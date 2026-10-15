# Basic usage

A short walk-through for someone using the app. The Help page inside the app has the full tables.

## Before you start

- Install advpipe (see the root `README.md`) and make sure `git` works.
- Sign in to Claude Code once on this machine (advpipe has no sign-in screen of its own).
- Your project must be a git repo with at least one commit.
- Put your project's checks in a `pipeline.toml` at the repo root, for example:

  ```toml
  [gates]
  test = ["npm", "test"]
  types = []
  lint = []
  security = []
  ```

  Without one, the defaults assume a Python project (`pytest`, `mypy`, `ruff`, `semgrep`).

## Run a task

1. **Open a repo.** Start advpipe and choose *Open a repo…* (or run `advpipe /path/to/repo`). The
   welcome screen checks git, the repo and Claude Code. Fix anything it marks red.
2. **Describe the task.** Either press *New work item* (a markdown file, saved in the repo's
   `work-items` folder and kept out of git) or type a one-off task on the *New run* page.
3. **Pick how much checking.** On *New run*, move the slider: Basic (one agent, cheap) to Full
   (everything). If unsure, use Tests for a small change and Full for anything risky.
4. **Check the money line,** then press *Start*. It shows the most the run can spend; it stops there.
5. **Watch it.** The run's page shows a timeline, each step's diff, checks and verdicts, and a live
   log. You can close the window: the run carries on, and reopening the repo shows it.

## When a run needs you

The run's page says what it is waiting for and shows the buttons:

| It says | What to do |
| --- | --- |
| needs answers | Type an answer for each question, tick *Let the agent decide* for ones you don't care about, then *Save answers and continue* |
| needs a decision | Choose: another fix pass (with an optional note) or *I'll take over*; ignore or block scan hits; begin work or stop |
| paused: usage limit | Wait for the reset or add usage/credits, then *Try again*, or *Finish as is* |
| stopped / error | *Resume* |
| over budget | *Resume* with a bigger total budget |

*Cancel* stops a running run at the next safe point; it can be resumed.

## Finish

When a run is **complete**, its page lists *Next steps*: git commands with Copy buttons. Read the
change on the `advpipe/…` branch, merge it yourself, then delete the branch. advpipe never pushes or
merges. Use *Clean up* on runs you no longer need.
