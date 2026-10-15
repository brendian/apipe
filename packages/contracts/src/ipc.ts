import { z } from 'zod';

/** `Result<T>`: errors are values, never thrown across IPC (docs/04 §5.1). */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The IPC invoke table: channel -> { input, output }. The single source for main's handlers and
 * the preload bridge (docs/04 §5). M0 has one channel; the product channels arrive from M7.
 */
export const IPC_TABLE = {
  'app.ping': {
    input: z.strictObject({ message: z.string().max(200) }),
    output: z.strictObject({ reply: z.string() }),
  },
} as const;

export type IpcChannel = keyof typeof IPC_TABLE;
export type IpcInput<C extends IpcChannel> = z.infer<(typeof IPC_TABLE)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.infer<(typeof IPC_TABLE)[C]['output']>;

/** Push channels (main -> renderer). None yet. */
export const PUSH_CHANNELS = [] as const;

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
type Flatten<T> = { [K in keyof T]: T[K] };

export type AdvpipeApi = Flatten<
  UnionToIntersection<{ [C in IpcChannel]: Nest<C, Fn<C>> }[IpcChannel]>
>;
