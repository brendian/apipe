import { defineConfig } from '@playwright/test';

// `npm run test:packaged`: smoke tests of the packaged app (release/), never of the dev build.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.smoke.ts',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
});
