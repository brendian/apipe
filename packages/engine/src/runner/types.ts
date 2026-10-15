import type { LoginKind, RateLimitSnapshot, Role } from '@advpipe/contracts';

// The runner interface: the only thing the orchestrator knows about Claude (docs/06 §1).

export type { Role };

export interface AgentRequest {
  role: Role;
  /** The user prompt, built by `stages/prompts.ts`. */
  prompt: string;
  /** The role's prompt file, verbatim. */
  system_prompt: string;
  model: string;
  tools: string[];
  /** The run's worktree. */
  cwd: string;
  max_turns: number;
  /** What's left of the task budget; null = no cap. */
  max_budget_usd: number | null;
  /** Cancellation (docs/06 §7). */
  signal?: AbortSignal | undefined;
}

export interface AgentResult {
  text: string;
  cost_usd: number;
  is_error: boolean;
  num_turns: number;
  session_id: string;
  /** Which login the call ran under; `unknown` when nothing said. */
  auth: LoginKind;
  /** Every usage snapshot Claude reported during the call, in order. */
  rate_limits: RateLimitSnapshot[];
}

/** An `AgentResult` with the defaults filled in. */
export function agentResult(
  fields: Pick<AgentResult, 'text' | 'cost_usd'> & Partial<AgentResult>,
): AgentResult {
  return {
    is_error: false,
    num_turns: 0,
    session_id: '',
    auth: 'unknown',
    rate_limits: [],
    ...fields,
  };
}

/**
 * A subscription usage limit or the Console credit balance ran out during an agent call. Raised by
 * a runner, caught only in `Orchestrator.run`, which pauses the run at a `usage_limit` decision.
 * `cost_usd` is what the call had cost when it stopped.
 */
export class UsageLimitReached extends Error {
  override name = 'UsageLimitReached';
  readonly billing: boolean;
  readonly snapshot: RateLimitSnapshot | null;
  readonly cost_usd: number;
  readonly auth: LoginKind;
  readonly rate_limits: RateLimitSnapshot[];

  constructor(
    message: string,
    opts: {
      billing?: boolean;
      snapshot?: RateLimitSnapshot | null;
      cost_usd?: number;
      auth?: LoginKind;
      rate_limits?: RateLimitSnapshot[];
    } = {},
  ) {
    super(message);
    this.billing = opts.billing ?? false;
    this.snapshot = opts.snapshot ?? null;
    this.cost_usd = opts.cost_usd ?? 0;
    this.auth = opts.auth ?? 'unknown';
    this.rate_limits = opts.rate_limits ?? [];
  }
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>;
}
