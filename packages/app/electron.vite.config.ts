import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// The CSP <meta> in index.html is strict (no unsafe-*). Vite's dev server injects an inline
// React-refresh script that it would block, so the meta is dropped for `serve` only. Production
// builds keep it, and main also sends the same policy as a response header (docs/08 §2).
const devWithoutCspMeta = (): Plugin => ({
  name: 'advpipe:dev-no-csp-meta',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
});

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    // A sandboxed preload cannot `require` anything but `electron`: bundle all, emit CommonJS.
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react(), devWithoutCspMeta()],
    build: {
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    },
  },
});
