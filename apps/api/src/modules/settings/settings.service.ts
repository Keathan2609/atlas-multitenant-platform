import { Injectable } from '@nestjs/common';
import type { TenantContext } from '../../common/http/express.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { AuditAction, AuditService, type AuditEvent } from '../../common/audit/audit.service.js';
import { ConflictError, ErrorCode } from '../../common/errors/app-error.js';

export interface SettingsInput {
  restrictEmailDomains?: boolean;
  allowedEmailDomains?: string[];
  sessionIdleTimeoutMinutes?: number | null;
  requireTwoFactor?: boolean;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(tenant: TenantContext) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const settings = await db.organizationSettings.findFirst({
      where: { organizationId: tenant.organizationId },
      select: {
        restrictEmailDomains: true,
        allowedEmailDomains: true,
        sessionIdleTimeoutMinutes: true,
        requireTwoFactor: true,
        updatedAt: true,
      },
    });

    // Every organization gets a settings row in its creation transaction, so
    // absence means an older tenant predating that. Returning defaults keeps
    // the endpoint total rather than 404-ing on a row the user never chose to
    // create.
    return (
      settings ?? {
        restrictEmailDomains: false,
        allowedEmailDomains: [] as string[],
        sessionIdleTimeoutMinutes: null,
        requireTwoFactor: false,
        updatedAt: null,
      }
    );
  }

  /**
   * Updates organization settings.
   *
   * Enabling the domain restriction with an empty allow-list is refused
   * rather than accepted. Accepting it would produce a configuration that
   * silently blocks every future invitation, including the administrator's
   * attempt to fix it — a self-inflicted lockout that looks like a bug.
   *
   * Existing members are deliberately not re-validated against a newly
   * enabled domain list. Turning on a restriction must not silently eject
   * people who are already in the organization; the setting governs future
   * invitations, and removing an existing member stays an explicit act with
   * its own audit entry.
   */
  async update(
    tenant: TenantContext,
    actorId: string,
    input: SettingsInput,
    requestContext: Pick<AuditEvent, 'ipAddress' | 'userAgent'>,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const current = await this.get(tenant);

    const restrict = input.restrictEmailDomains ?? current.restrictEmailDomains;
    const domains = input.allowedEmailDomains ?? current.allowedEmailDomains;

    if (restrict && domains.length === 0) {
      throw new ConflictError(
        ErrorCode.CONFLICT,
        'Add at least one allowed domain before turning on the restriction.',
        [{ field: 'allowedEmailDomains', message: 'Add at least one domain.' }],
      );
    }

    const settings = await db.organizationSettings.upsert({
      where: { organizationId: tenant.organizationId },
      create: {
        organizationId: tenant.organizationId,
        restrictEmailDomains: restrict,
        allowedEmailDomains: domains,
        sessionIdleTimeoutMinutes: input.sessionIdleTimeoutMinutes ?? null,
        requireTwoFactor: input.requireTwoFactor ?? false,
      } as never,
      update: {
        ...(input.restrictEmailDomains !== undefined
          ? { restrictEmailDomains: input.restrictEmailDomains }
          : {}),
        ...(input.allowedEmailDomains !== undefined
          ? { allowedEmailDomains: input.allowedEmailDomains }
          : {}),
        ...(input.sessionIdleTimeoutMinutes !== undefined
          ? { sessionIdleTimeoutMinutes: input.sessionIdleTimeoutMinutes }
          : {}),
        ...(input.requireTwoFactor !== undefined
          ? { requireTwoFactor: input.requireTwoFactor }
          : {}),
      },
      select: {
        restrictEmailDomains: true,
        allowedEmailDomains: true,
        sessionIdleTimeoutMinutes: true,
        requireTwoFactor: true,
        updatedAt: true,
      },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: AuditAction.SETTINGS_UPDATED,
      resourceType: 'organization_settings',
      resourceId: tenant.organizationId,
      metadata: {
        restrictEmailDomains: settings.restrictEmailDomains,
        allowedEmailDomains: settings.allowedEmailDomains.join(','),
        requireTwoFactor: settings.requireTwoFactor,
      },
      ...requestContext,
    });

    return settings;
  }
}
