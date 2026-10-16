import { z } from 'zod';
import { parseLevel } from './levels.js';
import { Level, ScanPolicy } from './primitives.js';

// Config: `pipeline.toml` and the per-run `config.json` (docs/03 §4). Every table rejects unknown
// keys so a typo fails loudly. Parsing TOML is the engine's job; this is only the schema.

const posInt = z.number().int().positive();

export const Models = z.strictObject({
  author: z.string().default('claude-opus-5-5'),
  critic: z.string().default('claude-sonnet-5-5'),
  arbiter: z.string().default('claude-opus-5-5'),
});

export const Limits = z.strictObject({
  // Spec-writer passes per run: the first spec plus one per round of answers.
  max_rounds_spec: posInt.default(3),
  max_rounds_tests: posInt.default(2),
  max_rounds_code: posInt.default(3),
  max_turns_per_agent: posInt.default(40),
  budget_usd_per_task: z.number().positive().default(15.0),
  gate_timeout_s: posInt.default(600),
  // Extra fix passes a person can ask for in one run, when checks stay red.
  max_fix_passes: posInt.default(3),
});
export type Limits = z.infer<typeof Limits>;

/** Commands run from the worktree root. An empty list means the gate is skipped. */
export const Gates = z.strictObject({
  test: z.array(z.string()).default(['npm', 'test']),
  types: z.array(z.string()).default(['npx', 'tsc', '--noEmit']),
  lint: z.array(z.string()).default(['npx', 'eslint', '.']),
  security: z.array(z.string()).default(['semgrep', '--error', '--config', 'auto']),
});

export const GATE_NAMES = ['test', 'types', 'lint', 'security'] as const;
export type GateName = (typeof GATE_NAMES)[number];

export const Paths = z.strictObject({
  tests: z.array(z.string()).default(['tests/']),
  standards_doc: z.string().default('CLAUDE.md'),
});

/** A level written as a name or as 1-5 (stored as the name). */
const LevelNameOrNumber = z.union([z.string(), z.number()]).transform((value, ctx) => {
  try {
    return parseLevel(value);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
    return z.NEVER;
  }
});

export const Pipeline = z.strictObject({
  level: LevelNameOrNumber.pipe(Level).default('full'),
  security_scan: z.boolean().nullable().default(null), // null: the level's default
  scan_failures: ScanPolicy.default('ask'), // what a failing scan means below full
  bypass_questions: z.boolean().default(false),
});

export const Config = z.strictObject({
  models: Models.prefault({}),
  limits: Limits.prefault({}),
  gates: Gates.prefault({}),
  paths: Paths.prefault({}),
  pipeline: Pipeline.prefault({}),
});
export type Config = z.infer<typeof Config>;

/** A config with every default. */
export const defaultConfig = (): Config => Config.parse({});
