import { z } from 'zod';
import { isValidRunId, Level, ScanPolicy } from './primitives.js';

// `start.json` (docs/03 §7): what the host asks a worker to do. Written before the worker is
// spawned, so no run parameter travels as a command-line argument.

const RunId = z.string().refine(isValidRunId, 'invalid run id');

export const StartRun = z.strictObject({
  command: z.literal('run'),
  run_id: RunId,
  repo: z.string().min(1),
  work_item: z.string(),
  work_item_file: z.string().default(''),
  name: z.string().nullable(),
  config_path: z.string().nullable(),
  keep_worktree: z.boolean().default(false),
  // The already-merged effective settings; the worker applies them verbatim.
  level: Level,
  security_scan: z.boolean().nullable(),
  scan_failures: ScanPolicy,
  bypass_questions: z.boolean(),
  budget_usd: z.number().positive().nullable(),
});

export const StartResume = z.strictObject({
  command: z.literal('resume'),
  run_id: RunId,
  repo: z.string().min(1),
  budget_usd: z.number().positive().nullable(),
  locked_for_me: z.literal(true),
});

export const StartRequest = z.discriminatedUnion('command', [StartRun, StartResume]);
export type StartRun = z.infer<typeof StartRun>;
export type StartResume = z.infer<typeof StartResume>;
export type StartRequest = z.infer<typeof StartRequest>;
