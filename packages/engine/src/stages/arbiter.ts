import {
  ArbiterRuling,
  isGate,
  SCHEMA_NAMES,
  type Dispute,
  type Finding,
  type Ruling,
} from '@advpipe/contracts';
import { gateStatuses } from '../core/events.js';
import { gatesLine } from '../core/gates.js';
import type { Role } from '../runner/types.js';
import { callAgent, callJsonAgent } from './calls.js';
import type { Context } from './context.js';
import { stageGates, testFileGuard } from './guards.js';
import {
  ARBITER_NOTE,
  arbiterPrompt,
  authorFindingsPrompt,
  REVIEW_PATHS,
  type StageKind,
} from './prompts.js';

/** Rule fix/dismiss on each open finding. Failed gates are always `fix`, without debate. */
export async function arbiterStage(
  ctx: Context,
  disputes: Dispute[],
  label: string,
): Promise<Ruling[]> {
  const rulings: Ruling[] = disputes
    .filter((d) => isGate(d.finding))
    .map((d) => ({
      finding_id: d.finding.id,
      decision: 'fix' as const,
      reason: 'failed gate is ground truth',
    }));
  const toRule = disputes.filter((d) => !isGate(d.finding));
  if (toRule.length > 0) {
    const diff = await ctx.workspace.diff(ctx.state.base_commit, REVIEW_PATHS);
    const { parsed, raw } = await callJsonAgent(
      ctx,
      'arbiter',
      arbiterPrompt(ctx, toRule, diff),
      'arbiter',
      ArbiterRuling,
      SCHEMA_NAMES.arbiter,
    );
    ctx.runlog.writeText(`arbiter-${label}.json`, raw);
    const byId = new Map((parsed?.rulings ?? []).map((r) => [r.finding_id, r]));
    if (parsed === null) {
      ctx.state.notes.push(`Arbiter output unparseable (${label}); all findings ruled fix.`);
    }
    for (const d of toRule) {
      rulings.push(
        byId.get(d.finding.id) ?? {
          finding_id: d.finding.id,
          decision: 'fix',
          reason: 'no ruling given; defaulting to fix',
        },
      );
    }
  }
  for (const r of rulings) {
    ctx.emit('ruling', `  ${r.finding_id}: ${r.decision} (${r.reason})`, {
      finding_id: r.finding_id,
      decision: r.decision,
    });
  }
  return rulings;
}

/**
 * One last author pass on `fix` rulings; no critic. Returns findings still failing. `stage` is
 * what the call is charged to; `extra` is added to the prompt (a person's note) and `rdir` is the
 * run-directory folder for the pass's files.
 */
export async function finalAuthorPass(
  ctx: Context,
  author: Role,
  findings: Finding[],
  kind: StageKind,
  opts: { note?: string; stage?: string; extra?: string; rdir?: string; prompt?: string } = {},
): Promise<Finding[]> {
  const rdir = opts.rdir || `final-pass-${kind}`;
  const prompt =
    opts.prompt ??
    authorFindingsPrompt(findings, ctx.lastGates, opts.note ?? ARBITER_NOTE) + (opts.extra ?? '');
  const result = await callAgent(ctx, author, prompt, opts.stage ?? 'arbiter');
  ctx.runlog.writeText(`${rdir}/author.txt`, result.text);
  const guard = kind === 'code' ? await testFileGuard(ctx, ctx.testsCommit) : [];
  const { gates, findings: gateF } = await stageGates(ctx, kind);
  ctx.lastGates = gates;
  ctx.emit('gates', `gates after final pass: ${gatesLine(gates)}`, { gates: gateStatuses(gates) });
  ctx.runlog.writeJson(`${rdir}/gates.json`, gates);
  return [...guard, ...gateF];
}
