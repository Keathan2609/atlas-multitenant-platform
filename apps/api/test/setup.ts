import { config } from 'dotenv';
import path from 'node:path';

/**
 * Integration-test environment.
 *
 * Loaded before any test module. DATABASE_URL is forced to TEST_DATABASE_URL
 * so the suite can TRUNCATE freely without touching development data — the
 * harness additionally refuses to run if the resulting URL does not name the
 * test database.
 */
config({ path: path.resolve(process.cwd(), '../../.env') });

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL must be set to run integration tests. See .env.example.');
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = 'test';
// Keep test output readable; the application logger is otherwise very chatty.
process.env.LOG_LEVEL = 'error';
process.env.LOG_FORMAT = 'json';
// Console transport: invitation emails are captured in memory so specs can
// read the token, with no SMTP socket and no dependency on Mailpit running.
process.env.EMAIL_TRANSPORT = 'console';
