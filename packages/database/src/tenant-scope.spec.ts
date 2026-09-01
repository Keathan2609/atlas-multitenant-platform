import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, forOrganization, type PrismaClient } from './index.js';
import { newId } from './id.js';

/**
 * Tenant-scope extension, exercised against a real database.
 *
 * These assert the behaviour the whole isolation strategy rests on. They are
 * deliberately not mocked: a mocked Prisma would happily "prove" scoping the
 * database never applied.
 *
 * The transaction cases exist because of a finding in the Phase 4/5 security
 * review. The member mutations originally ran on `unscoped.$transaction`,
 * which silently discards layer 2 for the duration of the transaction — the
 * two operations that most need it. These tests pin the property that made the
 * fix possible: the extension survives into `$transaction`.
 */

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let prisma: PrismaClient;
let orgA: string;
let orgB: string;
let userB: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl });
  await prisma.$connect();

  orgA = newId();
  orgB = newId();
  userB = newId();

  await prisma.organization.createMany({
    data: [
      { id: orgA, name: 'Scope A', slug: `scope-a-${orgA.slice(0, 8)}` },
      { id: orgB, name: 'Scope B', slug: `scope-b-${orgB.slice(0, 8)}` },
    ],
  });
  await prisma.user.create({
    data: { id: userB, email: `scope-${userB.slice(0, 8)}@example.test`, displayName: 'B' },
  });
  await prisma.organizationMembership.create({
    data: { id: newId(), organizationId: orgB, userId: userB, role: 'OWNER' },
  });
  await prisma.workspace.create({
    data: { id: newId(), organizationId: orgB, name: 'B WS', slug: 'b-ws', isDefault: true },
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await prisma.user.deleteMany({ where: { id: userB } });
  await prisma.$disconnect();
});

describe('forOrganization', () => {
  it('returns null for a cross-tenant findUnique by bare id', async () => {
    // The classic IDOR. findUnique accepts a bare id, and without the
    // extension this returns another tenant's row.
    const workspace = await prisma.workspace.findFirstOrThrow({ where: { organizationId: orgB } });
    const asA = forOrganization(prisma, orgA);

    expect(await asA.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
  });

  it('scopes findMany', async () => {
    const asA = forOrganization(prisma, orgA);
    expect(await asA.workspace.findMany()).toHaveLength(0);
  });

  it('affects zero rows on a cross-tenant deleteMany', async () => {
    const asA = forOrganization(prisma, orgA);
    const result = await asA.organizationMembership.deleteMany({ where: { userId: userB } });

    expect(result.count).toBe(0);
    expect(await prisma.organizationMembership.count({ where: { organizationId: orgB } })).toBe(1);
  });

  it('throws on a contradictory explicit organizationId', async () => {
    // Silently rewriting it would hide either a bug or an escape attempt.
    const asA = forOrganization(prisma, orgA);
    await expect(asA.workspace.findMany({ where: { organizationId: orgB } })).rejects.toThrow(
      /Tenant scope violation/,
    );
  });

  it('leaves non-tenant models untouched', async () => {
    const asA = forOrganization(prisma, orgA);
    expect(await asA.user.findUnique({ where: { id: userB } })).not.toBeNull();
  });
});

describe('forOrganization inside $transaction', () => {
  it('keeps the tenant predicate on a query that omits it', async () => {
    // The property the members-service fix depends on. A forgetful query
    // inside the transaction must still be scoped.
    const asA = forOrganization(prisma, orgA);

    const leaked = await asA.$transaction(async (tx) =>
      tx.organizationMembership.findFirst({ where: { userId: userB } }),
    );

    expect(leaked).toBeNull();
  });

  it('is the difference between the scoped and unscoped client', async () => {
    // Control: the identical query on the unscoped client *does* cross the
    // boundary. This is what `unscoped.$transaction` was giving up.
    const leaked = await prisma.$transaction(async (tx) =>
      tx.organizationMembership.findFirst({ where: { userId: userB } }),
    );

    expect(leaked).not.toBeNull();
    expect(leaked?.organizationId).toBe(orgB);
  });

  it('stamps the tenant on a create inside a transaction', async () => {
    const asA = forOrganization(prisma, orgA);

    const created = await asA.$transaction(async (tx) =>
      tx.workspace.create({
        data: { id: newId(), name: 'A WS', slug: `a-ws-${Date.now()}`, isDefault: false } as never,
      }),
    );

    expect(created.organizationId).toBe(orgA);
    await prisma.workspace.delete({ where: { id: created.id } });
  });

  it('rolls the whole transaction back on a thrown error', async () => {
    // Underpins the audit guarantee: a refused mutation must leave no audit
    // entry behind.
    const asA = forOrganization(prisma, orgA);
    const workspaceId = newId();

    await expect(
      asA.$transaction(async (tx) => {
        await tx.workspace.create({
          data: {
            id: workspaceId,
            name: 'Doomed',
            slug: `doomed-${Date.now()}`,
            isDefault: false,
          } as never,
        });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(await prisma.workspace.findUnique({ where: { id: workspaceId } })).toBeNull();
  });
});
