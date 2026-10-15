import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LoginKind, RateLimitSnapshot } from '@advpipe/contracts';
import { Cancelled } from '../core/cancel.js';
import { detectLogin, snapshotOf } from '../core/usage.js';
import {
  UsageLimitReached,
  type AgentRequest,
  type AgentResult,
  type AgentRunner,
} from './types.js';

// The only place the engine touches the Claude Agent SDK (docs/06 §3-§7).

export type SdkRunnerOptions = {
  /** The Claude Code binary to spawn; needed in a packaged app (docs/06 §8). */
  pathToClaudeCodeExecutable?: string;
};

/** The child's environment: ours, minus anything only Electron's Node needs (docs/06 §3). */
function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env['ELECTRON_RUN_AS_NODE'];
  return env;
}

export class SdkAgentRunner implements AgentRunner {
  constructor(private readonly opts: SdkRunnerOptions = {}) {}

  buildOptions(req: AgentRequest, abort: AbortController): Options {
    return {
      systemPrompt: req.system_prompt,
      model: req.model,
      // `tools` limits which tools exist at all, so read-only roles cannot edit;
      // `allowedTools` + dontAsk pre-approves them and denies anything else (never a prompt).
      tools: req.tools,
      allowedTools: req.tools,
      permissionMode: 'dontAsk',
      cwd: req.cwd,
      maxTurns: req.max_turns,
      ...(req.max_budget_usd !== null ? { maxBudgetUsd: req.max_budget_usd } : {}),
      // Load the target repo's project settings and CLAUDE.md, not user-level config.
      settingSources: ['project'],
      abortController: abort,
      env: childEnv(),
      ...(this.opts.pathToClaudeCodeExecutable !== undefined
        ? { pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable }
        : {}),
    };
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    if (req.signal?.aborted) throw new Cancelled();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    let lastText = '';
    let result: Extract<SDKMessage, { type: 'result' }> | null = null;
    let keySource: unknown;
    const snapshots: RateLimitSnapshot[] = [];
    let rejected: RateLimitSnapshot | null = null;
    let error: string | null = null;
    try {
      // The whole stream is read even after a limit shows up: it ends within moments, and its
      // result message says what the call had cost.
      for await (const m of query({ prompt: req.prompt, options: this.buildOptions(req, abort) })) {
        if (m.type === 'system' && m.subtype === 'init') {
          keySource = m.apiKeySource;
        } else if (m.type === 'rate_limit_event') {
          const snap = snapshotOf(m.rate_limit_info);
          snapshots.push(snap);
          // Extra usage covers the overrun, so a rejected window alone isn't a block.
          if (snap.status === 'rejected' && m.rate_limit_info.overageStatus !== 'allowed') {
            rejected = snap;
          }
        } else if (m.type === 'assistant') {
          if (m.error === 'rate_limit' || m.error === 'billing_error') error = m.error;
          const texts = m.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
          if (texts.length > 0) lastText = texts.join('\n');
        } else if (m.type === 'result') {
          result = m;
        }
      }
    } catch (e) {
      // An abort makes the iterator throw (spike S4); decide by the signal, not the error's class.
      if (req.signal?.aborted) throw new Cancelled();
      throw e;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
    if (req.signal?.aborted) throw new Cancelled();

    const auth: LoginKind = detectLogin(keySource, snapshots.length > 0);
    const cost = result?.total_cost_usd ?? 0;
    const failed = result === null || result.is_error;
    const throttled = result !== null && result.is_error && apiErrorStatus(result) === 429;
    if (
      error === 'billing_error' ||
      (failed && (rejected !== null || error === 'rate_limit')) ||
      throttled
    ) {
      const billing = error === 'billing_error';
      throw new UsageLimitReached(
        billing
          ? 'Claude reported that the credit balance ran out'
          : 'Claude reported that a usage limit was reached',
        {
          billing,
          snapshot: billing ? null : rejected,
          cost_usd: cost,
          auth: billing ? 'console' : auth,
          rate_limits: snapshots,
        },
      );
    }
    if (result === null) {
      return {
        text: lastText,
        cost_usd: 0,
        is_error: true,
        num_turns: 0,
        session_id: '',
        auth,
        rate_limits: snapshots,
      };
    }
    return {
      text: 'result' in result && typeof result.result === 'string' ? result.result : lastText,
      cost_usd: cost,
      is_error: result.is_error,
      num_turns: result.num_turns,
      session_id: result.session_id,
      auth,
      rate_limits: snapshots,
    };
  }
}

function apiErrorStatus(result: object): unknown {
  return 'api_error_status' in result ? result.api_error_status : undefined;
}
