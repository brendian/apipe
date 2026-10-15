import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { Config } from '@advpipe/contracts';
import { newRunId, RunLog, startRun } from '@advpipe/engine';
import { makeRepo, root, scratch } from './support.js';

// `npm run test:packaged`: the PACKAGED app (electron-builder --dir output), not the dev build.
// Proves what only a package can: the window opens and finds its bundled Claude Code, and a
// detached worker started from `app.asar.unpacked` can spawn that binary. No API call is made:
// the worker's agent call runs with an empty home and no credentials, so it can only fail to log in.

const release = path.join(root, 'release');
// The package is run from a copy outside the repo: inside it, Node's module lookup walks up into
// the repo's own node_modules and hides a dependency the package forgot to ship.
function packagedApp(): { exe: string; resources: string } {
  const copy = (dir: string): string => {
    const to = path.join(scratch(), path.basename(dir));
    if (existsSync(dir)) cpSync(dir, to, { recursive: true, verbatimSymlinks: true });
    return to;
  };
  if (process.platform === 'win32') {
    const dir = copy(path.join(release, 'win-unpacked'));
    return { exe: path.join(dir, 'advpipe.exe'), resources: path.join(dir, 'resources') };
  }
  if (process.platform === 'darwin') {
    const dir = copy(
      path.join(release, readdirSync(release).find((d) => d.startsWith('mac')) ?? 'mac'),
    );
    const contents = path.join(dir, 'advpipe.app', 'Contents');
    return {
      exe: path.join(contents, 'MacOS', 'advpipe'),
      resources: path.join(contents, 'Resources'),
    };
  }
  const dir = copy(path.join(release, 'linux-unpacked'));
  return { exe: path.join(dir, 'advpipe'), resources: path.join(dir, 'resources') };
}
const { exe, resources } = packagedApp();
const unpacked = path.join(resources, 'app.asar.unpacked');

test('the packaged app opens a repo and finds its bundled Claude Code', async () => {
  expect(existsSync(exe), `${exe} (run npm run pack first)`).toBe(true);
  const repo = makeRepo();
  const app = await electron.launch({
    executablePath: exe,
    args: [repo],
    env: { ...process.env, ADVPIPE_USER_DATA: scratch() },
  });
  try {
    const page = await app.firstWindow();
    const problems: string[] = [];
    page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('No runs yet in this repo.')).toBeVisible();

    const result = await page.evaluate(() => window.advpipe.app.preflight());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.git.ok).toBe(true);
    expect(result.value.repo.ok).toBe(true);
    expect(result.value.claude.ok).toBe(true);
    expect(result.value.claude.version).toMatch(/^\d+\.\d+\.\d+/);

    await page.getByRole('link', { name: 'Help' }).click();
    await expect(page.getByRole('heading', { name: 'How advpipe works' })).toBeVisible();
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a detached worker from the package spawns the unpacked Claude Code binary', async () => {
  // A subscription login on macOS lives in the keychain, which an empty home does not hide.
  test.skip(process.platform === 'darwin', 'cannot guarantee "no credentials" on macOS');
  const repo = makeRepo();
  const home = scratch();
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const workerEntry = path.join(unpacked, 'out', 'main', 'worker.js');
  expect(existsSync(workerEntry)).toBe(true);

  const config = Config.parse({
    gates: { test: [], types: [], lint: [], security: [] },
    limits: { budget_usd_per_task: 0.5 },
  });
  const runId = newRunId();
  const request = {
    command: 'run' as const,
    run_id: runId,
    repo,
    work_item: '# Add clamp\nclamp(x, lo, hi)',
    work_item_file: '',
    name: null,
    config_path: null,
    keep_worktree: false,
    level: 'basic' as const,
    security_scan: null,
    scan_failures: 'ask' as const,
    bypass_questions: false,
    budget_usd: null,
  };
  startRun(repo, request, {
    workerEntry,
    execPath: exe,
    config,
    // No login of any kind: the agent call can only be refused, never billed.
    env: {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
    },
  });

  const runlog = RunLog.forRun(repo, runId);
  await expect.poll(() => runlog.lockHolder(), { timeout: 90_000, intervals: [500] }).toBeNull();

  const events = readFileSync(runlog.path('events.jsonl'), 'utf-8');
  const consoleLog = existsSync(runlog.path('console.log'))
    ? readFileSync(runlog.path('console.log'), 'utf-8')
    : '';
  // The worker started, reached the agent call, and the spawned binary answered: not logged in.
  expect(events).toContain('"kind":"agent_start"');
  expect(events).toContain('Not logged in');
  expect(consoleLog).not.toMatch(/ENOENT|EACCES|Cannot find module|ERR_MODULE_NOT_FOUND/);
  expect(runlog.readState()?.cost_usd ?? 0).toBe(0);
  execFileSync('git', ['-C', repo, 'status', '--porcelain']); // the repo itself is untouched
});
