import { createContext, useContext, type ReactNode } from 'react';
import type { FilterKey, WindowInfo } from '@advpipe/contracts';

/** What the window learned about itself at boot: its repo, and the saved filter for that repo. */
export type WindowState = { repo: WindowInfo['repo']; initialFilter: FilterKey };

const WindowContext = createContext<WindowState | null>(null);

export function WindowProvider({ value, children }: { value: WindowState; children: ReactNode }) {
  return <WindowContext.Provider value={value}>{children}</WindowContext.Provider>;
}

export function useWindow(): WindowState {
  const w = useContext(WindowContext);
  if (!w) throw new Error('WindowProvider is missing');
  return w;
}
