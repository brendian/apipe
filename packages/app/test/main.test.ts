import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { newRunState } from '@advpipe/contracts';
import { RunLog } from '@advpipe/engine';
import { PrefsStore, prefsView } from '../src/main/prefs.js';
import { repoArg } from '../src/main/repo.js';
import { diff, scan, watchRepo } from '../src/main/watch.js';

const scratch = (): string => mkdtempSync(path.join(tmpdir(), 'advpipe-app-'));

describe('preferences', () => {
  it('keeps ten recent repos, most recent first, and survives a damaged file', () => {
    const file = path.join(scratch(), 'preferences.json');
    const store = new PrefsStore(file);
    for (let i = 0; i < 12; i++) store.addRecent(`/r/${i}`);
    store.addRecent('/r/5');
    expect(store.get().recent_repos).toHaveLength(10);
    expect(store.get().recent_repos[0]).toBe('/r/5');
    expect(new PrefsStore(file).get().recent_repos[0]).toBe('/r/5'); // saved
    store.forgetRecent(0);
    expect(store.get().recent_repos).not.toContain('/r/5');
    writeFileSync(file, '{not json');
    expect(new PrefsStore(file).get().theme).toBe('system');
    const view = prefsView(store.get(), '/r/11', (d) => d !== '/r/10');
    expect(view.run_filter).toBe('all');
    expect(view.recent.find((r) => r.path === '/r/10')?.exists).toBe(false);
  });
});

describe('command line', () => {
  it('takes the first plain argument as the repo, after the app path when run as electron <app>', () => {
    expect(repoArg(['/bin/advpipe', '--flag', 'proj'], '/home/me', false)).toBe('/home/me/proj');
    expect(repoArg(['electron', '--inspect=0', '/app', '/abs/repo'], '/x', true)).toBe('/abs/repo');
    expect(repoArg(['electron', '/app'], '/x', true)).toBeNull();
    expect(repoArg(['/bin/advpipe'], '/x', false)).toBeNull();
  });
});

describe('watcher', () => {
  it('scan/diff see run and usage changes, and a worker dying', () => {
    const repo = scratch();
    const log = RunLog.forRun(repo, 'r1');
    log.writeState(newRunState({ run_id: 'r1', work_item: 'x', repo }));
    const before = scan(repo);
    expect(diff(before, scan(repo))).toEqual({ runsChanged: false, runs: [], usage: false });
    log.appendEvent({ ts: 't', kind: 'stage', stage: 'INIT', round: 0, message: 'm' });
    expect(diff(before, scan(repo))).toMatchObject({ runsChanged: false, runs: ['r1'] }); // log only
    writeFileSync(log.path('run.lock'), '999999999'); // a lock whose process is gone
    const locked = scan(repo);
    const state = log.readState();
    state.cost_usd = 1;
    log.writeState(state);
    expect(diff(locked, scan(repo)).runsChanged).toBe(true);
    writeFileSync(path.join(repo, '.advpipe', 'usage.json'), '{}');
    expect(diff(locked, scan(repo)).usage).toBe(true);
  });

  it('pushes runs.changed when a run appears, even in a repo with no .advpipe yet', async () => {
    const repo = scratch();
    const notify = vi.fn();
    const w = watchRepo(repo, notify, { pollMs: 30, debounceMs: 10 });
    try {
      mkdirSync(path.join(repo, '.advpipe'), { recursive: true });
      RunLog.forRun(repo, 'r1').writeState(newRunState({ run_id: 'r1', work_item: 'x', repo }));
      await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('runs.changed', {}), {
        timeout: 3000,
      });
      expect(notify).toHaveBeenCalledWith('run.changed', { runId: 'r1' });
    } finally {
      w.close();
    }
  });
});
