# 03 · Data contracts and on-disk formats

Every shape that crosses a trust boundary (a file, an agent reply, an IPC message) is a **zod 4
schema in `packages/contracts`**; TypeScript types are `z.infer`. The schemas below are normative.
They mirror `docs/reference/python-original/src/advpipe/models.py` and `config.py`, and the on-disk
format must stay **byte-for-byte readable by the Python version** (ADR-9).

Conventions:

- **Keys are `snake_case` on disk** (as pydantic wrote them). TypeScript code may expose camelCase
  *inside* the app, but the schemas parse and emit snake_case. Simplest and least error-prone:
  keep snake_case property names in the contract types and don't translate. (The domain spec's
  pseudocode uses camelCase for readability only.)
- **Datetimes** are ISO-8601 strings. Python writes UTC as `2026-10-08T04:41:02.512345Z`; accept any
  ISO form with `Z` or an offset on read; write UTC with `Z`. Parse into `Date` only at the edges.
- **Reading is tolerant, writing is exact.** Unknown keys in `run.json`/`decisions/N.json`/`usage.json`
  are ignored on read (the Python models ignore extras). Unknown keys in `config.json`/`pipeline.toml`
  and work-item front matter are **errors** (typos must fail loudly).
- Every optional/defaulted field below must have its default on read so **old `run.json` files load**.
- Built in M1: `GateResult` (§6) is in `contracts/src/runstate.ts`; `gate_statuses` is `engine/src/core/events.ts`; `EventLine` (the loose event object, plus `isLogLine`) is in `contracts/src/events.ts`.
- JSON files are written with a 2-space indent and UTF-8. **The original Python wrote these formats; they are kept, not required
  (ADR-9). Byte format by file:** `run.json`, `decisions/N.json`, `config.json` keep real UTF-8
  (pydantic); `events.jsonl` keeps real UTF-8 (`ensure_ascii=False`); every other `*.json` (gates, arbiter,
  final-gates, spec answers/bypass, scanner) is written with `ensure_ascii=True`, i.e. non-ASCII as `\uXXXX`.
  Readers must accept either. Every
  file write is **temp file + rename** in the same directory (`.<name>.<pid>.tmp` → `<name>`), so a
  reader polling a live run never sees a half-written file. `events.jsonl` is opened in append mode and
  closed per event.

---

## 1. Primitive types

```ts
const Severity  = z.enum(['blocking','minor']);
const Category  = z.enum(['correctness','coverage','standards','security','scope','test-defect']);
const Level     = z.enum(['basic','reviewer','tests','adversarial','full']);
const ScanPolicy= z.enum(['ask','ignore','block']);
const Stage     = z.enum(['INIT','SOLO','SPEC','TESTS','CODE','REVIEW','ARBITER','FINAL_GATES','DONE']);
const Status    = z.enum(['running','complete','needs_human','budget_exceeded','error']);
const DecisionKind = z.enum(['red_checks','scan_hits','usage_limit','spec_cap']);
const LoginKind = z.enum(['console','subscription','unknown']);
const RUN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;      // plus: must not contain '..'
const QUESTION_ID_RE = /^Q[1-9][0-9]{0,3}$/;
const DECISION_CHOICES = {
  red_checks:  ['fix','takeover'],
  scan_hits:   ['ignore','block'],
  usage_limit: ['retry','finish'],
  spec_cap:    ['begin','stop'],
} as const;
const RESUMABLE = new Set(['running','error','budget_exceeded']);
```

## 2. Findings, verdicts, responses, rulings

```ts
const Finding = z.object({
  id: z.string(),
  severity: Severity,
  category: Category,
  file: z.string().nullable().default(null),
  line: z.number().int().nullable().default(null),
  criterion: z.string().nullable().default(null),
  claim: z.string(),
  evidence: z.string().default(''),
  suggested_check: z.string().default(''),
});
// helpers (pure, in contracts):
isGrounded(f) = (!!f.file && f.line != null) || !!f.criterion
isBlocking(f) = f.severity === 'blocking'
matchKey(f)   = (!f.file && !f.criterion) ? null : [f.file ?? '', f.criterion ?? '']

const Verdict = z.object({
  verdict: z.enum(['PASS','FAIL']),
  findings: z.array(Finding).default([]),
}).transform(v => {                       // enforce the rules IN THE SCHEMA, so no caller can forget
  const grounded = v.findings.filter(isGrounded), noise = v.findings.filter(f => !isGrounded(f));
  const hasBlocking = grounded.some(isBlocking);
  return { verdict: (v.verdict==='PASS' && hasBlocking) ? 'FAIL' : v.verdict, findings: grounded, noise };
});  // `noise` is NOT serialised back to disk (Python: Field(exclude=True))

const FindingResponse = z.object({
  finding_id: z.string(), action: z.enum(['fixed','disputed']),
  note: z.string().default(''), reason: z.string().default(''),
});
const AuthorResponse = z.object({ responses: z.array(FindingResponse).default([]) });
// disputed(): Map<finding_id, FindingResponse> where action === 'disputed'

const Ruling = z.object({ finding_id: z.string(), decision: z.enum(['dismiss','fix']), reason: z.string().default('') });
const ArbiterRuling = z.object({ rulings: z.array(Ruling).default([]) });

const BypassAnswer  = z.object({ id: z.string(), answer: z.string().default(''), reasoning: z.string().default('') });
const BypassAnswers = z.object({ answers: z.array(BypassAnswer).default([]) });

// In-memory only (never on disk as such):
type Dispute = { finding: Finding; response: FindingResponse | null };
type StageResult = { name: string; passed: boolean; rounds: number; open_findings: Dispute[]; minor_findings: Finding[] };
```

## 3. Run state (`run.json`)

```ts
const OpenQuestion = z.object({
  id: z.string(),                 // "Q1", "Q2", … unique within the run, never reused
  text: z.string(),               // as the writer wrote it, without the BLOCKING: prefix
  asked_in: z.number().int(),     // spec/solo pass that asked it (1 = the first)
  answer: z.string().default(''),
  answered_at: z.string().datetime({offset:true}).nullable().default(null),
  applied: z.boolean().default(false),          // a revision pass has been given this answer
  source: z.enum(['person','agent']).default('person'),
  reasoning: z.string().default(''),            // the agent's one-paragraph reason (Bypass)
  bypassed: z.boolean().default(false),         // the person chose Bypass; the agent's answer may not exist yet
});

const RateLimitSnapshot = z.object({
  window: z.string(),             // five_hour | seven_day | seven_day_opus | seven_day_sonnet | overage (| seven_day_overage_included)
  status: z.enum(['allowed','allowed_warning','rejected']),
  utilization: z.number().nullable().default(null),     // 0.0 – 1.0
  resets_at: z.string().datetime({offset:true}).nullable().default(null),
  seen_at: z.string().datetime({offset:true}),          // default: now
});
// Only these fields are ever stored. NEVER store the SDK's raw rate-limit event.

const Decision = z.object({
  kind: DecisionKind,
  stage: Stage,                                   // where the run stopped
  asked_at: z.string().datetime({offset:true}),
  explanation: z.string(),                        // plain words, shown to the person as is
  findings: z.array(Finding).default([]),
  usage: RateLimitSnapshot.nullable().default(null),   // usage_limit: the window that ran out
  billing: z.boolean().default(false),                 // usage_limit: Console credit balance ran out
  choice: z.string().default(''),                      // set by the person
  note: z.string().default(''),                        // red_checks + fix: the person's note, verbatim
  decided_at: z.string().datetime({offset:true}).nullable().default(null),
  applied: z.boolean().default(false),                 // the choice has been acted on
});

const RunState = z.object({
  run_id: z.string(),
  work_item: z.string(),
  work_item_file: z.string().default(''),          // absolute path of the file it came from, or ''
  repo: z.string(),                                // absolute path
  worktree: z.string().default(''),
  branch: z.string().default(''),
  base_commit: z.string().default(''),
  status: Status.default('running'),
  stage: Stage.default('INIT'),
  round: z.number().int().default(0),
  cost_usd: z.number().default(0),
  started_at: <datetime>, updated_at: <datetime>,  // updated_at rewritten on every write
  open_findings: z.array(Finding).default([]),
  minor_findings: z.array(Finding).default([]),
  rulings: z.array(Ruling).default([]),
  rounds_used: z.record(z.number().int()).default({}),     // "tests"|"code"|"review" → n
  commits: z.record(z.string()).default({}),               // "spec"|"solo"|"tests"|"code"|"review" → sha
  cost_by_stage: z.record(z.number()).default({}),
  calls_by_stage: z.record(z.number().int()).default({}),
  worktree_removed: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
  noise_dropped: z.number().int().default(0),
  questions: z.array(OpenQuestion).default([]),
  spec_passes: z.number().int().default(0),
  level: Level.default('full'),
  security_scan: z.boolean().nullable().default(null),     // null = an old run: the level's default
  scan_policy: ScanPolicy.default('ask'),
  bypass_questions: z.boolean().default(false),
  decisions: z.array(Decision).default([]),
  fix_passes: z.number().int().default(0),
  ended_by: z.enum(['','takeover','stop','finish']).default(''),
  auth: LoginKind.default('unknown'),
  rate_limits: z.record(RateLimitSnapshot).default({}),    // latest per window
});
// derived: decision = decisions.at(-1) ?? null   (the open or latest decision)
```

`commits` is **the resume key**: a stage is skipped on resume iff its key is present. A solo run records
`solo` (and maybe `review`), never `spec/tests/code`. Any logic that assumed "`spec` ∈ commits means
past the spec" must go through the level-aware helpers (`specStage(state)`, `stepsFor(level)`,
`COMMIT_KEYS`).

### Example (abridged)

```json
{
  "run_id": "20261008-091500-ab12cd",
  "work_item": "Add clamp(x, lo, hi) to mathutils.",
  "work_item_file": "/home/me/proj/work-items/s01-clamp.md",
  "repo": "/home/me/proj",
  "worktree": "/home/me/proj/.advpipe/worktrees/20261008-091500-ab12cd",
  "branch": "advpipe/s01-clamp",
  "base_commit": "92126375c790…",
  "status": "needs_human",
  "stage": "CODE",
  "round": 3,
  "cost_usd": 1.89,
  "commits": { "spec": "…", "tests": "…" },
  "level": "full",
  "security_scan": true,
  "scan_policy": "ask",
  "decisions": [{ "kind": "red_checks", "stage": "CODE", "explanation": "The checks are still failing …",
                  "findings": [], "choice": "", "applied": false, "asked_at": "2026-10-08T09:21:00Z" }]
}
```

## 4. Config (`pipeline.toml` and `config.json`)

```ts
const Config = z.strictObject({
  models:   z.strictObject({ author:'claude-opus-5-5', critic:'claude-sonnet-5-5', arbiter:'claude-opus-5-5' }),
  limits:   z.strictObject({
    max_rounds_spec: pos int =3, max_rounds_tests: pos int =2, max_rounds_code: pos int =3,
    max_turns_per_agent: pos int =40, budget_usd_per_task: pos number =15.0,
    gate_timeout_s: pos int =600, max_fix_passes: pos int =3 }),
  gates:    z.strictObject({ test: string[] ['pytest','-q'], types: ['mypy','.'], lint: ['ruff','check','.'],
                             security: ['semgrep','--error','--config','auto'] }),
  paths:    z.strictObject({ tests: string[] ['tests/'], standards_doc: 'CLAUDE.md' }),
  pipeline: z.strictObject({ level: Level|1..5 → name ='full', security_scan: boolean|null =null,
                             scan_failures: ScanPolicy ='ask', bypass_questions: boolean =false }),
});
```

Each table defaults to its defaults when absent. `config.json` is the same shape written by
`JSON.stringify(config, null, 2)`. Tests need to know **which keys were explicitly set** (for
`checkSameShape`: "a config that explicitly sets a different level is refused"): keep the *raw parsed
object* alongside the parsed config (Python used pydantic's `model_fields_set`).

## 5. Work-item files

See [02-DOMAIN_SPEC](02-DOMAIN_SPEC.md) §16. In TypeScript:

```ts
type WorkItem = { body: string; name?: string; config?: string; level?: string;
                  security_scan?: string; scan_failures?: string; bypass_questions?: string };
// values are kept AS WRITTEN (validated on parse); callers use parseLevel()/switchValue() to interpret them
```

## 6. The run directory

`<repo>/.advpipe/` is the app's whole footprint inside a repo (and is added to `.git/info/exclude`).

```
.advpipe/
  usage.json                         last known login + usage per window, repo-wide (§9)
  worktrees/<run-id>/                the git worktree (removed on complete / takeover / clean)
  runs/<run-id>/
    run.json                         RunState, rewritten at every transition and after every agent call
    events.jsonl                     every progress event, appended + flushed immediately (§8)
    console.log                      the worker's stdout+stderr (a detached run)
    config.json                      the effective config this run runs under (rewritten on resume)
    start.json                       NEW (app-only): what the host asked the worker to do (§7). Ignored by Python.
    task.md                          the latest spec, WITH its Answers section
    run.lock                         pid of the driving process; present only while one is driving
    cancel                           NEW: presence = "stop at the next safe point"; the worker deletes it
    report.md                        human summary, regenerated at every stop
    final-gates.json                 [GateResult]
    arbiter.json                     [Ruling] (all rulings)         arbiter-<tests|code|review>.json  raw arbiter reply
    spec/author.txt                  spec writer's first reply
    spec/pass-N/{task.md, author.txt, answers.json, bypass.json, bypass-begin.json}   N ≥ 1 task.md; N ≥ 2 the rest
    stage-solo/pass-N/{author.txt, diff.patch, gates.json, task.md, answers.json, bypass.json, request.json}
    stage-tests/round-N/{author.txt, diff.patch, critic.json, gates.json, test-fix.txt}
    stage-code/round-N/{author.txt, diff.patch, critic.json, gates.json, test-fix.txt}
    review/{diff.patch, standards.json, security.json, scanner.json}     (full)
    review/{diff.patch, single.json}                                      (reviewer, tests)
    decisions/N.json                 each Decision, as asked and as decided (N from 1; rewritten with state)
    final-pass-<tests|code|solo>/{author.txt, gates.json}                 final author pass after settle
    fix-pass-N/{author.txt, gates.json}                                   a person-requested pass (outside SOLO)
```

- `stage-*/round-N/critic.json` is **absent** at levels without critics (the `tests` level). The UI
  says "No critic at this level", not "missing".
- `critic.json`, `standards.json`, `security.json`, `single.json`, `arbiter-*.json` hold the **raw agent
  reply text**, which may be JSON wrapped in prose or fences. The UI parses it leniently
  (`extractJson` → `Verdict`) and shows it raw if that fails.
- `gates.json` / `final-gates.json` / `scanner.json`: `GateResult` is
  `{name, command: string[], returncode: number|null, output: string, skipped: boolean, skip_reason: string}`.
  `passed` is derived (`skipped || returncode === 0`), not stored.
- `diff.patch` is **exactly** the diff that went into that critic's (or both reviewers') prompt,
  written *before* the critic is called.
- Run ids are path components: every id from anywhere (UI, IPC, a directory name) goes through
  `checkRunId` before it touches a path.

## 7. `start.json` (new, app-only)

Written by the host before it spawns a worker, so no run parameter ever travels as a command-line
argument (no size limits, no quoting hazards, nothing for a shell to misparse):

```ts
const StartRequest = z.discriminatedUnion('command', [
  z.object({ command: z.literal('run'), run_id, repo, work_item: z.string(), work_item_file: z.string().default(''),
             name: z.string().nullable(), config_path: z.string().nullable(), keep_worktree: z.boolean().default(false),
             // the already-merged effective settings; the worker applies them verbatim
             level: Level, security_scan: z.boolean().nullable(), scan_failures: ScanPolicy, bypass_questions: z.boolean(),
             budget_usd: z.number().positive().nullable() }),
  z.object({ command: z.literal('resume'), run_id, repo, budget_usd: z.number().positive().nullable(), locked_for_me: z.literal(true) }),
]);
```

The worker's argv is `[node, worker.js, '--start', '<abs path to start.json>']` and nothing else. See
[04-ARCHITECTURE](04-ARCHITECTURE.md) §3.

## 8. Events (`events.jsonl`)

One JSON object per line. Every event has:

```ts
{ ts: '2026-10-08T04:41:02.512Z',   // UTC, millisecond precision, 'Z'
  kind: EventKind, stage: Stage, round: number,   // stage/round from RunState at emit time
  message: string,                  // human text; the UI's log line. Keep the exact Python wording.
  ...extra }                        // kind-specific, below
```

| `kind` | When | Extra fields |
|---|---|---|
| `run_start` | a new run (branch, worktree) or a resume | `branch` or `worktree`; `level`, `security_scan` (on the branch line and on resume) |
| `stage` | `== STAGE`; a stage passing or going to the arbiter | `passed` (the latter) |
| `round` | start of a round / spec pass / fix pass | `cap` |
| `agent_start` | before every agent call | `role` |
| `agent_done` | after every agent call (also one cut off by a limit) | `role`, `cost_usd`, `total_usd`, `is_error` |
| `gates` | check results; scanner result; each blocking gate failure | `gates`: `{name: 'pass'\|'fail'\|'skipped'}` (not on the failure lines) |
| `verdict` | a critic or reviewer verdict | `role`, `verdict`, `blocking`, `minor` |
| `guard` | a guard reverted something | |
| `test_fix` | the test-defect fix pass | `files` (when tests were committed) |
| `ruling` | each arbiter (or code) ruling | `finding_id`, `decision` |
| `status` | budget exceeded, interrupted, and the **final** event of every driving process | `status`; the final one has `final: true`, `total_usd` and is written with `echo=false` |
| `error` | an unexpected exception ended the run | |
| `questions` | blocking questions found | `ids`, `answerable`, `bypassed?` |
| `answers` | answers recorded (by the host) or the agent answered (Bypass) | `ids`, `bypassed?`, `agent?` |
| `decision` | a decision point was reached, chosen or applied | `decision_kind`, `choice` (`asked` or the choice), `decision_stage`, `choices?` |
| `usage` | login learned, or a usage-window snapshot | `login?`; or `window`, `status`, `utilization`, `resets_at` |

`echo` (printing to a live terminal) has no equivalent now: **the UI's log shows every event except it
may hide `echo=false` ones**, i.e. the final `status` line is data, not a log line. Keep the flag in the
emit signature (`echo: boolean`) and write it into the event as `"echo": false` so the UI can filter
(Python didn't persist it; the final event is identified by `final: true` instead, so also treat
`final: true` as "not a log line").

Readers (the live log) tail by **byte offset**, send only complete lines, and know the driving process
is finished when a `status` event with `final: true` has been read **and** no live process holds
`run.lock`.

## 9. `usage.json` (repo-wide cache)

```ts
const UsageCache = z.object({ login: LoginKind.default('unknown'),
                              updated_at: datetime.nullable().default(null),
                              windows: z.record(RateLimitSnapshot).default({}) });
```

`record(repo, login, snapshots)`: no-op if `login == 'unknown'` and there are no snapshots; otherwise
load, set `login` if known, merge snapshots (latest per window), set `updated_at`, write via temp +
rename; **never fail a run because this couldn't be written**.

## 10. `report.md`

Generated by `renderReport(state, {waitingOnAnswers})`; **port `runlog.render_report` verbatim**
(`docs/reference/python-original/src/advpipe/runlog.py`). Sections, in order:

```
# advpipe run <id>
- **Status:** …
- **Level:** … (and "Not done at this level:" bullets, "Blocking questions: bypassed up front", "Scan hits: …")
- **Work item:** … / **Branch:** `…` (worktree removed | worktree `…`) / **Stopped at stage:** … / **Cost:** $… / **Time:** …s
## Rounds used  ·  ## Open blocking findings  ·  ## Minor findings (not fixed)  ·  ## Arbiter rulings
## Cost by stage        (table: Stage | Agent calls | Cost | Share, plus a bold total row)
## Login and usage      (only when login or usage is known)
## Questions and answers (only when there were questions; agent answers marked "(agent's best judgement, you chose Bypass[ up front])" with Reason)
## Decisions            (each decision, choice, note; "Handed over…", "Stopped at your choice…", "Finished as is…", fix-pass count)
## Notes                (+ "N ungrounded finding(s) dropped as noise")
```

The report is rendered as markdown in the UI (never as HTML; see [08-SECURITY](08-SECURITY.md)). It
still names `advpipe answer` / `advpipe decide` commands in three places (waiting-on-answers note,
open-decision note, the open decision's "waiting for you" line) because the Python version does; **the TS port replaces those command strings
with plain instructions** ("Answer them on the run's page") since there is no CLI. This is the only
sanctioned deviation in the report text (full list of such rewordings: [02-DOMAIN_SPEC](02-DOMAIN_SPEC.md) §19); all other wording is verbatim.

## 11. App-only files (not in the repo)

`<userData>/preferences.json` (Electron's `app.getPath('userData')`):

```ts
{ theme: 'system'|'light'|'dark', recent_repos: string[] /* abs paths, max 10, most recent first */,
  windows: { [repoPath]: { x,y,width,height,maximized } }, notifications: boolean, items_dir: { [repoPath]: string } }
```

Per-repo `items_dir` defaults to `work-items` (relative to the repo, as `--items-dir` did).
