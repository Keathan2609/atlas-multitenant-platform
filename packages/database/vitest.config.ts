import { defineConfig } from 'vitest/config';

/**
 * Unit tests for @atlas/database — no I/O, no database, no environment.
 *
 * `*.integration.spec.ts` is excluded deliberately. This config previously
 * included every spec and loaded the root .env, because the package's only
 * spec was database-backed; that made `pnpm test` require a running Postgres,
 * which passed locally and failed in CI's service-free unit job. The
 * database-backed specs now run from vitest.integration.config.ts.
 *
 * passWithNoTests, because the package currently has no spec that needs no
 * database. That is a real state, not a suppressed failure: the nine
 * tenant-scope tests still run on every CI run, in the integration job, and
 * `pnpm test:integration` fails loudly if they do not.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.integration.spec.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
