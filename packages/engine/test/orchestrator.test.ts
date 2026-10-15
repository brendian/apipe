import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { maxAgentCalls, type Config, type Level } from '@advpipe/contracts';
import {
  authorResponse,
  Cancelled,
  FakeAgentRunner,
  finding,
  interrupt,
  limitHit,
  NotResumable,
  NO_ARBITER_NOTE,
  Orchestrator,
  RunLog,
  rulings,
  verdictFail,
  verdictPass,
  writes,
  type Scripts,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import {
  happyScripts,
  IMPL_OK,
  IMPL_WRONG,
  TASK_MD_BLOCKING,
  TEST_CLAMP,
  TRIVIAL_TEST,
} from './helpers/samples.js';

beforeEach(scrubEnv);

const atLevel = (config: Config, level: Level): Config => ({
  ...config,
  pipeline: { ...config.pipeline, level },
});

async function run(
  config: Config,
  repo: string,
  runner: FakeAgentRunner,
  opts: { runId?: string; keepWorktree?: boolean; progress?: (m: string) => void } = {},
) {
  const runId = opts.runId ?? 't1';
  const orch = new Orchestrator(config, runner, repo, 'add a clamp(x, lo, hi) function', {
    runId,
    name: runId,
    ...(opts.keepWorktree !== undefined && { keepWorktree: opts.keepWorktree }),
    ...(opts.progress !== undefined && { progress: opts.progress }),
  });
  const state = await orch.run();
  return { state, logdir: orch.runlog.root };
}

const branchFile = (repo: string, rel: string): string => git(repo, 'show', `advpipe/t1:${rel}`);
const read = (dir: string, rel: string): string => readFileSync(path.join(dir, rel), 'utf-8');

describe('full level', () => {
  it('passes on the first round and leaves a reviewable branch', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner(happyScripts());
    const { state, logdir } = await run(testConfig(), repo, runner);

    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.stage).toBe('DONE');
    expect(state.rounds_used).toEqual({ tests: 1, code: 1, review: 1 });
    expect(runner.callsFor('arbiter')).toHaveLength(0);
    expect(branchFile(repo, 'mathutils/core.js')).toContain('export function clamp');
    // The user's working tree is untouched.
    expect(readFileSync(path.join(repo, 'mathutils/core.js'), 'utf-8')).not.toContain('clamp');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // One commit per stage; no empty "final" commit when nothing changed after review.
    expect(git(repo, 'log', '--format=%s', 'main..advpipe/t1').trim().split('\n')).toEqual([
      'advpipe: implementation',
      'advpipe: tests',
      'advpipe: spec (task.md)',
    ]);
    expect(JSON.parse(read(logdir, 'run.json')).status).toBe('complete');
    const report = read(logdir, 'report.md');
    expect(report).toContain('**Status:** complete');
    expect(report).toContain('Security scanner not run');
    expect(report).toContain('(worktree removed)');
    for (const rel of [
      'task.md',
      'stage-tests/round-1/critic.json',
      'stage-code/round-1/gates.json',
    ])
      expect(existsSync(path.join(logdir, rel)), rel).toBe(true);
    // Worktree gone, branch kept.
    expect(existsSync(state.worktree)).toBe(false);
    expect(git(repo, 'branch', '--list', 'advpipe/t1')).toContain('advpipe/t1');
    // Cost table.
    expect(state.calls_by_stage).toEqual({ spec: 1, 'stage-tests': 2, 'stage-code': 2, review: 2 });
    expect(report).toContain('| **total** | **7** | **$0.07** | |');
  });

  it('gives critics artifacts, not reasoning; the test author sees no implementation', async () => {
    const runner = new FakeAgentRunner(happyScripts());
    await run(testConfig(), makeTargetRepo(), runner);
    for (const role of [
      'test-critic',
      'code-critic',
      'standards-reviewer',
      'security-reviewer',
    ] as const) {
      const [call] = runner.callsFor(role);
      expect(call?.prompt).not.toContain('AUTHOR-REASONING');
      expect(call?.prompt).toContain('# task.md');
      expect(call?.tools).toEqual(['Read', 'Glob', 'Grep']);
      expect(call?.prompt).not.toContain('task.md b/task.md'); // the contract isn't part of the diff
    }
    expect(runner.callsFor('code-critic')[0]?.prompt).toContain('- tests/clamp.test.js');
    expect(runner.callsFor('test-author')[0]?.prompt).not.toContain('export function clamp');
  });

  it('a critic FAIL goes back to the coder, then passes', async () => {
    const s: Scripts = {
      ...happyScripts(),
      coder: [writes(IMPL_OK), authorResponse({ 'C1-F1': ['fixed', 'added guard'] })],
      'code-critic': [verdictFail(finding('F1')), verdictPass()],
    };
    const runner = new FakeAgentRunner(s);
    const { state } = await run(testConfig(), makeTargetRepo(), runner);
    expect(state.status).toBe('complete');
    expect(state.rounds_used['code']).toBe(2);
    expect(runner.callsFor('coder')[1]?.prompt).toContain('C1-F1');
    expect(runner.callsFor('arbiter')).toHaveLength(0);
  });

  it('a failed gate is blocking even if the critic passes', async () => {
    const s: Scripts = {
      ...happyScripts(),
      coder: [writes(IMPL_WRONG), writes(IMPL_OK, '{}')],
      'code-critic': [verdictPass(), verdictPass()],
    };
    const runner = new FakeAgentRunner(s);
    const { state } = await run(testConfig(), makeTargetRepo(), runner);
    expect(state.status).toBe('complete');
    expect(state.rounds_used['code']).toBe(2);
    expect(runner.callsFor('coder')[1]?.prompt).toContain('C1-G-test');
  });

  it('the round cap sends findings to the arbiter, which can dismiss them', async () => {
    const s: Scripts = {
      ...happyScripts(),
      coder: [writes(IMPL_OK), '{}', '{}'],
      'code-critic': [
        verdictFail(finding('F1', { line: 1 })),
        verdictFail(finding('F1', { line: 2, criterion: 'AC1' })),
        verdictFail(finding('F1', { line: 3, criterion: 'AC3' })),
      ],
      arbiter: [rulings({ 'C3-F1': 'dismiss' })],
    };
    const runner = new FakeAgentRunner(s);
    const { state, logdir } = await run(testConfig(), makeTargetRepo(), runner);
    expect(state.status).toBe('complete');
    expect(state.rounds_used['code']).toBe(3);
    expect(state.rulings.map((r) => r.decision)).toEqual(['dismiss']);
    expect(runner.callsFor('coder')).toHaveLength(3); // no final pass after a dismissal
    expect(existsSync(path.join(logdir, 'arbiter.json'))).toBe(true);
  });

  it('arbiter "fix" gets one final coder pass; still red stops at a red_checks decision', async () => {
    const critic = [1, 2, 3].map((n) => verdictFail(finding('F1', { line: n })));
    const ok: Scripts = {
      ...happyScripts(),
      coder: [writes(IMPL_OK), '{}', '{}', writes(IMPL_OK, 'fixed')],
      'code-critic': critic,
      arbiter: [rulings({ 'C3-F1': 'fix' })],
    };
    const runner = new FakeAgentRunner(ok);
    const done = await run(testConfig(), makeTargetRepo(), runner);
    expect(done.state.status).toBe('complete');
    expect(runner.callsFor('coder')[3]?.prompt).toContain('Final pass');
    expect(runner.callsFor('code-critic')).toHaveLength(3); // no critic round after the final pass

    const red: Scripts = {
      ...ok,
      coder: [writes(IMPL_OK), '{}', '{}', writes(IMPL_WRONG, 'broke it')],
      'code-critic': critic,
      arbiter: [rulings({ 'C3-F1': 'fix' })],
    };
    const { state } = await run(testConfig(), makeTargetRepo(), new FakeAgentRunner(red), {
      runId: 't2',
    });
    expect(state.status).toBe('needs_human');
    expect(state.open_findings.map((f) => f.id)).toEqual(['G-test']);
    const d = state.decisions.at(-1);
    expect(d?.kind).toBe('red_checks');
    expect(d?.explanation).toMatch(
      /^The checks are still failing at CODE \(test\)\. The step's rounds/,
    );
    expect(d?.choice).toBe('');
    expect(existsSync(state.worktree)).toBe(true); // left exactly as it is
  });

  it('reverts a coder edit to the tests and flags it', async () => {
    const gutted = 'import { test } from "node:test";\ntest("nothing", () => {});\n';
    const s: Scripts = {
      ...happyScripts(),
      coder: [
        writes({ ...IMPL_OK, 'tests/clamp.test.js': gutted, 'tests/extra.test.js': gutted }),
        '{}',
      ],
      'code-critic': [verdictPass(), verdictPass()],
    };
    const runner = new FakeAgentRunner(s);
    const { state } = await run(testConfig(), makeTargetRepo(), runner);
    expect(state.status).toBe('complete');
    expect(runner.callsFor('coder')[1]?.prompt).toContain('coder modified test files');
  });

  it('green-before-implementation tests go back to the test author', async () => {
    const s: Scripts = {
      ...happyScripts(),
      'test-author': [
        writes({ 'tests/clamp.test.js': TRIVIAL_TEST }),
        writes({ 'tests/clamp.test.js': TEST_CLAMP }, '{}'),
      ],
      'test-critic': [verdictPass(), verdictPass()],
    };
    const runner = new FakeAgentRunner(s);
    const { state } = await run(testConfig(), makeTargetRepo(), runner);
    expect(state.status).toBe('complete');
    expect(runner.callsFor('test-author')[1]?.prompt).toContain('pass before implementation');
  });

  it('a blocking review finding is fixed via the arbiter; minors are only reported', async () => {
    const s: Scripts = {
      ...happyScripts(),
      'security-reviewer': [verdictFail(finding('F1', { category: 'security' }))],
      'standards-reviewer': [verdictPass(finding('F1', { severity: 'minor' }))],
      arbiter: [rulings({ 'SEC-F1': 'fix' })],
      coder: [writes(IMPL_OK), writes(IMPL_OK, 'fixed')],
    };
    const runner = new FakeAgentRunner(s);
    const { state, logdir } = await run(testConfig(), makeTargetRepo(), runner);
    expect(state.status).toBe('complete');
    expect(runner.callsFor('coder')).toHaveLength(2);
    expect(state.rulings.map((r) => r.finding_id)).toEqual(['SEC-F1']);
    expect(state.minor_findings.map((f) => f.id)).toEqual(['STD-F1']);
    expect(read(logdir, 'report.md')).toContain('STD-F1');
  });

  it('stops on blocking spec questions before any test is written; keeps the worktree', async () => {
    const s: Scripts = {
      ...happyScripts(),
      'spec-writer': [writes({ 'task.md': TASK_MD_BLOCKING })],
    };
    const runner = new FakeAgentRunner(s);
    const { state, logdir } = await run(testConfig(), makeTargetRepo(), runner);
    expect(state.status).toBe('needs_human');
    expect(state.stage).toBe('SPEC');
    expect(state.questions.map((q) => q.id)).toEqual(['Q1']);
    expect(state.open_findings[0]?.claim).toContain('swap or throw');
    expect(runner.callsFor('test-author')).toHaveLength(0);
    expect(existsSync(state.worktree) && !state.worktree_removed).toBe(true);
    expect(read(logdir, 'report.md')).toContain("Answer them on the run's page");
  });

  it('a spec writer that wrote no task.md needs a human', async () => {
    const s: Scripts = { ...happyScripts(), 'spec-writer': ['I wrote nothing'] };
    const { state } = await run(testConfig(), makeTargetRepo(), new FakeAgentRunner(s));
    expect(state.status).toBe('needs_human');
    expect(state.open_findings[0]?.claim).toContain('task.md');
  });

  it('aborts when the budget is crossed, and says so in the report', async () => {
    const runner = new FakeAgentRunner(happyScripts(), { costPerCall: 2 }); // budget is 5
    const { state, logdir } = await run(testConfig(), makeTargetRepo(), runner);
    expect(state.status).toBe('budget_exceeded');
    expect(runner.calls).toHaveLength(3);
    expect(state.cost_usd).toBe(6);
    expect(read(logdir, 'report.md')).toContain('budget_exceeded');
  });

  it('a usage limit pauses the run at a decision; it is never an error', async () => {
    const s: Scripts = { ...happyScripts(), coder: [limitHit({ cost: 0.5 })] };
    const { state } = await run(testConfig(), makeTargetRepo(), new FakeAgentRunner(s));
    expect(state.status).toBe('needs_human');
    expect(state.decisions.at(-1)?.kind).toBe('usage_limit');
    expect(state.cost_usd).toBeGreaterThan(0.5);
  });

  it('keeps the worktree when asked, and reports each step as progress', async () => {
    const lines: string[] = [];
    const { state } = await run(
      testConfig(),
      makeTargetRepo(),
      new FakeAgentRunner(happyScripts()),
      {
        keepWorktree: true,
        progress: (m) => lines.push(m),
      },
    );
    expect(existsSync(state.worktree)).toBe(true);
    expect(lines[0]).toBe('run t1 started; branch advpipe/t1');
    expect(lines.filter((l) => l.startsWith('== '))).toEqual([
      '== SPEC',
      '== TESTS',
      '== CODE',
      '== REVIEW',
      '== FINAL_GATES',
    ]);
  });
});

describe('Tests and Adversarial levels', () => {
  const testsScripts = (): Scripts => ({
    'spec-writer': happyScripts()['spec-writer'] ?? [],
    'test-author': happyScripts()['test-author'] ?? [],
    coder: [writes(IMPL_OK)],
    'code-critic': [verdictPass()],
  });

  it('Tests: four calls, one single review, no critics in the stages, no arbiter', async () => {
    const runner = new FakeAgentRunner(testsScripts());
    const { state, logdir } = await run(atLevel(testConfig(), 'tests'), makeTargetRepo(), runner);
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(runner.calls.map((c) => c.role)).toEqual([
      'spec-writer',
      'test-author',
      'coder',
      'code-critic',
    ]);
    expect(Object.keys(state.commits)).toEqual(['spec', 'tests', 'code', 'review']);
    expect(existsSync(path.join(logdir, 'stage-tests/round-1/critic.json'))).toBe(false);
    expect(existsSync(path.join(logdir, 'review/single.json'))).toBe(true);
    expect(runner.callsFor('code-critic')[0]?.prompt).toContain('This is a single review pass');
  });

  it('Tests: with no arbiter, open findings are ruled fix and the coder gets a final pass', async () => {
    const s = { ...testsScripts(), coder: [writes(IMPL_WRONG), 'r2', 'r3', writes(IMPL_OK)] };
    const runner = new FakeAgentRunner(s);
    const { state, logdir } = await run(atLevel(testConfig(), 'tests'), makeTargetRepo(), runner);
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.rulings.map((r) => [r.finding_id, r.decision, r.reason])).toEqual([
      ['C3-G-test', 'fix', 'no arbiter at level tests'],
    ]);
    expect(runner.callsFor('coder')[3]?.prompt).toContain(NO_ARBITER_NOTE);
    expect(existsSync(path.join(logdir, 'arbiter.json'))).toBe(false);
    expect(state.calls_by_stage['stage-code']).toBe(4); // charged to the stage: no arbiter step
    expect(state.cost_by_stage['arbiter']).toBeUndefined();
  });

  it('Tests: the worst case makes exactly maxAgentCalls.worst calls', async () => {
    const s: Scripts = {
      'spec-writer': happyScripts()['spec-writer'] ?? [],
      'test-author': [
        writes({ 'tests/clamp.test.js': TRIVIAL_TEST }),
        'r2',
        writes({ 'tests/clamp.test.js': TEST_CLAMP }),
      ],
      coder: [writes(IMPL_WRONG), 'r2', 'r3', writes(IMPL_OK), 'review fix'],
      'code-critic': ['not json', 'not json'],
    };
    const runner = new FakeAgentRunner(s);
    const config = atLevel(testConfig(), 'tests');
    const { state } = await run(config, makeTargetRepo(), runner);
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(runner.calls).toHaveLength(maxAgentCalls('tests', config.limits)[1]);
    expect([...runner.scripts.values()].every((steps) => steps.length === 0)).toBe(true);
  });

  it('Adversarial: critics and arbiter, but no review step or review commit', async () => {
    const runner = new FakeAgentRunner(happyScripts());
    const config = atLevel(testConfig(), 'adversarial');
    const { state } = await run(config, makeTargetRepo(), runner);
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(runner.calls).toHaveLength(maxAgentCalls('adversarial', config.limits)[0]);
    expect(Object.keys(state.commits)).toEqual(['spec', 'tests', 'code']);
    expect(runner.callsFor('standards-reviewer')).toHaveLength(0);
    expect(runner.callsFor('code-critic')).toHaveLength(1);
  });

  it('Basic and Reviewer are refused until M5', () => {
    for (const level of ['basic', 'reviewer'] as const) {
      expect(
        () =>
          new Orchestrator(
            atLevel(testConfig(), level),
            new FakeAgentRunner({}),
            makeTargetRepo(),
            'x',
          ),
      ).toThrow(/M5/);
    }
  });
});

describe('resume', () => {
  async function interruptedAtCode(repo: string, config = testConfig()) {
    const s: Scripts = { ...happyScripts(), 'code-critic': [interrupt()] };
    const orch = new Orchestrator(config, new FakeAgentRunner(s), repo, 'add clamp', {
      runId: 'r1',
      name: 'r1',
    });
    await expect(orch.run()).rejects.toBeInstanceOf(Cancelled);
    return orch;
  }
  const codeOnward = (): Scripts => ({
    coder: [writes(IMPL_OK)],
    'code-critic': [verdictPass()],
    'standards-reviewer': [verdictPass()],
    'security-reviewer': [verdictPass()],
  });

  it('an interrupt leaves a resumable run; resume continues at the interrupted stage', async () => {
    const repo = makeTargetRepo();
    const orch = await interruptedAtCode(repo);
    const saved = RunLog.forRun(repo, 'r1').readState();
    expect(saved.status).toBe('running');
    expect(saved.stage).toBe('CODE');
    expect(Object.keys(saved.commits)).toEqual(['spec', 'tests']);
    expect(saved.notes).toContain('Interrupted during CODE');
    expect(orch.runlog.lockHolder()).toBeNull();

    // Partial work from the interrupted stage is discarded on resume.
    writeFileSync(path.join(orch.state.worktree, 'stray.js'), 'x = 1\n');
    const runner = new FakeAgentRunner(codeOnward());
    const resumed = await Orchestrator.resume(runner, repo, 'r1');
    expect(resumed.config).toEqual(testConfig());
    const state = await resumed.run();
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.notes).toContain('Resumed at stage CODE');
    expect(state.cost_usd).toBeCloseTo(0.08);
    expect(new Set(runner.calls.map((c) => c.role))).toEqual(new Set(Object.keys(codeOnward())));
    const files = git(repo, 'ls-tree', '-r', '--name-only', 'advpipe/r1');
    expect(files).not.toContain('stray.js');
    expect(files).toContain('tests/clamp.test.js');
  });

  it('recreates a worktree that was deleted meanwhile', async () => {
    const repo = makeTargetRepo();
    const orch = await interruptedAtCode(repo);
    git(repo, 'worktree', 'remove', '--force', orch.state.worktree);
    const state = await (
      await Orchestrator.resume(new FakeAgentRunner(codeOnward()), repo, 'r1')
    ).run();
    expect(state.status, state.notes.join('; ')).toBe('complete');
  });

  it('resumes a budget_exceeded run with a new total, saved to config.json', async () => {
    const repo = makeTargetRepo();
    const first = new Orchestrator(
      testConfig(),
      new FakeAgentRunner(happyScripts(), { costPerCall: 2 }),
      repo,
      'w',
      {
        runId: 'r1',
      },
    );
    const over = await first.run();
    expect(over.status).toBe('budget_exceeded');
    expect(Object.keys(over.commits)).toEqual(['spec']);

    const { 'spec-writer': _spec, ...rest } = happyScripts();
    void _spec;
    const state = await (
      await Orchestrator.resume(new FakeAgentRunner(rest), repo, 'r1', { budgetUsd: 20 })
    ).run();
    expect(state.status, state.notes.join('; ')).toBe('complete');
    expect(state.cost_usd).toBeCloseTo(6.06);
    expect(state.cost_by_stage['spec']).toBeCloseTo(2);
    expect(RunLog.forRun(repo, 'r1').readConfig()?.limits.budget_usd_per_task).toBe(20);
  });

  it('refuses what cannot be resumed, says why, and ignores a stale lock', async () => {
    const repo = makeTargetRepo();
    await new Orchestrator(testConfig(), new FakeAgentRunner(happyScripts()), repo, 'w', {
      runId: 'done',
    }).run();
    await expect(Orchestrator.resume(new FakeAgentRunner({}), repo, 'done')).rejects.toThrow(
      /complete/,
    );
    await expect(Orchestrator.resume(new FakeAgentRunner({}), repo, 'nope')).rejects.toThrow(
      NotResumable,
    );
    expect(existsSync(path.join(repo, '.advpipe/runs/nope'))).toBe(false);

    await interruptedAtCode(repo);
    const lock = path.join(repo, '.advpipe/runs/r1/run.lock');
    writeFileSync(lock, String(process.pid));
    await expect(Orchestrator.resume(new FakeAgentRunner({}), repo, 'r1')).rejects.toThrow(
      /still being driven/,
    );
    writeFileSync(lock, '999999999');
    const state = await (
      await Orchestrator.resume(new FakeAgentRunner(codeOnward()), repo, 'r1')
    ).run();
    expect(state.status).toBe('complete');
  });

  it('a resumed run keeps its level: a config that sets another is refused', async () => {
    const repo = makeTargetRepo();
    await interruptedAtCode(repo);
    const other = atLevel(testConfig(), 'tests');
    await expect(
      Orchestrator.resume(new FakeAgentRunner({}), repo, 'r1', {
        config: other,
        explicit: { pipeline: new Set(['level']) },
      }),
    ).rejects.toThrow(/keeps its level/);
  });
});
