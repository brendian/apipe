# 00 · Project brief

## What this project is

**advpipe (rewrite)** is a ground-up rewrite of the Python project `advpipe` as a **desktop
application with a graphical interface**, written in TypeScript. It has no real command-line
interface: people use it by clicking, not by typing commands.

advpipe takes one work item (a feature or a bug fix, written in plain words) and drives it through a
pipeline of AI agents until a branch is ready for human review. The pipeline is built on
**adversarial author/critic pairs**: one agent produces work, a second agent tries to find concrete
reasons it is wrong, deterministic checks (tests, types, lint, a security scan) gate every stage,
every loop is bounded, and an arbiter settles disputes. A person is always the final reviewer and
the only one who merges.

Everything about *what the pipeline does* is already designed, built and tested in the Python
original. **This project changes the language, the shell around the engine, and the way people
operate it. It does not redesign the pipeline.**

## Why a rewrite

| Pain in the Python version | What the rewrite does |
|---|---|
| The UI is a local web server (FastAPI + Jinja2 + htmx) bolted onto a CLI-first tool; it needs a token, CSRF protection, a CSP and a loopback-only guard, all to protect a localhost port | A desktop app. No server, no port, no token. The renderer talks to the engine over a typed, allow-listed IPC bridge |
| Every UI action shells out to the CLI (`advpipe run --detach`, `answer`, `decide`, …) and parses its stdout | The UI calls the engine directly. There is no user-facing CLI to keep in sync |
| Python + a virtualenv + a Claude Agent SDK install is a lot of ceremony for someone who just wants a tool | One installable app. The Claude Agent SDK is bundled |
| Live updates are server-sent events tailing `events.jsonl` | A file watcher in the main process pushes changes to the window over IPC |

## The five hard requirements

1. **Not Python.** The engine and the app are TypeScript (see [01-TECH_DECISIONS](01-TECH_DECISIONS.md)
   for why, and what was rejected).
2. **UI first.** Everything a person needs is done in the window. There is no CLI to operate the
   pipeline. The only command-line surface is: launching the app (optionally with a repo path), and
   an internal, hidden worker entry point used by the app itself (see
   [04-ARCHITECTURE](04-ARCHITECTURE.md)).
3. **The UI is written in something suited to UIs**: React + TypeScript in an Electron renderer,
   with design tokens, light/dark themes and full keyboard/screen-reader support.
4. **Behavioural parity with the Python engine.** Same levels, same stages, same guards, same
   decision points, same bounds, same prompts. The rules in [02-DOMAIN_SPEC](02-DOMAIN_SPEC.md) are
   not up for renegotiation; they were decided over several sessions by the project owner.
5. **Files remain the source of truth.** The `.advpipe/` run directories, `run.json`, `events.jsonl`,
   `config.json`, `report.md`, work-item files and `pipeline.toml` use the formats in
   [03-DATA_CONTRACTS](03-DATA_CONTRACTS.md). They started as the Python version's, but **the owner has ruled
   that the Python project was only a proof of concept: runs and files it made need not open in this app, and
   this app's files need not open there.** Don't spend effort on compatibility; keep the formats unless a
   change is clearly better.

## The design rules that must survive (do not drop these)

These are carried over verbatim from the original `CLAUDE.md` and `BUILD_SPEC.md`:

1. **The orchestrator is code, not an agent.** A deterministic state machine. Agents never skip stages.
2. **Tests before code.** The test author sees `task.md` only.
3. **One writer at a time.** Critics and reviewers are read-only and return findings, never edits.
4. **Critics get artifacts, not reasoning:** `task.md`, the diff, and gate output only.
5. **Every loop is bounded:** round caps, max turns per agent, and a dollar budget per task.
6. **Critics may return PASS.** Findings must cite file + line, or an acceptance criterion.
7. **Ground truth beats opinion.** A failed gate is automatically a blocking finding.

Rules 2, 4 and 6 apply at the levels that have the agents they govern; the default level, `full`,
applies all seven. Rules 1, 5 and 7 hold at every level. See [02-DOMAIN_SPEC](02-DOMAIN_SPEC.md) §2.

Plus two safety rules that hold everywhere:

- **Never push, merge, or open pull requests.** The app *shows* the git commands (with copy
  buttons); a human runs them.
- **Never touch the user's working tree.** All agent work happens in a separate git worktree on its
  own `advpipe/…` branch.

## Scope

### In scope (parity)

Everything the Python version does, as UI affordances (the full mapping is in
[05-UI_SPEC](05-UI_SPEC.md) §3):

- Five **levels** (Basic, Reviewer, Tests, Adversarial, Full), picked with a slider.
- Starting runs from **work-item files** (markdown with simple front matter) or a typed one-off task.
- **Blocking questions**: answer them, or **Bypass** (the agent decides), or **Begin work?** at the cap.
- **Decision points**: failing checks (fix pass / take over), security-scan hits (ignore / block),
  usage limit (try again / finish as is).
- Live **run detail** with timeline, per-round panels (author reply, diff, checks, verdicts), live
  log, rendered report, "next steps" git commands with copy buttons.
- **Spec & context** tab: everything the agents worked from, and who sees what.
- **Work items** manager: list grouped by folder, last run and git state, editor with preview,
  rename, delete (with confirmation).
- **Cancel, resume** (optionally with a bigger budget), **clean up**.
- **Subscription usage** next to the budget, the Console-credits warning, and pausing at a limit.
- Help page, dark/light theme, keyboard focus, responsive down to tablet width.
- Resume/interrupt safety, per-run git worktrees, locks, and the budget hard-stop.

### In scope (additions the desktop shell makes natural)

Kept small and listed separately in the milestones so they never delay parity:

- A repo picker with recent repos; one window per repo.
- A first-run **preflight** screen (is `git` available, is this a git repo with a commit, is Claude
  logged in).
- Desktop notifications when a run needs you or finishes.
- "Reveal in file manager" / "Open in editor" for a worktree.
- Optional later: a form editor for `pipeline.toml`; running several work items at once with a
  concurrency limit.

### Out of scope / non-goals

- **No CLI.** Not for operating runs, not for scripting. (A tiny `gates` command for the Claude Code
  hook example is explicitly deferred; see [11-MILESTONES](11-MILESTONES.md), backlog.)
- **No server mode, no network access, no accounts.** One user, one machine, as decided for the
  original (`UI_PLAN.md` §8: one repo per UI, no other people on the network).
- **No pushing, merging, PRs.** Ever.
- No multi-repo or monorepo-aware task splitting; parallelism is across independent items.
- No language-specific gate logic. Gates are just commands from config.
- No new pipeline stages, roles or levels. Custom shapes were explicitly ruled out.
- No new prompt wording. Prompts are ported verbatim (they are the tuned part of the system).
- Not a re-implementation of the Claude Code subagent/skill version (`.claude/agents`,
  `.claude/skills`). Those are plain Claude Code configuration, not Python; they are copied across
  unchanged (see [10-PORTING_MAP](10-PORTING_MAP.md) §4).

## Who uses it

The project owner, **Brendan** (git author name in the originals), and people like them: developers
who want a well-checked branch from a well-specified task and will review and merge it themselves.
They are comfortable with git. They are not necessarily comfortable with a terminal for *this* tool,
and the UI says "checks" rather than "gates" for that reason.

## Decisions already made by the project owner (settled, don't re-ask)

From the original plans, still binding:

- Saving a work item in the UI does **not** commit it to git; the list shows "uncommitted".
- **One repo per window.** Several windows may be open.
- **Not for other people on the network.**
- Default level is `full`; default budget is $15 per task; critics on a cheaper/different model.
- Fix or take-over applies at every level; at most **3** fix passes per run.
- A usage/credit limit **pauses** the run (Try again / Finish as is); **no automatic retry**.
- Security-scan hits below Full: **ask** the person (ignore or block); the choice sticks for the run.
- *Block* means "treat like a failing test", not "end the run".
- *Take over* commits the work to the branch and removes the worktree.
- Bypass covers **only the stop it was chosen at**; after 3 spec passes ask **Begin work?**.
- Both logins supported (subscription and Console credits); **warn** on Console credits.
- The solo agent uses the author model; one budget for every level; no custom shapes.

New decisions made *for this rewrite* (by the author of these docs, flagged for Brendan's review) are
recorded as ADRs in [01-TECH_DECISIONS](01-TECH_DECISIONS.md). If you disagree with one, change the ADR
before building on it.
