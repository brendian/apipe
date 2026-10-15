import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  branchExists,
  gitLockPath,
  unmergedCommits,
  withGitLock,
  Workspace,
} from '../src/index.js';
import { git, makeTargetRepo } from './helpers/repo.js';

let repo: string;
beforeEach(() => {
  repo = makeTargetRepo();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('Workspace', () => {
  it('is isolated from the user tree and keeps .advpipe/ out of git status', async () => {
    const ws = await Workspace.create(repo, 'w1');
    expect(ws.branch).toBe('advpipe/w1');
    expect(git(ws.path, 'branch', '--show-current').trim()).toBe('advpipe/w1');
    writeFileSync(path.join(ws.path, 'new.js'), 'x\n');
    await ws.commit('add new');
    expect(existsSync(path.join(repo, 'new.js'))).toBe(false);
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('reports changed files and diffs (untracked included) and restores them', async () => {
    const ws = await Workspace.create(repo, 'w2');
    const base = await ws.head();
    writeFileSync(path.join(ws.path, 'tests', 'core.test.js'), '// gutted\n');
    writeFileSync(path.join(ws.path, 'tests', 'new test.js'), '// new\n'); // a space in the name
    writeFileSync(path.join(ws.path, 'mathutils', 'core.js'), '// changed\n');

    expect(await ws.changedFiles(base, ['tests/'])).toEqual([
      'tests/core.test.js',
      'tests/new test.js',
    ]);
    expect((await ws.diff(base, ['tests/'])).match(/diff --git/g)).toHaveLength(2);

    await ws.restore(base, ['tests/core.test.js', 'tests/new test.js']);
    expect(await ws.changedFiles(base, ['tests/'])).toEqual([]);
    expect(existsSync(path.join(ws.path, 'tests', 'new test.js'))).toBe(false);
    expect(readFileSync(path.join(ws.path, 'tests', 'core.test.js'), 'utf-8')).toContain('mean');
    expect(await ws.changedFiles(base)).toEqual(['mathutils/core.js']);
  });

  it('commitPaths commits only the named files; hasChanges sees the rest', async () => {
    const ws = await Workspace.create(repo, 'w3');
    writeFileSync(path.join(ws.path, 'a.js'), 'a\n');
    writeFileSync(path.join(ws.path, 'b.js'), 'b\n');
    await ws.commitPaths('only a', ['a.js']);
    expect(git(ws.path, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('a.js');
    expect(await ws.hasChanges()).toBe(true);
  });

  it('names branches from the work item and suffixes collisions; dirs stay keyed by run id', async () => {
    const a = await Workspace.create(repo, 'w1', 'Fix the refund rounding bug');
    const b = await Workspace.create(repo, 'w2', 'Fix the refund rounding bug');
    const c = await Workspace.create(repo, 'w3', 'fix refund rounding bug!');
    expect([a.branch, b.branch, c.branch]).toEqual([
      'advpipe/fix-refund-rounding-bug',
      'advpipe/fix-refund-rounding-bug-2',
      'advpipe/fix-refund-rounding-bug-3',
    ]);
    expect(path.basename(a.path)).toBe('w1');
    expect(await branchExists(repo, a.branch)).toBe(true);
  });

  it('parallel creations pick distinct branches (the git lock)', async () => {
    const all = await Promise.all(
      Array.from({ length: 6 }, (_, i) => Workspace.create(repo, `p${i}`, 'same task')),
    );
    expect(new Set(all.map((w) => w.branch)).size).toBe(6);
    expect(existsSync(gitLockPath(repo))).toBe(false);
  });

  it('reopen discards uncommitted work unless keepChanges, and rebuilds a deleted worktree', async () => {
    const ws = await Workspace.create(repo, 'w4');
    const file = path.join(ws.path, 'tmp.js');
    writeFileSync(file, 'x\n');
    await Workspace.reopen(repo, ws.path, ws.branch, { keepChanges: true });
    expect(existsSync(file)).toBe(true);
    await Workspace.reopen(repo, ws.path, ws.branch);
    expect(existsSync(file)).toBe(false);

    await ws.commit('work');
    rmSync(ws.path, { recursive: true, force: true }); // user deleted the directory
    const again = await Workspace.reopen(repo, ws.path, ws.branch);
    expect(git(again.path, 'log', '-1', '--format=%s').trim()).toBe('work');
  });

  it('remove deletes the directory but keeps the branch; unmergedCommits counts its commits', async () => {
    const ws = await Workspace.create(repo, 'w5');
    expect(await unmergedCommits(repo, ws.branch)).toBe(0);
    writeFileSync(path.join(ws.path, 'c.js'), 'c\n');
    await ws.commit('c');
    expect(await unmergedCommits(repo, ws.branch)).toBe(1);
    await ws.remove();
    expect(existsSync(ws.path)).toBe(false);
    expect(await branchExists(repo, ws.branch)).toBe(true);
  });
});

describe('git lock', () => {
  it('steals a lock whose process is dead, and times out on a live one', async () => {
    const file = gitLockPath(repo);
    await withGitLock(repo, async () => {}); // creates .advpipe/
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, ts: Date.now() }));
    await expect(withGitLock(repo, async () => 'ok')).resolves.toBe('ok');

    writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    await expect(withGitLock(repo, async () => 'x', 300)).rejects.toThrow(/Another advpipe run/);
    rmSync(file);
  });
});
