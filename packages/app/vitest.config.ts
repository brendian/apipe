import { defineConfig } from 'vitest/config';

// `test/` runs under Node (main process code); renderer tests sit beside their components and
// ask for jsdom with a `// @vitest-environment jsdom` line.
export default defineConfig({
  test: { name: 'app', include: ['test/**/*.test.ts', 'src/renderer/**/*.test.{ts,tsx}'] },
});
