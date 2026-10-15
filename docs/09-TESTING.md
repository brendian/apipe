# 09 · Testing strategy

The Python project has ~10 700 lines of tests that pin down the pipeline's behaviour (the *spec by
example*). **Porting those tests is the primary way this rewrite proves parity.** Read the Python
tests as you port each module; they encode decisions no prose captured.

## 1. Rules

1. **No API calls in automated tests. Ever.** Agents are `FakeAgentRunner`s. A test that would spend
   money is a manual check (§9), runs only with the owner's explicit go-ahead, and is never in CI.
2. **Real git, real processes, real files.** Tests that touch git use a real temporary repo; tests
   about detach/cancel/lock start a real child process. Mock only the SDK and the clock.
3. **Test the contract, not the implementation.** Assert on files written, events emitted, prompts the
   fake agent *received*, statuses, and the exact argument lists of spawned processes.
4. **Every invariant in [02-DOMAIN_SPEC](02-DOMAIN_SPEC.md) §18 is a parametrised test across all five levels.**
5. **Every milestone ends green:** `npm run typecheck && npm run lint && npm test` (and `test:e2e` from M8).
6. **A bug found later gets a failing test first.**

## 2. Layers

| Layer | Package | Runner | Notes |
|---|---|---|---|
| Schemas and pure functions | `contracts` | Vitest | Verdict rules, `matchKey`, `parseLevel`, `levelTag`, `droppedSafeguards`, `maxAgentCalls`, `slugify`, `blockingOpenQuestions`, regex agreement |
| Core modules | `engine` | Vitest | config, workitem, answers, decisions (pure parts), gates, workspace (real git), runlog, budget, usage, control |
| Orchestrator scenarios | `engine` | Vitest + `FakeAgentRunner` + real git + a real (Node) gate | the heart: §4 |
| Process tests | `engine` | Vitest + `worker.ts` test build | detach, cancel, resume, lock, orphan handling: §6 |
| Read models | `engine` | Vitest over run directories produced by the orchestrator and by hand | §5 |
| IPC handlers | `app/main` | Vitest | `createHandlers(deps)` called directly; no Electron needed: §7 |
| Renderer | `app/renderer` | Vitest + jsdom + Testing Library + axe | components and pages against a mocked `window.advpipe`: §8 |
| End to end | `e2e/` | Playwright (Electron) with the **test build** of the app | real windows, real worker processes, fake agents: §9 |
| Security | spread | the above | hostile inputs per [08-SECURITY](08-SECURITY.md) §8 |

## 3. Fixtures and helpers

**The target repo.** `fixtures/sample_repo/` is a tiny **Node** project (`mathutils` with `safeDiv` and
`mean`, tests in `tests/core.test.js`, gate `node --test`). It replaces the Python original's Python
fixture so contributors don't need Python or pytest. **Never modify it in place:** helpers copy it.

```ts
// packages/engine/test/helpers/repo.ts
makeTargetRepo(): Promise<string>        // copy fixtures/sample_repo to a mkdtemp dir, `git init -b main`, add, commit "baseline"
testConfig(overrides?): Config           // gates: test = [process.execPath, '--test'], types = [], lint = [], security = [];
                                         // limits.budget_usd_per_task = 5.0
git(cwd, ...args): string                // fixed identity t / t@t
scrubEnv()                               // delete ANTHROPIC_API_KEY (a developer's key must not trigger the Console warning)
```

(The Python `conftest.py` is the model. Use `process.execPath`, not `"node"`, so the gate works inside
any test runner.)

**Sample content for scripts** (port of `tests/fakes.py`, rewritten in JavaScript; keep the *names* so
the Python tests map one-to-one):

```ts
TASK_MD            // "# Task: Add clamp" … AC1 import works, AC2 clamps, AC3 lo>hi throws RangeError … "## Open questions\n- None"
TASK_MD_BLOCKING   // TASK_MD with "- BLOCKING: should lo > hi swap or throw?"
TEST_CLAMP         // tests/clamp.test.js: within / below-and-above / lo>hi throws   (imports clamp from ../mathutils/index.js → FAILS before implementation)
TRIVIAL_TEST       // a test that passes with no implementation (for the G-tests-green case)
CORE_HEADER, CLAMP_OK, CLAMP_WRONG, INDEX   // mathutils/core.js pieces; IMPL_OK / IMPL_WRONG = {path: content}
TEST_CLAMP_DEFECT  // wrong expected value: can never pass; defectFinding() = a test-defect finding for it
TEST_SIGN, SIGN_IMPL, signScripts()          // a second independent item, for parallel runs
happyScripts()     // every stage passes first round, with 'AUTHOR-REASONING …' in author replies
                   //   (so tests can assert a critic's prompt never contains it)
interrupt          // a step that throws Cancelled, simulating Ctrl-C mid-agent
```

`FakeAgentRunner` and its builders: [06-AGENT_RUNNER](06-AGENT_RUNNER.md) §9.

**Time and ids.** Inject a clock into anything that formats ages or reset times; inject the run id
(`new Orchestrator(..., { runId })`) for deterministic paths. Never `sleep` in tests: poll with a
helper `waitFor(cond, {timeoutMs})`.

## 4. Orchestrator scenarios to port (each is a named test)

From `test_orchestrator.py`, `test_stages.py`, `test_levels.py`, `test_tests_level.py`, `test_solo.py`,
`test_bypass.py`, `test_answers.py`, `test_decisions.py`, `test_resume.py`, `test_test_defects.py`,
`test_usage.py`, `test_level_invariants.py`, `test_parallel.py`, `test_events.py`, `test_reports.py`.
This list is the **minimum**; the Python files have more. Port by reading them.

*Pipeline mechanics (levels 3–5):* pass on the first round · FAIL then PASS · round cap → arbiter
dismiss · arbiter fix then success · arbiter fix still failing → `red_checks` decision · dispute
accepted when the critic doesn't re-raise · re-raised dispute → straight to the arbiter · malformed JSON
retried once with the parse error · twice-malformed critic → blocking "critic output unparseable" ·
coder edits a test file → reverted + `T-guard` finding · failed gate becomes `G-<name>` blocking
finding and can't be disputed · tests already green before implementation → `G-tests-green` · no test
files → `G-tests-missing` · budget exceeded aborts (status, report, cost table) · blocking questions at
SPEC · worktree removed on complete / kept with `keepWorktree` · branch naming and `-2` suffix · review
findings → arbiter → final pass · critic prompt contains task.md + diff + gates and **never** the author
reply · test author prompt has task.md only · code critic told which tests exist · `task.md` excluded
from judged diffs · cost table.

*Test defects:* critic flags `test-defect` + failing test → one test-author fix pass, non-test edits
reverted, tests committed alone, new guard baseline, gates rerun; a claim alone clears nothing; a second
defect in the same stage isn't fixed again; defect findings are minor and never go to the coder.

*Levels:* Adversarial (no reviewers) · Tests (no critics: gates drive the author; single `REV-` review;
no arbiter: rulings recorded by code; final pass charged to the stage) · Basic and Reviewer (solo stage,
checks, no automatic retry; single review → one automatic solo fix pass → ask) · `maxAgentCalls` worst
case against a script that fails as late as possible at **every** level · only `rolesFor(level)` called ·
level and scan never change across resume · `check_same_shape` refusals · old `run.json` loads as full.

*Questions:* recorded with ids; `recordAnswers` all-or-nothing and **every** refusal (unknown id, missing,
empty, too long, too long in total, both answered and bypassed, wrong status, live lock, branch deleted,
cap reached, `spec_cap` open); answering twice replaces; writes nothing but `run.json`/`events.jsonl`;
resume runs a **revision** with the previous task.md read from the *run directory* after `reopen`
wiped the worktree; committed task.md has the Answers section; new question after a revision continues
numbering; re-asked question's answer stands; cap → *Begin work?*; interrupted/over-budget revision
reruns on resume; old-format runs migrate; `withAnswersSection` idempotent and invisible to
`blockingOpenQuestions`.

*Bypass:* per-question, bypass-all, mixed; the bypass call (JSON, retry once, stray files reverted,
task.md restored byte for byte, stand-in on unusable answers); covers one stop only; Bypass up front at
and below the cap (solo gets one extra pass); *Begin work* → bypass call without another revision;
agent answers marked in task.md, report, status; later agents never see the bypass reply.

*Decisions:* each kind's explanation; `fix` with and without a note (note verbatim in the author prompt),
the 4th fix refused; `takeover` (commit, remove worktree, keep branch, end; then decide/resume refused,
`clean` rules); `scan_hits` ask/ignore/block (sticks; Full never asks; up-front policies never ask;
`ignore` costs no extra agent call); `spec_cap` begin/stop; `decide` refusals; interrupted fix pass
reruns on resume; the worktree untouched at a stop and kept on resume (`keepChanges`).

*Usage limits:* snapshots recorded per call, latest per window in `run.json` and `usage.json`, a `usage`
event each; `allowed_warning` adds a note and carries on; a rejected event / `rate_limit` / `billing_error`
each pause at `usage_limit` **from any stage** (spec, critic, reviewer pair, arbiter, JSON retry,
settle) with the right explanation; cost kept; `retry` restarts the stage with partial work and the
cut-off line in the prompt; a still-limited retry pauses again; `finish` leaves everything uncommitted and
the run final; `clean` refuses the dirty worktree without force; login detection order; "unknown" never
warns; Console warning cases.

*Resume/lock:* interrupted run resumes at the first unfinished stage; completed stages skipped;
`resume --budget`; refused when complete / needs a decision / being driven / ended; lock liveness
(stale lock ignored; live pid refused); `isThisProcess` handling for `locked_for_me`.

*Parallel:* two independent items, each with its own worktree/branch/budget/run dir, don't interfere.
(Now this means two orchestrators in one test process, since production uses one worker per run; plus a
real two-worker test in §6 that exercises the git lock.)

## 5. Read-model tests

**No golden runs from the Python version** (the owner dropped backwards compatibility, ADR-9). Instead the
read-model and report tests build run directories with the orchestrator and `FakeAgentRunner` (or by hand),
then assert on `displayStatus`, the timeline step states, next steps, the context view, `renderReport`
output (checked against the Python source's text for the ported wording), and `tailEvents` in odd chunk sizes
(partial lines, mid-line offsets). Keep these few and focused.

**Read-model unit tests** (port `test_ui*.py` logic, minus HTTP): `loadRuns` (newest first, counts,
unreadable listed, live lock ⇒ running, filters), `displayStatus` for every status and the ordering of
its rules, `stageLabel`, `title_of`, `age`; `loadDetail` for every status and level, timeline states
(`_step_state` cases: arbiter used/not needed/if needed/absent, fix-pass and decision panels, solo
passes titled correctly, "No critic at this level"); `nextSteps` per status with hostile values quoted
(branch/path containing spaces, quotes, `$()`, backticks, newlines); decision view per kind; context view
(seen-by per level, missing files, standards doc via `git cat-file` with a hostile revision/path, config
shown raw when invalid); items (grouping, last run by resolved path, git states from a real repo,
unmanageable names listed); `planRun` (precedence, every error and warning, calls/dropped per level,
`shown` text); `checkDraft`; `tailEvents` (partial lines held back, offsets mid-line, malformed line,
`ended` rule).

## 6. Process tests (real children)

`worker.ts` built with the **test flag** reads `ADVPIPE_FAKE_SCRIPT=<json>` and uses a
`FakeAgentRunner`. It can be **held at a role until a file appears**, exactly like the Python
`advpipe_fake_child.py` (a `hold: {role, until: path}` field). Tests:

- `startWorker` returns promptly while the run continues; `console.log` is appended; the lock holds the
  **child's** pid before the child has written `run.json`; the run completes; the lock is released.
- Cancel while held at a role → the worker stops at the next safe point; status stays `running`; note
  "Interrupted during <stage>" recorded; lock released; `cancel` file removed; `resume` continues and
  completes. Cancel that the worker ignores (held in a non-cancellable section) → the host's grace
  timer force-kills the tree; stale lock cleaned; run still resumable.
- Two workers started together on two items in the same repo: both complete; **distinct branches**; no
  git-lock failure; worktrees isolated (the git lock test: start N=4 at once, assert unique branches).
- A worker killed with SIGKILL leaves a stale lock: the run shows `stopped`; `resume` works.
- `locked_for_me` resume path; `start.json` validation failure → worker exits non-zero with a message in
  `console.log` and the run page shows it.
- `cleanRun` rules (complete refused, active refused even with force, unmerged commits refused without
  force, finished-as-is dirty worktree refused without force, path/branch defence in depth with a
  tampered `run.json`).
- Pid liveness helper on the current OS (alive, dead, other user's process).

## 7. IPC handler tests

`createHandlers(deps)` (in `app/main`) takes the engine functions, a `repoFor(sender)` and a fake
`shell`/`dialog`; tests call handlers with hand-built events. For **every channel**: valid call; each
invalid-input class (wrong type, missing field, extra field, bad id, traversal, over-length, wrong
status/kind, missing `confirm`) is rejected with `{ok:false}` **and the engine function was not
called** (assert on the spy); output is parsed; a sender that isn't one of our windows is refused; the
renderer-supplied-path rule (no channel accepts an absolute path except through the picker). The
`openLink` channel accepts only its two keys.

## 8. Renderer tests

Vitest + jsdom + Testing Library + `vitest-axe`. A `renderWithApi(<Page/>, apiStub)` helper provides a
typed fake `window.advpipe` and a controllable push emitter. Cover: every component's states; every page's
loading/empty/error/live states; the answer form rules (ticked box beats text; bypass-all beats
everything; typed text survives a refresh push); the decision panel per kind (disabled fix at the cap;
confirm pages focus the safe button); the New run summary and `shown` handshake; the slider
(`aria-valuetext`, inherited start, untouched re-seed rule); copy buttons announce; panels' open state
survives updates; hostile-string battery on every text surface (§08-SECURITY §4); **axe** has no
violations on each page in light and dark; colour tokens all have both values (parse `tokens.css`); no
`style=` attributes or inline `<script>` in rendered output; keyboard-only walkthroughs of the main flows.

## 9. End-to-end (Playwright with Electron)

Build once with the fake-agent flag (`npm run test:e2e` does it). Each scenario launches the real app on
a temp copy of the fixture repo and drives the UI; workers are real processes with scripted fake agents.
Minimum scenarios:

1. **Happy path:** open repo → New run (Tests level) → watch it go live → complete → next-steps commands
   present → copy button.
2. **Blocking question:** run stops at *needs answers* → answer one, bypass one → live → complete; task.md's
   Answers section shows both, the agent's marked.
3. **Red checks → fix with a note → takeover** on a second run (confirmation pages; branch checked with git).
4. **Scan hits** (scripted scanner failure) → Ignore, then a second run → Block.
5. **Usage limit** → paused panel with the fixed link (assert `shell.openExternal` stub got the constant URL
   only) → Try again → completes; and Finish as is → *finished* page; Clean up refuses until forced.
6. **Cancel → Resume** with a new budget; **over budget** requires a budget.
7. **Work items:** create, edit (front matter round-trips byte for byte), rename, delete with confirmation;
   stale-file save refused.
8. **Closing the window mid-run** doesn't stop the run; reopening the repo shows it live/complete.
9. **CSP/console:** no CSP violation and no console error during any scenario; no network requests made
   by the renderer.
10. **Keyboard + a11y smoke** on the main pages; light/dark/system; 768 px width.

`npm run screenshots` drives scenarios 1–7 and writes `docs/screenshots/*.png` (port of
`scripts/ui_screenshots.py`).

## 10. Real-API checks (manual; owner's go-ahead each time)

Not automated, not in CI; report what was checked **and what wasn't**:

- M0 spike S3: one Basic run on a fixture copy, logging the message stream.
- M12: one Basic and one Tests run end to end on a fixture copy with a real login, subscription or
  Console, whichever the owner has; confirm cost labels, login detection, the report.
- Never try to *trigger* a real usage limit.

## 11. CI

GitHub Actions (or the owner's CI): matrix `ubuntu-latest`, `macos-latest`, `windows-latest`; steps
`npm ci`, `typecheck`, `lint`, `test`, and on Linux `test:e2e` under `xvfb-run`. The Windows job exists
from M2 (workspace/gates/lock) so POSIX-only assumptions are caught early (`WINDOWS_PLAN.md` §3).
`npm audit --omit=dev` fails on high/critical. A job runs `check:prompts` and the "no push/merge verbs"
grep.

## 12. Definition of "ported"

A Python test file is *ported* when each of its tests has a TS counterpart with the same name (or a
mapped name in `docs/10-PORTING_MAP.md`'s table) **or** a one-line reason in that table why it doesn't
apply (e.g. "HTTP/CSRF: no server"). Track this in the porting map's status column as modules land.
