import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'app', include: ['test/**/*.test.ts'] } });
