import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { EventLine, type EventLine as EventLineT } from '@advpipe/contracts';
import { checkRunId, EVENTS_FILE, RunLog } from '../core/runlog.js';

// The live log: a run's events.jsonl, read from a byte offset (docs/04 §6). Port of `ui/live.py`'s
// `read_events`/`line_start`, minus the SSE framing: the host pushes what this returns.

export const DEFAULT_MAX_BYTES = 256 * 1024;

export type Tail = {
  lines: EventLineT[];
  /** The byte offset just past the last complete line returned; pass it back for the next read. */
  next_offset: number;
  /** Nothing is driving the run any more and everything it wrote has been read. */
  ended: boolean;
};

function readRange(file: string, start: number, length: number): { data: Buffer; size: number } {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { data: Buffer.alloc(0), size: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    const wanted = Math.max(0, Math.min(length, size - start));
    const data = Buffer.alloc(wanted);
    let got = 0;
    while (got < wanted) {
      const n = readSync(fd, data, got, wanted - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return { data: data.subarray(0, got), size };
  } finally {
    closeSync(fd);
  }
}

/**
 * `offset` clamped to the file and moved forward to the start of a line, if it points into the
 * middle of one (a stale offset, or a file that was replaced).
 */
export function lineStart(file: string, offset: number): number {
  const { size } = readRange(file, 0, 0);
  const at = Math.min(Math.max(Math.trunc(offset) || 0, 0), size);
  if (at === 0) return 0;
  const before = readRange(file, at - 1, 1).data;
  if (before[0] === 0x0a) return at;
  const rest = readRange(file, at, size - at).data;
  const newline = rest.indexOf(0x0a);
  return newline === -1 ? size : at + newline + 1;
}

/** A line that isn't an event becomes a visible error line, never a crash. */
function parseLine(line: string): EventLineT {
  try {
    const parsed = EventLine.safeParse(JSON.parse(line));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  return {
    ts: '',
    kind: 'error',
    stage: 'INIT',
    round: 0,
    message: `unreadable log line: ${line}`,
  };
}

/** Complete lines of `file` from `offset`, at most about `maxBytes` of them. */
export function readEvents(
  file: string,
  offset: number,
  maxBytes = DEFAULT_MAX_BYTES,
): { lines: EventLineT[]; next_offset: number } {
  const start = lineStart(file, offset);
  let want = maxBytes;
  for (;;) {
    const { data, size } = readRange(file, start, want);
    const end = data.lastIndexOf(0x0a) + 1; // a trailing partial line is still being written
    if (end === 0 && start + data.length < size) {
      want *= 2; // one line bigger than the window: widen it
      continue;
    }
    const lines = data
      .subarray(0, end)
      .toString('utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map(parseLine);
    return { lines, next_offset: start + end };
  }
}

/**
 * New events of a run since `offset`. `ended` is true once no live process holds run.lock and the
 * read has reached the end of the file, checked again after the lock test so a last line written
 * between the two is not missed.
 */
export function tailEvents(
  repo: string,
  runId: string,
  offset: number,
  maxBytes = DEFAULT_MAX_BYTES,
): Tail {
  const runlog = RunLog.forRun(repo, checkRunId(runId));
  const file = runlog.path(EVENTS_FILE);
  const first = readEvents(file, offset, maxBytes);
  if (runlog.lockHolder() !== null) return { ...first, ended: false };
  const more = readEvents(file, first.next_offset, maxBytes);
  // Caught up: nothing complete is left (a line still being written doesn't count).
  const left = readRange(file, more.next_offset, 64 * 1024).data;
  return {
    lines: [...first.lines, ...more.lines],
    next_offset: more.next_offset,
    ended: left.indexOf(0x0a) === -1,
  };
}
