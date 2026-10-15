import type { Level, Stage } from './primitives.js';
import { LEVEL_INFO, levelNumber } from './levels.js';

// What a run's *displayed* status is called and means (docs/05 §6). `run.json` keeps the real
// status; the engine's `displayStatus` derives one of these keys from it and the run's lock.
// Ported from `ui/runs.py`, with the CLI commands in the help texts replaced by the buttons that
// do the same (docs/02 §19). The renderer only maps a key to this table; it never derives status.

export const DISPLAY_STATUSES = [
  'running',
  'stopped',
  'complete',
  'needs_human',
  'needs_answers',
  'needs_decision',
  'paused',
  'handed_over',
  'ended',
  'finished',
  'budget_exceeded',
  'error',
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export type StatusInfo = { label: string; icon: string; help: string };

export const STATUSES: Readonly<Record<DisplayStatus, StatusInfo>> = {
  running: {
    label: 'running',
    icon: '●',
    help: 'An advpipe process is working on this run right now.',
  },
  stopped: {
    label: 'stopped',
    icon: '■',
    help: 'Interrupted or cancelled part-way through. Continue it with Resume.',
  },
  complete: {
    label: 'complete',
    icon: '✔',
    help: 'Finished with all checks passing. The branch is ready for you to review and merge.',
  },
  needs_human: {
    label: 'needs you',
    icon: '⚠',
    help:
      'Stopped for a person to decide: open findings, failing checks, or a blocking question ' +
      'in task.md. The report says which.',
  },
  needs_answers: {
    label: 'needs answers',
    icon: '?',
    help:
      "The spec has questions only you can answer. Answer them on the run's page and the same " +
      'run carries on.',
  },
  needs_decision: {
    label: 'needs a decision',
    icon: '◆',
    help:
      'The run stopped to ask you to choose: another fix pass or take over, ignore or block ' +
      "security scan hits, or begin work without the answers. Choose on the run's page and the " +
      'same run carries on.',
  },
  paused: {
    label: 'paused: usage limit',
    icon: '⏸',
    help:
      'A usage limit (or the Console credit balance) ran out. The run is paused with its work ' +
      "kept. Add usage or credits, or wait for the reset, then press Try again on the run's " +
      'page, or finish it as it is.',
  },
  handed_over: {
    label: 'handed over',
    icon: '→',
    help:
      'You took over. The branch has the work as it was, and the working copy is removed. ' +
      'Check the branch out and finish it by hand.',
  },
  ended: {
    label: 'ended',
    icon: '■',
    help:
      "You chose to stop at this point. Nothing was written to the branch, and the run can't " +
      'be resumed.',
  },
  finished: {
    label: 'finished as is',
    icon: '■',
    help:
      'You finished this run as it was when a usage limit stopped it. Nothing was committed: ' +
      "the work is in its working copy, uncommitted. The run can't be resumed.",
  },
  budget_exceeded: {
    label: 'over budget',
    icon: '$',
    help: 'Hit its dollar limit. Continue with a bigger limit using Resume.',
  },
  error: {
    label: 'error',
    icon: '✖',
    help: 'Stopped by an unexpected error (see the report). It can be resumed.',
  },
};

export const FILTER_KEYS = ['all', 'running', 'needs_you', 'complete'] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export const FILTERS: Readonly<
  Record<FilterKey, { label: string; statuses: ReadonlySet<DisplayStatus> }>
> = {
  all: { label: 'All', statuses: new Set(DISPLAY_STATUSES) },
  running: { label: 'Running', statuses: new Set<DisplayStatus>(['running']) },
  needs_you: {
    label: 'Needs you',
    statuses: new Set<DisplayStatus>([
      'stopped',
      'needs_human',
      'needs_answers',
      'needs_decision',
      'paused',
      'budget_exceeded',
      'error',
    ]),
  },
  complete: { label: 'Complete', statuses: new Set<DisplayStatus>(['complete']) },
};

/** Plain words in the UI: "checks", not "gates". */
export const STAGE_LABELS: Readonly<Partial<Record<Stage, string>>> = {
  FINAL_GATES: 'FINAL CHECKS',
};

/** The work item's first non-empty line, without a leading markdown heading mark (≤ `width`). */
export function titleOf(workItem: string, width = 80): string {
  const first = workItem.split(/\r?\n|\r/).find((line) => line.trim() !== '') ?? '';
  const text = first.trim().replace(/^#+/, '').trim() || '(empty work item)';
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** `just now`, `N min ago`, `N h ago`, `N day(s) ago`. */
export function ageOf(then: string | Date, now: string | Date = new Date()): string {
  const ms = new Date(now).getTime() - new Date(then).getTime();
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86_400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** `Tests (3 of 5)`, for the level chip. */
export function levelText(level: Level): string {
  return `${LEVEL_INFO[level].label} (${levelNumber(level)} of 5)`;
}
