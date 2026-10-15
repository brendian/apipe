# 05 · UI specification

The UI is the product. This document specifies every screen, its data, its states, its actions and
its wording. It is a **desktop restatement of the Python web UI** (screenshots of which are in
`docs/reference/screenshots/`; the original server code in
`docs/reference/python-original/src/advpipe/ui/` is the detailed reference for derivations) plus the
small additions a desktop shell makes natural.

Everything here renders from **read models** (the `readmodel/` modules in the engine, [04-ARCHITECTURE](04-ARCHITECTURE.md) §4)
over IPC. The renderer never reads files and never derives run status itself.

---

## 1. Principles

1. **Plain language.** Say "checks", not "gates". Every status has a tooltip/help line that says what
   to do. Every empty state says what to do next. Errors say what happened and what to try.
2. **A person makes every stop-or-go call.** The UI never auto-clicks a decision. Buttons that end a
   run (*I'll take over*, *Finish as is*, *Stop here*, *Clean up*, delete) always go through a
   confirmation that says exactly what will happen.
3. **Nothing starts blind.** *Start* shows the money and the settings *first*, and the host refuses to
   start if what was shown differs from what it computes at that moment (the `shown` check, §5.4).
4. **It never merges.** Next steps are git commands with **Copy** buttons; the app never runs them.
5. **Agent text is untrusted.** Everything from an agent, a file or a work item is rendered as text or
   sanitised markdown, never as HTML ([08-SECURITY](08-SECURITY.md)).
6. **Live by default.** A running run updates without a refresh; scroll position, open panels and typed
   drafts survive updates.
7. **Local and quiet.** No network calls from the UI, no telemetry, no update pings in the renderer.

## 2. Structure

```
┌ advpipe ─ home-inventory ─────────────────── Runs │ Work items │ Help ─── Theme ▾ ┐   ← top bar
│  [usage line: "Claude subscription · 5-hour 62% (resets 14:00) · weekly 30%"]       │   ← optional, §5.1
│  ┌────────────────────────── page ───────────────────────────────────────────────┐  │
│  │                                                                               │  │
```

- **One window per repo.** Title: `advpipe — <repo folder name>`. The top bar shows the repo name; a
  menu item *Open another repo…* (⌘/Ctrl+O) opens a new window.
- **Routes** (in-memory history; Back/Forward buttons and ⌘[ / ⌘] work):

| Route | Screen |
|---|---|
| `/` → `/runs` | Runs list (home) |
| `/runs/new?item=<rel>` | New run dialog (full page, as in the original) |
| `/runs/:id` | Run detail, **Progress** tab |
| `/runs/:id/context` | Run detail, **Spec & context** tab |
| `/runs/:id/decide/:choice` | Confirmation page for `takeover`, `stop`, `finish` |
| `/runs/:id/clean` | Clean-up confirmation page |
| `/items` | Work items list |
| `/items/new`, `/items/edit?path=`, `/items/rename?path=`, `/items/delete?path=` | Work-item pages |
| `/help` | Help |
| `/welcome` | First screen of a window with no repo, and the preflight |

- A native **menu** (File: New run, New work item, Open repo…, Close window, Quit; Edit; View: Theme,
  Zoom; Window; Help: Help page, Open log folder, About) mirrors the top bar. Menu actions arrive as
  `app.menu` pushes and navigate; they never bypass a screen's own validation.
- Notifications ([§5.9](#59-notifications-and-the-dock-badge)).

## 3. Every CLI command, as UI

There is no CLI to operate runs. This table is the **parity checklist**: each Python command and flag
maps to something specific in the UI. (From `docs/reference/python-original/README.md`'s Commands
section and `cli.py`.)

| Python | Where it lives now |
|---|---|
| `advpipe run "text"` / `--item FILE` | **New run** (§5.4): a work-item picker or a typed one-off task |
| `--level`, `--security-scan/--no-security-scan`, `--scan-failures`, `--bypass-questions` | New run: the **slider** (*How much checking*), *Security scan* radios, *If it finds issues* radios, *Don't stop for questions* checkbox; and the work-item editor's *Run settings* |
| `--name`, `--config`, `--budget` | New run: *Branch name*, *Pipeline config* fields; budget is shown (from config) and set on **Resume** |
| `--keep-worktree` | New run → *Advanced*: "Keep the working copy after a successful run" |
| `--from-file`, `--parallel N` | Backlog (M13): select several work items → *Run N items* with *At most K at once* |
| `--detach` | Always. Runs are always background workers |
| `advpipe status [ID]` | The **Runs list** and **Run detail** (header, timeline, report) |
| `advpipe report ID` | Run detail → **Report** section; *Open report.md* |
| `advpipe answer ID` (`--answer`, `--file`, `--template`, `--bypass`, `--no-resume`) | The **answer form** on the run page (§5.2.4): a box per question, *Let the agent decide* per question, *Bypass all and continue*. (`--file/--template/--no-resume` have no UI: saving always continues) |
| `advpipe decide ID CHOICE [--note]` | The **decision panel** (§5.2.5) |
| `advpipe resume ID [--budget]` | **Resume** button (with an optional new total budget; required after *over budget*) |
| `advpipe cancel ID` | **Cancel** button (confirm) |
| `advpipe clean ID [--force] [--logs]` | **Clean up** → confirmation page with checkboxes |
| `advpipe levels` | The slider's live summary + Help → *Levels* |
| `advpipe usage` | The usage line + meters (§5.1, §5.2.3); Help → *Logins and limits* |
| `advpipe ui [--repo] [--port] [--items-dir] [--host]` | Launching the app (`advpipe [repo]`); *items folder* is a per-repo preference; no port, no host |
| `advpipe gates [--only]` | **Not in the UI.** Backlog: tiny hook CLI (see [11-MILESTONES](11-MILESTONES.md)) |
| `pipeline.toml` editing | *View* in Run detail → Spec & context; *Open pipeline.toml in your editor*. A form editor is backlog |

## 4. Design system

### 4.1 Tokens

All colours are custom properties set with `light-dark(light, dark)` so there is **one list** and both
themes derive from it; `color-scheme` picks the side — the OS setting unless `<html data-theme="light|dark">`
overrides it. Every colour token needs a light and a dark value (a test enforces it, as the original's
`test_ui_polish.py` did). Required tokens (names are the contract; values are the designer's, starting
from the original's `static/app.css`):

```
--bg  --surface  --surface-2  --border  --text  --text-muted  --link
--accent  --accent-text                      /* primary buttons */
--ok  --ok-bg   --warn  --warn-bg   --bad  --bad-bg   --info  --info-bg   /* status chips, callouts */
--focus-ring                                 /* 2px, offset 2px, never removed */
--diff-add-bg  --diff-del-bg  --diff-hunk-bg  --diff-ctx
--font-ui (system-ui stack)   --font-mono (ui-monospace stack)
--space-1..6 (4px scale)   --radius-1..2   --max-content: 72rem
```

### 4.2 Components (build once, reuse)

`StatusChip` (icon + label + tooltip help; never colour alone) · `LevelChip` ("Tests (3 of 5)") ·
`CostMeter` (value of budget, a progress bar, the login label) · `UsageMeter` · `CommandBox` (monospace
text + **Copy** button, announces "Copied" politely) · `Markdown` (sanitised) · `TaskMd` (markdown +
acceptance-criteria / open-question / BLOCKING highlighting, §5.3) · `DiffView` · `FindingCard` ·
`GateList` · `Timeline` / `TimelineStep` · `RoundPanel` (a `<details>` with a stable key) ·
`DecisionPanel` · `AnswerForm` · `ConfirmDialog`/confirmation page · `LevelSlider` · `Callout`
(info/warn/bad) · `EmptyState` · `FilterTabs` · `Toast` (aria-live) · `Breadcrumb`.

### 4.3 Interaction and accessibility (every one is a test or a manual-check item)

- **Skip link** is the first Tab stop; `<main id="content" tabindex="-1">` takes focus on navigation;
  route changes move focus to the page heading and announce the title.
- **`:focus-visible` ring on every focusable element; nothing removes outlines.**
- Status is never conveyed by colour alone (icon + text). Chips have the help text as an accessible
  description.
- The level slider is a Radix Slider with a visible label row under the track and
  `aria-valuetext` = the level's label ("Tests"), not "3". Its summary is `aria-live="polite"`.
- Live regions: toasts (`status`), copy confirmations, the "run moved to <status>" announcement on the
  open run page (polite, once per change).
- All dialogs trap focus, close on Esc, restore focus. Destructive confirmations focus the *safe*
  button first.
- Keyboard: `g r` runs, `g i` items, `g h` help, `n` new run (documented in Help; ignored while typing in a field, with a modifier held, and on the welcome page); all buttons reachable in order. *(Built, M11.)* A fresh window leaves the focus alone so the skip link is the first Tab stop; every later navigation moves focus to the new page's heading.
- Responsive down to a **768 px** window: less padding, wrapping top bar, tables' action cells wrap;
  wide content (`pre`, commands, tables) scrolls **inside** its box, never the page.
- Respect `prefers-reduced-motion` (no animations beyond a 100 ms fade; the live-run indicator is a
  static dot with a text label under reduced motion).
- Text scales with the OS/zoom; no fixed-pixel body text.
- The theme control cycles *system → dark → light* and persists in `preferences.json`; the choice is
  applied **before first paint** (read synchronously in the preload and set on `<html>`) so there is no
  flash of the other theme.

### 4.4 Wording rules

Use the original's strings verbatim where this document or the Python UI templates have them
(`docs/reference/python-original/src/advpipe/ui/templates/*.html`, `ui/runs.py STATUSES`,
`ui/detail.py CHOICE_VIEWS`, `ui/routes/help.py`). Prefer "working copy" to "worktree" and "checks" to
"gates" in UI text; use `worktree`/`gate` only in code. Commands shown to a person (next steps) are
**git commands** the person may run in their own terminal; **never** show `advpipe …` commands: there
is no such CLI. (This is the one systematic text change from the original; see §5.2.7 and [02-DOMAIN_SPEC](02-DOMAIN_SPEC.md) §19.)

---

## 5. Screens

### 5.0 Welcome, repo picker and preflight (`/welcome`)

Shown when a window has no repo, or when preflight fails.

```
 advpipe                                              ← big heading
 Drive a task through AI agents that check each other, and get a branch to review.

 [ Open a repo… ]     Recent:  ~/code/home-inventory   ~/code/billing   …

 Checking your setup
  ✔ git 2.56 found
  ✔ ~/code/home-inventory is a git repo (branch main, 4 uncommitted files)      ← warn if no commits yet
  ✔ Claude Code found (SDK bundled). Logged in: Claude subscription
  ⚠ Claude: not known yet — advpipe learns which login you use from the first run.
```

- **Preflight** (`app.preflight`): `git --version` works; the folder **is the top of** a git repo (a subfolder is refused with "Open that folder instead", because `.advpipe/` and the worktrees belong at the repo root) with **at least
  one commit** (a worktree needs `HEAD`); the SDK's bundled Claude binary resolves; login kind from
  `.advpipe/usage.json` if present, else `unknown`. A failing check blocks *New run* and says exactly
  what to do ("This folder isn't a git repo. Run `git init` and make a first commit.").
- It also reports uncommitted changes in the repo as **information** ("Your working tree is never
  touched; agents work in a separate copy") — never a blocker.
- **Pick a repo**: native folder dialog in **main** (the renderer receives only "opened"). Recent
  repos (max 10) from preferences; a missing one is shown dimmed with *Remove*.

### 5.1 Runs list (`/runs`) — home

```
 Runs                                                                [ New run ]  [ Clean up… ]
 Claude subscription · 5-hour 62% used, resets 14:00 · weekly 30%      ← usage line (§5.2.3), when known
 [ All 12 ]  [ Running 1 ]  [ Needs you 3 ]  [ Complete 7 ]

 ● running     S03 stock changes          [Tests (3 of 5)]  CODE r2/3   $1.10 of $8.00   3 min ago
 ✔ complete    S02 items                  [Full (5 of 5)]   DONE        $1.50             1 day ago
 ⚠ needs you   S01 database               [Full (5 of 5)]   ARBITER     $0.98             2 days ago
 ◆ needs a decision …
```

- Data: `runs.list` → `RunList{rows, unreadable}`; **newest first**; counts per filter. Refetched on
  `runs.changed`. Row: status chip, **title** (work item's first non-empty line, leading `#`s
  stripped, ≤ 80 chars with `…`), level chip, branch, **stage label** (`CODE r2/3`: stage, plus round and
  the cap during TESTS/CODE; `FINAL_GATES` shows as `FINAL CHECKS`), cost against budget (budget from the
  run's `config.json`; omit "of $X" if unknown), age (`just now`, `N min ago`, `N h ago`, `N day(s) ago`).
- Whole row is a link (keyboard: Enter). Unreadable runs are listed in a collapsed section
  "N runs couldn't be read" with the reason.
- **Filters**: All; Running; **Needs you** = {stopped, needs_human, needs_answers, needs_decision, paused,
  budget_exceeded, error}; Complete. The selected filter is remembered per repo.
- **Clean up…** (header): opens a panel listing every run whose status allows cleaning (dead ones:
  stopped, error, over budget, needs you/answers/decision/paused, handed over, ended, finished) with
  checkboxes → per-run confirmation semantics (§5.7); a convenience over visiting each run.
- Empty state: "No runs yet in this repo. **Start one** from a work item or type a one-off task."
  with *New run* and *New work item* buttons.
- A run whose lock has a live holder shows as **running** even if `run.json` doesn't say so yet (a
  freshly started resume).

### 5.2 Run detail (`/runs/:id`)

Two tabs: **Progress** (default) and **Spec & context** (§5.3). Layout of Progress, top to bottom
(see the screenshot `reference/screenshots/run-detail.png`):

#### 5.2.1 Header
`← All runs` · **title** (≤ 120 chars) · a row of facts: **Status** (chip + help line below), **Stage**
(`CODE r2/3`), **Level** (chip, plus "· security scan on|off"), **Cost** (§5.2.3), **Time** (updated_at −
started_at), **Branch** (+ *Copy*), **Run id**, and, when set, *Work item: <relative path>* (links to
the editor).

#### 5.2.2 Action buttons (valid actions only)

Drawn from the validity matrix (§7). Each shows only when valid and again re-checked by the host.

| Button | Behaviour |
|---|---|
| **Cancel** | Confirm ("Stop this run at the next safe point? It can be resumed."). → `run.cancel` |
| **Resume** | Inline form: *New total budget* (optional; **required** for *over budget* with a suggested value `suggestedBudget`: double the budget, at least $5 more than spent, rounded up; validated by `parseBudget`); shows Console-credits warning if likely. → `run.resume` |
| **Clean up** | → confirmation page (§5.7) |
| **Open working copy** | `run.reveal` (worktree) when it exists |
| **Open report.md** / **Open run folder** | `run.reveal` |

*(Built, M10.)* The action bar also has *Open working copy / Open report.md / Open run folder* (`run.reveal`: main derives the path from run state and refuses anything outside `.advpipe/`). *Cancel* asks in a native `<dialog>` (safe button first and focused). The refusals a person can see are the engine's own words, prefixed "Not saved:", "Not sent:", "Not resumed:", "Couldn't cancel it:" or "Couldn't resume it:" (the Python's "advpipe refused:" had no CLI to name); a stale action says "This run changed since you looked (it's now <status>). Reload." Notices after an action are fixed texts (`NOTICES` in contracts), chosen by a route key.

#### 5.2.3 Cost and usage

`$1.89 of $8.00` + a bar; the label under it depends on the login:
Console → **real money**; subscription → **API-equivalent, not billed**; unknown → "API-equivalent if
you're on a subscription". When the login is subscription (or windows are known) show small meters from
`RunState.rate_limits` (run page) or `usage.json` (list, new-run dialog): "5-hour: 62% used, resets
14:00 · weekly: 30%, resets Mon" using `usage.describe` wording; stale windows read "reset since; usage
unknown"; with nothing: "Not known yet: advpipe sees usage only when Claude reports a change." Never a
live gauge. Windows at `allowed_warning`/`rejected` get a warning style and are called out in the New
run dialog.

#### 5.2.4 The answer form (status **needs answers**)

Replaces "what's left open". For every question with `!applied` (`to_answer`):

```
 The spec has 2 blocking questions. Answer them and the same run carries on.     $0.31 of $15.00
 Q1  Should partial refunds round half-up or to even?
     [ textarea, prefilled if already saved ]           [ ] Let the agent decide
 Q2  Are refunds allowed after 90 days?
     [ textarea ]                                        [ ] Let the agent decide
 [ Save answers and continue ]   [ Bypass all and continue ]
```

- Rules (mirror `answers.check_answers`): a ticked *Let the agent decide* beats text in its box; *Bypass
  all and continue* beats everything and sends every question as bypassed; the textareas are **not**
  `required` (the server decides, so a refusal keeps what was typed); each answer ≤ 8 000 chars and all
  ≤ 24 000; a refusal shows the message above the form with typed answers intact.
- Console-credits warning above the buttons if likely. On success → `run.answer`, the page goes live.
- At the spec-pass cap there is **no form**: the status is *needs a decision* and the **Begin work?**
  panel shows instead (§5.2.5).
- The timeline's SPEC (or SOLO) step has a panel per pass: "Spec", "Revision N: with your answers to
  Q1, Q2", each with the blocking questions it asked and their answers; agent answers carry an
  **agent's best judgement** badge and their reason.

#### 5.2.5 The decision panel (statuses **needs a decision** and **paused: usage limit**)

One panel, title from `DECISION_TITLES`, the decision's `explanation` (plain text), the findings as
`FindingCard`s (failing checks' output tails, or scan hits), and one control per choice from
`CHOICE_VIEWS` (verbatim labels/help):

| Kind | Title | Controls |
|---|---|---|
| `red_checks` | The checks are still failing | note box (≤ 8 000, only for fix) · **Another fix pass** ("fix pass N of 3"; disabled with an explanation when `N > max_fix_passes`) · **I'll take over** (confirm page) |
| `scan_hits` | The security scan reported issues | **Ignore and continue** · **Block** |
| `spec_cap` | Begin work? | the still-open questions listed · **Begin work** · **Stop here** (confirm page) |
| `usage_limit` | Paused: a usage limit was reached | the explanation with a fixed link (*Add extra usage* / *Add credits in the Console*, opened in the **system browser** via `shell.openExternal` after an allow-list check of exactly the two constant URLs) · `retryWarning` ("If the limit is still in force, the run will pause again. The limit resets at 14:00.") · **Try again** · **Finish as is** (confirm page) |

`takeover`, `stop`, `finish` go through confirmation pages (§5.7); the others post straight from the
panel. All choices call `run.decide`. After a continuing choice the run goes live; the timeline shows
each decision as a panel in the step where the run stopped.

States that are **not** decision panels: **handed over** (branch + "Check the branch out and finish it by
hand"), **ended** ("Stopped at your choice; nothing was written to the branch"), **finished as is**
(worktree path, uncommitted work, how to clean up); none have actions beyond Clean up.

#### 5.2.6 Timeline and round panels

A horizontal strip of steps for **this run's level** (`stepsFor(level)`), then a collapsible panel per
step. Step states and their labels/explanations (from `detail.STEP_STATES`):

| State | Label | Meaning |
|---|---|---|
| done | done | Finished |
| current | in progress | An agent or check is working on this step right now |
| stopped | stopped here | The run stopped during this step; the report says why |
| pending | not yet | Not started yet |
| not_reached | not reached | The run ended before this step |
| not_needed | not needed | No findings were left open, so the arbiter wasn't called |
| if_needed | only if needed | Runs only if findings are left open after a stage |

Derivation (port `ui/detail.py` `_step_state`, `_active_stage`, `build_timeline`): a mainline step is
**done** iff its commit key (`COMMIT_KEYS`: SPEC→`spec`, SOLO→`solo`, TESTS→`tests`, CODE→`code`,
REVIEW→`review`) is in `commits`; the step the run is in is current (live) or stopped; during ARBITER the
"active" stage is the first of the level's mainline steps without a commit; steps after it are `pending`
if the run can continue (resumable, or awaiting answers/decision) else `not_reached`; the ARBITER step is
`done` if rulings exist, `not_needed` on a complete run that never used it, absent at levels without an
arbiter (there, final author passes and code-made rulings appear in the step they were for, with the note
"No arbiter at the <level> level: code ruled every open finding fix."). FINAL CHECKS is done iff the run
is complete.

Step summary text: TESTS/CODE `N of CAP rounds`; ARBITER `N ruling(s): F fix, D dismiss`; SOLO `N pass(es)`;
others the first round panel's outcome.

**Round panel contents** (each section appears only if its file exists; a missing/unreadable file shows as
such and **never fails the page**):

- Title: `Round N`, `Pass N`, `Revision N: with your answers to Q1, Q2`, `Fix pass N (you asked)`,
  `Final checks`, the reviewers…
- **Author's reply** (`author.txt`): rendered as plain text/markdown (it is agent text).
- **Checks** (`gates.json`): one row per check: name, pass / fail (exit N) / skipped (reason), command;
  failing output tail in a scroll box.
- **Diff the critic judged** (`diff.patch`): `DiffView`, cut at **3 000 lines** with a "N more lines"
  note; new/removed/context line classes; file headers; copy button.
- **Verdict** (`critic.json` / `standards.json` / `security.json` / `single.json`, parsed with
  `extractJson` → `Verdict`; shown raw if that fails): PASS/FAIL + a `FindingCard` per finding
  (severity chip, category, `file:line`, criterion, claim, evidence, suggested check). At the `tests`
  level a round without `critic.json` says **"No critic at this level"**.
- Test-fix reply (`test-fix.txt`); scanner result (`scanner.json`); arbiter rulings with reasons.
- Panels are keyed (`step/round`) so their open/closed state survives live refreshes.

**Live log** (`<details>` "Log · N event(s)", open while running): lines `HH:MM:SS message`, appended
from `run.log` pushes; auto-scroll only while the user is at the bottom; `usage` events render with a
subtle style; a decision event has an icon. Capped at 5 000 lines in memory with a "Showing the last
5 000" note.

#### 5.2.7 Next steps

`nextSteps(state, status, repo, budget)` → ordered `{label, command}` list rendered as `CommandBox`es.
Port `ui/detail.next_steps` **with the `advpipe …` commands removed** (the UI has buttons for those);
what remains are **git and shell commands**, every value `shlex`-quoted for the user's shell (POSIX
single-quote rule; on Windows use the PowerShell/`cmd` quoting appropriate to the user's shell, default
PowerShell) — run.json is a file, not something to trust in a shell:

| Status | Steps |
|---|---|
| complete | Read the change, one commit per stage (`git -C <repo> log -p --reverse <base12>..<branch>`) · List the files it changed (`git diff --stat <base12>...<branch>`) · Merge it, from the branch you want it on (`git merge <branch>`) · Then delete the branch (`git branch -d <branch>`) · Remove the working copy it kept (`git worktree remove <wt>`, when it was kept) |
| needs you / needs decision / paused | See what it did so far (the `log -p` command) · Look at the work in its working copy (`cd <wt>`) |
| handed over | Check the branch out and finish it by hand (`git -C <repo> switch <branch>`) · Read what it did |
| finished as is | Look at the work, uncommitted, in its working copy (`cd <wt>`) · See what changed (`git -C <wt> status`) |
| others | (buttons cover everything else) |

"advpipe never merges or pushes. These are for you to run." is shown under complete runs.

#### 5.2.8 Report

`report.md` rendered (sanitised markdown) under the timeline. For states with a person's next move, the
report's own "Notes" lines about `advpipe answer/decide` are replaced by the plain instructions
(03-DATA_CONTRACTS §10).

#### 5.2.9 Starting-up panel

For `runs.detail` → `Starting` (lock exists, no `run.json`): "Starting… the run is setting up its
working copy." with the last lines of `console.log`; refreshes when `run.json` appears; if the process
is dead, shows the log tail and "The run didn't start. Here is why:". Never "No such run" unless the run
directory is missing; an unreadable run shows "Can't read this run: <message>" (HTTP-500-equivalent
styling), not "No such run".

### 5.3 Spec & context tab (`/runs/:id/context`)

"Everything the agents worked from." Each block states **who sees it** (port `SEEN_BY`, `seen_by_for(level)`
and `ROLE_INPUTS`; they describe what `stages` actually puts in each prompt, so change them together):

1. **Work item** — the text (markdown), the file it came from (link to editor). *Seen by:* the spec writer
   only (solo agent only, at levels 1–2); every later agent works from `task.md`.
2. **`task.md`** — `TaskMd` rendering with **Acceptance criteria** and **Open questions** headings and
   their top-level items classed; `BLOCKING:` items highlighted (same regex as the engine, 02 §5); the
   `## Answers` section highlighted; counts shown ("5 acceptance criteria · 2 open questions, 1 blocking").
3. **Config** — the run's `config.json` summarised: models, round caps, turn limit, **budget**, level
   settings; raw JSON if it doesn't validate (with the error).
4. **Checks** — each configured command (test/types/lint, and the scanner shown separately: "the
   security scanner, run once before the review") with `CHECK_HELP`; "skipped (not configured)" for `[]`.
5. **Standards doc** — read with `git cat-file blob <rev>:<path>` from the run's branch, then its base
   commit, then the working tree. The revision must match `^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$` (no
   leading `-`) and the path must be relative with no `..`, so values from `run.json`/`config.json`
   can't become git options or leave the repo. *Seen by:* the standards reviewer (note that Claude Code
   also loads the repo's `CLAUDE.md` into every agent via project settings).
6. **Role prompts** — only the roles in `rolesFor(level)`; each with model (from config), tools
   (`ROLE_TOOLS`), what it receives (`ROLE_INPUTS`), and its system prompt (read-only, shown **as
   installed now**, with the caveat "a run started with an older version may have used different text").

A missing file shows a clear empty state ("This run has no task.md yet"), never an error page.

### 5.4 New run (`/runs/new`)

A full page form (as `new-run.png`). Fields:

- **What to build**: radio *A work item* (a `<select>` of `items.list` paths) / *A one-off task, typed here*
  (textarea; "Used only when 'A one-off task' is chosen. It isn't saved as a work item."; ≤ 64 000
  bytes; no NUL). `?item=` preselects an item.
- **Branch name** (optional; placeholder = the item's `name`), **Pipeline config** (optional; a `.toml` in
  the repo; placeholder `pipeline.toml`). Single-line fields only.
- **How much checking** (fieldset): the **slider** (1–5) with labels *Basic · Reviewer · Tests ·
  Adversarial · Full* as visible text; **Security scan**: *Default / On / Off*; **If it finds issues**:
  *Ask me / Ignore / Block* with the note "Only when the scan is on below Full: at Full the security
  reviewer checks each hit."; checkbox **Don't stop for questions: let the agent decide** (with the
  warning when ticked: "Blocking questions will be answered by the agent without asking you.").
- **Advanced** (collapsed): *Keep the working copy after a successful run*.
- **Before you start** (live summary; re-requested via `newrun.plan` 400 ms after any input):

```
 This can spend up to $15.00 (the budget in pipeline.toml; the run stops if it reaches it).
 Config: pipeline.toml        Branch: advpipe/s04-rounding
 ┌ Tests (3 of 5) ───────────────────────────────────────────────────────────
 │ Spec, tests written first and shown to fail, code, then one review. Good for: a contained change with clear behaviour.
 │ 4 agents · 4 calls if all goes well, at most 11 before it asks you.
 │ Level tests, from the work item's front matter. Move the slider to change it.
 │ Security scan: off (the level's default).
 │ Not done at this level:  • No critics in the test and code steps: one review at the end  • No standards review …
 └──────────────────────────────────────────────────────────────────────────
 [ Start (up to $15.00) ]  Cancel     "Agents edit a separate copy of the repo and run its checks. Nothing is merged or pushed."
```

**`planRun(repo, itemsDir, form)`** (port `ui/actions.plan_run`, `_how_much_checking`) returns
`{errors[], warnings[], budget, config_label, branch, level, inherited_level, level_source, scan,
scan_default, scan_source, failures, inherited_failures, bypass, inherited_bypass, agents, calls:[happy,worst],
dropped[], shown_text, budget_text, start_request?}`:

- Effective values by precedence **form → item front matter → config → defaults**, exactly as the engine
  merges them (02 §16); the summary says where each came from.
- **The slider starts at the *inherited* level** (the chosen item's `level:` else config's else Full), and
  re-seeds when the chosen item changes *unless the user has touched it* (an untouched slider must not
  silently override the next item's front matter). The summary says when the slider overrides the item.
- Errors block *Start* (no item picked; item can't be run as it is → "Fix it in the editor"; item missing;
  empty/NUL/too-long task; config outside the repo / missing / invalid → "Config: <first line>"; bad
  level; bad scan or policy value). Warnings don't: the branch already exists ("…so the run makes
  `<branch>-2` or similar").
- **The level is always sent explicitly** (a run never starts at a level nobody saw). Scan flags only
  when On/Off; `scan_failures` only when it differs from what the item/config gives; bypass only when it
  differs. (The engine start request carries merged values; the "only when different" rule matters for
  what is *recorded* as an override vs inherited — keep it so `config.json`'s `[pipeline]` table matches
  the Python behaviour.)
- **The `shown` confirmation.** The form posts `shown = "<level>;<scan on|off>;<policy>;<bypass|ask>"` and
  `budget_shown = "<budget with 2 decimals>"` back with *Start*; `newrun.start` recomputes the plan and
  **refuses** (re-renders the form with "The settings changed since you looked: check them and press
  Start again") if either differs.
- **Console warning box** above *Start* when the login is known/likely Console: "This run uses Anthropic
  Console credits: it can spend up to $15.00 of real money." Subscription: no warning; a usage warning if a
  window is `allowed_warning`/`rejected`.
- On success: `newrun.start` → `{runId}` → navigate to `/runs/<id>` (starting-up panel).
- *(Built, M9.)* The window sends the form and `shown`/`budget_shown`; the host builds the start request from its own plan. What it records: the level always; `security_scan` only when someone set it (the form's On/Off, or the work item's or config's value), else `null` (the level's default); `scan_failures` and `bypass_questions` as their effective values; `name` as the form's, else the work item's. The level, the policy and the checkbox follow the chosen item until the person touches them; *Start* is disabled while the summary is being re-worked (a stale summary can't be started) and while the setup checks fail.

### 5.5 Work items (`/items`)

List of the `.md` files in the repo's items folder (default `work-items`, a per-repo preference, always
inside the repo), grouped by sub-folder (`server/`, `mobile/`), alphabetical. Per item: **name**, **last
run** (the newest run whose `work_item_file` is this file's resolved path: status chip + link), **git
state** chip, and actions **Run**, **Edit**, **Rename**, **Delete**.

- Git state (one `git status --porcelain=v1 -z --untracked-files=all --ignored=matching -- <folder>`):
  `untracked` → "not in git" ("This file has never been committed."), `modified` → "uncommitted" ("Changed
  since the last commit."), `ignored` → "ignored" ("Ignored by git (.gitignore), so it is never
  committed."), clean → no chip. A folder's state covers its files. If git can't tell: no chips.
  **The app never commits.** The owner ruled the folder is a specific one (default `work-items`, never the repo root) and git-ignored: creating an item adds it to `.git/info/exclude` (local, no tracked file changes), so new items normally show "ignored".
- The list walks the folder without following symlinked folders and skipping hidden ones; files whose
  path `itemPath` refuses are listed by name only, "not manageable here".
- Empty state: "No work items yet. A work item is a markdown file describing one task. **Create your
  first**."; if the folder doesn't exist: offer to create it.
- **New work item** button; **Run** opens New run with the item preselected.

### 5.6 Work-item editor (`/items/new`, `/items/edit`)

- **Path** field (new): relative, like `server/s05-refund-window.md`; `.md` added if left off.
- **Run settings** (front matter): *Branch name*, *Pipeline config*, *Level* (select: *inherit*, Basic …
  Full), *Security scan* (inherit/yes/no), *If it finds issues* (inherit/ask/ignore/block), *Don't stop
  for questions* (inherit/yes/no). **`inherit` leaves the key out of the file.**
- **Body** textarea (monospace) with a **live preview** pane (markdown, sanitised) beside it.
- **Inline checks** (`items.check`, debounced): *errors block Save* — empty body; a multi-line field; a
  value `advpipe run` wouldn't accept (checked with the engine's own parsers); *warnings don't* — config
  file missing/invalid/outside the repo; the branch `advpipe/<slugify(name or first line)>` already exists
  ("the run would add -2").
- **Save** and **Save & run** (saves, then opens New run with the item preselected). Saving:
  - **Refuses if the file changed on disk** since the editor loaded it (the form carries the SHA-256 of
    the loaded bytes; mismatch → "This file changed on disk since you opened it. Reload to see the
    changes, or copy yours first.").
  - If the fields parse **equal** to what's on disk, the file isn't touched (front matter round-trips
    **byte for byte**); otherwise it's written with `formatWorkItem`. Textarea CRLF → LF.
  - **Create never overwrites** (`open(..., 'wx')`); **rename refuses an existing target**; `Delete`
    goes to a confirmation page that says whether git still has a copy; only its form sends `confirm`.
- A file that doesn't parse opens in the editor with what could be salvaged (`salvageWorkItem`) and the
  parse error shown, so it can be fixed.
- Max file size 200 000 bytes; max folder depth 4; path rules in [08-SECURITY](08-SECURITY.md) §5.
- *(Built, M9.)* Create and Save re-run the checks in the host and refuse with "Not saved: fix the problems marked below first." even if the window let the click through; the editor's *Save* is disabled while a check says "Problem". Save needs the digest it loaded: no digest, no save. The work-items folder is a per-repo setting (*Folder: change…* on the Work items page); it must be inside the repo and not hidden, and the repo itself is refused. The original's folder and config suggestions (`<datalist>`) are not built. There is no "run it from a terminal" command: *Run…* opens New run.

### 5.7 Confirmation pages

Each states exactly what will happen, the safe button first and focused:

| Action | Text (from `ChoiceView.help` / `clean_info`) |
|---|---|
| **I'll take over** | "Commits the work as it is to the branch `<b>`, removes the working copy and ends the run, so you can check the branch out and finish it by hand." |
| **Stop here** | "Ends the run. Nothing is written to the branch, and it can't be resumed." |
| **Finish as is** | "Ends the run here. Nothing is committed: the work so far stays in the working copy, uncommitted, for you to do with as you please." |
| **Clean up** | Lists the working copy path, the branch, and "N commit(s) that only this branch has" (refused unless *Delete anyway* is ticked); for a finished-as-is run: "its working copy has uncommitted changes that cleaning up would delete" (needs *Delete anyway*); a *Also delete the run's log* checkbox. |
| **Delete work item** | Name, last run, "git still has a copy" / "git has no copy: this can't be undone". |

Only the confirmation page's own control sends `confirm: true`; the host refuses these actions without
it, so a stray call can't skip the page.

### 5.8 Help (`/help`)

*(Built, M11: `app.help` returns the tables; the prose is the original's with the browser, token and terminal wording changed. Sections: the levels table and the rules-by-level table, the steps, the agents (with each role's tools), checks, when a run asks you, subscription or Console credits, statuses, using advpipe, keyboard, where things are stored, money and safety, words, and About with *Open log folder*. The same two items are in the Help menu; About there is a native message box. The "Open log folder" in the original's wording is the host's `<userData>/logs`.)*

The pipeline in plain words, built from the same tables the code uses so it **cannot drift** (a test
checks that every status, role and check is covered): *What advpipe does* · *The steps* (SPEC, TESTS,
CODE, REVIEW, ARBITER, FINAL CHECKS and what each does, from `STAGE` tables) · *Statuses* (every key of
`STATUSES` with `STATUS_NEXT` advice) · *Who does what* (`ROLE_JOBS`, models, tools — real values from
`ROLE_MODEL`/`ROLE_TOOLS`/config defaults) · *What the checks are* (`CHECK_HELP`, defaults) · *Levels*
(the §02 level tables and rules table, built from `SHAPES`) · *Answering questions and Bypass* · *The
security scan and its policy* · *Decision points* · *Logins and limits* (subscription vs Console credits,
usage windows, pausing, API-equivalent) · *Keyboard* · *Where things are stored* (`.advpipe/`, safe to
delete, never committed) · *Safety* (agents run shell commands with your permissions, no sandbox;
nothing is pushed; your code goes to the Claude API) · *Open log folder*.

### 5.9 Notifications and the dock badge

*(Built, M10: `app/main/notify.ts` tracks each run's status per window; a notification is made when a run moves to needs-you or complete, only if the window isn't focused and the preference is on; it shows the run's title and the status label. The badge is the count of runs in needs-you states across windows (it only shows where the OS supports one). Not verified by hand: the e2e build hides its windows. "Needs you" here is needs_human, needs_answers, needs_decision, paused, error and over budget, not `stopped`.)*

If enabled in preferences (default **on**): a desktop notification when a watched run **needs you**
(needs answers / decision / paused / error / over budget) or **completes**, coalesced (one per run per
status change), only when the window isn't focused. Clicking it focuses the window and opens the run.
The dock/taskbar badge shows the count of runs that need you. No notification ever contains agent text
(only the run title and status) — they can be seen over a shoulder.

---

## 6. Display statuses (derived; `run.json` keeps the real status)

Port `ui/runs.py STATUSES` and `display_status` **verbatim** (the texts below are the original's). The
**first matching rule** wins:

```
1. a live process holds run.lock                      → running
2. status == running (no live process)               → stopped
3. status == needs_human:
   ended_by == takeover → handed_over;  finish → finished;  any other ended_by → ended
   awaiting a decision  → (decision.kind == usage_limit ? paused : needs_decision)
   a continuing choice made but not applied           → stopped        // resuming applies it
   awaiting answers, or answers saved but not resumed → needs_answers
4. otherwise                                           → state.status   // complete, needs_human, budget_exceeded, error
```

| Key | Label | Icon | Help text (verbatim) |
|---|---|---|---|
| running | running | ● | An advpipe process is working on this run right now. |
| stopped | stopped | ■ | Interrupted or cancelled part-way through. Continue it with **Resume**. *(was: "…with: advpipe resume <run id>")* |
| complete | complete | ✔ | Finished with all checks passing. The branch is ready for you to review and merge. |
| needs_human | needs you | ⚠ | Stopped for a person to decide: open findings, failing checks, or a blocking question in task.md. The report says which. |
| needs_answers | needs answers | ? | The spec has questions only you can answer. Answer them on the run's page and the same run carries on. |
| needs_decision | needs a decision | ◆ | The run stopped to ask you to choose: another fix pass or take over, ignore or block security scan hits, or begin work without the answers. Choose on the run's page and the same run carries on. |
| paused | paused: usage limit | ⏸ | A usage limit (or the Console credit balance) ran out. The run is paused with its work kept. Add usage or credits, or wait for the reset, then press **Try again** on the run's page, or finish it as it is. |
| handed_over | handed over | → | You took over. The branch has the work as it was, and the working copy is removed. Check the branch out and finish it by hand. |
| ended | ended | ■ | You chose to stop at this point. Nothing was written to the branch, and the run can't be resumed. |
| finished | finished as is | ■ | You finished this run as it was when a usage limit stopped it. Nothing was committed: the work is in its working copy, uncommitted. The run can't be resumed. |
| budget_exceeded | over budget | $ | Hit its dollar limit. Continue with a bigger limit using **Resume**. |
| error | error | ✖ | Stopped by an unexpected error (see the report). It can be resumed. |

## 7. Which actions are valid when (`VALID`)

The host re-checks every action against this table before doing anything; an action that is no longer
valid returns "This run changed since you looked (it's now <status>). Reload." (the original's HTTP 409).

| Displayed status | Actions |
|---|---|
| running | cancel |
| stopped, error, budget_exceeded | resume, clean |
| needs_human | clean |
| needs_answers | answer, clean |
| needs_decision, paused | decide, clean (the *choices* are checked against the decision's kind) |
| handed_over, ended, finished | clean |
| complete | – |

## 8. Notices

After an action the app navigates with a **notice key**; the page maps keys to fixed texts (nothing from
the route is ever shown): `started`, `resumed`, `answered`, `decided`, `handed_over`, `ended`,
`finished`, `cancelled`, `cleaned`, `item_saved`, `item_deleted`, …

## 9. Empty and error states (checklist)

*(Audited in M11 against the built pages: each item below has its text; two were added then: a round panel with no files says so, and an unknown route is a "Page not found" page.)*

Runs list empty · work items empty / folder missing · run not found · run unreadable · starting-up with a
dead process · task.md missing · config.json unreadable (shown raw) · standards doc missing · round files
missing ("not written yet" while live, "missing" when finished) · no usage known · repo has no commits ·
git missing · Claude not found · worktree gone (for Open working copy) · branch gone (for fix/answer:
the engine's message). Every one says what happened and what to do.

## 10. Visual references

`docs/reference/screenshots/`: `runs.png`, `runs-dark.png`, `run-detail.png`, `run-detail-tablet-dark.png`,
`run-needs-you.png`, `run-decision.png`, `new-run.png`, `work-items.png`, `item-editor.png`,
`spec-context.png`, `help.png`. They show the intended information density and hierarchy. **They are
references, not pixel specs**: the desktop app should look native-modern, not like a web page in a
frame (use the full window width sensibly, a persistent left rail or top bar, no browser chrome).
Regenerate equivalents for the new app with `npm run screenshots` (M11).
