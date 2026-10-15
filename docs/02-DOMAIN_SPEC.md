# 02 · Domain spec: what the pipeline does

This is the behavioural specification of the engine. It is a **language-neutral restatement of the
Python implementation as of 2026-10-15** (levels L0–L6 and the answers plan are all built there).
The Python source is in `docs/reference/python-original/src/advpipe/` and is the tie-breaker: where
this document is silent or ambiguous, read the Python, and where the two disagree, the Python is
right and this document has a bug (fix it).

How to read the references: `[stages.py]` means `docs/reference/python-original/src/advpipe/stages.py`;
`[tests/test_x.py]` means the same folder's `tests/`. Original design rationale lives in
`docs/reference/python-original/docs/*.md`; this file states the *what*, those state the *why*.

Pseudocode is TypeScript-flavoured. `await` marks anything that may take real time.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Work item** | The task text. A file (`.md` with optional front matter) or a typed one-off string |
| **Run** | One work item driven through the pipeline. Has an id, a branch, a worktree, a run directory |
| **Run id** | `YYYYMMDD-HHMMSS-<6 hex>` (UTC), e.g. `20261008-091500-ab12cd`. Matches `^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$`, no `..` |
| **Stage** | `INIT SOLO SPEC TESTS CODE REVIEW ARBITER FINAL_GATES DONE` |
| **Level** | How much checking a run gets: `basic reviewer tests adversarial full` (1–5) |
| **Role** | An agent job: `spec-writer test-author test-critic coder code-critic standards-reviewer security-reviewer arbiter solo` |
| **Gate / check** | A configured shell command (test, types, lint, security). The UI says "checks" |
| **Finding** | A critic/reviewer/gate claim that something is wrong (see [03-DATA_CONTRACTS](03-DATA_CONTRACTS.md)) |
| **Blocking / minor** | Only blocking findings reopen a loop. Minor findings go in the report |
| **Verdict** | `PASS` or `FAIL` plus findings |
| **Round** | One author turn + gates + critic turn inside TESTS or CODE |
| **Settle** | What happens to findings still open when a stage ends (arbiter, one final author pass) |
| **Decision point** | A stop where the run waits for a person to choose one of two things |
| **Bypass** | A person lets the agent answer a blocking question itself |
| **Takeover** | The person finishes by hand: work is committed to the branch, worktree removed, run ends |
| **Worktree** | `<repo>/.advpipe/worktrees/<run-id>`, a git worktree on branch `advpipe/<slug>` |
| **Base commit** | The repo's `HEAD` when the run started; every diff is against it (or a stage commit) |

---

## 2. Levels

A level is a name for a **shape**: five switches the orchestrator reads. Everything the UI says about
a level is derived from this table so the UI, the report and the call-count maths cannot drift
[levels.py].

```ts
type Shape = {
  solo: boolean;               // one agent writes task.md, tests and code in one stage
  critics: boolean;            // TESTS and CODE are author ⇄ critic loops
  review: 'none'|'single'|'full';
  arbiter: boolean;            // still-open/disputed findings go to the arbiter
  securityScan: boolean;       // the DEFAULT for the scan toggle
};
const SHAPES = {
  basic:       { solo: true,  critics: false, review: 'none',   arbiter: false, securityScan: false },
  reviewer:    { solo: true,  critics: false, review: 'single', arbiter: false, securityScan: false },
  tests:       { solo: false, critics: false, review: 'single', arbiter: false, securityScan: false },
  adversarial: { solo: false, critics: true,  review: 'none',   arbiter: true,  securityScan: false },
  full:        { solo: false, critics: true,  review: 'full',   arbiter: true,  securityScan: true  },
};
const LEVEL_ORDER = ['basic','reviewer','tests','adversarial','full'];   // slider positions 1..5
```

| # | Level | Steps (timeline) | Roles it can call | Good for |
|---|---|---|---|---|
| 1 | Basic | SOLO → FINAL CHECKS | solo | typos, renames, a one-line fix, a tiny refactor |
| 2 | Reviewer | SOLO → REVIEW → FINAL CHECKS | solo, code-critic | small bug fixes you'll skim |
| 3 | Tests | SPEC → TESTS → CODE → REVIEW → FINAL CHECKS | spec-writer, test-author, coder, code-critic | a contained change with clear behaviour |
| 4 | Adversarial | SPEC → TESTS → CODE → ARBITER → FINAL CHECKS | spec-writer, test-author, test-critic, coder, code-critic, arbiter | a feature with real logic |
| 5 | Full | SPEC → TESTS → CODE → REVIEW → ARBITER → FINAL CHECKS | all eight pipeline roles (everything except `solo`) | risky, security-relevant or user-facing work |

**Labels and one-liners (shown in the UI, ported verbatim)** [levels.py `LEVEL_INFO`]:

| Level | Label | `description` |
|---|---|---|
| basic | Basic | One agent writes task.md, tests and code in one pass; the checks decide. |
| reviewer | Reviewer | One agent does the work, then a second agent reviews the change once. |
| tests | Tests | Spec, tests written first and shown to fail, code, then one review. |
| adversarial | Adversarial | Spec, then tests and code each checked by a critic, with the arbiter settling disputes. No reviewers at the end. |
| full | Full | The whole pipeline: spec, tests and code with critics, standards and security reviewers, the arbiter, and the security scan. |

**Derived functions (all pure; port verbatim, with their tests)** [levels.py]:

```ts
levelNumber(l)            // 1..5
parseLevel(v: string|number): Level      // name or number; throws "unknown level 'x': use one of basic, reviewer, tests, adversarial, full, or 1 to 5"
rolesFor(l)               // solo? [solo] : [spec-writer, test-author, (test-critic if critics), coder]
                          //   + code-critic if (critics || review=='single')
                          //   + standards-reviewer, security-reviewer if review=='full'
                          //   + arbiter if arbiter
stepsFor(l)               // [SOLO] or [SPEC,TESTS,CODE]; + REVIEW if review!='none'; + ARBITER if arbiter; + FINAL_GATES
scanOn(state)             // state.security_scan ?? SHAPES[state.level].securityScan
levelTag(state)           // '' for full+scan; level name if scan equals the level default; else "<level>, scan|no scan"
droppedSafeguards(l, scan): string[]      // see below
maxAgentCalls(l, limits): [happy, worst]  // see below
```

`droppedSafeguards` (plain-words lines for the report, `New run` summary and Help):

```
if shape.solo:        "One agent writes task.md, tests and code, so tests aren't written before the code and shown to fail"
if !shape.critics:
   review=='none'   → "No second agent checks the change"
   elif shape.solo  → "No critic while the work is done: one review at the end"
   else             → "No critics in the test and code steps: one review at the end"
if review!='full':    "No standards review", "No security review"
if !arbiter && (critics || review!='none'):  "No arbiter: open findings are always sent back to be fixed"
if !scan:             "No security scan"
```

`maxAgentCalls(level, limits)` returns `(happy, worst)` agent calls **between two person decisions**:

```
if shape.solo: happy = worst = 1
else:
  perRound = critics ? 3 : 1                  // author + critic + critic's JSON retry
  settle   = (arbiter ? 2 : 0) + 1            // arbiter + its retry, plus the final author pass
  happy    = 1 + 2*(critics ? 2 : 1)          // spec + (author[+critic]) for tests + same for code
  worst    = 1 + (maxRoundsTests*perRound + settle) + (maxRoundsCode*perRound + settle)
  if critics: worst += 1                      // the test-fix pass
if review != 'none':
  reviewers = review=='full' ? 2 : 1
  settle    = (arbiter ? 2 : 0) + 1
  happy += reviewers
  worst += 2*reviewers + settle
```

With default limits: Full (7, 30), Adversarial (5, 23), Tests (4, 11), Reviewer (2, 4), Basic (1, 1).
A test runs a script that fails as late as possible at every level and asserts the count; keep it
([tests/test_levels.py], [tests/test_tests_level.py], [tests/test_solo.py]).

**Where a level comes from** (highest precedence first): the run's explicit choice (New run slider) →
the work item's front matter `level:` → `[pipeline] level` in the config → `full`. The same order,
independently, for `security_scan`, `scan_failures`, `bypass_questions`. The effective values are
copied into `RunState` **once**, at creation, and **never change** (not on resume, not by any agent).
Runs recorded before levels existed have no `level` and load as `full` with the scan on.

**Design rules by level** (rules 1, 3, 5, 7 hold everywhere; rules 2, 4, 6 apply where the agents
they govern exist):

| Rule | Basic | Reviewer | Tests | Adversarial | Full |
|---|---|---|---|---|---|
| 1 Orchestrator is code | ✔ | ✔ | ✔ | ✔ | ✔ |
| 2 Tests before code (test author sees `task.md` only) | ✘ one agent | ✘ one agent | ✔ | ✔ | ✔ |
| 3 One writer at a time | ✔ | ✔ | ✔ | ✔ | ✔ |
| 4 Critics get artifacts, not reasoning | n/a | ✔ | ✔ | ✔ | ✔ |
| 5 Every loop bounded | ✔ | ✔ | ✔ | ✔ | ✔ |
| 6 Critics may PASS; grounded findings | n/a | ✔ | ✔ | ✔ | ✔ |
| 7 Failed gate = blocking finding | ✔ | ✔ | ✔ | ✔ | ✔ |

(One person-made exception to rule 7: below Full, a person may choose to **ignore** security-scan
hits. It is recorded and reported; no agent can make that choice.)

---

## 3. Roles

| Role | Tools | Model tier | Job | Must not |
|---|---|---|---|---|
| spec-writer | Read, Glob, Grep, Write | author | Explore code; write `task.md` with testable acceptance criteria; flag ambiguity under Open questions (`BLOCKING:` for blockers) | write code or tests |
| test-author | Read, Glob, Grep, Edit, Write, Bash | author | Write tests from `task.md` only; run them; confirm they fail for the right reason | implement the feature |
| test-critic | Read, Glob, Grep | critic | Judge coverage and edge cases; "would a trivially wrong implementation pass?" | edit files |
| coder | Read, Glob, Grep, Edit, Write, Bash | author | Minimal change that makes tests pass; reply to findings with `AuthorResponse` JSON | edit/delete tests |
| code-critic | Read, Glob, Grep | critic | Judge the diff against `task.md` and gate output; return a Verdict; may flag `test-defect`; does the one "single review pass" at Reviewer/Tests | edit files; see author reasoning |
| standards-reviewer | Read, Glob, Grep | critic | Conventions (`CLAUDE.md`, standards doc), scope creep, readability, test quality | re-litigate what `task.md` settles |
| security-reviewer | Read, Glob, Grep | critic | Triage scanner output; injection, authz, secrets, unsafe input, dependency risk | report a scanner hit without checking reachability |
| arbiter | Read, Glob, Grep | arbiter | Rule `fix` or `dismiss` per disputed finding, one-line reason | introduce new findings |
| **solo** | Read, Glob, Grep, Edit, Write, Bash | author | Levels 1–2: write `task.md` first, then tests and code, run the checks; or stop with `BLOCKING:` questions | write code while it has blocking questions |

`READ_ONLY = [Read, Glob, Grep]`; `WRITER = [Read, Glob, Grep, Edit, Write, Bash]`. Model tiers map
to `[models] author | critic | arbiter` in the config (defaults: `claude-opus-5-5`,
`claude-sonnet-5-5`, `claude-opus-5-5`). The role system prompts are in
`assets/prompts/` (already copied verbatim from the original; source of truth) and ship with the engine as `packages/engine/prompts/*.md`.
[runner.py `ROLE_TOOLS`, `ROLE_MODEL`]

Read-only roles genuinely have no editing tool (the SDK's `tools` option limits which tools *exist*),
so rule 3 is enforced by construction, not by asking nicely.

---

## 4. Run state machine

```
status:  running | complete | needs_human | budget_exceeded | error
RESUMABLE = { running, error, budget_exceeded }        // plus special needs_human cases below
stage:   INIT → (SOLO | SPEC → TESTS → CODE) → REVIEW? → ARBITER (only while settling) → FINAL_GATES → DONE
```

Every stop other than `complete`, `budget_exceeded`, `error` and an interrupt is `needs_human`. Decision
points are `needs_human` too, so scripts/readers that look for `needs_human` keep working.

**`Orchestrator.run()`** [orchestrator.py]:

```ts
async run(): RunState {
  runlog.acquireLock()                          // pid in run.lock; refuse if another live pid holds it
  try { await this._run() }
  catch DecisionNeeded d        → this.ask(d.kind, d.findings, d.explanation)       // scan_hits
  catch UsageLimitReached l     → this.askUsage(l)                                  // usage_limit
  catch BudgetExceeded e        → status = budget_exceeded; notes.push(e.message); emit status
  catch Cancelled               → notes.push(`Interrupted during ${stage}`); emit status(status stays 'running'); rethrow
  catch any other               → status = error; notes.push(`${name}: ${msg}`); emit error
  finally {
    state.cost = budget.spent; per-stage cost/calls copied; runlog.writeState(state)
    runlog.writeText('report.md', renderReport(state, waitingOnAnswers))
    emit status {final:true, total_usd}, echo=false         // the last event of every driving process
    runlog.releaseLock()
  }
}
```

**Every run leaves a `report.md`**, including crashed, interrupted and over-budget runs. `run.json` is
rewritten at every transition **and after every agent call**.

**`_run()`** (linear; this is the whole state machine):

```ts
writeState()
ws  = openWorkspace()                                // create (new) or reopen (resume) — §16
ctx = new Context(config, runner, ws, budget, runlog, state, progress, consoleWarned)
shape  = SHAPES[state.level]
author = shape.solo ? SOLO : CODER
kind   = shape.solo ? 'solo' : 'code'
applyRetry(ctx)            // a decided usage_limit 'retry' → ctx.cutOff = true, mark applied
applyScanChoice(ctx)       // a decided scan_hits ignore|block → state.scanPolicy = it; ctx.judgeExisting = true

if shape.solo:
  if 'solo' ∉ commits: enter(SOLO); if !(await solo(ctx)) return; commits.solo = ws.commit('advpipe: solo (task.md, tests, code)')
  else ctx.taskMd = read(worktree/task.md)
else:
  if 'spec' ∈ commits: ctx.taskMd = read(worktree/task.md)  else if !(await spec(ctx)) return
  if 'tests' ∉ commits: enter(TESTS); if !(await stage(ctx, TEST_AUTHOR,'tests')) return; commits.tests = ws.commit('advpipe: tests')
  if 'code'  ∉ commits: enter(CODE);  if !(await stage(ctx, CODER,'code'))        return; commits.code  = ws.commit('advpipe: implementation')

if shape.review != 'none' && 'review' ∉ commits:
  enter(REVIEW)
  fix = take(state,'red_checks','fix',REVIEW)
  if fix: if !(await personFix(ctx, fix, author, kind, 'review')) return
  else:
    if ctx.lastGates empty (resumed): ctx.lastGates = await runGates(config, ws.path, runGateNames(state))
    result = shape.review=='full' ? await reviewStage(ctx) : await singleReviewStage(ctx)
    if !(await settle(result, author, kind, {arbiter: shape.arbiter})) return
  commits.review = ws.changedFiles(ws.head()).length ? ws.commit('advpipe: review fixes') : ws.head()

enter(FINAL_GATES)
fix = take(state,'red_checks','fix',FINAL_GATES);  if fix && !(await personFix(ctx, fix, author, kind, 'fix')) return
gates = await runGates(config, ws.path, runGateNames(state)); noteScannerSkipped(ctx, gates)
runlog.writeJson('final-gates.json', gates)
failed = checkedFindings(ctx, gates)                 // may throw DecisionNeeded (scan_hits, policy 'ask')
if failed.length: ctx.lastGates = gates; askRed(failed, 'the final checks', fixer(author)); return
state.stage = DONE; status = complete
if !keepWorktree: ws.remove(); state.worktreeRemoved = true
```

`enter(stage)` sets `state.stage`, `state.round = 0`, emits `stage` `"== <STAGE>"`, writes state.
`stage(ctx, author, kind)` = if a decided `red_checks fix` is pending at that stage run the person fix;
else `adversarialStage(ctx, kind, {critic: shape.critics})` then `settle(...)`.

The orchestrator **never** decides to skip a stage based on agent output. It skips a stage only if the
stage's key is in `state.commits` (resume).

---

## 5. SPEC stage and blocking questions (levels 3–5)

`task.md` format the spec writer produces (and every critic cites):

```markdown
# Task: <title>
## Goal
## Acceptance criteria
- [ ] AC1: <observable, testable>
## Constraints
## In scope
## Out of scope
## Open questions
- BLOCKING: <a question only a person can answer>
- <a non-blocking question>
```

**`blockingOpenQuestions(taskMd)`**: find the `## Open questions` section
(`^##\s*Open questions\s*$` … up to the next `^##\s` or end, case-insensitive, multiline, dotall); in
it, every line matching `^\s*[-*]\s*(?:\*\*)?BLOCKING(?::\*\*|\*\*:|:)\s*(.+)$` (case-insensitive) is a
blocking question; the captured text, trimmed, is its text. Any other line is not. The UI's
`task.md` renderer must accept **exactly the same forms** (two regexes that must agree: keep them in
`contracts` as one export).

**`spec(ctx)`** [orchestrator `_spec`]:

```ts
cap = limits.maxRoundsSpec                            // default 3
enter(SPEC)
if begin = take(state,'spec_cap','begin',SPEC): return await beginSpec(ctx, begin)
loop:
  number = state.specPasses + 1
  await bypass(ctx, number)                           // §5.2
  given = unapplied(state)                            // answered, not yet used by a revision
  if given.length:
    previousMd = read(runDir/task.md)                 // NOT the worktree's: reopen() wiped it
    state.round = number; emit round `spec pass N/cap: revising task.md with the answers to Q1, Q2`
    runlog.writeJson(`spec/pass-${number}/answers.json`, answered(state))
    prompt = specRevisionPrompt(workItem, previousMd, answered(state))
  else prompt = specPrompt(workItem)
  result = await callAgent(ctx, SPEC_WRITER, prompt, 'spec')
  state.specPasses = number; for q in given: q.applied = true
  write(number==1 ? 'spec/author.txt' : `spec/pass-${number}/author.txt`, result.text)
  stray = ws.changedFiles(baseCommit) − ['task.md']
  if stray: ws.restore(baseCommit, stray); notes.push('Spec writer edited files other than task.md; reverted: …')
  if !exists(worktree/task.md): stop(needs_human, [Finding S1 'spec writer did not produce task.md']); return false
  taskMd = read(worktree/task.md)
  if answered(state).length: taskMd = withAnswersSection(taskMd, state.questions); write it back
  setTaskMd(ctx, taskMd, `spec/pass-${number}`)       // ctx.taskMd, runDir/task.md, spec/pass-N/task.md
  switch (await questionStop(ctx, taskMd, number, `spec/pass-${number}`, solo=false)):
    'stop'  → return false
    'again' → continue
    'go'    → taskMd = withAnswersSection(taskMd, state.questions); write; setTaskMd
  state.commits.spec = ws.commit('advpipe: spec (task.md)'); return true
```

**`questionStop`** decides what the pass's blocking questions mean (used by spec and solo):

```ts
new = newQuestions(blockingOpenQuestions(taskMd), number)     // fresh ids Q<len+1>; a question whose
                                                              // normalised text matches an ANSWERED one is
                                                              // not re-asked: note "Spec writer asked Qn again; its answer stands."
if !new: return 'none'
if state.bypassQuestions:                      // Bypass up front, or after Begin work
   for q in new: q.bypassed = true
   emit questions {ids, answerable:false, bypassed:true}
   if number < cap || (solo && number == cap): return 'again'     // solo gets one more pass past the cap
   await bypass(ctx, number, `${pdir}/bypass.json`); for q in new: q.applied = true
   notes.push('The spec still had blocking questions after N spec pass(es), the limit (limits.max_rounds_spec); the agent decided them and the run went on (Bypass).')
   return 'go'
findings = new.map(q => Finding{id:q.id, severity:'blocking', category:'scope', criterion:'open-question', claim:q.text})
stop(needs_human, findings)
if number >= cap:                              // don't ask them one more time
   explanation = `The spec still has ${n} blocking question(s) after ${number} pass(es). Begin work anyway? The agent will decide these, and any question that comes up later in this run, itself.`
   emit questions {ids, answerable:false}; ask('spec_cap', findings, explanation)
else emit questions {ids, answerable:true}   // "… answer them with: advpipe answer <id>"  → UI: the answer form
return 'stop'
```

`normalise(text)` = lowercase, collapse whitespace, strip trailing `?`, `.`, and spaces [answers.py].

### 5.1 Answering (`answers.ts`) [answers.py; tests/test_answers*.py]

A run is **awaiting answers** when: `status == needs_human`, `stage == (SPEC | SOLO per level)`, that
stage's commit key not in `commits`, `questions` non-empty, `specPasses < cap`, and at least one
question is *pending* (no answer and not bypassed). It is **answers-ready** when the same holds but no
question is pending and (some answer is unapplied or some bypassed question has no answer yet).

`recordAnswers(repo, runId, answers, bypass)` — all-or-nothing, under the run lock:

1. Run exists; `acquireLock` (refuse with "run X is still being driven (…); wait for it to stop").
2. Run is awaiting answers or answers-ready, else a message from `notAnswerableMessage`
   (cap reached → "reword the work item and start a new run"; an open `spec_cap` decision → points at
   Begin work).
3. Branch still exists (else "can't be resumed: its branch … no longer exists (cleaned up?). Start a new run instead.").
4. `checkAnswers`: every question no spec pass has used an answer for yet (`!applied`) must be answered
   **or** bypassed; unknown id → error; already-used id → error; an id both answered and bypassed →
   error; empty after trim → error; > **8 000** chars → error; all together > **24 000** chars → error.
5. Set `answer`, `answered_at`, `applied=false`, `source='person'` for answered; `bypassed=true`,
   `answer=''` for bypassed. `writeState`. Emit `answers` `{ids, bypassed?}`. **Status stays
   `needs_human`**; the caller then resumes.

Old-format runs (questions only as open findings with `criterion == 'open-question'`) are upgraded in
memory by `migrate(state)` before any check.

`withAnswersSection(taskMd, questions)` — **written by code, never an agent** — removes any existing
`## Answers` section (`^##\s*Answers\s*$` … next `^##\s` or end) and appends, after everything:

```markdown
## Answers
Answers from the person who started this run. They override anything above that disagrees.

- **Q1:** <question, one line>
  **Answer:** <answer; later lines indented two spaces so no answer line can start a heading or list item>
```

If **any** answered question has `source == 'agent'`, the intro becomes: `Answers to the blocking
questions. They override anything above that disagrees. Answers marked "agent's best judgement" were
chosen by the agent because the person chose Bypass.`; those answers read `**Answer (agent's best
judgement):** …` followed by `  Reason: <reasoning on one line>`. No answered questions → the body
with no section. It must be **idempotent**, and `blockingOpenQuestions` must never read anything in it
as a question.

### 5.2 Bypass [stages.py `bypass_questions`; tests/test_bypass.py]

At the start of a spec/solo pass, `bypass(ctx, number, rel?)`:

```ts
waiting = bypassed questions with no answer yet; if none, return
role,stage = SHAPES[level].solo ? (SOLO,'solo') : (SPEC_WRITER,'spec')
previousMd = read(runDir/task.md)
await bypassQuestions(ctx, role, waiting, previousMd, stage, rel ?? `${solo ? soloDir() : `spec/pass-${n}`}/bypass.json`)
```

`bypassQuestions`: emit `round` `"the agent decides Q2 itself (Bypass)"`; remember `task.md`'s content;
one JSON call (`callJsonAgent`, retry once) to the role that wrote `task.md` with `bypassPrompt`
([07-PROMPT_TEMPLATES](07-PROMPT_TEMPLATES.md)), parsed as `BypassAnswers`; **revert every file the call
changed** (anything but `task.md`, with a note) and put `task.md` back exactly as it was; for each
question take the agent's `answer`/`reasoning` (answer ≤ 8 000, reasoning ≤ 2 000 chars) or, if missing/blank, the
stand-ins `FALLBACK_ANSWER` = "No answer given; use your best judgement and record the choice under
Assumptions." / `FALLBACK_REASON` = "The agent gave no usable answer when asked, so the run went on without one." (with a run note);
set `source='agent'`, `answered_at`, `applied=false`; write `{asked, answers[{id,answer,reasoning,stand_in}], reply}` to
`rel`; emit `answers {ids, agent:true}`. The bypass reply is **never** shown to later agents: they see
only the Answers section of `task.md` (rule 4).

**Bypass covers only the stop it was chosen at.** A revision's new blocking questions stop the run
again. **Up front** (`bypass_questions` setting) every blocking question is bypassed as it comes up.

### 5.3 Begin work? (`spec_cap`)

When the pass **at the cap** (`number >= cap`) still has blocking questions and Bypass isn't on, the run
stops at a `spec_cap` decision (§12). Choosing **begin**: `state.bypassQuestions = true`, every pending
question gets `bypassed = true`; the spec writer answers them in one bypass call
(`spec/pass-N/bypass-begin.json`); the answers go into `task.md` **without another revision pass**;
note "…you chose to begin work, and the agent decided them."; commit `spec`. Choosing **stop**: the
run ends (`ended_by='stop'`), nothing committed, last `task.md` stays in the run directory, not
resumable. At the cap, answering is refused and the message names *Begin work*.

---

## 6. SOLO stage (levels 1–2)

One agent (`solo`) writes `task.md` first, then tests and code, runs the checks. **One agent call per
entry, no automatic retries.** [orchestrator `_solo`, `_solo_checks`, `_solo_fix`]

```ts
async solo(ctx): boolean {
  taskPath = worktree/task.md; if exists: ctx.taskMd = read it
  if fix = take('red_checks','fix',SOLO): return await soloFix(ctx, fix)
  if b = take('spec_cap','begin',SOLO): begin(b)                       // bypassQuestions = true, pending → bypassed
  if ctx.judgeExisting: ctx.judgeExisting=false; return await soloChecks(ctx, soloDir(newest=true))
  loop:
    number = state.specPasses + 1; await bypass(ctx, number)
    given = unapplied(state); pdir = soloDir()                         // stage-solo/pass-N, N = existing passes + 1
    prompt = given ? (writeJson(`${pdir}/answers.json`, answered(state)); soloRevisionPrompt(ctx, previousMd, answered(state)))
                   : soloPrompt(ctx)
    result = await callAgent(ctx, SOLO, prompt, 'solo'); state.specPasses = number; mark given applied
    write(`${pdir}/author.txt`, result.text)
    if !exists(taskPath): return await soloChecks(ctx, pdir)           // → blocking guard finding
    taskMd = read(taskPath); if answered: taskMd = withAnswersSection(...), write back
    setTaskMd(ctx, taskMd, pdir)
    outcome = await questionStop(ctx, taskMd, number, pdir, solo=true)
    'stop'  → revertAllButTaskMd(ctx,'solo agent','while it had blocking questions'); return false
    'again' → revertAllButTaskMd(...); continue
    'go'    → taskMd = withAnswersSection(...); write; setTaskMd
    return await soloChecks(ctx, pdir)
}
async soloChecks(ctx, pdir): boolean {
  findings = []
  if !exists(worktree/task.md): findings.push(Finding S1 blocking/scope criterion 'guard:task-md' claim 'the solo agent did not produce task.md')
  gates = await runGates(config, ws.path, runGateNames(state)); noteScannerSkipped; ctx.lastGates = gates
  writeJson(`${pdir}/gates.json`, gates); writeText(`${pdir}/diff.patch`, ws.diff(baseCommit, REVIEW_PATHS))
  emit gates; findings += checkedFindings(ctx, gates)                  // may throw DecisionNeeded
  if findings: askRed(findings, "the solo agent's pass", 'solo agent', "The solo agent doesn't retry by itself."); return false
  return true
}
async soloFix(ctx, d): boolean {                                       // a person-requested pass
  number = state.fixPasses + 1; pdir = soloDir()
  emit round `fix pass N/cap: you asked for another pass`
  writeJson(`${pdir}/request.json`, {fix_pass:number, note:d.note, findings:d.findings})
  prompt = authorFindingsPrompt(d.findings, ctx.lastGates, fixPassNote(number)) + fixPassExtra(d.note)
  result = await callAgent(ctx, SOLO, prompt, 'solo'); state.fixPasses = number; d.applied = true
  write(`${pdir}/author.txt`, result.text); refresh task.md Answers section if answered; setTaskMd
  return await soloChecks(ctx, pdir)
}
```

There is **no test-file guard** (one agent owns both) and **no red gate** (tests and code arrive
together). A solo pass that asks blocking questions leaves **nothing changed but `task.md`**
(everything else is reverted with a note). At **Reviewer** the REVIEW step follows the solo commit:
`singleReviewStage`, then `settle(..., SOLO, kind 'solo', arbiter=false)`.

---

## 7. The adversarial loop (TESTS and CODE) [stages.py `adversarial_stage`]

```ts
async adversarialStage(ctx, kind: 'tests'|'code', {critic = true}): StageResult {
  [author, criticRole, cap, label] = kind=='tests' ? [TEST_AUTHOR, TEST_CRITIC, maxRoundsTests, 'Test diff']
                                                   : [CODER, CODE_CRITIC, maxRoundsCode, 'Implementation diff']
  stage = `stage-${kind}`; base = ws.head()
  toAuthor: Finding[] = []; forArbiter: Dispute[] = []; minors = []; testsBase = base; testFixUsed = false
  for rnd in 1..cap:
    state.round = rnd; save(); emit round `round ${rnd}/${cap}` {cap}; rdir = `${stage}/round-${rnd}`
    if rnd==1 && ctx.judgeExisting: ctx.judgeExisting=false; result = {text:'', cost:0}      // judge work as it is
    else:
      prompt = rnd==1 ? authorInitialPrompt(ctx, kind) : authorFindingsPrompt(toAuthor, ctx.lastGates, `Round ${rnd}`)
      result = await callAgent(ctx, author, prompt, stage); write(`${rdir}/author.txt`, result.text)
    pending = []                                           // disputes raised THIS round, judged by this round's critic
    if rnd>1: disputed = parseAuthorResponse(result.text).disputed()
              pending = toAuthor.filter(f => f.id ∈ disputed && !isGate(f)).map(f => Dispute{finding:f, response:disputed[f.id]})
    guard = kind=='code' ? testFileGuard(ctx, testsBase) : []     // reverts test edits BEFORE gates run
    [gates, gateFindings] = await stageGates(ctx, kind)           // tests: red gate; code: runGateNames(state)
    ctx.lastGates = gates; emit gates (+ one `  blocking: <claim>` line per gate finding)
    diff = ws.diff(base, REVIEW_PATHS); write(`${rdir}/diff.patch`, diff)       // exactly what the critic judges
    if critic: verdict = await callCritic(ctx, criticRole, criticPrompt(ctx, kind, label, diff, gates), stage)
               emit verdict; write(`${rdir}/critic.json`, raw)
    else:      verdict = {verdict:'PASS', findings:[]}           // Tests level: the gates decide
    defects = verdict.findings.filter(f => f.category=='test-defect')
    testFailed = gates.some(g => g.name=='test' && !g.passed)
    if kind=='code' && defects && testFailed && !testFixUsed:    // ONCE per stage
       testFixUsed = true; testsBase = await testFixPass(ctx, defects, gates, testsBase, rdir)
       [gates, gateFindings] = await stageGates(ctx, kind); ctx.lastGates = gates; emit `gates after test fix: …`
    writeJson(`${rdir}/gates.json`, gates)
    criticFindings = verdict.findings.map(f => f.category=='test-defect' ? {...f, severity:'minor'} : f)   // never sent to the coder
    found = prefix(guard + gateFindings + criticFindings, `${kind[0].toUpperCase()}${rnd}-`)               // F1 → C2-F1, G-test → C1-G-test, T-guard → C1-T-guard
    minors += found.filter(minor); blocking = found.filter(blocking)
    reflaggedKeys = {matchKey(f) | f ∈ blocking, !isGate(f)} − {null}
    for d in pending: if matchKey(d.finding) ∈ reflaggedKeys: forArbiter.push(d)       // disputed + raised again → arbiter
    arbiterKeys = {matchKey(d.finding) | d ∈ forArbiter}
    toAuthor = blocking.filter(f => isGate(f) || matchKey(f) ∉ arbiterKeys)
    if !toAuthor: break
  state.roundsUsed[kind] = rounds
  emit stage: (forArbiter||toAuthor) ? `${toAuthor ? 'round cap reached':'disputed findings'}: N open finding(s) ${critic ? 'go to the arbiter' : 'are still open'}` {passed:false}
                                     : `${kind} stage passed in R round(s)` {passed:true}
  return {name:kind, passed: !(forArbiter||toAuthor), rounds, openFindings: forArbiter + toAuthor.map(Dispute), minorFindings: minors}
}
```

Rules this encodes (each has a test; port them):

- **Finding ids include the round** so they never collide across rounds.
- **Disputes aren't re-debated.** A disputed finding that the next critic does **not** raise again is
  accepted; one raised again (same `matchKey = (file ?? '', criterion ?? '')`; line numbers excluded
  because they move) goes **straight to the arbiter**.
- **Gate and guard findings can't be disputed** (`isGate`: criterion starts with `gate:` or `guard:`).
- **Test defects go back to the test author once**, never to the coder. The critic's claim never
  clears anything by itself: only the **re-run gates** count. `testFixPass` (below).
- **Minor findings never reopen a loop.**
- **The code critic is told which tests the run wrote** (otherwise it complains "no tests were added").
- **`task.md` is excluded from judged diffs** (`REVIEW_PATHS = ['.', ':(exclude)task.md']`).

`stageGates(ctx, 'tests')` = run `['test']` only; findings = `redGateFindings(result, newTestFiles)`
where `newTestFiles = ws.changedFiles(specCommit, config.paths.tests)`. For `'code'`: run
`runGateNames(state)`, `noteScannerSkipped`, findings = `checkedFindings(ctx, results)`.

`runGateNames(state)` = `['test','types','lint']` plus `'security'` **only when** `level != full` and
`scanOn(state)`. (At Full the review stage runs the scanner itself, for the security reviewer.)

`testFixPass(ctx, defects, gates, testsBase, rdir)`: record non-test files already changed; one
test-author call (`'stage-code'`) with the defect list and gate output (prompt in
[07-PROMPT_TEMPLATES](07-PROMPT_TEMPLATES.md)); save `${rdir}/test-fix.txt`; revert any **non-test** file
changed (restore from HEAD if new, original bytes if previously changed) with a note + `guard` event;
if no test file changed since `testsBase`: emit `test-author changed no tests`, return `testsBase`;
else commit **just those files** (`advpipe: test fix (<rdir with / → space>)`), set
`state.commits.tests` to it (the coder's guard now protects the fixed tests), note "Test author fixed
defective tests: …", emit `test_fix {files}`, return the commit.

`testFileGuard(ctx, base)`: `changed = ws.changedFiles(base, config.paths.tests)`; if none → `[]`; else
`ws.restore(base, changed)` and return one blocking finding `{id:'T-guard', category:'scope',
file:changed[0], line:1, criterion:'guard:tests', claim:'coder modified test files; the changes were
reverted', evidence:'Reverted: a, b'}`. It runs **before** gates, so a reverted edit can't make tests
pass by accident.

---

## 8. Reviews

**Full review** (`review == 'full'`) [`review_stage`]:

1. If `scanOn(state)`: run the `security` gate command (optional gate: skipped, not failed, if the
   tool isn't installed); else a synthetic skipped result with reason `turned off for this run`.
   Emit `gates`; if skipped add the note "Security scanner not run (<reason>); security review used
   the diff alone."; write `review/scanner.json`.
2. `diff = ws.diff(baseCommit, REVIEW_PATHS)`; write `review/diff.patch`.
3. Standards doc = `worktree/<paths.standards_doc>` if it exists else `(no standards doc found)`.
4. Call **both reviewers concurrently** (`Promise.allSettled` semantics: let both finish before raising,
   so a usage limit in one never leaves the other running; a `UsageLimitReached` is re-raised first):
   standards (prompt + standards doc) and security (prompt + `scanner.summary()`). Each through
   `callCritic`. Emit both verdicts; write `review/standards.json`, `review/security.json`.
5. Findings are prefixed `STD-` / `SEC-`; blocking ones become `Dispute`s (no author response);
   `roundsUsed.review = 1`.

**Single review** (`review == 'single'`) [`single_review_stage`]: one `code-critic` call,
`criticPrompt(..., single=true)` over `ws.diff(baseCommit, REVIEW_PATHS)` + `ctx.lastGates` + the list of
test files changed in the run; files `review/diff.patch`, `review/single.json`; findings prefixed
`REV-`; a `test-defect` finding is an ordinary blocking finding here (no test-fix pass); charged to
stage `review`. The "single review pass" flag is **text in the prompt**, never a different system prompt.

No back-and-forth with reviewers; blocking findings go to `settle`.

---

## 9. Settle, the arbiter, final author pass [`_settle`, `arbiter_stage`, `final_author_pass`]

```ts
async settle(result, author, kind, {arbiter = true}): boolean {
  state.minorFindings += result.minorFindings
  if result.passed: return true
  previous = state.stage
  if arbiter:
    enter(ARBITER); rulings = await arbiterStage(ctx, result.openFindings, result.name)
    state.rulings += rulings; writeJson('arbiter.json', state.rulings); note = ARBITER_NOTE; charged = 'arbiter'
  else:
    reason = `no arbiter at level ${state.level}`
    rulings = result.openFindings.map(d => {findingId:d.finding.id, decision:'fix', reason}); emit a `ruling` event per ruling
    state.rulings += rulings; note = NO_ARBITER_NOTE; charged = BUDGET_STAGE[result.name]   // 'stage-tests'|'stage-code'|'solo'|'review'
  toFix = openFindings.filter(d => rulings has {finding id, 'fix'}).map(d => d.finding)
  if toFix:
    remaining = await finalAuthorPass(ctx, author, toFix, kind, {note, stage: charged})
    if remaining: askRed(remaining, previous.value, fixer(author), "The step's rounds, the rulings and a final fix pass didn't clear them.", {stage: previous}); return false
  state.stage = previous; return true
}
```

`arbiterStage(ctx, disputes, label)`: rulings for **gate/guard** findings are `fix` with reason
`failed gate is ground truth`, **no model call**; the rest go in **one** `callJsonAgent(ARBITER, …,
ArbiterRuling)` (retry once) call; save `arbiter-<label>.json`; any finding the arbiter skipped
defaults to `fix` ("no ruling given; defaulting to fix"); unparseable output → everything `fix` with
a note; emit a `ruling` event per ruling.

`finalAuthorPass(ctx, author, findings, kind, {note, stage, extra, rdir})`: prompt =
`authorFindingsPrompt(findings, ctx.lastGates, note) + extra`; one author call charged to `stage`;
write `${rdir ?? 'final-pass-'+kind}/author.txt`; run the **test-file guard** if `kind == 'code'`
(against `state.commits.tests`); `stageGates`; save `…/gates.json`; return `guard + gateFindings`
(findings still failing). **No critic round afterwards**: the gates decide.

---

## 10. Gates [gates.py]

`config.gates` has four named commands (each an argv array; empty = skipped): `test`, `types`, `lint`,
`security`. Defaults: `pytest -q`, `mypy .`, `ruff check .`, `semgrep --error --config auto`. **These
defaults describe the *target* repo, not this project**; a JS project's `pipeline.toml` sets
its own.

- Run from the worktree root, **sequentially**, with `spawn` and an argument array (no shell; its own process group, so a timeout or cancel kills grandchildren too; `ELECTRON_RUN_AS_NODE` scrubbed from the env), `timeout = limits.gate_timeout_s`
  (default 600), capturing stdout+stderr.
- Output kept is the **tail**: last **60 lines**, then last **4 000** characters.
- Empty command → `skipped` (`not configured`). Missing executable (`which` fails) → **failed**, exit
  127, output `<cmd>: command not found` — **except** `security` (the only `OPTIONAL_GATE`), which is
  `skipped` with `<cmd> not installed`. Timeout → exit 124, output tail + `\n[timed out]`.
- `passed = skipped || returncode == 0`.
- `gateFinding(r)` = blocking, category `correctness`, id `G-<name>`, criterion `gate:<name>`, claim
  `Gate '<name>' failed (exit <code>)`, evidence = output tail. **A failed gate is always a blocking
  finding** (rule 7).
- `redGateFindings(testResult, newTestFiles)` — the inverted TESTS gate, in this order:
  no new test files → `G-tests-missing` ("No test files were added or changed", category coverage);
  gate skipped → `G-tests-skipped`; exit 0 → `G-tests-green` ("Tests don't exercise the change: they
  pass before implementation"). Whether tests fail for the **right reason** is the test critic's job.
- `gatesLine(results)` = `"test FAIL, types pass, lint skipped"` (or `none configured`);
  `formatGates` = each result's `summary()`:
  `### <name>: PASS|FAIL (exit N)\n$ <cmd>\n```\n<output>\n```` or `### <name>: skipped (<reason>)`.

**Security-scan policy below Full** [`checked_findings`]: results named `security` that failed are
*hits*; all other failures → `gateFindings`. If no hits, done. Otherwise by `state.scanPolicy`:

- `block` → hits are blocking gate findings too (the author fixes them like a failing test; the scan
  re-runs).
- `ask` (default) → throw `DecisionNeeded('scan_hits', hitFindings, "The security scan reported
  N issue(s). No security reviewer checks them at this level, so some may not be real problems.")`
  (`N` from output `(\d+)\s+(?:code\s+)?findings?`; else "issues"). Caught in `run()` and turned into a
  decision point (§12).
- `ignore` → one **minor** finding `{id:'G-security-ignored', category:'security', claim:'Security
  scan reported issues; ignored by you'}` (with the scan output as evidence), replacing any earlier
  one; the run carries on.

At Full the scan is never asked about (the security reviewer triages it). An uninstalled scanner is
skipped at every level and the report says so once (`noteScannerSkipped`).

---

## 11. Decision points [decisions.py; tests/test_decisions.py]

A decision point is `status = needs_human` with `state.decisions` last element open (no `choice`).

| Kind | When | Choices | Explanation text starts |
|---|---|---|---|
| `red_checks` | checks are red and nothing automatic is left | `fix` (optional note) · `takeover` | "The checks are still failing at …" |
| `scan_hits` | scan failed below Full, policy `ask` | `ignore` · `block` | "The security scan reported …" |
| `usage_limit` | subscription window or Console credits ran out | `retry` · `finish` | see §14 |
| `spec_cap` | cap pass still has blocking questions | `begin` · `stop` | "The spec still has N blocking question(s) after …" |

`ask(kind, findings, explanation, {stage?, usageSnapshot?, billing?})`: append
`Decision{kind, stage: stage ?? state.stage, explanation, findings, usage, billing}`, set
`status = needs_human`, `openFindings = findings`, emit `decision` `"<explanation> Decide with: …"`
`{decision_kind, choice:'asked', decision_stage, choices}`. **The worktree is left exactly as it is.**

`askRed(findings, where, fixer, tried?, {stage?})` builds the `red_checks` explanation:

```
"The checks are still failing at {where}{ ' (gate names, comma separated)' if any gate: criterion }. "
+ ({tried} + ' ' if tried)
+ "Another fix pass by the {fixer}, with the failing output and a note from you if you like (fix pass {used+1} of {cap}); or take over: the work so far is committed to the branch {branch} and the worktree removed, so you can finish it by hand."
```

Where `red_checks` arises: levels 3–5 only **after** the stage's round cap, then `settle`, still red;
and at red final gates. Levels 1–2: right after the solo pass (no retry), after Reviewer's automatic
review-fix pass, and at final gates. **Never earlier.**

**`decide(repo, runId, choice, note='')`** (called by the UI via the host, under the lock):

- Refuse (`DecisionError`, plain-words message) if: run missing; a live process holds the lock; run
  isn't awaiting a decision; `choice` not one of that kind's (`"'x' isn't a choice here: choose a or
  b"`); a note given for any choice but `fix`; note > **8 000** chars; `fix` and
  `fixPasses >= limits.max_fix_passes` ("…has used all N fix passes it's allowed
  (limits.max_fix_passes): take over, or start a new run"); a continuing choice and the branch is gone.
- Record `choice`, `note` (trimmed), `decided_at`.
- **`takeover`**: if the worktree dir exists: commit all changes if any (`advpipe: work in progress,
  handed over (checks failing)`), remove the worktree (`worktreeRemoved = true`), note "Handed over to
  you at <stage>: committed the work as it was and removed the worktree (or: removed the worktree
  (nothing was uncommitted)). The branch <b> has the work as it was." `ended_by = 'takeover'`.
- **`stop`**: `ended_by = 'stop'`, note "Stopped at your choice at <stage>."
- **`finish`**: `ended_by = 'finish'`, note "Finished as is at <stage>. The uncommitted work is in
  <worktree>." Nothing committed; worktree kept.
- `fix | ignore | block | begin | retry`: leave `needs_human`; they apply when the run resumes.
- Write state, emit `decision` `"you chose <choice> (<kind>)"`, rewrite `report.md`.

**Applying on resume** (`current(state)` ignores an *applied* `usage_limit` so an earlier unapplied
choice survives a retry; `take(state, kind, choice, ...stages)` returns the decided, not-yet-applied
decision at one of the stages):

- `fix` → `personFix`: one author pass (test-author for TESTS; coder for CODE/REVIEW/FINAL_GATES; solo
  at levels 1–2) with failing output + the person's note **verbatim**, via `finalAuthorPass(...,
  {note: fixPassNote(n), extra: fixPassExtra(note), rdir: 'fix-pass-N', stage: <charged>})`. `fixPasses`
  and `applied` are set **after** the pass runs (so an interrupted pass reruns on a plain resume). Green
  → carry on from that stage; red → `askRed` again. Charged to the stage's budget key (`stage-tests`,
  `stage-code`, `review`, `solo`; from FINAL_GATES: `fix`).
- `ignore | block` → `applyScanChoice` sets `scanPolicy`, `applied = true`, `ctx.judgeExisting = true`
  so the stage's first round **skips the author call** and judges the work as it is (`ignore` costs no
  extra agent call). Emits a `decision` event.
- `begin` → §5.3. `retry` → `applyRetry`: `applied = true`, `ctx.cutOff = true` (the next call to a
  writing role prepends `CUT_OFF_NOTE`).
- **The worktree at a stop**: `Workspace.reopen(keepChanges = pendingChoice(state))` — no `reset
  --hard`, no `clean` when a continuing choice is pending. If the worktree was deleted meanwhile it is
  recreated from the branch and a note says the uncommitted work was lost.

`checkResumable` refuses a run waiting for a decision (names the choices), refuses `ended_by` runs
("handed over to you / stopped at your choice / finished as it was…; nothing to resume"), accepts a
`needs_human` run whose continuing choice is made (`decisionReady`) or whose answers are all in.

---

## 12. Guards (rules enforced in code, not asked for in prompts)

| Rule | Where | What happens |
|---|---|---|
| Coder must not touch tests | `testFileGuard` | changed files under `paths.tests` reverted **before** gates; blocking `scope` finding |
| Spec writer writes only `task.md` | `spec()` | other changed files reverted (`restore(baseCommit, …)`), noted |
| Solo agent stopped on questions writes only `task.md` | `revertAllButTaskMd` | everything else reverted, noted |
| Bypass call edits nothing | `bypassQuestions` | any file changed reverted; `task.md` restored byte for byte |
| Critics are read-only | `ROLE_TOOLS` | no editing tool exists for them |
| PASS means no blocking findings | `Verdict` validation | a PASS containing blocking findings becomes FAIL |
| Findings must be specific | `Verdict` validation | findings with neither (`file` and `line`) nor `criterion` are moved to `noise`, counted (`noise_dropped`), ignored |
| A broken critic can't silently pass | `callCritic` | two unparseable replies → FAIL with blocking finding `{id:'P1', category:'correctness', criterion:'<role>:output', claim:'critic output unparseable', evidence: tail(raw)}` |
| Test-author fix pass edits only tests | `testFixPass` | non-test changes reverted |
| No agent output sets level / scan / policy / bypass / any decision | design | those come from a person's choice and are copied into `RunState` by code |

**Agent output parsing** [stages.py]: `extractJson(text)`: if trimmed text starts with `{` use it; else the
**last** ```` ```json ``` ```` (or plain fenced) block; else the substring from the first `{` to the last
`}`; else the text. `callJsonAgent`: one call; on parse failure **one retry** with the parse error and the
last 2 000 chars of the reply appended (`"…Reply again with JSON only, matching the <Schema> schema."`);
second failure → `null`. `parseAuthorResponse` is **lenient**: unparseable ⇒ nothing disputed
(retrying an author would re-run its edits).

---

## 13. Budget [budget.py]

`Budget(limit, spent, byStage, callsByStage)`. `add(cost, stage)`: `spent += cost; byStage[stage] +=
cost; callsByStage[stage]++; if spent > limit → throw BudgetExceeded(spent, limit)` with message
`budget exceeded: $X.XX spent, limit $Y.YY`. Called after **every** agent call (also for a call that
ended in a usage limit: the cost so far counts). `remaining = max(limit − spent, 0)` is passed to each
agent as `maxBudgetUsd`, so one runaway agent is stopped by the SDK too. The budget applies at every
level and for every login: for a subscription login the dollar figure is an **API-equivalent
estimate** and still caps the run (rule 5 is independent of the login). `resume --budget N` sets a
new **total** (must be finite, > 0, and greater than what's already spent), and is written back to
`config.json` so the UI and later resumes see it. Budget stage keys: `spec solo stage-tests stage-code
review arbiter fix`.

---

## 14. Usage limits and login [usage.py; tests/test_usage.py]

- The runner raises **`UsageLimitReached{billing, snapshot, cost, auth, rateLimits}`** when the SDK
  reports a rejected subscription window, a `rate_limit` or `billing_error` assistant error, or an
  HTTP-429 result error (details: [06-AGENT_RUNNER](06-AGENT_RUNNER.md) §5). It can fire from **any**
  agent call (inside the concurrent reviewers, inside a JSON retry, inside `settle`), and is caught
  **only** in `run()`, like `BudgetExceeded`.
- `callAgent` on a limit: note usage, `budget.add(limit.cost)`, `save()`, emit `agent_done` (`is_error`
  true, "stopped by a usage limit"), re-raise. `run()` → `askUsage` → `ask('usage_limit', [],
  limitExplanation(stageWords, snapshot, billing), {usageSnapshot, billing})`.
- **Explanation** [usage.py `limit_explanation`]: Console credits: "Your Anthropic Console credit balance
  ran out during the <stage> step. Add credits (<ADD_CREDITS_URL>), then press Try again. <tail>";
  subscription with a snapshot: "Your Claude subscription's <window noun> was reached during the <stage>
  step. It resets at <time>. Add extra usage to your plan (<ADD_USAGE_URL>), or wait for the reset, then
  press Try again. <tail>"; no details: a generic variant. `<tail>` = "Or finish the run as it is: the
  work so far stays in the worktree, uncommitted, for you to do with as you please." Fixed URLs:
  `https://claude.ai/settings/usage`, `https://platform.claude.com/settings/billing` (constants,
  **never built from run data**).
- **`retry`**: resume; the interrupted stage restarts at round 1 **with its partial work kept** and the
  author's first prompt prefixed with `CUT_OFF_NOTE` = "A previous attempt at this step was cut off by
  a usage limit; the worktree has its partial changes; carry on from them." Applies to roles
  `spec-writer, test-author, coder, solo`. **No automatic waiting or retry loop**: if the limit is still
  in force the run pauses again.
- **`finish`**: end as is (`ended_by='finish'`); nothing committed; worktree kept; not resumable.
  `clean` then refuses the dirty worktree without `force`.
- **`allowed_warning`** snapshots add a note ("Approaching the 5-hour limit (62% used, resets 14:00)")
  and a `usage` event; the run carries on.
- **Login** (`LoginKind = console | subscription | unknown`) is recorded per call
  (`RunState.auth`) and in the repo-wide cache `.advpipe/usage.json`. Detection order and the TS SDK's
  actual `apiKeySource` semantics: [06-AGENT_RUNNER](06-AGENT_RUNNER.md) §6. **Silence never means
  Console.**
- **Console warning**: when the login is known or likely Console (`ANTHROPIC_API_KEY` set, or cache says
  console) the UI warns before any action that starts agent work ("this run uses Anthropic Console
  credits, which is real money. It can spend up to $15.00 …"); when it only becomes known after the
  first call, a run note and a `usage` event record it. A warning, **never a confirmation prompt**.
- **Snapshots are sparse** (sent when status changes). The UI shows "last known, with its age", never
  a live gauge. A snapshot past its `resets_at` shows "reset since; usage unknown".
- Labels: Console → "real money"; subscription → "API-equivalent, not billed"; unknown → "API-equivalent
  if you're on a subscription".

---

## 15. Resume, locking, cancel, clean

**Run lock.** `run.lock` contains the pid of the driving process. `lockHolder()` = that pid if the
process is alive, else none (a stale lock never blocks). `acquireLock(pid?)` refuses if another live
holder exists. `releaseLock()` removes it. **Always use `lockHolder()`/`isThisProcess()`, never raw
signals, for liveness.** (In Node, `process.kill(pid, 0)` is a liveness probe on every OS; the Python
version's Windows `os.kill(pid, 0)` bug does not apply, but write a test for it.)

**Resume** [`Orchestrator.resume`, `check_resumable`, `check_same_shape`]:

1. `checkResumable(repo, runId, {lockedForMe})`: run.json exists; `migrate`; if `needs_human`: refuse
   `ended_by`, refuse awaiting-decision, accept decision-ready or answers-ready (checking the branch
   exists), else "nothing to resume"; else status must be in `RESUMABLE`; refuse if another live pid
   holds the lock ("is still being driven by pid N").
2. Use the run's saved `config.json` unless one is given; **a given config must not change the run's
   level, scan setting or bypass setting** (`checkSameShape` refuses: "run X is at level basic; a resumed
   run keeps its level. Start a new run to change it"). The config used is rewritten so the run's own
   values win.
3. Restore the budget's spent amount and per-stage totals; `--budget` overrides the limit.
4. `openWorkspace` (resume branch): note "Resumed at stage S", emit `run_start`, `status = running`,
   `openFindings = []`, rewrite `config.json`; `Workspace.reopen(repo, worktree, branch, keepChanges)`.
5. `_run` skips every stage whose key is in `commits`; the interrupted stage restarts at round 1.

**Cancel** (the new unified mechanism, `WINDOWS_PLAN.md` §1): `cancelRun(repo, runId)` verifies the run
has a live lock holder that "looks like" an advpipe worker, then writes `<runDir>/cancel`. The worker
checks for that file between agent calls and gates **and** polls it while an agent call is in flight;
on seeing it, it aborts the call (SDK `AbortController`), records "Interrupted during <stage>", keeps
`status = running`, writes `run.json`/`report.md`, releases the lock, deletes `cancel`, exits 130. The
host force-ends the process tree if the lock is still held after a grace period (10 s default). The
run is then resumable. Git calls are never cut off halfway (they're short and awaited).

**Clean** (`cleanRun(repo, runId, {force, logs})`) — all checks before any deletion:

- Refuse `complete` runs ("branch <b> is its result. Delete it with git once you're done with it.").
- Refuse active runs (live lock holder; `force` does **not** override).
- The worktree must be under `<repo>/.advpipe/worktrees/` (defence in depth, whatever `run.json` says).
- If `ended_by == 'finish'`, `!force`, worktree exists and `git status --porcelain` non-empty → refuse
  and say what would be lost.
- The branch must start with `advpipe/`. Unless `force`, refuse a branch with commits no other local
  branch has (`git rev-list --count refs/heads/B --not --exclude=B --branches`).
- Then: `git worktree remove --force <wt>`, `git worktree prune`, `git branch -D <branch>`; with `logs`
  delete the run directory; else set `worktreeRemoved`, add note "Cleaned up: …", rewrite `run.json`
  and `report.md`.

**Branch naming** [workspace.py]: `advpipe/` + `slugify(name ?? firstLineOfWorkItem)`, with `-2`, `-3`, …
appended if the branch exists. `slugify`: first non-empty line, lowercase, `[a-z0-9]+` words, drop
`STOP_WORDS` (a an and as at by for from in into of on or so that the this to with) unless nothing else
remains, join with `-` stopping before exceeding **40** chars at a word boundary; `"work"` if nothing
usable. `.advpipe/` is added to `.git/info/exclude` (a local, untracked ignore file) so run artifacts
never show in `git status`. Worktree directory is `<repo>/.advpipe/worktrees/<run-id>` (**by run id**,
not branch).

---

## 16. Work items, front matter and precedence [workitem.py; tests/test_workitem.py]

A work-item file is markdown with an optional front-matter block:

```markdown
---
name: s03-stock
config: pipeline.server.toml
level: adversarial
security_scan: no
scan_failures: ask
bypass_questions: no
---
Add stock level changes with a change history...
```

Strict, hand-parsed (`^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$` per line; no YAML). Errors always name
`file:line`: unknown key (lists known keys), repeated key, empty value, malformed line, front matter that
never closes, **empty body**, bad `level`, bad yes/no (`yes true no false`), bad `scan_failures`
(`ask ignore block`). `KEYS` order = `name, config, level, security_scan, scan_failures,
bypass_questions`. `formatWorkItem` writes front matter only for set fields, in that order, then the
body and exactly one trailing newline; a body whose first line is `---` gets an empty block; values
must be single-line with no surrounding spaces. `parse(format(x))` must equal `x`. `salvageWorkItem`
extracts what it can from a file that doesn't parse, so the editor can open it to fix it.

**Precedence** (identical for `name`, `config`, `level`, `security_scan`, `scan_failures`,
`bypass_questions`): explicit run choice → front matter → `[pipeline]` config → defaults. A
front-matter `config` is relative to the repo root and must be an existing file. `RunState.work_item`
= the body; `RunState.work_item_file` = the file's absolute path (so the UI can show each item's last
run).

---

## 17. Config [config.py]

```toml
[models]   author = "claude-opus-5-5"  critic = "claude-sonnet-5-5"  arbiter = "claude-opus-5-5"
[limits]   max_rounds_spec = 3   max_rounds_tests = 2   max_rounds_code = 3   max_turns_per_agent = 40
           budget_usd_per_task = 15.0   gate_timeout_s = 600   max_fix_passes = 3
[gates]    test = ["pytest","-q"]  types = ["mypy","."]  lint = ["ruff","check","."]
           security = ["semgrep","--error","--config","auto"]
[paths]    tests = ["tests/"]   standards_doc = "CLAUDE.md"
[pipeline] level = "full"  # security_scan = true  scan_failures = "ask"  bypass_questions = false
```

Every table rejects unknown keys (typos fail loudly). `level` accepts a name or 1–5 (stored as the
name). Positive-int/float constraints on limits. Config is read from `--config`-equivalent path, else
`<repo>/pipeline.toml`, else defaults. Each run saves its **effective** config as `config.json`
(including the merged `[pipeline]`), and a resumed run uses that.

---

## 18. Testable invariants (every one needs a test; most exist in the Python suite)

Port these as parametrised tests across all five levels [tests/test_level_invariants.py]:

1. With no level anywhere and no new stop reached, a run is `full` with the scan on, and its prompts,
   files, events and report are what the original produced.
2. At every level `complete` requires green final gates; a failed gate is a blocking finding (the only
   exception: scan hits a person chose to ignore, recorded).
3. At every level blocking questions stop the run unless Bypass was chosen for that stop, *Begin
   work* at the cap, or Bypass up front. A Bypass never answers questions asked after it.
4. Every decision point waits for a recorded person choice (or an up-front policy); fix passes never
   exceed `max_fix_passes`.
5. At levels 3–5 a `red_checks` decision is reached only after the round cap and `settle`; never earlier.
6. At a decision point the worktree is untouched; resuming after a decision keeps it; `finish` commits nothing.
7. A usage limit or credit error never ends a run `error` or `complete`: it always pauses.
8. Between two person decisions, agent calls never exceed `maxAgentCalls(level, limits).worst`, and the
   happy path makes exactly `.happy`.
9. Only roles in `rolesFor(level)` are ever called.
10. Wherever a critic/reviewer is called its prompt contains `task.md`, the diff and gate output and **no
    author reply and no bypass reply**.
11. At levels 3–5 the test author's prompt contains `task.md` and no implementation; the test-file
    guard and red gate run.
12. A solo pass that asks blocking questions leaves no file changed but `task.md`.
13. Agent answers and ignored scan hits are marked as such in `task.md`, `report.md`, status, and every
    UI page that shows them.
14. Level and scan setting never change during a run, including across resume.
15. No agent output can set the level, scan, policy, Bypass, or a decision.
16. Console-login runs record cost exactly as before and always show the warning; usage snapshots never
    change budget logic.
17. `blockingOpenQuestions` never reports anything from the Answers section; `withAnswersSection` is idempotent.
18. Every answer/note/agent text that reaches a screen is escaped; nothing from a file, an agent or the
    UI ever reaches a shell (argument arrays only).

---

## 19. Text that names CLI commands (the one sanctioned wording change)

The Python messages tell a person to type commands (`advpipe answer <id>`, `advpipe decide <id> fix |
takeover`, `advpipe resume <id>`, `advpipe cancel <id>`, `advpipe clean <id>`, `--budget N`). The
rewrite has no such commands, so **every string that names one is reworded to point at the UI**; every
other word stays verbatim. The places (grep the Python for `advpipe ` inside strings to find them all):

| Where | Python | TypeScript |
|---|---|---|
| `questions` event, `answerable: true` | "…answer them with: advpipe answer <id>" | "…answer them on the run's page." |
| `decision` event when asked (`ask()`) | "<explanation> Decide with: advpipe decide <id> a \| b" | "<explanation>" (the decision panel shows the choices) |
| `NotResumable` for a run waiting on answers / a decision | "…waiting on answers to Q1: advpipe answer X" / "…waiting for a decision: advpipe decide X fix \| takeover" | "…waiting on answers to Q1: answer them on the run's page" / "…waiting for a decision: choose on the run's page" |
| `DecisionError`/`AnswerError` messages naming a command | "…advpipe decide X begin \| stop" | "…choose *Begin work* or *Stop here* on the run's page" |
| `spec_cap` question message | "… Decide with: advpipe decide <id> begin \| stop" | "…" without the command |
| Interrupt status event | "interrupted; resume with: advpipe resume <id>" | "interrupted; press Resume to continue" |
| `report.md` Notes | "…advpipe answer <id>" / "…Decide with: advpipe decide <id> a \| b" | "The spec has blocking questions. Answer them on the run's page." / the explanation alone |
| `report.md` Decisions, open decision | "(waiting for you: advpipe decide <id> a \| b)" | "(waiting for you: choose on the run's page)" |
| `clean` refusals | "stop it first: advpipe cancel X" / "Pass --force to delete them anyway." | "cancel it first" / "Tick *Delete anyway* to delete them." |
| Console warning | "…change it with --budget" (several runs: "…change each with --budget") | "…change it when you resume the run" (several runs: "…change each when you resume the run"; New run shows the budget from the config) |
| `status` / summary lines | CLI-only | not produced (the worker prints only a one-line final summary to `console.log`) |

Machine-readable fields (`choices`, `decision_kind`, ids, statuses) are unchanged. Anything that parses
messages (nothing in the app should) must not rely on the command text. Tests for these messages assert
the *new* text.
