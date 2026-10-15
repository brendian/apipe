/// <reference lib="dom" />
// The preload shares the page's document, so it needs the DOM types (it still imports no UI code).

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_TABLE,
  PUSH_CHANNELS,
  type AdvpipeApi,
  type PushChannel,
  type Result,
} from '@advpipe/contracts';

/**
 * Builds `window.advpipe` from the IPC table: named methods only. `ipcRenderer` itself, and any
 * generic invoke/send, are never exposed (docs/04 §5.3, docs/08 §3). `app.repo.pick` becomes
 * `advpipe.app.repo.pick(...)`; `on` takes only the push channels in the contract.
 */
function buildApi(): AdvpipeApi {
  const api: Record<string, unknown> = {};
  for (const channel of Object.keys(IPC_TABLE)) {
    const parts = channel.split('.');
    const name = parts.pop() ?? '';
    let node = api;
    for (const part of parts) node = (node[part] ??= {}) as Record<string, unknown>;
    node[name] = (input: unknown = {}): Promise<Result<unknown>> =>
      ipcRenderer.invoke(channel, input) as Promise<Result<unknown>>;
  }
  api['on'] = (channel: PushChannel, callback: (payload: unknown) => void): (() => void) => {
    if (!(PUSH_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(`unknown push channel: ${String(channel)}`);
    }
    const listener = (_event: unknown, payload: unknown): void => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
  return api as unknown as AdvpipeApi;
}

contextBridge.exposeInMainWorld('advpipe', buildApi());

// The theme is set before first paint, so there is no flash of the other one (docs/05 §4.3).
// Main passes it as a launch argument; `system` leaves the OS setting in charge.
const theme = /--advpipe-theme=(light|dark)/.exec(process.argv.join(' '))?.[1];
if (theme) {
  const apply = (): boolean => {
    if (!document.documentElement) return false;
    document.documentElement.setAttribute('data-theme', theme);
    return true;
  };
  if (!apply()) {
    const observer = new MutationObserver(() => apply() && observer.disconnect());
    observer.observe(document, { childList: true });
  }
}
