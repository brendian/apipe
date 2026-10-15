// Spike S4 (docs/06 §10), offline version: what does `query()` do when its AbortController fires
// mid-call, and is the child Claude process gone afterwards?
// The "API" is a local HTTP server that accepts and never answers; HOME is an empty temp dir and
// the key is a dummy, so no credentials exist and nothing leaves this machine.
// Run: node packages/engine/spikes/s4-abort.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const claudeProcs = () => {
  try {
    return execFileSync('pgrep', ['-f', 'claude-agent-sdk-linux-x64/claude'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
};

const hits = [];
const server = createServer((req) => hits.push(`${req.method} ${req.url}`)); // never responds
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const before = claudeProcs();
const ac = new AbortController();
const cwd = mkdtempSync(join(tmpdir(), 's4-cwd-'));
const env = {
  PATH: process.env.PATH ?? '',
  HOME: mkdtempSync(join(tmpdir(), 's4-home-')),
  ANTHROPIC_API_KEY: 'dummy-key-not-real',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

const log = [];
const t0 = Date.now();
setTimeout(() => {
  log.push(`abort() at ${Date.now() - t0}ms`);
  ac.abort();
}, 2000);

let outcome = 'iterator ended normally';
try {
  const q = query({
    prompt: 'say hi',
    options: {
      abortController: ac,
      cwd,
      env,
      tools: ['Read'],
      permissionMode: 'dontAsk',
      maxTurns: 1,
      model: 'claude-sonnet-5-5',
      persistSession: false,
    },
  });
  for await (const m of q) {
    log.push(
      `${Date.now() - t0}ms message type=${m.type}${m.subtype ? ` subtype=${m.subtype}` : ''}${m.apiKeySource ? ` apiKeySource=${m.apiKeySource}` : ''}`,
    );
  }
} catch (e) {
  outcome = `threw ${e?.constructor?.name}: ${String(e?.message).slice(0, 160)}`;
}
const endedAt = Date.now() - t0;
await sleep(1500);
const after = claudeProcs().filter((p) => !before.includes(p));
server.close();
console.log(
  JSON.stringify(
    {
      outcome,
      endedAtMs: endedAt,
      log,
      requestsSeenByFakeServer: hits.length,
      claudeProcessesLeftAfter1500ms: after,
    },
    null,
    2,
  ),
);
process.exit(0);
