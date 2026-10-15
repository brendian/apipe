# Documentation index

Everything needed to rebuild `advpipe` as a TypeScript desktop app, without access to the author and
without guessing. **Status: docs complete; M0–M11 built (the engine, the app shell, the runs list, the run detail page, new run and work items, the actions and needs-you flows, Help, keyboard, a11y and the full e2e suite). Next: [11-MILESTONES](11-MILESTONES.md) → M12.**

## Reading order

| # | Document | Read it to learn… | Needed for |
|---|---|---|---|
| 00 | [PROJECT_BRIEF](00-PROJECT_BRIEF.md) | what this is, why, the hard requirements, scope and non-goals, decisions already made by the owner | everyone, first |
| 01 | [TECH_DECISIONS](01-TECH_DECISIONS.md) | the stack (Electron + TypeScript + React + the Agent SDK) and why; rejected alternatives; open questions for the owner | M0, anyone doubting a choice |
| 02 | [DOMAIN_SPEC](02-DOMAIN_SPEC.md) | **what the pipeline does**: levels, roles, stages, loops, guards, gates, decision points, questions/Bypass, budget, usage, resume, cancel, clean; the 18 invariants | M1–M6 (the engine) |
| 03 | [DATA_CONTRACTS](03-DATA_CONTRACTS.md) | every schema and on-disk format (`run.json`, config, events, report, run directory layout, `start.json`) | M1 onward |
| 04 | [ARCHITECTURE](04-ARCHITECTURE.md) | packages, process model (detached workers), the IPC contract, live updates, cross-platform notes, scripts | M0, M6, M7 |
| 05 | [UI_SPEC](05-UI_SPEC.md) | **every screen**: layout, data, states, actions, wording; the CLI-to-UI parity table; status tables; accessibility | M7–M11 |
| 06 | [AGENT_RUNNER](06-AGENT_RUNNER.md) | the SDK mapping (verified against 0.3.300), stream handling, limit and login detection, packaging, the spikes to run | M0, M3, M12 |
| 07 | [PROMPT_TEMPLATES](07-PROMPT_TEMPLATES.md) | the exact text of every prompt the code builds | M3, M5 |
| 08 | [SECURITY](08-SECURITY.md) | Electron hardening, IPC rules, untrusted text, path gates, the per-milestone checklist | M0, M7+ |
| 09 | [TESTING](09-TESTING.md) | test layers, fixtures, the scenarios to port, process/IPC/renderer/e2e tests | every milestone |
| 10 | [PORTING_MAP](10-PORTING_MAP.md) | Python module → TS module, Python test → TS test, idiom guide, **28 things that will bite you** | every milestone |
| 11 | [MILESTONES](11-MILESTONES.md) | the build order M0–M12 (+ backlog), each with reading list, scope, tests, done-when | start here to work |

## Reference material (read-only)

[`reference/`](reference/README.md): a snapshot of the Python original (source, tests, its own docs and
plans), its screenshots, and sample config. **It is the tie-breaker** when these docs are silent or wrong.

## What was decided where

- *Why TypeScript/Electron, not Rust/Tauri*: 01 ADR-1/2 (the Claude CLI has no `--max-turns`; the SDK is
  the supported path).
- *Why runs are detached worker processes, not in-app*: 01 ADR-4, 04 §3.
- *Why the on-disk formats are unchanged*: 01 ADR-6/9, 03.
- *Why the IPC surface looks like it does*: 04 §5, 08 §3.
- *What the owner already ruled on (don't re-ask)*: 00 "Decisions already made".

## Keeping the docs true

Docs that drift are bugs. When code behaviour changes, change the doc in the same commit. When the
Python original and a doc disagree, follow the Python and fix the doc. Spike results go into
`06-AGENT_RUNNER.md` and `docs/VERSIONS.md` (created in M0).
