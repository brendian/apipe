# 04 · Architecture

How the pieces fit together. Decisions and their reasons are in [01-TECH_DECISIONS](01-TECH_DECISIONS.md);
this document is the *shape*. Behaviour is in [02-DOMAIN_SPEC](02-DOMAIN_SPEC.md); formats in
[03-DATA_CONTRACTS](03-DATA_CONTRACTS.md).

---

## 1. Repository layout

```
apipe/                              (the project root; rename freely before M0 if desired)
├── CLAUDE.md                       agent instructions for working on THIS project
├── package.json                    npm workspaces root; scripts (§11)
├── tsconfig.base.json              strict settings shared by all packages
├── eslint.config.js  .prettierrc  vitest.config.ts   (Vitest 5 `projects`, replacing vitest.workspace.ts)
├── docs/                           this documentation (+ docs/reference/ = the Python original, read-only)
├── assets/
│   └── prompts/*.md                the nine role system prompts, VERBATIM from the original (source of truth)
├── .claude/                        COPIED unchanged from the original: agents/ + skills/adversarial-build/
├── fixtures/
│   └── sample_repo/                tiny target project for tests (copy of the original's; never modify in place)
├── packages/
│   ├── contracts/                  zod schemas, inferred types, constants, pure derivations
│   │   └── src/ { primitives.ts findings.ts runstate.ts config.ts workitem.ts events.ts ipc.ts
│   │              levels.ts statuses.ts slug.ts blocking.ts index.ts }
│   ├── engine/                     everything that isn't a window
│   │   ├── src/
│   │   │   ├── orchestrator/ { orchestrator.ts spec.ts solo.ts settle.ts decisions-apply.ts resume.ts }
│   │   │   ├── stages/       { adversarial.ts review.ts arbiter.ts guards.ts prompts.ts json.ts context.ts }
│   │   │   ├── runner/       { types.ts sdk.ts fake.ts roles.ts }
│   │   │   ├── core/         { gates.ts workspace.ts gitlock.ts runlog.ts events.ts budget.ts
│   │   │   │                  config.ts workitem.ts answers.ts decisions.ts usage.ts control.ts levels.ts }
│   │   │   ├── readmodel/    { runs.ts detail.ts context.ts items.ts live.ts render.ts next-steps.ts }
│   │   │   ├── worker.ts     the hidden worker entry (§3)
│   │   │   └── index.ts      the public API the host imports
│   │   ├── prompts/          → symlink or build-time copy of /assets/prompts (see 10-PORTING_MAP §4)
│   │   └── test/             vitest; ported from the Python suite (09-TESTING)
│   └── app/
│       ├── src/main/         Electron main: windows, IPC handlers, watchers, worker supervisor, menus, prefs
│       ├── src/preload/      the typed bridge (contextBridge) — the ONLY thing the renderer can call
│       └── src/renderer/     React UI (05-UI_SPEC)
│           ├── app/ (shell, routes, theme)   pages/ (Runs, RunDetail, NewRun, Items, ItemEditor, Help, Welcome)
│           ├── components/ (StatusChip, Timeline, RoundPanel, DiffView, FindingCard, DecisionPanel, AnswerForm,
│           │                UsageMeter, CommandBox, Markdown, ConfirmDialog, LevelSlider, …)
│           ├── state/        store + IPC subscriptions
│           └── styles/       tokens.css, base.css, components.css
├── e2e/                            Playwright (Electron) tests with a fake-agent build (09-TESTING §6)
└── scripts/                        make-screenshots, copy-prompts, check-prompts-sync
```

**Import rules (enforced by ESLint `no-restricted-imports` and by TS project references):**

| From | May import | Must not import |
|---|---|---|
| `contracts` | `zod` | anything else |
| `engine` | `contracts`, Node built-ins, `@anthropic-ai/claude-agent-sdk`, `smol-toml`, `markdown-it` | `electron`, DOM, `react`, anything in `app` |
| `app/main` | `engine`, `contracts`, `electron` | `react`, DOM |
| `app/preload` | `contracts`, `electron` (`contextBridge`, `ipcRenderer`) | `engine` |
| `app/renderer` | `contracts`, `react`, UI libs | `engine`, `electron`, Node built-ins |

The renderer cannot even *compile* an import of Node or the engine. That is the first security layer.

## 2. Components at runtime

```
┌───────────────────────────── Electron app ─────────────────────────────┐
│                                                                          │
│  RENDERER (one per window)                MAIN (one process)             │
│  ┌───────────────────────┐   IPC (typed,  ┌──────────────────────────┐  │
│  │ React UI              │◄─────────────►│ IPC handlers (zod-checked)│  │
│  │ no Node, no fs        │  invoke + push │ read models  ─┐           │  │
│  └───────────────────────┘                │ short commands│ engine API│  │
│        ▲ window.advpipe (preload)         │ file watchers │           │  │
│                                           │ worker supervisor         │  │
│                                           └─────────────┬────────────┘  │
└─────────────────────────────────────────────────────────┼───────────────┘
                              spawn (detached)            │  reads/writes files
                                      ▼                   ▼
                     ┌──────────────────────┐   ┌─────────────────────────────┐
                     │ RUN WORKER (1 per    │──►│ <repo>/.advpipe/             │
                     │ active run), Node     │   │   runs/<id>/{run.json,       │
                     │ + engine + SDK +      │   │   events.jsonl, run.lock, …} │
                     │ the bundled Claude    │   │   worktrees/<id>/            │
                     │ Code CLI as a child   │   └─────────────────────────────┘
                     └──────────────────────┘
```

- **Only files connect the worker and the host.** No sockets, no worker→host IPC. This is deliberate:
  a run must be observable and controllable by anything that can read a directory, and it must survive
  the app closing.
- A window is bound to **one repo** at creation. Handlers resolve the repo from the *sender's window*,
  never from a renderer-supplied path ([08-SECURITY](08-SECURITY.md)).

## 3. The run worker

### 3.1 What it is

`packages/engine/src/worker.ts` (body: `worker-core.ts`; tsc emits `dist/src/worker.js`; M12 bundles it), built to a single file (`worker.js`, esbuild or `tsc`), run as
`process.execPath worker.js --start <abs path to start.json>` with `ELECTRON_RUN_AS_NODE=1` (so the
Electron binary behaves as plain Node). In a packaged app `worker.js` and the SDK's native Claude
binary must be **unpacked from the asar** (see [06-AGENT_RUNNER](06-AGENT_RUNNER.md) §8).

It is the **only** process that calls the SDK and the **only** process that runs an orchestrator. It:

1. Reads and zod-validates `start.json`; refuses anything else (no other input).
2. Builds `Config` (the host already wrote the effective `config.json` for a new run), a
   `SdkAgentRunner`, and an `Orchestrator` (new, or `Orchestrator.resume`).
3. Installs `SIGINT`/`SIGTERM` handlers and a 500 ms poll for `<runDir>/cancel`; both abort an
   `AbortController` that is threaded through the runner and the gates (ADR-8).
4. `await orchestrator.run()`; exit code `0` complete, `1` any other final status, `130` interrupted.
5. Its stdout/stderr go to `<runDir>/console.log` (opened by the host, append mode). The worker
   prints a one-line summary at the end (like `_summary`) and otherwise stays quiet: the UI reads
   events, not the console.

For tests, `worker.ts` accepts an env var `ADVPIPE_FAKE_SCRIPT=<json file>` selecting a
`FakeAgentRunner` with scripted replies, which is how the Playwright and detach/cancel tests run real
processes without API calls (the Python `advpipe_fake_child.py`). This hook is compiled into the
**test build only** (a build-time flag), never into release builds.

### 3.2 Starting a run (host side)

```
startRun(window, form)                                 // after plan + confirmation checks (05-UI_SPEC §5.4)
  1. plan = planRun(repo, itemsDir, form)             // pure; errors ⇒ return them, spawn nothing
  2. runId = newRunId(); runLog = RunLog.forRun(repo, runId)
  3. write <runDir>/config.json (effective config incl. merged [pipeline])      // so the UI can show it at once
  4. write <runDir>/start.json
  5. pid = spawnWorker(startJsonPath)                  // detached, windowsHide, stdio → console.log, env ELECTRON_RUN_AS_NODE=1
  6. runLog.acquireLock(pid)                           // write the CHILD's pid now: Cancel works before it has started up
  7. return runId                                      // renderer navigates to /runs/<id>
```

Between 6 and the worker's first `run.json` write, the run page shows the **starting-up panel**
(`load_starting` in the original): lock + console tail; polled from the watcher; if the pid dies first
it shows the end of `console.log` and the exit hint. `runs:detail` must distinguish "no such run"
(directory missing) from "can't read this run" (error with the message). **Do not swallow `OSError`s
into "no such run"** (the Windows plan §2 bug).

Resume is the same with `command: 'resume'` and `locked_for_me: true` (the worker's own pid is in the
lock, written by the host; `checkResumable` must accept that).

### 3.3 Short operations run in the host, not a worker

Recording answers, recording a decision (including `takeover`/`stop`/`finish`, which do git work),
cleaning, requesting cancel and every read model run **in the main process**: they are quick, they
take the run lock briefly via `RunLog.acquireLock()` (refusing if a live worker holds it), and they
never call an agent. Anything that would resume agent work is: *record, then spawn a resume worker*.

### 3.4 The repo-wide git lock

`workspace` operations that mutate repo-level git metadata can race across workers (the Python version
avoided this only because parallel runs shared one process and one thread of git calls). Add
`<repo>/.advpipe/git.lock`:

- Acquired with `fs.open(path, 'wx')` writing `{pid, ts}`; if it exists and its pid is dead (or it's
  older than 2 minutes), steal it. Retry with backoff (50 ms → 1 s) for up to 30 s, then fail with a
  readable error.
- Held **only** around: choosing a unique branch name **and** `git worktree add` (as one critical
  section, so two runs can't pick the same `advpipe/foo`), `git worktree remove`, `git worktree prune`,
  `git branch -D`, `git branch` existence+delete in clean, and `reopen`'s `worktree add`.
- Never held across an agent call, a gate, or a commit inside a worktree.
- Additionally retry any git command that fails with `Unable to create '…lock': File exists` a few
  times (concurrent `.git/index` locks don't apply across separate worktrees, but ref locks can).

### 3.5 Cancel

`cancelRun(repo, runId)` (host): require a live lock holder that is an advpipe worker (Linux: its
`/proc/<pid>/cmdline` contains the worker path or `advpipe`; elsewhere: trust the lock), then write
`<runDir>/cancel`. The worker handles it (§3.1). The host starts a timer (default **10 s**); if the lock
is still held when it fires it ends the process tree: `taskkill /PID <pid> /T /F` on Windows,
`process.kill(-pid, 'SIGKILL')` (the process group, because the worker is `detached`) elsewhere; it then
removes the stale lock and `cancel` file and adds the note "Interrupted during <stage> (forced stop)"
(via the same `RunLog` API, under the lock). The run keeps `status: running` and is resumable.

### 3.6 App lifecycle

- **Quit with runs active:** a confirmation ("2 runs are still working. They keep going in the
  background; reopen advpipe to follow them. Quit?"). Quitting does not touch workers (they're
  detached).
- **Startup:** nothing special. Run lists compute display status from files; a `running` run with a dead
  lock shows as **stopped** with Resume.
- **Single instance:** `app.requestSingleInstanceLock()`; a second launch (e.g. `advpipe ~/code/foo`)
  asks the first instance to open that repo in a new window.
- **Windows:** one per repo; closing the last window quits (Linux/Windows) or keeps the app (macOS).
- **Crash safety:** the host holds no run state; it can be killed at any time.

## 4. The engine's public API

`packages/engine/src/index.ts` is the only thing `app/main` imports. Group by purpose; all functions
are async unless noted; all take absolute, already-validated repo paths; all throw typed errors with
**plain-words messages meant to be shown to a person** (`AnswerError`, `DecisionError`, `ControlError`,
`NotResumable`, `WorkItemError`, `ConfigError`, `ItemPathError`, `GitError`).

```ts
// ── read models (pure over files; never throw for "missing", return null/empty) ──────────────
loadRuns(repo, now?): RunList                       // rows newest first + unreadable ids
loadDetail(repo, runId): RunDetail | null           // throws on unreadable run.json (so the UI shows the message)
loadStarting(repo, runId): Starting | null
loadContext(repo, runId): ContextView               // Spec & context tab
loadItems(repo, itemsDir): ItemList
readItem(itemsDir, relPath): ItemDraft
checkDraft(repo, itemsDir, draft): DraftChecks      // inline errors/warnings for the editor
planRun(repo, itemsDir, form): RunPlan              // what "New run" would do (+ errors/warnings/summary)
tailEvents(repo, runId, offset, maxBytes?): { lines: EventLine[]; next_offset: number; ended: boolean }
loadUsage(repo): UsageView

// ── commands that run quickly in the host ─────────────────────────────────────────────────────
recordAnswers(repo, runId, answers, bypass): RunState
decide(repo, runId, choice, note?): RunState        // takeover/stop/finish act at once; others record
cancelRun(repo, runId): { pid: number }
cleanRun(repo, runId, { force, logs }): string[]
cleanInfo(repo, state): CleanInfo
saveItem / createItem / renameItem / deleteItem     // ONLY inside the items dir (ItemPathError otherwise)
newRunId(): string

// ── driving a run (used by the worker, and by tests) ──────────────────────────────────────────
class Orchestrator { constructor(config, runner, repo, workItem, opts); static resume(...); run(): Promise<RunState> }
class SdkAgentRunner / FakeAgentRunner implements AgentRunner
checkResumable(repo, runId, { lockedForMe }): RunState

// ── process control (host side) ───────────────────────────────────────────────────────────────
startWorker(runLog, startRequest): number           // spawn detached; returns pid; writes start.json and the lock
```

`app/main` also needs zero business logic of its own: a handler is *validate input → call engine →
shape result*. If a handler grows logic, the logic belongs in the engine (and gets a unit test).

## 5. The IPC contract

Defined once in `packages/contracts/src/ipc.ts` as a table of
`channel → { input: ZodSchema, output: ZodSchema }`. `main` registers handlers by iterating the table
(a handler that parses its input and the output is **generated**, not hand-written per channel);
`preload` exposes typed wrappers from the same table.

### 5.1 Invoke channels (renderer → main)

All handlers: parse `input` with zod (reject → `{ok:false, error:'…'}`), resolve the repo from the
sending window, run, parse `output`. Results are `Result<T> = {ok:true, value:T} | {ok:false, error:string}`;
**errors are values, not thrown across IPC**, and the message is safe to render (it is rendered as
text, never HTML).

| Channel | Input | Output |
|---|---|---|
| `app.prefs.get` / `app.prefs.set` | – / partial prefs | prefs |
| `app.repo.pick` | – | opens the native folder dialog **in main**; returns `{opened: path}` (renderer never sees an arbitrary path to act on) |
| `app.repo.openRecent` | `{index}` | opens that repo in a new window |
| `app.preflight` | – | `{git:{ok,version}, repo:{ok,isGit,hasCommit,branch,dirty}, claude:{ok, login:LoginKind, version}, itemsDir:{path,exists}}` |
| `runs.list` | `{show: 'all'\|'running'\|'needs_you'\|'complete'}` | `RunList` |
| `runs.detail` | `{runId}` | `RunDetail \| Starting \| null` |
| `runs.context` | `{runId}` | `ContextView` |
| `runs.log.subscribe` / `runs.log.unsubscribe` | `{runId, offset}` | `{ok}` (then pushes, §5.2) |
| `items.list` | – | `ItemList` |
| `items.read` | `{path}` | `ItemDraft` |
| `items.check` | `Draft` | `DraftChecks` (the live preview + inline errors) |
| `items.create` / `items.save` / `items.rename` / `items.delete` | per §05-UI_SPEC §6 | updated `ItemList` entry or `{error}` |
| `newrun.plan` | `RunForm` | `RunPlan` (summary shown in the dialog) |
| `newrun.start` | `RunForm & {shown: string, budget_shown: string}` | `{runId}` (refused if what was *shown* is not what is computed now) |
| `run.cancel` | `{runId}` | – |
| `run.resume` | `{runId, budget?}` | `{runId}` |
| `run.answer` | `{runId, answers, bypass, bypassAll?}` | `{runId}` (records, then spawns resume) |
| `run.decide` | `{runId, choice, note?, confirm?}` | `{runId?}`; `takeover`/`stop`/`finish` need `confirm: true` |
| `run.clean.info` / `run.clean` | `{runId}` / `{runId, force, logs, confirm:true}` | `CleanInfo` / lines |
| `run.reveal` | `{runId, what: 'worktree'\|'runDir'}` | opens in the OS file manager (`shell.showItemInFolder`) — main resolves the path from run state and checks it's under `.advpipe/` |
| `run.openLink` | `{key: 'add_usage'\|'add_credits'}` | main maps the key to one of two **constant** URLs and calls `shell.openExternal`; the renderer can never supply a URL |
| `run.copy` | – | none: copy buttons use `navigator.clipboard` in the renderer |

### 5.2 Push channels (main → renderer)

| Channel | Payload | Sent when |
|---|---|---|
| `runs.changed` | `{}` | any `run.json`/`run.lock` under `.advpipe/runs/` changed (debounced 150 ms) → the list refetches |
| `run.changed` | `{runId}` | that run's `run.json`/`report.md`/lock changed → the open detail page refetches `runs.detail` |
| `run.log` | `{runId, lines: EventLine[], next_offset, ended}` | new complete lines in `events.jsonl` for a subscribed run |
| `usage.changed` | `{}` | `usage.json` changed |
| `app.menu` | `{action}` | native menu → UI navigation (e.g. "New run", "Preferences") |

### 5.3 The preload bridge

```ts
// preload/index.ts
contextBridge.exposeInMainWorld('advpipe', buildApi(ipcRenderer, IPC_TABLE));
// renderer: window.advpipe.runs.list({show:'all'}) → Promise<Result<RunList>>
//           const off = window.advpipe.on('run.log', cb)  // returns an unsubscribe fn
```

The bridge exposes **named methods only** (generated from the table), never `ipcRenderer` itself, never
a generic `invoke(channel, …)`, never `send`. `on()` accepts only channel names from the push table.

## 6. Live updates

- **Main** keeps one watcher set **per open window** (not per run): `<repo>/.advpipe/runs` (recursive
  where the platform supports it, else a per-run-directory watcher set plus a 2 s directory scan) and
  `<repo>/.advpipe/usage.json`. Use `fs.watch` + a **polling fallback** (a 1 s stat loop over
  `run.json`/`run.lock`/`events.jsonl` of runs that are `running`), because `fs.watch` is unreliable on
  network drives, in containers and on some platforms. Coalesce bursts (150 ms trailing debounce).
- **Log tailing** (`tailEvents`): read `events.jsonl` from a byte offset; return only complete lines
  (hold back a trailing partial line); parse each as JSON; a malformed line becomes a synthetic
  `error` log line, not a crash. `next_offset` is the byte offset after the last complete line. The
  page passes the size it rendered, so nothing shows twice; a reconnect resumes exactly (same
  guarantee as the original's SSE `Last-Event-ID`).
- **`ended`**: true once a `status` event with `final: true` has been read **and** no live process holds
  `run.lock` (check once more after reading so no last line is missed).
- **Runs started elsewhere** (another window, another app instance, even the Python CLI) appear live,
  because everything is derived from files.
- The renderer refetches `runs.detail` on `run.changed` with a short delay (300 ms trailing, **not**
  throttle: throttling would drop the final refresh) and keeps `<details>` panels' open/closed state
  across refreshes (store it by panel key, not DOM identity).

## 7. Renderer state

A small store holds: current route, `RunList`, the open run's `RunDetail`, the log lines for the open
run (append-only, capped at e.g. 5 000 lines), usage, prefs, and transient UI (dialogs, form drafts).
Server-truth objects are replaced wholesale on refetch; nothing in the renderer is a source of truth for
run data. Drafts that must survive a refresh (the answer form's typed text, the decision note box)
live in the store keyed by `runId` so a background refresh never wipes what someone is typing.

## 8. Errors and logging

- Engine functions throw typed errors with person-readable messages; the IPC layer converts them to
  `{ok:false, error}`. Unexpected exceptions are logged in main (with stack) and returned as "Something
  went wrong: <message>. The details are in the log (Help → Open log folder)".
- The host logs to `<userData>/logs/main.log` (rotate at 5 MB × 3). Workers log to the run's
  `console.log`. Never log agent output at info level in the host (it can be large); the run directory
  already has it.
- A run directory the UI can't read is listed as such ("couldn't read run.json: <reason>"), never
  breaking the list.

## 9. Concurrency within the engine

- One orchestrator per process. Inside it, the only concurrency is the two reviewers in `reviewStage`
  (`Promise.allSettled`, §02 §8). Gates run sequentially.
- Gates and git use `execFile` (async). Because there is one orchestrator per worker, there is no
  concurrent git inside a process, and the repo-wide git lock (§3.4) covers cross-process hazards.
- Every `await` in the orchestrator is a cancellation point; check `abortSignal.aborted` after agent
  calls and between gates and throw a `Cancelled` error that `run()` handles (§02 §4).

## 10. Cross-platform notes

| Concern | Rule |
|---|---|
| Paths | Always `path.resolve`/`path.join`; compare with `path.relative` (not string prefixes) for "inside folder" checks; store absolute paths in `run.json` as the OS gives them |
| Pid liveness | `process.kill(pid, 0)` in try/catch: `ESRCH` → dead, `EPERM` → alive. Works on Windows in Node |
| Detached spawn | `{detached: true, windowsHide: true, stdio: ['ignore', fd, fd]}`; call `child.unref()` |
| Killing a tree | Windows `taskkill /T /F`; POSIX kill the group (`-pid`) |
| Worktree removal | `git worktree remove --force`; on Windows a process with its cwd inside the worktree blocks removal: the worker must not hold cwd there when it removes it (run git with `-C`, `cwd` = repo root) |
| Line endings | Never rewrite a user's file's line endings. Textarea CRLF → LF only for work items the editor saves (the original does the same) |
| Unicode | UTF-8 everywhere; run ids and branch names are ASCII by construction |
| `ELECTRON_RUN_AS_NODE` | Set only for the worker child; must not leak into `gates` child processes (scrub it from their env), or an Electron-based gate command would misbehave |
| Env for agents | The SDK's `env` option **replaces** the child's env: pass `{...process.env}` minus `ELECTRON_RUN_AS_NODE` |

## 11. Tooling and scripts

Root `package.json` scripts (names are the contract; CI and the docs use them):

| Script | Does |
|---|---|
| `npm run dev` | electron-vite dev server + app with devtools |
| `npm run build` | build contracts → engine (+ worker bundle) → app |
| `npm run typecheck` | `tsc -b` over all packages (strict) |
| `npm run lint` | ESLint (incl. the import rules) + Prettier check |
| `npm test` | Vitest across `contracts`, `engine`, `app` (renderer component tests with Testing Library) |
| `npm run test:e2e` | build with the fake-agent flag, then Playwright against the Electron app |
| `npm run check:prompts` | the prompts in `assets/prompts` match `.claude/agents/*.md` bodies (port of `test_subagents_in_sync_with_prompts`) |
| `npm run screenshots` | regenerate `docs/screenshots/` from a fake-agent demo repo (port of `scripts/ui_screenshots.py`) |

`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `verbatimModuleSyntax`, `moduleResolution: "bundler"`/`"NodeNext"` as the build
tool needs, project references so `tsc -b` is the single typecheck. ESM throughout (the SDK is ESM).
