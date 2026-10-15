import { z } from 'zod';

// Primitive types shared by every contract (docs/03 §1). Keys are snake_case, as on disk.

export const Severity = z.enum(['blocking', 'minor']);
export type Severity = z.infer<typeof Severity>;

/** `test-defect`: a failing test is itself wrong (not the implementation). Code stage only. */
export const Category = z.enum([
  'correctness',
  'coverage',
  'standards',
  'security',
  'scope',
  'test-defect',
]);
export type Category = z.infer<typeof Category>;

export const Level = z.enum(['basic', 'reviewer', 'tests', 'adversarial', 'full']);
export type Level = z.infer<typeof Level>;

export const ScanPolicy = z.enum(['ask', 'ignore', 'block']);
export type ScanPolicy = z.infer<typeof ScanPolicy>;

export const Stage = z.enum([
  'INIT',
  'SOLO',
  'SPEC',
  'TESTS',
  'CODE',
  'REVIEW',
  'ARBITER',
  'FINAL_GATES',
  'DONE',
]);
export type Stage = z.infer<typeof Stage>;

export const Status = z.enum(['running', 'complete', 'needs_human', 'budget_exceeded', 'error']);
export type Status = z.infer<typeof Status>;

export const DecisionKind = z.enum(['red_checks', 'scan_hits', 'usage_limit', 'spec_cap']);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const LoginKind = z.enum(['console', 'subscription', 'unknown']);
export type LoginKind = z.infer<typeof LoginKind>;

export const Role = z.enum([
  'spec-writer',
  'test-author',
  'test-critic',
  'coder',
  'code-critic',
  'standards-reviewer',
  'security-reviewer',
  'arbiter',
  'solo',
]);
export type Role = z.infer<typeof Role>;

/** Run ids are path components: letters, digits, '.', '_' and '-', not starting with '.' or '-'. */
export const RUN_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
export const QUESTION_ID_RE = /^Q[1-9][0-9]{0,3}$/;

/** True if `runId` is safe to use as a directory name. */
export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId) && !runId.includes('..');
}

/** What a person can choose at each kind of decision point. */
export const DECISION_CHOICES = {
  red_checks: ['fix', 'takeover'],
  scan_hits: ['ignore', 'block'],
  usage_limit: ['retry', 'finish'],
  spec_cap: ['begin', 'stop'],
} as const satisfies Record<DecisionKind, readonly string[]>;

/** A run in one of these statuses can be resumed (needs_human has its own special cases). */
export const RESUMABLE: ReadonlySet<Status> = new Set<Status>([
  'running',
  'error',
  'budget_exceeded',
]);

/** An ISO-8601 datetime with `Z` or an offset (Python wrote `...512345Z`; any precision is fine). */
export const IsoDate = z.iso.datetime({ offset: true });

/** Now, as UTC with a trailing `Z` (what the engine writes). */
export function nowIso(): string {
  return new Date().toISOString();
}
