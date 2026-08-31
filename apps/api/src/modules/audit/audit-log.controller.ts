import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Permission } from '@atlas/types';
import { listAuditLogsSchema, type ListAuditLogsInput } from '@atlas/validation';
import { zodQuery } from '../../common/http/zod-validation.pipe.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import { PermissionsGuard, RequirePermission } from '../../common/authorization/permissions.guard.js';
import { AuditLogService } from './audit-log.service.js';

/**
 * Read-only by design. The audit log has no write, update or delete endpoint —
 * entries are produced by AuditService as a side effect of the actions they
 * describe. A trail an administrator can edit is not a trail.
 */
@ApiTags('Audit')
@Controller({ path: 'organizations/:orgSlug/audit-logs', version: '1' })
@RequireTenant()
@UseGuards(TenantGuard, PermissionsGuard)
export class AuditLogController {
  constructor(private readonly auditLogs: AuditLogService) {}

  @Get()
  @RequirePermission(Permission.AUDIT_READ)
  @ApiOperation({ summary: 'Read the audit log, newest first (cursor paginated)' })
  list(
    @Param('orgSlug') _s: string,
    @Query(zodQuery(listAuditLogsSchema)) query: ListAuditLogsInput,
    @Req() request: Request,
  ) {
    return this.auditLogs.list(requireTenant(request), query);
  }

  @Get('actions')
  @RequirePermission(Permission.AUDIT_READ)
  @ApiOperation({ summary: 'Distinct action names present in this log' })
  actions(@Param('orgSlug') _s: string, @Req() request: Request) {
    return this.auditLogs.actions(requireTenant(request));
  }
}
