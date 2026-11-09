import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/browser/**', 'node_modules/**', 'dist/**', 'demo/**'],
    testTimeout: 30_000,
  },
});
