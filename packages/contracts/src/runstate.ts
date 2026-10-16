import { z } from 'zod';
import { Finding, Ruling } from './findings.js';
import {
  DecisionKind,
  IsoDate,
  Level,
  LoginKind,
  ScanPolicy,
  Stage,
  Status,
  nowIso,
} from './primitives.js';

// Run state: `run.json`, `decisions/N.json`, `usage.json` (docs/03 §3, §9).
// Reading is tolerant (unknown keys ignored, every field defaulted so old files load);
// writing is exact (`JSON.stringify(state, null, 2)`).

/** A question the spec writer marked BLOCKING, and the answer to it. */
export const OpenQuestion = z.object({
  id: z.string(), // "Q1", "Q2", ...: unique within the run, never reused
  text: z.string(), // as the writer wrote it, without the BLOCKING: prefix
  asked_in: z.number().int(), // the spec/solo pass that asked it (1 = the first)
  answer: z.string().default(''),
  answered_at: IsoDate.nullable().default(null),
  applied: z.boolean().default(false), // a revision pass has been given this answer
  source: z.enum(['person', 'agent']).default('person'),
  reasoning: z.string().default(''), // the agent's one-paragraph reason (Bypass)
  bypassed: z.boolean().default(false), // the person chose Bypass; the answer may not exist yet
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;

/** What Claude last reported about one usage window. Only these fields are ever stored. */
export const RateLimitSnapshot = z.object({
  window: z.string(), // five_hour | seven_day | seven_day_opus | seven_day_sonnet | overage | ...
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  utilization: z.number().nullable().default(null), // 0.0 - 1.0
  resets_at: IsoDate.nullable().default(null),
  seen_at: IsoDate.default(nowIso),
});
export type RateLimitSnapshot = z.infer<typeof RateLimitSnapshot>;

/** A stop where the run waits for a person to choose. Nothing but a person picks a choice. */
export const Decision = z.object({
  kind: DecisionKind,
  stage: Stage, // where the run stopped
  asked_at: IsoDate.default(nowIso),
  explanation: z.string(), // plain words, shown to the person as is
  findings: z.array(Finding).default([]),
  usage: RateLimitSnapshot.nullable().default(null), // usage_limit: the window that ran out
  billing: z.boolean().default(false), // usage_limit: the Console credit balance ran out
  choice: z.string().default(''), // set by the person
  note: z.string().default(''), // red_checks + fix, review_step + revise: the person's note, verbatim
  decided_at: IsoDate.nullable().default(null),
  applied: z.boolean().default(false), // the choice has been acted on
});
export type Decision = z.infer<typeof Decision>;

export const RunState = z.object({
  run_id: z.string(),
  work_item: z.string(),
  work_item_file: z.string().default(''), // absolute path of the file it came from, or ''
  repo: z.string(), // absolute path
  worktree: z.string().default(''),
  branch: z.string().default(''),
  base_commit: z.string().default(''),
  status: Status.default('running'),
  stage: Stage.default('INIT'),
  round: z.number().int().default(0),
  cost_usd: z.number().default(0),
  started_at: IsoDate.default(nowIso),
  updated_at: IsoDate.default(nowIso),
  open_findings: z.array(Finding).default([]),
  minor_findings: z.array(Finding).default([]),
  rulings: z.array(Ruling).default([]),
  rounds_used: z.record(z.string(), z.number().int()).default({}),
  // The resume key: a stage is skipped on resume iff its key is present.
  commits: z.record(z.string(), z.string()).default({}),
  cost_by_stage: z.record(z.string(), z.number()).default({}),
  calls_by_stage: z.record(z.string(), z.number().int()).default({}),
  worktree_removed: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
  noise_dropped: z.number().int().default(0),
  questions: z.array(OpenQuestion).default([]),
  spec_passes: z.number().int().default(0),
  // Set when the run is created and never changed. A run recorded before levels is full.
  level: Level.default('full'),
  security_scan: z.boolean().nullable().default(null), // null: an old run, so the level's default
  scan_policy: ScanPolicy.default('ask'),
  bypass_questions: z.boolean().default(false),
  // Levels 3-5: stop for a person's review after the spec, the tests and the code.
  review_pauses: z.boolean().default(false),
  decisions: z.array(Decision).default([]),
  fix_passes: z.number().int().default(0),
  ended_by: z.enum(['', 'takeover', 'stop', 'finish']).default(''),
  auth: LoginKind.default('unknown'),
  rate_limits: z.record(z.string(), RateLimitSnapshot).default({}),
});
export type RunState = z.infer<typeof RunState>;

/** What `new RunState(...)` needs: the three fields with no default. */
export type NewRunState = Pick<RunState, 'run_id' | 'work_item' | 'repo'> &
  Partial<Omit<RunState, 'run_id' | 'work_item' | 'repo'>>;

/** A fresh run state, every other field at its default. */
export function newRunState(init: NewRunState): RunState {
  return RunState.parse(init);
}

/** The open decision point, or the latest one. */
export function currentDecision(state: RunState): Decision | null {
  return state.decisions.at(-1) ?? null;
}

/** `.advpipe/usage.json`: the last known login and usage per window, repo-wide. */
export const UsageCache = z.object({
  login: LoginKind.default('unknown'),
  updated_at: IsoDate.nullable().default(null),
  windows: z.record(z.string(), RateLimitSnapshot).default({}),
});
export type UsageCache = z.infer<typeof UsageCache>;

/** One gate (check) result, as stored in `gates.json` / `final-gates.json` / `scanner.json`. */
export const GateResult = z.object({
  name: z.string(),
  command: z.array(z.string()),
  returncode: z.number().int().nullable().default(null),
  output: z.string().default(''),
  skipped: z.boolean().default(false),
  skip_reason: z.string().default(''),
});
export type GateResult = z.infer<typeof GateResult>;

/** `passed` is derived, never stored. */
export const gatePassed = (r: GateResult): boolean => r.skipped || r.returncode === 0;

/** `### test: PASS\n$ cmd\n```\noutput\n```` or `### test: skipped (reason)`. */
export function gateSummary(r: GateResult): string {
  if (r.skipped) return `### ${r.name}: skipped (${r.skip_reason})`;
  const status = gatePassed(r) ? 'PASS' : `FAIL (exit ${r.returncode})`;
  return `### ${r.name}: ${status}\n$ ${r.command.join(' ')}\n\`\`\`\n${r.output}\n\`\`\``;
}
