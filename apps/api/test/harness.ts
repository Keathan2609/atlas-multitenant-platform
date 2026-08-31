import { Test, type TestingModule } from '@nestjs/testing';
import { VersioningType, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
// Imported through @atlas/database rather than @prisma/client directly: the
// API package does not declare a dependency on Prisma, and reaching past the
// package boundary would break under pnpm's isolated node_modules.
import { createPrismaClient, type PrismaClient } from '@atlas/database';
import { AppModule } from '../src/app.module.js';
import { RedisService } from '../src/common/redis/redis.service.js';
import { CONFIG_TOKEN, type AppConfig } from '../src/config/env.js';

/**
 * Integration test harness.
 *
 * Boots the real application against the real Postgres and Redis from
 * docker-compose — no mocks. The point of these tests is to catch the things
 * mocks hide: a missing tenant filter, a constraint that does not fire, a
 * guard registered in the wrong order. A mocked Prisma would happily "prove"
 * isolation that the database never enforced.
 *
 * The middleware/versioning setup below mirrors main.ts. It is duplicated
 * rather than shared because a test that silently diverges from production
 * bootstrap is worse than one that visibly restates it — and if this drifts,
 * the auth tests fail loudly.
 */

export interface TestContext {
  app: INestApplication;
  prisma: PrismaClient;
  redis: RedisService;
  /** Supertest agent bound to the running app. */
  http: () => request.Agent;
}

/** Tables truncated between tests, ordered so FKs never block the delete. */
const TRUNCATE_ORDER = [
  'audit_logs',
  'work_items',
  'project_memberships',
  'projects',
  'team_memberships',
  'teams',
  'workspaces',
  'invitations',
  'api_keys',
  'organization_settings',
  'organization_memberships',
  'organizations',
  'sessions',
  'users',
];

export async function createTestContext(): Promise<TestContext> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.includes('atlas_test')) {
    // A guard, not a convenience. Without it a misconfigured run truncates the
    // developer's actual database on the first test.
    throw new Error(
      `Integration tests must run against the atlas_test database. Got: ${databaseUrl ?? '(unset)'}`,
    );
  }

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  const config = app.get<AppConfig>(CONFIG_TOKEN);
  // Must mirror main.ts: without the same secret, cookie-parser cannot verify
  // the signed session cookie and every authenticated test would 401.
  app.use(cookieParser(process.env.SESSION_SECRET));
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Read from config rather than hard-coded, for the same reason main.ts does:
  // a hard-coded 1 here would make the proxy-trust regression tests pass
  // against a setting production does not use.
  app.set('trust proxy', config.TRUST_PROXY);
  await app.init();

  const prisma = createPrismaClient({ databaseUrl });
  await prisma.$connect();

  return {
    app,
    prisma,
    redis: app.get(RedisService),
    http: () => request.agent(app.getHttpServer()),
  };
}

/**
 * Empties every table.
 *
 * TRUNCATE ... CASCADE in one statement rather than per-table deletes: it is
 * dramatically faster, and it resets the tables atomically so a failed test
 * cannot leave a half-cleaned database for the next one.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const tables = TRUNCATE_ORDER.map((t) => `"public"."${t}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

/**
 * Clears rate-limit counters between tests.
 *
 * Every test drives the API from 127.0.0.1, so without this the shared
 * per-IP budget is exhausted a few tests in and the rest fail with 429 —
 * the limiter working correctly against its own test suite.
 *
 * Deliberately clears the counters rather than disabling the limiter in the
 * test environment. Switching it off would mean the guard never runs in CI,
 * and rate limiting is a security control that deserves coverage: the
 * dedicated test in rate-limit.integration.spec.ts exercises it directly.
 *
 * SCAN, not KEYS: KEYS blocks the Redis event loop across the whole keyspace,
 * which is a habit worth not forming even in tests.
 */
export async function resetRateLimits(redis: RedisService): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.client.scan(cursor, 'MATCH', 'ratelimit:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await redis.client.del(...keys);
  } while (cursor !== '0');
}

/** Full between-test reset: database rows and rate-limit counters. */
export async function resetState(ctx: TestContext): Promise<void> {
  await resetDatabase(ctx.prisma);
  await resetRateLimits(ctx.redis);
}

export async function destroyTestContext(ctx: TestContext): Promise<void> {
  await ctx.prisma.$disconnect();
  await ctx.app.close();
}

/** Registers a user and returns an agent carrying their session + CSRF token. */
export async function registerUser(
  ctx: TestContext,
  overrides: Partial<{ email: string; password: string; displayName: string }> = {},
): Promise<{ agent: request.Agent; csrfToken: string; userId: string; email: string }> {
  const email = overrides.email ?? `user-${Math.random().toString(36).slice(2, 10)}@northstar.example`;
  const password = overrides.password ?? 'correct horse battery staple';
  const displayName = overrides.displayName ?? 'Test Person';

  const agent = ctx.http();
  const response = await agent
    .post('/api/v1/auth/register')
    .send({ email, password, displayName })
    .expect(201);

  return {
    agent,
    csrfToken: response.body.csrfToken as string,
    userId: response.body.user.id as string,
    email: response.body.user.email as string,
  };
}
