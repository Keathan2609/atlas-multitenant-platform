import { config } from 'dotenv';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// These specs need a real database. TEST_DATABASE_URL points at atlas_test so
// they never touch development data.
config({ path: path.resolve(process.cwd(), '../../.env') });

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
