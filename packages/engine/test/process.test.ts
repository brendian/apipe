import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AnswerError,
  cancelRun,
  cleanRun,
  ControlError,
  decide,
  RunLog,
  recordAnswers,
  resumeRun,
  startRun,
  NotResumable,
} from '../src/index.js';
import { branchExists } from '../src/core/workspace.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import {
  ANSWER,
  IMPL_OK,
  IMPL_WRONG,
  SOLO_FILES,
  TASK_MD_BLOCKING,
  TASK_MD_REVISED,
} from './helpers/samples.js';
import {
  agentStarted,
  codeOnward,
  happyJson,
  pidAlive,
  runRequest,
  scratch,
  scriptEnv,
  settled,
  stopped,
  w,
  waitFor,
  WORKER,
} from './helpers/worker.js';

// Real detached workers (the fake-agent build), real git, real files: no UI, no API calls (docs/09 §6).

beforeAll(scrubEnv);

type Setup = { repo: string; dir: string; release: string };
const setup = (): Setup => {
  const dir = scratch();
  return { repo: makeTargetRepo(), dir, release: path.join(dir, 'release') };
};
const opts = (env: Record<string, string>) => ({
  workerEntry: WORKER,
  config: testConfig(),
  env,
});
const resumeOpts = (env: Record<string, string>) => ({ workerEntry: WORKER, env });

describe('detached workers', () => {
  it('starts at once, holds the lock with the child pid, runs to completion', async () => {
    const { repo, dir, release } = setup();
    const env = scriptEnv(dir, {
      scripts: happyJson(),
      hold: { role: 'coder', until: release },
    });
    const started = Date.now();
    const { runId, pid } = startRun(repo, runRequest(repo), opts(env));
    expect(Date.now() - started).toBeLessThan(5_000); // returns while the run goes on
    const log = RunLog.forRun(repo, runId);
    expect(log.lockHolder()).toBe(pid); // the child's pid, before it has written run.json
    await waitFor(() => agentStarted(log, 'coder'));
    expect(log.readState().status).toBe('running');
    expect(log.readConfig()?.pipeline.level).toBe('full'); // the host wrote config.json first

    writeFileSync(release, '');
    await waitFor(() => settled(log));
    expect(log.readState().status).toBe('complete');
    expect(log.lockHolder()).toBeNull();
    expect(readFileSync(log.path('console.log'), 'utf-8')).toContain(`${runId}  complete`);
  }, 90_000);

  it('cancel stops at a safe point, leaves the run resumable, and resume finishes it', async () => {
    const { repo, dir, release } = setup();
    const env = scriptEnv(dir, { scripts: happyJson(), hold: { role: 'coder', until: release } });
    const { runId } = startRun(repo, runRequest(repo), opts(env));
    const log = RunLog.forRun(repo, runId);
    await waitFor(() => agentStarted(log, 'coder'));

    const { done: stopping } = cancelRun(repo, runId);
    expect(await stopping).toEqual({ forced: false });
    await waitFor(() => stopped(log));
    const state = log.readState();
    expect(state.status).toBe('running'); // not an error, not complete: resumable
    expect(state.notes).toContain('Interrupted during CODE');
    expect(Object.keys(state.commits).sort()).toEqual(['spec', 'tests']);
    const last = JSON.parse(
      readFileSync(log.path('events.jsonl'), 'utf-8').trim().split('\n').at(-1)!,
    );
    expect(last).toMatchObject({ final: true, status: 'running' });
    expect(existsSync(log.path('cancel'))).toBe(false);
    expect(() => cancelRun(repo, runId)).toThrow(ControlError); // nothing active now

    const env2 = scriptEnv(dir, { scripts: codeOnward() }, 'resume.json');
    await resumeRun(repo, runId, { ...resumeOpts(env2), budgetUsd: 12.5 });
    await waitFor(() => settled(log));
    expect(log.readState().status).toBe('complete');
    expect(log.readConfig()?.limits.budget_usd_per_task).toBe(12.5); // written back
  }, 120_000);

  it('ends a worker that ignores the cancel, and the run is still resumable', async () => {
    const { repo, dir, release } = setup();
    const env = scriptEnv(dir, {
      scripts: happyJson(),
      hold: { role: 'coder', until: release, ignore_cancel: true },
    });
    const { runId, pid } = startRun(repo, runRequest(repo), opts(env));
    const log = RunLog.forRun(repo, runId);
    await waitFor(() => agentStarted(log, 'coder'));

    expect(await cancelRun(repo, runId, { graceMs: 1_500 }).done).toEqual({ forced: true });
    expect(pidAlive(pid)).toBe(false);
    expect(log.lockHolder()).toBeNull();
    expect(existsSync(log.path('cancel'))).toBe(false);
    expect(log.readState().notes).toContain('Interrupted during CODE (forced stop)');

    const env2 = scriptEnv(dir, { scripts: codeOnward() }, 'resume.json');
    await resumeRun(repo, runId, resumeOpts(env2));
    await waitFor(() => settled(log));
    expect(log.readState().status).toBe('complete');
  }, 120_000);

  it('a killed worker leaves a stale lock that blocks nothing', async () => {
    const { repo, dir, release } = setup();
    const env = scriptEnv(dir, { scripts: happyJson(), hold: { role: 'coder', until: release } });
    const { runId, pid } = startRun(repo, runRequest(repo), opts(env));
    const log = RunLog.forRun(repo, runId);
    await waitFor(() => agentStarted(log, 'coder'));

    process.kill(-pid, 'SIGKILL');
    await waitFor(() => !pidAlive(pid));
    expect(existsSync(log.path('run.lock'))).toBe(true); // left behind
    expect(log.lockHolder()).toBeNull(); // ...and ignored
    expect(log.readState().status).toBe('running');

    await resumeRun(repo, runId, resumeOpts(scriptEnv(dir, { scripts: codeOnward() }, 'r.json')));
    await waitFor(() => settled(log));
    expect(log.readState().status).toBe('complete');
  }, 120_000);

  it('four workers started together in one repo get four distinct branches', async () => {
    const { repo, dir } = setup();
    const env = scriptEnv(dir, { scripts: happyJson() });
    const ids = [0, 1, 2, 3].map(
      () => startRun(repo, runRequest(repo, { name: 'clamp' }), opts(env)).runId,
    );
    const logs = ids.map((id) => RunLog.forRun(repo, id));
    await waitFor(() => logs.every(settled));
    const states = logs.map((l) => l.readState());
    expect(states.map((s) => s.status)).toEqual(['complete', 'complete', 'complete', 'complete']);
    expect(new Set(states.map((s) => s.branch)).size).toBe(4);
  }, 180_000);

  it('a bad start.json makes the worker exit with a message in console.log', async () => {
    const { repo } = setup();
    const log = RunLog.forRun(repo, 'bad-start');
    const start = log.path('start.json');
    log.writeText('start.json', '{"command":"run"}');
    const r = spawnSync(process.execPath, [WORKER, '--start', start], { encoding: 'utf-8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("can't use");
  });
});

describe('answers, decisions and clean-up from the host', () => {
  it('a run that asks is answered, resumed and completes', async () => {
    const { repo, dir } = setup();
    const env = scriptEnv(dir, {
      scripts: { 'spec-writer': [w({ 'task.md': TASK_MD_BLOCKING })] },
    });
    const { runId } = startRun(repo, runRequest(repo), opts(env));
    const log = RunLog.forRun(repo, runId);
    await waitFor(() => settled(log));
    expect(log.readState().status).toBe('needs_human');
    await expect(resumeRun(repo, runId)).rejects.toThrow(NotResumable); // not before it's answered
    await expect(recordAnswers(repo, runId, {})).rejects.toThrow(AnswerError);

    await recordAnswers(repo, runId, { Q1: ANSWER });
    const rest = { ...happyJson(), 'spec-writer': [w({ 'task.md': TASK_MD_REVISED })] };
    await resumeRun(repo, runId, resumeOpts(scriptEnv(dir, { scripts: rest }, 'answered.json')));
    await waitFor(() => settled(log));
    expect(log.readState().status).toBe('complete');
    expect(readFileSync(log.path('task.md'), 'utf-8')).toContain(`**Answer:** ${ANSWER}`);
  }, 120_000);

  it('red checks: fix with a note resumes; takeover ends the run and clean-up needs force', async () => {
    const { repo, dir } = setup();
    const basic = { level: 'basic' as const };
    const wrong = scriptEnv(
      dir,
      { scripts: { solo: [w({ ...SOLO_FILES, ...IMPL_WRONG })] } },
      'wrong.json',
    );

    const a = startRun(repo, runRequest(repo, basic), opts(wrong)).runId;
    const logA = RunLog.forRun(repo, a);
    await waitFor(() => settled(logA));
    expect(logA.readState().decisions.at(-1)?.kind).toBe('red_checks');
    await decide(repo, a, 'fix', 'use a RangeError');
    const fixed = scriptEnv(
      dir,
      { scripts: { solo: [w({ ...SOLO_FILES, ...IMPL_OK })] } },
      'fix.json',
    );
    await resumeRun(repo, a, resumeOpts(fixed));
    await waitFor(() => settled(logA));
    expect(logA.readState().status).toBe('complete');

    const b = startRun(repo, runRequest(repo, basic), opts(wrong)).runId;
    const logB = RunLog.forRun(repo, b);
    await waitFor(() => settled(logB));
    const taken = await decide(repo, b, 'takeover');
    expect(taken.ended_by).toBe('takeover');
    await expect(resumeRun(repo, b)).rejects.toThrow(NotResumable);
    await expect(cleanRun(repo, b)).rejects.toThrow(/commit\(s\) that no other branch has/);
    expect(await branchExists(repo, taken.branch)).toBe(true);
    await cleanRun(repo, b, { force: true, logs: true });
    expect(await branchExists(repo, taken.branch)).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe(''); // the user's working tree was never touched
  }, 120_000);
});
