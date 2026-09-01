import { Injectable } from '@nestjs/common';
import { newId } from '@atlas/database';
import type {
  CreateWorkItemInput,
  ListWorkItemsInput,
  UpdateWorkItemInput,
} from '@atlas/validation';
import type { TenantContext } from '../../common/http/express.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { ErrorCode, NotFoundError } from '../../common/errors/app-error.js';

/** Statuses that mean the item is finished, for stamping completedAt. */
const TERMINAL_STATUSES = new Set(['DONE', 'CANCELLED']);

@Injectable()
export class WorkItemsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a work item with the next number in its project.
   *
   * The number is allocated by incrementing Project.workItemCounter inside the
   * same transaction as the insert. `increment` compiles to `SET counter =
   * counter + 1` and the UPDATE takes a row lock, so two concurrent creates
   * serialise on that row and each gets a distinct number — no gaps, no
   * duplicates, and no read-modify-write race in application code.
   *
   * A Postgres sequence would be simpler but is global, so PORTAL-1 and
   * BILLING-1 could not both exist. Per-project sequences would mean DDL on
   * every project creation. The counter column is the cheapest thing that
   * gives per-project numbering people can actually cite.
   */
  async create(
    tenant: TenantContext,
    projectId: string,
    reporterId: string,
    input: CreateWorkItemInput,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    await this.requireProject(tenant, projectId);

    if (input.assigneeId) await this.requireOrgMember(tenant, input.assigneeId);

    return db.$transaction(async (tx) => {
      const project = await tx.project.update({
        where: { id: projectId },
        data: { workItemCounter: { increment: 1 } },
        select: { workItemCounter: true, key: true },
      });

      const item = await tx.workItem.create({
        data: {
          id: newId(),
          projectId,
          number: project.workItemCounter,
          title: input.title,
          description: input.description ?? null,
          type: input.type,
          status: input.status,
          priority: input.priority,
          assigneeId: input.assigneeId ?? null,
          reporterId,
          dueDate: input.dueDate ?? null,
          completedAt: TERMINAL_STATUSES.has(input.status) ? new Date() : null,
        } as never,
        select: {
          id: true,
          number: true,
          title: true,
          type: true,
          status: true,
          priority: true,
          dueDate: true,
          createdAt: true,
        },
      });

      return { ...item, reference: `${project.key}-${item.number}` };
    });
  }

  /**
   * Org-wide or per-project work item list.
   *
   * `assigneeId` accepts the literals `me` and `unassigned`, resolved
   * server-side, so the web app can build a "my work" link without knowing
   * the caller's own id.
   */
  async list(tenant: TenantContext, viewerId: string, query: ListWorkItemsInput) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const assigneeFilter =
      query.assigneeId === 'me'
        ? { assigneeId: viewerId }
        : query.assigneeId === 'unassigned'
          ? { assigneeId: null }
          : query.assigneeId
            ? { assigneeId: query.assigneeId }
            : {};

    const where = {
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status
        ? { status: Array.isArray(query.status) ? { in: query.status } : query.status }
        : {}),
      ...(query.priority
        ? { priority: Array.isArray(query.priority) ? { in: query.priority } : query.priority }
        : {}),
      ...assigneeFilter,
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' as const } } : {}),
    };

    const [total, rows] = await Promise.all([
      db.workItem.count({ where }),
      db.workItem.findMany({
        where,
        select: {
          id: true,
          number: true,
          title: true,
          type: true,
          status: true,
          priority: true,
          dueDate: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
          project: { select: { id: true, key: true, name: true } },
          assignee: { select: { id: true, displayName: true, avatarUrl: true } },
          reporter: { select: { id: true, displayName: true } },
        },
        orderBy: { [query.sortBy]: query.sortDirection },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      data: rows.map((row) => ({ ...row, reference: `${row.project.key}-${row.number}` })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  async get(tenant: TenantContext, workItemId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const item = await db.workItem.findFirst({
      where: { id: workItemId },
      select: {
        id: true,
        number: true,
        title: true,
        description: true,
        type: true,
        status: true,
        priority: true,
        dueDate: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        project: { select: { id: true, key: true, name: true } },
        assignee: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
        reporter: { select: { id: true, displayName: true, email: true } },
      },
    });

    if (!item) {
      throw new NotFoundError(ErrorCode.WORK_ITEM_NOT_FOUND, 'That work item could not be found.');
    }
    return { ...item, reference: `${item.project.key}-${item.number}` };
  }

  async update(tenant: TenantContext, workItemId: string, input: UpdateWorkItemInput) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const existing = await db.workItem.findFirst({
      where: { id: workItemId },
      select: { id: true, status: true },
    });
    if (!existing) {
      throw new NotFoundError(ErrorCode.WORK_ITEM_NOT_FOUND, 'That work item could not be found.');
    }

    if (input.assigneeId) await this.requireOrgMember(tenant, input.assigneeId);

    // completedAt tracks status so the two cannot disagree: entering a
    // terminal status stamps it, leaving one clears it, and an update that
    // does not touch status leaves it alone.
    const completedAt =
      input.status === undefined
        ? undefined
        : TERMINAL_STATUSES.has(input.status)
          ? TERMINAL_STATUSES.has(existing.status)
            ? undefined
            : new Date()
          : null;

    const item = await db.workItem.update({
      where: { id: workItemId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId ?? null } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate ?? null } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
      },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        completedAt: true,
        project: { select: { key: true } },
      },
    });

    return { ...item, reference: `${item.project.key}-${item.number}` };
  }

  async remove(tenant: TenantContext, workItemId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const result = await db.workItem.deleteMany({ where: { id: workItemId } });
    if (result.count === 0) {
      throw new NotFoundError(ErrorCode.WORK_ITEM_NOT_FOUND, 'That work item could not be found.');
    }
  }

  private async requireProject(tenant: TenantContext, projectId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const project = await db.project.findFirst({
      where: { id: projectId },
      select: { id: true, key: true },
    });
    if (!project) {
      throw new NotFoundError(ErrorCode.PROJECT_NOT_FOUND, 'That project could not be found.');
    }
    return project;
  }

  /**
   * An assignee must belong to this organization.
   *
   * WorkItem.assigneeId references User directly rather than
   * OrganizationMembership — a person keeps their assignment history after
   * leaving — so no foreign key enforces this. It has to be checked here, and
   * without it any user id in the system could be assigned work in any tenant,
   * which leaks the existence of accounts across the boundary.
   */
  private async requireOrgMember(tenant: TenantContext, userId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const membership = await db.organizationMembership.findFirst({
      where: { userId },
      select: { id: true },
    });
    if (!membership) {
      throw new NotFoundError(
        ErrorCode.MEMBER_NOT_FOUND,
        'That person is not a member of this organization.',
      );
    }
  }
}
