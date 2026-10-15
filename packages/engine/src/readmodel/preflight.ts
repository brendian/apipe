import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { LOGIN_LABELS, type Preflight } from '@advpipe/contracts';
import { git, gitOk } from '../core/git.js';
import { loadCache } from '../core/usage.js';

// The first-run checks (docs/05 §5.0): is git there, is this a git repo with a commit, is Claude
// Code bundled, which login is known. Nothing here blocks reading old runs; a failing check only
// blocks *New run*, and says exactly what to do.

export const DEFAULT_ITEMS_DIR = 'work-items';

/** `/home/me/code/x` as `~/code/x`. */
export function tildePath(p: string, home: string = os.homedir()): string {
  const rel = path.relative(home, p);
  return rel === '' ? '~' : rel.startsWith('..') || path.isAbsolute(rel) ? p : `~/${rel}`;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The SDK's bundled Claude Code binary (its per-platform package), if this install has it. */
export function findClaudeBinary(): { path: string; version: string } | null {
  const require = createRequire(import.meta.url);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const names = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
  for (const name of names) {
    try {
      const pkgFile = require.resolve(`${name}/package.json`);
      const binary = path.join(
        path.dirname(pkgFile),
        process.platform === 'win32' ? 'claude.exe' : 'claude',
      );
      if (!existsSync(binary)) continue;
      const version = (JSON.parse(readFileSync(pkgFile, 'utf-8')) as { version?: string }).version;
      return { path: binary, version: version ?? '' };
    } catch {
      // try the next one
    }
  }
  return null;
}

async function checkGit(repo: string): Promise<Preflight['git']> {
  try {
    const out = (await git(repo, '--version')).trim();
    const version = out.replace(/^git version\s+/, '');
    return { ok: true, level: 'ok', version, text: `git ${version} found` };
  } catch {
    return {
      ok: false,
      level: 'bad',
      version: '',
      text: "git wasn't found. Install git, then reopen this window.",
    };
  }
}

async function checkRepo(repo: string, gitOkFlag: boolean): Promise<Preflight['repo']> {
  const shown = tildePath(repo);
  const bad = (text: string, extra: Partial<Preflight['repo']> = {}): Preflight['repo'] => ({
    ok: false,
    level: 'bad',
    is_git: false,
    has_commit: false,
    branch: '',
    dirty: 0,
    text,
    ...extra,
  });
  if (!isDir(repo)) return bad(`${shown} isn't a folder (was it moved or deleted?).`);
  if (!gitOkFlag) return bad(`Can't check ${shown} without git.`);
  let top: string;
  try {
    top = (await git(repo, 'rev-parse', '--show-toplevel')).trim();
  } catch {
    return bad("This folder isn't a git repo. Run `git init` and make a first commit.");
  }
  if (real(top) !== real(repo)) {
    return bad(`${shown} is inside the git repo at ${tildePath(top)}. Open that folder instead.`, {
      is_git: true,
    });
  }
  const hasCommit = await gitOk(repo, 'rev-parse', '--verify', '-q', 'HEAD');
  if (!hasCommit) {
    return bad(
      `${shown} is a git repo with no commits yet. Make a first commit: a working copy needs one to start from.`,
      { is_git: true },
    );
  }
  let branch: string;
  try {
    branch = (await git(repo, 'symbolic-ref', '--short', '-q', 'HEAD')).trim();
  } catch {
    branch = 'a detached HEAD';
  }
  const status = await git(repo, 'status', '--porcelain=v1');
  const dirty = status
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.slice(3).startsWith('.advpipe')).length;
  const changes =
    dirty === 0 ? 'no uncommitted files' : `${dirty} uncommitted file${dirty === 1 ? '' : 's'}`;
  return {
    ok: true,
    level: 'ok',
    is_git: true,
    has_commit: true,
    branch,
    dirty,
    text: `${shown} is a git repo (branch ${branch}, ${changes}). Your working tree is never touched; agents work in a separate copy.`,
  };
}

function checkClaude(repo: string): Preflight['claude'] {
  const found = findClaudeBinary();
  const login = loadCache(repo).login;
  if (!found) {
    return {
      ok: false,
      level: 'bad',
      login,
      version: '',
      text: "Claude Code wasn't found in this install. Reinstall advpipe.",
    };
  }
  if (login === 'unknown') {
    return {
      ok: true,
      level: 'warn',
      login,
      version: found.version,
      text: 'Claude Code found (SDK bundled). Which login it uses is not known yet: advpipe learns it from the first run.',
    };
  }
  return {
    ok: true,
    level: 'ok',
    login,
    version: found.version,
    text: `Claude Code found (SDK bundled). Logged in: ${LOGIN_LABELS[login]}`,
  };
}

export async function preflight(
  repo: string,
  itemsDir: string = DEFAULT_ITEMS_DIR,
): Promise<Preflight> {
  const gitCheck = await checkGit(isDir(repo) ? repo : process.cwd());
  const repoCheck = await checkRepo(repo, gitCheck.ok);
  const exists = isDir(path.join(repo, itemsDir));
  return {
    git: gitCheck,
    repo: repoCheck,
    claude: checkClaude(repo),
    items_dir: {
      ok: true,
      level: exists ? 'ok' : 'warn',
      path: itemsDir,
      exists,
      text: exists
        ? `Work items live in ${itemsDir}/.`
        : `There is no ${itemsDir}/ folder yet: it is created when you make your first work item.`,
    },
  };
}
