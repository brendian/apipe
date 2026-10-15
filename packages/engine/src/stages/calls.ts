import {
  AuthorResponse,
  Finding,
  Verdict,
  blockingOf,
  consoleWarning,
  describe as describeSnapshot,
  disputed,
  minorOf,
  SCHEMA_NAMES,
  windowLabel,
  type FindingResponse,
  type LoginKind,
  type RateLimitSnapshot,
  type Role,
} from '@advpipe/contracts';
import type { z } from 'zod';
import { throwIfCancelled } from '../core/cancel.js';
import { tail } from '../core/gates.js';
import { mergeSnapshots, recordUsage } from '../core/usage.js';
import { buildRequest } from '../runner/roles.js';
import { UsageLimitReached, type AgentResult } from '../runner/types.js';
import type { Context } from './context.js';

// Calling agents: one call with its events, budget and usage notes; JSON replies with one retry.

/** Roles whose next call after *Try again* carries the cut-off note. */
export const CUT_OFF_ROLES: ReadonlySet<Role> = new Set<Role>([
  'spec-writer',
  'test-author',
  'coder',
  'solo',
]);
export const CUT_OFF_NOTE =
  'A previous attempt at this step was cut off by a usage limit; the worktree has its partial ' +
  'changes; carry on from them.';

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Record what a call revealed about the login and the usage windows: in run.json, in the repo's
 * usage cache, as `usage` events, and as notes for a Console login or a window near its limit.
 * Nothing here changes the budget logic.
 */
function noteUsage(ctx: Context, auth: LoginKind, snapshots: readonly RateLimitSnapshot[]): void {
  const state = ctx.state;
  if (auth === 'console' && state.auth !== 'console') {
    const warning = consoleWarning(ctx.config.limits.budget_usd_per_task);
    state.notes.push(capitalise(warning.replace(/^Warning: /, '')));
    ctx.emit('usage', warning, { login: 'console' }, !ctx.consoleWarned);
    ctx.consoleWarned = true;
  }
  if (auth !== 'unknown') state.auth = auth;
  for (const snap of snapshots) {
    mergeSnapshots(state.rate_limits, [snap]);
    let text = describeSnapshot(snap);
    if (snap.status === 'allowed_warning') {
      text = `approaching the ${windowLabel(snap.window)} limit (${text.split(': ').slice(1).join(': ')})`;
      state.notes.push(capitalise(text));
    }
    ctx.emit('usage', text, {
      window: snap.window,
      status: snap.status,
      utilization: snap.utilization,
      resets_at: snap.resets_at,
    });
  }
  recordUsage(ctx.workspace.repo, auth, snapshots);
}

const seconds = (since: number): string => ((performance.now() - since) / 1000).toFixed(0);

/** One agent call: events, budget, usage notes, the cut-off note, and the limit handling. */
export async function callAgent(
  ctx: Context,
  role: Role,
  prompt: string,
  stage: string,
): Promise<AgentResult> {
  throwIfCancelled(ctx.signal);
  if (ctx.cutOff && CUT_OFF_ROLES.has(role)) {
    prompt = `${CUT_OFF_NOTE}\n\n${prompt}`;
    ctx.cutOff = false;
  }
  const request = buildRequest(
    role,
    prompt,
    ctx.config,
    ctx.workspace.path,
    ctx.budget.remaining,
    ctx.signal,
  );
  ctx.emit('agent_start', `${role} working (${request.model})...`, { role });
  const started = performance.now();
  let result: AgentResult;
  try {
    result = await ctx.runner.run(request);
  } catch (e) {
    if (!(e instanceof UsageLimitReached)) throw e;
    // A limit, not a bug: what the call cost still counts, then the run pauses (the
    // orchestrator asks the person what to do).
    try {
      noteUsage(ctx, e.auth, e.rate_limits);
      ctx.budget.add(e.cost_usd, stage);
    } finally {
      ctx.save();
      ctx.emit(
        'agent_done',
        `${role} stopped by a usage limit after ${seconds(started)}s, $${e.cost_usd.toFixed(2)} ` +
          `(run total $${ctx.budget.spent.toFixed(2)})`,
        {
          role,
          cost_usd: e.cost_usd,
          total_usd: ctx.budget.spent,
          is_error: true,
        },
      );
    }
    throw e;
  }
  noteUsage(ctx, result.auth, result.rate_limits);
  try {
    ctx.budget.add(result.cost_usd, stage);
  } finally {
    ctx.save();
    const error = result.is_error ? ' [agent reported an error]' : '';
    ctx.emit(
      'agent_done',
      `${role} done in ${seconds(started)}s, $${result.cost_usd.toFixed(2)} ` +
        `(run total $${ctx.budget.spent.toFixed(2)})${error}`,
      { role, cost_usd: result.cost_usd, total_usd: ctx.budget.spent, is_error: result.is_error },
    );
  }
  throwIfCancelled(ctx.signal);
  return result;
}

export function emitVerdict(ctx: Context, role: Role, verdict: Verdict): void {
  const blocking = blockingOf(verdict).length;
  const minor = minorOf(verdict).length;
  ctx.emit('verdict', `${role}: ${verdict.verdict} (${blocking} blocking, ${minor} minor)`, {
    role,
    verdict: verdict.verdict,
    blocking,
    minor,
  });
}

// ── agent output → JSON ─────────────────────────────────────────────────────────────────────────

/** Pull a JSON object out of agent output that may be wrapped in prose or code fences. */
export function extractJson(text: string): string {
  const stripped = text.trim();
  if (stripped.startsWith('{')) return stripped;
  const fences = [...stripped.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const last = fences.at(-1);
  if (last?.[1] !== undefined) return last[1].trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) return stripped.slice(start, end + 1);
  return stripped;
}

export class ParseError extends Error {
  override name = 'ParseError';
}

/** Parse agent output into `schema`. Throws `ParseError` with a readable message. */
export function parseModel<M>(text: string, schema: z.ZodType<M, unknown>): M {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (e) {
    throw new ParseError(`invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ParseError(
      parsed.error.issues
        .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

/** Run an agent expecting JSON. Retry once with the parse error; `parsed` is null on a 2nd failure. */
export async function callJsonAgent<M>(
  ctx: Context,
  role: Role,
  prompt: string,
  stage: string,
  schema: z.ZodType<M, unknown>,
  schemaName: string,
): Promise<{ parsed: M | null; raw: string }> {
  const first = await callAgent(ctx, role, prompt, stage);
  try {
    return { parsed: parseModel(first.text, schema), raw: first.text };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    const retry =
      `${prompt}\n\n---\nYour previous reply could not be parsed:\n${e.message}\n\n` +
      `Your previous reply was:\n${first.text.slice(-2000)}\n\n` +
      `Reply again with JSON only, matching the ${schemaName} schema.`;
    const second = await callAgent(ctx, role, retry, stage);
    try {
      return { parsed: parseModel(second.text, schema), raw: second.text };
    } catch (e2) {
      if (!(e2 instanceof ParseError)) throw e2;
      return { parsed: null, raw: second.text };
    }
  }
}

/** A critic's verdict. A critic that can't produce one twice is a blocking finding, never a PASS. */
export async function callCritic(
  ctx: Context,
  role: Role,
  prompt: string,
  stage: string,
): Promise<{ verdict: Verdict; raw: string }> {
  const { parsed, raw } = await callJsonAgent(
    ctx,
    role,
    prompt,
    stage,
    Verdict,
    SCHEMA_NAMES.verdict,
  );
  const verdict: Verdict =
    parsed ??
    Verdict.parse({
      verdict: 'FAIL',
      findings: [
        {
          id: 'P1',
          severity: 'blocking',
          category: 'correctness',
          criterion: `${role}:output`,
          claim: 'critic output unparseable',
          evidence: tail(raw),
        },
      ],
    });
  ctx.state.noise_dropped += verdict.noise.length;
  return { verdict, raw };
}

/** Authors' replies are parsed leniently: unparseable means nothing was disputed. */
export function parseAuthorResponse(text: string): Map<string, FindingResponse> {
  try {
    return disputed(parseModel(text, AuthorResponse));
  } catch (e) {
    if (e instanceof ParseError) return new Map();
    throw e;
  }
}

/** A finding as it is written into prompts and files (every field, in schema order). */
export const dumpFinding = (f: Finding): Finding => Finding.parse(f);
