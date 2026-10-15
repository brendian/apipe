import { z } from 'zod';
import { DisplayStatusSchema } from './views.js';
import type { DisplayStatus } from './statuses.js';

// What a person can do to a run, and when (docs/05 §5.2.2, §5.7, §7, §8). Pure: the engine's
// action functions enforce it in the host, and the window uses the same table to decide which
// buttons to draw. Port of `ui/actions.py` (VALID, `allowed`, `suggested_budget`, `parse_budget`).

export const ACTIONS = ['cancel', 'resume', 'answer', 'decide', 'clean'] as const;
export type RunAction = (typeof ACTIONS)[number];

/** Which actions make sense for each displayed status. The host checks again on every call. */
export const VALID: Readonly<Record<DisplayStatus, readonly RunAction[]>> = {
  running: ['cancel'],
  stopped: ['resume', 'clean'],
  error: ['resume', 'clean'],
  budget_exceeded: ['resume', 'clean'],
  needs_human: ['clean'],
  needs_answers: ['answer', 'clean'],
  needs_decision: ['decide', 'clean'],
  paused: ['decide', 'clean'],
  handed_over: ['clean'],
  ended: ['clean'],
  finished: ['clean'],
  complete: [],
};

export const allowed = (status: DisplayStatus, action: RunAction): boolean =>
  VALID[status].includes(action);

/** Length limits the window shows and the host enforces (docs/02 §5.1, §11). */
export const MAX_ANSWER_CHARS = 8_000;
export const MAX_TOTAL_ANSWER_CHARS = 24_000;
export const MAX_NOTE_CHARS = 8_000;

/** The message for an action a run no longer allows (the original's HTTP 409). */
export const STALE_MESSAGE = (status: DisplayStatus): string =>
  `This run changed since you looked (it's now ${status.replaceAll('_', ' ')}). Reload.`;

/** A bigger budget for a run that ran out: double it, and at least $5 more than spent. */
export function suggestedBudget(costUsd: number, budgetUsd: number | null): number {
  return Math.ceil(budgetUsd ? Math.max(budgetUsd * 2, costUsd + 5) : 30);
}

/**
 * The new total budget typed in the resume form: `null` for "keep it" (only when not `required`).
 * Throws an Error whose message says what's wrong, for the person.
 */
export function parseBudget(text: string, spentUsd: number, required: boolean): number | null {
  const typed = text.trim().replace(/^\$/, '').trim();
  if (typed === '') {
    if (required) throw new Error('This run ran out of budget: give it a bigger one to continue.');
    return null;
  }
  const value = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(typed) ? Number(typed) : NaN;
  if (Number.isNaN(value)) throw new Error(`'${typed}' isn't an amount in dollars.`);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('The budget must be a positive amount in dollars.');
  }
  if (value <= spentUsd) {
    throw new Error(
      `The budget is the total for the run, and it has spent $${spentUsd.toFixed(2)} ` +
        'already: give it more than that.',
    );
  }
  return Math.round(value * 100) / 100;
}

/** After an action the window navigates with one of these keys; the page maps it to fixed text. */
export const NOTICES = {
  started: 'The run has started. It works in the background, so you can close this window.',
  resumed: 'The run is going again in the background.',
  answered: 'Your answers are saved and the run is carrying on.',
  bypassed: 'The agent is deciding the questions, and the run is carrying on.',
  decided: 'Your choice is saved and the run is carrying on.',
  handed_over: 'Handed over. The work is committed to the branch and the working copy is removed.',
  ended: 'The run is ended. Nothing was written to the branch.',
  finished: 'The run is finished as it is. The work is in its working copy, uncommitted.',
  cancelled: 'Cancelling: the run stops at its next safe point and can be resumed.',
  cleaned: 'Cleaned up.',
} as const;
export type NoticeKey = keyof typeof NOTICES;
export const isNoticeKey = (key: string | null): key is NoticeKey =>
  key !== null && Object.hasOwn(NOTICES, key);

/** The notice a decision's choice leads to. */
export function decisionNotice(choice: string): NoticeKey {
  if (choice === 'takeover') return 'handed_over';
  if (choice === 'stop') return 'ended';
  if (choice === 'finish') return 'finished';
  return 'decided';
}

/** What cleaning a run up would do (docs/05 §5.7), for its confirmation page. */
export const CleanInfoView = z.strictObject({
  run_id: z.string(),
  title: z.string(),
  status: DisplayStatusSchema,
  /** Why this run can't be cleaned up at all; null when it can. */
  refusal: z.string().nullable(),
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  /** Commits only this branch has: lost if it's deleted. */
  unmerged_commits: z.number().int(),
  /** A finished-as-is run whose working copy holds uncommitted work. */
  dirty_finished: z.boolean(),
  /** First 12 characters of the run's base commit, for the "look at them first" hint. */
  base: z.string(),
});
export type CleanInfoView = z.infer<typeof CleanInfoView>;

/** The two links a run page may open in the system browser: the window names one, never a URL. */
export const LINK_KEYS = ['add_usage', 'add_credits'] as const;
export const LinkKey = z.enum(LINK_KEYS);
