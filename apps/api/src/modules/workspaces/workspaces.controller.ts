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
import { createWorkspaceSchema, updateWorkspaceSchema } from '@atlas/validation';
import { zodBody } from '../../common/http/zod-validation.pipe.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import {
  PermissionsGuard,
  RequirePermission,
} from '../../common/authorization/permissions.guard.js';
import { auditContext } from '../../common/audit/audit.service.js';
import { requireUser } from '../organizations/organizations.controller.js';
import { WorkspacesService, type WorkspaceInput } from './workspaces.service.js';

@ApiTags('Workspaces')
@Controller({ path: 'organizations/:orgSlug/workspaces', version: '1' })
@RequireTenant()
@UseGuards(TenantGuard, PermissionsGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  @RequirePermission(Permission.WORKSPACES_READ)
  @ApiOperation({ summary: 'List workspaces' })
  list(@Param('orgSlug') _s: string, @Req() request: Request) {
    return this.workspaces.list(requireTenant(request));
  }

  @Get(':workspaceId')
  @RequirePermission(Permission.WORKSPACES_READ)
  @ApiOperation({ summary: 'Workspace detail' })
  get(@Param('orgSlug') _s: string, @Param('workspaceId') id: string, @Req() request: Request) {
    return this.workspaces.get(requireTenant(request), id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(Permission.WORKSPACES_CREATE)
  @ApiOperation({ summary: 'Create a workspace' })
  create(
    @Param('orgSlug') _s: string,
    @Body(zodBody(createWorkspaceSchema)) input: WorkspaceInput,
    @Req() request: Request,
  ) {
    return this.workspaces.create(
      requireTenant(request),
      requireUser(request).id,
      input,
      auditContext(request),
    );
  }

  @Patch(':workspaceId')
  @RequirePermission(Permission.WORKSPACES_UPDATE)
  @ApiOperation({ summary: 'Update a workspace' })
  update(
    @Param('orgSlug') _s: string,
    @Param('workspaceId') id: string,
    @Body(zodBody(updateWorkspaceSchema)) input: Partial<WorkspaceInput>,
    @Req() request: Request,
  ) {
    return this.workspaces.update(
      requireTenant(request),
      requireUser(request).id,
      id,
      input,
      auditContext(request),
    );
  }

  @Delete(':workspaceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.WORKSPACES_DELETE)
  @ApiOperation({ summary: 'Delete an empty, non-default workspace' })
  async remove(
    @Param('orgSlug') _s: string,
    @Param('workspaceId') id: string,
    @Req() request: Request,
  ) {
    await this.workspaces.remove(
      requireTenant(request),
      requireUser(request).id,
      id,
      auditContext(request),
    );
  }
}
