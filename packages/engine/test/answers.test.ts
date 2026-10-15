import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { blockingOpenQuestions, type Config, type RunState } from '@advpipe/contracts';
import {
  AnswerError,
  answersReady,
  awaitingAnswers,
  checkResumable,
  decide,
  FakeAgentRunner,
  interrupt,
  limitHit,
  Orchestrator,
  recordAnswers,
  RunLog,
  withAnswersSection,
  writes,
  CUT_OFF_NOTE,
  Cancelled,
  type Scripts,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import {
  AGENT_ANSWER,
  AGENT_REASON,
  afterAnswers,
  ANSWER,
  blockedScripts,
  bypassReply,
  QUESTION,
  QUESTION_2,
  secondQuestion,
  TASK_MD,
  TASK_MD_BLOCKING,
  TASK_MD_REVISED,
} from './helpers/samples.js';

beforeEach(scrubEnv);

const withCap = (config: Config, cap: number): Config => ({
  ...config,
  limits: { ...config.limits, max_rounds_spec: cap },
});
const stateOf = (repo: string): RunState => RunLog.forRun(repo, 'r1').readState();
const logdir = (repo: string): string => RunLog.forRun(repo, 'r1').root;

async function blockedRun(config: Config, repo: string, first = TASK_MD_BLOCKING) {
  const orch = new Orchestrator(
    config,
    new FakeAgentRunner(blockedScripts(first)),
    repo,
    'add clamp',
    {
      runId: 'r1',
      name: 'r1',
    },
  );
  const state = await orch.run();
  expect(state.status).toBe('needs_human');
  return state;
}

async function resume(repo: string, scripts: Scripts, config?: Config) {
  const runner = new FakeAgentRunner(scripts);
  const orch = await Orchestrator.resume(runner, repo, 'r1', config ? { config } : {});
  return { state: await orch.run(), runner };
}

describe('blocking questions', () => {
  it('stop the run with the questions recorded, and can be answered and resumed', async () => {
    const repo = makeTargetRepo();
    const config = testConfig();
    const blocked = await blockedRun(config, repo);

    const [q] = blocked.questions;
    expect([q?.id, q?.text, q?.asked_in, q?.answer]).toEqual(['Q1', QUESTION, 1, '']);
    expect(blocked.spec_passes).toBe(1);
    expect(awaitingAnswers(blocked, 3) && !answersReady(blocked, 3)).toBe(true);
    const report = readFileSync(path.join(logdir(repo), 'report.md'), 'utf-8');
    expect(report).toContain("The spec has blocking questions. Answer them on the run's page.");
    expect(report).toContain('(not answered yet)');
    await expect(checkResumable(repo, 'r1')).rejects.toThrow(
      /waiting on answers to Q1: answer them on the run's page/,
    );

    const saved = await recordAnswers(repo, 'r1', { q1: `  ${ANSWER}\n` });
    expect(saved.questions[0]?.answer).toBe(ANSWER);
    expect(saved.status).toBe('needs_human');
    expect((await checkResumable(repo, 'r1')).run_id).toBe('r1');

    const { state, runner } = await resume(repo, afterAnswers());
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.spec_passes).toBe(2);
    // The revision sees the previous task.md (from the run directory: reopening wiped the
    // worktree's copy) and the answer.
    const [call] = runner.callsFor('spec-writer');
    expect(call?.prompt).toContain('# Your previous task.md');
    expect(call?.prompt).toContain(`BLOCKING: ${QUESTION}`);
    expect(call?.prompt).toContain(`Q1: ${QUESTION}\nAnswer: ${ANSWER}`);
    const committed = git(repo, 'show', 'advpipe/r1:task.md');
    expect(committed).toContain('AC4: the RangeError message names lo and hi.');
    expect(committed).toContain(`**Answer:** ${ANSWER}`);
    expect(blockingOpenQuestions(committed)).toEqual([]);
    expect(existsSync(path.join(logdir(repo), 'spec/pass-2/answers.json'))).toBe(true);
  });

  it('refuse every answer set that does not fit, and save nothing', async () => {
    const repo = makeTargetRepo();
    const two = TASK_MD_BLOCKING.replace(
      '## Open questions\n',
      `## Open questions\n- BLOCKING: ${QUESTION_2}\n`,
    );
    await blockedRun(testConfig(), repo, two);
    const bad: [Record<string, string>, string[], RegExp][] = [
      [{ Q1: ANSWER }, [], /Q2 still needs an answer \(or Bypass it/],
      [{ Q1: ANSWER }, ['Q1', 'Q2'], /Q1 can't be both answered and bypassed/],
      [{ Q1: ANSWER }, ['Q9'], /Q9 isn't one of this run's questions/],
      [{ Q1: ' ' }, ['Q2'], /answer to Q1 is empty/],
      [{ Q1: 'x'.repeat(8_001) }, ['Q2'], /keep each answer under 8,000/],
    ];
    for (const [answers, bypass, message] of bad) {
      await expect(recordAnswers(repo, 'r1', answers, bypass)).rejects.toThrow(message);
    }
    expect(stateOf(repo).questions.some((q) => q.answer || q.bypassed)).toBe(false);
  });

  it('are refused for a run that is driven, not waiting, or whose branch is gone', async () => {
    const repo = makeTargetRepo();
    await blockedRun(testConfig(), repo);
    const log = RunLog.forRun(repo, 'r1');
    log.acquireLock(process.ppid);
    await expect(recordAnswers(repo, 'r1', {}, ['Q1'])).rejects.toThrow(/still being driven/);
    log.releaseLock();
    log.writeConfig(withCap(testConfig(), 1));
    await expect(recordAnswers(repo, 'r1', {}, ['Q1'])).rejects.toThrow(/start a new run/);
    log.writeConfig(testConfig());
    git(repo, 'worktree', 'remove', '--force', stateOf(repo).worktree);
    git(repo, 'branch', '-D', 'advpipe/r1');
    await expect(recordAnswers(repo, 'r1', { Q1: ANSWER })).rejects.toThrow(AnswerError);
    await expect(recordAnswers(repo, 'r1', { Q1: ANSWER })).rejects.toThrow(/no longer exists/);
  });

  it('a revision that asks a new question continues the numbering; a re-asked one stands', async () => {
    const repo = makeTargetRepo();
    const config = testConfig();
    await blockedRun(config, repo);
    await recordAnswers(repo, 'r1', { Q1: ANSWER });
    const again = TASK_MD_BLOCKING; // asks Q1's question again, in other words
    const { state } = await resume(repo, afterAnswers(writes({ 'task.md': again })));
    // Asked again with the same text: its answer stands, so the run goes on.
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.notes).toContain('Spec writer asked Q1 again; its answer stands.');

    const repo2 = makeTargetRepo();
    await blockedRun(config, repo2);
    await recordAnswers(repo2, 'r1', { Q1: ANSWER });
    const { state: second } = await resume(
      repo2,
      afterAnswers(writes({ 'task.md': secondQuestion() })),
    );
    expect(second.status).toBe('needs_human');
    expect(second.questions.map((q) => q.id)).toEqual(['Q1', 'Q2']);
    expect(second.questions[1]?.asked_in).toBe(2);
    expect(awaitingAnswers(second, 3)).toBe(true);
  });

  it('an interrupted revision is redone on resume', async () => {
    const repo = makeTargetRepo();
    await blockedRun(testConfig(), repo);
    await recordAnswers(repo, 'r1', { Q1: ANSWER });
    const orch = await Orchestrator.resume(
      new FakeAgentRunner({ 'spec-writer': [interrupt()] }),
      repo,
      'r1',
    );
    await expect(orch.run()).rejects.toBeInstanceOf(Cancelled);
    expect(stateOf(repo).questions[0]?.applied).toBe(false);
    const { state } = await resume(repo, afterAnswers());
    expect(state.status, state.notes.join('; ')).toBe('complete');
  });
});

describe('Bypass', () => {
  it('lets the agent answer, marks it everywhere, and never shows its reply to later agents', async () => {
    const repo = makeTargetRepo();
    await blockedRun(testConfig(), repo);
    const saved = await recordAnswers(repo, 'r1', {}, ['q1']);
    expect(saved.questions[0]).toMatchObject({ bypassed: true, answer: '', source: 'person' });
    expect(answersReady(saved, 3)).toBe(true);

    const { state, runner } = await resume(repo, {
      ...afterAnswers(),
      // Anything else in the reply (here an extra key) is for the run directory only.
      'spec-writer': [
        JSON.stringify({ ...JSON.parse(bypassReply('Q1')), scratch: 'BYPASS-REPLY-TEXT' }),
        writes({ 'task.md': TASK_MD_REVISED }, 'revised'),
      ],
    });
    expect(state.status, state.notes.join('; ')).toBe('complete');
    const [bypassCall, revision] = runner.callsFor('spec-writer');
    expect(bypassCall?.prompt).toContain('chosen to let you decide them yourself');
    expect(revision?.prompt).toContain(
      `Answer (your own best judgement: the person chose Bypass): ${AGENT_ANSWER}`,
    );
    expect(revision?.prompt).not.toContain(AGENT_REASON);
    const q = state.questions[0];
    expect([q?.source, q?.answer, q?.reasoning]).toEqual(['agent', AGENT_ANSWER, AGENT_REASON]);
    const committed = git(repo, 'show', 'advpipe/r1:task.md');
    expect(committed).toContain(`**Answer (agent's best judgement):** ${AGENT_ANSWER}`);
    expect(committed).toContain(`Reason: ${AGENT_REASON}`);
    for (const role of ['test-author', 'coder', 'test-critic', 'code-critic'] as const) {
      for (const call of runner.callsFor(role)) {
        expect(call.prompt).not.toContain('BYPASS-REPLY-TEXT');
      }
    }
    const reply = JSON.parse(
      readFileSync(path.join(logdir(repo), 'spec/pass-2/bypass.json'), 'utf-8'),
    );
    expect(reply.asked).toEqual(['Q1']);
    const report = readFileSync(path.join(logdir(repo), 'report.md'), 'utf-8');
    expect(report).toContain("(agent's best judgement, you chose Bypass)");
  });

  it('reverts files the bypass call changed, retries bad JSON once, and uses stand-ins', async () => {
    const repo = makeTargetRepo();
    await blockedRun(testConfig(), repo);
    await recordAnswers(repo, 'r1', {}, ['Q1']);
    const { state, runner } = await resume(repo, {
      ...afterAnswers(),
      'spec-writer': [
        writes({ 'stray.js': 'x' }, 'not json'),
        'still not json',
        writes({ 'task.md': TASK_MD_REVISED }),
      ],
    });
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(runner.callsFor('spec-writer')).toHaveLength(3);
    expect(runner.callsFor('spec-writer')[1]?.prompt).toContain('could not be parsed');
    expect(state.questions[0]?.answer).toContain('No answer given');
    expect(state.notes.some((n) => n.includes('stand-in answer'))).toBe(true);
    expect(state.notes.some((n) => n.includes('edited files while answering'))).toBe(true);
    expect(git(repo, 'ls-tree', '-r', '--name-only', 'advpipe/r1')).not.toContain('stray.js');
  });

  it('covers only the stop it was chosen at', async () => {
    const repo = makeTargetRepo();
    await blockedRun(testConfig(), repo);
    await recordAnswers(repo, 'r1', {}, ['Q1']);
    const { state } = await resume(repo, {
      ...afterAnswers(),
      'spec-writer': [bypassReply('Q1'), writes({ 'task.md': secondQuestion() })],
    });
    expect(state.status).toBe('needs_human');
    expect(awaitingAnswers(state, 3)).toBe(true);
    expect(state.questions[1]).toMatchObject({ id: 'Q2', bypassed: false, answer: '' });
  });

  it('up front it never stops: the agent answers, another pass runs, and at the cap it goes on', async () => {
    const repo = makeTargetRepo();
    const config = testConfig();
    const upFront = { ...config, pipeline: { ...config.pipeline, bypass_questions: true } };
    const runner = new FakeAgentRunner({
      ...happyScripts2(),
      'spec-writer': [
        writes({ 'task.md': TASK_MD_BLOCKING }),
        bypassReply('Q1'),
        writes({ 'task.md': TASK_MD_REVISED }),
      ],
    });
    const state = await new Orchestrator(upFront, runner, repo, 'add clamp', {
      runId: 'r1',
      name: 'r1',
    }).run();
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.questions[0]).toMatchObject({ bypassed: true, source: 'agent' });

    // A cap of one: the questions are decided without another revision pass.
    const repo2 = makeTargetRepo();
    const capped = withCap(upFront, 1);
    const runner2 = new FakeAgentRunner({
      ...happyScripts2(),
      'spec-writer': [writes({ 'task.md': TASK_MD_BLOCKING }), bypassReply('Q1')],
    });
    const done = await new Orchestrator(capped, runner2, repo2, 'add clamp', {
      runId: 'r1',
      name: 'r1',
    }).run();
    expect(done.status, done.notes.join('; ')).toBe('complete');
    expect(done.spec_passes).toBe(1);
    expect(done.notes.some((n) => n.includes('(Bypass)'))).toBe(true);
    expect(existsSync(path.join(logdir(repo2), 'spec/pass-1/bypass.json'))).toBe(true);
    expect(git(repo2, 'show', 'advpipe/r1:task.md')).toContain("agent's best judgement");
  });

  it('a bypass call never carries the cut-off note, the revision does', async () => {
    const repo = makeTargetRepo();
    await blockedRun(testConfig(), repo);
    await recordAnswers(repo, 'r1', {}, ['Q1']);
    const cut = await resume(repo, { 'spec-writer': [limitHit()] });
    expect(cut.state.decisions.at(-1)?.kind).toBe('usage_limit');
    await decide(repo, 'r1', 'retry');
    const { state, runner } = await resume(repo, {
      ...afterAnswers(),
      'spec-writer': [bypassReply('Q1'), writes({ 'task.md': TASK_MD_REVISED })],
    });
    expect(state.status, state.notes.join('; ')).toBe('complete');
    const [bypassCall, revision] = runner.callsFor('spec-writer');
    expect(bypassCall?.prompt).not.toContain(CUT_OFF_NOTE);
    expect(revision?.prompt).toContain(CUT_OFF_NOTE);
  });
});

describe('the spec-pass cap: Begin work?', () => {
  async function atTheCap(repo: string) {
    const config = withCap(testConfig(), 2);
    await blockedRun(config, repo);
    await recordAnswers(repo, 'r1', { Q1: ANSWER });
    const { state } = await resume(
      repo,
      afterAnswers(writes({ 'task.md': secondQuestion() })),
      config,
    );
    expect(state.status).toBe('needs_human');
    return { config, state };
  }

  it('asks, refuses answers, and Begin work has the agent decide without another pass', async () => {
    const repo = makeTargetRepo();
    const { config, state } = await atTheCap(repo);
    const d = state.decisions.at(-1);
    expect([d?.kind, d?.stage]).toEqual(['spec_cap', 'SPEC']);
    expect(d?.explanation).toContain(
      'still has 1 blocking question after 2 passes. Begin work anyway?',
    );
    expect(d?.findings.map((f) => [f.id, f.claim])).toEqual([['Q2', QUESTION_2]]);
    expect(awaitingAnswers(state, 2)).toBe(false);
    await expect(recordAnswers(repo, 'r1', { Q2: 'no' })).rejects.toThrow(
      /choose \*Begin work\* or \*Stop here\*/,
    );

    await decide(repo, 'r1', 'begin');
    const { state: done, runner } = await resume(
      repo,
      { ...afterAnswers(), 'spec-writer': [bypassReply('Q2')] },
      config,
    );
    expect(done.status, done.notes.join('; ')).toBe('complete');
    expect(done.bypass_questions).toBe(true);
    expect(runner.callsFor('spec-writer')).toHaveLength(1);
    expect(done.spec_passes).toBe(2);
    expect(git(repo, 'show', 'advpipe/r1:task.md')).toContain(
      `**Answer (agent's best judgement):** ${AGENT_ANSWER}`,
    );
    expect(existsSync(path.join(logdir(repo), 'spec/pass-2/bypass-begin.json'))).toBe(true);
    expect(done.notes.some((n) => n.includes('you chose to begin work'))).toBe(true);
  });

  it('Stop here ends the run for good', async () => {
    const repo = makeTargetRepo();
    await atTheCap(repo);
    const ended = await decide(repo, 'r1', 'stop');
    expect(ended.ended_by).toBe('stop');
    expect('spec' in ended.commits).toBe(false);
    await expect(checkResumable(repo, 'r1')).rejects.toThrow(/stopped at your choice/);
    expect(existsSync(path.join(logdir(repo), 'task.md'))).toBe(true);
  });
});

describe('withAnswersSection', () => {
  const q = (id: string, answer: string, source: 'person' | 'agent' = 'person') => ({
    id,
    text: `question ${id}?`,
    asked_in: 1,
    answer,
    answered_at: null,
    applied: false,
    source,
    reasoning: source === 'agent' ? 'because' : '',
    bypassed: source === 'agent',
  });

  it('is verbatim, idempotent, and invisible to the question parser', () => {
    const questions = [q('Q1', 'line one\n- BLOCKING: not a question\n## Heading')];
    const once = withAnswersSection(TASK_MD, questions);
    expect(withAnswersSection(once, questions)).toBe(once);
    expect(once).toContain('Answers from the person who started this run.');
    expect(once).toContain('  - BLOCKING: not a question');
    expect(blockingOpenQuestions(once)).toEqual([]);
    expect(withAnswersSection(once, [])).toBe(TASK_MD);
  });

  it('marks the agent answers, and keeps person-only wording unchanged', () => {
    const mixed = withAnswersSection(TASK_MD, [q('Q1', 'mine'), q('Q2', 'theirs', 'agent')]);
    expect(mixed).toContain('Answers marked "agent\'s best judgement"');
    expect(mixed).toContain("**Answer (agent's best judgement):** theirs");
    expect(mixed).toContain('  Reason: because');
    expect(mixed).toContain('**Answer:** mine');
  });
});

function happyScripts2(): Scripts {
  return afterAnswers();
}
