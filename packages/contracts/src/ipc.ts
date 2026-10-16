import { z } from 'zod';
import { CleanInfoView, LinkKey } from './actions.js';
import { AboutView, HelpView } from './help.js';
import { isValidRunId, QUESTION_ID_RE } from './primitives.js';
import { ContextView, RunDetailOut, type LogPush } from './detail.js';
import {
  DeleteInfo,
  DraftChecks,
  DraftInput,
  DraftView,
  ItemList,
  RunForm,
  RunPlan,
  StartForm,
} from './items.js';
import {
  FilterKeySchema,
  Preflight,
  PrefsView,
  RunList,
  ThemePref,
  UsageView,
  WindowInfo,
} from './views.js';

/** `Result<T>`: errors are values, never thrown across IPC (docs/04 §5.1). */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const RunId = z.string().max(100).refine(isValidRunId, 'not a run id');
const None = z.strictObject({});

/**
 * The IPC invoke table: channel -> { input, output }. The single source for main's handlers and
 * the preload bridge (docs/04 §5). Channels land milestone by milestone; M7 has the shell and the
 * runs list. Nothing here accepts a path from the window except through the folder picker, which
 * main runs itself.
 */
export const IPC_TABLE = {
  'app.window.info': { input: None, output: WindowInfo },
  'app.prefs.get': { input: None, output: PrefsView },
  'app.prefs.set': {
    input: z.strictObject({
      theme: ThemePref.optional(),
      notifications: z.boolean().optional(),
      run_filter: FilterKeySchema.optional(),
      /** The work-items folder for this window's repo, relative to it (main checks it's inside). */
      items_dir: z.string().min(1).max(300).optional(),
    }),
    output: PrefsView,
  },
  'app.repo.pick': {
    input: None,
    output: z.strictObject({ opened: z.boolean() }),
  },
  'app.repo.openRecent': {
    input: z.strictObject({ index: z.number().int().min(0).max(9) }),
    output: z.strictObject({ opened: z.boolean() }),
  },
  'app.repo.forgetRecent': {
    input: z.strictObject({ index: z.number().int().min(0).max(9) }),
    output: PrefsView,
  },
  'app.preflight': { input: None, output: Preflight },
  // Help and About (docs/05 §5.8): fixed text built from the code's own tables; no repo needed.
  'app.help': { input: None, output: HelpView },
  'app.about': { input: None, output: AboutView },
  // Opens the host's log folder in the file manager. Takes nothing: main knows where it is.
  'app.logs.open': { input: None, output: z.strictObject({ ok: z.boolean() }) },
  'runs.list': {
    input: z.strictObject({ show: FilterKeySchema }),
    output: RunList,
  },
  'runs.detail': {
    input: z.strictObject({ runId: RunId }),
    output: RunDetailOut,
  },
  'runs.context': {
    input: z.strictObject({ runId: RunId }),
    output: ContextView.nullable(),
  },
  // The live log: subscribe from a byte offset, then `run.log` pushes carry what is new.
  'runs.log.subscribe': {
    input: z.strictObject({ runId: RunId, offset: z.number().int().min(0) }),
    output: z.strictObject({ ok: z.boolean() }),
  },
  'runs.log.unsubscribe': {
    input: z.strictObject({ runId: RunId }),
    output: z.strictObject({ ok: z.boolean() }),
  },
  'usage.get': { input: None, output: UsageView },
  // Work items (docs/05 §5.5-§5.6). Paths are relative to the work-items folder, and the engine's
  // one path gate decides whether one is allowed.
  'items.list': { input: None, output: ItemList },
  'items.read': { input: z.strictObject({ rel: z.string().max(300) }), output: DraftView },
  'items.check': { input: DraftInput, output: DraftChecks },
  'items.create': { input: DraftInput, output: z.strictObject({ rel: z.string() }) },
  'items.save': { input: DraftInput, output: z.strictObject({ changed: z.boolean() }) },
  'items.rename': {
    input: z.strictObject({ rel: z.string().max(300), new_rel: z.string().max(300) }),
    output: z.strictObject({ rel: z.string() }),
  },
  'items.deleteInfo': { input: z.strictObject({ rel: z.string().max(300) }), output: DeleteInfo },
  'items.delete': {
    input: z.strictObject({ rel: z.string().max(300), confirm: z.literal(true) }),
    output: z.strictObject({ deleted: z.string() }),
  },
  // New run (docs/05 §5.4): plan, then start only if what was shown is still what is computed.
  'newrun.plan': { input: RunForm, output: RunPlan },
  'newrun.start': { input: StartForm, output: z.strictObject({ runId: RunId }) },
  // Actions on a run (docs/05 §5.2.2-§5.2.5, §5.7). The host checks every one against the run's
  // displayed status (`VALID`) and refuses a stale one; the limits on answers and notes are the
  // engine's, and its messages are shown as written, so the schema only bounds the size.
  'run.cancel': {
    input: z.strictObject({ runId: RunId }),
    output: z.strictObject({ runId: RunId }),
  },
  'run.resume': {
    input: z.strictObject({ runId: RunId, budget: z.string().max(40).optional() }),
    output: z.strictObject({ runId: RunId }),
  },
  'run.answer': {
    input: z.strictObject({
      runId: RunId,
      answers: z.record(z.string().regex(QUESTION_ID_RE), z.string().max(100_000)),
      bypass: z.array(z.string().regex(QUESTION_ID_RE)).max(200),
      bypassAll: z.boolean().optional(),
    }),
    output: z.strictObject({ runId: RunId }),
  },
  'run.decide': {
    input: z.strictObject({
      runId: RunId,
      choice: z.string().max(20),
      note: z.string().max(16_000).optional(),
      /** review_step on the spec: the spec text as the person edited it, sent with `approve`. */
      edited: z.string().max(200_000).optional(),
      /** Only the confirmation page's button sends this; takeover, stop and finish need it. */
      confirm: z.boolean().optional(),
    }),
    output: z.strictObject({ runId: RunId, resumed: z.boolean() }),
  },
  'run.cleanInfo': { input: z.strictObject({ runId: RunId }), output: CleanInfoView },
  'run.clean': {
    input: z.strictObject({
      runId: RunId,
      force: z.boolean(),
      logs: z.boolean(),
      confirm: z.literal(true),
    }),
    output: z.strictObject({ lines: z.array(z.string()) }),
  },
  'run.reveal': {
    input: z.strictObject({ runId: RunId, what: z.enum(['worktree', 'runDir', 'report']) }),
    output: z.strictObject({ ok: z.boolean() }),
  },
  'run.openLink': {
    input: z.strictObject({ key: LinkKey }),
    output: z.strictObject({ ok: z.boolean() }),
  },
} as const;

export type IpcChannel = keyof typeof IPC_TABLE;
export type IpcInput<C extends IpcChannel> = z.infer<(typeof IPC_TABLE)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.infer<(typeof IPC_TABLE)[C]['output']>;

/** Push channels (main -> renderer) and their payloads (docs/04 §5.2). */
export type PushPayloads = {
  /** Any run.json/run.lock under `.advpipe/runs/` changed: the list refetches. */
  'runs.changed': Record<string, never>;
  /** That run's files changed: an open detail page refetches. */
  'run.changed': { runId: string };
  /** New complete events in a subscribed run's events.jsonl. */
  'run.log': LogPush;
  /** `usage.json` changed. */
  'usage.changed': Record<string, never>;
  /** A native menu item: navigate. */
  'app.menu': { action: MenuAction };
  /** A desktop notification was clicked: show that run. */
  'app.openRun': { runId: string };
};
export const MENU_ACTIONS = [
  'runs',
  'new-run',
  'items',
  'new-item',
  'help',
  'theme-system',
  'theme-light',
  'theme-dark',
] as const;
export type MenuAction = (typeof MENU_ACTIONS)[number];
export type PushChannel = keyof PushPayloads;
export const PUSH_CHANNELS = [
  'runs.changed',
  'run.changed',
  'run.log',
  'usage.changed',
  'app.menu',
  'app.openRun',
] as const;

// ── the typed bridge: `window.advpipe.<ns>.<name>(input) => Promise<Result<output>>` ──────────────
type Fn<C extends IpcChannel> = (input: IpcInput<C>) => Promise<Result<IpcOutput<C>>>;
type Nest<K extends string, V> = K extends `${infer Head}.${infer Tail}`
  ? { [P in Head]: Nest<Tail, V> }
  : { [P in K]: V };
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;
type Flatten<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends object
      ? Flatten<T[K]>
      : T[K];
};

type InvokeApi = Flatten<UnionToIntersection<{ [C in IpcChannel]: Nest<C, Fn<C>> }[IpcChannel]>>;

export type AdvpipeApi = InvokeApi & {
  /** Subscribe to a push channel; returns the unsubscribe function. */
  on<C extends PushChannel>(channel: C, callback: (payload: PushPayloads[C]) => void): () => void;
};
