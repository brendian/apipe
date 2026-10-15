import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { BudgetExceeded } from '../src/index.js';
import {
  arbiterStage,
  authorFindingsPrompt,
  buildRequest,
  callCritic,
  checkedFindings,
  criticPrompt,
  extractJson,
  fixPassExtra,
  gateFinding,
  loadPrompt,
  parseAuthorResponse,
  parseModel,
  reviewStage,
  SdkAgentRunner,
  singleReviewStage,
  testFileGuard,
  UsageLimitReached,
  FakeAgentRunner,
  authorResponse,
  finding,
  limitHit,
  rulings,
  verdictFail,
  verdictPass,
  writes,
  said,
} from '../src/index.js';
import { Verdict, type GateResult } from '@advpipe/contracts';
import { makeTargetRepo, scrubEnv, testConfig } from './helpers/repo.js';
import { commitSpec, makeCtx, TEST_CLAMP } from './helpers/samples.js';

beforeEach(scrubEnv);

describe('agent output parsing', () => {
  it.each([
    '{"verdict": "PASS", "findings": []}',
    'Here you go:\n```json\n{"verdict": "PASS", "findings": []}\n```\n',
    'Sure. {"verdict": "PASS", "findings": []} Done.',
  ])('extracts JSON from %j', (text) => {
    expect(parseModel(text, Verdict).verdict).toBe('PASS');
  });

  it('passes text through when there is no object; rejects bad schemas; author replies are lenient', () => {
    expect(extractJson('no json here')).toBe('no json here');
    expect(() => parseModel('{"verdict": "MAYBE"}', Verdict)).toThrow(/verdict/);
    expect(parseAuthorResponse('not json').size).toBe(0);
    expect(parseAuthorResponse(authorResponse({ 'C1-F1': ['disputed', 'AC3'] })).has('C1-F1')).toBe(
      true,
    );
  });
});

describe('callCritic', () => {
  it('retries once with the parse error and the previous reply', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({ 'code-critic': ['garbage', verdictPass()] });
    const ctx = await makeCtx(testConfig(), repo, runner);
    const { verdict } = await callCritic(ctx, 'code-critic', 'judge this', 'stage-code');
    expect(verdict.verdict).toBe('PASS');
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.prompt).toContain('garbage');
    expect(runner.calls[1]?.prompt).toContain('matching the Verdict schema');
  });

  it('is a blocking FAIL after two unparseable replies, never a PASS', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({ 'code-critic': ['garbage', 'more garbage'] });
    const ctx = await makeCtx(testConfig(), repo, runner);
    const { verdict, raw } = await callCritic(ctx, 'code-critic', 'judge this', 'stage-code');
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.findings.map((f) => f.claim)).toEqual(['critic output unparseable']);
    expect(raw).toBe('more garbage');
  });

  it('counts ungrounded findings as noise', async () => {
    const repo = makeTargetRepo();
    const vague = finding('F1', { file: null, line: null, criterion: null });
    const runner = new FakeAgentRunner({ 'code-critic': [verdictFail(vague)] });
    const ctx = await makeCtx(testConfig(), repo, runner);
    await callCritic(ctx, 'code-critic', 'p', 'stage-code');
    expect(ctx.state.noise_dropped).toBe(1);
  });
});

describe('budget and usage', () => {
  it('is checked after every call, and the cost so far still counts', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner(
      { 'code-critic': ['garbage', verdictPass()] },
      { costPerCall: 3 },
    );
    const ctx = await makeCtx(testConfig(), repo, runner);
    await expect(callCritic(ctx, 'code-critic', 'judge', 'stage-code')).rejects.toBeInstanceOf(
      BudgetExceeded,
    );
    expect(ctx.state.cost_usd).toBe(6);
    expect(ctx.budget.byStage['stage-code']).toBe(6);
  });

  it('a limit keeps its cost, pauses (rethrows) and is noted', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({ coder: [limitHit({ cost: 0.5 })] });
    const ctx = await makeCtx(testConfig(), repo, runner);
    const { callAgent } = await import('../src/index.js');
    await expect(callAgent(ctx, 'coder', 'p', 'stage-code')).rejects.toBeInstanceOf(
      UsageLimitReached,
    );
    expect(ctx.budget.spent).toBe(0.5);
    expect(ctx.state.rate_limits['five_hour']?.status).toBe('rejected');
    expect(readFileSync(ctx.runlog.path('events.jsonl'), 'utf-8')).toContain(
      'stopped by a usage limit',
    );
  });

  it('cut-off note is prepended once, to writing roles only', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({ coder: ['a', 'b'], 'code-critic': ['c'] });
    const ctx = await makeCtx(testConfig(), repo, runner);
    const { callAgent } = await import('../src/index.js');
    ctx.cutOff = true;
    await callAgent(ctx, 'code-critic', 'p', 's');
    expect(ctx.cutOff).toBe(true);
    await callAgent(ctx, 'coder', 'p', 's');
    await callAgent(ctx, 'coder', 'p', 's');
    expect(runner.callsFor('code-critic')[0]?.prompt).toBe('p');
    expect(runner.callsFor('coder')[0]?.prompt).toMatch(
      /^A previous attempt at this step was cut off/,
    );
    expect(runner.callsFor('coder')[1]?.prompt).toBe('p');
  });

  it('a Console login adds a warning note once; subscription events record usage', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({
      coder: [said('x', { auth: 'console' }), said('y', { auth: 'console' })],
    });
    const ctx = await makeCtx(testConfig(), repo, runner);
    const { callAgent } = await import('../src/index.js');
    await callAgent(ctx, 'coder', 'p', 's');
    await callAgent(ctx, 'coder', 'p', 's');
    expect(ctx.state.auth).toBe('console');
    expect(ctx.state.notes.filter((n) => n.includes('Console credits'))).toHaveLength(1);
  });
});

describe('requests', () => {
  it('carry the role settings; read-only roles have no editing tool', async () => {
    const config = testConfig();
    const critic = buildRequest('code-critic', 'p', config, '/w', 1.5);
    expect(critic).toMatchObject({
      model: 'claude-sonnet-5-5',
      tools: ['Read', 'Glob', 'Grep'],
      max_budget_usd: 1.5,
    });
    expect(critic.system_prompt).toContain('code critic');
    const coder = buildRequest('coder', 'p', config, '/w', null);
    expect(coder.model).toBe('claude-opus-5-5');
    expect(coder.tools).toEqual(expect.arrayContaining(['Edit', 'Bash']));
    expect(loadPrompt('arbiter').length).toBeGreaterThan(100);
  });

  it('SDK options: dontAsk, project settings, abort wired, no Electron-only env', () => {
    process.env['ELECTRON_RUN_AS_NODE'] = '1';
    try {
      const req = buildRequest('spec-writer', 'p', testConfig(), '/w', 2);
      const abort = new AbortController();
      const o = new SdkAgentRunner().buildOptions(req, abort);
      expect(o).toMatchObject({
        permissionMode: 'dontAsk',
        settingSources: ['project'],
        tools: ['Read', 'Glob', 'Grep', 'Write'],
        allowedTools: ['Read', 'Glob', 'Grep', 'Write'],
        maxBudgetUsd: 2,
        maxTurns: 40,
        cwd: '/w',
      });
      expect(o.abortController).toBe(abort);
      expect(o.env?.['ELECTRON_RUN_AS_NODE']).toBeUndefined();
      expect(o.env?.['PATH']).toBeDefined();
    } finally {
      delete process.env['ELECTRON_RUN_AS_NODE'];
    }
  });
});

describe('prompts', () => {
  it('a code critic sees task.md, the diff, gates and the tests; never the author reply', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({});
    const ctx = await makeCtx(testConfig(), repo, runner);
    await commitSpec(ctx);
    writes({ 'tests/clamp.test.js': TEST_CLAMP })({ cwd: ctx.workspace.path } as never);
    ctx.state.commits['spec'] = await ctx.workspace.commit('x');
    const p = await criticPrompt(ctx, 'code', 'Implementation diff', '+some diff', []);
    expect(p).toContain('# task.md\n\n# Task: Add clamp');
    expect(p).toContain('+some diff');
    expect(p).toContain('# Gate output');
    expect(p).toContain('Reply with Verdict JSON only.');
    const single = await criticPrompt(ctx, 'code', 'Full diff', '', [], { single: true });
    expect(single).toContain('This is a single review pass');
    expect(single).toContain('(empty diff)');
  });

  it('findings prompt carries the findings, gate output and a person’s note verbatim', () => {
    const gate: GateResult = {
      name: 'test',
      command: ['x'],
      returncode: 1,
      output: 'boom',
      skipped: false,
      skip_reason: '',
    };
    const p = authorFindingsPrompt([gateFinding(gate)], [gate], 'Round 2');
    expect(p).toMatch(/^# Round 2\n\nBlocking findings to address:\n\n```json\n/);
    expect(p).toContain('"id": "G-test"');
    expect(p).toContain('### test: FAIL (exit 1)');
    expect(fixPassExtra('  ')).toBe('');
    expect(fixPassExtra(' try X ')).toBe(
      '\n\nA person asked for this pass and left you this note:\n\n```\ntry X\n```',
    );
  });
});

describe('guards', () => {
  it('reverts test edits and flags them', async () => {
    const repo = makeTargetRepo();
    const ctx = await makeCtx(testConfig(), repo, new FakeAgentRunner({}));
    const base = await ctx.workspace.head();
    writes({ 'tests/core.test.js': '// tampered\n', 'tests/new.test.js': 'x' })({
      cwd: ctx.workspace.path,
    } as never);
    const [f] = await testFileGuard(ctx, base);
    expect(f).toMatchObject({
      id: 'T-guard',
      criterion: 'guard:tests',
      file: 'tests/core.test.js',
      line: 1,
    });
    expect(f?.evidence).toBe('Reverted: tests/core.test.js, tests/new.test.js');
    expect(await ctx.workspace.changedFiles(base, ['tests/'])).toEqual([]);
  });

  it('scan policy: ask throws, block is blocking, ignore is one minor finding', async () => {
    const repo = makeTargetRepo();
    const ctx = await makeCtx(testConfig(), repo, new FakeAgentRunner({}));
    const hit: GateResult = {
      name: 'security',
      command: ['s'],
      returncode: 1,
      output: '2 findings',
      skipped: false,
      skip_reason: '',
    };
    expect(() => checkedFindings(ctx, [hit])).toThrow(/reported 2 issue\(s\)/);
    ctx.state.scan_policy = 'block';
    expect(checkedFindings(ctx, [hit]).map((f) => f.id)).toEqual(['G-security']);
    ctx.state.scan_policy = 'ignore';
    expect(checkedFindings(ctx, [hit])).toEqual([]);
    checkedFindings(ctx, [hit]);
    expect(ctx.state.minor_findings.map((f) => f.id)).toEqual(['G-security-ignored']);
  });
});

describe('reviews and the arbiter', () => {
  it('a limit in one reviewer is raised only after both have finished', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({
      'standards-reviewer': [verdictPass()],
      'security-reviewer': [limitHit({ cost: 0.3 })],
    });
    const ctx = await makeCtx(testConfig(), repo, runner);
    await commitSpec(ctx);
    await expect(reviewStage(ctx)).rejects.toBeInstanceOf(UsageLimitReached);
    expect(runner.calls.map((c) => c.role).sort()).toEqual([
      'security-reviewer',
      'standards-reviewer',
    ]);
    expect(ctx.budget.spent).toBeCloseTo(0.31);
  });

  it('full review prefixes ids STD-/SEC-, keeps minors, and writes its files', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({
      'standards-reviewer': [verdictFail(finding('F1'), finding('F2', { severity: 'minor' }))],
      'security-reviewer': [verdictFail(finding('F1', { category: 'security' }))],
    });
    const ctx = await makeCtx(testConfig(), repo, runner);
    await commitSpec(ctx);
    const r = await reviewStage(ctx);
    expect(r.passed).toBe(false);
    expect(r.open_findings.map((d) => d.finding.id)).toEqual(['STD-F1', 'SEC-F1']);
    expect(r.minor_findings.map((f) => f.id)).toEqual(['STD-F2']);
    expect(
      ctx.state.notes.some((n) => n.includes('Security scanner not run (not configured)')),
    ).toBe(true);
    for (const f of ['diff.patch', 'standards.json', 'security.json', 'scanner.json'])
      expect(() => readFileSync(ctx.runlog.path(`review/${f}`))).not.toThrow();
    // Reviewers get the same artifacts: task.md, the diff, gates, and their own extra.
    expect(runner.callsFor('security-reviewer')[0]?.prompt).toContain(
      '### security: skipped (not configured)',
    );
    expect(runner.callsFor('standards-reviewer')[0]?.prompt).toContain(
      '# Standards doc (CLAUDE.md)',
    );
  });

  it('single review prefixes REV- and treats a test-defect as ordinary', async () => {
    const repo = makeTargetRepo();
    const runner = new FakeAgentRunner({
      'code-critic': [verdictFail(finding('F1', { category: 'test-defect' }))],
    });
    const ctx = await makeCtx(testConfig(), repo, runner);
    await commitSpec(ctx);
    const r = await singleReviewStage(ctx);
    expect(r.open_findings.map((d) => d.finding.id)).toEqual(['REV-F1']);
    expect(ctx.state.rounds_used['review']).toBe(1);
  });

  it('arbiter: gate findings are fix without a call; unparseable output means fix', async () => {
    const repo = makeTargetRepo();
    const gate: GateResult = {
      name: 'test',
      command: ['x'],
      returncode: 1,
      output: '',
      skipped: false,
      skip_reason: '',
    };
    const runner = new FakeAgentRunner({
      arbiter: [rulings({ 'C1-F1': 'dismiss' }), 'garbage', 'garbage'],
    });
    const ctx = await makeCtx(testConfig(), repo, runner);
    await commitSpec(ctx);
    const gateOnly = await arbiterStage(
      ctx,
      [{ finding: gateFinding(gate), response: null }],
      'code',
    );
    expect(gateOnly).toEqual([
      { finding_id: 'G-test', decision: 'fix', reason: 'failed gate is ground truth' },
    ]);
    expect(runner.calls).toHaveLength(0);

    const f1 = { finding: { ...finding('C1-F1'), suggested_check: '' }, response: null } as never;
    const ruled = await arbiterStage(ctx, [f1], 'code');
    expect(ruled.map((r) => r.decision)).toEqual(['dismiss']);

    const lost = await arbiterStage(ctx, [f1], 'code');
    expect(lost.map((r) => r.decision)).toEqual(['fix']);
    expect(ctx.state.notes).toContain('Arbiter output unparseable (code); all findings ruled fix.');
    expect(readFileSync(ctx.runlog.path('arbiter-code.json'), 'utf-8')).toBe('garbage');
  });
});
