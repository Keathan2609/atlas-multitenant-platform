import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests: real Postgres, real Redis, real HTTP stack.
 *
 * Run serially (singleFork). The suite truncates tables between tests, so
 * parallel workers sharing one database would delete each other's fixtures.
 * Isolation could come from a schema per worker instead; serial execution is
 * chosen for now because the suite is fast and the complexity is not yet
 * earning its keep. See docs/testing.md.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.spec.ts'],
    environment: 'node',
    globals: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 60000,
    setupFiles: ['test/setup.ts'],
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
