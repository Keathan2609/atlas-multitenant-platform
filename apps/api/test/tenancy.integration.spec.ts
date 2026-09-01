import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import {
  createTestContext,
  destroyTestContext,
  registerUser,
  resetState,
  type TestContext,
} from './harness.js';

/**
 * Cross-tenant isolation.
 *
 * These are the tests that matter most in ATLAS. Everything else is a feature;
 * a failure here is a data breach.
 *
 * Every case is written from the attacker's side: a real, authenticated user
 * of organization A deliberately addressing organization B. The assertion is
 * always that B's data is neither readable nor writable, and — separately —
 * that the response does not reveal whether B exists at all.
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

interface Tenant {
  agent: request.Agent;
  csrfToken: string;
  userId: string;
  email: string;
  slug: string;
  orgId: string;
}

/** Registers a user and gives them their own organization. */
async function createTenant(name: string, slugHint: string): Promise<Tenant> {
  const { agent, csrfToken, userId, email } = await registerUser(ctx, {
    email: `${slugHint}-owner@northstar.example`,
    displayName: `${name} Owner`,
  });

  const response = await agent
    .post('/api/v1/organizations')
    .set('x-csrf-token', csrfToken)
    .send({ name, slug: slugHint })
    .expect(201);

  return {
    agent,
    csrfToken,
    userId,
    email,
    slug: response.body.slug as string,
    orgId: response.body.id as string,
  };
}

describe('organization creation', () => {
  it('creates the organization, owner membership, settings and a default workspace atomically', async () => {
    const { agent, csrfToken, userId } = await registerUser(ctx);

    const response = await agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Northstar Systems' })
      .expect(201);

    expect(response.body.slug).toBe('northstar-systems');
    expect(response.body.role).toBe('OWNER');

    const orgId = response.body.id as string;

    // Every row the transaction promises must exist. A partial commit here
    // leaves an organization nobody can administer.
    const [membership, settings, workspace, audit] = await Promise.all([
      ctx.prisma.organizationMembership.findFirst({ where: { organizationId: orgId, userId } }),
      ctx.prisma.organizationSettings.findUnique({ where: { organizationId: orgId } }),
      ctx.prisma.workspace.findFirst({ where: { organizationId: orgId, isDefault: true } }),
      ctx.prisma.auditLog.findFirst({
        where: { organizationId: orgId, action: 'organization.created' },
      }),
    ]);

    expect(membership?.role).toBe('OWNER');
    expect(settings).not.toBeNull();
    expect(workspace?.slug).toBe('general');
    expect(audit?.actorId).toBe(userId);
  });

  it('derives a unique slug when the obvious one is taken', async () => {
    const first = await registerUser(ctx, { email: 'a@northstar.example' });
    await first.agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', first.csrfToken)
      .send({ name: 'Meridian Labs' })
      .expect(201);

    const second = await registerUser(ctx, { email: 'b@northstar.example' });
    const response = await second.agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', second.csrfToken)
      .send({ name: 'Meridian Labs' })
      .expect(201);

    expect(response.body.slug).toBe('meridian-labs-2');
  });

  it('rejects an explicitly requested slug that is already taken', async () => {
    // Silently handing back `meridian-labs-2` when the user asked for
    // `meridian-labs` would be surprising; a collision they chose is an error
    // they need to see.
    const first = await registerUser(ctx, { email: 'a@northstar.example' });
    await first.agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', first.csrfToken)
      .send({ name: 'Meridian Labs', slug: 'meridian' })
      .expect(201);

    const second = await registerUser(ctx, { email: 'b@northstar.example' });
    const response = await second.agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', second.csrfToken)
      .send({ name: 'Something Else', slug: 'meridian' })
      .expect(409);

    expect(response.body.error.code).toBe('SLUG_TAKEN');
  });

  it('refuses a slug that would shadow an application route', async () => {
    const { agent, csrfToken } = await registerUser(ctx);
    await agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Admin Org', slug: 'admin' })
      .expect(422);
  });
});

describe('cross-tenant access prevention', () => {
  it("hides another tenant's organization behind a 404, not a 403", async () => {
    // 403 would confirm the organization exists, letting an attacker
    // enumerate tenants by slug. Existence and membership must be
    // indistinguishable from outside.
    const northstar = await createTenant('Northstar Systems', 'northstar');
    const meridian = await createTenant('Meridian Labs', 'meridian');

    const response = await northstar.agent
      .get(`/api/v1/organizations/${meridian.slug}`)
      .expect(404);

    expect(response.body.error.code).toBe('ORGANIZATION_NOT_FOUND');

    // A slug that exists nowhere must produce the identical response.
    const nonexistent = await northstar.agent
      .get('/api/v1/organizations/does-not-exist-anywhere')
      .expect(404);

    expect(nonexistent.body.error.code).toBe(response.body.error.code);
    expect(nonexistent.body.error.message).toBe(response.body.error.message);
  });

  it("refuses to list another tenant's members", async () => {
    const northstar = await createTenant('Northstar Systems', 'northstar');
    const meridian = await createTenant('Meridian Labs', 'meridian');

    await northstar.agent.get(`/api/v1/organizations/${meridian.slug}/members`).expect(404);
  });

  it("refuses to mutate another tenant's organization", async () => {
    const northstar = await createTenant('Northstar Systems', 'northstar');
    const meridian = await createTenant('Meridian Labs', 'meridian');

    await northstar.agent
      .patch(`/api/v1/organizations/${meridian.slug}`)
      .set('x-csrf-token', northstar.csrfToken)
      .send({ name: 'Hijacked' })
      .expect(404);

    const unchanged = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: meridian.orgId },
    });
    expect(unchanged.name).toBe('Meridian Labs');
  });

  it("refuses to delete another tenant's organization even with the right confirmation", async () => {
    // The confirmation string is not a credential. Knowing the target's slug
    // must not be sufficient to act on it.
    const northstar = await createTenant('Northstar Systems', 'northstar');
    const meridian = await createTenant('Meridian Labs', 'meridian');

    await northstar.agent
      .delete(`/api/v1/organizations/${meridian.slug}`)
      .set('x-csrf-token', northstar.csrfToken)
      .send({ confirmSlug: meridian.slug })
      .expect(404);

    const survivor = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: meridian.orgId },
    });
    expect(survivor.deletedAt).toBeNull();
  });

  it('refuses to change a role in another tenant', async () => {
    const northstar = await createTenant('Northstar Systems', 'northstar');
    const meridian = await createTenant('Meridian Labs', 'meridian');

    await northstar.agent
      .patch(`/api/v1/organizations/${meridian.slug}/members/${meridian.userId}`)
      .set('x-csrf-token', northstar.csrfToken)
      .send({ role: 'VIEWER' })
      .expect(404);

    const membership = await ctx.prisma.organizationMembership.findFirstOrThrow({
      where: { organizationId: meridian.orgId, userId: meridian.userId },
    });
    expect(membership.role).toBe('OWNER');
  });

  it('only lists organizations the caller actually belongs to', async () => {
    const northstar = await createTenant('Northstar Systems', 'northstar');
    await createTenant('Meridian Labs', 'meridian');

    const response = await northstar.agent.get('/api/v1/organizations').expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].slug).toBe('northstar');
  });

  it('stops a user reaching a tenant after their membership is removed', async () => {
    // Revocation must take effect on the next request, not at session expiry.
    const northstar = await createTenant('Northstar Systems', 'northstar');
    const guest = await registerUser(ctx, { email: 'guest@northstar.example' });

    await ctx.prisma.organizationMembership.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: northstar.orgId,
        userId: guest.userId,
        role: 'MEMBER',
      },
    });

    await guest.agent.get(`/api/v1/organizations/${northstar.slug}`).expect(200);

    await ctx.prisma.organizationMembership.deleteMany({
      where: { organizationId: northstar.orgId, userId: guest.userId },
    });

    await guest.agent.get(`/api/v1/organizations/${northstar.slug}`).expect(404);
  });

  it('makes a soft-deleted organization immediately unreachable', async () => {
    const northstar = await createTenant('Northstar Systems', 'northstar');

    await northstar.agent
      .delete(`/api/v1/organizations/${northstar.slug}`)
      .set('x-csrf-token', northstar.csrfToken)
      .send({ confirmSlug: northstar.slug })
      .expect(204);

    await northstar.agent.get(`/api/v1/organizations/${northstar.slug}`).expect(404);

    const listed = await northstar.agent.get('/api/v1/organizations').expect(200);
    expect(listed.body.data).toHaveLength(0);
  });
});

describe('organization deletion guards', () => {
  it('requires the confirmation to match the slug', async () => {
    const northstar = await createTenant('Northstar Systems', 'northstar');

    const response = await northstar.agent
      .delete(`/api/v1/organizations/${northstar.slug}`)
      .set('x-csrf-token', northstar.csrfToken)
      .send({ confirmSlug: 'not-the-slug' })
      .expect(409);

    expect(response.body.error.code).toBe('CONFIRMATION_MISMATCH');

    const survivor = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: northstar.orgId },
    });
    expect(survivor.deletedAt).toBeNull();
  });
});
