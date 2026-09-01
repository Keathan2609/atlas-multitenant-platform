import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@atlas/observability';
import {
  type OrganizationRole,
  type RoleChangeDecision,
  canChangeRole,
  canRemoveMember,
} from '@atlas/types';
import type { TenantContext } from '../../common/http/express.js';
import { LOGGER_TOKEN } from '../../common/logging/logger.provider.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { AuditAction, AuditService, type AuditEvent } from '../../common/audit/audit.service.js';
import { ErrorCode, ForbiddenError, NotFoundError } from '../../common/errors/app-error.js';

export interface ListMembersQuery {
  search?: string;
  role?: OrganizationRole;
  sortBy: 'displayName' | 'email' | 'role' | 'joinedAt';
  sortDirection: 'asc' | 'desc';
  page: number;
  pageSize: number;
}

/**
 * Maps a refusal from the RBAC model onto an HTTP error.
 *
 * The model returns a discriminated reason rather than throwing, precisely so
 * this mapping lives in one place and the UI can explain *why* an action was
 * refused instead of showing an undifferentiated 403.
 */
function denial(decision: Exclude<RoleChangeDecision, { allowed: true }>): never {
  switch (decision.reason) {
    case 'MISSING_PERMISSION':
      throw new ForbiddenError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        'Your role does not permit this action.',
      );
    case 'CANNOT_MODIFY_SELF':
      throw new ForbiddenError(
        ErrorCode.CANNOT_MODIFY_SELF,
        'You cannot change your own role. Ask another owner, or transfer ownership.',
      );
    case 'TARGET_OUTRANKS_ACTOR':
      throw new ForbiddenError(
        ErrorCode.TARGET_OUTRANKS_ACTOR,
        'You cannot administer a member whose role is equal to or above your own.',
      );
    case 'CANNOT_GRANT_ABOVE_OWN_ROLE':
      throw new ForbiddenError(
        ErrorCode.CANNOT_GRANT_ABOVE_OWN_ROLE,
        'You cannot grant a role above your own.',
      );
    case 'LAST_OWNER':
      throw new ForbiddenError(
        ErrorCode.LAST_OWNER,
        'This is the last owner. Promote another member to owner first.',
      );
  }
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {}

  async list(tenant: TenantContext, query: ListMembersQuery) {
    const db = this.prisma.forTenant(tenant.organizationId);

    // `search` is passed to Prisma as a parameter, never interpolated, so it
    // cannot alter the query. `mode: 'insensitive'` maps to ILIKE.
    const where = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.search
        ? {
            user: {
              OR: [
                { displayName: { contains: query.search, mode: 'insensitive' as const } },
                { email: { contains: query.search, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };

    const orderBy =
      query.sortBy === 'role'
        ? { role: query.sortDirection }
        : query.sortBy === 'joinedAt'
          ? { joinedAt: query.sortDirection }
          : { user: { [query.sortBy]: query.sortDirection } };

    const [total, rows] = await Promise.all([
      db.organizationMembership.count({ where }),
      db.organizationMembership.findMany({
        where,
        select: {
          id: true,
          role: true,
          joinedAt: true,
          user: { select: { id: true, email: true, displayName: true, avatarUrl: true, lastLoginAt: true } },
        },
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      data: rows.map((row) => ({
        membershipId: row.id,
        userId: row.user.id,
        email: row.user.email,
        displayName: row.user.displayName,
        avatarUrl: row.user.avatarUrl,
        role: row.role,
        joinedAt: row.joinedAt,
        lastLoginAt: row.user.lastLoginAt,
      })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  }

  /**
   * Changes a member's role.
   *
   * The permission to touch members at all was checked by PermissionsGuard.
   * What is decided here is the part a permission cannot express — whether
   * *this actor* may do it to *this target*: rank comparison, self-modification,
   * and the last-owner rule. See @atlas/types canChangeRole.
   *
   * Owner counting and the update happen in one transaction at serializable
   * isolation. Without that, two concurrent demotions of the last two owners
   * could each read ownerCount = 2, each pass the check, and leave the
   * organization with none.
   */
  async changeRole(
    tenant: TenantContext,
    actorId: string,
    targetUserId: string,
    newRole: OrganizationRole,
    requestContext: Pick<AuditEvent, 'ipAddress' | 'userAgent'>,
  ) {
    // Scoped client, not unscoped. The extension survives into $transaction
    // (verified against a live database), so every query below carries the
    // tenant predicate even if a future edit forgets to write it. The
    // explicit organizationId filters stay too — belt and braces on the two
    // mutations most worth protecting.
    const db = this.prisma.forTenant(tenant.organizationId);

    return db.$transaction(
      async (tx) => {
        const target = await tx.organizationMembership.findFirst({
          where: { organizationId: tenant.organizationId, userId: targetUserId },
          select: { id: true, role: true, userId: true },
        });

        if (!target) {
          throw new NotFoundError(ErrorCode.MEMBER_NOT_FOUND, 'That member could not be found.');
        }

        const ownerCount = await tx.organizationMembership.count({
          where: { organizationId: tenant.organizationId, role: 'OWNER' },
        });

        const decision = canChangeRole({
          actorRole: tenant.role,
          targetCurrentRole: target.role,
          targetNewRole: newRole,
          actorIsTarget: target.userId === actorId,
          ownerCount,
        });

        if (!decision.allowed) denial(decision);

        const updated = await tx.organizationMembership.update({
          where: { id: target.id },
          data: { role: newRole },
          select: { id: true, role: true, userId: true },
        });

        await this.audit.record(
          {
            organizationId: tenant.organizationId,
            actorId,
            action: AuditAction.MEMBER_ROLE_CHANGED,
            resourceType: 'membership',
            resourceId: target.id,
            metadata: { targetUserId, from: target.role, to: newRole },
            ...requestContext,
          },
          tx,
        );

        this.logger.info(
          {
            event: 'member.role_changed',
            organizationId: tenant.organizationId,
            actorId,
            targetUserId,
            from: target.role,
            to: newRole,
          },
          'Member role changed',
        );

        return updated;
      },
      { isolationLevel: 'Serializable' },
    );
  }

  /**
   * Removes a member, or lets one leave.
   *
   * Leaving is permitted for everyone except the last owner — the asymmetry
   * with role changes is deliberate and lives in canRemoveMember.
   */
  async remove(
    tenant: TenantContext,
    actorId: string,
    targetUserId: string,
    requestContext: Pick<AuditEvent, 'ipAddress' | 'userAgent'>,
  ) {
    // Scoped, for the same reason as changeRole above.
    const db = this.prisma.forTenant(tenant.organizationId);

    return db.$transaction(
      async (tx) => {
        const target = await tx.organizationMembership.findFirst({
          where: { organizationId: tenant.organizationId, userId: targetUserId },
          select: { id: true, role: true, userId: true },
        });

        if (!target) {
          throw new NotFoundError(ErrorCode.MEMBER_NOT_FOUND, 'That member could not be found.');
        }

        const ownerCount = await tx.organizationMembership.count({
          where: { organizationId: tenant.organizationId, role: 'OWNER' },
        });

        const actorIsTarget = target.userId === actorId;
        const decision = canRemoveMember({
          actorRole: tenant.role,
          targetRole: target.role,
          actorIsTarget,
          ownerCount,
        });

        if (!decision.allowed) denial(decision);

        // Team and project memberships carry composite FKs onto this row with
        // ON DELETE CASCADE, so removing it detaches the user from everything
        // in this tenant atomically. Work items they authored or were assigned
        // keep their history — those relations are SetNull on a nullable
        // column, so the record survives the person leaving.
        await tx.organizationMembership.delete({ where: { id: target.id } });

        await this.audit.record(
          {
            organizationId: tenant.organizationId,
            actorId,
            action: actorIsTarget ? AuditAction.MEMBER_LEFT : AuditAction.MEMBER_REMOVED,
            resourceType: 'membership',
            resourceId: target.id,
            metadata: { targetUserId, role: target.role },
            ...requestContext,
          },
          tx,
        );

        this.logger.info(
          {
            event: actorIsTarget ? 'member.left' : 'member.removed',
            organizationId: tenant.organizationId,
            actorId,
            targetUserId,
          },
          actorIsTarget ? 'Member left organization' : 'Member removed',
        );

        return { removed: true as const };
      },
      { isolationLevel: 'Serializable' },
    );
  }
}
