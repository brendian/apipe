import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LoginKind, RateLimitSnapshot, Role } from '@advpipe/contracts';
import { Cancelled } from '../core/cancel.js';
import {
  agentResult,
  UsageLimitReached,
  type AgentRequest,
  type AgentResult,
  type AgentRunner,
} from './types.js';

// A scripted agent runner, so the orchestrator runs without API calls (docs/06 §9). Port of
// tests/fakes.py. It lives in `src` because the worker's test build uses it too (docs/04 §3.1).

type Reply = string | AgentResult;

/** A scripted step: a literal reply, or a function that may edit `req.cwd` and returns the reply. */
export type Step = Reply | ((req: AgentRequest) => Reply | Promise<Reply>);
export type Scripts = Partial<Record<Role, Step[]>>;

export class FakeAgentRunner implements AgentRunner {
  readonly scripts: Map<Role, Step[]>;
  readonly calls: AgentRequest[] = [];
  /** `[name, role]` per call, in order; share one array between runners to see an interleaving. */
  readonly events: [string, Role][];

  constructor(
    scripts: Scripts,
    readonly opts: {
      costPerCall?: number;
      name?: string;
      events?: [string, Role][];
      /** The login every plain reply says it ran under. */
      auth?: LoginKind;
    } = {},
  ) {
    this.scripts = new Map(
      Object.entries(scripts).map(([role, steps]) => [role as Role, [...steps]]),
    );
    this.events = opts.events ?? [];
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    await new Promise<void>((resolve) => setImmediate(resolve)); // so concurrent callers interleave
    this.calls.push(request);
    this.events.push([this.opts.name ?? '', request.role]);
    const step = this.scripts.get(request.role)?.shift();
    if (step === undefined) throw new Error(`unexpected call to ${request.role}`);
    const out = typeof step === 'function' ? await step(request) : step;
    if (typeof out !== 'string') return out;
    return agentResult({
      text: out,
      cost_usd: this.opts.costPerCall ?? 0.01,
      auth: this.opts.auth ?? 'unknown',
    });
  }

  callsFor(role: Role): AgentRequest[] {
    return this.calls.filter((c) => c.role === role);
  }
}

// ── builders (names kept from tests/fakes.py) ──────────────────────────────────────────────────

function writeFiles(cwd: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(cwd, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** A step that writes files (relative to the worktree) and replies with `reply`. */
export function writes(files: Record<string, string>, reply = 'done'): Step {
  return (req) => {
    writeFiles(req.cwd, files);
    return reply;
  };
}

/** A reply that also says which login it ran under and what usage Claude reported. */
export function said(
  text: string,
  opts: { auth?: LoginKind; snapshots?: RateLimitSnapshot[]; cost?: number } = {},
): AgentResult {
  return agentResult({
    text,
    cost_usd: opts.cost ?? 0.01,
    auth: opts.auth ?? 'unknown',
    rate_limits: opts.snapshots ?? [],
  });
}

export function snap(
  opts: {
    window?: string;
    status?: RateLimitSnapshot['status'];
    utilization?: number | null;
    resetsInS?: number | null;
  } = {},
): RateLimitSnapshot {
  const resetsInS = opts.resetsInS === undefined ? 3600 : opts.resetsInS;
  return {
    window: opts.window ?? 'five_hour',
    status: opts.status ?? 'allowed',
    utilization: opts.utilization === undefined ? 0.62 : opts.utilization,
    resets_at: resetsInS ? new Date(Date.now() + resetsInS * 1000).toISOString() : null,
    seen_at: new Date().toISOString(),
  };
}

/**
 * A step that writes `files` (partial work), then hits a usage limit, as the SDK runner raises it:
 * a rejected subscription window, or (`billing`) the Console balance running out.
 */
export function limitHit(
  opts: {
    window?: string | null;
    billing?: boolean;
    cost?: number;
    auth?: LoginKind;
    files?: Record<string, string>;
    resetsInS?: number;
  } = {},
): Step {
  return (req) => {
    writeFiles(req.cwd, opts.files ?? {});
    const billing = opts.billing ?? false;
    const window = opts.window === undefined ? 'five_hour' : opts.window;
    const rejected =
      window && !billing
        ? snap({ window, status: 'rejected', utilization: 1.0, resetsInS: opts.resetsInS ?? 3600 })
        : null;
    throw new UsageLimitReached('a limit was reached', {
      billing,
      snapshot: rejected,
      cost_usd: opts.cost ?? 0.02,
      auth: billing ? 'console' : (opts.auth ?? 'subscription'),
      rate_limits: rejected ? [rejected] : [],
    });
  };
}

export type FindingFields = {
  id: string;
  severity: string;
  category: string;
  file: string | null;
  line: number | null;
  criterion: string | null;
  claim: string;
  evidence: string;
};

export function finding(
  id = 'F1',
  opts: Partial<Omit<FindingFields, 'id' | 'evidence'>> = {},
): FindingFields {
  return {
    id,
    severity: opts.severity ?? 'blocking',
    category: opts.category ?? 'correctness',
    file: opts.file === undefined ? 'mathutils/core.js' : opts.file,
    line: opts.line === undefined ? 10 : opts.line,
    criterion: opts.criterion === undefined ? 'AC2' : opts.criterion,
    claim: opts.claim ?? 'something is wrong',
    evidence: 'see code',
  };
}

export const verdictPass = (...minor: FindingFields[]): string =>
  JSON.stringify({ verdict: 'PASS', findings: minor });

export const verdictFail = (...findings: FindingFields[]): string =>
  JSON.stringify({ verdict: 'FAIL', findings });

/** `authorResponse({ 'C1-F1': ['disputed', 'AC3 allows it'] })` */
export function authorResponse(actions: Record<string, [action: string, text: string]>): string {
  return JSON.stringify({
    responses: Object.entries(actions).map(([finding_id, [action, text]]) => ({
      finding_id,
      action,
      note: text,
      reason: text,
    })),
  });
}

export function rulings(decisions: Record<string, string>): string {
  return JSON.stringify({
    rulings: Object.entries(decisions).map(([finding_id, decision]) => ({
      finding_id,
      decision,
      reason: 'r',
    })),
  });
}

/** A step that simulates Ctrl-C (or a cancel) arriving while this agent runs. */
export function interrupt(): Step {
  return () => {
    throw new Cancelled();
  };
}
