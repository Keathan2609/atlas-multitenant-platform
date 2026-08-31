import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type Permission, can } from '@atlas/types';
import { ErrorCode, ForbiddenError } from '../errors/app-error.js';
import { requireTenant } from '../tenancy/tenant.guard.js';

export const REQUIRED_PERMISSIONS = 'atlas:requiredPermissions';

/**
 * Declares the permissions a route requires.
 *
 * Multiple permissions are ANDed — a route asking for two needs both. The
 * OR case has not come up, and adding it speculatively would make every
 * declaration ambiguous to read.
 *
 *   @RequireTenant()
 *   @RequirePermission(Permission.MEMBERS_INVITE)
 *   @Post('members')
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * Enforces the RBAC matrix from @atlas/types at the HTTP boundary.
 *
 * The role it checks comes from `request.tenant`, which TenantGuard populated
 * from a membership row read on the server. Nothing the client sent
 * participates in the decision.
 *
 * This guard is the *only* place a permission is checked for a whole route.
 * Services still enforce the rules a permission cannot express — last-owner
 * protection, "cannot grant above your own role" — because those depend on
 * the target of the operation, not just the actor. The split is deliberate:
 * route-level authority here, relationship-level rules in the domain service
 * where the target is known.
 *
 * Ordering matters. This guard runs after TenantGuard, and `requireTenant`
 * throws rather than defaulting if that ordering is ever broken, so a
 * misconfiguration fails closed instead of silently authorising.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const tenant = requireTenant(request);

    const missing = required.filter((permission) => !can(tenant.role, permission));

    if (missing.length > 0) {
      throw new ForbiddenError(
        ErrorCode.INSUFFICIENT_PERMISSIONS,
        'Your role does not permit this action.',
        {
          role: tenant.role,
          organizationId: tenant.organizationId,
          missingPermissions: missing,
        },
      );
    }

    return true;
  }
}
