import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/sample_repo',
);

/** Synchronous git with a fixed identity, for test setup and assertions. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A copy of fixtures/sample_repo as a git repo on `main` with one commit. Never edits the fixture. */
export function makeTargetRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'advpipe-repo-'));
  cpSync(SAMPLE, dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'baseline');
  return dir;
}
