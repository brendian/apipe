import { z } from 'zod';
import { Level, LoginKind } from './primitives.js';
import { DISPLAY_STATUSES, FILTER_KEYS } from './statuses.js';

// What the read models hand the window (docs/04 §4, docs/05). Plain data: the renderer never reads
// files and never derives status itself.

export const DisplayStatusSchema = z.enum(DISPLAY_STATUSES);
export const FilterKeySchema = z.enum(FILTER_KEYS);

/** One line of the runs list. Ages are computed in the window from `started_at`. */
export const RunRow = z.strictObject({
  run_id: z.string(),
  status: DisplayStatusSchema,
  title: z.string(),
  branch: z.string(),
  stage: z.string(), // `CODE r2/3`
  cost_usd: z.number(),
  budget_usd: z.number().nullable(),
  started_at: z.string(),
  work_item_file: z.string(),
  level: Level,
});
export type RunRow = z.infer<typeof RunRow>;

export const RunList = z.strictObject({
  rows: z.array(RunRow), // newest first, only those the asked-for filter shows
  counts: z.strictObject({
    all: z.number().int(),
    running: z.number().int(),
    needs_you: z.number().int(),
    complete: z.number().int(),
  }),
  unreadable: z.array(z.strictObject({ run_id: z.string(), error: z.string() })),
});
export type RunList = z.infer<typeof RunList>;

/** A run whose worker has started but not yet written run.json (docs/05 §5.2.9). */
export const Starting = z.strictObject({
  kind: z.literal('starting'),
  run_id: z.string(),
  alive: z.boolean(), // a live process still holds run.lock
  console_tail: z.string(),
});
export type Starting = z.infer<typeof Starting>;

export const Meter = z.strictObject({
  window: z.string(),
  label: z.string(), // "5-hour"
  percent: z.number().int().nullable(),
  text: z.string(), // "62% used, resets 14:00"
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  stale: z.boolean(),
  seen: z.string(), // "5 min ago"
});
export type Meter = z.infer<typeof Meter>;

/** The login and usage line (docs/05 §5.1): last known, with its age, never a live gauge. */
export const UsageView = z.strictObject({
  login: LoginKind,
  login_label: z.string(),
  cost_label: z.string(),
  console: z.boolean(), // known or likely Console credits: warn about real money
  warn: z.string(),
  note: z.string(),
  meters: z.array(Meter),
});
export type UsageView = z.infer<typeof UsageView>;

export const Check = z.strictObject({
  ok: z.boolean(),
  /** `ok` is a pass, `warn` is information the person should see, `bad` blocks New run. */
  level: z.enum(['ok', 'warn', 'bad']),
  text: z.string(),
});
export const Preflight = z.strictObject({
  git: Check.extend({ version: z.string() }),
  repo: Check.extend({
    is_git: z.boolean(),
    has_commit: z.boolean(),
    branch: z.string(),
    dirty: z.number().int(),
  }),
  claude: Check.extend({ login: LoginKind, version: z.string() }),
  items_dir: Check.extend({ path: z.string(), exists: z.boolean() }),
});
export type Preflight = z.infer<typeof Preflight>;

export const ThemePref = z.enum(['system', 'light', 'dark']);
export type ThemePref = z.infer<typeof ThemePref>;

/** `<userData>/preferences.json` (docs/03 §11). Read tolerantly: a bad file is the defaults. */
export const Prefs = z.object({
  theme: ThemePref.default('system'),
  recent_repos: z.array(z.string()).max(10).default([]),
  windows: z
    .record(
      z.string(),
      z.object({
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number(),
        height: z.number(),
        maximized: z.boolean().default(false),
      }),
    )
    .default({}),
  notifications: z.boolean().default(true),
  items_dir: z.record(z.string(), z.string()).default({}),
  run_filter: z.record(z.string(), FilterKeySchema).default({}), // per repo: the selected filter
});
export type Prefs = z.infer<typeof Prefs>;

/** What a window may see of the preferences: no raw paths it could act on, just labels. */
export const PrefsView = z.strictObject({
  theme: ThemePref,
  notifications: z.boolean(),
  run_filter: FilterKeySchema,
  recent: z.array(
    z.strictObject({
      index: z.number().int(),
      name: z.string(),
      path: z.string(),
      exists: z.boolean(),
    }),
  ),
});
export type PrefsView = z.infer<typeof PrefsView>;

export const WindowInfo = z.strictObject({
  repo: z.strictObject({ name: z.string(), path: z.string() }).nullable(),
});
export type WindowInfo = z.infer<typeof WindowInfo>;
