import { Injectable } from '@nestjs/common';
import { newId } from '@atlas/database';
import type { CreateProjectInput, ListProjectsInput, UpdateProjectInput } from '@atlas/validation';
import type { TenantContext } from '../../common/http/express.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { AuditAction, AuditService, type AuditEvent } from '../../common/audit/audit.service.js';
import { ConflictError, ErrorCode, NotFoundError } from '../../common/errors/app-error.js';

type RequestContext = Pick<AuditEvent, 'ipAddress' | 'userAgent'>;

/** Reserved because they collide with route segments under /projects. */
const RESERVED_PROJECT_KEYS = new Set(['NEW', 'ALL', 'API']);

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Paginated, filterable project list.
   *
   * Offset pagination rather than cursor: this list is presented as numbered
   * pages with a total count, users jump around it, and it is small enough
   * per tenant that deep-page cost never becomes the problem it is for audit
   * logs. The reasoning is recorded in docs/api.md.
   */
  async list(tenant: TenantContext, query: ListProjectsInput) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { key: { contains: query.search.toUpperCase() } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      db.project.count({ where }),
      db.project.findMany({
        where,
        select: {
          id: true,
          name: true,
          key: true,
          description: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          archivedAt: true,
          workspace: { select: { id: true, name: true, slug: true } },
          team: { select: { id: true, name: true, slug: true } },
          _count: { select: { workItems: true, members: true } },
        },
        orderBy: { [query.sortBy]: query.sortDirection },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        key: row.key,
        description: row.description,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        archivedAt: row.archivedAt,
        workspace: row.workspace,
        team: row.team,
        workItemCount: row._count.workItems,
        memberCount: row._count.members,
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async get(tenant: TenantContext, projectId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const project = await db.project.findFirst({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        key: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
        workspace: { select: { id: true, name: true, slug: true } },
        team: { select: { id: true, name: true, slug: true } },
        members: {
          select: {
            id: true,
            role: true,
            user: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
          },
        },
        _count: { select: { workItems: true } },
      },
    });

    if (!project) {
      throw new NotFoundError(ErrorCode.PROJECT_NOT_FOUND, 'That project could not be found.');
    }
    return project;
  }

  /**
   * Creates a project.
   *
   * The workspace and team are looked up through the *scoped* client before
   * use. That is not redundant with the composite foreign keys: the FKs would
   * reject a cross-tenant reference with a constraint violation, which surfaces
   * as a 500. Checking first turns the same condition into a clean 404 that
   * tells the caller nothing about whether the id exists elsewhere.
   */
  async create(
    tenant: TenantContext,
    actorId: string,
    input: CreateProjectInput,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const workspace = await db.workspace.findFirst({
      where: { id: input.workspaceId },
      select: { id: true },
    });
    if (!workspace) {
      throw new NotFoundError(ErrorCode.WORKSPACE_NOT_FOUND, 'That workspace could not be found.');
    }

    if (input.teamId) {
      const team = await db.team.findFirst({ where: { id: input.teamId }, select: { id: true } });
      if (!team) {
        throw new NotFoundError(ErrorCode.TEAM_NOT_FOUND, 'That team could not be found.');
      }
    }

    const key = await this.resolveKey(tenant, input.key ?? deriveKey(input.name), Boolean(input.key));

    const project = await db.project.create({
      data: {
        id: newId(),
        workspaceId: input.workspaceId,
        teamId: input.teamId ?? null,
        name: input.name,
        key,
        description: input.description ?? null,
        status: input.status,
      } as never,
      select: { id: true, name: true, key: true, status: true, description: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: AuditAction.PROJECT_CREATED,
      resourceType: 'project',
      resourceId: project.id,
      metadata: { name: project.name, key: project.key, workspaceId: input.workspaceId },
      ...requestContext,
    });

    return project;
  }

  async update(
    tenant: TenantContext,
    actorId: string,
    projectId: string,
    input: UpdateProjectInput,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    await this.requireProject(tenant, projectId);

    if (input.teamId) {
      const team = await db.team.findFirst({ where: { id: input.teamId }, select: { id: true } });
      if (!team) throw new NotFoundError(ErrorCode.TEAM_NOT_FOUND, 'That team could not be found.');
    }

    // Setting status to ARCHIVED stamps archivedAt, and moving away from it
    // clears the stamp — so the two can never disagree about whether the
    // project is archived.
    const archivedAt =
      input.status === 'ARCHIVED' ? new Date() : input.status !== undefined ? null : undefined;

    const project = await db.project.update({
      where: { id: projectId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.teamId !== undefined ? { teamId: input.teamId ?? null } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(archivedAt !== undefined ? { archivedAt } : {}),
      },
      select: { id: true, name: true, key: true, status: true, archivedAt: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action:
        input.status === 'ARCHIVED' ? AuditAction.PROJECT_ARCHIVED : AuditAction.PROJECT_UPDATED,
      resourceType: 'project',
      resourceId: projectId,
      metadata: { name: input.name, status: input.status },
      ...requestContext,
    });

    return project;
  }

  /**
   * Deletes a project and everything under it.
   *
   * Cascades to work items and project memberships via the composite FKs.
   * Requires projects.delete, which only ADMIN and OWNER hold — a MEMBER can
   * create and update projects but cannot destroy one along with its history.
   */
  async remove(
    tenant: TenantContext,
    actorId: string,
    projectId: string,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const project = await this.requireProject(tenant, projectId);

    await db.$transaction(async (tx) => {
      await tx.project.delete({ where: { id: projectId } });
      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          actorId,
          action: AuditAction.PROJECT_DELETED,
          resourceType: 'project',
          resourceId: projectId,
          metadata: { name: project.name, key: project.key },
          ...requestContext,
        },
        tx,
      );
    });
  }

  private async requireProject(tenant: TenantContext, projectId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const project = await db.project.findFirst({
      where: { id: projectId },
      select: { id: true, name: true, key: true },
    });
    if (!project) {
      throw new NotFoundError(ErrorCode.PROJECT_NOT_FOUND, 'That project could not be found.');
    }
    return project;
  }

  /**
   * Project keys are unique per tenant and appear in every work-item
   * reference (PORTAL-42), which is why they cannot be changed afterwards.
   */
  private async resolveKey(
    tenant: TenantContext,
    candidate: string,
    userSupplied: boolean,
  ): Promise<string> {
    const db = this.prisma.forTenant(tenant.organizationId);
    const base = (candidate || 'PROJ').toUpperCase().slice(0, 10);

    if (RESERVED_PROJECT_KEYS.has(base) && userSupplied) {
      throw new ConflictError(ErrorCode.PROJECT_KEY_TAKEN, 'That project key is reserved.', [
        { field: 'key', message: 'That key is reserved.' },
      ]);
    }

    const taken = await db.project.findFirst({ where: { key: base }, select: { id: true } });
    if (!taken && !RESERVED_PROJECT_KEYS.has(base)) return base;

    if (userSupplied) {
      throw new ConflictError(ErrorCode.PROJECT_KEY_TAKEN, 'That project key is already in use.', [
        { field: 'key', message: 'This key is already in use.' },
      ]);
    }

    for (let suffix = 2; suffix < 100; suffix++) {
      const attempt = `${base.slice(0, 10 - String(suffix).length)}${suffix}`;
      const exists = await db.project.findFirst({ where: { key: attempt }, select: { id: true } });
      if (!exists) return attempt;
    }

    throw new ConflictError(
      ErrorCode.PROJECT_KEY_TAKEN,
      'Could not derive an available project key. Choose one explicitly.',
    );
  }
}

/**
 * Derives a key from a project name: initials for multi-word names, a prefix
 * for single-word ones. "Identity Service Migration" -> ISM, "Portal" -> PORT.
 */
function deriveKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 'PROJ';
  if (words.length === 1) return (words[0] ?? 'PROJ').slice(0, 4);

  const initials = words
    .map((word) => word[0] ?? '')
    .join('')
    .slice(0, 6);

  // A key must start with a letter; a name like "3M Rollout" would otherwise
  // yield "3R", which the validation schema rejects.
  return /^[A-Z]/.test(initials) ? initials : `P${initials}`.slice(0, 10);
}
