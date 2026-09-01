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
  createWorkItemSchema,
  listWorkItemsSchema,
  updateWorkItemSchema,
  type CreateWorkItemInput,
  type ListWorkItemsInput,
  type UpdateWorkItemInput,
} from '@atlas/validation';
import { zodBody, zodQuery } from '../../common/http/zod-validation.pipe.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import {
  PermissionsGuard,
  RequirePermission,
} from '../../common/authorization/permissions.guard.js';
import { requireUser } from '../organizations/organizations.controller.js';
import { WorkItemsService } from './work-items.service.js';

/**
 * Work items are addressed two ways:
 *
 *   /organizations/:orgSlug/work-items               org-wide list
 *   /organizations/:orgSlug/projects/:projectId/...  within one project
 *
 * Both are tenant-scoped by the same guard; the project-scoped route simply
 * pins projectId as well. Creation is project-scoped because a work item
 * cannot exist without a project — its number comes from that project.
 */
@ApiTags('Work items')
@Controller({ path: 'organizations/:orgSlug', version: '1' })
@RequireTenant()
@UseGuards(TenantGuard, PermissionsGuard)
export class WorkItemsController {
  constructor(private readonly workItems: WorkItemsService) {}

  @Get('work-items')
  @RequirePermission(Permission.WORKITEMS_READ)
  @ApiOperation({ summary: 'List work items across the organization' })
  list(
    @Param('orgSlug') _s: string,
    @Query(zodQuery(listWorkItemsSchema)) query: ListWorkItemsInput,
    @Req() request: Request,
  ) {
    return this.workItems.list(requireTenant(request), requireUser(request).id, query);
  }

  @Get('work-items/:workItemId')
  @RequirePermission(Permission.WORKITEMS_READ)
  @ApiOperation({ summary: 'Work item detail' })
  get(@Param('orgSlug') _s: string, @Param('workItemId') id: string, @Req() request: Request) {
    return this.workItems.get(requireTenant(request), id);
  }

  @Post('projects/:projectId/work-items')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(Permission.WORKITEMS_CREATE)
  @ApiOperation({ summary: 'Create a work item in a project' })
  create(
    @Param('orgSlug') _s: string,
    @Param('projectId') projectId: string,
    @Body(zodBody(createWorkItemSchema)) input: CreateWorkItemInput,
    @Req() request: Request,
  ) {
    return this.workItems.create(requireTenant(request), projectId, requireUser(request).id, input);
  }

  @Patch('work-items/:workItemId')
  @RequirePermission(Permission.WORKITEMS_UPDATE)
  @ApiOperation({ summary: 'Update a work item' })
  update(
    @Param('orgSlug') _s: string,
    @Param('workItemId') id: string,
    @Body(zodBody(updateWorkItemSchema)) input: UpdateWorkItemInput,
    @Req() request: Request,
  ) {
    return this.workItems.update(requireTenant(request), id, input);
  }

  @Delete('work-items/:workItemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(Permission.WORKITEMS_DELETE)
  @ApiOperation({ summary: 'Delete a work item' })
  async remove(
    @Param('orgSlug') _s: string,
    @Param('workItemId') id: string,
    @Req() request: Request,
  ) {
    await this.workItems.remove(requireTenant(request), id);
  }
}
