import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // PGlite suites migrate a fresh in-process Postgres; under load a cold
    // start can exceed the 5 s default (observed once in GB-5 QA). With many
    // suites running in parallel the same contention hits beforeAll/beforeEach
    // (observed at GB-8 QA), so the hook timeout gets the same headroom.
    testTimeout: 15_000,
    hookTimeout: 20_000,
    // The binding constraint is PGlite cold starts, not CPU: every DB suite
    // boots its own WASM Postgres. Unbounded parallelism made them contend
    // past the 20 s hook timeout (5/16 files failed at 16 suites). Capping
    // workers is the fix — a third timeout bump would only defer the same
    // failure to the next suite added. Measured on this tree: uncapped 45 s
    // with 5 failures, fully serial 44 s green, capped at 4 -> 26 s green.
    maxWorkers: 4,
  },
});
