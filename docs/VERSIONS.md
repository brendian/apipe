# Pinned versions and SDK facts

Checked **2026-10-15** on the dev machine (Linux, Arch; system Node 26.11.1, npm 12.2.0, git 2.56.0,
Python not needed). Every version is **exact** (no `^`/`~`) in the `package.json`
files. Change one deliberately, and update this file in the same change. One copy of zod:
`npm ls zod` shows `zod@4.6.7` everywhere (deduped).

## Dependencies

| Package | Version | Where | Notes |
|---|---|---|---|
| electron | 44.7.2 | app (dev) | bundles Node **24.21.0**, Chromium 152. **Workers run on Electron's Node, not the system Node**: engine code must work on Node 24 (tests run on whatever the dev machine has) |
| electron-vite | 6.0.0 | app (dev) | peer vite ^6‖^7‖^8 |
| vite | 8.3.4 | app (dev) | |
| @vitejs/plugin-react | 6.1.2 | app (dev) | peer vite ^8 |
| react / react-dom | 19.3.1 | app | |
| @types/react / @types/react-dom | 19.3.0 | app (dev) | |
| @radix-ui/react-{collapsible, dialog, radio-group, slider, tabs, tooltip} | 1.2.1 / 1.3.1 / 1.5.1 / 1.6.1 / 1.2.1 / 1.4.1 | app | installed now, first used from M7 |
| dompurify | 3.4.17 | app | used by `<Markdown>` from M8 |
| zod | 4.6.7 | contracts, engine | the SDK's peer `^4` is satisfied by the same copy |
| @anthropic-ai/claude-agent-sdk | 0.3.300 | engine | ships its own native Claude Code binary (see SDK facts) |
| @anthropic-ai/sdk | 0.134.0 | engine | SDK peer (`>=0.93.0`) |
| @modelcontextprotocol/sdk | 1.32.1 | engine | SDK peer (`^1.29.0`) |
| smol-toml | 1.9.1 | engine | `pipeline.toml` |
| markdown-it | 15.0.2 | engine | read-model rendering from M8 |
| typescript | **6.0.3** | root (dev) | **not 7.0.2 (npm `latest`)**: typescript-eslint 8.71.2 declares `typescript >=4.8.4 <6.1.0`. Move to 7 only when typescript-eslint supports it |
| typescript-eslint | 8.71.2 | root (dev) | |
| eslint / @eslint/js / globals | 10.12.0 / 10.0.1 / 17.13.0 | root (dev) | flat config (`eslint.config.js`) |
| prettier | 3.9.10 | root (dev) | |
| vitest | 5.0.4 | root (dev) | multi-package setup is `projects` in `vitest.config.ts` (Vitest 5 replaced `vitest.workspace.ts`) |
| @playwright/test | 1.64.1 | root (dev) | drives Electron via `_electron.launch`; needs a display (`DISPLAY`), no browsers to download |
| @types/node | 26.6.5 | root (dev) | |

Added in M7 (app dev dependencies, exact): jsdom 30.1.3, @testing-library/react 16.3.3, @testing-library/dom 10.4.2, @testing-library/user-event 14.6.8 (installed, not used yet), vitest-axe 0.1.0. `@advpipe/engine` is now a dependency of the app (main imports it). No state library: a hand-rolled router and a `useRemote` hook are enough (ADR-3).

Added in M9: nothing new installed. `@radix-ui/react-slider` is now in use (the New run level slider); its Slider needs `ResizeObserver`, which jsdom lacks, so the page tests define a stub.

Added in M8: @types/markdown-it 14.2.0 (engine dev; markdown-it 15 ships no types). `markdown-it` and `dompurify` are now in use.

Not installed yet (add at the milestone that needs them, then list here): electron-builder (M12).

Working combination notes (docs/10 §5 item 27): ESM everywhere (`"type": "module"`); main is emitted as
ESM `out/main/index.js`; the **sandboxed preload must be CommonJS**, so `electron.vite.config.ts` bundles
it with `externalizeDeps: false` and `entryFileNames: '[name].cjs'` (output `out/preload/index.cjs`).
The main bundle leaves workspace packages external (it `import`s `@advpipe/contracts` at runtime from
`node_modules`); **M12 must bundle or unpack them** for the packaged app. The main bundle now also imports `@advpipe/engine` (and through it the Agent SDK module, loaded but never called in the host) the same way.

## SDK facts (spikes, M0)

Spike scripts: `packages/engine/spikes/` (S1 compiled by `tsc -b`; S4 run with
`node packages/engine/spikes/s4-abort.mjs`). Real-API spikes need the owner's go-ahead each time.

| # | Result |
|---|---|
| **S1** | **Pass.** `packages/engine/spikes/s1-options.ts` builds an `Options` with every field in docs/06 §3 (`systemPrompt`, `model`, `tools`, `allowedTools`, `permissionMode: 'dontAsk'`, `cwd`, `maxTurns`, `maxBudgetUsd`, `settingSources: ['project']`, `abortController`, `pathToClaudeCodeExecutable`, `env`, `persistSession`) and narrows the §4 message fields (`system/init.apiKeySource`, `rate_limit_event.rate_limit_info.{status,resetsAt,rateLimitType,utilization,overageStatus}`, `assistant.error`, `result.{subtype,is_error,total_cost_usd,num_turns,session_id,result,api_error_status}`); `tsc -b` is clean under `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| **S2** | **Unix epoch *seconds*.** The bundled binary's own field docs say "resetsAt is unix epoch seconds" (the `.d.ts` only says `number`). So `resets_at = new Date(resetsAt * 1000)` as docs/06 §4 assumes |
| **S3** | **Pass (run 2026-10-15, owner's go-ahead; `packages/engine/spikes/s3-real-call.mjs`, one solo-role call on a copy of `fixtures/sample_repo`, $0.065, 4 turns, `claude-sonnet-5-5`).** Stream: `system/init` → `rate_limit_event` → assistant/user tool turns → final assistant text → `result` (`subtype: success`, `is_error: false`, `total_cost_usd`, `num_turns`, `session_id`, `api_error_status: null`, `permission_denials: []`). **A subscription login reports `apiKeySource: 'none'`**, so `detectLogin` reaches `subscription` only through the `rate_limit_event` fallback, as docs/06 §6 predicted (it arrived before the first model turn, `status: allowed`, `rateLimitType: five_hour`, `resetsAt` in epoch seconds, `overageStatus: rejected`). The event also carries fields we ignore: `overageDisabledReason`, `isUsingOverage`, and `unifiedWindows` (per-window `utilization`/`resetsAt`, including `seven_day`, which the runner does not snapshot: only the event's own `rateLimitType` window is kept). `utilization` is not on the top-level info here, so the `five_hour` snapshot has `utilization: null`; `describe` then says `no usage figure`. Still not run: the S6 online denial check (a read-only role trying `Bash`) |
| **S4** | **Pass (run offline).** The real SDK against a local server that accepts and never answers (empty `HOME`, dummy key: no credentials, nothing leaves the machine). The `system/init` message arrives ~150 ms in, before any model reply. Calling `abortController.abort()` at 2 s makes the **async iterator throw** `Error: Claude Code process aborted by user` (the class name is minified: **detect an abort by `signal.aborted`, not by error class or message**). It took about 2 s after `abort()` for the throw to surface (budget for it in the cancel grace period: the 10 s default is enough). **No Claude process was left behind** (checked with `pgrep` 1.5 s later). The runner translates that throw into the engine's `Cancelled` when `signal.aborted` is true |
| **S5** | **Partly done; the packaged-app half is M12.** The per-platform package `@anthropic-ai/claude-agent-sdk-linux-x64` contains one native executable, `claude` (267 MB, `chmod +x`, `--version` prints `2.1.300 (Claude Code)`). The SDK uses it by default (S4 ran without Node/Bun on the CLI path) and `pathToClaudeCodeExecutable` overrides it. Still to do in M12: confirm spawning it from `app.asar.unpacked/…` in a built Electron app, per OS |
| **S6 (offline)** | **Documented only.** From `sdk.d.ts`: `permissionMode: 'dontAsk'` = "Don't prompt for permissions, deny if not pre-approved" (denials are reported in `result.permission_denials`); `tools: string[]` = "the base set of available built-in tools" (`[]` disables all); `settingSources` must include `'project'` to load `CLAUDE.md`; omitting it loads all sources, `[]` is isolation mode; `maxTurns`/`maxBudgetUsd` bound one query (`error_max_budget_usd` result). Observed behaviour (denial of an un-pre-approved tool by a read-only role, no prompt) needs the paid call and stays **not run** with S3 |
