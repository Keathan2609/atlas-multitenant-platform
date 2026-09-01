import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission } from '@atlas/types';
import { updateOrganizationSettingsSchema } from '@atlas/validation';
import { zodBody } from '../../common/http/zod-validation.pipe.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import {
  PermissionsGuard,
  RequirePermission,
} from '../../common/authorization/permissions.guard.js';
import { auditContext } from '../../common/audit/audit.service.js';
import { requireUser } from '../organizations/organizations.controller.js';
import { SettingsService, type SettingsInput } from './settings.service.js';

@ApiTags('Settings')
@Controller({ path: 'organizations/:orgSlug/settings', version: '1' })
@RequireTenant()
@UseGuards(TenantGuard, PermissionsGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @RequirePermission(Permission.SETTINGS_READ)
  @ApiOperation({ summary: 'Read organization settings' })
  get(@Param('orgSlug') _s: string, @Req() request: Request) {
    return this.settings.get(requireTenant(request));
  }

  @Patch()
  @RequirePermission(Permission.SETTINGS_UPDATE)
  @ApiOperation({ summary: 'Update organization settings' })
  update(
    @Param('orgSlug') _s: string,
    @Body(zodBody(updateOrganizationSettingsSchema)) input: SettingsInput,
    @Req() request: Request,
  ) {
    return this.settings.update(
      requireTenant(request),
      requireUser(request).id,
      input,
      auditContext(request),
    );
  }
}
