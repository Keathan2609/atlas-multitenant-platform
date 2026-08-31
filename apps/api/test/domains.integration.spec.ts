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
 * Workspaces, teams, projects and work items.
 *
 * The interesting cases are not the CRUD happy paths — they are the
 * invariants: gapless per-project numbering under concurrency, the Restrict
 * foreign key on team deletion, refusing to cascade away an arbitrary amount
 * of work, and tenant isolation holding for every one of these entities.
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
  defaultWorkspaceId: string;
}

async function createOrg(prefix = 'northstar'): Promise<Org> {
  const user = await registerUser(ctx, { email: `${prefix}-owner@northstar.example` });
  const response = await user.agent
    .post('/api/v1/organizations')
    .set('x-csrf-token', user.csrfToken)
    .send({ name: 'Northstar Systems', slug: prefix })
    .expect(201);

  const workspace = await ctx.prisma.workspace.findFirstOrThrow({
    where: { organizationId: response.body.id, isDefault: true },
  });

  return {
    slug: response.body.slug,
    orgId: response.body.id,
    agent: user.agent,
    csrf: user.csrfToken,
    userId: user.userId,
    defaultWorkspaceId: workspace.id,
  };
}

async function addMember(org: Org, role: OrganizationRole, prefix: string) {
  const user = await registerUser(ctx, { email: `${prefix}@northstar.example` });
  await ctx.prisma.organizationMembership.create({
    data: { id: newId(), organizationId: org.orgId, userId: user.userId, role },
  });
  return user;
}

async function createProject(org: Org, name = 'Developer Portal', key?: string) {
  const response = await org.agent
    .post(`/api/v1/organizations/${org.slug}/projects`)
    .set('x-csrf-token', org.csrf)
    .send({ name, workspaceId: org.defaultWorkspaceId, ...(key ? { key } : {}) })
    .expect(201);
  return response.body as { id: string; key: string; name: string };
}

describe('workspaces', () => {
  it('creates a workspace and derives its slug', async () => {
    const org = await createOrg();
    const response = await org.agent
      .post(`/api/v1/organizations/${org.slug}/workspaces`)
      .set('x-csrf-token', org.csrf)
      .send({ name: 'Platform Engineering' })
      .expect(201);

    expect(response.body.slug).toBe('platform-engineering');
    expect(response.body.isDefault).toBe(false);
  });

  it('refuses to delete the default workspace', async () => {
    // It is where projects land when none is chosen; deleting it would leave
    // the organization unable to create a project.
    const org = await createOrg();
    const response = await org.agent
      .delete(`/api/v1/organizations/${org.slug}/workspaces/${org.defaultWorkspaceId}`)
      .set('x-csrf-token', org.csrf)
      .expect(409);

    expect(response.body.error.code).toBe('CANNOT_DELETE_DEFAULT_WORKSPACE');
  });

  it('refuses to delete a workspace that still holds projects', async () => {
    // The schema cascades workspace -> projects -> work items, so allowing
    // this would erase an arbitrary amount of work from one click.
    const org = await createOrg();
    const created = await org.agent
      .post(`/api/v1/organizations/${org.slug}/workspaces`)
      .set('x-csrf-token', org.csrf)
      .send({ name: 'Secondary' })
      .expect(201);

    await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects`)
      .set('x-csrf-token', org.csrf)
      .send({ name: 'Held Project', workspaceId: created.body.id })
      .expect(201);

    const refused = await org.agent
      .delete(`/api/v1/organizations/${org.slug}/workspaces/${created.body.id}`)
      .set('x-csrf-token', org.csrf)
      .expect(409);

    expect(refused.body.error.code).toBe('WORKSPACE_NOT_EMPTY');
    expect(await ctx.prisma.project.count({ where: { organizationId: org.orgId } })).toBe(1);
  });

  it('keeps workspaces invisible across tenants', async () => {
    const a = await createOrg('northstar');
    const b = await createOrg('meridian');

    await a.agent.get(`/api/v1/organizations/${b.slug}/workspaces`).expect(404);
    await a.agent
      .get(`/api/v1/organizations/${a.slug}/workspaces/${b.defaultWorkspaceId}`)
      .expect(404);
  });
});

describe('teams', () => {
  it('unassigns projects when a team is deleted', async () => {
    // Project.team is Restrict, because a composite FK's SET NULL would blank
    // the NOT NULL organizationId and detach the row from its tenant. The
    // service therefore unassigns inside the deletion transaction.
    const org = await createOrg();
    const team = await org.agent
      .post(`/api/v1/organizations/${org.slug}/teams`)
      .set('x-csrf-token', org.csrf)
      .send({ name: 'Platform' })
      .expect(201);

    const project = await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects`)
      .set('x-csrf-token', org.csrf)
      .send({ name: 'Owned Project', workspaceId: org.defaultWorkspaceId, teamId: team.body.id })
      .expect(201);

    await org.agent
      .delete(`/api/v1/organizations/${org.slug}/teams/${team.body.id}`)
      .set('x-csrf-token', org.csrf)
      .expect(204);

    // The project survives, detached from the deleted team and still in its
    // tenant — the failure mode Restrict exists to prevent.
    const survivor = await ctx.prisma.project.findUniqueOrThrow({ where: { id: project.body.id } });
    expect(survivor.teamId).toBeNull();
    expect(survivor.organizationId).toBe(org.orgId);
  });

  it('refuses to add a non-member to a team', async () => {
    // The composite FK onto OrganizationMembership would reject this anyway;
    // the service check turns a constraint violation into a clean 404.
    const org = await createOrg();
    const outsider = await registerUser(ctx, { email: 'outsider@elsewhere.example' });

    const team = await org.agent
      .post(`/api/v1/organizations/${org.slug}/teams`)
      .set('x-csrf-token', org.csrf)
      .send({ name: 'Platform' })
      .expect(201);

    const refused = await org.agent
      .post(`/api/v1/organizations/${org.slug}/teams/${team.body.id}/members`)
      .set('x-csrf-token', org.csrf)
      .send({ userId: outsider.userId, role: 'MEMBER' })
      .expect(404);

    expect(refused.body.error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('adds an organization member to a team', async () => {
    const org = await createOrg();
    const member = await addMember(org, 'MEMBER', 'teammate');

    const team = await org.agent
      .post(`/api/v1/organizations/${org.slug}/teams`)
      .set('x-csrf-token', org.csrf)
      .send({ name: 'Platform' })
      .expect(201);

    await org.agent
      .post(`/api/v1/organizations/${org.slug}/teams/${team.body.id}/members`)
      .set('x-csrf-token', org.csrf)
      .send({ userId: member.userId, role: 'LEAD' })
      .expect(201);

    const detail = await org.agent
      .get(`/api/v1/organizations/${org.slug}/teams/${team.body.id}`)
      .expect(200);

    expect(detail.body.members).toHaveLength(1);
    expect(detail.body.members[0].role).toBe('LEAD');
  });
});

describe('projects', () => {
  it('derives a key from the project name', async () => {
    const org = await createOrg();
    const project = await createProject(org, 'Identity Service Migration');
    expect(project.key).toBe('ISM');
  });

  it('rejects a duplicate key the caller chose explicitly', async () => {
    const org = await createOrg();
    await createProject(org, 'Portal One', 'PORTAL');

    const refused = await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects`)
      .set('x-csrf-token', org.csrf)
      .send({ name: 'Portal Two', key: 'PORTAL', workspaceId: org.defaultWorkspaceId })
      .expect(409);

    expect(refused.body.error.code).toBe('PROJECT_KEY_TAKEN');
  });

  it('lets two tenants use the same project key', async () => {
    // Keys are unique per tenant, not globally. If they were global, one
    // organization could deny another a key simply by taking it first.
    const a = await createOrg('northstar');
    const b = await createOrg('meridian');

    await createProject(a, 'Portal', 'PORTAL');
    await createProject(b, 'Portal', 'PORTAL');

    expect(await ctx.prisma.project.count({ where: { key: 'PORTAL' } })).toBe(2);
  });

  it('refuses a workspace belonging to another tenant', async () => {
    // The composite FK would reject this too, but as a 500. Checking first
    // returns 404 and reveals nothing about whether the id exists elsewhere.
    const a = await createOrg('northstar');
    const b = await createOrg('meridian');

    const refused = await a.agent
      .post(`/api/v1/organizations/${a.slug}/projects`)
      .set('x-csrf-token', a.csrf)
      .send({ name: 'Cross Tenant', workspaceId: b.defaultWorkspaceId })
      .expect(404);

    expect(refused.body.error.code).toBe('WORKSPACE_NOT_FOUND');
  });

  it('stamps and clears archivedAt with status', async () => {
    const org = await createOrg();
    const project = await createProject(org);

    const archived = await org.agent
      .patch(`/api/v1/organizations/${org.slug}/projects/${project.id}`)
      .set('x-csrf-token', org.csrf)
      .send({ status: 'ARCHIVED' })
      .expect(200);
    expect(archived.body.archivedAt).not.toBeNull();

    const reopened = await org.agent
      .patch(`/api/v1/organizations/${org.slug}/projects/${project.id}`)
      .set('x-csrf-token', org.csrf)
      .send({ status: 'ACTIVE' })
      .expect(200);
    expect(reopened.body.archivedAt).toBeNull();
  });

  it('refuses to change the project key', async () => {
    // The key appears in every work-item reference people paste elsewhere, so
    // it is absent from the update schema entirely.
    const org = await createOrg();
    const project = await createProject(org, 'Portal', 'PORTAL');

    await org.agent
      .patch(`/api/v1/organizations/${org.slug}/projects/${project.id}`)
      .set('x-csrf-token', org.csrf)
      .send({ key: 'RENAMED' })
      .expect(422);
  });

  it('stops a MEMBER deleting a project', async () => {
    // MEMBER may create and update, but deleting takes the work items with it.
    const org = await createOrg();
    const project = await createProject(org);
    const member = await addMember(org, 'MEMBER', 'member');

    await member.agent
      .delete(`/api/v1/organizations/${org.slug}/projects/${project.id}`)
      .set('x-csrf-token', member.csrfToken)
      .expect(403);

    expect(await ctx.prisma.project.count({ where: { id: project.id } })).toBe(1);
  });

  it('hides projects from another tenant', async () => {
    const a = await createOrg('northstar');
    const b = await createOrg('meridian');
    const secret = await createProject(b, 'Secret Roadmap');

    await a.agent.get(`/api/v1/organizations/${a.slug}/projects/${secret.id}`).expect(404);

    const listed = await a.agent.get(`/api/v1/organizations/${a.slug}/projects`).expect(200);
    expect(listed.body.data).toHaveLength(0);
  });
});

describe('work items', () => {
  it('numbers items per project, starting at 1', async () => {
    const org = await createOrg();
    const portal = await createProject(org, 'Developer Portal', 'PORTAL');
    const billing = await createProject(org, 'Billing Infrastructure', 'BILL');

    const first = await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects/${portal.id}/work-items`)
      .set('x-csrf-token', org.csrf)
      .send({ title: 'Draft the OpenAPI spec' })
      .expect(201);

    const second = await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects/${portal.id}/work-items`)
      .set('x-csrf-token', org.csrf)
      .send({ title: 'Wire up authentication' })
      .expect(201);

    // A different project restarts at 1 — the whole reason for a per-project
    // counter rather than a global sequence.
    const other = await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects/${billing.id}/work-items`)
      .set('x-csrf-token', org.csrf)
      .send({ title: 'Reconcile invoice totals' })
      .expect(201);

    expect(first.body.reference).toBe('PORTAL-1');
    expect(second.body.reference).toBe('PORTAL-2');
    expect(other.body.reference).toBe('BILL-1');
  });

  it('allocates gapless, unique numbers under concurrent creation', async () => {
    // The claim the counter design rests on. `increment` compiles to
    // SET counter = counter + 1 and takes a row lock, so concurrent creates
    // serialise on that row rather than racing a read-modify-write.
    const org = await createOrg();
    const project = await createProject(org, 'Reliability Program', 'REL');

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        org.agent
          .post(`/api/v1/organizations/${org.slug}/projects/${project.id}/work-items`)
          .set('x-csrf-token', org.csrf)
          .send({ title: `Concurrent item ${i + 1}` }),
      ),
    );

    expect(results.every((r) => r.status === 201)).toBe(true);

    const numbers = results.map((r) => r.body.number as number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(12);
    expect(numbers).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('refuses an assignee who is not an organization member', async () => {
    // WorkItem.assigneeId references User directly so history survives a
    // departure, which means no foreign key enforces membership here.
    const org = await createOrg();
    const project = await createProject(org);
    const outsider = await registerUser(ctx, { email: 'outsider@elsewhere.example' });

    const refused = await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects/${project.id}/work-items`)
      .set('x-csrf-token', org.csrf)
      .send({ title: 'Assigned to an outsider', assigneeId: outsider.userId })
      .expect(404);

    expect(refused.body.error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('tracks completedAt against status', async () => {
    const org = await createOrg();
    const project = await createProject(org);

    const item = await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects/${project.id}/work-items`)
      .set('x-csrf-token', org.csrf)
      .send({ title: 'Finish the migration' })
      .expect(201);

    const done = await org.agent
      .patch(`/api/v1/organizations/${org.slug}/work-items/${item.body.id}`)
      .set('x-csrf-token', org.csrf)
      .send({ status: 'DONE' })
      .expect(200);
    expect(done.body.completedAt).not.toBeNull();

    const reopened = await org.agent
      .patch(`/api/v1/organizations/${org.slug}/work-items/${item.body.id}`)
      .set('x-csrf-token', org.csrf)
      .send({ status: 'IN_PROGRESS' })
      .expect(200);
    expect(reopened.body.completedAt).toBeNull();
  });

  it('resolves the assignee filter literal "me" server-side', async () => {
    const org = await createOrg();
    const project = await createProject(org);

    await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects/${project.id}/work-items`)
      .set('x-csrf-token', org.csrf)
      .send({ title: 'Mine', assigneeId: org.userId })
      .expect(201);

    await org.agent
      .post(`/api/v1/organizations/${org.slug}/projects/${project.id}/work-items`)
      .set('x-csrf-token', org.csrf)
      .send({ title: 'Unassigned' })
      .expect(201);

    const mine = await org.agent
      .get(`/api/v1/organizations/${org.slug}/work-items?assigneeId=me`)
      .expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].title).toBe('Mine');

    const unassigned = await org.agent
      .get(`/api/v1/organizations/${org.slug}/work-items?assigneeId=unassigned`)
      .expect(200);
    expect(unassigned.body.data).toHaveLength(1);
    expect(unassigned.body.data[0].title).toBe('Unassigned');
  });

  it('hides work items from another tenant', async () => {
    const a = await createOrg('northstar');
    const b = await createOrg('meridian');
    const project = await createProject(b, 'Secret Roadmap');

    const item = await b.agent
      .post(`/api/v1/organizations/${b.slug}/projects/${project.id}/work-items`)
      .set('x-csrf-token', b.csrf)
      .send({ title: 'Confidential' })
      .expect(201);

    await a.agent.get(`/api/v1/organizations/${a.slug}/work-items/${item.body.id}`).expect(404);

    // And a cross-tenant delete must affect nothing.
    await a.agent
      .delete(`/api/v1/organizations/${a.slug}/work-items/${item.body.id}`)
      .set('x-csrf-token', a.csrf)
      .expect(404);

    expect(await ctx.prisma.workItem.count({ where: { id: item.body.id } })).toBe(1);
  });

  it('lets a VIEWER read work items but not create them', async () => {
    const org = await createOrg();
    const project = await createProject(org);
    const viewer = await addMember(org, 'VIEWER', 'viewer');

    await viewer.agent.get(`/api/v1/organizations/${org.slug}/work-items`).expect(200);

    await viewer.agent
      .post(`/api/v1/organizations/${org.slug}/projects/${project.id}/work-items`)
      .set('x-csrf-token', viewer.csrfToken)
      .send({ title: 'Should not be created' })
      .expect(403);
  });
});
