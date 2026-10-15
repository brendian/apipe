import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'engine', include: ['test/**/*.test.ts'], globalSetup: ['test/global-setup.ts'] },
});
