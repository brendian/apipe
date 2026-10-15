import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BRANCH_PREFIX, slugify } from '@advpipe/contracts';
import { git, gitOk } from './git.js';
import { withGitLock } from './gitlock.js';

export const MAX_DIFF_CHARS = 60_000;

const nul = (out: string): string[] => out.split('\0').filter(Boolean);

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return gitOk(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
}

/** Commits on `branch` that no other local branch contains (lost if it's deleted). */
export async function unmergedCommits(repo: string, branch: string): Promise<number> {
  const out = await git(
    repo,
    'rev-list',
    '--count',
    `refs/heads/${branch}`,
    '--not',
    `--exclude=${branch}`,
    '--branches',
  );
  return Number.parseInt(out.trim(), 10);
}

/** `advpipe/<slug of name>`, with -2, -3, ... appended if that branch already exists. */
export async function uniqueBranch(repo: string, name: string): Promise<string> {
  const base = BRANCH_PREFIX + slugify(name);
  let branch = base;
  for (let n = 1; await branchExists(repo, branch);) branch = `${base}-${++n}`;
  return branch;
}

/** Keep .advpipe/ out of the user's `git status` without editing tracked files. */
async function excludeAdvpipeDir(repo: string): Promise<void> {
  let exclude = (await git(repo, 'rev-parse', '--git-path', 'info/exclude')).trim();
  if (!path.isAbsolute(exclude)) exclude = path.join(repo, exclude);
  mkdirSync(path.dirname(exclude), { recursive: true });
  const existing = existsSync(exclude) ? readFileSync(exclude, 'utf-8') : '';
  if (existing.split(/\r?\n/).includes('.advpipe/')) return;
  const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileSync(exclude, `${existing}${sep}.advpipe/\n`);
}

const toplevel = async (repo: string): Promise<string> =>
  path.resolve((await git(repo, 'rev-parse', '--show-toplevel')).trim());

/** A git worktree on its own `advpipe/...` branch; the user's working tree is untouched. */
export class Workspace {
  constructor(
    readonly repo: string,
    readonly path: string,
    readonly branch: string,
  ) {}

  /**
   * New worktree off the repo's current HEAD, on branch `advpipe/<slug of name>`. `name` defaults
   * to the run id. The worktree directory is always named after the run id.
   */
  static async create(repo: string, runId: string, name?: string): Promise<Workspace> {
    const root = await toplevel(repo);
    const dir = path.join(root, '.advpipe', 'worktrees', runId);
    const branch = await withGitLock(root, async () => {
      await excludeAdvpipeDir(root);
      const b = await uniqueBranch(root, name ?? runId);
      await git(root, 'worktree', 'add', '-q', '-b', b, dir, 'HEAD');
      return b;
    });
    return new Workspace(root, dir, branch);
  }

  /**
   * Reattach to a run's worktree, discarding uncommitted work from an interrupted stage.
   * `keepChanges` leaves the uncommitted work alone: used when a person has just decided what to
   * do about it.
   */
  static async reopen(
    repo: string,
    dir: string,
    branch: string,
    opts: { keepChanges?: boolean } = {},
  ): Promise<Workspace> {
    const root = await toplevel(repo);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      if (!opts.keepChanges) {
        await git(dir, 'reset', '-q', '--hard', 'HEAD');
        await git(dir, 'clean', '-q', '-fd');
      }
    } else {
      await withGitLock(root, async () => {
        await git(root, 'worktree', 'prune');
        await git(root, 'worktree', 'add', '-q', dir, branch);
      });
    }
    return new Workspace(root, dir, branch);
  }

  /** Delete the worktree directory. The branch (and all committed work) is kept. */
  async remove(): Promise<void> {
    // Run from the repo root: on Windows a process whose cwd is inside the worktree blocks removal.
    await withGitLock(this.repo, () => git(this.repo, 'worktree', 'remove', '--force', this.path));
  }

  /** Whether anything in the worktree is uncommitted (changed, staged or untracked). */
  async hasChanges(): Promise<boolean> {
    return (await git(this.path, 'status', '--porcelain')).trim() !== '';
  }

  async head(): Promise<string> {
    return (await git(this.path, 'rev-parse', 'HEAD')).trim();
  }

  async commit(message: string): Promise<string> {
    await git(this.path, 'add', '-A');
    await git(this.path, 'commit', '-q', '--allow-empty', '--no-verify', '-m', message);
    return this.head();
  }

  /** Commit only `files` (added, changed or deleted); other changes stay uncommitted. */
  async commitPaths(message: string, files: string[]): Promise<string> {
    await git(this.path, 'add', '-A', '--', ...files);
    await git(this.path, 'commit', '-q', '--no-verify', '-m', message, '--', ...files);
    return this.head();
  }

  /** Diff of the working tree (including untracked files) against `base`. */
  async diff(base: string, paths: string[] = []): Promise<string> {
    await git(this.path, 'add', '-A', '--intent-to-add');
    let text = await git(this.path, 'diff', base, '--', ...paths);
    if (text.length > MAX_DIFF_CHARS) text = text.slice(0, MAX_DIFF_CHARS) + '\n[diff truncated]\n';
    return text;
  }

  /** Tracked files changed since `base` plus untracked files, limited to `paths`. */
  async changedFiles(base: string, paths: string[] = []): Promise<string[]> {
    const changed = nul(await git(this.path, 'diff', '--name-only', '-z', base, '--', ...paths));
    const untracked = nul(
      await git(this.path, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...paths),
    );
    return [...new Set([...changed, ...untracked])].sort();
  }

  /** Put `files` back to their state at `base`; delete files that didn't exist there. */
  async restore(base: string, files: string[]): Promise<void> {
    const existed = new Set(nul(await git(this.path, 'ls-tree', '-r', '--name-only', '-z', base)));
    for (const f of files) {
      if (existed.has(f)) {
        await git(this.path, 'checkout', base, '--', f);
      } else {
        await git(this.path, 'rm', '-q', '--cached', '--ignore-unmatch', '--', f);
        try {
          unlinkSync(path.join(this.path, f));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
    }
  }
}
