import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission } from '@atlas/types';
import { addTeamMemberSchema, createTeamSchema, updateTeamSchema } from '@atlas/validation';
import { zodBody } from '../../common/http/zod-validation.pipe.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import { PermissionsGuard, RequirePermission } from '../../common/authorization/permissions.guard.js';
import { auditContext } from '../../common/audit/audit.service.js';
import { requireUser } from '../organizations/organizations.controller.js';
import { TeamsService, type TeamInput } from './teams.service.js';

@ApiTags('Teams')
@Controller({ path: 'organizations/:orgSlug/teams', version: '1' })
@RequireTenant()
@UseGuards(TenantGuard, PermissionsGuard)
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermission(Permission.TEAMS_READ)
  @ApiOperation({ summary: 'List teams' })
  list(@Param('orgSlug') _s: string, @Req() request: Request) {
    return this.teams.list(requireTenant(request));
  }

  @Get(':teamId')
  @RequirePermission(Permission.TEAMS_READ)
  @ApiOperation({ summary: 'Team detail with members and projects' })
  get(@Param('orgSlug') _s: string, @Param('teamId') id: string, @Req() request: Request) {
    return this.teams.get(requireTenant(request), id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(Permission.TEAMS_CREATE)
  @ApiOperation({ summary: 'Create a team' })
  create(
    @Param('orgSlug') _s: string,
    @Body(zodBody(createTeamSchema)) input: TeamInput,
    @Req() request: Request,
  ) {
    return this.teams.create(requireTenant(request), requireUser(request).id, input, auditContext(request));
  }

  @Patch(':teamId')
  @RequirePermission(Permission.TEAMS_UPDATE)
  @ApiOperation({ summary: 'Update a team' })
  update(
    @Param('orgSlug') _s: string,
    @Param('teamId') id: string,
    @Body(zodBody(updateTeamSchema)) input: Partial<TeamInput>,
    @Req() request: Request,
  ) {
    return this.teams.update(requireTenant(request), requireUser(request).id, id, input, auditContext(request));
  }

  @Delete(':teamId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.TEAMS_DELETE)
  @ApiOperation({ summary: 'Delete a team, unassigning its projects' })
  async remove(@Param('orgSlug') _s: string, @Param('teamId') id: string, @Req() request: Request) {
    await this.teams.remove(requireTenant(request), requireUser(request).id, id, auditContext(request));
  }

  @Post(':teamId/members')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(Permission.TEAMS_UPDATE)
  @ApiOperation({ summary: 'Add an organization member to a team' })
  addMember(
    @Param('orgSlug') _s: string,
    @Param('teamId') id: string,
    @Body(zodBody(addTeamMemberSchema)) input: { userId: string; role: 'LEAD' | 'MEMBER' },
    @Req() request: Request,
  ) {
    return this.teams.addMember(requireTenant(request), id, input.userId, input.role);
  }

  @Delete(':teamId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.TEAMS_UPDATE)
  @ApiOperation({ summary: 'Remove someone from a team' })
  async removeMember(
    @Param('orgSlug') _s: string,
    @Param('teamId') id: string,
    @Param('userId') userId: string,
    @Req() request: Request,
  ) {
    await this.teams.removeMember(requireTenant(request), id, userId);
  }
}
