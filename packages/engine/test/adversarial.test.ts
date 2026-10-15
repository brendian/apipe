import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adversarialStage,
  authorResponse,
  FakeAgentRunner,
  finding,
  finalAuthorPass,
  verdictFail,
  verdictPass,
  writes,
  type Context,
  type Scripts,
  type Step,
} from '../src/index.js';
import { git, makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import {
  CLAMP_WRONG,
  commitSpec,
  CORE_HEADER,
  happyScripts,
  IMPL_OK,
  IMPL_WRONG,
  makeCtx,
  TEST_CLAMP,
  TEST_CLAMP_DEFECT,
  TRIVIAL_TEST,
} from './helpers/samples.js';

beforeEach(scrubEnv);

/** A context at the start of the CODE stage: spec and tests stages done and committed. */
async function atCode(scripts: Scripts, testsScript: Step[] = happyScripts()['test-author'] ?? []) {
  const repo = makeTargetRepo();
  const runner = new FakeAgentRunner({ ...happyScripts(), ...scripts, 'test-author': testsScript });
  const ctx = await makeCtx(testConfig(), repo, runner);
  await commitSpec(ctx);
  const tests = await adversarialStage(ctx, 'tests');
  expect(tests.passed).toBe(true);
  ctx.state.commits['tests'] = await ctx.workspace.commit('advpipe: tests');
  return { repo, runner, ctx };
}

const rdirFile = (ctx: Context, rel: string): string => readFileSync(ctx.runlog.path(rel), 'utf-8');

describe('tests stage', () => {
  it('passes on the first round when the new tests fail (red)', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner(happyScripts());
    const ctx = await makeCtx(testConfig(), repo, runner);
    await commitSpec(ctx);
    const r = await adversarialStage(ctx, 'tests');
    expect(r).toMatchObject({ name: 'tests', passed: true, rounds: 1, open_findings: [] });
    expect(runner.callsFor('test-author')[0]?.prompt).toContain('Write the tests now.');
    expect(runner.callsFor('test-critic')).toHaveLength(1);
    for (const f of ['author.txt', 'diff.patch', 'critic.json', 'gates.json'])
      expect(() => rdirFile(ctx, `stage-tests/round-1/${f}`)).not.toThrow();
  });

  it('green tests are a blocking finding the author must fix; no critic at the Tests level', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({
      'test-author': [
        writes({ 'tests/triv.test.js': TRIVIAL_TEST }),
        writes({ 'tests/clamp.test.js': TEST_CLAMP }),
      ],
    });
    const ctx = await makeCtx(testConfig(), repo, runner);
    await commitSpec(ctx);
    const r = await adversarialStage(ctx, 'tests', { critic: false });
    expect(r.passed).toBe(true);
    expect(r.rounds).toBe(2);
    const second = runner.callsFor('test-author')[1]?.prompt ?? '';
    expect(second).toContain('G-tests-green');
    expect(runner.callsFor('test-critic')).toHaveLength(0);
  });

  it('no test files at all: G-tests-missing, then open at the cap', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({ 'test-author': ['nothing', 'still nothing'] });
    const ctx = await makeCtx(testConfig(), repo, runner);
    await commitSpec(ctx);
    const r = await adversarialStage(ctx, 'tests', { critic: false });
    expect(r.passed).toBe(false);
    expect(r.open_findings.map((d) => d.finding.id)).toEqual(['T2-G-tests-missing']);
    expect(ctx.state.rounds_used['tests']).toBe(2);
  });
});

describe('code stage', () => {
  it('passes on the first round; the critic never sees the author’s reasoning', async () => {
    const { runner, ctx } = await atCode({});
    const r = await adversarialStage(ctx, 'code');
    expect(r).toMatchObject({ passed: true, rounds: 1 });
    const critic = runner.callsFor('code-critic')[0]?.prompt ?? '';
    expect(critic).toContain('# Implementation diff');
    expect(critic).toContain('+export function clamp');
    expect(critic).toContain('- tests/clamp.test.js');
    expect(critic).toContain('### test: PASS');
    expect(critic).not.toContain('AUTHOR-REASONING');
    expect(critic).not.toContain('task.md\n+'); // task.md is excluded from the judged diff
    expect(runner.callsFor('coder')[0]?.prompt).toContain('Do not modify anything under: tests/');
  });

  it('FAIL then PASS: findings go back with round-prefixed ids', async () => {
    const { runner, ctx } = await atCode({
      coder: [writes(IMPL_OK), '{}'],
      'code-critic': [verdictFail(finding('F1')), verdictPass()],
    });
    const r = await adversarialStage(ctx, 'code');
    expect(r).toMatchObject({ passed: true, rounds: 2 });
    expect(runner.callsFor('coder')[1]?.prompt).toContain('"id": "C1-F1"');
    expect(runner.callsFor('coder')[1]?.prompt).toMatch(/^# Round 2/);
  });

  it('a dispute the next critic does not raise again is accepted', async () => {
    const { ctx } = await atCode({
      coder: [writes(IMPL_OK), authorResponse({ 'C1-F1': ['disputed', 'AC3 allows it'] })],
      'code-critic': [verdictFail(finding('F1')), verdictPass()],
    });
    expect(await adversarialStage(ctx, 'code')).toMatchObject({ passed: true, rounds: 2 });
  });

  it('a dispute raised again goes straight to the arbiter, with the author’s response', async () => {
    const { ctx } = await atCode({
      coder: [writes(IMPL_OK), authorResponse({ 'C1-F1': ['disputed', 'AC3 allows it'] })],
      'code-critic': [verdictFail(finding('F1')), verdictFail(finding('F9', { line: 99 }))],
    });
    const r = await adversarialStage(ctx, 'code');
    expect(r.passed).toBe(false);
    expect(r.rounds).toBe(2);
    expect(r.open_findings).toHaveLength(1);
    expect(r.open_findings[0]?.finding.id).toBe('C1-F1');
    expect(r.open_findings[0]?.response?.note).toBe('AC3 allows it');
  });

  it('a failed gate is a blocking finding that cannot be disputed; the cap leaves it open', async () => {
    const { ctx } = await atCode({
      coder: [
        writes(IMPL_WRONG),
        authorResponse({ 'C1-G-test': ['disputed', 'no'] }),
        authorResponse({ 'C2-G-test': ['disputed', 'no'] }),
      ],
      'code-critic': [verdictPass(), verdictPass(), verdictPass()],
    });
    const r = await adversarialStage(ctx, 'code');
    expect(r.passed).toBe(false);
    expect(r.rounds).toBe(3);
    expect(r.open_findings.map((d) => d.finding.id)).toEqual(['C3-G-test']);
    expect(r.open_findings[0]?.response).toBeNull();
  });

  it('coder edits to tests are reverted before the gates run, and flagged', async () => {
    const { ctx } = await atCode({
      coder: [writes({ ...IMPL_OK, 'tests/clamp.test.js': '// weakened\n' }), '{}'],
      'code-critic': [verdictPass(), verdictPass()],
    });
    const r = await adversarialStage(ctx, 'code');
    expect(r).toMatchObject({ passed: true, rounds: 2 });
    expect(readFileSync(path.join(ctx.workspace.path, 'tests/clamp.test.js'), 'utf-8')).toBe(
      TEST_CLAMP,
    );
    expect(rdirFile(ctx, 'stage-code/round-1/gates.json')).toContain('"returncode": 0');
  });

  it('judgeExisting skips the first author call and judges the work as it is', async () => {
    const { runner, ctx } = await atCode({ 'code-critic': [verdictPass()] });
    await writes(IMPL_OK)({ cwd: ctx.workspace.path } as never);
    ctx.judgeExisting = true;
    const r = await adversarialStage(ctx, 'code');
    expect(r.passed).toBe(true);
    expect(runner.callsFor('coder')).toHaveLength(0);
    expect(ctx.judgeExisting).toBe(false);
  });

  it('a final author pass runs the guard and gates, with no critic', async () => {
    const { runner, ctx } = await atCode({
      coder: [writes(IMPL_WRONG), '{}', '{}'],
      'code-critic': [verdictPass(), verdictPass(), verdictPass()],
    });
    const open = await adversarialStage(ctx, 'code');
    expect(open.passed).toBe(false);
    runner.scripts.set('coder', [writes(IMPL_OK)]);
    const left = await finalAuthorPass(
      ctx,
      'coder',
      open.open_findings.map((d) => d.finding),
      'code',
      {
        note: 'Final pass: the arbiter ruled these must be fixed',
      },
    );
    expect(left).toEqual([]);
    expect(ctx.budget.byStage['arbiter']).toBeGreaterThan(0);
    expect(rdirFile(ctx, 'final-pass-code/gates.json')).toContain('"name": "test"');
  });
});

describe('test defects (code stage)', () => {
  const defect = (id = 'F1') =>
    finding(id, {
      category: 'test-defect',
      file: 'tests/clamp.test.js',
      line: 8,
      criterion: 'AC2',
    });
  const defective = (): Step[] => [
    writes({ 'tests/clamp.test.js': TEST_CLAMP_DEFECT }),
    writes({ 'tests/clamp.test.js': TEST_CLAMP }, 'fixed the expected value'),
  ];

  it('goes back to the test author once; tests are committed alone; the coder is not asked', async () => {
    const { runner, ctx } = await atCode({ 'code-critic': [verdictFail(defect())] }, defective());
    const r = await adversarialStage(ctx, 'code');
    expect(r).toMatchObject({ passed: true, rounds: 1 });
    expect(runner.callsFor('coder')).toHaveLength(1);
    const fix = runner.callsFor('test-author')[1]?.prompt ?? '';
    expect(fix).toContain('# Test fix pass');
    expect(fix).toContain('"claim"');
    const log = git(ctx.workspace.path, 'log', '--format=%s');
    expect(log).toContain('advpipe: test fix (stage-code round-1)');
    expect(readFileSync(path.join(ctx.workspace.path, 'tests/clamp.test.js'), 'utf-8')).toBe(
      TEST_CLAMP,
    );
    const recorded = r.minor_findings.find((f) => f.category === 'test-defect');
    expect(recorded).toMatchObject({ id: 'C1-F1', severity: 'minor' });
    expect(ctx.state.notes.some((n) => n.includes('fixed defective tests'))).toBe(true);
  });

  it('survives later rounds: the guard baseline moves to the fix commit', async () => {
    const { runner, ctx } = await atCode(
      {
        coder: [writes(IMPL_OK), '{}'],
        'code-critic': [
          verdictFail(defect('F1'), finding('F2', { line: 3, criterion: 'AC3' })),
          verdictPass(),
        ],
      },
      defective(),
    );
    const r = await adversarialStage(ctx, 'code');
    expect(r).toMatchObject({ passed: true, rounds: 2 });
    expect(runner.callsFor('coder')[1]?.prompt).not.toContain('T-guard');
    expect(readFileSync(path.join(ctx.workspace.path, 'tests/clamp.test.js'), 'utf-8')).toBe(
      TEST_CLAMP,
    );
  });

  it('a claim alone clears nothing: no failing test, no fix pass', async () => {
    const { runner, ctx } = await atCode({ 'code-critic': [verdictFail(defect())] });
    const r = await adversarialStage(ctx, 'code');
    expect(r.passed).toBe(true);
    expect(runner.callsFor('test-author')).toHaveLength(1);
    expect(r.minor_findings.map((f) => f.category)).toEqual(['test-defect']);
  });

  it('only one fix pass per stage; the failing gate stays ground truth', async () => {
    const steps = defective();
    steps[1] = writes({ 'tests/clamp.test.js': TEST_CLAMP_DEFECT }, 'tried');
    const { runner, ctx } = await atCode(
      {
        coder: [writes(IMPL_OK), '{}', '{}'],
        'code-critic': [verdictFail(defect()), verdictFail(defect()), verdictFail(defect())],
      },
      steps,
    );
    const r = await adversarialStage(ctx, 'code');
    expect(runner.callsFor('test-author')).toHaveLength(2);
    expect(r.passed).toBe(false);
    expect(r.open_findings.map((d) => d.finding.id)).toEqual(['C3-G-test']);
  });

  it('the fix pass cannot touch implementation files', async () => {
    const steps = defective();
    steps[1] = writes({
      'tests/clamp.test.js': TEST_CLAMP,
      'mathutils/core.js': CORE_HEADER + CLAMP_WRONG,
      'mathutils/extra.js': 'export const x = 1;\n',
    });
    const { ctx } = await atCode({ 'code-critic': [verdictFail(defect())] }, steps);
    const r = await adversarialStage(ctx, 'code');
    expect(r.passed).toBe(true);
    expect(readFileSync(path.join(ctx.workspace.path, 'mathutils/core.js'), 'utf-8')).toBe(
      IMPL_OK['mathutils/core.js'],
    );
    expect(
      await ctx.workspace.changedFiles(ctx.state.commits['tests'] ?? '', ['mathutils/']),
    ).toEqual(['mathutils/core.js', 'mathutils/index.js']);
    expect(
      ctx.state.notes.some((n) => n.includes('reverted: mathutils/core.js, mathutils/extra.js')),
    ).toBe(true);
  });
});
