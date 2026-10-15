import {
  IPC_TABLE,
  type IpcChannel,
  type IpcInput,
  type IpcOutput,
  type Result,
} from '@advpipe/contracts';

/** What a handler needs from its caller. Kept Electron-free so handlers are unit-testable. */
export interface SenderInfo {
  /** URL of the frame that sent the message. */
  frameUrl: string;
  /** True only for a web contents belonging to a window we created. */
  isOurWindow: boolean;
}

export type Handlers = {
  [C in IpcChannel]: (input: IpcInput<C>) => Promise<IpcOutput<C>>;
};

export const APP_ORIGIN = 'app://renderer';

/** Handlers hold the logic; `createHandlers` is where product channels get their engine deps (M7+). */
export function createHandlers(): Handlers {
  return {
    'app.ping': async ({ message }) => ({ reply: `pong: ${message}` }),
  };
}

function senderAllowed(sender: SenderInfo, devOrigin: string | null): boolean {
  if (!sender.isOurWindow) return false;
  return (
    sender.frameUrl.startsWith(`${APP_ORIGIN}/`) ||
    (devOrigin !== null && sender.frameUrl.startsWith(devOrigin))
  );
}

/**
 * The one entry point for every invoke channel: check the sender, parse the input, run the handler,
 * parse the output. Errors are values, never thrown across IPC (docs/04 §5.1, docs/08 §3).
 */
export async function dispatch(
  handlers: Handlers,
  channel: string,
  raw: unknown,
  sender: SenderInfo,
  devOrigin: string | null = null,
): Promise<Result<unknown>> {
  if (!senderAllowed(sender, devOrigin)) return { ok: false, error: 'Request refused.' };
  if (!Object.hasOwn(IPC_TABLE, channel)) return { ok: false, error: 'Unknown request.' };
  const name = channel as IpcChannel;
  const spec = IPC_TABLE[name];
  const input = spec.input.safeParse(raw);
  if (!input.success) return { ok: false, error: 'Invalid request.' };
  try {
    const handler = handlers[name] as (i: unknown) => Promise<unknown>;
    const output = spec.output.parse(await handler(input.data));
    return { ok: true, value: output };
  } catch (err) {
    console.error(`ipc ${channel} failed:`, err);
    return { ok: false, error: 'Something went wrong. The details are in the log.' };
  }
}
