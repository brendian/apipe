import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Config, isValidRunId, RunState } from '@advpipe/contracts';

// Writes `.advpipe/runs/<run-id>/...` in the target repo (docs/03 §6). File access here is
// synchronous on purpose: the files are small, ordering matters (an event is on disk before the
// next line runs), and it keeps every write to one atomic step.

export const EVENTS_FILE = 'events.jsonl';

export class RunLocked extends Error {
  override name = 'RunLocked';
}

/** Whether process `pid` is running. `kill(pid, 0)` is a liveness probe on every OS, Windows too. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false; // 0 and negatives would signal a group
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

/** Whether `pid` names this process (the pid the host wrote to run.lock for the worker). */
export function isThisProcess(pid: number): boolean {
  return pid === process.pid;
}

/** Returns `runId` if it's safe to use as a directory name; throws otherwise. */
export function checkRunId(runId: string): string {
  if (!isValidRunId(runId)) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
  return runId;
}

export const runsDir = (repo: string): string => path.join(repo, '.advpipe', 'runs');

/** `JSON.stringify` with non-ASCII as `\uXXXX` (the format of every `*.json` but run.json/config). */
export function jsonAscii(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent).replace(
    /[\u0080-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write via a temporary file and a rename, so a reader polling a live run never sees half a file. */
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, text, 'utf-8');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows refuses a rename over a file a reader has open; it clears in moments.
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      sleepMs(20 * (attempt + 1));
    }
  }
}

export class RunLog {
  constructor(readonly root: string) {}

  static forRun(repo: string, runId: string): RunLog {
    return new RunLog(path.join(runsDir(repo), checkRunId(runId)));
  }

  path(rel: string): string {
    return path.join(this.root, rel);
  }

  readState(): RunState {
    return RunState.parse(JSON.parse(readFileSync(this.path('run.json'), 'utf-8')));
  }

  writeConfig(config: Config): void {
    this.writeText('config.json', JSON.stringify(config, null, 2));
  }

  readConfig(): Config | null {
    const file = this.path('config.json');
    return existsSync(file) ? Config.parse(JSON.parse(readFileSync(file, 'utf-8'))) : null;
  }

  // A run.lock holding the driving process's pid stops two processes driving one run.
  private get lockFile(): string {
    return this.path('run.lock');
  }

  /** The pid of a live process driving this run, if any. A stale lock never blocks. */
  lockHolder(): number | null {
    let text: string;
    try {
      text = readFileSync(this.lockFile, 'utf-8').trim();
    } catch {
      return null;
    }
    if (!/^[0-9]+$/.test(text)) return null;
    const pid = Number(text);
    return pidAlive(pid) ? pid : null;
  }

  /** Mark the run as driven by `pid` (default: this process). */
  acquireLock(pid?: number): void {
    const holder = this.lockHolder();
    const mine = pid !== undefined ? holder === pid : holder !== null && isThisProcess(holder);
    if (holder !== null && !mine) throw new RunLocked(`run is being driven by pid ${holder}`);
    writeFileAtomic(this.lockFile, String(pid ?? process.pid));
  }

  releaseLock(): void {
    try {
      unlinkSync(this.lockFile);
    } catch {
      // already gone
    }
  }

  /** Rewrite run.json (and `decisions/N.json`, each decision as asked and as decided). */
  writeState(state: RunState): void {
    state.updated_at = new Date().toISOString();
    this.writeText('run.json', JSON.stringify(state, null, 2));
    state.decisions.forEach((d, i) => {
      this.writeText(`decisions/${i + 1}.json`, JSON.stringify(d, null, 2));
    });
  }

  writeText(rel: string, text: string): void {
    writeFileAtomic(this.path(rel), text);
  }

  /** Append one JSON line to events.jsonl; the file is closed per event, so it is flushed at once. */
  appendEvent(event: Record<string, unknown>): void {
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.path(EVENTS_FILE), JSON.stringify(event) + '\n', 'utf-8');
  }

  /** Write `obj` as `\uXXXX`-escaped JSON, 2-space indent (gates, arbiter, spec answers, ...). */
  writeJson(rel: string, obj: unknown): void {
    this.writeText(rel, jsonAscii(obj));
  }
}

export type RunListing = {
  /** Oldest first. */
  runs: RunState[];
  /** Run directories whose run.json could not be read, with the reason. */
  unreadable: { run_id: string; error: string }[];
};

/** All runs recorded in `repo`. One unreadable run never breaks the list. */
export function listRuns(repo: string): RunListing {
  const root = runsDir(repo);
  const runs: RunState[] = [];
  const unreadable: RunListing['unreadable'] = [];
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return { runs, unreadable };
  }
  for (const name of names) {
    if (!isValidRunId(name) || !existsSync(path.join(root, name, 'run.json'))) continue;
    try {
      runs.push(new RunLog(path.join(root, name)).readState());
    } catch (e) {
      unreadable.push({ run_id: name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  runs.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  return { runs, unreadable };
}
