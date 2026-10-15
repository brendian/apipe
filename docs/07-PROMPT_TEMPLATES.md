# 07 · Prompt templates (what each agent is sent)

There are two kinds of prompt text:

1. **Role system prompts**: one markdown file per role (`assets/prompts/<role>.md`, already copied verbatim from the
   original; shipped with the engine as `packages/engine/prompts/`). **Do not retype them. Do not edit, reflow, "improve" or
   re-wrap them.** They are the tuned part of the system, and a test compares them to
   `.claude/agents/*.md` bodies (the original's `test_subagents_in_sync_with_prompts`). `assets/prompts` is
   the source of truth; `.claude/agents/<role>.md` = a frontmatter block + the same body.
2. **User prompts** built in code (this file). They are assembled by `packages/engine/src/stages/prompts.ts`.
   The text below is the Python `stages.py`'s, transcribed. **Parity tests assert on substrings of these**
   (the original's tests check, e.g., that a critic's prompt contains `task.md`, the diff and gate
   output and *no* author text), so keep wording and section order exactly. Where this file and
   `stages.py` differ, `stages.py` wins.

Conventions: `fence(text, lang='')` = `` ```lang\n<text with trailing whitespace trimmed>\n``` ``.
`ctx.taskMd` = the current `task.md` (with its Answers section). `gateCommands(config, names)` =
one line per **configured** gate `- <name>: \`<argv joined by spaces>\``, or `- (none configured)`.
`formatGates(results)` is in [02-DOMAIN_SPEC](02-DOMAIN_SPEC.md) §10.

---

## 1. Spec writer

**First pass** `specPrompt(workItem)`:

```
Work item: {workItem}

The target repository is your current working directory. Write task.md at the repository root.
```

**Revision** `specRevisionPrompt(workItem, previousTaskMd, questions)` (after answers; `qa` = for every
question **with an answer**, in order, joined by a blank line: `"{id}: {text}\nAnswer{marker}: {answer}"`
where `marker` = ` (your own best judgement: the person chose Bypass)` when `source == 'agent'`, else
empty):

```
Work item: {workItem}

The target repository is your current working directory.

You wrote the task.md below, and the run stopped on its BLOCKING open questions. The person who started the run has now answered them.

# Your previous task.md

{fence(previousTaskMd.trim() || '(missing)', 'markdown')}

# Questions and answers

{qa}

Revise the spec: write the complete task.md again at the repository root, following the section "Revising after answers" in your instructions.
```

The previous `task.md` is read from the **run directory** (`<runDir>/task.md`), because `Workspace.reopen`
wiped the worktree's uncommitted copy.

## 2. Solo agent

`soloTail(ctx)`:

```
# Gate commands (run from repo root)

{gateCommands(config, runGateNames(state))}

Test paths: {config.paths.tests joined by ', '}.
```

**First pass** `soloPrompt(ctx)`:

```
Work item: {state.work_item}

The target repository is your current working directory. Write task.md at the repository root first, then do the work, as your instructions say.

{soloTail}
```

**Revision** `soloRevisionPrompt(ctx, previousTaskMd, questions)`:

```
Work item: {state.work_item}

The target repository is your current working directory.

You wrote the task.md below, and the run stopped on its BLOCKING open questions. They have now been answered.

# Your previous task.md

{fence(previousTaskMd.trim() || '(missing)', 'markdown')}

# Questions and answers

{qa  // all answered questions, same format as §1}

Write the complete task.md again at the repository root, following the section "Revising after answers" in your instructions, and then do the work.

{soloTail}
```

## 3. Bypass (agent answers its own blocking questions)

`bypassPrompt(workItem, taskMd, questions)` (`listed` = `"{id}: {text}"` per question, newline-joined):

```
Work item: {workItem}

The target repository is your current working directory.

You wrote the task.md below and marked the questions listed after it BLOCKING. The person who started the run has chosen to let you decide them yourself.

# Your task.md

{fence(taskMd.trim() || '(missing)', 'markdown')}

# Questions to decide

{listed}

Answer every question with your best judgement: read the code if it helps, pick the answer a careful engineer would pick, and give a one-paragraph reason. Do not edit or create any file. Reply with JSON only, in this shape:

{fence('{"answers": [{"id": "Q1", "answer": "...", "reasoning": "..."}]}', 'json')}
```

Sent to the role that asked (spec writer; solo agent at levels 1–2), via `callJsonAgent` with
`BypassAnswers`. The call's cut-off flag is suppressed (a bypass call mustn't carry "carry on from
partial work").

## 4. Test author / coder / solo — author prompts

**Initial** `authorInitialPrompt(ctx, kind)`, parts joined by `\n\n`:

```
# task.md

{ctx.taskMd}

# Gate commands (run from repo root)

{gateCommands(config, runGateNames(state))}
```
then, **tests**: `Write the tests now. Test paths: {paths}. This is round 1.`
**code**:
```
# Tests written for this task

{one "- file" per ws.changedFiles(specCommit, paths.tests), or "- (none)"}

Implement the change now. Do not modify anything under: {paths}. This is round 1.
```
(`paths` = `config.paths.tests` joined by `, `.)

**Findings** `authorFindingsPrompt(findings, gates, note)` (round ≥ 2, final author pass, fix pass):

```
# {note}

Blocking findings to address:

{fence(JSON.stringify({verdict:'FAIL', findings: findings.map(dump)}, null, 2), 'json')}

# Latest gate output

{formatGates(gates)}

Fix or dispute each finding (failed gates cannot be disputed), re-run the gates, then reply with AuthorResponse JSON only.
```

`note` values: `Round {n}` · `Final pass: the arbiter ruled these must be fixed` (`ARBITER_NOTE`) ·
`Final pass: these findings are still open and must be fixed` (`NO_ARBITER_NOTE`) · `Fix pass {n}: a
person asked for another pass at the failing checks` (`fixPassNote(n)`).

**A person's note** `fixPassExtra(note)` is **appended** to the findings prompt (empty note → empty string):

```


A person asked for this pass and left you this note:

{fence(note.trim())}
```

**Cut off by a usage limit** (`ctx.cutOff`, set by *Try again*): the next call to a role in
`{spec-writer, test-author, coder, solo}` is prefixed with

```
A previous attempt at this step was cut off by a usage limit; the worktree has its partial changes; carry on from them.

```
and the flag is cleared.

## 5. Critics

`criticPrompt(ctx, kind, diffLabel, diff, gates, {single})`:

```
# task.md

{ctx.taskMd}{context}

# {diffLabel}

{fence(diff || '(empty diff)', 'diff')}

# Gate output

{formatGates(gates)}

Reply with Verdict JSON only.
```

`diffLabel`: `Test diff` (tests stage), `Implementation diff` (code stage), `Full diff` (single review).

`context` (note the leading blank line):

- `single` → 
  ```
  

  # Review

  This is a single review pass: judge the whole change once; there won't be another round.

  # Test files changed in this run (part of the diff below)

  {"- file" per ws.changedFiles(baseCommit, paths.tests), or "- (none)"}
  ```
- else if `kind == 'code'` →
  ```
  

  # Tests written in the previous stage (not part of this diff; the coder may not modify them)

  {"- file" per ws.changedFiles(specCommit, paths.tests), or "- (none)"}
  ```
- else (tests stage) → empty.

The diff is `ws.diff(base, REVIEW_PATHS)` with `REVIEW_PATHS = ['.', ':(exclude)task.md']`, truncated at
**60 000** characters with `\n[diff truncated]\n`. Critics are never given the author's reply.

## 6. Reviewers (Full)

```
{base} = "# task.md\n\n{ctx.taskMd}\n\n# Full diff\n\n{fence(diff,'diff')}\n\n# Gate output\n\n{formatGates(ctx.lastGates)}"

standards: {base}\n\n# Standards doc ({config.paths.standards_doc})\n\n{doc}\n\nReply with Verdict JSON only.
security:  {base}\n\n# Security scanner output\n\n{scanner.summary()}\n\nReply with Verdict JSON only.
```

`doc` = the standards file's contents from the worktree, or `(no standards doc found)`.
`scanner.summary()` for a skipped scanner is `### security: skipped (<reason>)`.

## 7. Arbiter

```
# task.md

{ctx.taskMd}

# Current diff

{fence(ws.diff(baseCommit, REVIEW_PATHS), 'diff')}

# Latest gate output

{formatGates(ctx.lastGates)}

# Open findings

{fence(JSON.stringify(items, null, 2), 'json')}

Rule on each finding. Reply with JSON only.
```

`items` = per non-gate dispute: `{ "finding": <Finding dump>, "author_response": <FindingResponse dump | null> }`.
Gate/guard findings are **not** sent (ruled `fix` by code).

## 8. Test-fix pass (test author, code stage, once)

```
# task.md

{ctx.taskMd}

# Test fix pass

The implementation was judged against your tests, and the code critic reports that these failing tests are themselves defective (the test is wrong, not the code):

{fence(JSON.stringify(defects.map(dump), null, 2), 'json')}

# Latest gate output

{formatGates(gates)}

Fix only these defects, in files under {paths joined by ', '}. Keep every test checking the behaviour task.md requires: don't delete or skip tests, and don't weaken assertions just to make them pass. Don't edit implementation files; changes outside the test paths are reverted. Re-run the tests, then reply with a short summary.
```

## 9. JSON retry suffix (`callJsonAgent`, second attempt)

```
{originalPrompt}

---
Your previous reply could not be parsed:
{parseError}

Your previous reply was:
{previousReply.slice(-2000)}

Reply again with JSON only, matching the {SchemaName} schema.
```

`SchemaName` ∈ `Verdict`, `ArbiterRuling`, `BypassAnswers` (the *Python class names* appear in the prompt;
keep them: zod schemas should be given these `.describe()` names / a `schemaName` constant).

## 10. Other fixed strings

| Constant | Text |
|---|---|
| `FALLBACK_ANSWER` | `No answer given; use your best judgement and record the choice under Assumptions.` |
| `FALLBACK_REASON` | `The agent gave no usable answer when asked, so the run went on without one.` |
| `CUT_OFF_NOTE` | see §4 |
| Commit messages | `advpipe: spec (task.md)` · `advpipe: solo (task.md, tests, code)` · `advpipe: tests` · `advpipe: implementation` · `advpipe: review fixes` · `advpipe: test fix (<round dir, '/'→' '>)` · `advpipe: work in progress, handed over (checks failing)` |
| Git identity | `-c user.name=advpipe -c user.email=advpipe@localhost`, `--no-verify` |

## 11. Role system prompts: what each contains (orientation only; the files are authoritative)

| File | Lines | Notable content |
|---|---|---|
| `spec-writer.md` | 74 | `task.md` format; `BLOCKING:` rule; "Revising after answers" section; don't write an Answers section |
| `solo.md` | 80 | `task.md` first; stop with `BLOCKING:` questions and write nothing else; `## Assumptions`; revising after answers; reply with `AuthorResponse` when given findings |
| `test-author.md` | 48 | tests from `task.md` only; run them; they must fail for the right reason |
| `test-critic.md` | 58 | coverage, edge cases, "would a trivially wrong implementation pass?"; Verdict schema; shared rules |
| `coder.md` | 36 | minimal change; never edit tests; `AuthorResponse` JSON; dispute only with a task.md reason |
| `code-critic.md` | 74 | correctness/scope/production risk; **`test-defect`** category; **"A single review pass"** paragraph; Verdict schema; shared rules |
| `standards-reviewer.md` | 59 | conventions from the standards doc, scope creep, readability, test quality |
| `security-reviewer.md` | 59 | triage scanner output for reachability; injection/authz/secrets/unsafe input/deps |
| `arbiter.md` | 38 | `fix`/`dismiss` per finding with a one-line reason; no new findings |

The shared critic/reviewer footer, verbatim: *"Find the strongest reasons this fails an acceptance
criterion in task.md or would break in production. Report only findings you can point to by file and
line, or by acceptance criterion. Mark each finding blocking or minor. If you find nothing blocking,
return PASS. Reply with JSON only, matching the Verdict schema."*
