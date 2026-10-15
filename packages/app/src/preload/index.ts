import { contextBridge, ipcRenderer } from 'electron';
import { IPC_TABLE, type AdvpipeApi, type Result } from '@advpipe/contracts';

/**
 * Builds `window.advpipe` from the IPC table: named methods only. `ipcRenderer` itself, and any
 * generic invoke/send, are never exposed (docs/04 §5.3, docs/08 §3).
 */
function buildApi(): AdvpipeApi {
  const api: Record<string, Record<string, unknown>> = {};
  for (const channel of Object.keys(IPC_TABLE)) {
    const [ns = '', name = ''] = channel.split('.');
    (api[ns] ??= {})[name] = (input: unknown): Promise<Result<unknown>> =>
      ipcRenderer.invoke(channel, input) as Promise<Result<unknown>>;
  }
  return api as unknown as AdvpipeApi;
}

contextBridge.exposeInMainWorld('advpipe', buildApi());
