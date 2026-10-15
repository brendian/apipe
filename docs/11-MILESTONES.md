# 11 · Milestones

The build order. Each milestone is sized for **one agent session**, ends green, and leaves the project
in a state the next session can start from without asking anything. This mirrors how the Python
project was built (`UI_PLAN.md` U0–U6, `ANSWERS_PLAN.md` A0–A2, `LEVELS_PLAN.md` L0–L6) and uses the
same working agreements.

```
M0 foundations + spikes ─► M1 contracts+core ─► M2 git+gates ─► M3 runner+stages ─► M4 orchestrator I
        ─► M5 orchestrator II ─► M6 workers+control ─► M7 app shell+runs list ─► M8 run detail
        ─► M9 new run + work items ─► M10 actions ─► M11 polish+e2e ─► M12 package+verify
```

**M1–M6 are the engine and need no window at all; they are testable under plain Node.** The engine is
done and trusted *before* any UI exists. Do not start M7 until M6 is green.

## How to start a session

> Read `CLAUDE.md`, then `docs/11-MILESTONES.md` (this file) and the docs it lists for **M<n>**. Implement
> milestone **M<n>** only. Follow the project rules and the security checklist. Stop at the end of the
> milestone and summarise: what you built, how you verified it, what you could not check, any place the
> docs and the Python original disagreed (and which you followed), and any doc you changed.

## Working agreements (every milestone)

- **Source of truth order:** the Python source > these docs > your judgement. If the Python source and a
  doc disagree, follow the Python, then **fix the doc in the same commit** and say so.
- **Don't redesign.** If you think a rule is wrong, write the question under "Questions for the owner" in
  your summary; build what the docs say.
- **Tests are ported, not invented.** Read the matching Python test file first ([10-PORTING_MAP](10-PORTING_MAP.md) §2).
- **No API calls in tests.** Real-API steps only where a milestone says so, with the owner's go-ahead.
- **Definition of done (all milestones):** `npm run typecheck`, `npm run lint`, `npm test` green (and
  `npm run test:e2e` from M7); no `any` without a justification comment; no `// @ts-ignore`; the
  porting-map status column updated; `docs/VERSIONS.md` updated if a dependency changed; docs changed if
  behaviour changed; a commit (when the owner has asked for commits; otherwise leave the tree clean and
  say so).
- **Security checklist** ([08-SECURITY](08-SECURITY.md) §8) from M7 on, for every IPC channel/path/process.
- **User-visible strings are ported verbatim** from the Python (statuses, explanations, errors, report
  text) unless a doc names an exception.

---

## M0 · Foundations and spikes  ✔ done 2026-10-15 (S3 run later, 2026-10-15, with the owner's go-ahead; S6-online not run: run before M12)

**Read:** 01, 04 §1/§11, 06 §10, 09 §3, 10 §4.

**Build**

1. Initialise the npm-workspaces monorepo exactly as 04 §1 (empty packages with `package.json`,
   `tsconfig`, a placeholder test each). Strict TS settings, ESLint (with the import-boundary
   `no-restricted-imports` rules and `no-eval`/`no-implied-eval`/`child_process` shell rule), Prettier,
   Vitest workspace. `git init` is the owner's call; do not initialise a repo unless asked.
2. **Pin versions.** Install the then-current stable Electron, electron-vite, React, Vite, Vitest,
   Playwright, zod 4, `smol-toml`, `markdown-it`, DOMPurify, Radix, `@anthropic-ai/claude-agent-sdk` and
   its peers. Write `docs/VERSIONS.md`: each dependency, exact version, date checked, and a "SDK facts"
   section (empty, filled by the spikes). Make sure `npm ls zod` shows **one** zod.
3. `scripts/check-prompts-sync` (and `npm run check:prompts`): `assets/prompts/<role>.md` equals the body of
   `.claude/agents/<role>.md` (split on the first two `---\n`), frontmatter has `name: <role>`.
4. Make `packages/engine/prompts/` appear from `assets/prompts/` (build-time copy script; byte-identical;
   fails the build on mismatch).
5. **Electron hello-world** that proves the stack: a window loading the React renderer, a typed preload
   bridge with one channel (`app.ping`), the CSP in place, a Playwright test that launches it and clicks a
   button. **No product code.**
6. **Spikes S1, S2, S4, S5, S6-offline** from 06 §10 (those that need no paid call). S1 = compile the
   `Options` mapping under `strict`. Record findings in `docs/VERSIONS.md`.
7. **Spike S3 (+S6 online) only with the owner's explicit go-ahead.** If not given, record "not run" and
   continue; M12 must run it before release. When run: one Basic-shaped call against a copy of
   `fixtures/sample_repo`; log message `type`/`subtype` and the fields in 06 §4 to a file (redact paths,
   never write keys); update 06 §6.
8. ~~Golden run directories~~ dropped: no Python compatibility needed (ADR-9).

**Done when:** the checks above are green; the hello-world app launches under Playwright; spikes are
recorded; `docs/VERSIONS.md` exists; nothing in the repo contains product logic yet.

## M1 · Contracts and core data  ✔ done 2026-10-15

**Read:** 02 §2/§4/§13/§16/§17/§18, 03 (all), 07 §10; Python `models.py config.py levels.py workitem.py
events.py budget.py usage.py runlog.py`; tests `test_models, test_config_and_prompts, test_workitem,
test_levels (pure parts), test_events, test_reports, test_usage (pure parts)`.

**Build:** every schema in 03 with its defaults; `Verdict` rule enforcement; `matchKey`/`isGrounded`;
`levels` (all derived functions and the `LEVEL_INFO`/safeguards text); `parseLevel`; `slugify`;
`blockingOpenQuestions` + the single shared BLOCKING pattern; `normalise`; `Config` (strict) + TOML loader
+ raw-keys-set tracking; work-item parse/format/salvage (error text with file:line);
`events.emit` (append + flush; `echo`/`final` rules); `Budget`; `usage` helpers (wording, `describe`,
staleness, `formatReset`, `detectLogin`, `snapshotOf`, `limitExplanation`, `consoleWarning`, `costLabel`,
`UsageCache` read/record); `RunLog` (atomic writes, lock with liveness, `checkRunId`, `readState`,
`writeState` incl. `decisions/N.json`, `listRuns`) and `renderReport` (port verbatim, with the two
sanctioned command-string changes).

**Tests:** ports of the files above; `renderReport` tests against the Python source's wording;
Windows-safe lock tests.

**Done when:** a run written by the engine loads back through the schemas and its report renders as the ported text.

## M2 · Git and gates  ✔ done 2026-10-15

**Read:** 02 §9–§10, §15 (branch naming, clean), 04 §3.4; `gates.py workspace.py`; `test_gates,
test_workspace`.

**Build:** `Workspace` (create/reopen/remove/hasChanges/head/commit/commitPaths/diff/changedFiles/restore;
`execFile` git with the fixed identity; `.git/info/exclude`; diff truncation 60 000), `uniqueBranch`,
`branchExists`, `unmergedCommits`; the repo-wide **git lock** and its use around branch+worktree
creation/removal; gates (`runGate(s)`, tail, optional gate, exit 127/124, `gateFinding(s)`,
`redGateFindings`, `gatesLine`, `formatGates`); a `which` helper.

**Tests:** real temp repos from `makeTargetRepo`; restore of new files; intent-to-add diffs; reopen with and
without `keepChanges` and with a deleted worktree; `slugify` cases; unique-branch suffixes; **N parallel
creations pick distinct branches** (the lock); gate cases including timeout and a missing tool. **Start the
Windows CI job here.**

## M3 · Runner and stages  ✔ done 2026-10-15 (S3 real call run afterwards: the stream matches what `SdkAgentRunner` reads)

**Read:** 02 §3, §7–§10, §12; 06 (all); 07 (all); `runner.py stages.py`; `test_stages, test_test_defects`.

**Build:** `AgentRunner`, roles/tools/models tables, `buildRequest`, `SdkAgentRunner` (06 §4, with the
S3/S4 results applied), `FakeAgentRunner` and all builders, `Context`, `callAgent` (events, budget,
usage notes, limit handling, cut-off note), `extractJson`/`parseModel`/`callJsonAgent`/`callCritic`/
`parseAuthorResponse`, every prompt builder (07), `testFileGuard`, `checkedFindings` (scan policy),
`stageGates`, `adversarialStage` (incl. `testFixPass`), `reviewStage`, `singleReviewStage`, `arbiterStage`,
`finalAuthorPass`, `blockingOpenQuestions` use. *(`bypassQuestions` itself moved to M5: it needs `answers.ts`'s limits.)*

**Tests:** prompts contain exactly what 07 says and nothing from the author's reply in critic prompts;
every guard; disputes/arbiter routing; JSON retry; the usage-limit raise from inside concurrent
reviewers; ids with round prefixes.

## M4 · Orchestrator I (levels 3–5)

**Read:** 02 §4–§5.0, §7–§9, §13, §15; `orchestrator.py`; `test_orchestrator, test_resume, test_tests_level,
test_levels (orchestrator parts)`.

**Build:** `Orchestrator` (`run`, `_run`, `_open_workspace`, `_enter`, `_stop`, `_stage`, `_settle`,
`resume` + `checkResumable` + `checkSameShape`, `newRunId`), SPEC (first pass only for now, blocking
questions **stop** the run), TESTS, CODE, REVIEW (full and single), ARBITER, FINAL_GATES, budget stop,
`report.md` every time, status/stage transitions, per-stage commits, worktree removal, `keepWorktree`.
Levels Tests, Adversarial and Full. `askRed` may stub to a plain `needs_human` with open findings until M5.

**Tests:** the §4 scenarios in 09 that concern levels 3–5; `maxAgentCalls` worst case for those levels;
resume at every stage boundary; interrupted run resumes.

## M5 · Orchestrator II: questions, solo levels, decisions, usage

**Read:** 02 §5–§6, §11, §14; `answers.py decisions.py` + the solo/decision/bypass/usage parts of
`orchestrator.py`; `test_answers, test_bypass, test_solo, test_decisions, test_usage, test_level_invariants`.

**Build:** `answers.ts` (everything in 02 §5.1 incl. `migrate`, files parsing is **not** needed), `bypass`,
`questionStop`, `beginSpec`, revisions; the SOLO stage and Reviewer flow; **decision points** (`ask`,
`askRed`, `decide`, `take`, `pendingChoice`, `applyRetry`, `applyScanChoice`, `personFix`, `soloFix`,
takeover/stop/finish); scan policy; `askUsage` and usage-limit handling; `Workspace.reopen(keepChanges)`
wiring; resume rules for decisions and answers.

**Tests:** all of 09 §4's questions/bypass/decisions/usage lists; the 18 invariants parametrised over five
levels; `maxAgentCalls` for Basic and Reviewer.

**Done when:** the whole Python orchestrator-level suite has TS counterparts (porting map statuses ☑ for
everything except CLI/UI rows) and the decision/answers/usage scenarios produce loadable run directories and reports.

## M6 · Worker processes and control

**Read:** 04 §3, 02 §15; `control.py`; `test_control`, `advpipe_fake_child.py`, `WINDOWS_PLAN.md`.

**Build:** `worker.ts` (+ test-build fake script hook with `hold`), `startWorker`, `start.json`, lock
written with the child pid, cancel file + abort wiring + grace-period force kill, `cleanRun`, `cleanInfo`,
`recordAnswers`/`decide` as host-side functions with the lock, orphan/stale-lock handling, exit codes.
The worker prints the one-line summary (`_summary` text without the CLI-only hints).

**Tests:** all of 09 §6 with real child processes on the current OS.

**Done when:** from a Node test you can start a fake-agent run in a detached worker, cancel it, resume it,
answer its questions, decide at its stops, and clean up — **with no UI**. This is the engine's acceptance
test.

## M7 · App shell and runs list

**Read:** 04 §2/§5/§6/§7, 05 §1–§5.1/§6, 08 (all).

**Build:** Electron main (windows per repo, single-instance, menus, preferences, recent repos), preload
bridge generated from the IPC table, `createHandlers(deps)` with zod in/out and the sender checks,
`readmodel/runs.ts` (+ `displayStatus`, `STATUSES`, `FILTERS`), file watchers with polling fallback,
`tailEvents`, the renderer shell (top bar, routes, theme bootstrap before first paint, tokens, base
components), **Welcome/preflight** and the **Runs list** (live), the starting-up panel plumbing.

**Tests:** handler tests (09 §7) for the channels added; `displayStatus` table tests; Testing Library page
tests with axe; first e2e (open repo → empty list → start a **scripted** run via a test-only channel or
direct engine call → it appears live).

## M8 · Run detail

**Read:** 05 §5.2–§5.3, 02 §4 (timeline semantics); `ui/detail.py context.py render.py`; `test_ui_detail,
test_ui_context`.

**Build:** `readmodel/{detail,context,next-steps,render}.ts`; renderer: header, cost/usage meters, timeline,
round panels, `DiffView`, `FindingCard`, `GateList`, `Markdown`/`TaskMd`, the live log (subscribe/unsubscribe,
offsets), report, next steps with `CommandBox` + quoting helper, Spec & context tab, starting-up and error
states, panel-state persistence.

**Tests:** read-model tests for every status × level; hostile-string battery on every text surface; live-update test (events appended while the page is open); e2e: watch a run complete.

## M9 · New run and work items

**Read:** 05 §5.4–§5.7, 02 §16; `ui/actions.py (plan_run) items.py`; `test_ui_actions (plan), test_ui_items,
test_ui_levels`.

**Build:** `planRun` and `newrun.plan/start` with the `shown` handshake; New run page with the slider and
live summary; work-items list, editor (front-matter fields, preview, inline checks, stale-write guard,
byte-exact round trip), create/rename/delete with confirmation pages; items-dir preference; git states.

**Tests:** full traversal suite; round trips; `planRun` for every precedence combination and error;
exact `start.json` contents per choice; refusal when what was shown differs; e2e scenario 7.

## M10 · Actions and the "needs you" flows

**Read:** 05 §5.2.2–§5.2.5, §5.7, §7, §5.9; 02 §11/§14; `ui/routes/actions.py`, `test_ui_decisions,
test_ui_answers, test_ui_actions (actions)`.

**Build:** Cancel, Resume (budget form), Clean up (info + confirmation + bulk panel), the **answer form**,
the **decision panel** for all four kinds, confirmation pages for takeover/stop/finish, the paused/finished/
handed-over/ended states, usage line and meters, Console-credits warnings, `run.openLink`, `run.reveal`,
desktop notifications and badge, the `VALID` matrix enforced in the host.

**Tests:** 09 §8 behaviours; e2e scenarios 2–6; an action that is no longer valid is refused with the
reload message; destructive actions refused without `confirm`.

## M11 · Polish, help and the e2e suite

**Read:** 05 §4, §5.8, §9; 09 §8–§9.

**Build:** Help page from the code's tables (with its coverage test), empty/error states checklist,
keyboard shortcuts, responsive 768 px, reduced motion, theme persistence, focus management, About, log
folder, `npm run screenshots`, the complete Playwright suite (09 §9), CSP/console cleanliness checks.

**Done when:** axe is clean on every page in both themes; the e2e suite passes on Linux under xvfb.

## M12 · Packaging and real verification

**Build:** electron-builder config for Linux (AppImage + deb), macOS (dmg), Windows (nsis); `asarUnpack`
for the SDK's native binary and `worker.js`; launch smoke test of the **packaged** app (S5 for real);
CI matrix; README.md at the repo root (install, first run, screenshots, safety, FAQ — adapt from the
original README); update `docs/VERSIONS.md`.

**Real checks (owner's go-ahead):** one Basic and one Tests run with a real login (09 §10). Report what
was and wasn't checked.

**Done when:** a person can download the installer, open a repo, and run a Basic run without touching a
terminal.

---

## M13+ · Backlog (not parity; do after M12, in any order the owner picks)

- **Run several work items at once** (`--from-file`/`--parallel` equivalent): select items → *Run N items*
  with *At most K at once*; a host-side queue (in-memory) that starts workers as slots free; queued runs
  shown in a strip.
- **`pipeline.toml` form editor** (models, limits, gates, paths, pipeline) with validation and a
  comment-loss warning.
- **Hook CLI**: the optional `advpipe gates --only types,lint` for the Claude Code `PostToolUse` hook
  (`docs/reference/claude-hooks.json`). The only CLI the project would ever ship; keep it a few lines on
  top of `runGates`.
- Diff syntax highlighting; "pause after spec" to edit `task.md` before tests; "typical cost at this level
  in this repo" (median of this repo's complete runs, shown at ≥ 3).
- Auto-update; crash reporting that never uploads (owner decision).
- Re-port the Claude Code skill to mention the app where relevant.
