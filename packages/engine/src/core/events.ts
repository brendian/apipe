import { gatePassed, type EventKind, type GateResult, type RunState } from '@advpipe/contracts';
import type { RunLog } from './runlog.js';

/**
 * Append an event to the run's events.jsonl, then pass `message` to the printer.
 *
 * `echo = false` records the event without printing it, and writes `"echo": false` into it so the
 * UI's live log can skip it (docs/03 §8). Extra `data` fields ride along after the core ones.
 */
export function emit(
  runlog: RunLog,
  state: RunState,
  progress: (message: string) => void,
  kind: EventKind,
  message: string,
  data: Record<string, unknown> = {},
  echo = true,
): void {
  const event: Record<string, unknown> = {
    ts: new Date().toISOString(),
    kind,
    stage: state.stage,
    round: state.round,
    message,
    ...data,
  };
  if (!echo) event['echo'] = false;
  runlog.appendEvent(event);
  if (echo) progress(message);
}

/** `{"test": "fail", "lint": "pass", "types": "skipped"}` for a gates event. */
export function gateStatuses(results: readonly GateResult[]): Record<string, string> {
  return Object.fromEntries(
    results.map((r) => [r.name, r.skipped ? 'skipped' : gatePassed(r) ? 'pass' : 'fail']),
  );
}
