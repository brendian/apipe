import { z } from 'zod';
import { Level } from './primitives.js';
import { DisplayStatusSchema } from './views.js';

// Work items and the New run form (docs/05 §5.4–§5.6). Plain data the window shows and sends back.
// Every free-text field has a length cap here, so a request can't make main hold huge strings; the
// *meaning* of a value (a bad level, a path outside the folder) is checked by the engine, which
// answers in plain words.

/** A work item's size limit, and a one-off task's (a task is one prompt, not a dataset). */
export const MAX_ITEM_BYTES = 200_000;
export const MAX_TASK_BYTES = 64_000;
/** Folders below the work-items folder. */
export const MAX_ITEM_DEPTH = 4;

/** What a work item's git state looks like to a person (docs/05 §5.5). `''`: committed, unchanged. */
export const GIT_STATES = {
  untracked: { label: 'not in git', help: 'This file has never been committed.' },
  modified: { label: 'uncommitted', help: 'Changed since the last commit.' },
  ignored: { label: 'ignored', help: 'Ignored by git (.gitignore), so it is never committed.' },
} as const;
export const GitStateKey = z.enum(['', 'untracked', 'modified', 'ignored']);
export type GitStateKey = z.infer<typeof GitStateKey>;

const LastRun = z.strictObject({
  run_id: z.string(),
  status: DisplayStatusSchema,
  started_at: z.string(),
});

export const ItemRow = z.strictObject({
  rel: z.string(), // path inside the work-items folder, e.g. "server/s03-stock.md"
  title: z.string(), // the body's first line, or the problem if the file can't be read
  name: z.string().nullable(),
  config: z.string().nullable(),
  problem: z.string().nullable(), // why a run would reject it
  last_run: LastRun.nullable(),
  git: GitStateKey,
});
export type ItemRow = z.infer<typeof ItemRow>;

export const ItemList = z.strictObject({
  items_dir: z.string(), // as the person set it, relative to the repo
  folder_exists: z.boolean(),
  groups: z.array(z.strictObject({ folder: z.string(), items: z.array(ItemRow) })), // "" = top level
  skipped: z.array(z.string()), // .md files whose paths can't be managed here
  git_known: z.boolean(),
});
export type ItemList = z.infer<typeof ItemList>;

const Short = z.string().max(300);
const Setting = z.string().max(300).optional(); // absent: the form didn't carry it; '': inherit

/** What the editor sends: the fields as text. A run setting left out keeps the file's. */
export const DraftInput = z.strictObject({
  rel: Short.default(''),
  name: Short.default(''),
  config: Short.default(''),
  body: z.string().max(MAX_ITEM_BYTES).default(''),
  base: z.string().max(64).default(''), // sha-256 of the file as loaded; '' for a new item
  level: Setting,
  security_scan: Setting,
  scan_failures: Setting,
  bypass_questions: Setting,
});
export type DraftInput = z.input<typeof DraftInput>;

/** A file loaded for the editor. A file that doesn't parse still opens, with the problem. */
export const DraftView = z.strictObject({
  rel: z.string(),
  name: z.string(),
  config: z.string(),
  body: z.string(),
  base: z.string(),
  problem: z.string().nullable(),
  level: z.string(),
  security_scan: z.string(),
  scan_failures: z.string(),
  bypass_questions: z.string(),
  last_run: LastRun.nullable(),
});
export type DraftView = z.infer<typeof DraftView>;

export const DraftChecks = z.strictObject({
  checks: z.array(
    z.strictObject({ level: z.enum(['error', 'warning', 'info']), text: z.string() }),
  ),
  branch: z.string(),
  ok: z.boolean(), // no errors: it can be saved
  preview_html: z.string().nullable(), // the body, markdown escaped by the engine
});
export type DraftChecks = z.infer<typeof DraftChecks>;

export const DeleteInfo = z.strictObject({
  rel: z.string(),
  /** `unknown`: git couldn't say. */
  git: z.enum(['', 'untracked', 'modified', 'ignored', 'unknown']),
  items_dir: z.string(),
});
export type DeleteInfo = z.infer<typeof DeleteInfo>;

// ── New run ────────────────────────────────────────────────────────────────────────────────────

export const SCAN_CHOICES = ['default', 'on', 'off'] as const;

/** The New run form's fields, as text. Empty means "whatever the run would get without this". */
export const RunForm = z.strictObject({
  source: z.string().max(10).default('item'), // "item" or "task"
  item: Short.default(''),
  task: z
    .string()
    .max(4 * MAX_TASK_BYTES)
    .default(''),
  name: z.string().max(1000).default(''),
  config: z.string().max(1000).default(''),
  level: z.string().max(20).default(''), // "1".."5"; '' = the inherited level
  scan: z.string().max(20).default('default'),
  scan_failures: z.string().max(20).default(''),
  bypass: z.boolean().nullable().default(null),
  review: z.boolean().default(false),
  keep_worktree: z.boolean().default(false),
});
export type RunForm = z.infer<typeof RunForm>;
export type RunFormInput = z.input<typeof RunForm>;

/** What starting would do, worked out the way the engine merges settings (docs/02 §16). */
export const RunPlan = z.strictObject({
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  ok: z.boolean(),
  budget: z.number().nullable(),
  budget_text: z.string(),
  config_label: z.string(),
  branch: z.string(),
  item_name: z.string(),
  item_config: z.string(),
  level: Level,
  inherited_level: Level,
  level_source: z.string(),
  scan: z.boolean(),
  scan_default: z.boolean(),
  scan_source: z.string(),
  failures: z.enum(['ask', 'ignore', 'block']),
  inherited_failures: z.enum(['ask', 'ignore', 'block']),
  bypass: z.boolean(),
  inherited_bypass: z.boolean(),
  review: z.boolean(),
  agents: z.number().int(),
  calls: z.tuple([z.number().int(), z.number().int()]),
  dropped: z.array(z.string()),
  /** `level;scan on|off;policy;bypass|ask`: sent back with Start so a run never starts on settings nobody saw. */
  shown_text: z.string(),
});
export type RunPlan = z.infer<typeof RunPlan>;

export const StartForm = RunForm.extend({
  shown: z.string().max(100),
  budget_shown: z.string().max(40),
});
export type StartForm = z.infer<typeof StartForm>;

/** The message when what was shown isn't what start computes now (docs/05 §5.4). */
export const SETTINGS_CHANGED =
  'The settings changed since you looked: check them and press Start again.';
