import { describe, expect, it, vi } from 'vitest';
import { Prefs, type PrefsView } from '@advpipe/contracts';
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
      preflight: vi.fn(),
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
    expect(deps.prefs.update).not.toHaveBeenCalled();
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

  it('parses its own output: a handler cannot leak extra fields', async () => {
    const { deps, handlers } = setup();
    deps.engine.loadRuns.mockReturnValueOnce({ ...emptyList, leak: 'x' } as never);
    expect((await call(handlers, 'runs.list', { show: 'all' })).ok).toBe(false);
  });
});
