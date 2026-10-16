import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Config, newRunState, RunForm, SETTINGS_CHANGED } from '@advpipe/contracts';
import {
  cancelRun,
  checkDraft,
  createItem,
  deleteItem,
  digest,
  itemDeleteInfo,
  ItemConflict,
  ItemError,
  ItemPathError,
  itemPath,
  loadItems,
  NewRunError,
  planRun,
  readDraft,
  renameItem,
  resolveItemsDir,
  RunLog,
  saveItem,
  startNewRun,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv } from './helpers/repo.js';
import { scratch, scriptEnv, stopped, waitFor, WORKER } from './helpers/worker.js';

// Work items on disk and the New run plan (docs/05 §5.4–§5.6). Real files, real git, no agents.

beforeEach(scrubEnv);

const form = (over: Record<string, unknown> = {}): RunForm => RunForm.parse(over);

function setup(): { repo: string; dir: string } {
  const repo = makeTargetRepo();
  return { repo, dir: resolveItemsDir(repo, 'work-items') };
}
const put = (dir: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

describe('the path gate', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'advpipe-items-'));
  const rejected = [
    '',
    '../x.md',
    'a/../../x.md',
    '/etc/passwd.md',
    'a\\b.md',
    '.hidden.md',
    'a/.git/x.md',
    'a//b.md',
    'a/b',
    'a/b.txt',
    '.md',
    'trailing /x.md',
    'C:/x.md',
    '%2e%2e/x.md',
    'x\0.md',
    'a/b/c/d/e/f.md', // 5 folders deep
    'x'.repeat(300) + '.md',
    'trailing./x.md',
  ];
  it.each(rejected)('refuses %j', (rel) => {
    expect(() => itemPath(dir, rel)).toThrow(ItemPathError);
  });
  it('accepts plain names, and refuses a symlink that leads out', () => {
    expect(itemPath(dir, 'server/s03-stock v2.md')).toBe(path.join(dir, 'server/s03-stock v2.md'));
    const outside = mkdtempSync(path.join(tmpdir(), 'advpipe-out-'));
    symlinkSync(outside, path.join(dir, 'link'));
    expect(() => itemPath(dir, 'link/x.md')).toThrow(/outside the work-items folder/);
  });
  it('the folder setting must stay inside the repo and not be hidden', () => {
    const { repo } = setup();
    for (const bad of ['', '.', '..', '../x', '/tmp', '.git', 'a/../..', '.advpipe/x'])
      expect(() => resolveItemsDir(repo, bad), bad).toThrow(ItemPathError);
    expect(resolveItemsDir(repo, 'tasks/open')).toMatch(/tasks\/open$/);
  });
});

describe('create, edit, rename, delete', () => {
  it('round-trips, never overwrites, and leaves an unchanged file byte for byte', async () => {
    const { repo, dir } = setup();
    const rel = await createItem(repo, dir, {
      rel: 'server/s05-refund',
      name: 's05',
      body: 'Refund window\r\n\r\nAllow refunds.',
      level: 'tests',
    });
    expect(rel).toBe('server/s05-refund.md');
    expect(readFileSync(path.join(dir, rel), 'utf-8')).toBe(
      '---\nname: s05\nlevel: tests\n---\nRefund window\n\nAllow refunds.\n',
    );
    await expect(createItem(repo, dir, { rel, body: 'again' })).rejects.toThrow(/already exists/);
    // The folder is git-ignored locally (info/exclude), so items never show in `git status`.
    expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf-8')).toContain(
      '/work-items/\n',
    );
    expect(git(repo, 'status', '--porcelain')).not.toContain('work-items');

    // A hand-formatted file (extra spaces, blank lines in the front matter) is not rewritten.
    const odd = '---\nname:   s05\n\nlevel : tests\n---\n\nRefund window\n\nAllow refunds.\n\n';
    put(dir, rel, odd);
    const draft = readDraft(repo, dir, rel);
    expect(draft).toMatchObject({ name: 's05', level: 'tests', problem: null });
    expect(await saveItem(repo, dir, draft)).toBe(false);
    expect(readFileSync(path.join(dir, rel), 'utf-8')).toBe(odd);

    // Clearing a field removes the key; "inherit" leaves it out.
    expect(await saveItem(repo, dir, { ...draft, level: '', name: '' })).toBe(true);
    expect(readFileSync(path.join(dir, rel), 'utf-8')).toBe('Refund window\n\nAllow refunds.\n');
  });

  it('refuses a save over changes made elsewhere, and one that has problems', async () => {
    const { repo, dir } = setup();
    put(dir, 'a.md', 'first\n');
    const draft = readDraft(repo, dir, 'a.md');
    put(dir, 'a.md', 'changed by someone else\n');
    await expect(saveItem(repo, dir, { ...draft, body: 'mine' })).rejects.toThrow(ItemConflict);
    expect(readFileSync(path.join(dir, 'a.md'), 'utf-8')).toBe('changed by someone else\n');
    const fresh = readDraft(repo, dir, 'a.md');
    for (const bad of [
      { body: '' },
      { name: 'a\nb' },
      { level: 'huge' },
      { bypass_questions: 'maybe' },
    ]) {
      await expect(saveItem(repo, dir, { ...fresh, ...bad })).rejects.toThrow(ItemError);
    }
    await expect(saveItem(repo, dir, { ...fresh, base: '' })).rejects.toThrow(ItemConflict);
    expect(readFileSync(path.join(dir, 'a.md'), 'utf-8')).toBe('changed by someone else\n');
  });

  it('a file that does not parse opens with what could be read, and saves fixed', async () => {
    const { repo, dir } = setup();
    put(dir, 'bad.md', '---\nname: x\nbogus: 1\n---\nDo the thing\n');
    const draft = readDraft(repo, dir, 'bad.md');
    expect(draft.problem).toMatch(/bogus/);
    expect(draft).toMatchObject({ name: 'x', body: 'Do the thing' });
    expect(await saveItem(repo, dir, draft)).toBe(true);
    expect(readFileSync(path.join(dir, 'bad.md'), 'utf-8')).toBe(
      '---\nname: x\n---\nDo the thing\n',
    );
  });

  it('rename refuses an existing target and a path outside; delete removes the file', () => {
    const { dir } = setup();
    put(dir, 'a.md', 'a\n');
    put(dir, 'b.md', 'b\n');
    expect(() => renameItem(dir, 'a.md', 'b')).toThrow(/already exists/);
    expect(() => renameItem(dir, 'a.md', '../escape')).toThrow(/New name/);
    expect(() => renameItem(dir, 'a.md', 'a.md')).toThrow(/name already/);
    expect(renameItem(dir, 'a.md', 'sub/c')).toBe('sub/c.md');
    expect(existsSync(path.join(dir, 'a.md'))).toBe(false);
    expect(readFileSync(path.join(dir, 'sub/c.md'), 'utf-8')).toBe('a\n');
    deleteItem(dir, 'sub/c.md');
    expect(existsSync(path.join(dir, 'sub/c.md'))).toBe(false);
    expect(() => deleteItem(dir, 'sub/c.md')).toThrow(/no work item/);
  });

  it('inline checks: errors block, warnings do not, an existing branch is noticed', async () => {
    const { repo } = setup();
    git(repo, 'branch', 'advpipe/add-clamp');
    const ok = await checkDraft(repo, { body: 'Add clamp', config: 'nope.toml' });
    expect(ok.ok).toBe(true);
    expect(ok.branch).toBe('advpipe/add-clamp');
    expect(ok.checks.map((c) => c.text).join('\n')).toMatch(/already exists.*add-clamp-2/s);
    expect(ok.checks.some((c) => /nope\.toml doesn't exist/.test(c.text))).toBe(true);
    expect(ok.preview_html).toContain('<p>Add clamp</p>');
    const bad = await checkDraft(repo, { body: ' ', level: '9', bypass_questions: 'yes' });
    expect(bad.ok).toBe(false);
    expect(bad.checks.map((c) => c.level).sort()).toEqual(['error', 'error', 'info', 'warning']);
    const outside = await checkDraft(repo, { body: 'x', config: '../x.toml' });
    expect(outside.checks[0]?.text).toMatch(/outside the repo/);
  });
});

describe('the list', () => {
  it('groups by folder with last run and git state, and lists unmanageable paths', async () => {
    const { repo, dir } = setup();
    put(dir, 'top.md', '# Top task\nbody\n');
    put(dir, 'server/s01.md', '---\nname: s01\n---\nDo S01\n');
    put(dir, 'server/broken.md', '---\nnope: 1\n---\nstill has a title\n');
    put(dir, 'mobile/m1.md', 'Mobile one\n');
    put(dir, '.hidden/x.md', 'hidden\n');
    put(dir, 'weird name!.md', 'odd\n');
    git(repo, 'add', 'work-items/top.md');
    git(repo, 'commit', '-q', '-m', 'items');
    writeFileSync(path.join(dir, 'top.md'), '# Top task\nchanged\n');
    const file = path.join(dir, 'server/s01.md');
    RunLog.forRun(repo, '20261015-100000-aaaaaa').writeState(
      newRunState({
        run_id: '20261015-100000-aaaaaa',
        work_item: 'Do S01',
        work_item_file: file,
        repo,
        status: 'complete',
      }),
    );

    const list = await loadItems(repo, dir);
    expect(list.groups.map((g) => g.folder)).toEqual(['', 'mobile', 'server']);
    const byRel = Object.fromEntries(list.groups.flatMap((g) => g.items).map((i) => [i.rel, i]));
    expect(byRel['top.md']).toMatchObject({ title: 'Top task', git: 'modified' });
    expect(byRel['server/s01.md']).toMatchObject({
      name: 's01',
      git: 'untracked',
      last_run: { run_id: '20261015-100000-aaaaaa', status: 'complete' },
    });
    expect(byRel['server/broken.md']?.problem).toMatch(/unknown key 'nope'/);
    expect(byRel['server/broken.md']?.title).toBe('still has a title');
    expect(byRel['mobile/m1.md']?.last_run).toBeNull();
    expect(list.skipped).toEqual(['weird name!.md']);
    expect(list.git_known).toBe(true);

    expect((await itemDeleteInfo(repo, dir, 'server/s01.md')).git).toBe('untracked');
    git(repo, 'add', 'work-items');
    git(repo, 'commit', '-q', '-m', 'all');
    expect((await itemDeleteInfo(repo, dir, 'top.md')).git).toBe('');
    expect(digest(Buffer.from('x'))).toHaveLength(64);
  });

  it('an absent folder is an empty state, not an error', async () => {
    const { repo, dir } = setup();
    expect(await loadItems(repo, dir)).toMatchObject({ folder_exists: false, groups: [] });
  });
});

describe('planRun', () => {
  it('takes the level, scan, policy and bypass from the form over the item over the config', async () => {
    const { repo, dir } = setup();
    writeFileSync(
      path.join(repo, 'pipeline.toml'),
      '[limits]\nbudget_usd_per_task = 8\n[pipeline]\nlevel = "adversarial"\nscan_failures = "block"\n',
    );
    put(dir, 'plain.md', 'Plain task\n');
    put(
      dir,
      'rich.md',
      '---\nlevel: tests\nsecurity_scan: yes\nscan_failures: ignore\nbypass_questions: yes\n---\nRich\n',
    );

    const plain = await planRun(repo, dir, form({ item: 'plain.md' }));
    expect(plain).toMatchObject({
      ok: true,
      level: 'adversarial',
      level_source: 'pipeline.toml',
      scan: false,
      scan_source: "the level's default",
      failures: 'block',
      bypass: false,
      budget: 8,
      budget_text: '8.00',
      config_label: 'pipeline.toml',
      branch: 'advpipe/plain-task',
      calls: [5, 23],
      agents: 6,
      shown_text: 'adversarial;off;block;ask;auto',
    });

    const rich = await planRun(repo, dir, form({ item: 'rich.md' }));
    expect(rich).toMatchObject({
      level: 'tests',
      level_source: "the work item's front matter",
      scan: true,
      scan_source: "the work item's front matter",
      failures: 'ignore',
      bypass: true,
      shown_text: 'tests;on;ignore;bypass;auto',
    });
    expect(rich.dropped).toContain('No standards review');

    // The form wins over both, but only for what it sets.
    const over = await planRun(
      repo,
      dir,
      form({ item: 'rich.md', level: '5', scan: 'off', scan_failures: 'ask', bypass: false }),
    );
    expect(over).toMatchObject({
      level: 'full',
      inherited_level: 'tests',
      scan: false,
      failures: 'ask',
      inherited_failures: 'ignore',
      bypass: false,
      inherited_bypass: true,
      shown_text: 'full;off;ask;ask;auto',
    });
    expect(
      (await planRun(repo, dir, form({ source: 'task', task: 'x', level: 'basic' }))).level,
    ).toBe('basic');
  });

  it('says what is wrong, in words', async () => {
    const { repo, dir } = setup();
    put(dir, 'broken.md', '---\nnope: 1\n---\nx\n');
    const errors = async (over: Record<string, unknown>): Promise<string[]> =>
      (await planRun(repo, dir, form(over))).errors;
    expect(await errors({})).toEqual(['Pick a work item, or choose to type a one-off task.']);
    expect(await errors({ item: '../x.md' })).toEqual([expect.stringMatching(/^Work item: /)]);
    expect(await errors({ item: 'gone.md' })).toEqual(["There's no work item gone.md any more."]);
    expect(await errors({ item: 'broken.md' })).toEqual([
      expect.stringMatching(
        /broken\.md can't be run as it is: .*unknown key.*Fix it in the editor\.$/s,
      ),
    ]);
    expect(await errors({ source: 'task', task: '  ' })).toEqual([
      'The task is empty: say what to build or fix.',
    ]);
    expect(await errors({ source: 'task', task: 'a\0b' })).toEqual([
      'The task contains a NUL character.',
    ]);
    expect(await errors({ source: 'task', task: 'x'.repeat(64_001) })).toEqual([
      'The task is over 64 kB. Save it as a work item instead.',
    ]);
    expect(await errors({ source: 'other' })).toEqual(['Choose a work item or a one-off task.']);
    expect(await errors({ source: 'task', task: 'x', config: '../x.toml' })).toEqual([
      'Config: ../x.toml is outside the repo',
    ]);
    expect(await errors({ source: 'task', task: 'x', config: 'nope.toml' })).toEqual([
      "Config: nope.toml doesn't exist",
    ]);
    expect(await errors({ source: 'task', task: 'x', name: 'a\nb' })).toEqual([
      'The branch name must be a single line.',
    ]);
    expect(
      await errors({ source: 'task', task: 'x', level: '9', scan: 'maybe', scan_failures: 'x' }),
    ).toEqual([
      'The level must be 1 (Basic) to 5 (Full).',
      'The security scan must be Default, On or Off.',
      'If the scan finds issues: choose Ask me, Ignore or Block.',
    ]);
    writeFileSync(path.join(repo, 'bad.toml'), '[limits]\nbudget_usd_per_task = -1\n');
    expect((await errors({ source: 'task', task: 'x', config: 'bad.toml' }))[0]).toMatch(
      /^Config: /,
    );
    git(repo, 'branch', 'advpipe/x');
    expect((await planRun(repo, dir, form({ source: 'task', task: 'x' }))).warnings).toEqual([
      'Branch advpipe/x already exists, so the run makes advpipe/x-2 or similar.',
    ]);
  });
});

describe('starting a run', () => {
  it('writes exactly what was shown to start.json, and refuses what was not shown', async () => {
    const { repo, dir } = setup();
    put(dir, 'clamp.md', '---\nname: clamp-it\nlevel: tests\n---\nAdd clamp\n');
    const scratchDir = scratch();
    const release = path.join(scratchDir, 'never');
    const opts = {
      workerEntry: WORKER,
      env: scriptEnv(scratchDir, { scripts: {}, hold: { role: 'spec-writer', until: release } }),
    };
    const f = form({ item: 'clamp.md', scan: 'on', bypass: true });
    const plan = await planRun(repo, dir, f);
    expect(plan.shown_text).toBe('tests;on;ask;bypass;auto');

    const stale = (shown: string, budget: string): Promise<unknown> =>
      startNewRun(repo, dir, f, shown, budget, opts);
    await expect(stale('full;on;ask;bypass', plan.budget_text)).rejects.toThrow(SETTINGS_CHANGED);
    await expect(stale(plan.shown_text, '99.00')).rejects.toThrow(NewRunError);
    await expect(startNewRun(repo, dir, form({ item: 'nope.md' }), '', '', opts)).rejects.toThrow(
      /no work item/,
    );
    expect(existsSync(path.join(repo, '.advpipe', 'runs'))).toBe(false); // nothing was started

    const { runId } = await startNewRun(repo, dir, f, plan.shown_text, plan.budget_text, opts);
    const log = RunLog.forRun(repo, runId);
    const request = JSON.parse(readFileSync(log.path('start.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(request).toEqual({
      command: 'run',
      run_id: runId,
      repo,
      work_item: 'Add clamp',
      work_item_file: path.join(dir, 'clamp.md'),
      name: 'clamp-it',
      config_path: null,
      keep_worktree: false,
      level: 'tests',
      security_scan: true,
      scan_failures: 'ask',
      bypass_questions: true,
      review_pauses: false,
      budget_usd: 15,
    });
    expect(Config.parse(log.readConfig()).pipeline).toMatchObject({
      level: 'tests',
      security_scan: true,
    });

    const { done } = cancelRun(repo, runId);
    await done;
    await waitFor(() => stopped(log));
  }, 60_000);
});
