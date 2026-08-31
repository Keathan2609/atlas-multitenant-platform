import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { newId } from '@atlas/database';
import type { OrganizationRole } from '@atlas/types';
import {
  createTestContext,
  destroyTestContext,
  lastInvitationToken,
  registerUser,
  resetState,
  type TestContext,
} from './harness.js';

/**
 * API keys, invitations, audit log and settings.
 *
 * The invariants under test are the credential ones: nothing secret is stored
 * or returned twice, revocation and expiry take effect immediately, a token
 * cannot be redeemed twice, and every one of these features respects the same
 * tenant boundary as the rest of the system.
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

interface Org {
  slug: string;
  orgId: string;
  agent: request.Agent;
  csrf: string;
  userId: string;
}

async function createOrg(prefix = 'northstar', name = 'Northstar Systems'): Promise<Org> {
  const user = await registerUser(ctx, { email: `${prefix}-owner@northstar.example` });
  const response = await user.agent
    .post('/api/v1/organizations')
    .set('x-csrf-token', user.csrfToken)
    .send({ name, slug: prefix })
    .expect(201);

  return {
    slug: response.body.slug,
    orgId: response.body.id,
    agent: user.agent,
    csrf: user.csrfToken,
    userId: user.userId,
  };
}

async function addMember(org: Org, role: OrganizationRole, prefix: string) {
  const user = await registerUser(ctx, { email: `${prefix}@northstar.example` });
  await ctx.prisma.organizationMembership.create({
    data: { id: newId(), organizationId: org.orgId, userId: user.userId, role },
  });
  return user;
}

async function createKey(org: Org, name = 'CI deploy', expiresInDays?: number) {
  const response = await org.agent
    .post(`/api/v1/organizations/${org.slug}/api-keys`)
    .set('x-csrf-token', org.csrf)
    .send({ name, ...(expiresInDays !== undefined ? { expiresInDays } : {}) })
    .expect(201);
  return response.body as { id: string; key: string; keyPrefix: string };
}

describe('API keys', () => {
  it('returns the secret exactly once and never stores it', async () => {
    const org = await createOrg();
    const created = await createKey(org);

    expect(created.key).toMatch(/^atlas_live_[A-Za-z0-9_-]{40,}$/);

    // The stored row holds a SHA-256 digest and a display prefix — never the key.
    const stored = await ctx.prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.keyHash).not.toContain(created.key);
    expect(created.key.startsWith(stored.keyPrefix)).toBe(true);

    // And no later read returns it.
    const listed = await org.agent
      .get(`/api/v1/organizations/${org.slug}/api-keys`)
      .expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(created.key);
    expect(listed.body.data[0].keyPrefix).toBe(stored.keyPrefix);
  });

  it('keeps the raw key out of the audit trail', async () => {
    const org = await createOrg();
    const created = await createKey(org);

    const entry = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { organizationId: org.orgId, action: 'apikey.created' },
    });
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain(created.key);
    expect(serialised).not.toContain('keyHash');
  });

  it('authenticates a request and is scoped to its own organization', async () => {
    const org = await createOrg('northstar');
    const other = await createOrg('meridian', 'Meridian Labs');
    const key = await createKey(org);

    // Works against the organization it was issued for.
    await ctx
      .http()
      .get(`/api/v1/organizations/${org.slug}/projects`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    // And cannot be pointed at another tenant, even a real one.
    await ctx
      .http()
      .get(`/api/v1/organizations/${other.slug}/projects`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(404);
  });

  it('grants only read access, whoever created it', async () => {
    // A leaked key must not be able to add members, mint further keys, or
    // delete the organization — so keys act as VIEWER even when an OWNER
    // created them.
    const org = await createOrg();
    const key = await createKey(org);

    await ctx
      .http()
      .get(`/api/v1/organizations/${org.slug}/projects`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    const denied = await ctx
      .http()
      .post(`/api/v1/organizations/${org.slug}/api-keys`)
      .set('Authorization', `Bearer ${key.key}`)
      .send({ name: 'Escalation' })
      .expect(403);
    expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');

    await ctx
      .http()
      .delete(`/api/v1/organizations/${org.slug}`)
      .set('Authorization', `Bearer ${key.key}`)
      .send({ confirmSlug: org.slug })
      .expect(403);
  });

  it('stops working the moment it is revoked', async () => {
    const org = await createOrg();
    const key = await createKey(org);

    await ctx
      .http()
      .get(`/api/v1/organizations/${org.slug}/projects`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    await org.agent
      .delete(`/api/v1/organizations/${org.slug}/api-keys/${key.id}`)
      .set('x-csrf-token', org.csrf)
      .expect(200);

    const rejected = await ctx
      .http()
      .get(`/api/v1/organizations/${org.slug}/projects`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(401);
    expect(rejected.body.error.code).toBe('INVALID_API_KEY');
  });

  it('rejects an expired key', async () => {
    const org = await createOrg();
    const key = await createKey(org, 'Short lived', 1);

    // Move the expiry into the past rather than waiting a day.
    await ctx.prisma.apiKey.update({
      where: { id: key.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await ctx
      .http()
      .get(`/api/v1/organizations/${org.slug}/projects`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(401);
  });

  it('gives the same response for unknown, revoked and expired keys', async () => {
    // Distinguishing them would confirm to an attacker that a key was real.
    const org = await createOrg();
    const revoked = await createKey(org, 'Revoked');
    const expired = await createKey(org, 'Expired');

    await org.agent
      .delete(`/api/v1/organizations/${org.slug}/api-keys/${revoked.id}`)
      .set('x-csrf-token', org.csrf)
      .expect(200);
    await ctx.prisma.apiKey.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const responses = await Promise.all(
      [revoked.key, expired.key, 'atlas_live_completelyMadeUpValueThatIsLongEnough'].map((k) =>
        ctx
          .http()
          .get(`/api/v1/organizations/${org.slug}/projects`)
          .set('Authorization', `Bearer ${k}`),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_API_KEY');
      expect(response.body.error.message).toBe(responses[0]?.body.error.message);
    }
  });

  it('records last-used on authentication', async () => {
    const org = await createOrg();
    const key = await createKey(org);

    expect(
      (await ctx.prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsedAt,
    ).toBeNull();

    await ctx
      .http()
      .get(`/api/v1/organizations/${org.slug}/projects`)
      .set('Authorization', `Bearer ${key.key}`)
      .expect(200);

    // The touch is fire-and-forget, so allow it a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      (await ctx.prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsedAt,
    ).not.toBeNull();
  });

  it('rejects a malformed Authorization header rather than falling back to cookies', async () => {
    // Falling through would let a caller probe keys while quietly
    // authenticating as someone else.
    const org = await createOrg();

    await org.agent
      .get(`/api/v1/organizations/${org.slug}/projects`)
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401);
  });

  it('keeps API keys invisible to MEMBER and VIEWER', async () => {
    const org = await createOrg();
    await createKey(org);
    const member = await addMember(org, 'MEMBER', 'member');
    const viewer = await addMember(org, 'VIEWER', 'viewer');

    await member.agent.get(`/api/v1/organizations/${org.slug}/api-keys`).expect(403);
    await viewer.agent.get(`/api/v1/organizations/${org.slug}/api-keys`).expect(403);
  });

  it("refuses to revoke another tenant's key", async () => {
    const a = await createOrg('northstar');
    const b = await createOrg('meridian', 'Meridian Labs');
    const key = await createKey(b, 'Meridian key');

    await a.agent
      .delete(`/api/v1/organizations/${a.slug}/api-keys/${key.id}`)
      .set('x-csrf-token', a.csrf)
      .expect(404);

    expect(
      (await ctx.prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt,
    ).toBeNull();
  });
});

describe('invitations', () => {
  async function invite(org: Org, email: string, role: OrganizationRole = 'MEMBER') {
    const response = await org.agent
      .post(`/api/v1/organizations/${org.slug}/invitations`)
      .set('x-csrf-token', org.csrf)
      .send({ email, role })
      .expect(201);
    return response.body as { id: string; email: string };
  }

  it('stores only a hash of the token', async () => {
    const org = await createOrg();
    const created = await invite(org, 'newcomer@northstar.example');

    const stored = await ctx.prisma.invitation.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    const token = lastInvitationToken(ctx);
    expect(stored.tokenHash).not.toContain(token);
  });

  it('keeps the token out of the API response and the audit trail', async () => {
    const org = await createOrg();
    const created = await invite(org, 'newcomer@northstar.example');
    const token = lastInvitationToken(ctx);

    const listed = await org.agent
      .get(`/api/v1/organizations/${org.slug}/invitations`)
      .expect(200);
    expect(JSON.stringify(listed.body)).not.toContain(token);

    const entry = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { organizationId: org.orgId, action: 'member.invited', resourceId: created.id },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain(token);
  });

  it('lets the invited person join, once', async () => {
    const org = await createOrg();
    await invite(org, 'newcomer@northstar.example', 'MEMBER');
    const token = lastInvitationToken(ctx);

    const newcomer = await registerUser(ctx, { email: 'newcomer@northstar.example' });

    const accepted = await newcomer.agent
      .post('/api/v1/invitations/accept')
      .set('x-csrf-token', newcomer.csrfToken)
      .send({ token })
      .expect(200);
    expect(accepted.body.role).toBe('MEMBER');

    await newcomer.agent.get(`/api/v1/organizations/${org.slug}`).expect(200);

    // The token is consumed — a replay must fail.
    const replay = await newcomer.agent
      .post('/api/v1/invitations/accept')
      .set('x-csrf-token', newcomer.csrfToken)
      .send({ token })
      .expect(404);
    expect(replay.body.error.code).toBe('INVITATION_NOT_FOUND');
  });

  it('refuses acceptance by a different email address', async () => {
    // A forwarded link must not let whoever received it join.
    const org = await createOrg();
    await invite(org, 'intended@northstar.example');
    const token = lastInvitationToken(ctx);

    const wrongPerson = await registerUser(ctx, { email: 'someone-else@northstar.example' });

    const refused = await wrongPerson.agent
      .post('/api/v1/invitations/accept')
      .set('x-csrf-token', wrongPerson.csrfToken)
      .send({ token })
      .expect(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');

    expect(
      await ctx.prisma.organizationMembership.count({
        where: { organizationId: org.orgId, userId: wrongPerson.userId },
      }),
    ).toBe(0);
  });

  it('refuses an expired invitation', async () => {
    const org = await createOrg();
    const created = await invite(org, 'newcomer@northstar.example');
    const token = lastInvitationToken(ctx);

    await ctx.prisma.invitation.update({
      where: { id: created.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const newcomer = await registerUser(ctx, { email: 'newcomer@northstar.example' });
    await newcomer.agent
      .post('/api/v1/invitations/accept')
      .set('x-csrf-token', newcomer.csrfToken)
      .send({ token })
      .expect(404);
  });

  it('refuses a revoked invitation', async () => {
    const org = await createOrg();
    const created = await invite(org, 'newcomer@northstar.example');
    const token = lastInvitationToken(ctx);

    await org.agent
      .delete(`/api/v1/organizations/${org.slug}/invitations/${created.id}`)
      .set('x-csrf-token', org.csrf)
      .expect(204);

    const newcomer = await registerUser(ctx, { email: 'newcomer@northstar.example' });
    await newcomer.agent
      .post('/api/v1/invitations/accept')
      .set('x-csrf-token', newcomer.csrfToken)
      .send({ token })
      .expect(404);
  });

  it('gives the same response for unknown, expired and revoked tokens', async () => {
    const org = await createOrg();
    const expiredInv = await invite(org, 'expired@northstar.example');
    const expiredToken = lastInvitationToken(ctx);
    await ctx.prisma.invitation.update({
      where: { id: expiredInv.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const revokedInv = await invite(org, 'revoked@northstar.example');
    const revokedToken = lastInvitationToken(ctx);
    await org.agent
      .delete(`/api/v1/organizations/${org.slug}/invitations/${revokedInv.id}`)
      .set('x-csrf-token', org.csrf)
      .expect(204);

    const responses = await Promise.all(
      [expiredToken, revokedToken, 'a'.repeat(43)].map((t) =>
        ctx.http().get(`/api/v1/invitations/${t}`),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('INVITATION_NOT_FOUND');
      expect(response.body.error.message).toBe(responses[0]?.body.error.message);
    }
  });

  it('stops an ADMIN inviting an OWNER', async () => {
    // Same escalation guard as changeRole, applied at the entry point:
    // otherwise an admin could mint an owner account they control.
    const org = await createOrg();
    const admin = await addMember(org, 'ADMIN', 'admin');

    const refused = await admin.agent
      .post(`/api/v1/organizations/${org.slug}/invitations`)
      .set('x-csrf-token', admin.csrfToken)
      .send({ email: 'puppet@northstar.example', role: 'OWNER' })
      .expect(403);

    expect(refused.body.error.code).toBe('CANNOT_GRANT_ABOVE_OWN_ROLE');
  });

  it('stops a MEMBER inviting anyone', async () => {
    const org = await createOrg();
    const member = await addMember(org, 'MEMBER', 'member');

    await member.agent
      .post(`/api/v1/organizations/${org.slug}/invitations`)
      .set('x-csrf-token', member.csrfToken)
      .send({ email: 'someone@northstar.example', role: 'VIEWER' })
      .expect(403);
  });

  it("refuses to list or revoke another tenant's invitations", async () => {
    const a = await createOrg('northstar');
    const b = await createOrg('meridian', 'Meridian Labs');
    const created = await invite(b, 'newcomer@meridian.example');

    await a.agent.get(`/api/v1/organizations/${b.slug}/invitations`).expect(404);
    await a.agent
      .delete(`/api/v1/organizations/${a.slug}/invitations/${created.id}`)
      .set('x-csrf-token', a.csrf)
      .expect(404);
  });

  it('enforces the organization email-domain restriction', async () => {
    const org = await createOrg();
    await org.agent
      .patch(`/api/v1/organizations/${org.slug}/settings`)
      .set('x-csrf-token', org.csrf)
      .send({ restrictEmailDomains: true, allowedEmailDomains: ['northstar.example'] })
      .expect(200);

    await org.agent
      .post(`/api/v1/organizations/${org.slug}/invitations`)
      .set('x-csrf-token', org.csrf)
      .send({ email: 'outsider@elsewhere.example', role: 'MEMBER' })
      .expect(403);

    await org.agent
      .post(`/api/v1/organizations/${org.slug}/invitations`)
      .set('x-csrf-token', org.csrf)
      .send({ email: 'colleague@northstar.example', role: 'MEMBER' })
      .expect(201);
  });
});

describe('audit log endpoints', () => {
  it('is readable by ADMIN and OWNER but not MEMBER or VIEWER', async () => {
    const org = await createOrg();
    const admin = await addMember(org, 'ADMIN', 'admin');
    const member = await addMember(org, 'MEMBER', 'member');
    const viewer = await addMember(org, 'VIEWER', 'viewer');

    await org.agent.get(`/api/v1/organizations/${org.slug}/audit-logs`).expect(200);
    await admin.agent.get(`/api/v1/organizations/${org.slug}/audit-logs`).expect(200);
    await member.agent.get(`/api/v1/organizations/${org.slug}/audit-logs`).expect(403);
    await viewer.agent.get(`/api/v1/organizations/${org.slug}/audit-logs`).expect(403);
  });

  it('paginates newest-first by cursor without repeating or skipping rows', async () => {
    const org = await createOrg();
    for (let i = 0; i < 7; i++) {
      await org.agent
        .post(`/api/v1/organizations/${org.slug}/teams`)
        .set('x-csrf-token', org.csrf)
        .send({ name: `Team ${i}` })
        .expect(201);
    }

    const first = await org.agent
      .get(`/api/v1/organizations/${org.slug}/audit-logs?limit=3`)
      .expect(200);
    expect(first.body.data).toHaveLength(3);
    expect(first.body.pagination.hasMore).toBe(true);

    const second = await org.agent
      .get(
        `/api/v1/organizations/${org.slug}/audit-logs?limit=3&cursor=${first.body.pagination.nextCursor}`,
      )
      .expect(200);

    const firstIds = first.body.data.map((r: { id: string }) => r.id);
    const secondIds = second.body.data.map((r: { id: string }) => r.id);
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);

    // Newest first: every id on page two sorts below every id on page one.
    expect(Math.max(...secondIds.map((id: string) => id.localeCompare(firstIds[2])))).toBeLessThan(0);
  });

  it('filters by action', async () => {
    const org = await createOrg();
    await org.agent
      .post(`/api/v1/organizations/${org.slug}/teams`)
      .set('x-csrf-token', org.csrf)
      .send({ name: 'Platform' })
      .expect(201);

    const filtered = await org.agent
      .get(`/api/v1/organizations/${org.slug}/audit-logs?action=team.created`)
      .expect(200);

    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0].action).toBe('team.created');
  });

  it("never returns another tenant's entries", async () => {
    const a = await createOrg('northstar');
    const b = await createOrg('meridian', 'Meridian Labs');
    await b.agent
      .post(`/api/v1/organizations/${b.slug}/teams`)
      .set('x-csrf-token', b.csrf)
      .send({ name: 'Meridian Platform' })
      .expect(201);

    const own = await a.agent.get(`/api/v1/organizations/${a.slug}/audit-logs`).expect(200);
    const actions = own.body.data.map((r: { action: string }) => r.action);
    expect(actions).not.toContain('team.created');

    await a.agent.get(`/api/v1/organizations/${b.slug}/audit-logs`).expect(404);
  });

  it('exposes no write endpoint', async () => {
    // A trail an administrator can edit is not a trail.
    const org = await createOrg();
    await org.agent
      .post(`/api/v1/organizations/${org.slug}/audit-logs`)
      .set('x-csrf-token', org.csrf)
      .send({ action: 'forged.event', resourceType: 'organization' })
      .expect(404);
  });
});

describe('organization settings', () => {
  it('is readable and writable by ADMIN, and by neither MEMBER nor VIEWER', async () => {
    const org = await createOrg();
    const admin = await addMember(org, 'ADMIN', 'admin');
    const member = await addMember(org, 'MEMBER', 'member');

    await admin.agent.get(`/api/v1/organizations/${org.slug}/settings`).expect(200);
    await admin.agent
      .patch(`/api/v1/organizations/${org.slug}/settings`)
      .set('x-csrf-token', admin.csrfToken)
      .send({ requireTwoFactor: true })
      .expect(200);

    await member.agent.get(`/api/v1/organizations/${org.slug}/settings`).expect(403);
    await member.agent
      .patch(`/api/v1/organizations/${org.slug}/settings`)
      .set('x-csrf-token', member.csrfToken)
      .send({ requireTwoFactor: false })
      .expect(403);
  });

  it('refuses a domain restriction with an empty allow-list', async () => {
    // Accepting it would block every future invitation, including the
    // administrator's attempt to undo it.
    const org = await createOrg();

    const refused = await org.agent
      .patch(`/api/v1/organizations/${org.slug}/settings`)
      .set('x-csrf-token', org.csrf)
      .send({ restrictEmailDomains: true, allowedEmailDomains: [] })
      .expect(409);

    expect(refused.body.error.code).toBe('CONFLICT');
    expect((await org.agent.get(`/api/v1/organizations/${org.slug}/settings`)).body.restrictEmailDomains).toBe(false);
  });

  it('records a settings change in the audit log', async () => {
    const org = await createOrg();
    await org.agent
      .patch(`/api/v1/organizations/${org.slug}/settings`)
      .set('x-csrf-token', org.csrf)
      .send({ requireTwoFactor: true })
      .expect(200);

    const entry = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { organizationId: org.orgId, action: 'organization.settings_updated' },
    });
    expect(entry.actorId).toBe(org.userId);
  });

  it("refuses to read or write another tenant's settings", async () => {
    const a = await createOrg('northstar');
    const b = await createOrg('meridian', 'Meridian Labs');

    await a.agent.get(`/api/v1/organizations/${b.slug}/settings`).expect(404);
    await a.agent
      .patch(`/api/v1/organizations/${b.slug}/settings`)
      .set('x-csrf-token', a.csrf)
      .send({ requireTwoFactor: true })
      .expect(404);

    const settings = await ctx.prisma.organizationSettings.findUniqueOrThrow({
      where: { organizationId: b.orgId },
    });
    expect(settings.requireTwoFactor).toBe(false);
  });
});
