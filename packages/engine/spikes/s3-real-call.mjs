// Spike S3 (docs/06 §10): one real Basic-shaped call. Logs message type/subtype and the §4 fields
// only (no keys, tokens or message text; paths redacted). Usage: node s3-real-call.mjs <log-file>
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'advpipe-s3-'));
cpSync(path.join(here, '../../../fixtures/sample_repo'), dir, { recursive: true });
for (const a of [
  ['init', '-q', '-b', 'main'],
  ['add', '-A'],
  ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'baseline'],
])
  spawnSync('git', a, { cwd: dir });

const tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
const log = [];
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const it = query({
  prompt:
    'Work item: add clamp(x, lo, hi) to mathutils.\n\nThe target repository is your current working directory. Write task.md at the repository root first, then do the work, as your instructions say.\n\nTest paths: tests/.',
  options: {
    systemPrompt: readFileSync(path.join(here, '../prompts/solo.md'), 'utf-8'),
    model: 'claude-sonnet-5-5',
    tools,
    allowedTools: tools,
    permissionMode: 'dontAsk',
    cwd: dir,
    maxTurns: 25,
    maxBudgetUsd: 1.0,
    settingSources: ['project'],
    env,
  },
});
for await (const m of it) {
  const e = { type: m.type, subtype: m.subtype };
  if (m.type === 'system' && m.subtype === 'init') e.apiKeySource = m.apiKeySource;
  if (m.type === 'rate_limit_event') e.rate_limit_info = m.rate_limit_info;
  if (m.type === 'assistant') {
    e.error = m.error;
    e.blocks = m.message.content.map((b) => b.type);
  }
  if (m.type === 'result') {
    for (const k of [
      'is_error',
      'total_cost_usd',
      'num_turns',
      'session_id',
      'api_error_status',
      'permission_denials',
    ])
      e[k] = Array.isArray(m[k]) ? m[k].length : m[k];
    e.has_result_text = typeof m.result === 'string';
  }
  log.push(e);
}
const out = JSON.stringify(log, null, 2).replaceAll(dir, '<worktree>');
writeFileSync(process.argv[2], out);
console.log(`${log.length} messages; log written`);
