import { Injectable } from '@nestjs/common';
import { newId } from '@atlas/database';
import { slugify } from '@atlas/validation';
import type { TenantContext } from '../../common/http/express.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { AuditAction, AuditService, type AuditEvent } from '../../common/audit/audit.service.js';
import { ConflictError, ErrorCode, NotFoundError } from '../../common/errors/app-error.js';

export interface WorkspaceInput {
  name: string;
  slug?: string;
  description?: string;
}

type RequestContext = Pick<AuditEvent, 'ipAddress' | 'userAgent'>;

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const workspaces = await db.workspace.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isDefault: true,
        createdAt: true,
        _count: { select: { projects: true } },
      },
      // Default first, then alphabetical: the default is where new projects
      // land, so it is the one people look for.
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    return {
      data: workspaces.map((workspace) => ({
        ...workspace,
        projectCount: workspace._count.projects,
        _count: undefined,
      })),
    };
  }

  async get(tenant: TenantContext, workspaceId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!workspace) {
      throw new NotFoundError(ErrorCode.WORKSPACE_NOT_FOUND, 'That workspace could not be found.');
    }
    return workspace;
  }

  async create(
    tenant: TenantContext,
    actorId: string,
    input: WorkspaceInput,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const slug = await this.resolveSlug(tenant, input.slug ?? slugify(input.name), Boolean(input.slug));

    const workspace = await db.workspace.create({
      data: {
        id: newId(),
        name: input.name,
        slug,
        description: input.description ?? null,
        isDefault: false,
      } as never,
      select: { id: true, name: true, slug: true, description: true, isDefault: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: AuditAction.WORKSPACE_CREATED,
      resourceType: 'workspace',
      resourceId: workspace.id,
      metadata: { name: workspace.name, slug: workspace.slug },
      ...requestContext,
    });

    return workspace;
  }

  async update(
    tenant: TenantContext,
    actorId: string,
    workspaceId: string,
    input: Partial<WorkspaceInput>,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    await this.get(tenant, workspaceId);

    const workspace = await db.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      },
      select: { id: true, name: true, slug: true, description: true, isDefault: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: AuditAction.WORKSPACE_UPDATED,
      resourceType: 'workspace',
      resourceId: workspaceId,
      metadata: { name: input.name },
      ...requestContext,
    });

    return workspace;
  }

  /**
   * Deletes a workspace.
   *
   * Two refusals, both because the alternative destroys work silently:
   *
   *  - The default workspace cannot be deleted. It is where projects land
   *    when none is chosen, so removing it would leave the organization
   *    unable to create a project without first creating a workspace.
   *  - A workspace holding projects cannot be deleted. The schema cascades
   *    workspace -> projects -> work items, so a single click would erase an
   *    arbitrary amount of work with no warning. The caller must move or
   *    delete the projects first, which forces the decision to be explicit.
   */
  async remove(
    tenant: TenantContext,
    actorId: string,
    workspaceId: string,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId },
      select: { id: true, name: true, isDefault: true, _count: { select: { projects: true } } },
    });

    if (!workspace) {
      throw new NotFoundError(ErrorCode.WORKSPACE_NOT_FOUND, 'That workspace could not be found.');
    }

    if (workspace.isDefault) {
      throw new ConflictError(
        ErrorCode.CANNOT_DELETE_DEFAULT_WORKSPACE,
        'The default workspace cannot be deleted.',
      );
    }

    if (workspace._count.projects > 0) {
      throw new ConflictError(
        ErrorCode.WORKSPACE_NOT_EMPTY,
        `This workspace still holds ${workspace._count.projects} project(s). Move or delete them first.`,
      );
    }

    await db.$transaction(async (tx) => {
      await tx.workspace.delete({ where: { id: workspaceId } });
      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          actorId,
          action: AuditAction.WORKSPACE_DELETED,
          resourceType: 'workspace',
          resourceId: workspaceId,
          metadata: { name: workspace.name },
          ...requestContext,
        },
        tx,
      );
    });
  }

  /**
   * Slug uniqueness is per tenant, so two organizations may both have
   * "platform". The scoped client makes the lookup tenant-local automatically.
   */
  private async resolveSlug(
    tenant: TenantContext,
    candidate: string,
    userSupplied: boolean,
  ): Promise<string> {
    const db = this.prisma.forTenant(tenant.organizationId);
    const base = candidate || 'workspace';

    const taken = await db.workspace.findFirst({ where: { slug: base }, select: { id: true } });
    if (!taken) return base;

    if (userSupplied) {
      throw new ConflictError(ErrorCode.SLUG_TAKEN, 'A workspace with that address already exists.', [
        { field: 'slug', message: 'This address is already in use.' },
      ]);
    }

    for (let suffix = 2; suffix < 25; suffix++) {
      const attempt = `${base}-${suffix}`.slice(0, 64);
      const exists = await db.workspace.findFirst({ where: { slug: attempt }, select: { id: true } });
      if (!exists) return attempt;
    }

    throw new ConflictError(
      ErrorCode.SLUG_TAKEN,
      'Could not derive an available address. Choose one explicitly.',
    );
  }
}
