import { z } from 'zod';
import { isValidRunId } from './primitives.js';
import { ContextView, RunDetailOut, type LogPush } from './detail.js';
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
