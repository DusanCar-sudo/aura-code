// vitest config — runs TS tests in tests/ via the same tsconfig
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Live benchmarks: they drive a real Ollama model and the real DeepSeek
    // verifier through 30 full agent runs (~2 min each), so they turn `npm
    // test` from a 25-second unit suite into an hour-long one on any machine
    // that happens to have both credentials. They self-skip only when a
    // credential is *missing*, which is the wrong trigger — opt in instead.
    //   AURA_LIVE_BENCH=1 npx vitest run tests/archimedes
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(process.env.AURA_LIVE_BENCH ? [] : [
        'tests/archimedes/escalation-fullpath.test.ts',
        'tests/archimedes/escalation-correctness.test.ts',
      ]),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli/index.ts', 'src/server/index.ts', 'src/types/**'],
    },
    testTimeout: 10_000,
  },
});
