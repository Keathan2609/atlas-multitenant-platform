import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, resetState, type TestContext } from './harness.js';

/**
 * Rate limiting and client-IP trust.
 *
 * The spoofing test below is a regression test for a real defect found during
 * the pre-multi-tenancy security review: `app.set('trust proxy', 1)` was
 * hard-coded, so Express read the client address out of X-Forwarded-For even
 * when nothing was proxying. Confirmed at the time by exhausting the login
 * budget until it returned 429, then restoring a fresh budget three times with
 * three forged header values.
 *
 * That is not only a throttling problem: req.ip is also the address written to
 * sessions and audit entries, so the same header let a caller forge the
 * recorded origin of their own actions.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

afterEach(async () => {
  await resetState(ctx);
});

const attemptLogin = (email: string, headers: Record<string, string> = {}) => {
  const req = ctx.http().post('/api/v1/auth/login');
  for (const [key, value] of Object.entries(headers)) req.set(key, value);
  return req.send({ email, password: 'definitely the wrong password' });
};

describe('login rate limiting', () => {
  it('permits the configured budget then returns 429 with Retry-After', async () => {
    const email = 'budget@northstar.example';

    for (let i = 0; i < 10; i++) {
      const response = await attemptLogin(email);
      expect(response.status, `attempt ${i + 1} should still be allowed`).toBe(401);
    }

    const blocked = await attemptLogin(email);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not let one email exhaust the budget for another', async () => {
    // Bucketing on email alone would let an attacker lock a victim out of
    // their own account simply by burning the budget deliberately.
    for (let i = 0; i < 11; i++) await attemptLogin('victim@northstar.example');
    await expect(attemptLogin('victim@northstar.example')).resolves.toMatchObject({ status: 429 });

    const other = await attemptLogin('bystander@northstar.example');
    expect(other.status).toBe(401);
  });

  it('ignores a forged X-Forwarded-For when no proxy is configured', async () => {
    // The regression. With TRUST_PROXY at its default of 0, Express must use
    // the socket address and disregard the header, so a client cannot mint
    // itself a fresh rate-limit bucket per request.
    const email = 'spoofer@northstar.example';

    for (let i = 0; i < 11; i++) await attemptLogin(email);
    await expect(attemptLogin(email)).resolves.toMatchObject({ status: 429 });

    for (const forged of ['203.0.113.10', '203.0.113.11', '198.51.100.7']) {
      const response = await attemptLogin(email, { 'X-Forwarded-For': forged });
      expect(response.status, `X-Forwarded-For: ${forged} must not reset the budget`).toBe(429);
    }
  });

  it('does not record a forged X-Forwarded-For as the session address', async () => {
    // Same header, second consequence: the address stored on a session is
    // shown to users as "where this device signed in from". It must reflect
    // the real peer, not whatever the client claimed.
    const email = 'ipcheck@northstar.example';
    const password = 'correct horse battery staple';

    await ctx
      .http()
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', '203.0.113.99')
      .send({ email, password, displayName: 'IP Check' })
      .expect(201);

    const session = await ctx.prisma.session.findFirstOrThrow({
      where: { user: { email } },
      select: { ipAddress: true },
    });

    expect(session.ipAddress).not.toBe('203.0.113.99');
  });
});

describe('signed session cookie', () => {
  it('rejects a tampered session cookie without touching the datastore', async () => {
    // The signature is verified by cookie-parser, so a fabricated cookie never
    // reaches the session lookup at all.
    const response = await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('Cookie', 'atlas_session=s%3Afabricated.invalidsignaturevalue')
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unsigned value in the session cookie', async () => {
    await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('Cookie', 'atlas_session=plaintexttokenwithoutasignature')
      .expect(401);
  });
});
