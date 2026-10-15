# Reference: the Python original

A **read-only snapshot** of the project being rewritten, copied from the sibling directory `advpipe/`
on 2026-10-15 (git history, virtualenv and caches excluded, vendored htmx removed). It exists so the
rewrite is self-contained: nothing here depends on that directory staying where it is.

**Do not edit anything under `reference/`.** If the Python version changes later, take a fresh snapshot
and diff it.

| Path | What it is | Use it for |
|---|---|---|
| `python-original/CLAUDE.md`, `BUILD_SPEC.md`, `README.md` | the original brief, build spec and the full user guide | intent, wording of user-facing text, the FAQ/troubleshooting to adapt for the new README |
| `python-original/docs/ARCHITECTURE.md` | how the Python works, end to end | the "why" behind every module |
| `python-original/docs/LEVELS_PLAN.md`, `ANSWERS_PLAN.md`, `UI_PLAN.md`, `WINDOWS_PLAN.md` | the design plans, with the owner's decisions inline | rationale; decisions already made; the cancel-by-file design |
| `python-original/src/advpipe/` | **the implementation** (≈ 8 000 lines of core + ≈ 4 000 of web UI) | the tie-breaker for behaviour and exact strings |
| `python-original/src/advpipe/prompts/` | the nine role prompts | already copied to `/assets/prompts/` |
| `python-original/src/advpipe/ui/` | the web UI: routes, view-model builders, templates, CSS | the UI's derivations (`runs.py`, `detail.py`, `context.py`, `items.py`, `actions.py`, `live.py`, `render.py`) and `static/app.css` for the visual language |
| `python-original/tests/` | ≈ 10 700 lines of tests; `fakes.py`, `conftest.py`, `advpipe_fake_child.py` | **the executable spec**; port them ([../10-PORTING_MAP.md](../10-PORTING_MAP.md)) |
| `python-original/.claude/` | subagents and the `adversarial-build` skill | copied unchanged to `/.claude/` |
| `python-original/pipeline.example.toml`, `../pipeline.example.toml` | example config | the config shape |
| `claude-hooks.json` | optional Claude Code `PostToolUse` hook that ran `advpipe gates` | backlog (hook CLI) |
| `screenshots/` | the Python web UI, light/dark/tablet | visual and informational reference for [../05-UI_SPEC.md](../05-UI_SPEC.md) |

## Running the Python original (only to produce golden runs)

Not needed for day-to-day work. For [../09-TESTING.md](../09-TESTING.md) §5, in a **scratch directory
outside this repo**: create a venv, `pip install -e 'python-original[dev]'`, and drive its orchestrator
with its own `FakeAgentRunner` (see `python-original/tests/fakes.py` and `test_orchestrator.py` for how).
It needs Python 3.11+. It makes no API calls with the fake runner.

## Things in the original that deliberately do **not** carry over

- `cli.py` and every CLI flag/exit code (the UI replaces them; parity table in [../05-UI_SPEC.md](../05-UI_SPEC.md) §3).
- `ui/security.py` token/CSRF/Host/CSP middleware, `ui/app.py`, FastAPI routes, htmx and the SSE extension
  (no server in the rewrite; see [../08-SECURITY.md](../08-SECURITY.md)).
- `pyproject.toml`, `uv`/venv instructions, `mypy`/`ruff` configuration.
- The Python sample repo (replaced by a Node one in `/fixtures/sample_repo`).
