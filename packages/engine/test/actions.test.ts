import { beforeAll, describe, expect, it } from 'vitest';
import { STALE_MESSAGE } from '@advpipe/contracts';
import {
  ActionError,
  answerAction,
  cancelAction,
  cleanAction,
  cleanInfoAction,
  decideAction,
  FakeAgentRunner,
  Orchestrator,
  resumeAction,
  revealPath,
  RunLog,
  verdictPass,
  writes,
  type Scripts,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import { blockedScripts, happyScripts, IMPL_WRONG } from './helpers/samples.js';

// What a person does to a run from its page, checked in the host (docs/05 §5.2.2, §7). No worker is
// started here: every case is a refusal or an action that is done at once.

beforeAll(scrubEnv);

const run = (repo: string, scripts: Scripts, config = testConfig(), id = 'r1') =>
  new Orchestrator(config, new FakeAgentRunner(scripts), repo, 'add clamp', {
    runId: id,
    name: id,
  }).run();

const redCode = (): Scripts => ({
  ...happyScripts(),
  coder: [writes(IMPL_WRONG), 'tried', 'tried', 'tried'],
  'code-critic': [verdictPass(), verdictPass(), verdictPass()],
});

const refused = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(ActionError);
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('the host re-checks every action against the run’s status', () => {
  it('refuses all of them on a complete run, and on one that is not there', async () => {
    const repo = makeTargetRepo();
    expect((await run(repo, happyScripts())).status).toBe('complete');
    const stale = STALE_MESSAGE('complete');
    expect(await refused(() => cancelAction(repo, 'r1'))).toBe(stale);
    expect(await refused(resumeAction(repo, 'r1', ''))).toBe(stale);
    expect(await refused(answerAction(repo, 'r1', { answers: {}, bypass: [] }))).toBe(stale);
    expect(await refused(decideAction(repo, 'r1', { choice: 'fix' }))).toBe(stale);
    expect(await refused(cleanAction(repo, 'r1', { force: true, logs: true }))).toBe(stale);
    expect(await refused(cleanInfoAction(repo, 'r1'))).toContain('its branch is the result');
    expect(await refused(cleanInfoAction(repo, 'nope'))).toBe("There's no run nope.");
    expect(await refused(cleanInfoAction(repo, '../x'))).toBe("There's no run ../x.");
  });
});

describe('decisions', () => {
  it('ending choices need confirm; the engine’s own refusals are shown as they are', async () => {
    const repo = makeTargetRepo();
    const state = await run(repo, redCode());
    expect(state.decisions.at(-1)?.kind).toBe('red_checks');

    expect(await refused(decideAction(repo, 'r1', { choice: 'takeover' }))).toBe(
      'Not done: that needs confirming first.',
    );
    expect(await refused(decideAction(repo, 'r1', { choice: 'ignore' }))).toContain(
      "isn't a choice here",
    );
    expect(
      await refused(decideAction(repo, 'r1', { choice: 'fix', note: 'x'.repeat(8_001) })),
    ).toContain('keep it under 8,000');
    expect(RunLog.forRun(repo, 'r1').readState().decisions.at(-1)?.choice).toBe('');

    // Taking over commits the work, removes the working copy and ends the run, at once.
    expect(await decideAction(repo, 'r1', { choice: 'takeover', confirm: true })).toEqual({
      runId: 'r1',
      resumed: false,
    });
    const after = RunLog.forRun(repo, 'r1').readState();
    expect([after.ended_by, after.worktree_removed]).toEqual(['takeover', true]);
    expect(git(repo, 'log', '-1', '--format=%s', 'advpipe/r1').trim()).toMatch(/handed over/);
    // The page it was decided from is stale now.
    expect(await refused(decideAction(repo, 'r1', { choice: 'fix' }))).toBe(
      STALE_MESSAGE('handed_over'),
    );

    // …and a handed-over run can be cleaned: its branch is its own, so that needs "delete anyway".
    const info = await cleanInfoAction(repo, 'r1');
    expect(info).toMatchObject({ status: 'handed_over', branch: 'advpipe/r1', refusal: null });
    expect(info.unmerged_commits).toBeGreaterThan(0);
    expect(await refused(cleanAction(repo, 'r1', { force: false, logs: false }))).toContain(
      'Tick *Delete anyway*',
    );
    expect((await cleanAction(repo, 'r1', { force: true, logs: false })).join()).toContain(
      'deleted branch advpipe/r1',
    );
  });
});

describe('resume and answers', () => {
  it('an over-budget run needs a bigger total than it has spent', async () => {
    const repo = makeTargetRepo();
    const state = await run(
      repo,
      happyScripts(),
      testConfig({ limits: { budget_usd_per_task: 0.015 } }),
    );
    expect(state.status).toBe('budget_exceeded');
    expect(await refused(resumeAction(repo, 'r1', ''))).toBe(
      'Not resumed: This run ran out of budget: give it a bigger one to continue.',
    );
    expect(await refused(resumeAction(repo, 'r1', 'lots'))).toBe(
      "Not resumed: 'lots' isn't an amount in dollars.",
    );
    expect(await refused(resumeAction(repo, 'r1', '0.01'))).toContain('has spent $0.02 already');
  });

  it('answers are all-or-nothing: a refusal says what is missing and saves nothing', async () => {
    const repo = makeTargetRepo();
    const state = await run(repo, blockedScripts());
    expect(state.questions.map((q) => q.id)).toEqual(['Q1']);
    expect(await refused(answerAction(repo, 'r1', { answers: {}, bypass: [] }))).toBe(
      'Not saved: answer every question: Q1 still needs an answer (or Bypass it, to let the agent decide).',
    );
    expect(await refused(answerAction(repo, 'r1', { answers: { Q9: 'x' }, bypass: [] }))).toContain(
      "Q9 isn't one of this run's questions",
    );
    expect(RunLog.forRun(repo, 'r1').readState().questions[0]?.answer).toBe('');
  });
});

describe('opening things in the file manager', () => {
  it('shows only what is inside .advpipe/, whatever run.json says', async () => {
    const repo = makeTargetRepo();
    await run(repo, blockedScripts());
    const log = RunLog.forRun(repo, 'r1');
    expect(revealPath(repo, 'r1', 'runDir')).toBe(log.root);
    expect(revealPath(repo, 'r1', 'report')).toBe(log.path('report.md'));
    expect(revealPath(repo, 'r1', 'worktree')).toBe(log.readState().worktree);

    const tampered = log.readState();
    tampered.worktree = '/etc';
    log.writeState(tampered);
    expect(await refused(() => revealPath(repo, 'r1', 'worktree'))).toContain('not opening it');
  });
});
