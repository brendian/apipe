import { useCallback, useEffect, useRef, useState } from 'react';
import type { PushChannel, PushPayloads, Result } from '@advpipe/contracts';
import { useApi } from './api.js';

export type Remote<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: string; value?: T };

export type RefetchOn = { [C in PushChannel]?: (payload: PushPayloads[C]) => boolean };

/** After a push, wait this long for more before refetching (trailing, not a throttle). */
export const REFETCH_DELAY_MS = 300;

/**
 * Server truth, fetched over IPC. The last good value stays on screen while a refetch runs, and
 * `refetchOn` names the pushes that mean "look again" (each with an optional filter). A late answer
 * to an old request never overwrites a newer one. Nothing here is a source of truth for run data.
 */
export function useRemote<T>(
  load: () => Promise<Result<T>>,
  deps: readonly unknown[],
  refetchOn: RefetchOn = {},
): { state: Remote<T>; reload: () => void } {
  const api = useApi();
  const [state, setState] = useState<Remote<T>>({ status: 'loading' });
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => {
    const mine = ++seq.current;
    loadRef.current().then(
      (r) => {
        if (mine !== seq.current) return;
        setState((prev) =>
          r.ok
            ? { status: 'ready', value: r.value }
            : {
                status: 'error',
                error: r.error,
                ...(prev.status === 'ready' || prev.status === 'error'
                  ? prev.value !== undefined
                    ? { value: prev.value }
                    : {}
                  : {}),
              },
        );
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      },
    );
  }, []);

  // The caller's `deps` say when the request itself changes.
  useEffect(() => reload(), deps);

  const channels = Object.keys(refetchOn).join(',');
  const filtersRef = useRef(refetchOn);
  filtersRef.current = refetchOn;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offs = (channels ? (channels.split(',') as PushChannel[]) : []).map((channel) =>
      api.on(channel, (payload) => {
        const match = filtersRef.current[channel] as ((p: unknown) => boolean) | undefined;
        if (match && !match(payload)) return;
        clearTimeout(timer);
        timer = setTimeout(reload, REFETCH_DELAY_MS);
      }),
    );
    return () => {
      clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [api, channels, reload]);

  return { state, reload };
}
