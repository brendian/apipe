import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LEVEL_ORDER,
  maxAgentCalls,
  rolesFor,
  SHAPES,
  type Config,
  type Level,
} from '@advpipe/contracts';
import {
  awaitingDecision,
  checkResumable,
  decide,
  DecisionError,
  FakeAgentRunner,
  interrupt,
  Cancelled,
  Orchestrator,
  recordAnswers,
  RunLog,
  verdictPass,
  writes,
  type Role,
  type Scripts,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import {
  happyScripts,
  IMPL_WRONG,
  SOLO_OK,
  SOLO_WRONG,
  TASK_MD,
  TASK_MD_BLOCKING,
} from './helpers/samples.js';

// The invariants of docs/02 §18 that hold at every level, run at all five.

beforeEach(scrubEnv);

const at = (level: Level): Config => {
  const c = testConfig();
  return { ...c, pipeline: { ...c.pipeline, level } };
};

/** Only the roles a level can call: a call to any other role would fail loudly. */
const keep = (scripts: Scripts, level: Level): Scripts =>
  Object.fromEntries(
    Object.entries(scripts).filter(([role]) => rolesFor(level).includes(role as Role)),
  ) as Scripts;

const happy = (level: Level): Scripts =>
  SHAPES[level].solo
    ? keep({ solo: [SOLO_OK], 'code-critic': [verdictPass()] }, level)
    : keep(happyScripts(), level);

const red = (level: Level): Scripts =>
  SHAPES[level].solo
    ? keep({ solo: [SOLO_WRONG] }, level)
    : keep(
        {
          ...happyScripts(),
          coder: [writes(IMPL_WRONG), 'tried', 'tried', 'tried'],
          'code-critic': [verdictPass(), verdictPass(), verdictPass()],
        },
        level,
      );

async function start(config: Config, repo: string, scripts: Scripts, bypass = false) {
  const runner = new FakeAgentRunner(scripts);
  const cfg = bypass
    ? { ...config, pipeline: { ...config.pipeline, bypass_questions: true } }
    : config;
  const state = await new Orchestrator(cfg, runner, repo, 'add clamp', {
    runId: 'r1',
    name: 'r1',
  }).run();
  return { state, runner };
}

describe.each(LEVEL_ORDER)('at level %s', (level) => {
  it('the happy path makes exactly the planned calls, with only its own roles', async () => {
    const config = at(level);
    const { state, runner } = await start(config, makeTargetRepo(), happy(level));
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect([state.level, state.decisions]).toEqual([level, []]);
    expect(runner.calls).toHaveLength(maxAgentCalls(level, config.limits)[0]);
    expect(runner.calls.every((c) => rolesFor(level).includes(c.role))).toBe(true);
  });

  it('red checks stop and ask within the worst case, leave the worktree, and nothing resumes it', async () => {
    const repo = makeTargetRepo();
    const config = at(level);
    const { state, runner } = await start(config, repo, red(level));
    const d = state.decisions.at(-1);
    expect([state.status, d?.kind, d?.choice]).toEqual(['needs_human', 'red_checks', '']);
    expect(awaitingDecision(state)).toBe(true);
    expect(runner.calls.length).toBeLessThanOrEqual(maxAgentCalls(level, config.limits)[1]);
    expect('solo' in state.commits || 'code' in state.commits).toBe(false);
    expect(git(state.worktree, 'status', '--porcelain').trim()).not.toBe('');
    await expect(checkResumable(repo, 'r1')).rejects.toThrow(/waiting for a decision/);
    await expect(Orchestrator.resume(new FakeAgentRunner({}), repo, 'r1')).rejects.toThrow(
      /waiting for a decision/,
    );
    expect([state.fix_passes, state.ended_by]).toEqual([0, '']);
  });

  it('fix passes never exceed the cap: one pass by the stage author, no critic', async () => {
    const repo = makeTargetRepo();
    const config = at(level);
    await start({ ...config, limits: { ...config.limits, max_fix_passes: 1 } }, repo, red(level));
    const author: Role = SHAPES[level].solo ? 'solo' : 'coder';
    await decide(repo, 'r1', 'fix');
    const runner = new FakeAgentRunner({ [author]: ['still red'] });
    const state = await (await Orchestrator.resume(runner, repo, 'r1')).run();
    expect([state.status, state.fix_passes]).toEqual(['needs_human', 1]);
    expect(runner.calls.map((c) => c.role)).toEqual([author]);
    await expect(decide(repo, 'r1', 'fix')).rejects.toThrow(DecisionError);
    await expect(decide(repo, 'r1', 'fix')).rejects.toThrow(/fix passes/);
  });

  it('no agent output can make a decision', async () => {
    const scripts = red(level);
    for (const role of Object.keys(scripts) as Role[]) {
      scripts[role] = [...(scripts[role] ?? []), ...Array<string>(4).fill('decide: takeover')];
    }
    const { state } = await start(at(level), makeTargetRepo(), scripts);
    expect([state.decisions.at(-1)?.choice, state.ended_by]).toEqual(['', '']);
  });

  it('blocking questions stop the run unless Bypass was chosen up front', async () => {
    const asks: Scripts = SHAPES[level].solo
      ? { solo: [writes({ 'task.md': TASK_MD_BLOCKING })] }
      : { 'spec-writer': [writes({ 'task.md': TASK_MD_BLOCKING })] };
    const { state } = await start(at(level), makeTargetRepo(), asks);
    expect([state.status, state.questions.length]).toEqual(['needs_human', 1]);
    expect(state.open_findings.map((f) => f.criterion)).toEqual(['open-question']);

    // Up front, the agent decides it and the pass is rerun; the level's roles only.
    const up = SHAPES[level].solo
      ? keep(
          {
            solo: [writes({ 'task.md': TASK_MD_BLOCKING }), 'not json', 'not json', SOLO_OK],
            'code-critic': [verdictPass()],
          },
          level,
        )
      : keep(
          {
            ...happyScripts(),
            'spec-writer': [
              writes({ 'task.md': TASK_MD_BLOCKING }),
              'not json',
              'not json',
              writes({ 'task.md': TASK_MD }),
            ],
          },
          level,
        );
    const done = await start(at(level), makeTargetRepo(), up, true);
    expect(done.state.status, done.state.notes.join('; ')).toBe('complete');
    expect(done.state.questions[0]).toMatchObject({ bypassed: true, source: 'agent' });
    expect(done.state.notes.some((n) => n.includes('stand-in answer'))).toBe(true);
  });
});

describe('Tests level: resume and answers', () => {
  it('resuming at the review reruns the checks for the reviewer', async () => {
    const repo = makeTargetRepo();
    const s = { ...happyScripts(), 'code-critic': [interrupt()] };
    const orch = new Orchestrator(at('tests'), new FakeAgentRunner(s), repo, 'add clamp', {
      runId: 'r1',
      name: 'r1',
    });
    await expect(orch.run()).rejects.toBeInstanceOf(Cancelled);
    const runner = new FakeAgentRunner({ 'code-critic': [verdictPass()] });
    const state = await (await Orchestrator.resume(runner, repo, 'r1')).run();
    expect([state.status, state.level]).toEqual(['complete', 'tests']);
    expect(runner.callsFor('code-critic')[0]?.prompt).toContain('test: PASS');
  });

  it('questions are answered exactly as at Full, and the answer reaches the reviewer', async () => {
    const repo = makeTargetRepo();
    await start(at('tests'), repo, {
      ...happyScripts(),
      'spec-writer': [writes({ 'task.md': TASK_MD_BLOCKING })],
    });
    await recordAnswers(repo, 'r1', { Q1: 'Raise RangeError.' });
    const runner = new FakeAgentRunner(happyScripts());
    const state = await (await Orchestrator.resume(runner, repo, 'r1')).run();
    expect([state.status, state.spec_passes]).toEqual(['complete', 2]);
    expect(runner.callsFor('spec-writer')[0]?.prompt).toContain('# Your previous task.md');
    expect(runner.callsFor('code-critic')[0]?.prompt).toContain('**Answer:** Raise RangeError.');
    expect(git(repo, 'show', 'advpipe/r1:task.md')).toContain('**Answer:** Raise RangeError.');
    expect(RunLog.forRun(repo, 'r1').readState().level).toBe('tests');
    expect(readFileSync(path.join(RunLog.forRun(repo, 'r1').root, 'task.md'), 'utf-8')).toContain(
      '## Answers',
    );
  });
});

describe('test author', () => {
  it.each(LEVEL_ORDER.filter((l) => !SHAPES[l].solo))(
    'at %s sees task.md and no implementation, and writes before the coder',
    async (level) => {
      const { state, runner } = await start(at(level), makeTargetRepo(), happy(level));
      expect(state.status).toBe('complete');
      const prompt = runner.callsFor('test-author')[0]?.prompt ?? '';
      expect(prompt).toContain('# task.md');
      expect(prompt).not.toContain('export function clamp');
      expect(prompt).not.toContain('AUTHOR-REASONING');
      const order = runner.calls.map((c) => c.role);
      expect(order.indexOf('test-author')).toBeLessThan(order.indexOf('coder'));
    },
  );
});
