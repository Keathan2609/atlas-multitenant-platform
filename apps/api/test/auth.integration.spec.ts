import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  destroyTestContext,
  registerUser,
  resetState,
  type TestContext,
} from './harness.js';

/**
 * Authentication integration tests.
 *
 * These run against the real application, real Postgres and real Redis. Each
 * test asserts a security property rather than a happy path — the happy path
 * is only interesting here because the failures around it must behave.
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

describe('POST /auth/register', () => {
  it('creates an account and issues a session', async () => {
    const response = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({
        email: 'dana@northstar.example',
        password: 'correct horse battery staple',
        displayName: 'Dana Whitfield',
      })
      .expect(201);

    expect(response.body.user.email).toBe('dana@northstar.example');
    expect(response.body.csrfToken).toHaveLength(43);

    const cookies = response.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('atlas_session='));
    const csrf = cookies.find((c) => c.startsWith('atlas_csrf='));

    // The session cookie must be unreadable to script — that is what stops an
    // XSS foothold from exfiltrating the session itself.
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    // The CSRF cookie must be readable; the double-submit pattern depends on
    // client code echoing it into a header.
    expect(csrf).not.toMatch(/HttpOnly/i);
  });

  it('never stores the password in plaintext', async () => {
    const { userId } = await registerUser(ctx, { password: 'correct horse battery staple' });
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    expect(user.passwordHash).not.toContain('correct horse battery staple');
    // Argon2id, not bcrypt or a bare digest.
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('normalises the email so one address cannot become two accounts', async () => {
    await registerUser(ctx, { email: 'Dana.Whitfield@Northstar.Example' });

    const duplicate = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({
        email: 'dana.whitfield@northstar.example',
        password: 'a completely different passphrase',
        displayName: 'Impostor',
      })
      .expect(409);

    expect(duplicate.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('rejects a weak password with field-level detail', async () => {
    const response = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({ email: 'x@northstar.example', password: 'short', displayName: 'X' })
      .expect(422);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'password' }),
    );
  });

  it('rejects unknown body fields rather than silently dropping them', async () => {
    // Mass-assignment defence: .strict() on the schema means a smuggled field
    // is a 422, not a silently ignored key that some later Object.assign picks up.
    const response = await ctx
      .http()
      .post('/api/v1/auth/register')
      .send({
        email: 'x@northstar.example',
        password: 'correct horse battery staple',
        displayName: 'X',
        emailVerifiedAt: '2020-01-01T00:00:00Z',
      })
      .expect(422);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /auth/login', () => {
  it('returns the same error for an unknown account and a wrong password', async () => {
    await registerUser(ctx, { email: 'dana@northstar.example' });

    const unknown = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@northstar.example', password: 'whatever it may be' })
      .expect(401);

    const wrongPassword = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'dana@northstar.example', password: 'not the right password' })
      .expect(401);

    // Identical code and message: the response must not reveal which of the
    // two failed, or it becomes an account-enumeration oracle.
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.error.code).toBe(unknown.body.error.code);
    expect(wrongPassword.body.error.message).toBe(unknown.body.error.message);
  });

  it('takes comparable time for an unknown account and a real one', async () => {
    // The message being identical is not enough — without the dummy Argon2
    // verification, "no such user" returns in microseconds while a real
    // account costs tens of milliseconds, which leaks existence just as
    // reliably. Bounds are loose because CI timing is noisy; the failure this
    // catches is an order-of-magnitude gap, not a few milliseconds.
    await registerUser(ctx, { email: 'dana@northstar.example' });

    const time = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await ctx
        .http()
        .post('/api/v1/auth/login')
        .send({ email, password: 'definitely the wrong password' });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const unknown = await time('nobody@northstar.example');
    const known = await time('dana@northstar.example');
    const ratio = Math.max(unknown, known) / Math.max(1, Math.min(unknown, known));

    expect(ratio).toBeLessThan(4);
  });
});

describe('session lifecycle', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await ctx.http().get('/api/v1/auth/me').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('revokes the session on logout', async () => {
    const { agent, csrfToken } = await registerUser(ctx);

    await agent.get('/api/v1/auth/me').expect(200);
    await agent.post('/api/v1/auth/logout').set('x-csrf-token', csrfToken).expect(204);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('revokes every other session when the password changes', async () => {
    // The security point of a password change: an attacker holding a stolen
    // session cookie must lose access, not keep it.
    const email = 'dana@northstar.example';
    const password = 'correct horse battery staple';
    const { agent: deviceA } = await registerUser(ctx, { email, password });

    const deviceB = ctx.http();
    const loginB = await deviceB
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);

    await deviceA.get('/api/v1/auth/me').expect(200);
    await deviceB.get('/api/v1/auth/me').expect(200);

    const changed = await deviceB
      .post('/api/v1/auth/change-password')
      .set('x-csrf-token', loginB.body.csrfToken)
      .send({ currentPassword: password, newPassword: 'an entirely new strong passphrase' })
      .expect(200);

    expect(changed.body.revokedSessions).toBe(1);
    await deviceA.get('/api/v1/auth/me').expect(401);
    await deviceB.get('/api/v1/auth/me').expect(200);
  });

  it('stores only a hash of the session token', async () => {
    const { userId } = await registerUser(ctx);
    const session = await ctx.prisma.session.findFirstOrThrow({ where: { userId } });

    // 64 hex characters — a SHA-256 digest, never a usable token. A database
    // dump must not yield session cookies.
    expect(session.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('CSRF protection', () => {
  it('rejects a state-changing request with no CSRF header', async () => {
    const { agent } = await registerUser(ctx);

    const response = await agent
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'correct horse battery staple', newPassword: 'another good passphrase' })
      .expect(403);

    expect(response.body.error.message).toMatch(/CSRF/i);
  });

  it('rejects a mismatched CSRF token', async () => {
    const { agent } = await registerUser(ctx);

    await agent
      .post('/api/v1/auth/change-password')
      .set('x-csrf-token', 'not-the-right-token')
      .send({ currentPassword: 'correct horse battery staple', newPassword: 'another good passphrase' })
      .expect(403);
  });

  it('does not require a CSRF token for safe methods', async () => {
    // Blocking GET would break ordinary navigation, and GET is required to be
    // side-effect free anyway.
    const { agent } = await registerUser(ctx);
    await agent.get('/api/v1/auth/me').expect(200);
  });
});

describe('error envelope', () => {
  it('returns a request id on every error and echoes it in the header', async () => {
    const response = await ctx.http().get('/api/v1/auth/me').expect(401);

    expect(response.body.error.requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
  });

  it('never leaks internals on an unmatched route', async () => {
    const response = await ctx.http().get('/api/v1/definitely-not-a-route').expect(404);

    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toMatch(/stack|prisma|node_modules|at Object/i);
  });
});
