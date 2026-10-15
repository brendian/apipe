import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isBlocking,
  scanOn,
  gateSummary,
  type Dispute,
  type Finding,
  type GateResult,
  type StageResult,
  type Verdict,
} from '@advpipe/contracts';
import { gateStatuses } from '../core/events.js';
import { gatesLine, runGate } from '../core/gates.js';
import { UsageLimitReached } from '../runner/types.js';
import { callCritic, emitVerdict } from './calls.js';
import type { Context } from './context.js';
import { prefixIds } from './guards.js';
import { criticPrompt, NO_STANDARDS_DOC, REVIEW_PATHS, reviewerPrompts } from './prompts.js';

// The review stages: standards + security reviewers (full), or one code-critic pass (single).

export const SCAN_OFF = 'turned off for this run';

function reviewResult(found: Finding[]): StageResult {
  const blocking: Dispute[] = found.filter(isBlocking).map((f) => ({ finding: f, response: null }));
  return {
    name: 'review',
    passed: blocking.length === 0,
    rounds: 1,
    open_findings: blocking,
    minor_findings: found.filter((f) => !isBlocking(f)),
  };
}

/** Standards and security reviewers, in parallel, one pass each. */
export async function reviewStage(ctx: Context): Promise<StageResult> {
  const command = ctx.config.gates.security;
  const scanner: GateResult = scanOn(ctx.state)
    ? await runGate(
        'security',
        command,
        ctx.workspace.path,
        ctx.config.limits.gate_timeout_s,
        ctx.signal,
      )
    : {
        name: 'security',
        command,
        returncode: null,
        output: '',
        skipped: true,
        skip_reason: SCAN_OFF,
      };
  ctx.emit('gates', `security scanner: ${gatesLine([scanner])}`, {
    gates: gateStatuses([scanner]),
  });
  if (scanner.skipped) {
    ctx.state.notes.push(
      `Security scanner not run (${scanner.skip_reason}); security review used the diff alone.`,
    );
  }
  ctx.runlog.writeJson('review/scanner.json', scanner);

  const diff = await ctx.workspace.diff(ctx.state.base_commit, REVIEW_PATHS);
  ctx.runlog.writeText('review/diff.patch', diff); // exactly what both reviewers judge
  const docFile = path.join(ctx.workspace.path, ctx.config.paths.standards_doc);
  const doc = existsSync(docFile) ? readFileSync(docFile, 'utf-8') : NO_STANDARDS_DOC;
  const prompts = reviewerPrompts(ctx, diff, doc, gateSummary(scanner));

  // Both reviewers run to the end before anything is raised, so a usage limit in one never
  // leaves the other running in the background (its cost still counts).
  const both = await Promise.allSettled([
    callCritic(ctx, 'standards-reviewer', prompts.standards, 'review'),
    callCritic(ctx, 'security-reviewer', prompts.security, 'review'),
  ]);
  const failures = both.flatMap((o) => (o.status === 'rejected' ? [o.reason as unknown] : []));
  const limit = failures.find((e) => e instanceof UsageLimitReached);
  if (limit !== undefined) throw limit;
  if (failures.length > 0) throw failures[0];
  const [std, sec] = both.map(
    (o) => (o as PromiseFulfilledResult<{ verdict: Verdict; raw: string }>).value,
  ) as [{ verdict: Verdict; raw: string }, { verdict: Verdict; raw: string }];
  emitVerdict(ctx, 'standards-reviewer', std.verdict);
  emitVerdict(ctx, 'security-reviewer', sec.verdict);
  ctx.runlog.writeText('review/standards.json', std.raw);
  ctx.runlog.writeText('review/security.json', sec.raw);

  ctx.state.rounds_used['review'] = 1;
  return reviewResult([
    ...prefixIds(std.verdict.findings, 'STD-'),
    ...prefixIds(sec.verdict.findings, 'SEC-'),
  ]);
}

/**
 * One code-critic pass over the whole change, no back-and-forth (levels without critics). A
 * test-defect finding is an ordinary finding here: there's no test-fix pass to send it to.
 */
export async function singleReviewStage(ctx: Context): Promise<StageResult> {
  const diff = await ctx.workspace.diff(ctx.state.base_commit, REVIEW_PATHS);
  ctx.runlog.writeText('review/diff.patch', diff); // exactly what the critic judges
  const prompt = await criticPrompt(ctx, 'code', 'Full diff', diff, ctx.lastGates, {
    single: true,
  });
  const { verdict, raw } = await callCritic(ctx, 'code-critic', prompt, 'review');
  emitVerdict(ctx, 'code-critic', verdict);
  ctx.runlog.writeText('review/single.json', raw);
  ctx.state.rounds_used['review'] = 1;
  return reviewResult(prefixIds(verdict.findings, 'REV-'));
}
