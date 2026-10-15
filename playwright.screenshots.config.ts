import { defineConfig } from '@playwright/test';

// `npm run screenshots`: the one file that writes docs/screenshots/*.png.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.shots.ts',
  timeout: 240_000,
  workers: 1,
  reporter: [['list']],
});
