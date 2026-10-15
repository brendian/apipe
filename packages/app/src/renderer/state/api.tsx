import { createContext, useContext, type ReactNode } from 'react';
import type { AdvpipeApi } from '@advpipe/contracts';

// The window reaches main only through `window.advpipe` (the typed bridge). Components get it from
// context so tests can hand them a stub.

const ApiContext = createContext<AdvpipeApi | null>(null);

export function ApiProvider({ api, children }: { api: AdvpipeApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): AdvpipeApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('ApiProvider is missing');
  return api;
}
