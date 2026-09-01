import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission } from '@atlas/types';
import {
  createOrganizationSchema,
  deleteOrganizationSchema,
  updateOrganizationSchema,
  type CreateOrganizationInput,
} from '@atlas/validation';
import { zodBody } from '../../common/http/zod-validation.pipe.js';
import { RateLimit, RateLimitGuard } from '../../common/http/rate-limit.guard.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import {
  PermissionsGuard,
  RequirePermission,
} from '../../common/authorization/permissions.guard.js';
import { UnauthenticatedError } from '../../common/errors/app-error.js';
import { auditContext } from '../../common/audit/audit.service.js';
import { OrganizationsService } from './organizations.service.js';

/**
 * Organization endpoints.
 *
 * Split into two route groups on purpose:
 *
 *   /organizations         — operates *across* the caller's memberships.
 *                            No tenant context; this is where the switcher
 *                            gets its list and where a new tenant is created.
 *
 *   /organizations/:orgSlug — operates *inside* one tenant. Every route here
 *                            carries @RequireTenant(), which resolves the slug
 *                            to a membership row and refuses if there isn't one.
 *
 * Keeping them apart means the tenant-scoped group can be guarded uniformly
 * rather than each handler remembering to check.
 */
@ApiTags('Organizations')
@Controller({ path: 'organizations', version: '1' })
@UseGuards(RateLimitGuard, TenantGuard, PermissionsGuard)
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @ApiOperation({ summary: 'Organizations the caller belongs to' })
  async list(@Req() request: Request) {
    const user = requireUser(request);
    return { data: await this.organizations.listForUser(user.id) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an organization; the caller becomes its owner' })
  // Deliberately throttled. Organization creation writes five rows and claims
  // a slug from a global namespace, so it is the cheapest way to grief the
  // system from a single authenticated account.
  @RateLimit({ max: 10, windowSeconds: 3600, by: 'user' })
  async create(
    @Body(zodBody(createOrganizationSchema)) input: CreateOrganizationInput,
    @Req() request: Request,
  ) {
    const user = requireUser(request);
    return this.organizations.create({
      name: input.name,
      slug: input.slug,
      ownerId: user.id,
      requestContext: auditContext(request),
    });
  }

  @Get(':orgSlug')
  @RequireTenant()
  @RequirePermission(Permission.ORGANIZATION_READ)
  @ApiOperation({ summary: 'Organization detail for the current tenant' })
  async get(@Param('orgSlug') _orgSlug: string, @Req() request: Request) {
    return this.organizations.get(requireTenant(request));
  }

  @Patch(':orgSlug')
  @RequireTenant()
  @RequirePermission(Permission.ORGANIZATION_UPDATE)
  @ApiOperation({ summary: 'Update organization details' })
  async update(
    @Param('orgSlug') _orgSlug: string,
    @Body(zodBody(updateOrganizationSchema)) input: { name?: string },
    @Req() request: Request,
  ) {
    const user = requireUser(request);
    return this.organizations.update(requireTenant(request), user.id, input, auditContext(request));
  }

  @Delete(':orgSlug')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireTenant()
  @RequirePermission(Permission.ORGANIZATION_DELETE)
  @ApiOperation({ summary: 'Soft-delete the organization (owner only, confirmation required)' })
  async remove(
    @Param('orgSlug') _orgSlug: string,
    @Body(zodBody(deleteOrganizationSchema)) input: { confirmSlug: string },
    @Req() request: Request,
  ) {
    const user = requireUser(request);
    await this.organizations.softDelete(
      requireTenant(request),
      user.id,
      input.confirmSlug,
      auditContext(request),
    );
  }
}

/**
 * Narrows `request.user` for handlers.
 *
 * The global AuthGuard guarantees it is present on any non-@Public route, so
 * this only converts a "cannot happen" into a 401 rather than a TypeError on
 * an undefined dereference.
 */
export function requireUser(request: Request) {
  if (!request.user) throw new UnauthenticatedError();
  return request.user;
}
