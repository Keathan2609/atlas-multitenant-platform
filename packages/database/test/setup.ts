import path from 'node:path';
import { config } from 'dotenv';

/**
 * Environment for the database package's integration tests.
 *
 * Loaded before any test module, so DATABASE_URL is redirected to the test
 * database before @prisma/client reads it. The same shape as
 * apps/api/test/setup.ts — one pattern for every database-backed suite in the
 * repository.
 *
 * The guard is not ceremony: these specs create and delete rows, and pointing
 * them at a development database would quietly mutate seeded data.
 */
config({ path: path.resolve(process.cwd(), '../../.env') });

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL must be set to run integration tests. See .env.example.');
}

if (!/atlas_test/.test(testDatabaseUrl)) {
  throw new Error(
    `TEST_DATABASE_URL does not name the test database: ${testDatabaseUrl}\n` +
      'Refusing to run — these specs write to whatever they are pointed at.',
  );
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = 'test';
