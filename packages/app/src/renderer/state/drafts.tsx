import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

// What a person has typed into a form that a live refresh must not wipe (the answer form's text and
// Bypass ticks, the decision note), kept by a stable key such as `answers:<runId>` (docs/04 §7).
// Drafts live only here, in the window; nothing is stored, and nothing here is run data.

const DraftContext = createContext<Map<string, unknown> | null>(null);

export function DraftStateProvider({ children }: { children: ReactNode }) {
  const store = useRef(new Map<string, unknown>());
  return <DraftContext.Provider value={store.current}>{children}</DraftContext.Provider>;
}

/** `[value, setValue]` for the draft `key`; `initial` is used until something is typed. */
export function useDraft<T>(key: string, initial: T): [T, (next: T) => void] {
  const store = useContext(DraftContext);
  const [local, setLocal] = useState<T>(initial);
  const stored = store?.has(key) ? (store.get(key) as T) : undefined;
  const [, bump] = useState(0);
  const set = useCallback(
    (next: T) => {
      if (store === null) return setLocal(next);
      store.set(key, next);
      bump((n) => n + 1);
    },
    [store, key],
  );
  if (store === null) return [local, set];
  return [stored ?? initial, set];
}
