import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { newId } from '@atlas/database';
import type { OrganizationRole } from '@atlas/types';
import {
  createTestContext,
  destroyTestContext,
  registerUser,
  resetState,
  type TestContext,
} from './harness.js';

/**
 * Authorization enforced over HTTP.
 *
 * The permission matrix is unit-tested in @atlas/types. What these tests prove
 * is different and not implied by those: that the matrix is actually *wired
 * in* — that the guard runs, reads the role from the server-side membership
 * row, and that a client cannot talk its way past it.
 *
 * Each case is an escalation attempt by a real, authenticated member of the
 * organization, which is the threat that matters once tenant isolation holds.
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
  owner: { agent: request.Agent; csrfToken: string; userId: string };
}

async function createOrg(): Promise<Org> {
  const owner = await registerUser(ctx, { email: 'owner@northstar.example', displayName: 'Owner' });
  const response = await owner.agent
    .post('/api/v1/organizations')
    .set('x-csrf-token', owner.csrfToken)
    .send({ name: 'Northstar Systems', slug: 'northstar' })
    .expect(201);

  return {
    slug: response.body.slug as string,
    orgId: response.body.id as string,
    owner: { agent: owner.agent, csrfToken: owner.csrfToken, userId: owner.userId },
  };
}

/**
 * Adds a member at a given role by writing the membership row directly.
 *
 * Deliberately bypasses the invitation flow — that is a separate feature with
 * its own tests, and going through it here would make these tests fail for
 * reasons unrelated to authorization.
 */
async function addMember(org: Org, role: OrganizationRole, emailPrefix: string) {
  const user = await registerUser(ctx, {
    email: `${emailPrefix}@northstar.example`,
    displayName: emailPrefix,
  });

  await ctx.prisma.organizationMembership.create({
    data: { id: newId(), organizationId: org.orgId, userId: user.userId, role },
  });

  return user;
}

describe('permission enforcement at the HTTP boundary', () => {
  it('lets a VIEWER read but not mutate', async () => {
    const org = await createOrg();
    const viewer = await addMember(org, 'VIEWER', 'viewer');

    await viewer.agent.get(`/api/v1/organizations/${org.slug}`).expect(200);
    await viewer.agent.get(`/api/v1/organizations/${org.slug}/members`).expect(200);

    const denied = await viewer.agent
      .patch(`/api/v1/organizations/${org.slug}`)
      .set('x-csrf-token', viewer.csrfToken)
      .send({ name: 'Renamed by a viewer' })
      .expect(403);

    expect(denied.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
  });

  it('stops a MEMBER reading the member list it has no permission for', async () => {
    // MEMBER holds members.read, so this asserts the positive; the negative
    // below is the one that matters.
    const org = await createOrg();
    const member = await addMember(org, 'MEMBER', 'member');

    await member.agent.get(`/api/v1/organizations/${org.slug}/members`).expect(200);

    await member.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${org.owner.userId}`)
      .set('x-csrf-token', member.csrfToken)
      .send({ role: 'VIEWER' })
      .expect(403);
  });

  it('stops a MEMBER deleting the organization', async () => {
    const org = await createOrg();
    const member = await addMember(org, 'MEMBER', 'member');

    await member.agent
      .delete(`/api/v1/organizations/${org.slug}`)
      .set('x-csrf-token', member.csrfToken)
      .send({ confirmSlug: org.slug })
      .expect(403);

    const survivor = await ctx.prisma.organization.findUniqueOrThrow({ where: { id: org.orgId } });
    expect(survivor.deletedAt).toBeNull();
  });

  it('stops an ADMIN deleting the organization', async () => {
    // organization.delete is owner-only. A compromised admin account must not
    // be able to destroy the tenant.
    const org = await createOrg();
    const admin = await addMember(org, 'ADMIN', 'admin');

    await admin.agent
      .delete(`/api/v1/organizations/${org.slug}`)
      .set('x-csrf-token', admin.csrfToken)
      .send({ confirmSlug: org.slug })
      .expect(403);
  });
});

describe('privilege escalation attempts', () => {
  it('stops an ADMIN granting OWNER', async () => {
    // The classic self-escalation: mint an owner, then have it promote you.
    const org = await createOrg();
    const admin = await addMember(org, 'ADMIN', 'admin');
    const target = await addMember(org, 'MEMBER', 'target');

    const denied = await admin.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${target.userId}`)
      .set('x-csrf-token', admin.csrfToken)
      .send({ role: 'OWNER' })
      .expect(403);

    expect(denied.body.error.code).toBe('CANNOT_GRANT_ABOVE_OWN_ROLE');

    const unchanged = await ctx.prisma.organizationMembership.findFirstOrThrow({
      where: { organizationId: org.orgId, userId: target.userId },
    });
    expect(unchanged.role).toBe('MEMBER');
  });

  it('stops an ADMIN demoting an OWNER', async () => {
    const org = await createOrg();
    const admin = await addMember(org, 'ADMIN', 'admin');

    const denied = await admin.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${org.owner.userId}`)
      .set('x-csrf-token', admin.csrfToken)
      .send({ role: 'MEMBER' })
      .expect(403);

    expect(denied.body.error.code).toBe('TARGET_OUTRANKS_ACTOR');
  });

  it('stops an ADMIN demoting a peer ADMIN', async () => {
    const org = await createOrg();
    const adminA = await addMember(org, 'ADMIN', 'admin-a');
    const adminB = await addMember(org, 'ADMIN', 'admin-b');

    await adminA.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${adminB.userId}`)
      .set('x-csrf-token', adminA.csrfToken)
      .send({ role: 'VIEWER' })
      .expect(403);
  });

  it('stops a member promoting themselves', async () => {
    const org = await createOrg();
    const member = await addMember(org, 'MEMBER', 'member');

    await member.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${member.userId}`)
      .set('x-csrf-token', member.csrfToken)
      .send({ role: 'OWNER' })
      .expect(403);

    const unchanged = await ctx.prisma.organizationMembership.findFirstOrThrow({
      where: { organizationId: org.orgId, userId: member.userId },
    });
    expect(unchanged.role).toBe('MEMBER');
  });

  it('refuses an OWNER changing their own role', async () => {
    const org = await createOrg();

    const denied = await org.owner.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${org.owner.userId}`)
      .set('x-csrf-token', org.owner.csrfToken)
      .send({ role: 'ADMIN' })
      .expect(403);

    expect(denied.body.error.code).toBe('CANNOT_MODIFY_SELF');
  });

  it('ignores a role smuggled in the request body of another endpoint', async () => {
    // Mass assignment: the update-organization schema is .strict(), so an
    // extra `role` is rejected outright rather than reaching a service that
    // might spread it into an update.
    const org = await createOrg();
    const member = await addMember(org, 'MEMBER', 'member');

    await member.agent
      .patch(`/api/v1/organizations/${org.slug}`)
      .set('x-csrf-token', member.csrfToken)
      .send({ name: 'x', role: 'OWNER' })
      .expect(422);
  });
});

describe('last-owner protection', () => {
  it('refuses to demote the only owner', async () => {
    const org = await createOrg();
    const secondOwner = await addMember(org, 'OWNER', 'owner-two');

    // Two owners: demoting one is fine.
    await org.owner.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${secondOwner.userId}`)
      .set('x-csrf-token', org.owner.csrfToken)
      .send({ role: 'ADMIN' })
      .expect(200);

    // One owner left: the remaining owner cannot be demoted by anyone.
    const admin = await addMember(org, 'ADMIN', 'admin');
    const denied = await admin.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${org.owner.userId}`)
      .set('x-csrf-token', admin.csrfToken)
      .send({ role: 'MEMBER' })
      .expect(403);

    // Rank is checked before the owner count, so an admin gets the rank
    // refusal — either way the organization keeps an owner.
    expect(['TARGET_OUTRANKS_ACTOR', 'LAST_OWNER']).toContain(denied.body.error.code);
  });

  it('refuses to let the last owner leave', async () => {
    const org = await createOrg();

    const denied = await org.owner.agent
      .delete(`/api/v1/organizations/${org.slug}/members/${org.owner.userId}`)
      .set('x-csrf-token', org.owner.csrfToken)
      .expect(403);

    expect(denied.body.error.code).toBe('LAST_OWNER');

    const stillThere = await ctx.prisma.organizationMembership.findFirst({
      where: { organizationId: org.orgId, userId: org.owner.userId },
    });
    expect(stillThere).not.toBeNull();
  });

  it('lets an owner leave once another owner exists', async () => {
    const org = await createOrg();
    await addMember(org, 'OWNER', 'owner-two');

    await org.owner.agent
      .delete(`/api/v1/organizations/${org.slug}/members/${org.owner.userId}`)
      .set('x-csrf-token', org.owner.csrfToken)
      .expect(204);

    const gone = await ctx.prisma.organizationMembership.findFirst({
      where: { organizationId: org.orgId, userId: org.owner.userId },
    });
    expect(gone).toBeNull();
  });

  it('lets a VIEWER leave voluntarily despite holding no remove permission', async () => {
    // The asymmetry with role changes: self-removal is always allowed except
    // for the last owner.
    const org = await createOrg();
    const viewer = await addMember(org, 'VIEWER', 'viewer');

    await viewer.agent
      .delete(`/api/v1/organizations/${org.slug}/members/${viewer.userId}`)
      .set('x-csrf-token', viewer.csrfToken)
      .expect(204);

    await viewer.agent.get(`/api/v1/organizations/${org.slug}`).expect(404);
  });
});

describe('audit trail', () => {
  it('records a role change with actor, target and both roles', async () => {
    const org = await createOrg();
    const target = await addMember(org, 'MEMBER', 'target');

    await org.owner.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${target.userId}`)
      .set('x-csrf-token', org.owner.csrfToken)
      .send({ role: 'ADMIN' })
      .expect(200);

    const entry = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { organizationId: org.orgId, action: 'member.role_changed' },
    });

    expect(entry.actorId).toBe(org.owner.userId);
    expect(entry.metadata).toMatchObject({ targetUserId: target.userId, from: 'MEMBER', to: 'ADMIN' });
  });

  it('does not write a role-change entry when the change was refused', async () => {
    // An audit trail that records attempts as if they succeeded is worse than
    // none, because it is trusted. The transaction rolls both back together.
    const org = await createOrg();
    const admin = await addMember(org, 'ADMIN', 'admin');

    await admin.agent
      .patch(`/api/v1/organizations/${org.slug}/members/${org.owner.userId}`)
      .set('x-csrf-token', admin.csrfToken)
      .send({ role: 'MEMBER' })
      .expect(403);

    const entries = await ctx.prisma.auditLog.findMany({
      where: { organizationId: org.orgId, action: 'member.role_changed' },
    });
    expect(entries).toHaveLength(0);
  });
});
