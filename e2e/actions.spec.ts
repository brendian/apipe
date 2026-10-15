import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Config } from '@advpipe/contracts';
import { newRunId, RunLog, startRun } from '@advpipe/engine';
import {
  codeOnward,
  happyJson,
  runRequest,
  scriptEnv,
  w,
  type JsonScript,
} from '../packages/engine/test/helpers/worker.js';
import {
  IMPL_OK,
  IMPL_WRONG,
  TASK_MD,
  TEST_CLAMP,
} from '../packages/engine/test/helpers/samples.js';
import { launch, makeRepo, workerEntry } from './support.js';

// Scenarios 2-6 (docs/09 §9): answering and Bypass, red checks with a note then take over, scan
// hits, a usage limit, cancel and resume, and an over-budget run. Real worker processes, scripted
// agents: never a real one (the test build refuses to start any other worker).
//
// A worker builds its fake agents from the start of its script every time it starts, so a run that
// is resumed needs the script for what is left: `then()` swaps it in before the app resumes it.

test.setTimeout(120_000);

const pass = JSON.stringify({ verdict: 'PASS', findings: [] });
const config = (over: Record<string, unknown> = {}): Config =>
  Config.parse({
    gates: { test: [process.execPath, '--test'], types: [], lint: [], security: [] },
    ...over,
  });

type Started = { log: RunLog };

function begin(
  repo: string,
  userData: string,
  script: JsonScript,
  opts: {
    level?: 'full' | 'tests';
    scan?: boolean;
    config?: Config;
    title?: string;
  } = {},
): Started {
  const runId = newRunId();
  const request = {
    ...runRequest(repo, { work_item: `# ${opts.title ?? 'Add clamp'}\nclamp(x, lo, hi)` }),
    run_id: runId,
    level: opts.level ?? ('full' as const),
    ...(opts.scan === undefined ? {} : { security_scan: opts.scan }),
  };
  const env = scriptEnv(userData, script, `${runId}.json`);
  startRun(repo, request, { workerEntry, config: opts.config ?? config(), env });
  const log = RunLog.forRun(repo, runId);
  copyFileSync(env['ADVPIPE_FAKE_SCRIPT'] as string, path.join(log.root, 'fake-script.json'));
  return { log };
}

/** What the run's next worker (one the app starts) will be scripted with. */
const then = (run: Started, scripts: JsonScript['scripts']): void =>
  writeFileSync(path.join(run.log.root, 'fake-script.json'), JSON.stringify({ scripts }));

const open = (page: Page, title = 'Add clamp') =>
  page.getByRole('link', { name: new RegExp(title) }).click({ timeout: 20_000 });
const chip = (page: Page, label: string) => page.locator('.facts .chip', { hasText: label });

test('questions: answer one, let the agent decide the other; the answers reach task.md', async () => {
  const repo = makeRepo();
  const { app, page, problems, userData } = await launch(repo);
  try {
    const blocked = TASK_MD.replace(
      '## Open questions\n- None',
      '## Open questions\n- BLOCKING: should lo > hi swap or throw?\n- BLOCKING: may lo equal hi?',
    );
    const revised = TASK_MD.replace(
      '- [ ] AC3:',
      '- [ ] AC4: the error names lo and hi.\n- [ ] AC3:',
    );
    const agent = JSON.stringify({
      answers: [{ id: 'Q2', answer: 'Yes: equal bounds are fine.', reasoning: 'AC1 allows it.' }],
    });
    const scripts = happyJson();
    scripts['spec-writer'] = [w({ 'task.md': blocked })];
    const run = begin(repo, userData, { scripts });
    then(run, { ...happyJson(), 'spec-writer': [agent, w({ 'task.md': revised })] });

    await open(page);
    await expect(chip(page, 'needs answers')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: "Answer the spec's questions" })).toBeVisible();
    await page.getByLabel(/should lo > hi swap or throw/).fill('Throw a RangeError.');
    await page.getByLabel(/Let the agent decide Q2/).check();
    await page.getByRole('button', { name: 'Save answers and continue' }).click();
    await expect(
      page.getByText('Your answers are saved and the run is carrying on.'),
    ).toBeVisible();

    await expect(chip(page, 'complete')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: 'Spec & context' }).click();
    const task = page.locator('#ctx-task');
    await expect(task).toContainText('Throw a RangeError.');
    await expect(task).toContainText("agent's best judgement");
    await expect(task).toContainText('Yes: equal bounds are fine.');
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});

test('red checks: fix with a note, then take over behind its confirmation page', async () => {
  const repo = makeRepo();
  const { app, page, problems, userData } = await launch(repo);
  try {
    const scripts = happyJson();
    scripts['coder'] = [w(IMPL_WRONG), 'tried', 'tried', 'tried'];
    scripts['code-critic'] = [pass, pass, pass];
    const run = begin(repo, userData, { scripts });
    then(run, { coder: ['a fix attempt that changes nothing'] });

    await open(page);
    await expect(chip(page, 'needs a decision')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Fix pass 1 of 3.')).toBeVisible();
    await page.getByLabel(/A note for the author/).fill('keep the public signature');
    await page.getByRole('button', { name: 'Another fix pass' }).click();
    await expect(page.getByText('Your choice is saved and the run is carrying on.')).toBeVisible();
    await expect(page.getByText('Fix pass 2 of 3.')).toBeVisible({ timeout: 60_000 });
    expect(run.log.readState().decisions[0]?.note).toBe('keep the public signature');

    // Taking over asks first: the safe button has the focus, and nothing happens until the other one.
    await page.getByRole('link', { name: /I'll take over/ }).click();
    await expect(page.getByRole('button', { name: 'Keep it waiting' })).toBeFocused();
    expect(run.log.readState().ended_by).toBe('');
    await page.getByRole('button', { name: 'Take over', exact: true }).click();
    await expect(chip(page, 'handed over')).toBeVisible({ timeout: 20_000 });
    expect(run.log.readState().worktree_removed).toBe(true);
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});

test('scan hits: ignore on one run, block on another', async () => {
  const repo = makeRepo();
  const { app, page, problems, userData } = await launch(repo);
  try {
    const hits = config({
      gates: {
        test: [process.execPath, '--test'],
        types: [],
        lint: [],
        security: [process.execPath, '-e', 'console.log("1 finding"); process.exit(1)'],
      },
    });
    const upToCode = (): JsonScript['scripts'] => ({
      'spec-writer': [w({ 'task.md': TASK_MD })],
      'test-author': [w({ 'tests/clamp.test.js': TEST_CLAMP })],
      coder: [w(IMPL_OK)],
    });
    const opts = { level: 'tests', scan: true, config: hits } as const;

    const first = begin(repo, userData, { scripts: upToCode() }, opts);
    then(first, { 'code-critic': [pass] });
    await open(page);
    await expect(chip(page, 'needs a decision')).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByRole('heading', { name: 'The security scan reported issues' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Ignore and continue' }).click();
    await expect(chip(page, 'complete')).toBeVisible({ timeout: 60_000 });
    expect(first.log.readState().scan_policy).toBe('ignore');
    expect(first.log.readState().minor_findings.map((f) => f.id)).toContain('G-security-ignored');

    const second = begin(
      repo,
      userData,
      { scripts: upToCode() },
      { ...opts, title: 'Second clamp' },
    );
    then(second, { coder: ['tried', 'tried', 'tried'] });
    await page.getByRole('link', { name: 'All runs' }).click();
    await open(page, 'Second clamp');
    await expect(chip(page, 'needs a decision')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Block', exact: true }).click();
    // Blocking treats the hits like a failing test: the author is asked, and it still fails.
    await expect(page.getByRole('heading', { name: 'The checks are still failing' })).toBeVisible({
      timeout: 60_000,
    });
    expect(second.log.readState().scan_policy).toBe('block');
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});

test('usage limit: the fixed link, Try again; and Finish as is, which clean up guards', async () => {
  const repo = makeRepo();
  const { app, page, problems, userData } = await launch(repo);
  try {
    // Try again.
    const limited = begin(repo, userData, { scripts: { 'spec-writer': [{ limit: {} }] } });
    then(limited, happyJson());
    await open(page);
    await expect(chip(page, 'paused: usage limit')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/If the limit is still in force/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Add extra usage' }).click();
    await expect
      .poll(() => readFileSync(path.join(userData, 'logs', 'main.log'), 'utf-8'), {
        timeout: 10_000,
      })
      .toContain('openExternal https://claude.ai/settings/usage');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(chip(page, 'complete')).toBeVisible({ timeout: 60_000 });

    // Finish as is: nothing committed, the work stays; clean up asks for "delete anyway".
    const second = begin(
      repo,
      userData,
      { scripts: { 'spec-writer': [{ limit: { files: { 'task.md': '# half a spec\n' } } }] } },
      { title: 'Limited run' },
    );
    await page.getByRole('link', { name: 'All runs' }).click();
    await open(page, 'Limited run');
    await expect(chip(page, 'paused: usage limit')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: /Finish as is/ }).click();
    await expect(page.getByRole('button', { name: 'Keep it paused' })).toBeFocused();
    await page.getByRole('button', { name: 'Finish as is', exact: true }).click();
    await expect(chip(page, 'finished as is')).toBeVisible({ timeout: 20_000 });
    expect(existsSync(second.log.readState().worktree)).toBe(true);

    await page.getByRole('link', { name: 'Clean up…' }).click();
    await page.getByRole('button', { name: 'Clean it up' }).click();
    await expect(page.getByRole('alert')).toContainText('Delete anyway');
    expect(existsSync(second.log.readState().worktree)).toBe(true);
    await page.getByLabel(/Delete anyway/).check();
    await page.getByRole('button', { name: 'Clean it up' }).click();
    await expect(chip(page, 'finished as is')).toBeVisible({ timeout: 20_000 });
    expect(existsSync(second.log.readState().worktree)).toBe(false);
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});

test('cancel then resume with a new budget; an over-budget run needs one', async () => {
  const repo = makeRepo();
  const { app, page, problems, userData } = await launch(repo);
  try {
    const release = path.join(userData, 'release');
    const held = begin(repo, userData, {
      scripts: happyJson(),
      hold: { role: 'coder', until: release },
    });
    then(held, codeOnward());
    await open(page);
    await expect(chip(page, 'running')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.timeline-strip li', { hasText: 'CODE' })).toContainText(
      'in progress',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.getByRole('button', { name: 'Keep it running' })).toBeFocused();
    await page.getByRole('button', { name: 'Cancel the run' }).click();
    await expect(chip(page, 'stopped')).toBeVisible({ timeout: 30_000 });
    expect(held.log.readState().notes.join()).toContain('Interrupted during');

    await page.locator('#resume-budget').fill('20');
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(chip(page, 'complete')).toBeVisible({ timeout: 60_000 });
    expect(
      JSON.parse(readFileSync(held.log.path('config.json'), 'utf-8')).limits.budget_usd_per_task,
    ).toBe(20);

    // Over budget: the form is prefilled with a suggestion and the budget is required.
    const tight = happyJson();
    tight['test-author'] = [w({ 'tests/clamp.test.js': TEST_CLAMP })];
    const over = begin(
      repo,
      userData,
      { scripts: tight },
      { config: config({ limits: { budget_usd_per_task: 0.015 } }), title: 'Tight budget' },
    );
    then(over, {
      'test-author': [w({ 'tests/clamp.test.js': TEST_CLAMP })],
      'test-critic': [pass],
      ...codeOnward(),
    });
    await page.getByRole('link', { name: 'All runs' }).click();
    await open(page, 'Tight budget');
    await expect(chip(page, 'over budget')).toBeVisible({ timeout: 30_000 });
    const budget = page.locator('#resume-budget');
    await expect(budget).toHaveValue('6');
    await budget.fill('');
    await page.getByRole('button', { name: 'Resume' }).click();
    expect(await budget.evaluate((el: HTMLInputElement) => el.validity.valueMissing)).toBe(true);
    await budget.fill('20');
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(chip(page, 'complete')).toBeVisible({ timeout: 60_000 });
    expect(problems).toEqual([]);
  } finally {
    await app.close();
  }
});
