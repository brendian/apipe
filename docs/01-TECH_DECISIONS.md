# 01 · Technology decisions

Each decision is an ADR: context, decision, alternatives rejected, consequences. They were made while
writing these docs, after reading the whole Python project and checking the real SDK. **They are
this rewrite's only new decisions that the project owner has not yet signed off.** The first three
(language, shell, SDK) are the ones to confirm; everything after them follows.

Facts used below were checked on **2026-10-15** on the dev machine (Linux, Arch):

- `@anthropic-ai/claude-agent-sdk` **0.3.300** (npm `latest`), `engines.node >= 18`, peer
  dependencies `zod ^4`, `@anthropic-ai/sdk >= 0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`. Its
  `package.json` lists the Claude Code native binary per platform as `optionalDependencies`
  (`…-linux-x64`, `…-darwin-arm64`, `…-win32-x64`, and so on), so the SDK ships its own CLI.
- The `claude` CLI on the machine is **2.1.300**. Its `--help` has `--print`, `--output-format
  stream-json`, `--max-budget-usd`, `--tools`, `--permission-mode dontAsk`, `--setting-sources`,
  `--system-prompt`, but **no `--max-turns` flag**. The SDK has `maxTurns`.
- Installed: Node 26.11 / npm 12.2, Rust 1.96, Go, Bun 1.2, git 2.56. **pnpm is not installed.**

Do not copy version numbers from this file into `package.json`. Pin the then-current stable releases
at milestone M0 and record them in `docs/VERSIONS.md` (the milestone says how).

---

## ADR-1 · Language: TypeScript (strict)

**Context.** The engine is an async state machine that spawns agents, runs shell commands, drives git
and reads/writes JSON files. The UI must be a first-class citizen. Python is excluded by the
requirements.

**Decision.** TypeScript with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
on, for **both** the engine and the UI. Runtime data crossing a trust boundary (files on disk, agent
output, IPC) is parsed with **zod 4**; TypeScript types are `z.infer` of those schemas, so there is
one definition per contract ([03-DATA_CONTRACTS](03-DATA_CONTRACTS.md)).

**Why.**

- Anthropic's **TypeScript** Claude Agent SDK is the same product the Python code calls, and its
  `Options` has every field the Python runner uses (`systemPrompt`, `model`, `tools`,
  `allowedTools`, `permissionMode: 'dontAsk'`, `cwd`, `maxTurns`, `maxBudgetUsd`,
  `settingSources`, `abortController`). Details and message shapes: [06-AGENT_RUNNER](06-AGENT_RUNNER.md).
- Engine and UI share the contract types with no code generation.
- The original's heavy use of pydantic validators maps directly onto zod `.transform`/`.refine`.
- `async`/`await`, `AbortController` and `child_process` map closely onto the Python's `asyncio`,
  cancellation and subprocess use, which keeps the port mechanical.

**Rejected.**

| Alternative | Why not |
|---|---|
| **Rust + Tauri** | The attractive option on paper (small binary, strong types). But the engine would drive the `claude` CLI directly (`--output-format stream-json`) and **re-implement the SDK**: the CLI has no `--max-turns`, message/rate-limit event shapes would be hand-parsed, and every SDK improvement would be missed. A Node sidecar to get the SDK back defeats the point. Revisit only if the SDK is ever available for Rust. |
| Go + web UI | Same SDK problem as Rust, and a web UI means a server, tokens and CSRF again. |
| Kotlin / C# / Swift | Per-platform UI stacks, no official agent SDK. |
| Python + a different UI toolkit | Explicitly excluded. |

**Consequences.** The Node runtime that ships inside Electron runs the engine. Minimum language
level: whatever Electron's Node supports; do not use Bun- or Deno-specific APIs.

## ADR-2 · Shell: Electron

**Context.** "Mostly UI based" means a window people open, not a page they point a browser at.

**Decision.** An **Electron** app, built with **electron-vite**: a main process (the *host*), a
preload script (the typed bridge), and a renderer (the UI). One Electron window per repo.

**Why.** One language end to end; the Agent SDK and `git` work in the Node main/worker processes with
no extra plumbing; native menus, notifications, file dialogs and "reveal in file manager" come for
free; no localhost port means **no token, no CSRF, no Host-header check, no DNS-rebinding defence**:
the whole `ui/security.py` threat model collapses to "harden the IPC bridge" ([08-SECURITY](08-SECURITY.md)).

**Rejected.** A browser app served from localhost (reintroduces everything above); Tauri (ADR-1); a
terminal UI (violates "UI-based"); a PWA (cannot spawn processes).

**Consequences.** Larger download than Tauri. Accepted. The Electron security checklist in
[08-SECURITY](08-SECURITY.md) is mandatory, not optional.

## ADR-3 · UI toolkit: React + Vite, plain CSS tokens, Radix primitives

**Decision.**

- **React** (function components, hooks) + TypeScript in the renderer, bundled by Vite via
  electron-vite.
- **Styling:** hand-written CSS with design tokens as CSS custom properties, using
  `light-dark()` + `color-scheme` exactly as the original's `app.css` does (one list of colours, both
  themes derived). No CSS framework, no CSS-in-JS runtime.
- **Accessible primitives:** Radix UI (Dialog, Tabs, Slider, RadioGroup, Tooltip, Collapsible) for
  anything with non-trivial keyboard/ARIA behaviour. Everything else is plain HTML.
- **State:** a small store (Zustand or `useSyncExternalStore` by hand) fed by IPC pushes. **No
  server-state library** (there is no server); no Redux.
- **Markdown:** `markdown-it` with `html: false`, plus DOMPurify on the result, rendered with
  `dangerouslySetInnerHTML` in one `<Markdown>` component. Agent text is untrusted input. The
  `task.md` renderer adds the "acceptance criteria / open questions / BLOCKING" classes with a custom
  core rule, ported from `ui/render.py`.
- **Diff view:** a small in-house unified-diff renderer (line classes, line numbers, 3 000-line cap),
  ported from `ui/detail.py`. No diff library needed for parity.
- **Routing:** `react-router` in memory-history mode, or a hand-rolled route table; there is no URL
  bar, so keep it simple.

**Why.** The UI is a set of forms, lists, tabs and a live log, not a canvas. Plain CSS + a few
accessible primitives matches the original's "no build-heavy framework, readable by anyone" spirit
while using the right tool for a desktop UI.

**Rejected.** Svelte/Vue (fine, but React has the deepest accessible-primitive ecosystem and the
most agent familiarity); Tailwind/MUI (heavy and unnecessary).

## ADR-4 · Process model: one detached worker per run

**Context.** The original's most important operational property: *a run is an ordinary background
process that outlives the UI*, driven through files. Closing the window must not kill a $5 run.
The UI is a viewer and a controller over the files. (`UI_PLAN.md` §1.)

**Decision.** Three kinds of process:

1. **Main (host)**: windows, repo registry, IPC handlers, file watchers, and every *short* operation
   (record answers, record a decision, takeover/stop/finish, clean, cancel-request, read models).
2. **Renderer**: UI only. No Node access.
3. **Run worker**: one **detached** Node process per active run, started by main, that runs the
   orchestrator to the next stop. Started by `child_process.spawn(process.execPath, [workerEntry,
   …], { detached: true, stdio: [ignore, logFd, logFd], env: { ELECTRON_RUN_AS_NODE: '1', … } })`.
   It communicates **only through files** (`run.json`, `events.jsonl`, `run.lock`, `console.log`,
   `cancel`), never over a socket.

The worker entry is internal and hidden. It is the only "command line" besides `advpipe [repo]`.

**Why.** It reproduces `control.start_detached`, `run.lock`, and "runs started elsewhere show up live"
with no new invention, keeps a crashing SDK call from taking the UI down, and gives `cancel` and
`resume` the semantics the Python plans already settled. The same files the Python version wrote are
what the UI reads, so a worker could even be driven by a different front end later.

**Rejected.** Running orchestrators inside the main process (simplest, but quitting the app would stop
runs, and an SDK crash or runaway gate would freeze or kill the host). Keep it as the **documented
fallback** if detached workers prove impractical in a packaged build; the engine has no dependency on
which it is (it only needs a `RunLog` and a runner).

**Consequences.** Details in [04-ARCHITECTURE](04-ARCHITECTURE.md) §3: worker start protocol, the lock,
cancellation by file, orphan handling on app start, and the repo-wide git lock.

## ADR-5 · Repository layout: npm workspaces, UI-free engine

**Decision.** A monorepo with **npm workspaces** (pnpm isn't installed; do not add a second package
manager). Three packages:

| Package | Contents | May import |
|---|---|---|
| `packages/contracts` | zod schemas and inferred types for every file format and IPC message; level/status tables; pure helper functions that are part of the contract (`parseLevel`, `levelTag`, `maxAgentCalls`, `slugify`, …) | zod only |
| `packages/engine` | orchestrator, stages, gates, workspace (git), runlog, runner (SDK + fake), usage, decisions, answers, work items, config, control, **read models** for the UI | contracts, node built-ins, the SDK, `smol-toml` |
| `packages/app` | `main/`, `preload/`, `renderer/` | contracts, engine (main only), react … |

The engine **must not import Electron** or anything DOM. The renderer **must not import the engine**
(only `contracts`). ESLint `no-restricted-imports` enforces both. This keeps the engine runnable and
testable under plain Node and keeps the IPC surface the only coupling.

Full tree: [04-ARCHITECTURE](04-ARCHITECTURE.md) §1.

## ADR-6 · Persistence: the existing files, nothing else

**Decision.** No database, no app-level store of run data. State is `.advpipe/` inside the target
repo, in the **existing formats** ([03-DATA_CONTRACTS](03-DATA_CONTRACTS.md)). The app keeps only
per-user preferences (theme, recent repos, window bounds) in Electron's `userData` directory, as one
small JSON file.

**Why.** Files-as-truth is what makes resume, the lock, multi-process driving, and "open the Python
version's runs" work. It also means a bug in the app can never corrupt history beyond what a file
write can.

## ADR-7 · Git: the `git` binary, argument arrays

**Decision.** Call the system `git` with `execFile` (promisified), always an argv array, never a
shell string; fixed identity `-c user.name=advpipe -c user.email=advpipe@localhost`; commits use
`--no-verify`. No `isomorphic-git`/`nodegit`.

**Why.** Worktrees and `--intent-to-add` diffs are first-class in real git and poorly supported
elsewhere; matching the Python's exact commands keeps behaviour identical.

## ADR-8 · Cancellation: a file, plus an abort signal

**Decision.** `cancel` writes `.advpipe/runs/<id>/cancel`. The worker polls for it (and handles
`SIGINT`/`SIGTERM` on POSIX), and on seeing it aborts the in-flight agent call through the SDK's
`abortController`, records "Interrupted during <stage>", leaves status `running` (so it is
resumable), releases the lock and exits. If the worker has not stopped after a grace period, main
force-ends the process tree (`taskkill /T /F` on Windows, `kill -9` of the process group on POSIX).

**Why.** This is `docs/WINDOWS_PLAN.md` §1 adopted from day one, so cancellation is identical on
every OS and never orphans a Claude process.

## ADR-9 · No compatibility with the Python version (revised 2026-10-15)

**Decision.** The owner ruled that the Python `advpipe` was a proof of concept. The rewrite does **not**
need to read its run directories or be readable by it. The on-disk formats in
[03-DATA_CONTRACTS](03-DATA_CONTRACTS.md) are kept because they are already specified and tested, not
because of a promise: changing one is allowed when clearly better, but record it in 03. Reading old
`run.json` files (defaults for missing fields) is harmless but is not a goal.

The Python source remains the behavioural reference for the pipeline's *rules* (domain spec), not its files.

## ADR-10 · Platforms

Linux, macOS and Windows are all targets; develop on Linux. Cross-platform concerns are called out
where they bite (paths, pid liveness, worktree removal, signals, `ELECTRON_RUN_AS_NODE`). CI runs the
engine tests on all three before M12.

## ADR-11 · Config and front matter stay as they are

`pipeline.toml` stays TOML (parsed with `smol-toml`). Work-item front matter stays the hand-parsed
`key: value` format, strict, with file and line in errors. No YAML dependency, no JSON config.

## Open questions for the project owner

None of these block M0–M6 (the engine). Each has a recommended default, which the milestones assume.

| # | Question | Recommended default |
|---|---|---|
| 1 | Confirm Electron + TypeScript over Tauri + Rust (ADR-1/2) | Electron + TS |
| 2 | ~~Does the Python project stay alive (compatibility)?~~ | **Answered 2026-10-15: it was a POC; no compatibility needed (ADR-9)** |
| 3 | Should the app edit `pipeline.toml` (form), or only show it and offer "open in editor"? | Show + open in editor for parity (M10); form editor is backlog |
| 4 | App name / identifier for packaging | Keep `advpipe`; id `dev.advpipe.app` (changeable before M12) |
| 5 | Packaging targets for M12 | Linux AppImage + deb, macOS dmg, Windows nsis |
| 6 | May the agent implementing M0 make a **real, paid** SDK call to capture message shapes (one Basic run on the fixture, a few cents on a subscription)? | Yes, once, with explicit go-ahead, as the original's L6 did |
