import { z } from 'zod';
import { ACTIONS } from './actions.js';
import { Config } from './config.js';
import { EventLine } from './events.js';
import { Finding, Ruling } from './findings.js';
import { Role, Stage } from './primitives.js';
import { Decision, OpenQuestion } from './runstate.js';
import { RunRow, Starting, UsageView } from './views.js';

// What the run page shows (docs/05 §5.2, §5.3): the run's header, timeline, report, next steps and
// the "Spec & context" tab. Plain data built by the engine's read models; the renderer only draws
// it. Text an agent wrote arrives as `*_html` (markdown the engine rendered with raw HTML escaped)
// and is sanitised once more in the window's one `<Markdown>` component (docs/08 §4).

// ── timeline step states (port of `detail.STEP_STATES`) ────────────────────────────────────────

export const STEP_STATE_KEYS = [
  'done',
  'current',
  'stopped',
  'pending',
  'not_reached',
  'not_needed',
  'if_needed',
] as const;
export const StepState = z.enum(STEP_STATE_KEYS);
export type StepState = z.infer<typeof StepState>;

export const STEP_STATES: Readonly<Record<StepState, { label: string; help: string }>> = {
  done: { label: 'done', help: 'Finished.' },
  current: { label: 'in progress', help: 'An agent or check is working on this step right now.' },
  stopped: {
    label: 'stopped here',
    help: 'The run stopped during this step. The report says why.',
  },
  pending: { label: 'not yet', help: 'Not started yet.' },
  not_reached: { label: 'not reached', help: 'The run ended before this step.' },
  not_needed: {
    label: 'not needed',
    help: "No findings were left open, so the arbiter wasn't called.",
  },
  if_needed: {
    label: 'only if needed',
    help: 'Runs only if findings are left open after a stage.',
  },
};

// ── the choices at a decision point (port of `detail.CHOICE_VIEWS`, `DECISION_TITLES`) ──────────

export type ChoiceView = {
  value: string;
  label: string;
  help: string;
  /** Ends the run: asks on its own page first. */
  confirm: boolean;
  primary: boolean;
};

export const CHOICE_VIEWS: Readonly<Record<string, ChoiceView>> = {
  fix: {
    value: 'fix',
    label: 'Another fix pass',
    help:
      'One more pass by the author with the failing output (and your note, if you write one). ' +
      'Then the checks run again.',
    confirm: false,
    primary: true,
  },
  takeover: {
    value: 'takeover',
    label: "I'll take over",
    help:
      'Commits the work as it is to the branch, removes the working copy and ends the run, so ' +
      'you can check the branch out and finish it by hand.',
    confirm: true,
    primary: false,
  },
  ignore: {
    value: 'ignore',
    label: 'Ignore and continue',
    help:
      'Records the hits as minor findings marked as ignored by you, and carries on. Later hits ' +
      "in this run aren't asked about.",
    confirm: false,
    primary: true,
  },
  block: {
    value: 'block',
    label: 'Block',
    help:
      'Treats the hits like a failing test: the author is asked to fix them and the scan runs ' +
      'again. Later hits in this run are blocking too.',
    confirm: false,
    primary: false,
  },
  begin: {
    value: 'begin',
    label: 'Begin work',
    help:
      'The agent decides the questions that are still open, and any question that comes up later ' +
      'in this run, and carries on.',
    confirm: false,
    primary: true,
  },
  retry: {
    value: 'retry',
    label: 'Try again',
    help:
      'Starts the step that was cut off again, with its partial work kept. Add usage or credits ' +
      'first, or wait for the reset. If the limit is still in force, the run pauses again.',
    confirm: false,
    primary: true,
  },
  finish: {
    value: 'finish',
    label: 'Finish as is',
    help:
      'Ends the run here. Nothing is committed: the work so far stays in the working copy, ' +
      'uncommitted, for you to do with as you please.',
    confirm: true,
    primary: false,
  },
  stop: {
    value: 'stop',
    label: 'Stop here',
    help: "Ends the run. Nothing is written to the branch, and it can't be resumed.",
    confirm: true,
    primary: false,
  },
};

export const DECISION_TITLES = {
  red_checks: 'The checks are still failing',
  scan_hits: 'The security scan reported issues',
  usage_limit: 'Paused: a usage limit was reached',
  spec_cap: 'Begin work?',
} as const;

// ── the run page ──────────────────────────────────────────────────────────────────────────────

export const DiffLine = z.strictObject({
  /** A CSS class: file headers, hunk marks, added, removed and context lines. */
  kind: z.enum(['meta', 'hunk', 'add', 'del', 'ctx']),
  text: z.string(),
});
export const DiffViewS = z.strictObject({
  path: z.string(), // relative to the run directory
  lines: z.array(DiffLine),
  total: z.number().int(), // lines in the file; more than `lines.length` when cut
});
export type DiffViewData = z.infer<typeof DiffViewS>;

export const GateRow = z.strictObject({
  name: z.string(),
  command: z.string(),
  status: z.enum(['pass', 'fail', 'skipped']),
  returncode: z.number().int().nullable(),
  output: z.string(),
  skip_reason: z.string(),
});
export const GatesViewS = z.strictObject({
  path: z.string(),
  readable: z.boolean(),
  results: z.array(GateRow),
  passed: z.boolean(),
  /** `test fail · types pass · lint skipped`. */
  line: z.string(),
});
export type GatesViewData = z.infer<typeof GatesViewS>;

export const CriticViewS = z.strictObject({
  role: z.string(), // "code critic"
  path: z.string(),
  raw: z.string(),
  /** Null: the output is missing or unparseable (the raw text is shown instead). */
  verdict: z
    .strictObject({ verdict: z.enum(['PASS', 'FAIL']), findings: z.array(Finding) })
    .nullable(),
  /** Findings thrown away as noise because they cited no file+line or criterion. */
  dropped: z.number().int(),
});
export type CriticViewData = z.infer<typeof CriticViewS>;

export const RoundViewS = z.strictObject({
  /** Stable across refreshes (`tests/round-2`): the key a panel's open state is kept under. */
  key: z.string(),
  title: z.string(),
  author_role: z.string(),
  author_html: z.string().nullable(),
  diff: DiffViewS.nullable(),
  gates: z.array(z.strictObject({ label: z.string(), view: GatesViewS })),
  critics: z.array(CriticViewS),
  test_fix_html: z.string().nullable(),
  expect_red: z.boolean(),
  task_html: z.string().nullable(),
  asked: z.array(OpenQuestion),
  notice: z.string(),
  decision: Decision.nullable(),
  /** A short result for the panel's summary line. */
  outcome: z.string(),
});
export type RoundViewData = z.infer<typeof RoundViewS>;

export const StepViewS = z.strictObject({
  stage: Stage,
  label: z.string(),
  state: StepState,
  summary: z.string(), // "2 of 3 rounds", "" if nothing to say
  rounds: z.array(RoundViewS),
  task_html: z.string().nullable(),
  rulings: z.array(Ruling),
  rulings_note: z.string(),
});
export type StepViewData = z.infer<typeof StepViewS>;

export const NextStep = z.strictObject({ label: z.string(), command: z.string() });
export type NextStep = z.infer<typeof NextStep>;

export const DecisionViewS = z.strictObject({
  decision: Decision,
  choices: z.array(z.string()),
  pending: z.array(OpenQuestion), // spec_cap: the questions still open
  fix_pass: z.number().int(), // red_checks: the pass a "fix" would be (1-based)
  max_fix_passes: z.number().int(),
  retry_warning: z.string(), // usage_limit
  add_key: z.enum(['', 'add_usage', 'add_credits']),
  add_label: z.string(),
});
export type DecisionViewData = z.infer<typeof DecisionViewS>;

/** `runs.detail` for a run that has a run.json. */
export const RunDetail = z.strictObject({
  kind: z.literal('run'),
  row: RunRow,
  title: z.string(), // up to 120 characters
  live: z.boolean(),
  elapsed: z.string(), // "3m 07s"
  scan: z.boolean(),
  dropped: z.array(z.string()), // what this run's level doesn't do
  worktree_kept: z.boolean(),
  work_item_file: z.string(),
  usage: UsageView,
  timeline: z.array(StepViewS),
  report_html: z.string().nullable(),
  next_steps: z.array(NextStep),
  decision_view: DecisionViewS.nullable(),
  /** The actions valid for this status (docs/05 §7); the host checks again on every call. */
  actions: z.array(z.enum(ACTIONS)),
  /** A bigger total budget to offer a run that ran out. */
  suggested_budget: z.number().int(),
  /** The blocking questions the answer form asks (empty unless the run needs answers). */
  questions: z.array(OpenQuestion),
  /** Who asked them: "spec writer", or "solo agent" at Basic and Reviewer. */
  asker: z.enum(['spec writer', 'solo agent']),
  /** Bypass is on for this run: the agent answers blocking questions itself. */
  bypass_on: z.boolean(),
  /** What a plain "needs you" stop left open. */
  open_findings: z.array(Finding),
});
export type RunDetail = z.infer<typeof RunDetail>;

export const RunDetailOut = z.union([RunDetail, Starting]).nullable();
export type RunDetailOut = z.infer<typeof RunDetailOut>;

// ── the Spec & context tab ────────────────────────────────────────────────────────────────────

export const TaskView = z.strictObject({
  html: z.string(),
  criteria: z.number().int(), // top-level items under "Acceptance criteria"
  questions: z.number().int(), // top-level items under "Open questions", not counting "None"
  blocking: z.number().int(), // those marked BLOCKING:
  sections: z.array(z.enum(['ac', 'oq'])), // which of the two task.md has
});
export type TaskView = z.infer<typeof TaskView>;

export const ContextView = z.strictObject({
  run_id: z.string(),
  status: z.string(),
  title: z.string(),
  live: z.boolean(),
  level: z.string(),
  work_item: z.strictObject({
    text: z.string(),
    html: z.string().nullable(), // null: the work item is empty
    file: z.string(),
  }),
  task: TaskView.nullable(), // null: no task.md yet
  config: z.strictObject({
    config: Config.nullable(), // null: missing or unreadable
    raw: z.string().nullable(), // as written (re-indented when valid); null: missing
    error: z.string(),
  }),
  checks: z.array(z.strictObject({ name: z.string(), command: z.string(), help: z.string() })),
  standards: z.strictObject({
    path: z.string(),
    html: z.string().nullable(), // null: no such file
    source: z.string(),
  }),
  roles: z.array(
    z.strictObject({
      role: Role,
      name: z.string(),
      model: z.string(),
      tools: z.array(z.string()),
      read_only: z.boolean(),
      inputs: z.string(),
      prompt_html: z.string().nullable(), // null: the prompt file couldn't be read
    }),
  ),
  seen_by: z.strictObject({
    work_item: z.string(),
    task_md: z.string(),
    config: z.string(),
    checks: z.string(),
    standards: z.string(),
    prompts: z.string(),
  }),
  answers: z.array(OpenQuestion), // blocking questions with an answer, from you or the agent
});
export type ContextView = z.infer<typeof ContextView>;

// ── the live log ──────────────────────────────────────────────────────────────────────────────

/** Pushed on `run.log`: new complete events of a subscribed run (docs/04 §5.2). */
export const LogPush = z.strictObject({
  runId: z.string(),
  lines: z.array(EventLine),
  next_offset: z.number().int(),
  ended: z.boolean(),
});
export type LogPush = z.infer<typeof LogPush>;
