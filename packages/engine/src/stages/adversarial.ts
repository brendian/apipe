import {
  isBlocking,
  isGate,
  matchKeyString,
  Verdict,
  type Dispute,
  type Finding,
  type GateResult,
  type StageResult,
} from '@advpipe/contracts';
import { gatesLine } from '../core/gates.js';
import { gateStatuses } from '../core/events.js';
import { callAgent, callCritic, emitVerdict, parseAuthorResponse } from './calls.js';
import type { Context } from './context.js';
import { inPaths, prefixIds, readBytes, stageGates, testFileGuard, writeBytes } from './guards.js';
import {
  authorFindingsPrompt,
  authorInitialPrompt,
  criticPrompt,
  REVIEW_PATHS,
  testFixPrompt,
} from './prompts.js';
import path from 'node:path';

/**
 * Send tests the code critic says are defective back to the test author, once. The test author
 * may only change files under the test paths; anything else it touches is put back. Changed tests
 * are committed on their own, and that commit becomes the new baseline for the coder's test-file
 * guard. Returns the new baseline commit.
 */
export async function testFixPass(
  ctx: Context,
  defects: Finding[],
  gates: GateResult[],
  testsBase: string,
  rdir: string,
): Promise<string> {
  const ws = ctx.workspace;
  const paths = ctx.config.paths.tests;
  const head = await ws.head();
  const nonTest = async (): Promise<string[]> =>
    (await ws.changedFiles(head)).filter((f) => !inPaths(f, paths));
  const before = new Map<string, Buffer | null>();
  for (const f of await nonTest()) before.set(f, readBytes(path.join(ws.path, f)));

  ctx.emit(
    'test_fix',
    `code-critic reports ${defects.length} defective test(s): one fix pass by test-author`,
  );
  const result = await callAgent(
    ctx,
    'test-author',
    testFixPrompt(ctx, defects, gates),
    'stage-code',
  );
  ctx.runlog.writeText(`${rdir}/test-fix.txt`, result.text);

  const reverted: string[] = [];
  for (const f of [...new Set([...before.keys(), ...(await nonTest())])].sort()) {
    const target = path.join(ws.path, f);
    if (!before.has(f)) {
      await ws.restore(head, [f]);
      reverted.push(f);
    } else {
      const original = before.get(f) ?? null;
      const now = readBytes(target);
      if (original === null ? now !== null : now === null || !original.equals(now)) {
        writeBytes(target, original);
        reverted.push(f);
      }
    }
  }
  if (reverted.length > 0) {
    ctx.state.notes.push(
      `Test author edited non-test files during its fix pass; reverted: ${reverted.join(', ')}`,
    );
    ctx.emit('guard', `test-author edited non-test files; reverted: ${reverted.join(', ')}`);
  }

  const changed = await ws.changedFiles(testsBase, paths);
  if (changed.length === 0) {
    ctx.emit('test_fix', 'test-author changed no tests');
    return testsBase;
  }
  const commit = await ws.commitPaths(`advpipe: test fix (${rdir.replaceAll('/', ' ')})`, changed);
  ctx.state.commits['tests'] = commit; // the coder's test guard now protects the fixed tests
  ctx.state.notes.push(`Test author fixed defective tests: ${changed.join(', ')}`);
  ctx.emit('test_fix', `test fix committed: ${changed.join(', ')}`, { files: changed });
  return commit;
}

/**
 * Author ⇄ critic loop with a round cap. Returns findings the arbiter must settle.
 * `critic: false` (the Tests level): each round runs the author, the guard and the gates, and
 * no critic, so only gate and guard findings go back to the author.
 */
export async function adversarialStage(
  ctx: Context,
  kind: 'tests' | 'code',
  opts: { critic?: boolean } = {},
): Promise<StageResult> {
  const hasCritic = opts.critic ?? true;
  const limits = ctx.config.limits;
  const [author, criticRole, cap, label] =
    kind === 'tests'
      ? (['test-author', 'test-critic', limits.max_rounds_tests, 'Test diff'] as const)
      : (['coder', 'code-critic', limits.max_rounds_code, 'Implementation diff'] as const);
  const stage = `stage-${kind}`;
  const base = await ctx.workspace.head();

  let toAuthor: Finding[] = [];
  const forArbiter: Dispute[] = [];
  const minors: Finding[] = [];
  let rounds = 0;
  let testsBase = base; // what the coder's test-file guard protects; moves after a test fix
  let testFixUsed = false;
  for (let rnd = 1; rnd <= cap; rnd++) {
    rounds = rnd;
    ctx.state.round = rnd;
    ctx.save();
    ctx.emit('round', `round ${rnd}/${cap}`, { cap });
    const rdir = `${stage}/round-${rnd}`;

    let authorText: string;
    if (rnd === 1 && ctx.judgeExisting) {
      // The work is in the worktree already, and a person has decided how to treat the scan's
      // hits: judge it as it is.
      ctx.judgeExisting = false;
      authorText = '';
    } else {
      const prompt =
        rnd === 1
          ? await authorInitialPrompt(ctx, kind)
          : authorFindingsPrompt(toAuthor, ctx.lastGates, `Round ${rnd}`);
      authorText = (await callAgent(ctx, author, prompt, stage)).text;
      ctx.runlog.writeText(`${rdir}/author.txt`, authorText);
    }

    // Disputes from this round are judged by this round's critic.
    let pending: Dispute[] = [];
    if (rnd > 1) {
      const disputes = parseAuthorResponse(authorText);
      pending = toAuthor
        .filter((f) => disputes.has(f.id) && !isGate(f))
        .map((f) => ({ finding: f, response: disputes.get(f.id) ?? null }));
    }

    const guard = kind === 'code' ? await testFileGuard(ctx, testsBase) : [];
    const first = guard[0];
    if (first) ctx.emit('guard', `test-file guard: coder edited tests (${first.evidence})`);
    let { gates, findings: gateF } = await stageGates(ctx, kind);
    ctx.lastGates = gates;
    const expect = kind === 'tests' ? ' (new tests should fail before implementation)' : '';
    ctx.emit('gates', `gates: ${gatesLine(gates)}${expect}`, { gates: gateStatuses(gates) });
    for (const f of gateF) ctx.emit('gates', `  blocking: ${f.claim}`);

    const diff = await ctx.workspace.diff(base, REVIEW_PATHS);
    ctx.runlog.writeText(`${rdir}/diff.patch`, diff); // exactly what the critic judges
    let verdict: Verdict;
    if (hasCritic) {
      const prompt = await criticPrompt(ctx, kind, label, diff, gates);
      const called = await callCritic(ctx, criticRole, prompt, stage);
      verdict = called.verdict;
      emitVerdict(ctx, criticRole, verdict);
      ctx.runlog.writeText(`${rdir}/critic.json`, called.raw);
    } else {
      verdict = Verdict.parse({ verdict: 'PASS' }); // no critic at this level: the gates decide
    }

    // A failing test the critic says is itself wrong goes back to the test author, once per
    // stage. The rerun gates are the ground truth: the claim alone never clears a failure.
    const defects = verdict.findings.filter((f) => f.category === 'test-defect');
    const testFailed = gates.some((g) => g.name === 'test' && !g.skipped && g.returncode !== 0);
    if (kind === 'code' && defects.length > 0 && testFailed && !testFixUsed) {
      testFixUsed = true;
      testsBase = await testFixPass(ctx, defects, gates, testsBase, rdir);
      ({ gates, findings: gateF } = await stageGates(ctx, kind));
      ctx.lastGates = gates;
      ctx.emit('gates', `gates after test fix: ${gatesLine(gates)}`, {
        gates: gateStatuses(gates),
      });
    }
    ctx.runlog.writeJson(`${rdir}/gates.json`, gates);

    // Test-defect claims are recorded, never sent to the coder (it can't edit tests).
    const criticFindings = verdict.findings.map((f) =>
      f.category === 'test-defect' ? { ...f, severity: 'minor' as const } : f,
    );
    const found = prefixIds(
      [...guard, ...gateF, ...criticFindings],
      `${kind[0]?.toUpperCase()}${rnd}-`,
    );
    minors.push(...found.filter((f) => !isBlocking(f)));
    const blocking = found.filter(isBlocking);

    // A disputed finding that the critic raises again goes straight to the arbiter.
    const reflagged = new Set(
      blocking
        .filter((f) => !isGate(f))
        .map(matchKeyString)
        .filter((k) => k !== null),
    );
    for (const d of pending) {
      const key = matchKeyString(d.finding);
      if (key !== null && reflagged.has(key)) forArbiter.push(d);
    }
    const arbiterKeys = new Set(forArbiter.map((d) => matchKeyString(d.finding)));
    toAuthor = blocking.filter((f) => isGate(f) || !arbiterKeys.has(matchKeyString(f)));

    if (toAuthor.length === 0) break;
  }

  ctx.state.rounds_used[kind] = rounds;
  if (forArbiter.length > 0 || toAuthor.length > 0) {
    const reason = toAuthor.length > 0 ? 'round cap reached' : 'disputed findings';
    const count = forArbiter.length + toAuthor.length;
    const where = hasCritic ? 'go to the arbiter' : 'are still open';
    ctx.emit('stage', `${reason}: ${count} open finding(s) ${where}`, { passed: false });
  } else {
    ctx.emit('stage', `${kind} stage passed in ${rounds} round(s)`, { passed: true });
  }
  const open = [...forArbiter, ...toAuthor.map((f): Dispute => ({ finding: f, response: null }))];
  return {
    name: kind,
    passed: open.length === 0,
    rounds,
    open_findings: open,
    minor_findings: minors,
  };
}
