/// <reference types="vite/client" />

import type { AdvpipeApi } from '@advpipe/contracts';

declare global {
  interface Window {
    advpipe: AdvpipeApi;
  }
}
