# 10 · Porting map

Where each piece of the Python original goes. Paths are relative to
`docs/reference/python-original/` (the Python tree) and to `packages/` (the TS tree). **Status**
column: `☐` not started · `◐` in progress · `☑` ported and tests ported. Update it as modules land; it
is how the next session knows where things stand.

## 1. Source modules

| Python (`src/advpipe/…`) | TypeScript | Milestone | Status | Notes |
|---|---|---|---|---|
| `models.py` | `contracts/src/{primitives,findings,runstate}.ts` | M1 | ☑ | `GateResult` also lives in `runstate.ts` (M2's gates use it). pydantic validators → zod `.transform`/`.refine` (Verdict rules); keep snake_case keys |
| `config.py` | `contracts/src/config.ts` + `engine/src/core/config.ts` (TOML load) | M1 | ☑ | `extra=forbid` → `z.strictObject`; keep the raw object to know which keys were set |
| `levels.py` | `contracts/src/levels.ts` | M1 | ☑ | pure; derived text lives here so UI and report share it |
| `workitem.py` | `contracts/src/workitem.ts` (parse/format) + `engine/src/core/workitem.ts` (file IO) | M1 | ☑ | port the error text exactly (file:line) |
| `events.py` | `engine/src/core/events.ts` + `contracts/src/events.ts` | M1 | ☑ | one `emit()`; add the persisted `echo` rule from 03 §8 |
| `budget.py` | `engine/src/core/budget.ts` | M1 | ☑ | |
| `usage.py` | `engine/src/core/usage.ts` (+ constants in contracts) | M1 | ☑ | wording functions are shared with the UI via `contracts` re-exports; keep the two URL constants here |
| `gates.py` | `engine/src/core/gates.ts` | M2 | ☑ | `spawn` (argument array, own process group so a timeout kills grandchildren too) + `which.ts` for the missing-executable case; abortable via `AbortSignal` |
| `workspace.py` | `engine/src/core/workspace.ts` + `git.ts` + `gitlock.ts` | M2 | ☑ | same git commands (plus `commit.gpgsign=false`, `-z` listings so odd file names work); repo-wide git lock (04 §3.4); `slugify`/`BRANCH_PREFIX` live in `contracts` (M1) |
| `runlog.py` | `engine/src/core/runlog.ts` + `report.ts` (`renderReport`) | M1 | ☑ | temp+rename writes; lock; `renderReport` verbatim except the three command strings (02 §19). Sync fs on purpose. `listRuns` returns `{runs, unreadable}` instead of throwing on one bad run |
| `answers.py` | `engine/src/core/answers.ts` | M5 | ☐ | |
| `decisions.py` | `engine/src/core/decisions.ts` | M5 | ☐ | |
| `control.py` | `engine/src/core/control.ts` | M6 | ☐ | detach = `spawn` + lock; cancel = file; clean as-is |
| `runner.py` | `engine/src/runner/{types,roles,sdk,fake}.ts` | M3 | ☐ | 06 |
| `stages.py` | `engine/src/stages/*.ts` | M3–M4 | ☐ | split by concern (prompts, json, guards, adversarial, review, arbiter) |
| `orchestrator.py` | `engine/src/orchestrator/*.ts` | M4–M5 | ☐ | one class, split into files by stage; keep method names |
| `cli.py` | **(deleted)**; its behaviour is the host's IPC handlers + UI | M7+ | – | `_summary`/`status` text feeds the worker's end-of-run line only; `gates` command deferred |
| `__main__.py` | `engine/src/worker.ts` (hidden) | M6 | ☐ | |
| `ui/runs.py` | `engine/src/readmodel/runs.ts` | M7 | ☐ | `display_status`, `STATUSES`, `FILTERS`, `stage_label` |
| `ui/detail.py` | `engine/src/readmodel/{detail,next-steps}.ts` | M8 | ☐ | timeline, rounds, decision view, next steps (minus `advpipe …` commands) |
| `ui/context.py` | `engine/src/readmodel/context.ts` | M8 | ☐ | |
| `ui/items.py` | `engine/src/readmodel/items.ts` + `core` file ops | M9 | ☐ | `itemPath`, grouping, git states, `checkDraft`, `saveItem` (sha256 guard) |
| `ui/actions.py` | `engine/src/readmodel/plan-run.ts` + host handlers | M9–M10 | ☐ | `planRun`, `VALID`, `parseBudget`, `suggestedBudget`, `cleanInfo`; **no `call_advpipe`** |
| `ui/live.py` | `engine/src/readmodel/live.ts` (`tailEvents`) + host watcher | M7 | ☐ | SSE → push |
| `ui/render.py` | `engine/src/readmodel/render.ts` (markdown-it) + `renderer/components/Markdown` | M8 | ☐ | |
| `ui/usage_view.py` | `engine/src/readmodel/usage-view.ts` | M10 | ☐ | |
| `ui/security.py`, `ui/app.py`, `ui/state.py` | **(deleted)**; replaced by Electron hardening + IPC (08) | M7 | – | |
| `ui/routes/*.py` | `app/main/ipc/*.ts` handlers + `app/renderer/pages/*` | M7–M10 | ☐ | `help.py` → Help page built from the same tables |
| `ui/templates/*.html` | `app/renderer/components/*`, `pages/*` | M7–M11 | ☐ | each template ↔ a component; see 05 |
| `ui/static/app.css`, `theme.js`, `app.js` | `renderer/styles/*.css`, theme bootstrap in preload, small hooks | M7, M11 | ☐ | no htmx; no SSE ext |
| `prompts/*.md` | `/assets/prompts/*.md` (already copied) | M0 | ☑ | verbatim; sync test |

## 2. Tests

**M1 status:** `test_models`, `test_config_and_prompts` (config half; the prompt half is `npm run check:prompts`), `test_workitem` (parse/format/salvage; the `--item` CLI tests are N/A), `test_levels` (pure parts), `test_events` (the `emit` rules; the orchestrator-driven parts land with M4), `test_reports` (renderReport), `test_usage` (pure parts) are ported **lightly** as a few focused tests (owner's rule: keep unit tests light), in `packages/contracts/test/` and `packages/engine/test/`. Each Python file still has its orchestrator-level scenarios for later milestones.

All under `tests/` in the Python tree. TS tests live beside the module under `packages/*/test/`.
"N/A" rows are tests of HTTP/CLI plumbing that have no counterpart.

| Python test | TS counterpart | Notes |
|---|---|---|
| `test_models.py` | `contracts/test/findings.test.ts` | |
| `test_config_and_prompts.py` | `contracts/test/config.test.ts`, `scripts/check-prompts-sync` | prompts ↔ `.claude/agents` sync, critic shared-rule substrings |
| `test_workitem.py` | `contracts/test/workitem.test.ts` | |
| `test_levels.py`, `test_level_invariants.py` | `contracts/test/levels.test.ts`, `engine/test/levels.integration.test.ts`, `engine/test/invariants.test.ts` | `advpipe levels` CLI output → N/A (the slider summary is tested in `planRun`) |
| `test_gates.py` | `engine/test/gates.test.ts` | ☑ |
| `test_workspace.py` | `engine/test/workspace.test.ts` | ☑ + git-lock concurrency; slugify cases are in `contracts/test/text.test.ts` |
| `test_events.py` | `engine/test/events.test.ts` | printed-vs-event equality → "echo" rule |
| `test_stages.py`, `test_orchestrator.py` | `engine/test/stages.test.ts`, `orchestrator.test.ts` | |
| `test_tests_level.py`, `test_solo.py` | `engine/test/tests-level.test.ts`, `solo.test.ts` | |
| `test_test_defects.py` | `engine/test/test-defects.test.ts` | |
| `test_resume.py`, `test_parallel.py` | `engine/test/resume.test.ts`, `parallel.test.ts` | parallel now also in `process.test.ts` (real workers) |
| `test_answers.py`, `test_bypass.py` | `engine/test/answers.test.ts`, `bypass.test.ts` | |
| `test_answers_cli.py`, `test_cli.py` | N/A as CLI; the *behaviours* move to `app/main` handler tests and `engine` tests | exit codes N/A; refusals and messages still tested |
| `test_decisions.py` | `engine/test/decisions.test.ts` | terminal "decide now" prompt N/A |
| `test_usage.py` | `engine/test/usage.test.ts` | `advpipe usage` output N/A (UI usage view tested instead) |
| `test_reports.py` | `engine/test/reports.test.ts` | |
| `test_control.py` | `engine/test/control.test.ts`, `process.test.ts` | cancel by file; clean rules; run-id traversal |
| `test_ui.py` | `app/main/test/handlers.test.ts` + renderer tests | token/CSRF/Host tests N/A (no server) → replaced by IPC hostile-input tests |
| `test_ui_detail.py`, `test_ui_context.py` | `engine/test/readmodel-detail.test.ts`, `readmodel-context.test.ts` + renderer page tests | SSE tests → `tailEvents` + push tests |
| `test_ui_items.py` | `engine/test/items.test.ts` + renderer editor tests | path-traversal suite kept in full |
| `test_ui_actions.py` | `engine/test/plan-run.test.ts` + `handlers.test.ts` | exact subprocess argv checks → exact `start.json` contents + `spawn` args |
| `test_ui_levels.py`, `test_ui_decisions.py`, `test_ui_answers.py` | renderer page tests + `plan-run`/handler tests | |
| `test_ui_polish.py` | renderer a11y/CSS-token tests + e2e smoke | "no inline script/style", both-theme colours, focus ring present, tablet rules |
| `tests/advpipe_fake_child.py` | `engine/src/worker.ts` test build (`ADVPIPE_FAKE_SCRIPT`) | |
| `scripts/ui_screenshots.py` | `scripts/make-screenshots` (Playwright) | |

## 3. Idiom guide

| Python | TypeScript |
|---|---|
| pydantic `BaseModel`, validators | zod schemas + `.transform`/`.superRefine`; types via `z.infer` |
| `StrEnum` | `z.enum([...])` + `as const` arrays |
| `asyncio`, `await`, `asyncio.to_thread` | `async`/`await`; `execFile` promisified (no thread needed) |
| `asyncio.gather(..., return_exceptions=True)` | `Promise.allSettled` |
| `asyncio.CancelledError` (Ctrl-C / cancel) | a `Cancelled` error class thrown on abort; `run()` handles it |
| `asyncio.Semaphore` + `run_many` | not needed in the engine (one run per worker); concurrency limit lives in the host (backlog) |
| `subprocess.run([...])` | `execFile`/`spawn` with argv arrays; never `shell: true` |
| `pathlib.Path` | `node:path` + `node:fs/promises`; `path.relative` for containment |
| `tomllib` | `smol-toml` |
| `datetime.now(UTC)` | `new Date().toISOString()`; keep timestamps as strings in state |
| `secrets.token_hex(3)` | `crypto.randomBytes(3).toString('hex')` |
| `hashlib.sha256` | `crypto.createHash('sha256')` |
| `shlex.quote` | a `quoteForShell(value, shell)` helper (POSIX single-quote rule; PowerShell rule on Windows) with its own tests |
| Jinja2 template + `autoescape` | a React component; text nodes are escaped by default |
| htmx fragment + `hx-trigger="every 3s"` | a push event + refetch |
| SSE `/runs/<id>/events` | `run.log` push + `tailEvents` |
| `typer` CLI | deleted |
| `markupsafe.Markup` | the single `<Markdown>` component |
| FastAPI exception handlers rendering error pages | `Result` values + page-level error components |
| `logging` | a tiny logger in main; workers log to `console.log` |

## 4. Non-code assets (copy, never retype)

| Asset | From | To | Rule |
|---|---|---|---|
| Role prompts | `src/advpipe/prompts/*.md` | `/assets/prompts/` (done) → built into `packages/engine/prompts/` | byte-identical; a script fails the build if they differ |
| Claude Code subagents + skill | `.claude/agents/*.md`, `.claude/skills/adversarial-build/SKILL.md` | `/.claude/` (done) | unchanged; they are Claude Code configuration, not part of the app. The skill text mentions `advpipe` CLI commands (`advpipe gates` etc.); leave as is for now, and revisit when/if the backlog hook CLI exists (the *skill* runs inside Claude Code, independent of this app) |
| Sample target repo | Python `tests/fixtures/sample_repo` | `/fixtures/sample_repo` (done, rewritten in Node) | never modified in place by tests |
| `pipeline.example.toml` | root | `docs/reference/pipeline.example.toml` (done); ship a copy as the app's "example config" in Help | same keys |
| Hook example | `examples/claude-hooks.json` | `docs/reference/claude-hooks.json` | backlog |
| Screenshots | `docs/screenshots/` | `docs/reference/screenshots/` (done) | reference only; regenerate for the new app |

## 5. Things that will bite you

Collected from the original plans' "things that will bite you" sections and the code, plus new ones for
this stack. Each has bitten someone before.

**From the original:**

1. **`commits` is the resume key.** A solo run records `solo` (and maybe `review`), never
   `spec/tests/code`. Anything that assumes `'spec' ∈ commits` means "past the spec" must go through the
   level-aware helpers (`specStage`, `stepsFor`, `COMMIT_KEYS`).
2. **`Workspace.reopen` wipes uncommitted work** (`reset --hard` + `clean -fd`). After a *decision* it
   must run with `keepChanges: true`. A spec/solo revision reads the previous `task.md` from the **run
   directory**, because the worktree copy is gone. Test this explicitly or the revision silently sees no
   previous spec.
3. **`_open_workspace` clears `open_findings` on resume** — keep questions in `state.questions`, not only
   in findings.
4. **Two BLOCKING regexes** (engine and the `task.md` renderer) must accept the same prefix forms; the
   solo prompt must use the same form. Keep **one** exported pattern in `contracts`.
5. **`UsageLimitReached` can come from anywhere**: inside the concurrent reviewers (let both finish, then
   raise), inside `callJsonAgent`'s retry, inside `settle`. Catch it **only** in `Orchestrator.run`.
6. **The stream can end without a `result`** when a limit hits; that is a limit, not "no result".
7. **A retry restarts the interrupted stage at round 1 with the partial work in place**; the round cap
   starts again. Acceptable; don't try to resume mid-round.
8. **Old tests that ended a run on red gates** now stop at a `red_checks` decision (still `needs_human`).
   Assert `decision`, don't loosen the status checks.
9. **`_settle` assumes an arbiter.** Without one, rulings are still recorded (so the report and ARBITER
   panel logic hold); the timeline shows them in the step they were for.
10. **The code critic's prompt mentions test-defects and earlier rounds**; the "single review pass"
    paragraph must make clear there's one pass. The flag is **prompt text**, never a different system prompt.
11. **Bypass calls use an author role with write tools.** The prompt says don't edit; code reverts anything
    changed anyway. Don't invent a new role for it.
12. **Answers wording changes only when an agent answered.** Person-only answers keep today's text.
13. **Scanner output is free text.** Pull rule/file/line out where you can; never drop a hit because it
    didn't parse (the hit is still shown as the output tail).
14. **`clean` and dirty worktrees.** A finished-as-is run keeps uncommitted work on purpose; `clean` must
    refuse without `force` and say what would be lost.
15. **Rate-limit events are sparse** (sent on status change). "Last known, with its age", never a live gauge.
    **Login detection must not guess Console from silence.**
16. **The New run summary re-renders on every input.** Keep `levels` lookups cheap; read `usage.json` once
    per render; don't scan run directories per keystroke.
17. **Budget is unchanged by level.** No per-level budgets.
18. **Front matter is strict**; adding a key changes the error text that lists known keys.
19. **Git calls were synchronous in Python**, so parallel runs in one process never issued concurrent git.
    Workers are separate processes: the **repo-wide git lock** (04 §3.4) replaces that guarantee.
20. **Windows**: use the lock-holder helpers, never raw signals; remove worktrees with `git worktree remove`
    via `-C`/repo cwd; a `.cmd` shim on `PATH` isn't spawnable with `execFile` without `shell` — resolve
    `.cmd` explicitly or document that gate commands must be real executables.

**New for this stack:**

21. **Electron's `process.execPath` is the Electron binary.** Spawning it for the worker needs
    `ELECTRON_RUN_AS_NODE=1`, and that variable must be **scrubbed** from the children the worker spawns.
22. **The SDK's `env` option replaces** the child's environment. Forgetting `...process.env` loses `PATH`
    and `HOME` (and with them the login).
23. **`fs.watch` is lossy and platform-dependent.** Always back it with a polling fallback and treat it as
    a hint to re-read, not as the data.
24. **Don't hold DOM state as truth.** Panels are keyed; typed drafts live in the store; refetches replace
    server-truth objects wholesale.
25. **Don't `JSON.parse` agent output directly** — always `extractJson` → zod; and never trust
    `run.json` fields as paths without the gates in 08 §5.
26. **zod 4 vs the SDK's peer range:** keep one copy of zod in the tree (`npm ls zod`); duplicates cause
    confusing `instanceof` failures.
27. **ESM + Electron + Vitest** friction: pin a working combination in M0, write it down in
    `docs/VERSIONS.md`, and don't change it casually.
28. **Don't let the renderer import `engine`** "just for a type": import types from `contracts` only.
