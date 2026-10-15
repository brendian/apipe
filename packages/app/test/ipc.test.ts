import { describe, expect, it, vi } from 'vitest';
import { Prefs, SETTINGS_CHANGED, type Preflight, type PrefsView } from '@advpipe/contracts';
import { ActionError, ItemPathError, NewRunError } from '@advpipe/engine';
import {
  createHandlers,
  dispatch,
  UserError,
  type Deps,
  type SenderInfo,
} from '../src/main/ipc.js';

const REPO = '/home/me/proj';
const ours: SenderInfo = {
  frameUrl: 'app://renderer/index.html',
  isOurWindow: true,
  repo: REPO,
  windowId: 3,
};
const welcome: SenderInfo = { ...ours, repo: null };

const goodPreflight = {
  git: { ok: true, text: '' },
  repo: { ok: true, text: '' },
} as unknown as Preflight;

const emptyList = {
  rows: [],
  counts: { all: 0, running: 0, needs_you: 0, complete: 0 },
  unreadable: [],
};

/** Handlers over spies, so a test can assert the engine was (not) called. */
function setup() {
  const prefs = Prefs.parse({ recent_repos: ['/a/one', '/a/two'] });
  const deps = {
    prefs: {
      get: vi.fn(() => prefs),
      update: vi.fn((change: (p: Prefs) => void) => (change(prefs), prefs)),
      forgetRecent: vi.fn(),
    },
    engine: {
      loadRuns: vi.fn(() => emptyList),
      loadDetail: vi.fn(() => null),
      loadContext: vi.fn(async () => null),
      loadUsage: vi.fn(),
      loadHelp: vi.fn(() => ({ marker: 'help' }) as never),
      preflight: vi.fn(async () => goodPreflight),
      resolveItemsDir: vi.fn((repo: string, rel: string) => `${repo}/${rel}`),
      loadItems: vi.fn(async () => ({
        items_dir: 'work-items',
        folder_exists: false,
        groups: [],
        skipped: [],
        git_known: true,
      })),
      readDraft: vi.fn(),
      checkDraft: vi.fn(),
      createItem: vi.fn(async (_r: string, _d: string, input: { rel?: string }) => input.rel ?? ''),
      saveItem: vi.fn(async () => true),
      renameItem: vi.fn((_d: string, _rel: string, to: string) => to),
      itemDeleteInfo: vi.fn(),
      deleteItem: vi.fn(),
      planRun: vi.fn(),
      startNewRun: vi.fn(async () => ({ runId: '20261015-100000-abcdef' })),
      cancelAction: vi.fn((_repo: string, runId: string) => ({ runId })),
      resumeAction: vi.fn(async (_repo: string, runId: string) => ({ runId })),
      answerAction: vi.fn(async (_repo: string, runId: string) => ({ runId })),
      decideAction: vi.fn(async (_repo: string, runId: string) => ({ runId, resumed: true })),
      cleanInfoAction: vi.fn(),
      cleanAction: vi.fn(async () => ['removed worktree']),
      revealPath: vi.fn(() => '/home/me/proj/.advpipe/runs/r1'),
    },
    shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined) },
    host: {
      about: vi.fn(() => ({
        name: 'advpipe',
        version: '1',
        electron: '2',
        chrome: '3',
        node: '4',
      })),
      openLogs: vi.fn(async () => undefined),
    },
    logs: { subscribe: vi.fn(), unsubscribe: vi.fn() },
    windows: { pick: vi.fn(async () => true), open: vi.fn(async () => true) },
    exists: () => true,
    defaultItemsDir: 'work-items',
  } satisfies Deps;
  return { deps, handlers: createHandlers(deps) };
}

const call = (
  h: ReturnType<typeof createHandlers>,
  channel: string,
  input: unknown,
  sender: SenderInfo = ours,
) => dispatch(h, channel, input, sender);

describe('IPC handlers', () => {
  it('answers valid calls with parsed output, using the window’s repo', async () => {
    const { deps, handlers } = setup();
    expect(await call(handlers, 'runs.list', { show: 'running' })).toEqual({
      ok: true,
      value: emptyList,
    });
    expect(deps.engine.loadRuns).toHaveBeenCalledWith(REPO, 'running');
    const info = await call(handlers, 'app.window.info', {});
    expect(info).toEqual({ ok: true, value: { repo: { name: 'proj', path: REPO } } });
    const set = await call(handlers, 'app.prefs.set', { theme: 'dark', run_filter: 'complete' });
    expect(set.ok && (set.value as PrefsView).theme).toBe('dark');
    expect(deps.prefs.get().run_filter[REPO]).toBe('complete');
  });

  it('rejects every hostile input without calling the engine', async () => {
    const { deps, handlers } = setup();
    const bad: [string, unknown][] = [
      ['runs.list', { show: 'bogus' }],
      ['runs.list', { show: 'all', repo: '/etc' }], // a window can't name a repo
      ['runs.list', 'all'],
      ['runs.detail', { runId: '../../etc/passwd' }],
      ['runs.detail', { runId: 'a/b' }],
      ['runs.detail', { runId: '' }],
      ['runs.detail', { runId: 'x'.repeat(101) }],
      ['runs.detail', { runId: 7 }],
      ['runs.context', { runId: '../x' }],
      ['runs.log.subscribe', { runId: 'r1', offset: -1 }],
      ['runs.log.subscribe', { runId: 'a/b', offset: 0 }],
      ['runs.log.unsubscribe', { runId: '..' }],
      ['app.prefs.set', { theme: 'neon' }],
      ['app.prefs.set', { recent_repos: ['/etc'] }], // main manages the recent list
      ['app.repo.openRecent', { index: -1 }],
      ['app.repo.openRecent', { index: 1.5 }],
      ['app.repo.openRecent', { index: 0, path: '/etc' }],
      ['app.repo.pick', { path: '/etc' }], // the picker takes no path
      ['app.preflight', { repo: '/etc' }],
      ['usage.get', { x: 1 }],
      ['app.logs.open', { path: '/etc' }], // main knows where its logs are
      ['app.help', { x: 1 }],
      ['app.about', { x: 1 }],
      ['items.read', { rel: 'x'.repeat(301) }],
      ['items.read', { rel: '../x.md', repo: '/etc' }],
      ['items.save', { rel: 'a.md', body: 'x'.repeat(200_001) }],
      ['items.save', { rel: 'a.md', body: 'x', itemsDir: '/etc' }], // a window can't name the folder
      ['items.create', { rel: 'a.md', level: 5 }],
      ['items.rename', { rel: 'a.md' }],
      ['items.delete', { rel: 'a.md' }], // no confirm
      ['items.delete', { rel: 'a.md', confirm: false }],
      ['items.delete', { rel: 'a.md', confirm: 'yes' }],
      ['items.deleteInfo', { rel: 5 }],
      ['app.prefs.set', { items_dir: '' }],
      ['newrun.plan', { source: 'item', level: 5 }],
      ['newrun.plan', { repo: '/etc' }],
      ['newrun.start', { source: 'task', task: 'x' }], // nothing was shown
      ['newrun.start', { shown: 'full;on;ask;ask', budget_shown: '15.00', config_path: '/etc/x' }],
      ['run.cancel', { runId: '../x' }],
      ['run.cancel', { runId: 'r1', repo: '/etc' }],
      ['run.resume', { runId: 'r1', budget: 'x'.repeat(41) }],
      ['run.answer', { runId: 'r1', answers: { 'Q1; rm -rf': 'x' }, bypass: [] }],
      ['run.answer', { runId: 'r1', answers: {}, bypass: ['everything'] }],
      ['run.answer', { runId: 'r1', answers: { Q1: 'x'.repeat(100_001) }, bypass: [] }],
      ['run.answer', { runId: 'r1', answers: { Q1: 'x' } }], // no bypass list
      ['run.decide', { runId: 'r1', choice: 'x'.repeat(21) }],
      ['run.decide', { runId: 'r1', choice: 'fix', note: 'x'.repeat(16_001) }],
      ['run.decide', { runId: 'r1', choice: 'takeover', confirm: 'yes' }],
      ['run.cleanInfo', { runId: 'a/b' }],
      ['run.clean', { runId: 'r1', force: false, logs: false }], // no confirm
      ['run.clean', { runId: 'r1', force: false, logs: false, confirm: false }],
      ['run.clean', { runId: 'r1', force: 'yes', logs: false, confirm: true }],
      ['run.reveal', { runId: 'r1', what: '/etc' }], // a window can't name a path
      ['run.reveal', { runId: 'r1', what: 'worktree', path: '/etc' }],
      ['run.openLink', { key: 'https://evil.example/' }], // a window can't name a URL
      ['run.openLink', { key: 'add_usage', url: 'https://evil.example/' }],
      ['app.nope', {}],
      ['constructor', {}],
    ];
    for (const [channel, input] of bad) {
      expect((await call(handlers, channel, input)).ok, `${channel} ${JSON.stringify(input)}`).toBe(
        false,
      );
    }
    expect(deps.engine.loadRuns).not.toHaveBeenCalled();
    expect(deps.engine.loadDetail).not.toHaveBeenCalled();
    expect(deps.engine.loadContext).not.toHaveBeenCalled();
    expect(deps.logs.subscribe).not.toHaveBeenCalled();
    expect(deps.engine.preflight).not.toHaveBeenCalled();
    expect(deps.engine.loadUsage).not.toHaveBeenCalled();
    expect(deps.windows.pick).not.toHaveBeenCalled();
    expect(deps.windows.open).not.toHaveBeenCalled();
    expect(deps.shell.showItemInFolder).not.toHaveBeenCalled();
    expect(deps.shell.openExternal).not.toHaveBeenCalled();
    expect(deps.prefs.update).not.toHaveBeenCalled();
    for (const fn of Object.values(deps.engine).filter((f) => 'mock' in f)) {
      // Everything above that was a spy and is not one of the earlier checked ones stayed quiet.
      if (fn !== deps.engine.preflight) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('refuses senders that are not our windows or not our origin', async () => {
    const { deps, handlers } = setup();
    const foreign = { ...ours, frameUrl: 'https://evil.example/' };
    const sneaky = { ...ours, frameUrl: 'app://renderer.evil.example/x' };
    for (const sender of [foreign, sneaky, { ...ours, isOurWindow: false }]) {
      expect((await call(handlers, 'runs.list', { show: 'all' }, sender)).ok).toBe(false);
    }
    expect(deps.engine.loadRuns).not.toHaveBeenCalled();
  });

  it('a window with no repo gets "no repo" for repo channels, and can still pick one', async () => {
    const { deps, handlers } = setup();
    for (const [channel, input] of [
      ['runs.list', { show: 'all' }],
      ['runs.detail', { runId: 'r1' }],
      ['runs.context', { runId: 'r1' }],
      ['runs.log.subscribe', { runId: 'r1', offset: 0 }],
      ['app.preflight', {}],
      ['usage.get', {}],
    ] as const) {
      expect(await call(handlers, channel, input, welcome)).toEqual({
        ok: false,
        error: 'No repo is open in this window.',
      });
    }
    expect(await call(handlers, 'app.repo.pick', {}, welcome)).toEqual({
      ok: true,
      value: { opened: true },
    });
    expect(deps.windows.pick).toHaveBeenCalledWith(3);
  });

  it('opens a recent repo by index only, and says so when the index is stale', async () => {
    const { deps, handlers } = setup();
    await call(handlers, 'app.repo.openRecent', { index: 1 });
    expect(deps.windows.open).toHaveBeenCalledWith('/a/two', 3);
    expect(await call(handlers, 'app.repo.openRecent', { index: 5 })).toMatchObject({ ok: false });
    expect(deps.windows.open).toHaveBeenCalledTimes(1);
  });

  it('shows a person-readable error for an unreadable run, and hides unexpected ones', async () => {
    const { deps, handlers } = setup();
    deps.engine.loadDetail.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    expect(await call(handlers, 'runs.detail', { runId: 'r1' })).toEqual({
      ok: false,
      error: "Can't read this run: EACCES: permission denied",
    });
    deps.windows.open.mockRejectedValueOnce(new UserError("That folder doesn't exist any more."));
    expect(await call(handlers, 'app.repo.openRecent', { index: 0 })).toEqual({
      ok: false,
      error: "That folder doesn't exist any more.",
    });
    const onError = vi.fn();
    deps.engine.loadUsage.mockImplementationOnce(() => {
      throw new Error('secret /home/me/stack trace');
    });
    const r = await dispatch(handlers, 'usage.get', {}, ours, null, onError);
    expect(r.ok === false && r.error).not.toMatch(/secret/);
    expect(onError).toHaveBeenCalled();
  });

  it('log subscriptions and the context tab use the window’s own repo and window id', async () => {
    const { deps, handlers } = setup();
    expect(await call(handlers, 'runs.log.subscribe', { runId: 'r1', offset: 12 })).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(deps.logs.subscribe).toHaveBeenCalledWith(ours.windowId, REPO, 'r1', 12);
    await call(handlers, 'runs.log.unsubscribe', { runId: 'r1' });
    expect(deps.logs.unsubscribe).toHaveBeenCalledWith(ours.windowId, 'r1');
    expect(await call(handlers, 'runs.context', { runId: 'r1' })).toEqual({
      ok: true,
      value: null,
    });
    expect(deps.engine.loadContext).toHaveBeenCalledWith(REPO, 'r1');
    deps.engine.loadContext.mockRejectedValueOnce(new Error('bad run.json'));
    expect(await call(handlers, 'runs.context', { runId: 'r1' })).toEqual({
      ok: false,
      error: "Can't read this run: bad run.json",
    });
  });

  it('work items: the folder comes from main (the window’s setting), errors are shown plainly', async () => {
    const { deps, handlers } = setup();
    await call(handlers, 'items.list', {});
    expect(deps.engine.resolveItemsDir).toHaveBeenCalledWith(REPO, 'work-items');
    expect(deps.engine.loadItems).toHaveBeenCalledWith(REPO, `${REPO}/work-items`);

    // A folder outside the repo is refused before it is stored.
    deps.engine.resolveItemsDir.mockImplementationOnce(() => {
      throw new ItemPathError('The work-items folder must be a folder inside this repo.');
    });
    expect(await call(handlers, 'app.prefs.set', { items_dir: '../elsewhere' })).toEqual({
      ok: false,
      error: 'The work-items folder must be a folder inside this repo.',
    });
    expect(deps.prefs.get().items_dir[REPO]).toBeUndefined();
    await call(handlers, 'app.prefs.set', { items_dir: 'tasks' });
    expect(deps.prefs.get().items_dir[REPO]).toBe('tasks');
    await call(handlers, 'items.deleteInfo', { rel: 'a.md' }).catch(() => undefined);
    expect(deps.engine.itemDeleteInfo).toHaveBeenCalledWith(REPO, `${REPO}/tasks`, 'a.md');

    // Engine path errors are for a person; anything else is hidden.
    deps.engine.deleteItem.mockImplementationOnce(() => {
      throw new ItemPathError("'..' isn't allowed in a path");
    });
    expect(await call(handlers, 'items.delete', { rel: '../x.md', confirm: true })).toEqual({
      ok: false,
      error: "'..' isn't allowed in a path",
    });
    expect(await call(handlers, 'items.delete', { rel: 'a.md', confirm: true })).toEqual({
      ok: true,
      value: { deleted: 'a.md' },
    });
    expect(deps.engine.deleteItem).toHaveBeenLastCalledWith(`${REPO}/tasks`, 'a.md');
    expect(await call(handlers, 'items.list', {}, welcome)).toMatchObject({ ok: false });
  });

  it('new run: start passes what was shown to the engine, after the setup checks', async () => {
    const { deps, handlers } = setup();
    const form = {
      source: 'task',
      task: 'add clamp',
      shown: 'full;on;ask;ask',
      budget_shown: '15.00',
    };
    expect(await call(handlers, 'newrun.start', form)).toEqual({
      ok: true,
      value: { runId: '20261015-100000-abcdef' },
    });
    const [repo, , sent, shown, budget] = deps.engine.startNewRun.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      string,
      string,
    ];
    expect([repo, shown, budget]).toEqual([REPO, 'full;on;ask;ask', '15.00']);
    expect(sent).toMatchObject({ source: 'task', task: 'add clamp' });
    expect(sent).not.toHaveProperty('shown');

    deps.engine.startNewRun.mockRejectedValueOnce(new NewRunError(SETTINGS_CHANGED));
    expect(await call(handlers, 'newrun.start', form)).toEqual({
      ok: false,
      error: SETTINGS_CHANGED,
    });

    // No git repo with a commit: nothing is started.
    deps.engine.startNewRun.mockClear();
    deps.engine.preflight.mockResolvedValueOnce({
      git: { ok: true, text: '' },
      repo: { ok: false, text: 'This folder isn’t a git repo.' },
    } as never);
    expect(await call(handlers, 'newrun.start', form)).toEqual({
      ok: false,
      error: 'This folder isn’t a git repo.',
    });
    expect(deps.engine.startNewRun).not.toHaveBeenCalled();
  });

  it('run actions: the window’s repo, the engine’s refusals as plain text, the two fixed links', async () => {
    const { deps, handlers } = setup();
    await call(handlers, 'run.cancel', { runId: 'r1' });
    expect(deps.engine.cancelAction).toHaveBeenCalledWith(REPO, 'r1');
    await call(handlers, 'run.resume', { runId: 'r1', budget: '20' });
    expect(deps.engine.resumeAction).toHaveBeenCalledWith(REPO, 'r1', '20');
    await call(handlers, 'run.answer', {
      runId: 'r1',
      answers: { Q1: 'Throw.' },
      bypass: ['Q2'],
    });
    expect(deps.engine.answerAction).toHaveBeenCalledWith(REPO, 'r1', {
      answers: { Q1: 'Throw.' },
      bypass: ['Q2'],
    });
    await call(handlers, 'run.decide', { runId: 'r1', choice: 'takeover', confirm: true });
    expect(deps.engine.decideAction).toHaveBeenCalledWith(REPO, 'r1', {
      choice: 'takeover',
      confirm: true,
    });
    expect(
      await call(handlers, 'run.clean', { runId: 'r1', force: true, logs: false, confirm: true }),
    ).toEqual({ ok: true, value: { lines: ['removed worktree'] } });
    expect(deps.engine.cleanAction).toHaveBeenCalledWith(REPO, 'r1', { force: true, logs: false });

    deps.engine.cancelAction.mockImplementationOnce(() => {
      throw new ActionError("This run changed since you looked (it's now complete). Reload.");
    });
    expect(await call(handlers, 'run.cancel', { runId: 'r1' })).toEqual({
      ok: false,
      error: "This run changed since you looked (it's now complete). Reload.",
    });
    expect(await call(handlers, 'run.cancel', { runId: 'r1' }, welcome)).toMatchObject({
      ok: false,
    });

    // The file manager shows what the engine derived; the window never names a path.
    await call(handlers, 'run.reveal', { runId: 'r1', what: 'runDir' });
    expect(deps.engine.revealPath).toHaveBeenCalledWith(REPO, 'r1', 'runDir');
    expect(deps.shell.showItemInFolder).toHaveBeenCalledWith('/home/me/proj/.advpipe/runs/r1');
    deps.engine.revealPath.mockImplementationOnce(() => {
      throw new ActionError("That isn't inside .advpipe/; not opening it.");
    });
    expect(await call(handlers, 'run.reveal', { runId: 'r1', what: 'worktree' })).toMatchObject({
      ok: false,
    });
    expect(deps.shell.showItemInFolder).toHaveBeenCalledTimes(1);

    // Two keys, two constant URLs.
    await call(handlers, 'run.openLink', { key: 'add_usage' });
    await call(handlers, 'run.openLink', { key: 'add_credits' });
    expect(deps.shell.openExternal.mock.calls).toEqual([
      ['https://claude.ai/settings/usage'],
      ['https://platform.claude.com/settings/billing'],
    ]);
  });

  it('help, about and the log folder take nothing and need no repo', async () => {
    const { deps, handlers } = setup();
    expect((await call(handlers, 'app.about', {}, welcome)).ok).toBe(true);
    await call(handlers, 'app.logs.open', {}, welcome);
    expect(deps.host.openLogs).toHaveBeenCalledTimes(1);
    // The help view is parsed on the way out: a made-up one is refused, not passed through.
    expect((await call(handlers, 'app.help', {})).ok).toBe(false);
    expect(deps.engine.loadHelp).toHaveBeenCalledTimes(1);
  });

  it('parses its own output: a handler cannot leak extra fields', async () => {
    const { deps, handlers } = setup();
    deps.engine.loadRuns.mockReturnValueOnce({ ...emptyList, leak: 'x' } as never);
    expect((await call(handlers, 'runs.list', { show: 'all' })).ok).toBe(false);
  });
});
