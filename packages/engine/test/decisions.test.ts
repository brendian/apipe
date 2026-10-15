import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADD_USAGE_URL,
  ADD_CREDITS_URL,
  type Config,
  type Level,
  type RunState,
} from '@advpipe/contracts';
import {
  awaitingDecision,
  checkResumable,
  CUT_OFF_NOTE,
  decide,
  DecisionError,
  decisionReady,
  FakeAgentRunner,
  interrupt,
  limitHit,
  NotResumable,
  Orchestrator,
  RunLog,
  verdictPass,
  writes,
  Cancelled,
  type AgentRequest,
  type Scripts,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import {
  CLAMP_WRONG,
  CORE_HEADER,
  happyScripts,
  IMPL_OK,
  IMPL_WRONG,
  TEST_CLAMP,
  TRIVIAL_TEST,
} from './helpers/samples.js';

beforeEach(scrubEnv);

const NOTE = "Please keep the public signature; don't touch mathutils/index.js!";
const logdir = (repo: string): string => RunLog.forRun(repo, 'r1').root;
const stateOf = (repo: string): RunState => RunLog.forRun(repo, 'r1').readState();
const coreOf = (repo: string): string =>
  readFileSync(path.join(stateOf(repo).worktree, 'mathutils/core.js'), 'utf-8');

async function start(config: Config, repo: string, scripts: Scripts, runId = 'r1') {
  const runner = new FakeAgentRunner(scripts);
  const state = await new Orchestrator(config, runner, repo, 'add clamp', {
    runId,
    name: runId,
  }).run();
  return { state, runner };
}

async function carryOn(repo: string, scripts: Scripts, config?: Config) {
  const runner = new FakeAgentRunner(scripts);
  const orch = await Orchestrator.resume(runner, repo, 'r1', config ? { config } : {});
  return { state: await orch.run(), runner };
}

/** The coder never gets it right and the critic never notices: the checks stay red throughout. */
const redCode = (cap = 3): Scripts => ({
  ...happyScripts(),
  coder: [writes(IMPL_WRONG), ...Array<string>(cap).fill('tried')],
  'code-critic': Array<string>(cap).fill(verdictPass()),
});

const fixedCode = (): Scripts => ({
  coder: [writes(IMPL_OK, 'fixed')],
  'standards-reviewer': [verdictPass()],
  'security-reviewer': [verdictPass()],
});

describe('red_checks', () => {
  it('asks only after the rounds and the final pass, leaving the worktree as it was', async () => {
    const repo = makeTargetRepo();
    const { state, runner } = await start(testConfig(), repo, redCode());
    const d = state.decisions.at(-1);
    expect([state.status, d?.kind, d?.stage]).toEqual(['needs_human', 'red_checks', 'CODE']);
    expect(awaitingDecision(state) && !decisionReady(state)).toBe(true);
    // The whole of CODE ran first: three rounds, then the final pass by the coder.
    expect(runner.callsFor('coder')).toHaveLength(4);
    expect([state.rounds_used['code'], state.stage]).toEqual([3, 'ARBITER']);
    expect(d?.findings.map((f) => f.criterion)).toEqual(['gate:test']);
    expect(d?.explanation).toContain('still failing at CODE (test)');
    expect(d?.explanation).toContain('fix pass 1 of 3');
    expect(coreOf(repo)).toBe(CORE_HEADER + CLAMP_WRONG);
    expect(git(state.worktree, 'status', '--porcelain').trim()).not.toBe('');
    expect('code' in state.commits).toBe(false);
    const events = readFileSync(path.join(logdir(repo), 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const asked = events.filter((e) => e.kind === 'decision');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ choice: 'asked', choices: ['fix', 'takeover'] });
    expect(asked[0].message).toBe(d?.explanation); // no command text (02 §19)
    expect(readFileSync(path.join(logdir(repo), 'report.md'), 'utf-8')).toContain(
      "(waiting for you: choose on the run's page)",
    );
    await expect(checkResumable(repo, 'r1')).rejects.toThrow(
      /waiting for a decision: choose on the run's page/,
    );
  });

  it('fix with a note runs one pass by the coder, no critic, and the run carries on', async () => {
    const repo = makeTargetRepo();
    await start(testConfig(), repo, redCode());
    const saved = await decide(repo, 'r1', 'fix', NOTE);
    expect(decisionReady(saved)).toBe(true);
    expect(saved.decisions.at(-1)?.note).toBe(NOTE);
    expect(coreOf(repo)).toBe(CORE_HEADER + CLAMP_WRONG); // deciding changes nothing

    const { state, runner } = await carryOn(repo, fixedCode());
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(runner.calls.map((c) => c.role)).toEqual([
      'coder',
      'standards-reviewer',
      'security-reviewer',
    ]);
    const prompt = runner.calls[0]?.prompt ?? '';
    expect(prompt).toContain('Fix pass 1: a person asked for another pass');
    expect(prompt).toContain(
      `A person asked for this pass and left you this note:\n\n\`\`\`\n${NOTE}\n\`\`\``,
    );
    expect(prompt).toContain('G-test');
    expect([state.fix_passes, state.decisions.at(-1)?.applied]).toEqual([1, true]);
    expect(Object.keys(state.commits)).toEqual(['spec', 'tests', 'code', 'review']);
    expect(readFileSync(path.join(logdir(repo), 'fix-pass-1/author.txt'), 'utf-8')).toBe('fixed');
    expect(state.calls_by_stage['stage-code']).toBe(7);
  });

  it('a fix pass still red asks again until the cap, and takeover is still possible', async () => {
    const repo = makeTargetRepo();
    const config = testConfig();
    const capped = { ...config, limits: { ...config.limits, max_fix_passes: 2 } };
    await start(capped, repo, redCode());
    for (const n of [1, 2]) {
      await decide(repo, 'r1', 'fix');
      const { state } = await carryOn(repo, { coder: ['still wrong'] });
      expect([state.status, state.fix_passes, state.decisions.length]).toEqual([
        'needs_human',
        n,
        n + 1,
      ]);
      expect(awaitingDecision(state)).toBe(true);
    }
    await expect(decide(repo, 'r1', 'fix')).rejects.toThrow(/all 2 fix passes.*take over/);
    expect((await decide(repo, 'r1', 'takeover')).ended_by).toBe('takeover');
  });

  it('a fix at the tests stage goes to the test author', async () => {
    const repo = makeTargetRepo();
    // Tests that pass before any implementation exist never show a red gate.
    const { state } = await start(testConfig(), repo, {
      ...happyScripts(),
      'test-author': [writes({ 'tests/clamp.test.js': TRIVIAL_TEST }), 'again', 'again'],
      'test-critic': [verdictPass(), verdictPass()],
    });
    const d = state.decisions.at(-1);
    expect([d?.kind, d?.stage]).toEqual(['red_checks', 'TESTS']);
    expect(d?.findings.map((f) => f.id)).toEqual(['G-tests-green']);

    await decide(repo, 'r1', 'fix', 'test the lo > hi case');
    const next = await carryOn(repo, {
      'test-author': [writes({ 'tests/clamp.test.js': TEST_CLAMP })],
      coder: [writes(IMPL_OK)],
      'code-critic': [verdictPass()],
      'standards-reviewer': [verdictPass()],
      'security-reviewer': [verdictPass()],
    });
    expect(next.state.status, next.state.notes.join('; ')).toBe('complete');
    expect(next.runner.calls[0]?.role).toBe('test-author');
    expect(next.runner.calls[0]?.prompt).toContain('test the lo > hi case');
    expect(next.runner.callsFor('test-critic')).toHaveLength(0); // no critic after a requested pass
  });

  it('red final checks ask too, then a fix pass by the coder', async () => {
    const repo = makeTargetRepo();
    const flag = path.join(repo, '.advpipe-flaky');
    // The 2nd run of the types check fails: that is the final checks.
    const flaky =
      "const fs = process.getBuiltinModule('node:fs'); const f = process.argv[1];" +
      "const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf-8')) + 1 : 1;" +
      'fs.writeFileSync(f, String(n)); process.exit(n === 2 ? 1 : 0);';
    const base = testConfig({ gates: { types: [process.execPath, '-e', flaky, flag] } });
    const config = { ...base, pipeline: { ...base.pipeline, level: 'adversarial' as Level } };
    const { state } = await start(config, repo, happyScripts());
    const d = state.decisions.at(-1);
    expect([d?.kind, d?.stage]).toEqual(['red_checks', 'FINAL_GATES']);
    expect(d?.findings.map((f) => f.criterion)).toEqual(['gate:types']);
    expect(Object.keys(state.commits)).toEqual(['spec', 'tests', 'code']);

    await decide(repo, 'r1', 'fix', 'types are flaky, look again');
    const next = await carryOn(repo, { coder: ['looked again'] }, config);
    expect(next.state.status, next.state.notes.join('; ')).toBe('complete');
    expect(next.runner.calls.map((c) => c.role)).toEqual(['coder']);
    expect([next.state.stage, next.state.fix_passes]).toEqual(['DONE', 1]);
  });

  it('an interrupted fix pass runs again on a plain resume, with the worktree kept', async () => {
    const repo = makeTargetRepo();
    await start(testConfig(), repo, redCode());
    await decide(repo, 'r1', 'fix', NOTE);
    const orch = await Orchestrator.resume(
      new FakeAgentRunner({ coder: [interrupt()] }),
      repo,
      'r1',
    );
    await expect(orch.run()).rejects.toBeInstanceOf(Cancelled);
    const after = stateOf(repo);
    expect([after.status, after.fix_passes, after.decisions.at(-1)?.applied]).toEqual([
      'running',
      0,
      false,
    ]);
    expect(coreOf(repo)).toBe(CORE_HEADER + CLAMP_WRONG);
    const { state, runner } = await carryOn(repo, fixedCode());
    expect([state.status, state.fix_passes]).toEqual(['complete', 1]);
    expect(runner.calls[0]?.prompt).toContain(NOTE);
  });
});

describe('takeover and the refusals', () => {
  it('takeover commits, removes the worktree, ends the run, and clean keeps its rules', async () => {
    const repo = makeTargetRepo();
    const { state } = await start(testConfig(), repo, redCode());
    const ended = await decide(repo, 'r1', 'takeover');
    expect([ended.ended_by, ended.status, ended.worktree_removed]).toEqual([
      'takeover',
      'needs_human',
      true,
    ]);
    expect(existsSync(state.worktree)).toBe(false);
    const subjects = git(repo, 'log', '--format=%s', 'main..advpipe/r1').trim().split('\n');
    expect(subjects[0]).toBe('advpipe: work in progress, handed over (checks failing)');
    expect(subjects).toContain('advpipe: tests');
    expect(git(repo, 'show', 'advpipe/r1:mathutils/core.js')).toBe(CORE_HEADER + CLAMP_WRONG);
    expect(ended.notes.some((n) => n.includes('Handed over to you at CODE'))).toBe(true);
    await expect(decide(repo, 'r1', 'fix')).rejects.toThrow(/handed over to you/);
    await expect(checkResumable(repo, 'r1')).rejects.toThrow(
      /handed over to you; nothing to resume/,
    );
  });

  it('takeover with nothing uncommitted makes no empty handover commit', async () => {
    const repo = makeTargetRepo();
    const { state } = await start(testConfig(), repo, redCode());
    git(state.worktree, 'add', '-A');
    git(state.worktree, 'commit', '-q', '-m', 'by hand');
    await decide(repo, 'r1', 'takeover');
    const subjects = git(repo, 'log', '--format=%s', 'main..advpipe/r1').trim().split('\n');
    expect(subjects[0]).toBe('by hand');
    expect(stateOf(repo).notes.some((n) => n.includes('nothing was uncommitted'))).toBe(true);
  });

  it('decide refuses what does not fit, and records nothing', async () => {
    const repo = makeTargetRepo();
    await expect(decide(repo, 'nope', 'fix')).rejects.toThrow(/no run nope/);
    expect((await start(testConfig(), repo, happyScripts(), 'done')).state.status).toBe('complete');
    await expect(decide(repo, 'done', 'fix')).rejects.toThrow(/isn't waiting for a decision/);

    await start(testConfig(), repo, redCode());
    await expect(decide(repo, 'r1', 'ignore')).rejects.toThrow(
      /'ignore' isn't a choice here: choose fix or takeover/,
    );
    await expect(decide(repo, 'r1', 'takeover', 'hand it over')).rejects.toThrow(
      /note goes with the fix choice only/,
    );
    await expect(decide(repo, 'r1', 'fix', 'x'.repeat(8_001))).rejects.toThrow(
      /characters; keep it under 8,000/,
    );
    const log = RunLog.forRun(repo, 'r1');
    log.acquireLock(process.ppid);
    await expect(decide(repo, 'r1', 'fix')).rejects.toThrow(/still being driven/);
    log.releaseLock();
    git(repo, 'worktree', 'remove', '--force', stateOf(repo).worktree);
    git(repo, 'branch', '-D', 'advpipe/r1');
    await expect(decide(repo, 'r1', 'fix')).rejects.toThrow(DecisionError);
    await expect(decide(repo, 'r1', 'fix')).rejects.toThrow(/branch advpipe\/r1 no longer exists/);
    expect(stateOf(repo).decisions.at(-1)?.choice).toBe('');
  });

  it('a decision is recorded once', async () => {
    const repo = makeTargetRepo();
    await start(testConfig(), repo, redCode());
    await decide(repo, 'r1', 'fix');
    await expect(decide(repo, 'r1', 'takeover')).rejects.toThrow(/isn't waiting for a decision/);
  });
});

describe('scan_hits', () => {
  // A scan that fails while bad.txt exists in the worktree.
  const scan =
    "const bad = process.getBuiltinModule('node:fs').existsSync('bad.txt');" +
    "console.log(bad ? 'rule: shell=True at bad.txt:1\\n2 findings' : 'clean');" +
    'process.exit(bad ? 1 : 0);';
  const scanConfig = (policy: 'ask' | 'ignore' | 'block' = 'ask', level: Level = 'adversarial') => {
    const c = testConfig({ gates: { security: [process.execPath, '-e', scan] } });
    return {
      ...c,
      pipeline: { ...c.pipeline, level, security_scan: true, scan_failures: policy },
    };
  };
  const unlinkBad = (req: AgentRequest): string => {
    unlinkSync(path.join(req.cwd, 'bad.txt'));
    return 'removed bad.txt';
  };
  const badScripts = (fixRound = false): Scripts => ({
    ...happyScripts(),
    coder: fixRound
      ? [writes({ ...IMPL_OK, 'bad.txt': 'x' }), unlinkBad]
      : [writes({ ...IMPL_OK, 'bad.txt': 'x' })],
    ...(fixRound && { 'code-critic': [verdictPass(), verdictPass()] }),
  });

  it('asks the first time below Full, leaving the hit in place', async () => {
    const repo = makeTargetRepo();
    const { state, runner } = await start(scanConfig(), repo, badScripts());
    const d = state.decisions.at(-1);
    expect([state.status, state.scan_policy, d?.kind, d?.stage]).toEqual([
      'needs_human',
      'ask',
      'scan_hits',
      'CODE',
    ]);
    expect(d?.explanation).toContain('reported 2 issue(s)');
    expect(d?.explanation).toContain('may not be real problems');
    expect(d?.findings.map((f) => f.criterion)).toEqual(['gate:security']);
    expect(d?.findings[0]?.evidence).toContain('shell=True at bad.txt:1');
    expect(runner.calls.map((c) => c.role)).toEqual([
      'spec-writer',
      'test-author',
      'test-critic',
      'coder',
    ]);
    expect(existsSync(path.join(state.worktree, 'bad.txt'))).toBe(true);
  });

  it('ignore records a minor finding, never asks again, and costs no extra author call', async () => {
    const repo = makeTargetRepo();
    await start(scanConfig(), repo, badScripts());
    await decide(repo, 'r1', 'ignore');
    const { state, runner } = await carryOn(repo, { 'code-critic': [verdictPass()] });
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.scan_policy).toBe('ignore');
    expect(runner.calls.map((c) => c.role)).toEqual(['code-critic']);
    const minor = state.minor_findings.filter((f) => f.criterion === 'gate:security');
    expect(minor).toHaveLength(1);
    expect(minor[0]?.severity).toBe('minor');
    expect(minor[0]?.claim).toContain('ignored by you');
    expect(state.decisions).toHaveLength(1);
    expect(readFileSync(path.join(logdir(repo), 'report.md'), 'utf-8')).toContain('ignored by you');
  });

  it('block sends the hits to the author, and a hit it cannot fix ends at red_checks', async () => {
    const repo = makeTargetRepo();
    await start(scanConfig(), repo, badScripts());
    await decide(repo, 'r1', 'block');
    const done = await carryOn(repo, {
      'code-critic': [verdictPass(), verdictPass()],
      coder: [unlinkBad],
    });
    expect(done.state.status, done.state.notes.join('; ')).toBe('complete');
    expect(done.state.scan_policy).toBe('block');
    expect(done.runner.callsFor('coder')[0]?.prompt).toContain('G-security');
    expect(done.runner.callsFor('coder')[0]?.prompt).toContain('shell=True at bad.txt:1');
    expect(done.state.decisions).toHaveLength(1);

    const repo2 = makeTargetRepo();
    await start(scanConfig(), repo2, badScripts());
    await decide(repo2, 'r1', 'block');
    const stuck = await carryOn(repo2, {
      'code-critic': Array<string>(3).fill(verdictPass()),
      coder: Array<string>(3).fill('no idea'),
    });
    expect(stuck.state.status).toBe('needs_human');
    expect(stuck.state.decisions.map((d) => d.kind)).toEqual(['scan_hits', 'red_checks']);
  });

  it.each(['ignore', 'block'] as const)('an up-front policy (%s) never asks', async (policy) => {
    const { state } = await start(
      scanConfig(policy),
      makeTargetRepo(),
      badScripts(policy === 'block'),
    );
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.decisions).toEqual([]);
    expect(state.scan_policy).toBe(policy);
  });

  it('Full never asks about scan hits: the security reviewer triages them', async () => {
    const { state } = await start(scanConfig('ask', 'full'), makeTargetRepo(), badScripts());
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.decisions).toEqual([]);
  });
});

describe('usage limits', () => {
  const partial = { 'mathutils/core.js': CORE_HEADER + CLAMP_WRONG };
  const paused = (state: RunState) => {
    const d = state.decisions.at(-1);
    expect([state.status, d?.kind]).toEqual(['needs_human', 'usage_limit']);
    return d as NonNullable<typeof d>;
  };

  it.each([
    ['spec-writer', 'SPEC', () => ({ 'spec-writer': [limitHit()] })],
    ['test-critic', 'TESTS', () => ({ 'test-critic': [limitHit()] })],
    ['coder', 'CODE', () => ({ coder: [limitHit({ files: partial })] })],
    ['code-critic', 'CODE', () => ({ 'code-critic': [limitHit()] })],
  ] as const)(
    'a limit during %s pauses the run at %s, never as an error',
    async (_role, stage, over) => {
      const repo = makeTargetRepo();
      const { state } = await start(testConfig(), repo, { ...happyScripts(), ...over() });
      const d = paused(state);
      expect(d.stage).toBe(stage);
      expect(d.explanation).toContain('5-hour usage limit was reached');
      expect(d.explanation).toContain(`during the ${stage.toLowerCase()} step`);
      expect(d.explanation).toContain(ADD_USAGE_URL);
      expect([d.usage?.status, d.billing]).toEqual(['rejected', false]);
      expect(state.rate_limits['five_hour']?.status).toBe('rejected');
      await expect(checkResumable(repo, 'r1')).rejects.toThrow(/waiting for a decision/);
      expect(readFileSync(path.join(logdir(repo), 'report.md'), 'utf-8')).toContain('## Decisions');
    },
  );

  it('running out of credits is its own explanation, and a limit with no details still pauses', async () => {
    const { state } = await start(testConfig(), makeTargetRepo(), {
      ...happyScripts(),
      coder: [limitHit({ billing: true, files: partial })],
    });
    const d = paused(state);
    expect([d.billing, d.usage]).toEqual([true, null]);
    expect(d.explanation).toContain('Console credit balance ran out during the code step');
    expect(d.explanation).toContain(ADD_CREDITS_URL);
    expect(state.auth).toBe('console');

    const none = await start(testConfig(), makeTargetRepo(), {
      ...happyScripts(),
      'spec-writer': [limitHit({ window: null })],
    });
    expect(paused(none.state).explanation).toContain('no details were given');
  });

  it('retry restarts the step with its partial work kept and the author told it was cut off', async () => {
    const repo = makeTargetRepo();
    const first = await start(testConfig(), repo, {
      ...happyScripts(),
      coder: [limitHit({ files: partial })],
    });
    paused(first.state);
    const spent = first.state.cost_usd;
    await decide(repo, 'r1', 'retry');
    expect(decisionReady(stateOf(repo))).toBe(true);

    const seen: { partial?: string; prompt?: string } = {};
    const coder = (req: AgentRequest): string => {
      seen.partial = readFileSync(path.join(req.cwd, 'mathutils/core.js'), 'utf-8');
      seen.prompt = req.prompt;
      return writes(IMPL_OK, 'carried on')(req) as string;
    };
    const { state } = await carryOn(repo, {
      coder: [coder],
      'code-critic': [verdictPass()],
      'standards-reviewer': [verdictPass()],
      'security-reviewer': [verdictPass()],
    });
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(seen.partial).toBe(partial['mathutils/core.js']); // kept, not reset
    expect(seen.prompt?.startsWith(CUT_OFF_NOTE)).toBe(true);
    expect(state.cost_usd).toBeGreaterThan(spent); // one budget across the pause
    expect([state.decisions[0]?.choice, state.decisions[0]?.applied]).toEqual(['retry', true]);
  });

  it('a retry that is still limited pauses again, without waiting or retrying on its own', async () => {
    const repo = makeTargetRepo();
    await start(testConfig(), repo, { ...happyScripts(), coder: [limitHit({ files: partial })] });
    await decide(repo, 'r1', 'retry');
    const { state } = await carryOn(repo, { coder: [limitHit({ files: partial, cost: 0.03 })] });
    expect(state.status).toBe('needs_human');
    expect(state.decisions).toHaveLength(2);
    expect([state.decisions[0]?.applied, state.decisions[1]?.choice]).toEqual([true, '']);
    await expect(checkResumable(repo, 'r1')).rejects.toThrow(NotResumable);
  });

  it("a fix pass cut short by a limit is still the person's choice after Try again", async () => {
    const repo = makeTargetRepo();
    await start(testConfig(), repo, redCode());
    await decide(repo, 'r1', 'fix', NOTE);
    const cut = await carryOn(repo, { coder: [limitHit({ files: partial })] });
    paused(cut.state);
    expect(cut.state.fix_passes).toBe(0); // the pass didn't finish, so it isn't counted
    await decide(repo, 'r1', 'retry');
    const prompts: string[] = [];
    const fixer = (req: AgentRequest): string => {
      prompts.push(req.prompt);
      return writes(IMPL_OK, 'fixed')(req) as string;
    };
    const done = await carryOn(repo, { ...fixedCode(), coder: [fixer] });
    expect([done.state.status, done.state.fix_passes]).toEqual(['complete', 1]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(NOTE);
    expect(prompts[0]).toContain(CUT_OFF_NOTE);
  });

  it('finish ends the run as it is: nothing committed, worktree kept, not resumable', async () => {
    const repo = makeTargetRepo();
    const { state: first } = await start(testConfig(), repo, {
      ...happyScripts(),
      coder: [limitHit({ files: partial })],
    });
    const before = git(first.worktree, 'rev-list', '--count', 'HEAD').trim();
    const state = await decide(repo, 'r1', 'finish');
    expect([state.ended_by, state.status]).toEqual(['finish', 'needs_human']);
    expect('code' in state.commits).toBe(false);
    expect(git(first.worktree, 'rev-list', '--count', 'HEAD').trim()).toBe(before);
    expect(existsSync(first.worktree)).toBe(true);
    expect(state.notes.some((n) => n.startsWith('Finished as is at CODE.'))).toBe(true);
    await expect(checkResumable(repo, 'r1')).rejects.toThrow(/finished as it was/);
  });
});
