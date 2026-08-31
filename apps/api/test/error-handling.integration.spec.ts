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
 * Error-envelope behaviour, and the malformed-identifier regression.
 *
 * Found in the Phase 6 security review: a non-UUID path parameter reached
 * Prisma, which threw P2023, which the filter reported as a 500. Two problems
 * with that. It is a status-code oracle — 500 for malformed versus 404 for
 * absent tells a caller which of the two happened — and any client could
 * trigger an unbounded number of stack traces in the error log, where they
 * would drown genuine faults.
 */

let ctx: TestContext;
let agent: request.Agent;
let slug: string;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

afterEach(async () => {
  await resetState(ctx);
});

async function orgFixture() {
  const user = await registerUser(ctx, { email: 'errors@northstar.example' });
  const response = await user.agent
    .post('/api/v1/organizations')
    .set('x-csrf-token', user.csrfToken)
    .send({ name: 'Northstar Systems', slug: 'northstar' })
    .expect(201);
  agent = user.agent;
  slug = response.body.slug as string;
  return { agent, slug, csrf: user.csrfToken };
}

const ABSENT_UUID = '018f0000-0000-7000-8000-000000000999';

describe('malformed identifiers', () => {
  it('returns 404 rather than 500 for a non-UUID path parameter', async () => {
    const fixture = await orgFixture();

    for (const path of [
      `/api/v1/organizations/${fixture.slug}/work-items/not-a-uuid`,
      `/api/v1/organizations/${fixture.slug}/projects/not-a-uuid`,
      `/api/v1/organizations/${fixture.slug}/teams/not-a-uuid`,
      `/api/v1/organizations/${fixture.slug}/workspaces/not-a-uuid`,
    ]) {
      const response = await fixture.agent.get(path);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code, path).toBe('NOT_FOUND');
    }
  });

  it('returns the same status for a malformed and an absent identifier', async () => {
    // Both are 404. The error *code* still differs — malformed yields the
    // generic NOT_FOUND because the filter cannot tell which resource was
    // being addressed, while an absent id yields PROJECT_NOT_FOUND from the
    // service.
    //
    // That difference is deliberate rather than a gap. It distinguishes "your
    // input was malformed" from "no such project", and the caller already
    // knows which they sent. The oracle that would matter is a different one —
    // telling a resource that exists in *another tenant* apart from one that
    // does not exist at all — and the next test pins that closed.
    const fixture = await orgFixture();

    const malformed = await fixture.agent
      .get(`/api/v1/organizations/${fixture.slug}/projects/not-a-uuid`)
      .expect(404);
    const absent = await fixture.agent
      .get(`/api/v1/organizations/${fixture.slug}/projects/${ABSENT_UUID}`)
      .expect(404);

    expect(malformed.status).toBe(absent.status);
  });

  it("cannot distinguish another tenant's resource from one that does not exist", async () => {
    // This is the oracle that matters. A real project id belonging to another
    // organization must produce a byte-identical response to an id that exists
    // nowhere — otherwise ids become enumerable across tenants.
    const fixture = await orgFixture();

    const other = await registerUser(ctx, { email: 'other@meridian.example' });
    const otherOrg = await other.agent
      .post('/api/v1/organizations')
      .set('x-csrf-token', other.csrfToken)
      .send({ name: 'Meridian Labs', slug: 'meridian' })
      .expect(201);
    const otherWorkspace = await ctx.prisma.workspace.findFirstOrThrow({
      where: { organizationId: otherOrg.body.id, isDefault: true },
    });
    const otherProject = await other.agent
      .post(`/api/v1/organizations/meridian/projects`)
      .set('x-csrf-token', other.csrfToken)
      .send({ name: 'Confidential', workspaceId: otherWorkspace.id })
      .expect(201);

    const foreign = await fixture.agent
      .get(`/api/v1/organizations/${fixture.slug}/projects/${otherProject.body.id}`)
      .expect(404);
    const nonexistent = await fixture.agent
      .get(`/api/v1/organizations/${fixture.slug}/projects/${ABSENT_UUID}`)
      .expect(404);

    expect(foreign.body.error.code).toBe(nonexistent.body.error.code);
    expect(foreign.body.error.message).toBe(nonexistent.body.error.message);
  });

  it('does not leak the query, file path or stack in the response', async () => {
    const fixture = await orgFixture();
    const response = await fixture.agent
      .get(`/api/v1/organizations/${fixture.slug}/work-items/not-a-uuid`)
      .expect(404);

    const body = JSON.stringify(response.body);
    expect(body).not.toMatch(/prisma|findFirst|node_modules|Inconsistent|\.ts:|\.js:/i);
  });

  it('still returns 404 on a mutation with a malformed identifier', async () => {
    const fixture = await orgFixture();

    await fixture.agent
      .patch(`/api/v1/organizations/${fixture.slug}/work-items/not-a-uuid`)
      .set('x-csrf-token', fixture.csrf)
      .send({ title: 'Renamed' })
      .expect(404);

    await fixture.agent
      .delete(`/api/v1/organizations/${fixture.slug}/projects/not-a-uuid`)
      .set('x-csrf-token', fixture.csrf)
      .expect(404);
  });

  it('leaves an unknown organization slug on the existing 404 path', async () => {
    // The slug column is a varchar, so it never reaches the UUID parser —
    // this confirms the new translation did not change tenant behaviour.
    const fixture = await orgFixture();
    const response = await fixture.agent.get('/api/v1/organizations/no-such-org').expect(404);
    expect(response.body.error.code).toBe('ORGANIZATION_NOT_FOUND');
  });
});
