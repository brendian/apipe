# advpipe (TypeScript rewrite): adversarial multi-agent coding pipeline, as a desktop app

Takes one work item and drives it through adversarial author/critic agent pairs with deterministic
gates, leaving a git branch ready for human review. This repo is a **ground-up rewrite of the Python
`advpipe`** as an **Electron + TypeScript desktop app**: UI-first, **no operating CLI**, same pipeline,
same on-disk formats. **Status: M0 (foundations and spikes), M1 (contracts and core data), M2 (git and gates) and M3 (runner and stages) done; the next milestone is M4.**

Everything an agent needs is in `docs/`. **Start at `docs/README.md`.**

## Read first, in this order

1. `docs/00-PROJECT_BRIEF.md`: goal, hard requirements, non-goals, decisions already made
2. `docs/11-MILESTONES.md`: the build order; find the next unfinished milestone and its reading list
3. The docs that milestone lists (domain spec, contracts, architecture, UI spec, …)

## Source of truth, in order

1. The **Python source** in `docs/reference/python-original/` (read-only snapshot: `src/`, `tests/`,
   original plans). It is what the pipeline actually does today.
2. The **docs** in `docs/`. If a doc and the Python disagree, follow the Python and **fix the doc in
   the same change**.
3. Your own judgement, last. Don't redesign the pipeline: if you think a rule is wrong, write it under
   "Questions for the owner" in your summary and build what the docs say.

## Layout (planned; see `docs/04-ARCHITECTURE.md` §1)

```
packages/contracts   zod schemas, types, constants, pure derivations (imports only zod)
packages/engine      orchestrator, stages, gates, git, runlog, runner (SDK + fake), read models, worker
packages/app         Electron: main/ (host), preload/ (typed bridge), renderer/ (React UI)
assets/prompts       the nine role system prompts, VERBATIM. Source of truth: never retype or edit
.claude/             Claude Code subagents + skill, copied unchanged (keep in sync with assets/prompts)
fixtures/sample_repo tiny Node target project for tests. Never modify in place; copy it first
docs/                all documentation; docs/reference/ is the read-only Python original
e2e/                 Playwright (Electron) tests, fake agents only
```

## Commands

```sh
npm install
npm run dev            # app with devtools
npm run typecheck      # tsc -b, strict
npm run lint           # ESLint (incl. import boundaries) + Prettier
npm test               # Vitest: contracts, engine, app
npm run test:e2e       # Playwright against the fake-agent build
npm run check:prompts  # assets/prompts == .claude/agents bodies
```

Use **npm workspaces** (pnpm isn't installed; don't add another package manager).

## Design rules (do not drop these)

1. **Orchestrator is code, not an agent.** Deterministic state machine; agents never skip stages.
2. **Tests before code.** The test author sees `task.md` only.
3. **One writer at a time.** Critics and reviewers are read-only and return findings, never edits.
4. **Critics get artifacts, not reasoning:** `task.md`, diff, and gate output only.
5. **Every loop is bounded:** round caps, max turns per agent, and a dollar budget per task.
6. **Critics may return PASS.** Findings must cite file + line or an acceptance criterion.
7. **Ground truth beats opinion.** A failed gate is automatically a blocking finding.

Rules 2, 4 and 6 apply at the levels that have the agents they govern (`docs/02-DOMAIN_SPEC.md` §2);
the default level, `full`, applies all of them. Rules 1, 5, 7 hold at every level.

**Never push, merge, or open PRs. Never touch the user's working tree** (agents work in a git worktree
on an `advpipe/…` branch). Default models: authors and arbiter `claude-opus-5-5`, critics and reviewers
`claude-sonnet-5-5`.

## Project rules

- **UI first, no CLI.** The only command-line surface is `advpipe [repo-path]` (opens the app) and a
  hidden worker entry the app itself starts. Don't add commands, flags or a TUI.
- **Files are the source of truth.** `.advpipe/` formats are in
  `docs/03-DATA_CONTRACTS.md` (they started as the Python POC's; **no backwards compatibility with it is required**). Runs are driven by **detached worker processes** that talk to the app
  only through files; the UI never holds run state of its own.
- **The renderer has no Node.** It imports only `contracts`. The engine never imports Electron. ESLint
  enforces both. All renderer↔main traffic is the typed, zod-validated IPC table.
- **Agent output, work-item text and file contents are untrusted.** Never `dangerouslySetInnerHTML`
  outside the one sanitising `<Markdown>` component. Never build a shell string; argument arrays only.
  See `docs/08-SECURITY.md`; its per-milestone checklist applies.
- **Prompts are verbatim.** `assets/prompts/*.md` and the prompt-builder text in
  `docs/07-PROMPT_TEMPLATES.md` are ported exactly; tests assert on their substrings.
- **User-visible strings are ported verbatim** from the Python (statuses, explanations, errors, report
  text) unless a doc names an exception. UI wording says "checks", not "gates".
- **No API calls in automated tests.** Agents are `FakeAgentRunner`s. A real call needs the owner's
  explicit go-ahead each time (it costs money / uses their subscription).
- **Tests are ported, not invented.** Read the matching Python test file before writing the TS one;
  `docs/10-PORTING_MAP.md` §2 maps them and tracks status.
- **No `any` without a justification comment; no `@ts-ignore`; one copy of zod in the tree.**
- **Don't add dependencies casually.** Pinned versions live in `docs/VERSIONS.md`; update it when you
  change one.
- **Keep unit tests LIGHT. Do not spend forever writing unit tests for every tiny minute change. Only major pieces should be unit tested.
    The last project had almost 1000 unit tests and it ate context and took forever. So we'd like to keep this as simple as possible.

## Working in a session

- Do **one milestone** per session; stop at its end and summarise: what you built, how you verified it,
  what you couldn't check, where docs and Python disagreed, which docs you changed.
- Say plainly what was checked by hand and what wasn't. A UI change isn't verified until you've run the
  app (or the Playwright test) and looked at it.
- Update `docs/10-PORTING_MAP.md` status and the relevant doc when behaviour changes. Docs that drift are
  bugs.
- Keep this file short. Detail belongs in `docs/`.
