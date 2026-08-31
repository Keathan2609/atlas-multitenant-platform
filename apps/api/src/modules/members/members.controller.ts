import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission, assignableRoles, type OrganizationRole } from '@atlas/types';
import { listMembersSchema, updateMemberRoleSchema } from '@atlas/validation';
import { zodBody, zodQuery } from '../../common/http/zod-validation.pipe.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import { PermissionsGuard, RequirePermission } from '../../common/authorization/permissions.guard.js';
import { auditContext } from '../../common/audit/audit.service.js';
import { requireUser } from '../organizations/organizations.controller.js';
import { MembersService, type ListMembersQuery } from './members.service.js';

@ApiTags('Members')
@Controller({ path: 'organizations/:orgSlug/members', version: '1' })
@RequireTenant()
@UseGuards(TenantGuard, PermissionsGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission(Permission.MEMBERS_READ)
  @ApiOperation({ summary: 'List organization members' })
  async list(
    @Param('orgSlug') _orgSlug: string,
    @Query(zodQuery(listMembersSchema)) query: ListMembersQuery,
    @Req() request: Request,
  ) {
    return this.members.list(requireTenant(request), query);
  }

  /**
   * Roles the caller is allowed to hand out.
   *
   * Exists so the UI can populate a role selector without hard-coding the
   * rule, and so the list it shows always matches what the server would
   * accept. It is a convenience for rendering, not a check — `changeRole`
   * re-derives the same decision server-side regardless of what is submitted.
   */
  @Get('assignable-roles')
  @RequirePermission(Permission.MEMBERS_READ)
  @ApiOperation({ summary: 'Roles the caller may assign' })
  assignable(@Param('orgSlug') _orgSlug: string, @Req() request: Request) {
    return { data: assignableRoles(requireTenant(request).role) };
  }

  @Patch(':userId')
  @RequirePermission(Permission.MEMBERS_UPDATE)
  @ApiOperation({ summary: "Change a member's role" })
  async changeRole(
    @Param('orgSlug') _orgSlug: string,
    @Param('userId') userId: string,
    @Body(zodBody(updateMemberRoleSchema)) input: { role: OrganizationRole },
    @Req() request: Request,
  ) {
    const user = requireUser(request);
    return this.members.changeRole(
      requireTenant(request),
      user.id,
      userId,
      input.role,
      auditContext(request),
    );
  }

  /**
   * Removes a member.
   *
   * Note the absence of @RequirePermission here, which is deliberate rather
   * than an oversight: leaving voluntarily must work for a MEMBER or VIEWER,
   * who hold no members.remove permission. The service distinguishes the two
   * cases — canRemoveMember allows self-removal and applies the full rank and
   * last-owner rules to everyone else — so the authority check happens where
   * the target is known.
   */
  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a member, or leave the organization' })
  async remove(
    @Param('orgSlug') _orgSlug: string,
    @Param('userId') userId: string,
    @Req() request: Request,
  ) {
    const user = requireUser(request);
    await this.members.remove(requireTenant(request), user.id, userId, auditContext(request));
  }
}
