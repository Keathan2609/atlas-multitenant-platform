import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  destroyTestContext,
  lastInvitationToken,
  registerUser,
  resetState,
  type TestContext,
} from './harness.js';

/**
 * One property, asserted across every credential ATLAS issues.
 *
 * Sessions, API keys and invitation tokens are produced by three different
 * services written at three different times. Each has its own tests; this file
 * exists so the *shared* rule is stated once and cannot quietly stop holding
 * for one of them:
 *
 *   the raw credential exists in exactly one response, and nowhere in the
 *   database, the audit log, or any subsequent read.
 *
 * Added at the Phase 7 security checkpoint after the credential surface had
 * grown from one type to three.
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

/** Every row of every table, as one string. Crude and exactly the point. */
async function dumpDatabase(): Promise<string> {
  const [users, sessions, apiKeys, invitations, auditLogs, memberships] = await Promise.all([
    ctx.prisma.user.findMany(),
    ctx.prisma.session.findMany(),
    ctx.prisma.apiKey.findMany(),
    ctx.prisma.invitation.findMany(),
    ctx.prisma.auditLog.findMany(),
    ctx.prisma.organizationMembership.findMany(),
  ]);
  return JSON.stringify({ users, sessions, apiKeys, invitations, auditLogs, memberships });
}

describe('credential hygiene', () => {
  it('never persists a session token, an API key, or an invitation token', async () => {
    // Register — issues a session token in a cookie.
    const owner = await registerUser(ctx, { email: 'owner@northstar.example' });
    const org = await owner.agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', owner.csrfToken)
      .send({ name: 'Northstar Systems', slug: 'northstar' })
      .expect(201);
    const slug = org.body.slug as string;

    // The raw session token lives only in the cookie jar.
    const sessionCookie = await ctx
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'owner@northstar.example', password: 'correct horse battery staple' })
      .expect(200)
      .then((r) => {
        const cookies = r.headers['set-cookie'] as unknown as string[];
        const raw = cookies.find((c) => c.startsWith('atlas_session=')) ?? '';
        return decodeURIComponent(raw.split(';')[0]?.split('=')[1] ?? '');
      });

    // An API key — raw value returned exactly once.
    const apiKey = await owner.agent
      .post(`/api/v1/organizations/${slug}/api-keys`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ name: 'CI deploy' })
      .expect(201)
      .then((r) => r.body.key as string);

    // An invitation — raw token only in the email.
    await owner.agent
      .post(`/api/v1/organizations/${slug}/invitations`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ email: 'newcomer@northstar.example', role: 'MEMBER' })
      .expect(201);
    const invitationToken = lastInvitationToken(ctx);

    expect(sessionCookie.length).toBeGreaterThan(20);
    expect(apiKey).toMatch(/^atlas_live_/);
    expect(invitationToken.length).toBeGreaterThan(20);

    const dump = await dumpDatabase();

    // The signed cookie wraps the token as `s:<token>.<signature>`, so strip
    // the wrapper before searching — otherwise the test could pass simply
    // because the stored form differs by a prefix.
    const bareSessionToken = sessionCookie.replace(/^s:/, '').split('.')[0] ?? sessionCookie;

    for (const [label, secret] of [
      ['session token', bareSessionToken],
      ['api key', apiKey],
      ['invitation token', invitationToken],
    ] as const) {
      expect(dump.includes(secret), `${label} was found in the database`).toBe(false);
    }
  });

  it('keeps every credential out of the audit log', async () => {
    const owner = await registerUser(ctx, { email: 'owner@northstar.example' });
    const org = await owner.agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', owner.csrfToken)
      .send({ name: 'Northstar Systems', slug: 'northstar' })
      .expect(201);
    const slug = org.body.slug as string;

    const apiKey = await owner.agent
      .post(`/api/v1/organizations/${slug}/api-keys`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ name: 'CI deploy' })
      .expect(201)
      .then((r) => r.body.key as string);

    await owner.agent
      .post(`/api/v1/organizations/${slug}/invitations`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ email: 'newcomer@northstar.example', role: 'MEMBER' })
      .expect(201);
    const invitationToken = lastInvitationToken(ctx);

    // Read it back through the API too — the audit log is admin-readable, so
    // the response matters as much as the row.
    const viaApi = await owner.agent
      .get(`/api/v1/organizations/${slug}/audit-logs`)
      .expect(200);

    const serialised = JSON.stringify(viaApi.body);
    expect(serialised).not.toContain(apiKey);
    expect(serialised).not.toContain(invitationToken);
    // Nor should the hashes be exposed to a reader of the log.
    expect(serialised).not.toMatch(/keyHash|tokenHash|passwordHash/);
  });

  it('stores each credential as a SHA-256 digest, not a reversible form', async () => {
    const owner = await registerUser(ctx, { email: 'owner@northstar.example' });
    const org = await owner.agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', owner.csrfToken)
      .send({ name: 'Northstar Systems', slug: 'northstar' })
      .expect(201);

    await owner.agent
      .post(`/api/v1/organizations/${org.body.slug}/api-keys`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ name: 'CI deploy' })
      .expect(201);

    await owner.agent
      .post(`/api/v1/organizations/${org.body.slug}/invitations`)
      .set('x-csrf-token', owner.csrfToken)
      .send({ email: 'newcomer@northstar.example', role: 'MEMBER' })
      .expect(201);

    const [session, key, invitation, user] = await Promise.all([
      ctx.prisma.session.findFirstOrThrow(),
      ctx.prisma.apiKey.findFirstOrThrow(),
      ctx.prisma.invitation.findFirstOrThrow(),
      ctx.prisma.user.findFirstOrThrow(),
    ]);

    expect(session.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(key.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(invitation.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    // The password is the one credential that is deliberately *not* a plain
    // digest — it is low-entropy, so it needs a slow, salted KDF.
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });
});
