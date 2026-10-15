import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pidAlive } from './runlog.js';

// Repo-wide lock for operations that change repo-level git metadata (docs/04 §3.4): choosing a
// branch name and adding the worktree must be one step, or two workers pick the same branch.

export const GIT_LOCK_STALE_MS = 2 * 60_000;
const WAIT_MS = 30_000;
const FIRST_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 1000;

export class GitLockTimeout extends Error {
  override name = 'GitLockTimeout';
}

export const gitLockPath = (repo: string): string => path.join(repo, '.advpipe', 'git.lock');

function isStale(file: string, now: number): boolean {
  let held: { pid?: unknown; ts?: unknown };
  try {
    held = JSON.parse(readFileSync(file, 'utf-8')) as typeof held;
  } catch {
    // Unreadable: either being written this instant or junk. Treat as stale only once old.
    try {
      return now - statSync(file).mtimeMs > GIT_LOCK_STALE_MS;
    } catch {
      return false; // vanished: the next create attempt will succeed
    }
  }
  if (typeof held.pid !== 'number' || !pidAlive(held.pid)) return true;
  return typeof held.ts !== 'number' || now - held.ts > GIT_LOCK_STALE_MS;
}

function tryCreate(file: string): boolean {
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** Run `fn` holding the repo's git lock. Never hold it across an agent call, a gate or a worktree commit. */
export async function withGitLock<T>(
  repo: string,
  fn: () => Promise<T>,
  waitMs: number = WAIT_MS,
): Promise<T> {
  const file = gitLockPath(repo);
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  let backoff = FIRST_BACKOFF_MS;
  while (!tryCreate(file)) {
    if (isStale(file, Date.now())) {
      try {
        unlinkSync(file);
      } catch {
        // someone else stole it first; loop and try to create again
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new GitLockTimeout(
        `Another advpipe run is changing this repository's git state (${file}). Try again in a moment.`,
      );
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // already gone (stolen as stale); nothing to release
    }
  }
}
