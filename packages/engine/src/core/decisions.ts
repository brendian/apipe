import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  DECISION_CHOICES,
  pyRepr,
  type Decision,
  type DecisionKind,
  type Finding,
  type RunState,
  type Stage,
} from '@advpipe/contracts';
import { emit } from './events.js';
import { renderReport } from './report.js';
import { RunLocked, RunLog } from './runlog.js';
import { branchExists, Workspace } from './workspace.js';

// Decision points (docs/02 §11): where a run stops and asks a person to choose. Only a person picks a
// choice (`decide`, called by the host); no code path here or in the orchestrator does. `takeover`,
// `stop` and `finish` end the run at once; the other choices are applied when the run resumes, with
// the worktree kept as it was (`Workspace.reopen({ keepChanges: true })`).

export const MAX_NOTE_CHARS = 8_000;
export const HANDED_OVER_COMMIT = 'advpipe: work in progress, handed over (checks failing)';

/** A decision that can't be recorded; the message is meant for the person deciding. */
export class DecisionError extends Error {
  override name = 'DecisionError';
}

/**
 * Raised from inside a stage when a person has to decide (the scan policy is `ask` and the scan
 * failed). `Orchestrator.run` turns it into a decision point.
 */
export class DecisionNeeded extends Error {
  override name = 'DecisionNeeded';
  constructor(
    readonly kind: DecisionKind,
    readonly findings: Finding[],
    readonly explanation: string,
  ) {
    super(explanation);
  }
}

/** Choices that end the run on the spot; the rest are applied when the run resumes. */
export const ENDING: ReadonlySet<string> = new Set(['takeover', 'stop', 'finish']);

/**
 * The decision that is in force: the latest, except that a *Try again* already acted on doesn't
 * hide the choice made before it (a fix pass a usage limit cut short is still the person's choice).
 */
export function current(state: RunState): Decision | null {
  for (const d of [...state.decisions].reverse()) {
    if (d.kind === 'usage_limit' && d.applied) continue;
    return d;
  }
  return null;
}

/** The run stopped at a decision point and nobody has chosen yet. */
export function awaitingDecision(state: RunState): boolean {
  const d = state.decisions.at(-1);
  return state.status === 'needs_human' && d !== undefined && !d.choice && !state.ended_by;
}

/** A continuing choice (fix, ignore, block, begin, retry) was made and not acted on yet. */
export function pendingChoice(state: RunState): boolean {
  const d = current(state);
  return d !== null && !!d.choice && !ENDING.has(d.choice) && !d.applied && !state.ended_by;
}

/** The run waits at a decision point whose choice has been made, so resuming applies it. */
export const decisionReady = (state: RunState): boolean =>
  state.status === 'needs_human' && pendingChoice(state);

/**
 * The decided, not yet applied decision of `kind` with `choice` (at one of `stages`, if given),
 * or null.
 */
export function take(
  state: RunState,
  kind: DecisionKind,
  choice: string,
  ...stages: Stage[]
): Decision | null {
  const d = current(state);
  if (d === null || d.kind !== kind || d.choice !== choice || d.applied) return null;
  if (stages.length > 0 && !stages.includes(d.stage)) return null;
  return d;
}

/** Why a run can't resume yet: it waits for a decision (02 §19: the choice is made on the run's page). */
export const waitingMessage = (state: RunState): string =>
  `run ${state.run_id} is waiting for a decision: choose on the run's page`;

/** Why a run that a person ended can't resume. */
export function endedMessage(state: RunState): string {
  const how: Record<string, string> = {
    takeover: 'handed over to you',
    stop: 'stopped at your choice',
    finish: 'finished as it was, at your choice',
  };
  return `run ${state.run_id} ended: ${how[state.ended_by] ?? state.ended_by}; nothing to resume`;
}

/** Why a run that isn't at a decision point can't take one. */
export function notWaitingForDecision(state: RunState): string {
  if (state.ended_by) return endedMessage(state);
  return `run ${state.run_id} isn't waiting for a decision (it's ${state.status} at ${state.stage})`;
}

/** The run's cap on person-requested fix passes, from the config it ran with. */
export function maxFixPasses(log: RunLog): number {
  try {
    return log.readConfig()?.limits.max_fix_passes ?? 3;
  } catch {
    return 3;
  }
}

async function branchStillThere(repo: string, branch: string): Promise<boolean> {
  try {
    return branch !== '' && (await branchExists(repo, branch));
  } catch {
    return false;
  }
}

/**
 * Commit the work as it is to the run's branch, remove the worktree (the branch stays) and end the
 * run, so the person can check the branch out.
 */
async function takeOver(repo: string, state: RunState): Promise<void> {
  let what: string;
  if (state.worktree !== '' && existsSync(state.worktree)) {
    const ws = new Workspace(repo, state.worktree, state.branch);
    let committed = false;
    if (await ws.hasChanges()) {
      await ws.commit(HANDED_OVER_COMMIT);
      committed = true;
    }
    await ws.remove();
    state.worktree_removed = true;
    what = committed
      ? 'committed the work as it was and removed the worktree'
      : 'removed the worktree (nothing was uncommitted)';
  } else {
    what = 'the worktree was already gone';
  }
  state.ended_by = 'takeover';
  state.notes.push(
    `Handed over to you at ${state.decisions.at(-1)?.stage ?? state.stage}: ${what}. ` +
      `The branch ${state.branch} has the work as it was.`,
  );
}

/**
 * Record a person's choice at a run's decision point (the host calls this, under the run lock).
 *
 * `takeover`, `stop` and `finish` act at once (commit the work and remove the worktree, or just end
 * the run). The other choices leave the run `needs_human` until something resumes it. Throws
 * DecisionError if the run isn't waiting for a decision, the choice isn't one of that kind's, a
 * live process drives the run, the branch is gone, the note doesn't fit, or `fix` is past
 * `limits.max_fix_passes`.
 */
export async function decide(
  repo: string,
  runId: string,
  choice: string,
  note = '',
): Promise<RunState> {
  const root = path.resolve(repo);
  const log = RunLog.forRun(root, runId);
  if (!existsSync(log.path('run.json'))) throw new DecisionError(`no run ${runId} in ${root}`);
  try {
    log.acquireLock();
  } catch (e) {
    if (!(e instanceof RunLocked)) throw e;
    throw new DecisionError(
      `run ${runId} is still being driven (${e.message}); wait for it to stop`,
    );
  }
  try {
    const state = log.readState();
    const d = state.decisions.at(-1);
    if (!awaitingDecision(state) || d === undefined)
      throw new DecisionError(notWaitingForDecision(state));
    const picked = choice.trim().toLowerCase();
    const choices: readonly string[] = DECISION_CHOICES[d.kind];
    if (!choices.includes(picked)) {
      throw new DecisionError(
        `${pyRepr(picked)} isn't a choice here: choose ${choices.join(' or ')}`,
      );
    }
    if (note && picked !== 'fix') throw new DecisionError('a note goes with the fix choice only');
    if (note.length > MAX_NOTE_CHARS) {
      throw new DecisionError(
        `the note is ${note.length.toLocaleString('en-US')} characters; keep it under ` +
          MAX_NOTE_CHARS.toLocaleString('en-US'),
      );
    }
    if (picked === 'fix' && state.fix_passes >= maxFixPasses(log)) {
      throw new DecisionError(
        `run ${runId} has used all ${state.fix_passes} fix passes it's allowed ` +
          '(limits.max_fix_passes): take over, or start a new run',
      );
    }
    if (picked !== 'stop' && picked !== 'finish' && !(await branchStillThere(root, state.branch))) {
      throw new DecisionError(
        `run ${runId} can't go on: its branch ${state.branch} no longer exists ` +
          '(cleaned up?). Start a new run instead.',
      );
    }
    d.choice = picked;
    d.note = note ? note.trim() : '';
    d.decided_at = new Date().toISOString();
    if (picked === 'takeover') {
      await takeOver(root, state);
    } else if (picked === 'stop') {
      state.ended_by = 'stop';
      state.notes.push(`Stopped at your choice at ${d.stage}.`);
    } else if (picked === 'finish') {
      state.ended_by = 'finish';
      const where = state.worktree ? ` The uncommitted work is in ${state.worktree}.` : '';
      state.notes.push(`Finished as is at ${d.stage}.${where}`);
    }
    log.writeState(state);
    emit(log, state, () => undefined, 'decision', `you chose ${picked} (${d.kind})`, {
      decision_kind: d.kind,
      choice: picked,
      decision_stage: d.stage,
    });
    log.writeText('report.md', renderReport(state));
    return state;
  } finally {
    log.releaseLock();
  }
}
