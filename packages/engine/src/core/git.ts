import { execFile } from 'node:child_process';

// The one place the engine runs git: argument arrays only, never a shell (docs/08 §3.7).

/** Commits and merges made by advpipe carry this identity, whatever the user's git config says. */
export const GIT_IDENTITY = ['-c', 'user.name=advpipe', '-c', 'user.email=advpipe@localhost'];

// Unattended: never sign (a signing key could prompt), never ask for a password.
const GIT_OPTIONS = [...GIT_IDENTITY, '-c', 'commit.gpgsign=false'];

export class GitError extends Error {
  override name = 'GitError';
}

const MAX_BUFFER = 256 * 1024 * 1024;
const LOCK_RETRIES = 5;
const LOCK_RETRY_MS = 100;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  delete env.ELECTRON_RUN_AS_NODE; // belongs to the worker only (docs/04 §10)
  return env;
}

type Raw = { code: number; stdout: string; stderr: string };

function runGit(cwd: string, args: string[]): Promise<Raw> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GIT_OPTIONS, ...args],
      { cwd, env: gitEnv(), maxBuffer: MAX_BUFFER, encoding: 'utf-8', windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = (err as NodeJS.ErrnoException).code;
        if (typeof code === 'number') return resolve({ code, stdout, stderr });
        reject(new GitError(`git ${args.join(' ')} failed: ${err.message}`)); // e.g. git missing
      },
    );
  });
}

/** Run `git <args>` in `cwd` and return stdout; throws `GitError` on a non-zero exit. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await runGit(cwd, args);
    if (r.code === 0) return r.stdout;
    // Ref locks can collide across separate workers; the other side finishes in milliseconds.
    if (attempt < LOCK_RETRIES && /Unable to create '.*\.lock': File exists/.test(r.stderr)) {
      await new Promise((r2) => setTimeout(r2, LOCK_RETRY_MS * (attempt + 1)));
      continue;
    }
    throw new GitError(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  }
}

/** Run git and report only whether it exited 0 (for yes/no questions such as `rev-parse --verify`). */
export async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  return (await runGit(cwd, args)).code === 0;
}
