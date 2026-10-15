import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cleanInfo,
  cleanRun,
  ControlError,
  FakeAgentRunner,
  Orchestrator,
  pidAlive,
  RunLog,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import { happyScripts } from './helpers/samples.js';

// `clean` rules and run-id safety, in-process (the real-child tests are process.test.ts).

beforeAll(scrubEnv);

const branches = (repo: string): string[] =>
  git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);

/** A dead run: the spec writer wrote no task.md, so it stopped needs_human with nothing committed. */
async function deadRun(repo: string, runId = 'r1') {
  const runner = new FakeAgentRunner({ 'spec-writer': ['wrote nothing'] });
  const state = await new Orchestrator(testConfig(), runner, repo, 'add clamp', {
    runId,
    name: runId,
  }).run();
  expect(state.status).toBe('needs_human');
  return state;
}

describe('cleanRun', () => {
  it('removes the worktree and branch, then the log; says what it would do first', async () => {
    const repo = makeTargetRepo();
    const state = await deadRun(repo);
    const info = await cleanInfo(repo, state);
    expect(info).toMatchObject({ refusal: null, branch: 'advpipe/r1', unmerged_commits: 0 });

    const done = await cleanRun(repo, 'r1');
    expect(done.join()).toContain('removed worktree');
    expect(branches(repo)).not.toContain('advpipe/r1');
    const log = RunLog.forRun(repo, 'r1');
    expect(log.readState().notes.at(-1)).toMatch(/^Cleaned up/);

    await cleanRun(repo, 'r1', { logs: true });
    expect(RunLog.forRun(repo, 'r1').readConfig()).toBeNull();
  });

  it('refuses a complete run, an active run (even forced) and unknown ids', async () => {
    const repo = makeTargetRepo();
    const ok = await new Orchestrator(
      testConfig(),
      new FakeAgentRunner(happyScripts()),
      repo,
      'w',
      {
        runId: 'ok',
      },
    ).run();
    expect(ok.status).toBe('complete');
    await expect(cleanRun(repo, 'ok', { force: true })).rejects.toThrow(/is complete/);

    await deadRun(repo, 'busy');
    RunLog.forRun(repo, 'busy').acquireLock(process.pid);
    await expect(cleanRun(repo, 'busy', { force: true })).rejects.toThrow(/cancel it first/);
    expect(branches(repo)).toContain('advpipe/busy');
    await expect(cleanRun(repo, 'nope')).rejects.toThrow(ControlError);
  });

  it('refuses a branch holding commits nothing else has, unless forced', async () => {
    const repo = makeTargetRepo();
    // Over budget after the spec was committed: the branch has one commit of its own.
    const runner = new FakeAgentRunner(happyScripts(), { costPerCall: 2.0 });
    const state = await new Orchestrator(testConfig(), runner, repo, 'add clamp', {
      runId: 'r1',
      name: 'r1',
    }).run();
    expect(state.status).toBe('budget_exceeded');
    await expect(cleanRun(repo, 'r1')).rejects.toThrow(/1 commit\(s\) that no other branch has/);
    expect(branches(repo)).toContain('advpipe/r1');
    await cleanRun(repo, 'r1', { force: true });
    expect(branches(repo)).not.toContain('advpipe/r1');
  });

  it('only touches its own worktree and an advpipe/ branch, whatever run.json says', async () => {
    const repo = makeTargetRepo();
    const state = await deadRun(repo);
    const log = RunLog.forRun(repo, 'r1');

    log.writeState({ ...state, branch: 'main' });
    await expect(cleanRun(repo, 'r1', { force: true })).rejects.toThrow(
      /isn't an advpipe\/ branch/,
    );
    expect(branches(repo)).toContain('main');

    const outside = path.dirname(repo);
    log.writeState({ ...state, worktree: outside });
    await expect(cleanRun(repo, 'r1', { force: true })).rejects.toThrow(
      /isn't under .advpipe\/worktrees/,
    );
  });
});

describe('ids and liveness', () => {
  it.each(['..', '../r1', 'r1/../r1', '/etc', '-x', '.hidden', '%2e%2e', ''])(
    'run id %j cannot name a path',
    async (bad) => {
      const repo = makeTargetRepo();
      await expect(cleanRun(repo, bad, { force: true, logs: true })).rejects.toThrow(
        /invalid run id/,
      );
      expect(() => RunLog.forRun(repo, bad)).toThrow(/invalid run id/);
    },
  );

  it('pidAlive: this process yes, a reaped child no', () => {
    expect(pidAlive(process.pid)).toBe(true);
    const child = spawnSync(process.execPath, ['-e', '0']);
    expect(pidAlive(child.pid)).toBe(false);
  });
});
