import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@atlas/database';
import type { Logger } from '@atlas/observability';
import { slugify, RESERVED_SLUGS } from '@atlas/validation';
import type { OrganizationRole } from '@atlas/types';
import type { TenantContext } from '../../common/http/express.js';
import { LOGGER_TOKEN } from '../../common/logging/logger.provider.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { AuditAction, AuditService, type AuditEvent } from '../../common/audit/audit.service.js';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/app-error.js';

export interface CreateOrganizationCommand {
  name: string;
  slug?: string;
  ownerId: string;
  requestContext: Pick<AuditEvent, 'ipAddress' | 'userAgent'>;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  memberCount: number;
  joinedAt: Date;
}

/** Attempts to find a free slug before giving up and asking the user. */
const MAX_SLUG_ATTEMPTS = 25;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {}

  /**
   * Creates an organization and everything it needs to be usable.
   *
   * Five writes, one transaction:
   *   1. the organization
   *   2. the creator's OWNER membership
   *   3. default settings
   *   4. a default workspace, so projects have somewhere to go on day one
   *   5. the audit entry
   *
   * All or nothing. A partial failure here is uniquely bad: an organization
   * with no owner membership is invisible to its creator and unreachable by
   * anyone — nobody can be added to it, because adding members requires a
   * member with permission. It would need manual database surgery to fix.
   *
   * This is one of the few paths that legitimately uses the *unscoped* client:
   * the tenant does not exist yet, so there is no tenant to scope to. Every
   * write below sets organizationId explicitly from the id generated here.
   */
  async create(command: CreateOrganizationCommand) {
    const slug = await this.resolveSlug(command.slug ?? slugify(command.name), Boolean(command.slug));

    const organizationId = newId();
    const now = new Date();

    const organization = await this.prisma.unscoped.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: { id: organizationId, name: command.name, slug },
        select: { id: true, name: true, slug: true, createdAt: true },
      });

      await tx.organizationMembership.create({
        data: {
          id: newId(),
          organizationId,
          userId: command.ownerId,
          role: 'OWNER',
          joinedAt: now,
        },
      });

      await tx.organizationSettings.create({
        data: { organizationId },
      });

      await tx.workspace.create({
        data: {
          id: newId(),
          organizationId,
          name: 'General',
          slug: 'general',
          description: 'Default workspace.',
          isDefault: true,
        },
      });

      // Inside the transaction: an organization that exists with no record of
      // who created it is a gap in the trail that can never be filled in.
      await this.audit.record(
        {
          organizationId,
          actorId: command.ownerId,
          action: AuditAction.ORGANIZATION_CREATED,
          resourceType: 'organization',
          resourceId: organizationId,
          metadata: { name: command.name, slug },
          ...command.requestContext,
        },
        tx,
      );

      return created;
    });

    this.logger.info(
      { event: 'organization.created', organizationId, slug, ownerId: command.ownerId },
      'Organization created',
    );

    return { ...organization, role: 'OWNER' as const };
  }

  /**
   * Organizations the user belongs to, for the switcher.
   *
   * Driven entirely by membership rows, so it is inherently scoped: a user
   * cannot see an organization they are not in, and there is no filter here
   * that could be forgotten.
   */
  async listForUser(userId: string): Promise<OrganizationSummary[]> {
    const memberships = await this.prisma.unscoped.organizationMembership.findMany({
      where: { userId, organization: { deletedAt: null } },
      select: {
        role: true,
        joinedAt: true,
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            _count: { select: { memberships: true } },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    return memberships.map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role as OrganizationRole,
      memberCount: membership.organization._count.memberships,
      joinedAt: membership.joinedAt,
    }));
  }

  /** Detail for the current tenant. Reads through the scoped client. */
  async get(tenant: TenantContext) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const organization = await db.organization.findFirst({
      where: { id: tenant.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { memberships: true, projects: true, teams: true } },
      },
    });

    if (!organization) {
      throw new NotFoundError(ErrorCode.ORGANIZATION_NOT_FOUND, 'Organization not found.');
    }

    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
      role: tenant.role,
      counts: {
        members: organization._count.memberships,
        projects: organization._count.projects,
        teams: organization._count.teams,
      },
    };
  }

  async update(tenant: TenantContext, actorId: string, input: { name?: string }, requestContext: Pick<AuditEvent, 'ipAddress' | 'userAgent'>) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const updated = await db.organization.update({
      where: { id: tenant.organizationId },
      data: { ...(input.name !== undefined ? { name: input.name } : {}) },
      select: { id: true, name: true, slug: true, updatedAt: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: AuditAction.ORGANIZATION_UPDATED,
      resourceType: 'organization',
      resourceId: tenant.organizationId,
      metadata: { name: input.name },
      ...requestContext,
    });

    return updated;
  }

  /**
   * Soft-deletes the organization.
   *
   * Two guards beyond the permission check:
   *
   *  - The caller must retype the slug. Validated server-side against the real
   *    value, so a scripted request has to demonstrate the same intent a human
   *    would rather than just possessing the right role.
   *  - Only an OWNER reaches here, enforced by ORGANIZATION_DELETE being an
   *    owner-only permission in the RBAC matrix.
   *
   * Soft, not hard: deletion cascades across every tenant table, so it is
   * staged. The row is marked here and purged by a background job, which
   * leaves a window to undo an accident. TenantGuard filters on
   * `deletedAt: null`, so access stops immediately regardless.
   */
  async softDelete(
    tenant: TenantContext,
    actorId: string,
    confirmSlug: string,
    requestContext: Pick<AuditEvent, 'ipAddress' | 'userAgent'>,
  ) {
    if (confirmSlug !== tenant.slug) {
      throw new ConflictError(
        ErrorCode.CONFIRMATION_MISMATCH,
        'The confirmation text does not match the organization slug.',
        [{ field: 'confirmSlug', message: `Type "${tenant.slug}" to confirm.` }],
      );
    }

    if (tenant.role !== 'OWNER') {
      // Defence in depth. PermissionsGuard already rejected non-owners; this
      // makes the invariant local to the operation that depends on it, so a
      // future caller that forgets the decorator still cannot delete a tenant.
      throw new ForbiddenError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        'Only an owner can delete an organization.',
      );
    }

    await this.prisma.unscoped.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: tenant.organizationId },
        data: { deletedAt: new Date() },
      });

      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          actorId,
          action: AuditAction.ORGANIZATION_DELETED,
          resourceType: 'organization',
          resourceId: tenant.organizationId,
          metadata: { slug: tenant.slug },
          ...requestContext,
        },
        tx,
      );
    });

    this.logger.warn(
      { event: 'organization.deleted', organizationId: tenant.organizationId, actorId },
      'Organization soft-deleted',
    );
  }

  /**
   * Finds a free slug.
   *
   * When the user supplied one explicitly, a collision is an error they need
   * to see — silently handing them `acme-2` when they asked for `acme` would
   * be surprising. When we derived it from the name, appending a suffix is the
   * helpful behaviour.
   *
   * The loop is bounded and the unique index remains the real guarantee; this
   * only avoids the common case reaching the database as an error.
   */
  private async resolveSlug(candidate: string, userSupplied: boolean): Promise<string> {
    const base = candidate || 'organization';

    if (RESERVED_SLUGS.has(base)) {
      if (userSupplied) {
        throw new ConflictError(ErrorCode.SLUG_TAKEN, 'That organization address is reserved.', [
          { field: 'slug', message: 'That name is reserved.' },
        ]);
      }
      return this.resolveSlug(`${base}-org`, false);
    }

    const taken = await this.prisma.unscoped.organization.findUnique({
      where: { slug: base },
      select: { id: true },
    });

    if (!taken) return base;

    if (userSupplied) {
      throw new ConflictError(ErrorCode.SLUG_TAKEN, 'That organization address is already taken.', [
        { field: 'slug', message: 'This address is already in use.' },
      ]);
    }

    for (let suffix = 2; suffix < MAX_SLUG_ATTEMPTS; suffix++) {
      const attempt = `${base}-${suffix}`.slice(0, 64);
      const exists = await this.prisma.unscoped.organization.findUnique({
        where: { slug: attempt },
        select: { id: true },
      });
      if (!exists) return attempt;
    }

    throw new ConflictError(
      ErrorCode.SLUG_TAKEN,
      'Could not derive an available address from that name. Choose one explicitly.',
      [{ field: 'slug', message: 'Choose an address for this organization.' }],
    );
  }
}
