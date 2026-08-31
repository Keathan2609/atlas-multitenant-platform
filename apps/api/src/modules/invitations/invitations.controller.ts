import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission, type OrganizationRole } from '@atlas/types';
import { acceptInvitationSchema, inviteMemberSchema } from '@atlas/validation';
import { zodBody } from '../../common/http/zod-validation.pipe.js';
import { RateLimit, RateLimitGuard } from '../../common/http/rate-limit.guard.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import { PermissionsGuard, RequirePermission } from '../../common/authorization/permissions.guard.js';
import { auditContext } from '../../common/audit/audit.service.js';
import { Public } from '../auth/auth.guard.js';
import { requireUser } from '../organizations/organizations.controller.js';
import { InvitationsService } from './invitations.service.js';

/** Invitation management, inside a tenant. */
@ApiTags('Invitations')
@Controller({ path: 'organizations/:orgSlug/invitations', version: '1' })
@RequireTenant()
@UseGuards(RateLimitGuard, TenantGuard, PermissionsGuard)
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @RequirePermission(Permission.MEMBERS_READ)
  @ApiOperation({ summary: 'List outstanding invitations' })
  list(@Param('orgSlug') _s: string, @Req() request: Request) {
    return this.invitations.list(requireTenant(request));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(Permission.MEMBERS_INVITE)
  // Throttled per user: invitations send mail to an address the caller
  // chooses, so an unthrottled endpoint is a spam relay wearing our domain.
  @RateLimit({ max: 20, windowSeconds: 3600, by: 'user' })
  @ApiOperation({ summary: 'Invite someone to the organization' })
  invite(
    @Param('orgSlug') _s: string,
    @Body(zodBody(inviteMemberSchema)) input: { email: string; role: OrganizationRole },
    @Req() request: Request,
  ) {
    return this.invitations.invite(
      requireTenant(request),
      requireUser(request).id,
      input.email,
      input.role,
      auditContext(request),
    );
  }

  @Delete(':invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.MEMBERS_INVITE)
  @ApiOperation({ summary: 'Revoke an outstanding invitation' })
  async revoke(
    @Param('orgSlug') _s: string,
    @Param('invitationId') invitationId: string,
    @Req() request: Request,
  ) {
    await this.invitations.revoke(
      requireTenant(request),
      requireUser(request).id,
      invitationId,
      auditContext(request),
    );
  }
}

/**
 * Redeeming an invitation, outside any tenant.
 *
 * These routes cannot be tenant-scoped: the recipient is not a member yet, so
 * there is no membership row for TenantGuard to resolve. The token is the
 * claim, which is why it is 256 bits of CSPRNG output stored only as a hash.
 *
 * `preview` is @Public so the sign-in page can name the organization before
 * the visitor authenticates. `accept` deliberately is not — the membership
 * must attach to a real session, and folding account creation into acceptance
 * would make one endpoint both authenticate and authorise.
 */
@ApiTags('Invitations')
@Controller({ path: 'invitations', version: '1' })
@UseGuards(RateLimitGuard)
export class InvitationRedemptionController {
  constructor(private readonly invitations: InvitationsService) {}

  @Public()
  @Get(':token')
  @RateLimit({ max: 30, windowSeconds: 600, by: 'ip' })
  @ApiOperation({ summary: 'Describe an invitation to the holder of its token' })
  preview(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ max: 20, windowSeconds: 600, by: 'user' })
  @ApiOperation({ summary: 'Accept an invitation as the signed-in user' })
  accept(
    @Body(zodBody(acceptInvitationSchema)) input: { token: string },
    @Req() request: Request,
  ) {
    return this.invitations.accept(requireUser(request).id, input.token, auditContext(request));
  }
}
