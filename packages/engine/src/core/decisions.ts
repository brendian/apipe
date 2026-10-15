import type { Decision, DecisionKind, Finding, RunState, Stage } from '@advpipe/contracts';

// Decision points (docs/02 §11). M4 has what the orchestrator itself needs: the signal a stage raises
// from deep inside, and the read-only helpers (`current`, `take`, `pendingChoice`, ...). Recording a
// person's choice (`decide`, `takeover`, ...) lands in M5.

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
