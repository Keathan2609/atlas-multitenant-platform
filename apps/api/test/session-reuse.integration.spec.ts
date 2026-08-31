import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  destroyTestContext,
  registerUser,
  resetState,
  type TestContext,
} from './harness.js';

/**
 * Signing in while already holding a session.
 *
 * Regression tests for a defect found by driving the real web application in a
 * browser: a stale `atlas_session` cookie made AuthGuard resolve a session on
 * the @Public() login route, which then enforced CSRF on the POST. The caller
 * had no matching token, so login returned 403 with "reload the page and try
 * again" — advice that could not work, because the cookie survived the reload.
 *
 * The user-visible effect was that anyone returning with an old cookie could
 * not sign in at all, and nobody could sign in as a different account.
 *
 * Typechecks and the existing suite were all green; only exercising the actual
 * sign-in flow surfaced it.
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

const PASSWORD = 'correct horse battery staple';

describe('signing in with an existing session', () => {
  it('lets a signed-in user sign in again without a CSRF token', async () => {
    const { agent } = await registerUser(ctx, {
      email: 'dana@northstar.example',
      password: PASSWORD,
    });

    // The agent still carries the session cookie from registration. No CSRF
    // header is sent, exactly as a fresh page load would behave.
    const response = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'dana@northstar.example', password: PASSWORD })
      .expect(200);

    expect(response.body.user.email).toBe('dana@northstar.example');
  });

  it('lets a signed-in user sign in as a different account', async () => {
    await registerUser(ctx, { email: 'first@northstar.example', password: PASSWORD });
    const second = await registerUser(ctx, {
      email: 'second@northstar.example',
      password: PASSWORD,
    });

    // Reuse the second user's agent — it holds their cookie — and switch to
    // the first account through it.
    const response = await second.agent
      .post('/api/v1/auth/login')
      .send({ email: 'first@northstar.example', password: PASSWORD })
      .expect(200);

    expect(response.body.user.email).toBe('first@northstar.example');

    const me = await second.agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.email).toBe('first@northstar.example');
  });

  it('lets a signed-in user register a new account without a CSRF token', async () => {
    const { agent } = await registerUser(ctx, { email: 'existing@northstar.example' });

    await agent
      .post('/api/v1/auth/register')
      .send({
        email: 'brand-new@northstar.example',
        password: PASSWORD,
        displayName: 'Brand New',
      })
      .expect(201);
  });

  it('still enforces CSRF on authenticated state-changing routes', async () => {
    // The exemption must be scoped to @Public() routes only. If it leaked to
    // authenticated ones it would remove the protection entirely.
    const { agent } = await registerUser(ctx, { password: PASSWORD });

    const denied = await agent
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: 'an entirely new passphrase' })
      .expect(403);

    expect(denied.body.error.message).toMatch(/CSRF/i);
  });

  it('still enforces CSRF on tenant-scoped mutations', async () => {
    const { agent, csrfToken } = await registerUser(ctx, { password: PASSWORD });

    const org = await agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Northstar Systems', slug: 'northstar' })
      .expect(201);

    await agent
      .patch(`/api/v1/organizations/${org.body.slug}`)
      .send({ name: 'Renamed without a token' })
      .expect(403);
  });
});
