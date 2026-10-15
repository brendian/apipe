# 06 · The agent runner (Claude Agent SDK integration)

The runner is the only place the engine touches Claude. The orchestrator depends on a three-line
interface; everything SDK-specific lives in `packages/engine/src/runner/sdk.ts`. This document
specifies the interface, the SDK mapping, how limits and logins are detected, and the **spikes** that
must be run before trusting this document's SDK details.

Verified against `@anthropic-ai/claude-agent-sdk` **0.3.300** (its published `sdk.d.ts`, read on
2026-10-15). Items marked **⚠ spike** were *not* verified by running the SDK and must be confirmed in
milestone M0. Python reference: `docs/reference/python-original/src/advpipe/runner.py` and `usage.py`.

---

## 1. The interface

```ts
// packages/engine/src/runner/types.ts
export type Role = 'spec-writer'|'test-author'|'test-critic'|'coder'|'code-critic'
                 |'standards-reviewer'|'security-reviewer'|'arbiter'|'solo';

export interface AgentRequest {
  role: Role;
  prompt: string;              // the user prompt (built by stages/prompts.ts)
  system_prompt: string;       // the role's prompt file, verbatim
  model: string;               // from config.models[ROLE_MODEL[role]]
  tools: string[];             // ROLE_TOOLS[role]
  cwd: string;                 // the run's worktree
  max_turns: number;           // config.limits.max_turns_per_agent
  max_budget_usd: number | null;   // what's left of the task budget
  signal?: AbortSignal;        // cancellation (§7)
}

export interface AgentResult {
  text: string;
  cost_usd: number;
  is_error: boolean;                       // default false
  num_turns: number;                       // default 0
  session_id: string;                      // default ''
  auth: LoginKind;                         // default 'unknown'
  rate_limits: RateLimitSnapshot[];        // every one seen during the call, in order; default []
}

export class UsageLimitReached extends Error {
  billing: boolean; snapshot: RateLimitSnapshot | null; cost_usd: number;
  auth: LoginKind; rate_limits: RateLimitSnapshot[];
}

export interface AgentRunner { run(request: AgentRequest): Promise<AgentResult>; }
```

`buildRequest(role, prompt, config, cwd, remainingBudget)` = the above, with `system_prompt =
loadPrompt(role)` (the file `prompts/<role>.md`, read once and cached), `model =
config.models[ROLE_MODEL[role]]`, `tools = [...ROLE_TOOLS[role]]`, `max_turns =
config.limits.max_turns_per_agent`, `max_budget_usd = remaining`.

## 2. Role table (port of `runner.ROLE_TOOLS`, `ROLE_MODEL`)

```ts
const READ_ONLY = ['Read','Glob','Grep'];
const WRITER    = ['Read','Glob','Grep','Edit','Write','Bash'];
ROLE_TOOLS = { 'spec-writer': ['Read','Glob','Grep','Write'], 'test-author': WRITER, 'test-critic': READ_ONLY,
               coder: WRITER, 'code-critic': READ_ONLY, 'standards-reviewer': READ_ONLY,
               'security-reviewer': READ_ONLY, arbiter: READ_ONLY, solo: WRITER };
ROLE_MODEL = { 'spec-writer':'author', 'test-author':'author', coder:'author', solo:'author',
               'test-critic':'critic', 'code-critic':'critic', 'standards-reviewer':'critic',
               'security-reviewer':'critic', arbiter:'arbiter' };
```

## 3. Mapping a request to SDK options (verified against `sdk.d.ts`)

`query({ prompt, options })` is the entry point (`export declare function query(params: {prompt: string
| AsyncIterable<SDKUserMessage>, options?: Options}): Query`; `Query` is an async iterable of
`SDKMessage`).

| Python `ClaudeAgentOptions` | TS `Options` | Notes |
|---|---|---|
| `system_prompt=str` | `systemPrompt: string` | Replaces Claude Code's default system prompt with the role prompt. (`systemPrompt` also accepts `string[]`, `{type:'custom'}`, `{type:'preset', preset:'claude_code', append}`.) |
| `model` | `model` | |
| `tools=list` | `tools: string[]` | **Limits which tools exist at all**, so read-only roles *cannot* edit. (`[]` disables all built-ins; `{type:'preset', preset:'claude_code'}` is the default set.) Doc note: native builds may provide search via Bash `find`/`grep` instead of dedicated Grep/Glob unless listed here or in `allowedTools` — they are listed, so fine. |
| `allowed_tools=list` | `allowedTools: string[]` | Pre-approves them |
| `permission_mode="dontAsk"` | `permissionMode: 'dontAsk'` | `PermissionMode = 'default'\|'acceptEdits'\|'bypassPermissions'\|'plan'\|'dontAsk'\|'auto'`. Anything not pre-approved is denied; a run **never stalls on a prompt** |
| `cwd` | `cwd` | the worktree |
| `max_turns` | `maxTurns` | |
| `max_budget_usd` | `maxBudgetUsd` | a per-call cap = what's left of the task budget |
| `setting_sources=["project"]` | `settingSources: ['project']` | `SettingSource = 'user'\|'project'\|'local'`. Loads the **target repo's** `CLAUDE.md` and project settings, **not** the user's global config |
| – | `abortController` | cancellation (§7) |
| – | `pathToClaudeCodeExecutable` | needed in a packaged app (§8) |
| – | `env` | **replaces** the child's environment entirely; pass `{...process.env}` minus `ELECTRON_RUN_AS_NODE` (and any other Electron-only vars) |
| – | `persistSession` | default is to persist transcripts under `~/.claude/projects/…`. Keep the default for parity (useful for debugging); revisit if the clutter is a complaint |

The peer dependency `zod ^4` is satisfied by the app's own zod 4. `@anthropic-ai/sdk >= 0.93` and
`@modelcontextprotocol/sdk ^1.29` are also peers: install them at the versions npm resolves (M0).

## 4. Reading the stream

Port of `SdkAgentRunner.run`: iterate the `Query` to the **end** (don't stop early at a limit: the
stream ends within moments and its `result` message says what the call cost). Message shapes
(`sdk.d.ts`, 0.3.300):

| Message | Fields used |
|---|---|
| `{type:'system', subtype:'init', apiKeySource, claude_code_version, cwd, tools, …}` | **`apiKeySource`** (`'ANTHROPIC_API_KEY' \| 'apiKeyHelper' \| '/login managed key' \| 'none' \| 'user' \| 'project' \| 'org' \| 'temporary' \| 'oauth'`) |
| `{type:'assistant', message: BetaMessage, error?: SDKAssistantMessageError, …}` | text blocks in `message.content` (`type:'text'`); **`error`** ∈ `'authentication_failed' \| 'oauth_org_not_allowed' \| 'account_on_hold' \| 'verification_required' \| 'billing_error' \| 'rate_limit' \| 'overloaded' \| 'invalid_request' \| 'model_not_found' \| 'server_error' \| 'unknown' \| 'max_output_tokens' \| 'cloud_credential_error'` |
| `{type:'rate_limit_event', rate_limit_info: SDKRateLimitInfo}` | `status` (`allowed\|allowed_warning\|rejected`), `resetsAt?: number`, `rateLimitType?` (`five_hour\|seven_day\|seven_day_opus\|seven_day_sonnet\|seven_day_overage_included\|overage`), `utilization?: number`, `overageStatus?` and other overage fields. "Rate limit information for **claude.ai subscription users**." |
| `{type:'result', subtype, is_error, total_cost_usd, num_turns, session_id, result?, api_error_status?, …}` | `subtype`: `'success'` or `'error_during_execution'\|'error_max_turns'\|'error_max_budget_usd'\|'error_max_structured_output_retries'`; **`total_cost_usd`** is cumulative for the `query()` call ("an estimate, not a billing statement"); `result` text on success; `api_error_status` on errors |

Everything else (`SDKToolProgressMessage`, hooks, tasks, partial messages, …) is ignored.

```ts
async run(req): AgentResult {
  let lastText = '', result = null, keySource = undefined, snapshots = [], rejected = null, error = null;
  for await (const m of query({ prompt: req.prompt, options: buildOptions(req) })) {
    if (m.type==='system' && m.subtype==='init')            keySource = m.apiKeySource;
    else if (m.type==='rate_limit_event') { const s = snapshotOf(m.rate_limit_info); snapshots.push(s);
        if (s.status==='rejected' && m.rate_limit_info.overageStatus !== 'allowed') rejected = s; }
    else if (m.type==='assistant') { if (m.error==='rate_limit'||m.error==='billing_error') error = m.error;
        const texts = m.message.content.filter(b => b.type==='text').map(b=>b.text); if (texts.length) lastText = texts.join('\n'); }
    else if (m.type==='result') result = m;
  }
  const auth   = detectLogin(keySource, snapshots.length>0);
  const cost   = result ? (result.total_cost_usd ?? 0) : 0;
  const failed = !result || result.is_error;
  const throttled = !!result && result.is_error && result.api_error_status === 429;
  if (error==='billing_error' || (failed && (rejected || error==='rate_limit')) || throttled) {
    const billing = error==='billing_error';
    throw new UsageLimitReached(billing ? 'Claude reported that the credit balance ran out'
                                        : 'Claude reported that a usage limit was reached',
      { billing, snapshot: billing ? null : rejected, cost_usd: cost, auth: billing ? 'console' : auth, rate_limits: snapshots });
  }
  if (!result) return { text: lastText, cost_usd: 0, is_error: true, num_turns: 0, session_id: '', auth, rate_limits: snapshots };
  return { text: result.result ?? lastText, cost_usd: cost, is_error: result.is_error, num_turns: result.num_turns,
           session_id: result.session_id, auth, rate_limits: snapshots };
}
```

Two points copied deliberately from the Python:

- **A `rejected` event only counts as a limit if `overageStatus !== 'allowed'`** (extra usage covers
  the overrun, so the call isn't actually blocked) — and only **together with** a failed result or a
  `rate_limit` assistant error. A rejected snapshot alone never pauses a run that finished fine.
- **The stream may end without a `result` message when a limit hits.** That must raise
  `UsageLimitReached`, **not** a generic "no result" error.

`snapshotOf(info, now)`: `window = rateLimitType ?? 'five_hour'`; `status` = info.status if one of the three
else `allowed`; `utilization = info.utilization ?? null`; `resets_at = typeof resetsAt === 'number' ?
ISO(resetsAt * 1000) : null` (**spike S2 confirmed: `resetsAt` is Unix epoch *seconds***, as the Python
`datetime.fromtimestamp(int)` assumes; see `docs/VERSIONS.md`); `seen_at = now`. **Never store the raw event** — only these fields.

An `is_error` result that is *not* a limit is returned as `AgentResult{is_error: true}` (`agent_done`
logs "[agent reported an error]"); the stages carry on (a critic's empty/unparseable reply becomes the
"critic output unparseable" blocking finding; an author's empty reply just means nothing was disputed).
Do **not** invent new retry behaviour.

## 5. Why `maxBudgetUsd` and `maxTurns` matter here

They bound a *single* call. `error_max_turns` / `error_max_budget_usd` results come back as
`is_error` results with whatever text exists; the orchestrator's own `Budget` then raises
`BudgetExceeded` once the **sum** crosses the limit (rule 5). Both must be passed every call; neither
is available as a CLI flag in `claude 2.1.300` (`--max-turns` doesn't exist) — one reason ADR-1 chose
the SDK.

## 6. Login detection (`detectLogin`)

```ts
const CONSOLE_KEY_SOURCES      = new Set(['ANTHROPIC_API_KEY','apiKeyHelper','/login managed key','user','project','org']);
const SUBSCRIPTION_KEY_SOURCES = new Set(['oauth']);
function detectLogin(apiKeySource: unknown, sawRateLimitEvent: boolean, env = process.env): LoginKind {
  if (typeof apiKeySource === 'string') {
    if (CONSOLE_KEY_SOURCES.has(apiKeySource)) return 'console';
    if (SUBSCRIPTION_KEY_SOURCES.has(apiKeySource)) return 'subscription';
  }
  if (sawRateLimitEvent) return 'subscription';          // rate-limit events apply to claude.ai subscription logins
  if (env.ANTHROPIC_API_KEY) return 'console';
  return 'unknown';                                      // SILENCE NEVER MEANS CONSOLE
}
```

**What the TS SDK's own docs say about `apiKeySource` (0.3.300):** `'ANTHROPIC_API_KEY'` (env),
`'apiKeyHelper'`, `'/login managed key'` (a Console account's key created by `/login`) are API-key
sources; **`'none'` means "no API key in use — e.g. claude.ai OAuth login, a bearer token, or a
third-party cloud provider"**; `'user' | 'project' | 'org' | 'temporary' | 'oauth'` are **legacy
members that current CLIs never emit**. Consequences:

- A real subscription login will most likely show `apiKeySource: 'none'` — which tells us it is **not
  an API key** but not that it *is* a subscription (could be Bedrock/Vertex/a bearer token). The
  fallback "a rate-limit event arrived ⇒ subscription" is therefore the working signal, and `unknown`
  is correct until one arrives. **Spike S3 (run): a subscription login sends `apiKeySource: 'none'` plus a `rate_limit_event`**, so the fallback is the working signal (`docs/VERSIONS.md`).
- Don't change the detection order. Do consider treating `'none'` + no `ANTHROPIC_API_KEY` env as "not
  Console" for the *warning* (i.e. don't warn), which the order above already does (it returns
  `unknown` and `unknown` never warns).

The detected `auth` is stored per call in `AgentResult.auth`, merged into `RunState.auth` (only when not
`unknown`), written to `.advpipe/usage.json`, and drives the Console warning and cost labels
(`02 §14`, `05 §5.2.3`). It never changes budget logic.

## 7. Cancellation

`AgentRequest.signal` ↔ `Options.abortController`: the worker creates one `AbortController` per
process; each call passes a controller linked to it (`new AbortController()` whose `abort()` is called
when the worker's signal fires). When aborted mid-call the SDK stops the child Claude process. **Spike S4
(done, offline)**: on abort the async iterator **throws** (`Error: Claude Code process aborted by user`,
class name minified) about 2 s after `abort()`, and the child process is gone afterwards (no orphan). So the
runner **catches any throw while `signal.aborted` is true and rethrows the engine's `Cancelled`** (decide by the
signal, not by the error's class or text), never `UsageLimitReached` or a plain `is_error` result. `callAgent` also checks the signal before and after every call (the engine's `throwIfCancelled`), and the gates take the same signal.

## 8. Packaging the SDK

The SDK's native Claude Code binary comes from a per-platform `optionalDependency`
(`@anthropic-ai/claude-agent-sdk-<os>-<arch>[-musl]`); npm installs only the one for the build machine.
For a **packaged** app:

- Build per target OS/arch (CI matrix) so the right optional dependency is present, or install the
  others explicitly with `npm install --os=… --cpu=…` when cross-building.
- The binary must be **outside the asar** (an executable inside an asar can't be spawned): configure
  `asarUnpack` for `node_modules/**` (the binary, and every runtime dependency: the worker runs from
  `app.asar.unpacked` and resolves its imports from `app.asar.unpacked/node_modules`), and pass
  `pathToClaudeCodeExecutable` resolved against `process.resourcesPath` + `app.asar.unpacked/…`.
  **Spike S5 (done for Linux x64 in M12; macOS/Windows by CI)**: the platform package holds one native executable named `claude`
  (`@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude`; `.exe` on Windows) and the SDK uses it with no Node/Bun
  on its path; M12 proved the spawn from `app.asar.unpacked` in a packaged Linux build (`findClaudeBinary` returns the unpacked path and the worker passes it as `pathToClaudeCodeExecutable`). Original note:
  find the correct file inside the optional package and confirm the SDK doesn't need
  Node/Bun on `PATH` (`Options.executable?: 'bun'|'deno'|'node'` suggests a JS CLI path exists; the
  native optional packages should make it unnecessary).
- macOS: the binary must be code-signed/notarised with the app; Windows: whitelisting by AV is the
  user's concern — document it.
- The worker runs the SDK; the host does not. Only `worker.js` and its deps need to be reachable
  outside the asar.

## 9. `FakeAgentRunner` (port of `tests/fakes.py`)

Scripts per role, consumed in order; each step is a literal reply, an `AgentResult`, or a function
`(req) => string | AgentResult` that may write files under `req.cwd` and may **throw
`UsageLimitReached`**. An exhausted role throws an assertion error ("unexpected call to <role>") so a
test that triggers an extra agent call fails loudly. It records every `AgentRequest` (so tests assert on
what each agent saw), awaits a microtask/`setImmediate` on every call (so concurrent reviewers really
interleave) and supports `cost_per_call` (default 0.01) and a default login. Builders to port:
`writes(files, reply='done')`, `said(text, {auth, snapshots, cost})`, `limitHit({window, billing, cost,
auth, files, resetsInS})`, `snap(...)`, `finding(...)`, `verdictPass(...minor)`, `verdictFail(...findings)`,
`authorResponse({id: [action, text]})`, `rulings({id: decision})`, and the sample content `TASK_MD`,
`TASK_MD_BLOCKING`, and the `sample_repo` helpers. The worker's test-build `ADVPIPE_FAKE_SCRIPT` hook
(04 §3.1) deserialises a JSON script into one of these (steps limited to literals and `writes`).

## 10. Spikes (milestone M0): confirm before building on them

Each spike has a **pass condition** and **where to record the result** (`docs/VERSIONS.md`, §"SDK
facts"). S1 and S6 need no paid call.

| # | Question | How | Pass |
|---|---|---|---|
| S1 | Does `sdk.d.ts` 0.3.300 compile against the `Options` fields in §3 under `strict`? | A 20-line TS file that builds an `Options` and calls `query` without running it | `tsc` is clean |
| S2 | Is `rate_limit_info.resetsAt` Unix seconds or milliseconds? | Read the SDK source/docs; confirm in S3's output if a window event arrives | documented |
| S3 | What does a real call emit: `apiKeySource` for a subscription login, whether `rate_limit_event` arrives at all, the exact `result` fields | **With the owner's explicit go-ahead** (a few cents): one **Basic**-shaped call against a copy of `fixtures/sample_repo` ("add `clamp(x, lo, hi)`"), logging every message's `type`/`subtype` and the fields above to a file (never keys/tokens; redact paths) | the facts written into 06 §6 and `docs/VERSIONS.md` |
| S4 | What does abort do (throw vs end), and is the child process gone? | Start a call, abort after 2 s, check `ps` | the runner's abort translation is specified |
| S5 | Which file in the platform package is the executable, and does a spawn from an asar-unpacked path work in a packaged build? | Build a minimal Electron app that runs S3 from `app.asar.unpacked` | works on the dev OS; recorded for CI |
| S6 | Does `maxTurns`/`maxBudgetUsd`/`settingSources`/`tools`/`permissionMode: 'dontAsk'` do what the Python docs say (denies un-pre-approved tools without prompting)? | Part of S3 with a prompt that tries to use `Bash` as a read-only role | the denial is observed, and no prompt is shown |

If a spike contradicts this document, **fix the document in the same commit** and note it in the
milestone summary.
