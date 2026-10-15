import type { Limits } from './config.js';
import { Level, type Role, type Stage } from './primitives.js';
import type { RunState } from './runstate.js';
import { pyRepr } from './text.js';

// Pipeline levels: how much checking a run gets (docs/02 §2). A level is a name for a *shape*;
// everything the UI, the report and the call-count maths say about a level derives from SHAPES.
// A person picks the level; no agent can change it, and it never changes during a run.

export type Shape = {
  readonly solo: boolean; // one agent writes task.md, tests and code in one stage
  readonly critics: boolean; // TESTS and CODE are author <-> critic loops
  readonly review: 'none' | 'single' | 'full';
  readonly arbiter: boolean; // still-open / disputed findings go to the arbiter
  readonly securityScan: boolean; // the DEFAULT for the scan toggle
};

export const SHAPES: Readonly<Record<Level, Shape>> = {
  basic: { solo: true, critics: false, review: 'none', arbiter: false, securityScan: false },
  reviewer: { solo: true, critics: false, review: 'single', arbiter: false, securityScan: false },
  tests: { solo: false, critics: false, review: 'single', arbiter: false, securityScan: false },
  adversarial: { solo: false, critics: true, review: 'none', arbiter: true, securityScan: false },
  full: { solo: false, critics: true, review: 'full', arbiter: true, securityScan: true },
};

/** Slider positions 1..5. */
export const LEVEL_ORDER: readonly Level[] = ['basic', 'reviewer', 'tests', 'adversarial', 'full'];

export type LevelInfo = { label: string; goodFor: string; description: string };

export const LEVEL_INFO: Readonly<Record<Level, LevelInfo>> = {
  basic: {
    label: 'Basic',
    goodFor: 'typos, renames, a one-line fix, a tiny refactor',
    description: 'One agent writes task.md, tests and code in one pass; the checks decide.',
  },
  reviewer: {
    label: 'Reviewer',
    goodFor: "small bug fixes you'll skim",
    description: 'One agent does the work, then a second agent reviews the change once.',
  },
  tests: {
    label: 'Tests',
    goodFor: 'a contained change with clear behaviour',
    description: 'Spec, tests written first and shown to fail, code, then one review.',
  },
  adversarial: {
    label: 'Adversarial',
    goodFor: 'a feature with real logic',
    description:
      'Spec, then tests and code each checked by a critic, with the arbiter settling disputes. ' +
      'No reviewers at the end.',
  },
  full: {
    label: 'Full',
    goodFor: 'risky, security-relevant or user-facing work',
    description:
      'The whole pipeline: spec, tests and code with critics, standards and security ' +
      'reviewers, the arbiter, and the security scan.',
  },
};

/** 1 (basic) to 5 (full): the slider position. */
export function levelNumber(level: Level): number {
  return LEVEL_ORDER.indexOf(level) + 1;
}

/** A level from its name or its number (1 to 5). Throws an Error with the original's message. */
export function parseLevel(value: string | number): Level {
  if (typeof value === 'number') {
    const level = Number.isInteger(value) ? LEVEL_ORDER[value - 1] : undefined;
    if (level !== undefined) return level;
  } else {
    const text = value.trim().toLowerCase();
    if (/^[0-9]+$/.test(text)) return parseLevel(Number(text));
    const parsed = Level.safeParse(text);
    if (parsed.success) return parsed.data;
  }
  const names = LEVEL_ORDER.join(', ');
  throw new Error(
    `unknown level ${pyRepr(value)}: use one of ${names}, or 1 to ${LEVEL_ORDER.length}`,
  );
}

/** The roles a run at `level` can call, in pipeline order. */
export function rolesFor(level: Level): Role[] {
  const shape = SHAPES[level];
  const roles: Role[] = [];
  if (shape.solo) roles.push('solo');
  else {
    roles.push('spec-writer', 'test-author');
    if (shape.critics) roles.push('test-critic');
    roles.push('coder');
  }
  if (shape.critics || shape.review === 'single') roles.push('code-critic');
  if (shape.review === 'full') roles.push('standards-reviewer', 'security-reviewer');
  if (shape.arbiter) roles.push('arbiter');
  return roles;
}

/** The timeline steps of a run at `level`. */
export function stepsFor(level: Level): Stage[] {
  const shape = SHAPES[level];
  const steps: Stage[] = shape.solo ? ['SOLO'] : ['SPEC', 'TESTS', 'CODE'];
  if (shape.review !== 'none') steps.push('REVIEW');
  if (shape.arbiter) steps.push('ARBITER');
  return [...steps, 'FINAL_GATES'];
}

/** Commit keys recorded in `RunState.commits`, by step (the resume key). */
export const COMMIT_KEYS = {
  SPEC: 'spec',
  SOLO: 'solo',
  TESTS: 'tests',
  CODE: 'code',
  REVIEW: 'review',
} as const;

/** The stage that writes task.md, and its commit key: SPEC/`spec`, or SOLO/`solo` at levels 1-2. */
export function specStage(state: Pick<RunState, 'level'>): { stage: Stage; key: string } {
  return SHAPES[state.level].solo
    ? { stage: 'SOLO', key: COMMIT_KEYS.SOLO }
    : { stage: 'SPEC', key: COMMIT_KEYS.SPEC };
}

/** Whether the security scan runs in this run: its own setting, else its level's default. */
export function scanOn(state: Pick<RunState, 'level' | 'security_scan'>): boolean {
  return state.security_scan ?? SHAPES[state.level].securityScan;
}

/**
 * Short words for the run's level, e.g. "adversarial" or "full, no scan", with the scan only
 * when it isn't the level's default. Empty for full with the scan on.
 */
export function levelTag(state: Pick<RunState, 'level' | 'security_scan'>): string {
  const scan = scanOn(state);
  if (state.level === 'full' && scan) return '';
  if (scan === SHAPES[state.level].securityScan) return state.level;
  return `${state.level}, ${scan ? 'scan' : 'no scan'}`;
}

/** What a run at `level` doesn't do that a full run with the scan does, in plain words. */
export function droppedSafeguards(level: Level, securityScan: boolean): string[] {
  const shape = SHAPES[level];
  const dropped: string[] = [];
  if (shape.solo) {
    dropped.push(
      "One agent writes task.md, tests and code, so tests aren't written before the " +
        'code and shown to fail',
    );
  }
  if (!shape.critics) {
    if (shape.review === 'none') dropped.push('No second agent checks the change');
    else if (shape.solo) dropped.push('No critic while the work is done: one review at the end');
    else dropped.push('No critics in the test and code steps: one review at the end');
  }
  if (shape.review !== 'full') dropped.push('No standards review', 'No security review');
  if (!shape.arbiter && (shape.critics || shape.review !== 'none')) {
    dropped.push('No arbiter: open findings are always sent back to be fixed');
  }
  if (!securityScan) dropped.push('No security scan');
  return dropped;
}

/** (happy path, worst case) agent calls between two person decisions at `level`. */
export function maxAgentCalls(
  level: Level,
  limits: Pick<Limits, 'max_rounds_tests' | 'max_rounds_code'>,
): [happy: number, worst: number] {
  const shape = SHAPES[level];
  let happy: number;
  let worst: number;
  if (shape.solo) {
    happy = worst = 1;
  } else {
    const perRound = shape.critics ? 3 : 1; // the author, plus a critic and its retry
    const settle = (shape.arbiter ? 2 : 0) + 1; // arbiter and its retry, final author pass
    happy = 1 + 2 * (shape.critics ? 2 : 1);
    worst = 1 + (limits.max_rounds_tests * perRound + settle);
    worst += limits.max_rounds_code * perRound + settle;
    if (shape.critics) worst += 1; // the test-fix pass
  }
  if (shape.review !== 'none') {
    const reviewers = shape.review === 'full' ? 2 : 1;
    const settle = (shape.arbiter ? 2 : 0) + 1;
    happy += reviewers;
    worst += 2 * reviewers + settle;
  }
  return [happy, worst];
}
