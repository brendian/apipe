import { defineConfig } from 'vitest/config';

// One project per package. (Vitest 5 replaced vitest.workspace.ts with `projects`.)
export default defineConfig({
  test: {
    projects: ['packages/contracts', 'packages/engine', 'packages/app'],
  },
});
