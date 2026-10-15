import { z } from 'zod';
import { Stage } from './primitives.js';

// Events: one JSON object per line in `events.jsonl` (docs/03 §8).

export const EVENT_KINDS = [
  'run_start',
  'stage',
  'round',
  'agent_start',
  'agent_done',
  'gates',
  'verdict',
  'guard',
  'test_fix',
  'ruling',
  'status',
  'error',
  'questions',
  'answers',
  'decision',
  'usage',
] as const;
export const EventKind = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKind>;

/** The fields every event has; kind-specific fields ride along (`z.looseObject`). */
export const EventLine = z.looseObject({
  ts: z.string(), // UTC, millisecond precision, 'Z'
  kind: EventKind,
  stage: Stage,
  round: z.number().int(),
  message: z.string(),
  echo: z.boolean().optional(), // written only as `false`: the line is data, not a log line
  final: z.boolean().optional(), // the last event of a driving process
});
export type EventLine = z.infer<typeof EventLine>;

/** Whether the live log should show this event (the final `status` line is data). */
export function isLogLine(e: Pick<EventLine, 'echo' | 'final'>): boolean {
  return e.echo !== false && e.final !== true;
}
