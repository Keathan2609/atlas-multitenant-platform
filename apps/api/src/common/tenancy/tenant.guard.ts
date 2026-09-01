import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Logger } from '@atlas/observability';
import { Inject } from '@nestjs/common';
import { LOGGER_TOKEN } from '../logging/logger.provider.js';
import { PrismaService } from '../database/prisma.service.js';
import { ErrorCode, ForbiddenError, NotFoundError, UnauthenticatedError } from '../errors/app-error.js';

/** Marks a route as operating inside an organization. */
export const REQUIRES_TENANT = 'atlas:requiresTenant';
export const RequireTenant = () => SetMetadata(REQUIRES_TENANT, true);

/**
 * Layer 3 of tenant isolation: resolving and authorising the tenant before any
 * service runs. Layers 1 and 2 are the composite foreign keys in the schema
 * and the scoped Prisma client (packages/database/src/tenant-scope.ts).
 *
 * The rule this guard exists to enforce is simple and absolute:
 *
 *   **The organization is never taken from the client's word for it.**
 *
 * A request names an organization by slug in the URL. That slug is a claim,
 * not a credential. The guard turns it into a tenant context only by looking
 * up a membership row that proves *this authenticated user* belongs to *that
 * organization*, and the role it attaches comes from that row — never from a
 * header, body field, or anything else the caller controls.
 *
 * ── Why a non-member gets 404 and not 403 ────────────────────────────────────
 * Returning 403 would confirm the organization exists. An attacker could then
 * enumerate tenants by slug: 403 means "real, you're not in it", 404 means
 * "no such org". Collapsing both into 404 makes membership and existence
 * indistinguishable from outside. The audit log still records the attempt with
 * the real reason, so the distinction survives where it is safe to keep it.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresTenant = this.reflector.getAllAndOverride<boolean>(REQUIRES_TENANT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiresTenant) return true;

    const request = context.switchToHttp().getRequest<Request>();

    // An API-key request already carries a server-resolved organization; the
    // key *is* the tenant claim and was validated when it was looked up. The
    // slug in the URL must still agree, or a key for org A could be used to
    // address org B's data through a URL the key holder controls.
    if (request.apiKeyContext) {
      return this.authoriseApiKey(request);
    }

    const user = request.user;
    if (!user) throw new UnauthenticatedError();

    const slug = this.extractSlug(request);
    if (!slug) {
      throw new NotFoundError(
        ErrorCode.ORGANIZATION_NOT_FOUND,
        'The requested organization could not be found.',
      );
    }

    // One indexed query answers both questions at once: does the organization
    // exist, and is this user a member of it? Splitting them into two lookups
    // would open the timing difference the 404 collapse is meant to close.
    // Unscoped by necessity: this query is *how* the tenant is resolved. There
    // is no organizationId to scope by until this row is found, and the row
    // itself is the proof of membership. Scoped by userId instead, which is the
    // authenticated identity, so it cannot read another user's membership.
    const membership = await this.prisma.unscoped.organizationMembership.findFirst({
      // eslint-disable-next-line no-restricted-syntax
      where: {
        userId: user.id,
        organization: { slug, deletedAt: null },
      },
      select: {
        id: true,
        role: true,
        organization: { select: { id: true, slug: true, name: true } },
      },
    });

    if (!membership) {
      this.logger.warn(
        {
          event: 'tenancy.access_denied',
          reason: 'not_a_member_or_no_such_org',
          userId: user.id,
          requestedSlug: slug,
        },
        'Tenant access denied',
      );
      throw new NotFoundError(
        ErrorCode.ORGANIZATION_NOT_FOUND,
        'The requested organization could not be found.',
      );
    }

    request.tenant = {
      organizationId: membership.organization.id,
      slug: membership.organization.slug,
      name: membership.organization.name,
      role: membership.role,
      membershipId: membership.id,
    };

    return true;
  }

  /**
   * An API key is bound to one organization at creation and can never address
   * another. The URL slug is checked against the key's organization so a
   * caller cannot point a valid key at a tenant it was not issued for.
   */
  private async authoriseApiKey(request: Request): Promise<boolean> {
    const { organizationId } = request.apiKeyContext!;
    const slug = this.extractSlug(request);

    const organization = await this.prisma.unscoped.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { id: true, slug: true, name: true },
    });

    if (!organization || (slug && organization.slug !== slug)) {
      this.logger.warn(
        {
          event: 'security.api_key_tenant_mismatch',
          apiKeyId: request.apiKeyContext!.apiKeyId,
          keyOrganizationId: organizationId,
          requestedSlug: slug,
        },
        'API key used against a different organization',
      );
      throw new NotFoundError(
        ErrorCode.ORGANIZATION_NOT_FOUND,
        'The requested organization could not be found.',
      );
    }

    // API keys act with organization-wide read authority and nothing more.
    // Deliberately not OWNER or ADMIN: a leaked key must not be able to add
    // members, mint further keys, or delete the organization. Widening this
    // would need a scopes column on the key, not a role bump here.
    request.tenant = {
      organizationId: organization.id,
      slug: organization.slug,
      name: organization.name,
      role: 'VIEWER',
      membershipId: `apikey:${request.apiKeyContext!.apiKeyId}`,
    };

    return true;
  }

  /**
   * Reads the organization slug from the route.
   *
   * Only route parameters are consulted. A query string or header would be
   * equally easy for a client to set but far easier to overlook when reviewing
   * which inputs are trusted, and the slug is the one input that selects a
   * tenant.
   */
  private extractSlug(request: Request): string | undefined {
    const value = (request.params as Record<string, string | undefined>)?.orgSlug;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}

/**
 * Throws if the tenant context is missing.
 *
 * Services take the context as an argument rather than reading it from a
 * request-scoped provider, so this is the single place that converts "the
 * guard did not run" into a loud failure instead of an undefined dereference
 * somewhere deeper.
 */
export function requireTenant(request: Request) {
  if (!request.tenant) {
    throw new ForbiddenError(
      ErrorCode.NOT_ORGANIZATION_MEMBER,
      'No organization context for this request.',
      { reason: 'tenant_guard_did_not_run' },
    );
  }
  return request.tenant;
}
