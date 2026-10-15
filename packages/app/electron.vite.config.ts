import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

// The role prompts are read at run time from a `prompts/` folder beside the bundle (docs/04 §1,
// docs/10 §4): copied from the source of truth, so a packaged app carries them too.
const copyPrompts = (): Plugin => ({
  name: 'advpipe:copy-prompts',
  apply: 'build',
  writeBundle(options) {
    const from = resolve(import.meta.dirname, '../../assets/prompts');
    const to = join(options.dir ?? resolve(import.meta.dirname, 'out/main'), 'prompts');
    mkdirSync(to, { recursive: true });
    for (const f of readdirSync(from).filter((n) => n.endsWith('.md'))) {
      copyFileSync(join(from, f), join(to, f));
    }
  },
});

export default defineConfig({
  main: {
    plugins: [copyPrompts()],
    build: {
      // Our own packages are bundled into main and the worker. What stays external (the package's
      // `dependencies`) is the Agent SDK, its peers and zod: they ship in node_modules, unpacked.
      externalizeDeps: { exclude: ['@advpipe/contracts', '@advpipe/engine'] },
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // The detached worker a run is driven by (docs/04 §3.1): started as `<app> worker.js --start …`.
          worker: resolve(import.meta.dirname, '../engine/dist/src/worker.js'),
        },
      },
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
