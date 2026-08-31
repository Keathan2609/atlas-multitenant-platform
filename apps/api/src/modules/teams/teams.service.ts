import { Injectable } from '@nestjs/common';
import { newId } from '@atlas/database';
import { slugify } from '@atlas/validation';
import type { TenantContext } from '../../common/http/express.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { AuditAction, AuditService, type AuditEvent } from '../../common/audit/audit.service.js';
import { ConflictError, ErrorCode, NotFoundError } from '../../common/errors/app-error.js';

export interface TeamInput {
  name: string;
  slug?: string;
  description?: string;
}

type RequestContext = Pick<AuditEvent, 'ipAddress' | 'userAgent'>;

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(tenant: TenantContext) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const teams = await db.team.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        createdAt: true,
        _count: { select: { members: true, projects: true } },
      },
      orderBy: { name: 'asc' },
    });

    return {
      data: teams.map((team) => ({
        id: team.id,
        name: team.name,
        slug: team.slug,
        description: team.description,
        createdAt: team.createdAt,
        memberCount: team._count.members,
        projectCount: team._count.projects,
      })),
    };
  }

  async get(tenant: TenantContext, teamId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const team = await db.team.findFirst({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        members: {
          select: {
            id: true,
            role: true,
            joinedAt: true,
            user: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
          },
          orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
        },
        projects: {
          select: { id: true, name: true, key: true, status: true },
          orderBy: { updatedAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!team) throw new NotFoundError(ErrorCode.TEAM_NOT_FOUND, 'That team could not be found.');
    return team;
  }

  async create(
    tenant: TenantContext,
    actorId: string,
    input: TeamInput,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const slug = await this.resolveSlug(tenant, input.slug ?? slugify(input.name), Boolean(input.slug));

    const team = await db.team.create({
      data: {
        id: newId(),
        name: input.name,
        slug,
        description: input.description ?? null,
      } as never,
      select: { id: true, name: true, slug: true, description: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: AuditAction.TEAM_CREATED,
      resourceType: 'team',
      resourceId: team.id,
      metadata: { name: team.name, slug: team.slug },
      ...requestContext,
    });

    return team;
  }

  async update(
    tenant: TenantContext,
    actorId: string,
    teamId: string,
    input: Partial<TeamInput>,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    await this.requireTeam(tenant, teamId);

    const team = await db.team.update({
      where: { id: teamId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description ?? null } : {}),
      },
      select: { id: true, name: true, slug: true, description: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: AuditAction.TEAM_UPDATED,
      resourceType: 'team',
      resourceId: teamId,
      metadata: { name: input.name },
      ...requestContext,
    });

    return team;
  }

  /**
   * Deletes a team, unassigning its projects first.
   *
   * Project.team is declared `onDelete: Restrict` in the schema, deliberately.
   * A composite foreign key's SET NULL nulls *every* column in the key, which
   * would blank the NOT NULL organizationId and detach the project from its
   * tenant — so Postgres would reject it. Restrict means the database refuses
   * the delete outright while any project still points at the team, and this
   * transaction does the unassignment explicitly.
   *
   * Both statements are one transaction: a half-done delete would leave
   * projects unassigned from a team that still exists, which is worse than
   * either outcome alone.
   */
  async remove(
    tenant: TenantContext,
    actorId: string,
    teamId: string,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const team = await this.requireTeam(tenant, teamId);

    await db.$transaction(async (tx) => {
      const unassigned = await tx.project.updateMany({
        where: { teamId },
        data: { teamId: null },
      });

      await tx.team.delete({ where: { id: teamId } });

      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          actorId,
          action: AuditAction.TEAM_DELETED,
          resourceType: 'team',
          resourceId: teamId,
          metadata: { name: team.name, projectsUnassigned: unassigned.count },
          ...requestContext,
        },
        tx,
      );
    });
  }

  /**
   * Adds an organization member to a team.
   *
   * The composite foreign key onto OrganizationMembership means the database
   * itself refuses a user who is not a member of this organization — the
   * check below exists to turn that into a clean 404 rather than a constraint
   * violation surfacing as a 500.
   */
  async addMember(
    tenant: TenantContext,
    teamId: string,
    userId: string,
    role: 'LEAD' | 'MEMBER',
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    await this.requireTeam(tenant, teamId);

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

    const existing = await db.teamMembership.findFirst({
      where: { teamId, userId },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictError(ErrorCode.ALREADY_A_MEMBER, 'They are already on this team.');
    }

    return db.teamMembership.create({
      data: { id: newId(), teamId, userId, role } as never,
      select: {
        id: true,
        role: true,
        user: { select: { id: true, displayName: true, email: true } },
      },
    });
  }

  async removeMember(tenant: TenantContext, teamId: string, userId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);
    await this.requireTeam(tenant, teamId);

    const result = await db.teamMembership.deleteMany({ where: { teamId, userId } });
    if (result.count === 0) {
      throw new NotFoundError(ErrorCode.MEMBER_NOT_FOUND, 'They are not on this team.');
    }
  }

  private async requireTeam(tenant: TenantContext, teamId: string) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const team = await db.team.findFirst({
      where: { id: teamId },
      select: { id: true, name: true },
    });
    if (!team) throw new NotFoundError(ErrorCode.TEAM_NOT_FOUND, 'That team could not be found.');
    return team;
  }

  private async resolveSlug(
    tenant: TenantContext,
    candidate: string,
    userSupplied: boolean,
  ): Promise<string> {
    const db = this.prisma.forTenant(tenant.organizationId);
    const base = candidate || 'team';

    const taken = await db.team.findFirst({ where: { slug: base }, select: { id: true } });
    if (!taken) return base;

    if (userSupplied) {
      throw new ConflictError(ErrorCode.SLUG_TAKEN, 'A team with that address already exists.', [
        { field: 'slug', message: 'This address is already in use.' },
      ]);
    }

    for (let suffix = 2; suffix < 25; suffix++) {
      const attempt = `${base}-${suffix}`.slice(0, 64);
      const exists = await db.team.findFirst({ where: { slug: attempt }, select: { id: true } });
      if (!exists) return attempt;
    }

    throw new ConflictError(
      ErrorCode.SLUG_TAKEN,
      'Could not derive an available address. Choose one explicitly.',
    );
  }
}
