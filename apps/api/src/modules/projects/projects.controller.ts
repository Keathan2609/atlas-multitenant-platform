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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission } from '@atlas/types';
import {
  createProjectSchema,
  listProjectsSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type ListProjectsInput,
  type UpdateProjectInput,
} from '@atlas/validation';
import { zodBody, zodQuery } from '../../common/http/zod-validation.pipe.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import { PermissionsGuard, RequirePermission } from '../../common/authorization/permissions.guard.js';
import { auditContext } from '../../common/audit/audit.service.js';
import { requireUser } from '../organizations/organizations.controller.js';
import { ProjectsService } from './projects.service.js';

@ApiTags('Projects')
@Controller({ path: 'organizations/:orgSlug/projects', version: '1' })
@RequireTenant()
@UseGuards(TenantGuard, PermissionsGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequirePermission(Permission.PROJECTS_READ)
  @ApiOperation({ summary: 'List projects with search, filters and sorting' })
  list(
    @Param('orgSlug') _s: string,
    @Query(zodQuery(listProjectsSchema)) query: ListProjectsInput,
    @Req() request: Request,
  ) {
    return this.projects.list(requireTenant(request), query);
  }

  @Get(':projectId')
  @RequirePermission(Permission.PROJECTS_READ)
  @ApiOperation({ summary: 'Project detail' })
  get(@Param('orgSlug') _s: string, @Param('projectId') id: string, @Req() request: Request) {
    return this.projects.get(requireTenant(request), id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(Permission.PROJECTS_CREATE)
  @ApiOperation({ summary: 'Create a project' })
  create(
    @Param('orgSlug') _s: string,
    @Body(zodBody(createProjectSchema)) input: CreateProjectInput,
    @Req() request: Request,
  ) {
    return this.projects.create(
      requireTenant(request),
      requireUser(request).id,
      input,
      auditContext(request),
    );
  }

  @Patch(':projectId')
  @RequirePermission(Permission.PROJECTS_UPDATE)
  @ApiOperation({ summary: 'Update a project' })
  update(
    @Param('orgSlug') _s: string,
    @Param('projectId') id: string,
    @Body(zodBody(updateProjectSchema)) input: UpdateProjectInput,
    @Req() request: Request,
  ) {
    return this.projects.update(
      requireTenant(request),
      requireUser(request).id,
      id,
      input,
      auditContext(request),
    );
  }

  @Delete(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.PROJECTS_DELETE)
  @ApiOperation({ summary: 'Delete a project and its work items' })
  async remove(
    @Param('orgSlug') _s: string,
    @Param('projectId') id: string,
    @Req() request: Request,
  ) {
    await this.projects.remove(
      requireTenant(request),
      requireUser(request).id,
      id,
      auditContext(request),
    );
  }
}
