import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Applies migrations to the integration-test database.
 *
 * This replaces `dotenv -e ../../.env -v DATABASE_URL=$TEST_DATABASE_URL -- …`,
 * which never worked: `$TEST_DATABASE_URL` is a *shell* expansion, and
 * dotenv-cli's `-v` takes a literal value, so Prisma received the eight
 * characters `$TEST_DATABASE_URL` and rejected them for not starting with
 * `postgresql://`. It went unnoticed because the test database already had a
 * schema from an earlier run; it only surfaced against fresh volumes.
 *
 * Doing it in Node also removes the dependency on a POSIX shell, which the
 * original silently had.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');

loadDotenv({ path: path.resolve(packageRoot, '../../.env') });

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  console.error('TEST_DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

// Guard against pointing this at development or production data: the
// integration suite truncates every table between tests.
if (!/atlas_test/.test(testDatabaseUrl)) {
  console.error(
    `TEST_DATABASE_URL does not name the test database: ${testDatabaseUrl}\n` +
      'Refusing to migrate — the integration suite truncates what it points at.',
  );
  process.exit(1);
}

const result = spawnSync('prisma', ['migrate', 'deploy'], {
  cwd: packageRoot,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
});

process.exit(result.status ?? 1);
