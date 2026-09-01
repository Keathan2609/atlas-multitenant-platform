import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Database-backed tests for @atlas/database.
 *
 * Mirrors apps/api/vitest.integration.config.ts: real Postgres, no mocks, run
 * serially in a single fork because the specs share one database.
 *
 * The environment is prepared in test/setup.ts rather than here, so that
 * DATABASE_URL is redirected to the *test* database before any module reads
 * it — the same guarantee the API's suite relies on.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    setupFiles: [path.resolve(__dirname, 'test/setup.ts')],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
