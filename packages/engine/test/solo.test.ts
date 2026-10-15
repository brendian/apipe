import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { maxAgentCalls, type Config, type Level, type RunState } from '@advpipe/contracts';
import {
  awaitingAnswers,
  awaitingDecision,
  decide,
  FakeAgentRunner,
  finding,
  interrupt,
  Cancelled,
  Orchestrator,
  recordAnswers,
  RunLog,
  verdictFail,
  verdictPass,
  writes,
  type Scripts,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import {
  ANSWER,
  AGENT_ANSWER,
  bypassReply,
  IMPL_OK,
  IMPL_WRONG,
  QUESTION,
  SOLO_ASKS,
  SOLO_OK,
  SOLO_REVISED,
  SOLO_WRONG,
  TASK_MD,
  TASK_MD_BLOCKING,
  TEST_CLAMP,
} from './helpers/samples.js';

beforeEach(scrubEnv);

const at = (level: Level, bypass = false): Config => {
  const c = testConfig();
  return { ...c, pipeline: { ...c.pipeline, level, bypass_questions: bypass } };
};
const logdir = (repo: string): string => RunLog.forRun(repo, 'r1').root;
const stateOf = (repo: string): RunState => RunLog.forRun(repo, 'r1').readState();

async function start(config: Config, repo: string, scripts: Scripts) {
  const runner = new FakeAgentRunner(scripts);
  const state = await new Orchestrator(config, runner, repo, 'add clamp', {
    runId: 'r1',
    name: 'r1',
  }).run();
  return { state, runner };
}

async function carryOn(repo: string, scripts: Scripts, config?: Config) {
  const runner = new FakeAgentRunner(scripts);
  const orch = await Orchestrator.resume(runner, repo, 'r1', config ? { config } : {});
  return { state: await orch.run(), runner };
}

describe('Basic', () => {
  it('one agent writes task.md, tests and code in one commit; the checks decide', async () => {
    const repo = makeTargetRepo();
    const config = at('basic');
    const { state, runner } = await start(config, repo, { solo: [SOLO_OK] });

    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.security_scan).toBe(false);
    expect(runner.calls.map((c) => c.role)).toEqual(['solo']);
    expect(runner.calls).toHaveLength(maxAgentCalls('basic', config.limits)[0]);
    expect(Object.keys(state.commits)).toEqual(['solo']);
    expect(git(repo, 'log', '--format=%s', 'main..advpipe/r1').trim()).toBe(
      'advpipe: solo (task.md, tests, code)',
    );
    const pass1 = path.join(logdir(repo), 'stage-solo/pass-1');
    expect(readFileSync(path.join(pass1, 'author.txt'), 'utf-8')).toBe('AUTHOR-REASONING solo');
    expect(readFileSync(path.join(pass1, 'task.md'), 'utf-8')).toBe(TASK_MD);
    expect(JSON.parse(readFileSync(path.join(pass1, 'gates.json'), 'utf-8'))[0].name).toBe('test');
    const diff = readFileSync(path.join(pass1, 'diff.patch'), 'utf-8');
    expect(diff).toContain('+++ b/mathutils/core.js');
    expect(diff).not.toContain('task.md');
    expect(existsSync(path.join(logdir(repo), 'final-gates.json'))).toBe(true);
    expect(readFileSync(path.join(logdir(repo), 'report.md'), 'utf-8')).toContain(
      '- **Level:** basic (1 of 5): 1 agent · security scan off',
    );
    expect(runner.calls[0]?.prompt).toContain('Write task.md at the repository root first');
    expect(runner.calls[0]?.prompt).toContain('- test: `');
  });

  it('a solo agent that writes no task.md is a blocking guard finding', async () => {
    const { state } = await start(at('basic'), makeTargetRepo(), {
      solo: [writes({ 'tests/clamp.test.js': TEST_CLAMP, ...IMPL_OK })],
    });
    const d = state.decisions.at(-1);
    expect([state.status, d?.kind, d?.stage]).toEqual(['needs_human', 'red_checks', 'SOLO']);
    expect(d?.findings.map((f) => f.criterion)).toEqual(['guard:task-md']);
    expect('solo' in state.commits).toBe(false);
  });

  it('red checks ask at once, with no retry; a fix pass by the solo agent carries a note', async () => {
    const repo = makeTargetRepo();
    const { state, runner } = await start(at('basic'), repo, { solo: [SOLO_WRONG] });
    expect(runner.calls).toHaveLength(1);
    const d = state.decisions.at(-1);
    expect([state.status, state.stage, d?.kind, d?.stage]).toEqual([
      'needs_human',
      'SOLO',
      'red_checks',
      'SOLO',
    ]);
    expect(d?.explanation).toContain("The solo agent doesn't retry by itself.");
    expect(d?.explanation).toContain('Another fix pass by the solo agent');
    expect(git(state.worktree, 'status', '--porcelain').trim()).not.toBe('');

    await decide(repo, 'r1', 'fix', 'clamp must return lo when x < lo');
    const next = await carryOn(repo, { solo: [writes(IMPL_OK, 'fixed it')] });
    expect(next.state.status, next.state.notes.join('; ')).toBe('complete');
    const prompt = next.runner.calls[0]?.prompt ?? '';
    expect(prompt).toContain('Fix pass 1: a person asked for another pass');
    expect(prompt).toContain('clamp must return lo when x < lo');
    expect(prompt).toContain('G-test');
    expect(next.state.fix_passes).toBe(1);
    const pass2 = path.join(logdir(repo), 'stage-solo/pass-2');
    expect(readFileSync(path.join(pass2, 'author.txt'), 'utf-8')).toBe('fixed it');
    expect(JSON.parse(readFileSync(path.join(pass2, 'request.json'), 'utf-8'))).toMatchObject({
      fix_pass: 1,
      note: 'clamp must return lo when x < lo',
    });
  });

  it('takeover hands over the solo work', async () => {
    const repo = makeTargetRepo();
    await start(at('basic'), repo, { solo: [SOLO_WRONG] });
    const ended = await decide(repo, 'r1', 'takeover');
    expect(ended.ended_by).toBe('takeover');
    expect(existsSync(ended.worktree)).toBe(false);
    const shown = git(repo, 'show', '--name-only', '--format=%s', 'advpipe/r1');
    expect(shown).toContain('advpipe: work in progress, handed over');
    expect(shown).toContain('task.md');
  });
});

describe('Basic: blocking questions', () => {
  it('leave only task.md changed, then take answers, and the revision is one more solo pass', async () => {
    const repo = makeTargetRepo();
    const { state, runner } = await start(at('basic'), repo, { solo: [SOLO_ASKS] });
    expect([state.status, state.stage, state.spec_passes]).toEqual(['needs_human', 'SOLO', 1]);
    expect(awaitingAnswers(state, 3)).toBe(true);
    expect(readFileSync(path.join(state.worktree, 'task.md'), 'utf-8')).toBe(TASK_MD_BLOCKING);
    expect(existsSync(path.join(state.worktree, 'mathutils/extra.js'))).toBe(false);
    expect(git(state.worktree, 'diff', '--stat', 'HEAD').trim()).toBe('');
    expect(
      state.notes.some((n) => n.includes('mathutils/extra.js') && n.includes('reverted')),
    ).toBe(true);
    expect(runner.calls).toHaveLength(1);
    const events = readFileSync(path.join(logdir(repo), 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const asked = events.find((e) => e.kind === 'questions');
    expect(asked).toMatchObject({ answerable: true });
    expect(asked.message).toBe(
      "solo agent has 1 blocking question(s); answer them on the run's page.",
    );

    await recordAnswers(repo, 'r1', { Q1: ANSWER });
    const next = await carryOn(repo, { solo: [SOLO_REVISED] });
    expect(next.state.status, next.state.notes.join('; ')).toBe('complete');
    const [call] = next.runner.calls;
    expect(call?.prompt).toContain('# Your previous task.md');
    expect(call?.prompt).toContain(`Q1: ${QUESTION}\nAnswer: ${ANSWER}`);
    expect(git(repo, 'show', 'advpipe/r1:task.md')).toContain(`**Answer:** ${ANSWER}`);
    expect(next.state.spec_passes).toBe(2);
    expect(existsSync(path.join(logdir(repo), 'stage-solo/pass-2/answers.json'))).toBe(true);
  });

  it('Bypass goes to the solo agent, as a person choice or up front', async () => {
    const repo = makeTargetRepo();
    await start(at('basic'), repo, { solo: [SOLO_ASKS] });
    await recordAnswers(repo, 'r1', {}, ['Q1']);
    const { state, runner } = await carryOn(repo, { solo: [bypassReply('Q1'), SOLO_REVISED] });
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(runner.calls.map((c) => c.role)).toEqual(['solo', 'solo']);
    expect(runner.calls[0]?.prompt).toContain('# Questions to decide');
    expect(runner.calls[1]?.prompt).toContain(
      `Answer (your own best judgement: the person chose Bypass): ${AGENT_ANSWER}`,
    );
    expect(existsSync(path.join(logdir(repo), 'stage-solo/pass-2/bypass.json'))).toBe(true);

    // Up front: one run, three solo calls; the early extra file never reaches the branch.
    const repo2 = makeTargetRepo();
    const up = await start(at('basic', true), repo2, {
      solo: [SOLO_ASKS, bypassReply('Q1'), SOLO_REVISED],
    });
    expect(up.state.status, up.state.notes.join('; ')).toBe('complete');
    expect(up.runner.calls).toHaveLength(3);
    expect(git(repo2, 'ls-tree', '-r', '--name-only', 'advpipe/r1')).not.toContain('extra.js');
  });

  it('at the cap the run asks Begin work?, and Begin goes on', async () => {
    const repo = makeTargetRepo();
    const config = { ...at('basic'), limits: { ...at('basic').limits, max_rounds_spec: 2 } };
    await start(config, repo, { solo: [SOLO_ASKS] });
    await recordAnswers(repo, 'r1', { Q1: ANSWER });
    const asksAgain = writes(
      { 'task.md': TASK_MD_BLOCKING.replace(QUESTION, 'may lo equal hi?') },
      'asked another',
    );
    const { state } = await carryOn(repo, { solo: [asksAgain] }, config);
    const d = state.decisions.at(-1);
    expect([state.status, state.spec_passes, d?.kind, d?.stage]).toEqual([
      'needs_human',
      2,
      'spec_cap',
      'SOLO',
    ]);
    await decide(repo, 'r1', 'begin');
    const done = await carryOn(repo, { solo: [bypassReply('Q2'), SOLO_REVISED] }, config);
    expect(done.state.status, done.state.notes.join('; ')).toBe('complete');
    expect(done.state.bypass_questions).toBe(true);
    expect(done.runner.calls.map((c) => c.role)).toEqual(['solo', 'solo']);
    expect(done.state.questions.find((q) => q.id === 'Q2')).toMatchObject({ source: 'agent' });
  });
});

describe('Reviewer', () => {
  it('one review of the whole change, from artifacts only', async () => {
    const repo = makeTargetRepo();
    const config = at('reviewer');
    const { state, runner } = await start(config, repo, {
      solo: [SOLO_OK],
      'code-critic': [verdictPass()],
    });
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(runner.calls.map((c) => c.role)).toEqual(['solo', 'code-critic']);
    expect(Object.keys(state.commits)).toEqual(['solo', 'review']);
    const review = runner.calls[1];
    expect(review?.model).toBe(config.models.critic);
    expect(review?.prompt).toContain(`# task.md\n\n${TASK_MD}`);
    expect(review?.prompt).toContain('This is a single review pass');
    expect(review?.prompt).toContain('- tests/clamp.test.js');
    expect(review?.prompt).not.toContain('AUTHOR-REASONING');
    expect(readFileSync(path.join(logdir(repo), 'review/single.json'), 'utf-8')).toBe(
      verdictPass(),
    );
  });

  it('findings get one pass by the solo agent (not the coder), ruled by code', async () => {
    const repo = makeTargetRepo();
    const { state, runner } = await start(at('reviewer'), repo, {
      solo: [SOLO_OK, writes({}, 'added the NaN check')],
      'code-critic': [verdictFail(finding('F1', { claim: 'clamp never rejects NaN' }))],
    });
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(runner.calls.map((c) => c.role)).toEqual(['solo', 'code-critic', 'solo']);
    const fix = runner.calls[2]?.prompt ?? '';
    expect(fix).toContain('REV-F1');
    expect(fix).toContain('these findings are still open and must be fixed');
    expect(state.rulings.map((r) => [r.finding_id, r.decision])).toEqual([['REV-F1', 'fix']]);
    expect(state.rulings[0]?.reason).toContain('no arbiter at level reviewer');
    expect(readFileSync(path.join(logdir(repo), 'final-pass-solo/author.txt'), 'utf-8')).toBe(
      'added the NaN check',
    );
    expect(state.cost_by_stage['arbiter']).toBeUndefined();
  });

  it('red checks after the review fix ask, and a fix goes to the solo agent with no critic', async () => {
    const repo = makeTargetRepo();
    const { state } = await start(at('reviewer'), repo, {
      solo: [SOLO_OK, writes(IMPL_WRONG, 'broke it')],
      'code-critic': [verdictFail(finding('F1'))],
    });
    const d = state.decisions.at(-1);
    expect([state.status, d?.kind, d?.stage]).toEqual(['needs_human', 'red_checks', 'REVIEW']);
    expect('solo' in state.commits && !('review' in state.commits)).toBe(true);

    await decide(repo, 'r1', 'fix');
    const next = await carryOn(repo, { solo: [writes(IMPL_OK, 'fixed')] });
    expect(next.state.status, next.state.notes.join('; ')).toBe('complete');
    expect(next.runner.calls.map((c) => c.role)).toEqual(['solo']);
    expect(readFileSync(path.join(logdir(repo), 'fix-pass-1/author.txt'), 'utf-8')).toBe('fixed');
    expect(Object.keys(next.state.commits)).toEqual(['solo', 'review']);
  });

  it('resuming mid-review skips the solo stage; resuming mid-solo runs it again', async () => {
    const repo = makeTargetRepo();
    const orch = new Orchestrator(
      at('reviewer'),
      new FakeAgentRunner({ solo: [SOLO_OK], 'code-critic': [interrupt()] }),
      repo,
      'add clamp',
      { runId: 'r1', name: 'r1' },
    );
    await expect(orch.run()).rejects.toBeInstanceOf(Cancelled);
    expect(Object.keys(stateOf(repo).commits)).toEqual(['solo']);
    const { state, runner } = await carryOn(repo, { 'code-critic': [verdictPass()] });
    expect(state.status).toBe('complete');
    expect(runner.calls.map((c) => c.role)).toEqual(['code-critic']);

    const repo2 = makeTargetRepo();
    const first = new Orchestrator(
      at('basic'),
      new FakeAgentRunner({ solo: [interrupt()] }),
      repo2,
      'add clamp',
      { runId: 'r1', name: 'r1' },
    );
    await expect(first.run()).rejects.toBeInstanceOf(Cancelled);
    expect(stateOf(repo2).status).toBe('running');
    const again = await carryOn(repo2, { solo: [SOLO_OK] });
    expect([again.state.status, again.runner.calls.length]).toEqual(['complete', 1]);
  });
});

describe('security scan at Basic', () => {
  const scan =
    "const bad = process.getBuiltinModule('node:fs').existsSync('bad.txt');" +
    "console.log(bad ? 'rule: shell=True at bad.txt:1\\n2 findings' : 'clean');" +
    'process.exit(bad ? 1 : 0);';
  const scanConfig = (policy: 'ask' | 'block'): Config => {
    const c = testConfig({ gates: { security: [process.execPath, '-e', scan] } });
    return {
      ...c,
      pipeline: { ...c.pipeline, level: 'basic', security_scan: true, scan_failures: policy },
    };
  };
  const soloBad = writes({
    'task.md': TASK_MD,
    'tests/clamp.test.js': TEST_CLAMP,
    'bad.txt': 'x',
    ...IMPL_OK,
  });

  it('asks, and ignore judges the work as it is without calling the agent again', async () => {
    const repo = makeTargetRepo();
    const { state, runner } = await start(scanConfig('ask'), repo, { solo: [soloBad] });
    const d = state.decisions.at(-1);
    expect([state.status, d?.kind, d?.stage, runner.calls.length]).toEqual([
      'needs_human',
      'scan_hits',
      'SOLO',
      1,
    ]);
    await decide(repo, 'r1', 'ignore');
    const next = await carryOn(repo, {});
    expect(next.state.status, next.state.notes.join('; ')).toBe('complete');
    expect(next.runner.calls).toEqual([]);
    expect(next.state.minor_findings.some((f) => f.claim.includes('ignored by you'))).toBe(true);
    expect(Object.keys(next.state.commits)).toEqual(['solo']);
  });

  it('a blocking policy sends the hits to the solo agent through red_checks', async () => {
    const { state, runner } = await start(scanConfig('block'), makeTargetRepo(), {
      solo: [soloBad],
    });
    const d = state.decisions.at(-1);
    expect(d?.kind).toBe('red_checks');
    expect(d?.findings.map((f) => f.criterion)).toEqual(['gate:security']);
    expect(runner.calls).toHaveLength(1);
  });
});

describe('the solo levels at their worst', () => {
  it.each(['basic', 'reviewer'] as const)(
    '%s makes exactly maxAgentCalls.worst calls',
    async (level) => {
      const config = at(level);
      const scripts: Scripts =
        level === 'basic'
          ? { solo: [SOLO_WRONG] }
          : // The solo pass is green, the critic's output is garbage twice (one JSON retry), and the
            // review-fix pass leaves the checks red.
            { solo: [SOLO_OK, writes(IMPL_WRONG)], 'code-critic': ['not json', 'still not json'] };
      const { state, runner } = await start(config, makeTargetRepo(), scripts);
      expect(state.status).toBe('needs_human');
      expect(awaitingDecision(state)).toBe(true);
      expect(runner.calls).toHaveLength(maxAgentCalls(level, config.limits)[1]);
    },
  );
});
