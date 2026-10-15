import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const noShellOption = {
  selector: "Property[key.name='shell'][value.value=true]",
  message: 'Never run a command through a shell (docs/08 §3.7): use argument arrays.',
};

// A per-package `no-restricted-imports` replaces the global one, so each override repeats this.
const execPaths = ['child_process', 'node:child_process'].map((name) => ({
  name,
  importNames: ['exec', 'execSync'],
  message: 'Use execFile/spawn with argument arrays.',
}));

/** Restrict what a package may import (docs/04 §1). */
const only = (message, ...names) => ({
  'no-restricted-imports': [
    'error',
    {
      paths: execPaths,
      patterns: names.map((group) => ({ group: [group], message })),
    },
  ],
});

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/out/**',
      'node_modules/**',
      'fixtures/**',
      'docs/**',
      'assets/**',
      '.claude/**',
      'packages/engine/prompts/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': ['error', noShellOption],
      // `any` needs a justification: write `// eslint-disable-next-line ... -- <why>`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: execPaths,
        },
      ],
    },
  },
  // contracts: zod only.
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: execPaths,
          patterns: [
            {
              regex: '^(?!zod$|\\.{1,2}/).*',
              message: 'contracts may import only zod and its own files (docs/04 §1).',
            },
          ],
        },
      ],
    },
  },
  // engine: never Electron, the DOM, React or the app.
  {
    files: ['packages/engine/src/**/*.ts'],
    rules: only(
      'The engine must not import electron, react or anything from the app (docs/04 §1).',
      'electron',
      'electron/*',
      'react',
      'react/*',
      'react-dom',
      'react-dom/*',
      '@advpipe/app',
      '@advpipe/app/*',
    ),
  },
  // renderer: contracts + UI libs only. No engine, no electron, no Node built-ins.
  {
    files: ['packages/app/src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...Object.fromEntries(Object.keys(globals.node).map((k) => [k, 'off'])),
      },
    },
    rules: only(
      'The renderer imports only @advpipe/contracts and UI libraries (docs/04 §1).',
      '@advpipe/engine',
      '@advpipe/engine/*',
      'electron',
      'electron/*',
      'node:*',
      'fs',
      'fs/*',
      'path',
      'child_process',
      'os',
      'crypto',
    ),
  },
  // preload: contracts + electron only.
  {
    files: ['packages/app/src/preload/**/*.ts'],
    rules: only(
      'preload must not import the engine (docs/04 §1).',
      '@advpipe/engine',
      '@advpipe/engine/*',
      'react',
      'react-dom',
    ),
  },
  // main: engine, contracts, electron; no React or DOM.
  {
    files: ['packages/app/src/main/**/*.ts'],
    rules: only(
      'main must not import React (docs/04 §1).',
      'react',
      'react/*',
      'react-dom',
      'react-dom/*',
    ),
  },
  // Plain scripts / config files may run in Node's globals.
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}', 'packages/*/*.config.ts', 'e2e/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', noShellOption] },
  },
);
