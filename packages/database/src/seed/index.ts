import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import argon2 from 'argon2';

/**
 * The repository-root .env.
 *
 * Loaded here because this script is invoked directly by tsx, without the
 * Prisma CLI that would otherwise read prisma.config.ts and populate the
 * environment. Without it `pnpm db:seed` fails with "DATABASE_URL is not set"
 * on a clean checkout — which is the exact flow the README documents.
 *
 * The seed is a development-only script and dotenv is a devDependency of this
 * package, so a static import is correct here; the API loads it lazily instead
 * because its production image omits dev dependencies.
 *
 * dotenv does not overwrite variables that are already set, so
 * `DATABASE_URL=… pnpm db:seed` still wins.
 */
loadDotenv({ path: path.resolve(process.cwd(), '../../.env') });

import { createPrismaClient, type PrismaClient } from '../client.js';
import { newId } from '../id.js';
import {
  DEMO_PASSWORD,
  MERIDIAN_MEMBERS,
  MERIDIAN_PROJECTS,
  MERIDIAN_WORK_ITEMS,
  NORTHSTAR_MEMBERS,
  PROJECTS,
  TEAMS,
  USERS,
  WORKSPACES,
  WORK_ITEMS,
} from './data.js';

/**
 * Seeds a coherent development dataset.
 *
 * Idempotent by truncation: it clears the tenant tables first and rebuilds
 * them, so running it twice produces the same state rather than duplicates.
 * That matters because it is run repeatedly during development and in CI.
 *
 * Refuses to run against a database whose URL does not look local, because
 * "seed" here means "delete everything first".
 */

const TRUNCATE_ORDER = [
  'audit_logs',
  'work_items',
  'project_memberships',
  'projects',
  'team_memberships',
  'teams',
  'workspaces',
  'invitations',
  'api_keys',
  'organization_settings',
  'organization_memberships',
  'organizations',
  'sessions',
  'users',
];

function assertLocalDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is not set.');
  const isLocal = /@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url);
  if (!isLocal && process.env.ALLOW_REMOTE_SEED !== 'true') {
    throw new Error(
      'Refusing to seed a non-local database — this deletes every row first.\n' +
        'Set ALLOW_REMOTE_SEED=true only if you are certain.',
    );
  }
}

function daysFromNow(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/** Spreads createdAt over the past few weeks so lists are not one timestamp. */
function staggered(index: number, total: number): Date {
  const daysAgo = Math.round(((total - index) / total) * 45);
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(9 + (index % 8), (index * 7) % 60, 0, 0);
  return date;
}

async function main(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL);
  const prisma: PrismaClient = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  await prisma.$connect();

  const started = Date.now();
  process.stdout.write('Seeding ATLAS...\n');

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TRUNCATE_ORDER.map((t) => `"public"."${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );

  // One hash for every demo account. Hashing eight times with real Argon2
  // parameters costs a couple of seconds for no benefit — they share a password
  // by design, and it is printed at the end.
  const passwordHash = await argon2.hash(DEMO_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const userIds = new Map<string, string>();
  for (const [index, user] of USERS.entries()) {
    const id = newId();
    userIds.set(user.key, id);
    await prisma.user.create({
      data: {
        id,
        email: user.email,
        displayName: user.displayName,
        passwordHash,
        emailVerifiedAt: new Date(),
        createdAt: staggered(index, USERS.length),
        lastLoginAt: index < 4 ? daysFromNow(-(index + 1)) : null,
      },
    });
  }
  process.stdout.write(`  ${USERS.length} users\n`);

  const northstarId = await seedNorthstar(prisma, userIds);
  const meridianId = await seedMeridian(prisma, userIds);

  // Backdate updatedAt to match createdAt.
  //
  // Prisma's @updatedAt stamps the write time and ignores any value supplied
  // on create, so every seeded row ends up "updated" the moment the seed ran.
  // That makes "recently updated" lists identical and useless — which is
  // exactly what the overview screen is for. Raw SQL is the only way to set a
  // managed column, and it is worth it: without this the seed cannot exercise
  // ordering by recency at all.
  await prisma.$executeRawUnsafe('UPDATE "public"."projects" SET "updatedAt" = "createdAt"');
  await prisma.$executeRawUnsafe('UPDATE "public"."work_items" SET "updatedAt" = "createdAt"');
  await prisma.$executeRawUnsafe('UPDATE "public"."teams" SET "updatedAt" = "createdAt"');
  await prisma.$executeRawUnsafe('UPDATE "public"."organizations" SET "updatedAt" = "createdAt"');

  const counts = await prisma.$transaction([
    prisma.organization.count(),
    prisma.project.count(),
    prisma.workItem.count(),
    prisma.auditLog.count(),
  ]);

  process.stdout.write(
    `\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s — ` +
      `${counts[0]} organizations, ${counts[1]} projects, ${counts[2]} work items, ${counts[3]} audit entries.\n`,
  );
  process.stdout.write('\nDemo accounts (local development only):\n');
  process.stdout.write(`  password for all accounts: ${DEMO_PASSWORD}\n\n`);
  for (const member of NORTHSTAR_MEMBERS) {
    const user = USERS.find((u) => u.key === member.user);
    process.stdout.write(`  ${member.role.padEnd(6)}  ${user?.email}\n`);
  }
  process.stdout.write(
    `\n  Second tenant (proves isolation): ${USERS.find((u) => u.key === 'jonas')?.email}\n`,
  );
  process.stdout.write(`  Northstar: /app/northstar   Meridian: /app/meridian\n`);

  void northstarId;
  void meridianId;
  await prisma.$disconnect();
}

async function seedNorthstar(prisma: PrismaClient, userIds: Map<string, string>): Promise<string> {
  const organizationId = newId();
  const createdAt = daysFromNow(-60);

  await prisma.organization.create({
    data: { id: organizationId, name: 'Northstar Systems', slug: 'northstar', createdAt },
  });
  await prisma.organizationSettings.create({ data: { organizationId } });

  for (const [index, member] of NORTHSTAR_MEMBERS.entries()) {
    await prisma.organizationMembership.create({
      data: {
        id: newId(),
        organizationId,
        userId: userIds.get(member.user)!,
        role: member.role,
        joinedAt: staggered(index, NORTHSTAR_MEMBERS.length),
      },
    });
  }

  const workspaceIds = new Map<string, string>();
  for (const workspace of WORKSPACES) {
    const id = newId();
    workspaceIds.set(workspace.key, id);
    await prisma.workspace.create({
      data: {
        id,
        organizationId,
        name: workspace.name,
        slug: workspace.slug,
        description: workspace.description,
        isDefault: workspace.isDefault,
        createdAt,
      },
    });
  }

  const teamIds = new Map<string, string>();
  for (const team of TEAMS) {
    const id = newId();
    teamIds.set(team.key, id);
    await prisma.team.create({
      data: {
        id,
        organizationId,
        name: team.name,
        slug: team.slug,
        description: team.description,
        createdAt,
      },
    });
    for (const member of team.members) {
      await prisma.teamMembership.create({
        data: {
          id: newId(),
          organizationId,
          teamId: id,
          userId: userIds.get(member.user)!,
          role: member.role,
        },
      });
    }
  }

  const projectIds = new Map<string, string>();
  for (const [index, project] of PROJECTS.entries()) {
    const id = newId();
    projectIds.set(project.key, id);
    await prisma.project.create({
      data: {
        id,
        organizationId,
        workspaceId: workspaceIds.get(project.workspace)!,
        teamId: teamIds.get(project.team)!,
        name: project.name,
        key: project.projectKey,
        description: project.description,
        status: project.status,
        createdAt: staggered(index, PROJECTS.length),
        archivedAt: null,
      },
    });
  }

  // Work items are numbered per project, mirroring what the service does at
  // runtime — the seed must leave workItemCounter consistent with the rows it
  // wrote, or the first item created through the API would collide.
  const perProjectCounter = new Map<string, number>();
  for (const [index, item] of WORK_ITEMS.entries()) {
    const projectId = projectIds.get(item.project)!;
    const number = (perProjectCounter.get(item.project) ?? 0) + 1;
    perProjectCounter.set(item.project, number);

    const terminal = item.status === 'DONE' || item.status === 'CANCELLED';
    await prisma.workItem.create({
      data: {
        id: newId(),
        organizationId,
        projectId,
        number,
        title: item.title,
        description: item.description ?? null,
        type: item.type,
        status: item.status,
        priority: item.priority,
        assigneeId: item.assignee ? userIds.get(item.assignee)! : null,
        reporterId: userIds.get(item.reporter)!,
        dueDate: item.dueInDays === undefined ? null : daysFromNow(item.dueInDays),
        completedAt: terminal ? daysFromNow(-2) : null,
        createdAt: staggered(index, WORK_ITEMS.length),
      },
    });
  }

  for (const [key, count] of perProjectCounter) {
    await prisma.project.update({
      where: { id: projectIds.get(key)! },
      data: { workItemCounter: count },
    });
  }

  // Audit entries describing what the seed itself represents, so the audit
  // screen has real history rather than being empty on first look. Written
  // through the same shape AuditService produces.
  const auditEvents: Array<{
    action: string;
    resourceType: string;
    resourceId: string;
    actor: string;
    metadata: Record<string, string>;
  }> = [
    {
      action: 'organization.created',
      resourceType: 'organization',
      resourceId: organizationId,
      actor: 'dana',
      metadata: { name: 'Northstar Systems', slug: 'northstar' },
    },
    ...TEAMS.map((team) => ({
      action: 'team.created',
      resourceType: 'team',
      resourceId: teamIds.get(team.key)!,
      actor: 'dana',
      metadata: { name: team.name },
    })),
    ...PROJECTS.map((project) => ({
      action: 'project.created',
      resourceType: 'project',
      resourceId: projectIds.get(project.key)!,
      actor: 'marcus',
      metadata: { name: project.name, key: project.projectKey },
    })),
    {
      action: 'member.role_changed',
      resourceType: 'membership',
      resourceId: organizationId,
      actor: 'dana',
      metadata: { targetUserId: userIds.get('marcus')!, from: 'MEMBER', to: 'ADMIN' },
    },
    {
      action: 'organization.settings_updated',
      resourceType: 'organization_settings',
      resourceId: organizationId,
      actor: 'dana',
      metadata: { requireTwoFactor: 'false' },
    },
    {
      action: 'project.archived',
      resourceType: 'project',
      resourceId: projectIds.get('legacy-reporting')!,
      actor: 'marcus',
      metadata: { name: 'Legacy Reporting Decommission' },
    },
  ];

  for (const [index, event] of auditEvents.entries()) {
    await prisma.auditLog.create({
      data: {
        id: newId(),
        organizationId,
        actorId: userIds.get(event.actor)!,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        metadata: event.metadata,
        ipAddress: '198.51.100.24',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        createdAt: staggered(index, auditEvents.length),
      },
    });
  }

  process.stdout.write(
    `  Northstar Systems: ${NORTHSTAR_MEMBERS.length} members, ${TEAMS.length} teams, ` +
      `${PROJECTS.length} projects, ${WORK_ITEMS.length} work items\n`,
  );
  return organizationId;
}

async function seedMeridian(prisma: PrismaClient, userIds: Map<string, string>): Promise<string> {
  const organizationId = newId();

  await prisma.organization.create({
    data: {
      id: organizationId,
      name: 'Meridian Labs',
      slug: 'meridian',
      createdAt: daysFromNow(-30),
    },
  });
  await prisma.organizationSettings.create({ data: { organizationId } });

  for (const member of MERIDIAN_MEMBERS) {
    await prisma.organizationMembership.create({
      data: { id: newId(), organizationId, userId: userIds.get(member.user)!, role: member.role },
    });
  }

  const workspaceId = newId();
  await prisma.workspace.create({
    data: { id: workspaceId, organizationId, name: 'General', slug: 'general', isDefault: true },
  });

  const projectIds = new Map<string, string>();
  for (const project of MERIDIAN_PROJECTS) {
    const id = newId();
    projectIds.set(project.key, id);
    await prisma.project.create({
      data: {
        id,
        organizationId,
        workspaceId,
        name: project.name,
        key: project.projectKey,
        description: project.description,
        status: project.status,
      },
    });
  }

  const counters = new Map<string, number>();
  for (const item of MERIDIAN_WORK_ITEMS) {
    const number = (counters.get(item.project) ?? 0) + 1;
    counters.set(item.project, number);
    await prisma.workItem.create({
      data: {
        id: newId(),
        organizationId,
        projectId: projectIds.get(item.project)!,
        number,
        title: item.title,
        type: item.type,
        status: item.status,
        priority: item.priority,
        assigneeId: item.assignee ? userIds.get(item.assignee)! : null,
        reporterId: userIds.get(item.reporter)!,
      },
    });
  }
  for (const [key, count] of counters) {
    await prisma.project.update({
      where: { id: projectIds.get(key)! },
      data: { workItemCounter: count },
    });
  }

  await prisma.auditLog.create({
    data: {
      id: newId(),
      organizationId,
      actorId: userIds.get('jonas')!,
      action: 'organization.created',
      resourceType: 'organization',
      resourceId: organizationId,
      metadata: { name: 'Meridian Labs', slug: 'meridian' },
    },
  });

  process.stdout.write(
    `  Meridian Labs: ${MERIDIAN_MEMBERS.length} members, ${MERIDIAN_PROJECTS.length} project\n`,
  );
  return organizationId;
}

main().catch((error: unknown) => {
  process.stderr.write(`Seed failed: ${String(error)}\n`);
  process.exit(1);
});
