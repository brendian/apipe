// Spike S1 (docs/06 §10): does the SDK's published `sdk.d.ts` compile against the `Options` mapping
// (§3) and the message fields the stream reader uses (§4) under `strict`? Never run; `tsc -b` is
// the whole experiment. Safe to delete once the real runner (M3) compiles the same things.
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export function options(signal: AbortController): Options {
  return {
    systemPrompt: 'role prompt',
    model: 'claude-sonnet-5-5',
    tools: ['Read', 'Glob', 'Grep'],
    allowedTools: ['Read', 'Glob', 'Grep'],
    permissionMode: 'dontAsk',
    cwd: '/tmp/worktree',
    maxTurns: 40,
    maxBudgetUsd: 1.5,
    settingSources: ['project'],
    abortController: signal,
    pathToClaudeCodeExecutable: '/path/to/claude',
    env: { PATH: process.env['PATH'] ?? '' },
    persistSession: true,
  };
}

export async function readStream(prompt: string, o: Options): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const m of query({ prompt, options: o }) as AsyncIterable<SDKMessage>) {
    if (m.type === 'system' && m.subtype === 'init') seen.push(m.apiKeySource);
    else if (m.type === 'rate_limit_event') {
      const i = m.rate_limit_info;
      seen.push(i.status, i.resetsAt, i.rateLimitType, i.utilization, i.overageStatus);
    } else if (m.type === 'assistant') {
      seen.push(m.error);
      for (const b of m.message.content) if (b.type === 'text') seen.push(b.text);
    } else if (m.type === 'result') {
      seen.push(m.subtype, m.is_error, m.total_cost_usd, m.num_turns, m.session_id);
      if (m.subtype === 'success') seen.push(m.result);
      if ('api_error_status' in m) seen.push(m.api_error_status);
    }
  }
  return seen;
}
