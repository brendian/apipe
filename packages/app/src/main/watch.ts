import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { isValidRunId, type PushPayloads } from '@advpipe/contracts';
import { RunLog } from '@advpipe/engine';

// Live updates (docs/04 §6): `fs.watch` is only a hint to look again, because it is lossy and
// platform-dependent; a 1 s poll over cheap stats is what guarantees nothing is missed. The
// signatures below are what "changed" means, and the host pushes one message per change.

export type Notify = <C extends 'runs.changed' | 'run.changed' | 'usage.changed'>(
  channel: C,
  payload: PushPayloads[C],
) => void;

type Sig = { list: string; detail: string };
type Snapshot = { runs: Map<string, Sig>; usage: string };

const stamp = (file: string): string => {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '-';
  }
};

/** What the files say now. Stats only, plus one liveness probe per run that has a lock. */
export function scan(repo: string): Snapshot {
  const root = path.join(repo, '.advpipe', 'runs');
  const runs = new Map<string, Sig>();
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    // no runs yet
  }
  for (const name of names) {
    if (!isValidRunId(name)) continue;
    const dir = path.join(root, name);
    const holder = new RunLog(dir).lockHolder(); // a worker dying changes status without a write
    const list = `${stamp(path.join(dir, 'run.json'))}|${stamp(path.join(dir, 'run.lock'))}|${holder ?? '-'}`;
    const detail = `${list}|${stamp(path.join(dir, 'report.md'))}|${stamp(path.join(dir, 'events.jsonl'))}`;
    runs.set(name, { list, detail });
  }
  return { runs, usage: stamp(path.join(repo, '.advpipe', 'usage.json')) };
}

/** Which pushes `next` calls for, given `prev`. */
export function diff(
  prev: Snapshot,
  next: Snapshot,
): { runsChanged: boolean; runs: string[]; usage: boolean } {
  let runsChanged = prev.runs.size !== next.runs.size;
  const changed: string[] = [];
  for (const [id, sig] of next.runs) {
    const before = prev.runs.get(id);
    if (before === undefined || before.list !== sig.list) runsChanged = true;
    if (before === undefined || before.detail !== sig.detail) changed.push(id);
  }
  return { runsChanged, runs: changed, usage: prev.usage !== next.usage };
}

export type WatchOptions = { pollMs?: number; debounceMs?: number };

/** Watch `repo`'s runs and usage cache; calls `notify` once per change. `close()` stops it. */
export function watchRepo(
  repo: string,
  notify: Notify,
  opts: WatchOptions = {},
): { close(): void } {
  const advpipe = path.join(repo, '.advpipe');
  let last = scan(repo);
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const watchers = new Map<string, FSWatcher>();

  const check = (): void => {
    if (closed) return;
    attach();
    const next = scan(repo);
    const d = diff(last, next);
    last = next;
    if (d.runsChanged) notify('runs.changed', {});
    for (const runId of d.runs) notify('run.changed', { runId });
    if (d.usage) notify('usage.changed', {});
  };
  const soon = (): void => {
    if (timer !== null || closed) return;
    timer = setTimeout(() => {
      timer = null;
      check();
    }, opts.debounceMs ?? 150);
  };
  /** Start (or restart) the hints; the directories may not exist until the first run. */
  function attach(): void {
    for (const [dir, recursive] of [
      [advpipe, false],
      [path.join(advpipe, 'runs'), true],
    ] as const) {
      if (watchers.has(dir) || !existsSync(dir)) continue;
      try {
        const w = watch(dir, { recursive }, soon);
        w.on('error', () => {
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
      } catch {
        // no watcher here: the poll covers it
      }
    }
  }
  attach();
  const poll = setInterval(check, opts.pollMs ?? 1000);
  poll.unref();
  return {
    close() {
      closed = true;
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      for (const w of watchers.values()) w.close();
    },
  };
}
