import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** End `pid` and everything it started: `taskkill /T /F` on Windows, the process group elsewhere. */
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL'); // gates and workers lead their own process group
    }
  } catch {
    // already gone
  }
}

/**
 * Whether `pid` looks like an advpipe worker, so a stale run.lock whose pid now belongs to an
 * unrelated process is never signalled or killed. Linux can check `/proc/<pid>/cmdline`; elsewhere
 * there is nothing to check and the lock is trusted.
 */
export function looksLikeWorker(pid: number): boolean {
  if (process.platform !== 'linux') return true;
  let args: string[];
  try {
    args = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0');
  } catch {
    return false;
  }
  return args.includes('--start') && args.some((a) => /(^|[\\/])worker(-fake)?\.js$/.test(a));
}
