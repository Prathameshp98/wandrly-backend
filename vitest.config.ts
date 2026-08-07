import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globals: false,
    globalSetup: ['test/support/global-teardown.ts'],
    testTimeout: 30_000,
    // Loaded before any application module: platform/config/env parses at
    // import time and exits the process on invalid config.
    setupFiles: ['test/support/env.ts'],
    // API tests share ONE Postgres database and truncate in `beforeEach`, so
    // any concurrency lets one file wipe another file's data mid-test. That
    // showed up as a ~1-in-5 flake in an unrelated assertion.
    //
    // fileParallelism alone is not sufficient — the pool still spawns multiple
    // workers — so the fork pool is pinned to a single process as well.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    maxWorkers: 1,
    minWorkers: 1,
    // Each file gets its own module registry — and therefore its own pg Pool,
    // rate-limit counters, and user-sync cache. Combined with sequential files
    // and no cross-test truncation, nothing is shared between files at all.
    //
    // This is safe now only because the suite no longer truncates between
    // tests: an earlier attempt at isolation leaked pools whose idle
    // connections blocked the next file's TRUNCATE.
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // The money and policy layers are the only ones with a hard coverage gate.
      // TECHNICAL_DESIGN §13.
      include: ['src/money/**', 'src/platform/policy/**', 'src/modules/ledger/split.resolver.ts'],
      exclude: ['**/*.test.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
