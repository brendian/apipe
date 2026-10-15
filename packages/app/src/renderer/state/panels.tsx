import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// Which `<details>` panels a person opened or closed, by a stable key, so a live refresh (or a
// switch of tab) never snaps them back (docs/04 §6, §7). Never run data: only open/closed.

type Store = {
  get: (key: string) => boolean | undefined;
  set: (key: string, open: boolean) => void;
};

const PanelContext = createContext<Store | null>(null);

export function PanelStateProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<Readonly<Record<string, boolean>>>({});
  const set = useCallback(
    (key: string, open: boolean) => setOpened((o) => ({ ...o, [key]: open })),
    [],
  );
  const store = useMemo<Store>(() => ({ get: (key) => opened[key], set }), [opened, set]);
  return <PanelContext.Provider value={store}>{children}</PanelContext.Provider>;
}

/** [open, setOpen] for the panel `key`; `fallback` is used until the person chooses. */
export function usePanel(key: string, fallback: boolean): [boolean, (open: boolean) => void] {
  const store = useContext(PanelContext);
  const [local, setLocal] = useState<boolean | undefined>(undefined);
  if (store === null) return [local ?? fallback, setLocal];
  return [store.get(key) ?? fallback, (open) => store.set(key, open)];
}
