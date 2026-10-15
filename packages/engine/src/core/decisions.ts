import type { DecisionKind, Finding } from '@advpipe/contracts';

// Decision points (docs/02 §11). M3 needs only the signal a stage raises from deep inside;
// the rest of this module (`ask`, `decide`, `take`, ...) lands in M5.

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
