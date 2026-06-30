// vitest config — runs TS tests in tests/ via the same tsconfig
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli/index.ts', 'src/server/index.ts', 'src/types/**'],
    },
    testTimeout: 10_000,
  },
});
