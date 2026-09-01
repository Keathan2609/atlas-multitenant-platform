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
import { Permission } from '@atlas/types';
import { createApiKeySchema, type CreateApiKeyInput } from '@atlas/validation';
import { zodBody } from '../../common/http/zod-validation.pipe.js';
import { RequireTenant, TenantGuard, requireTenant } from '../../common/tenancy/tenant.guard.js';
import {
  PermissionsGuard,
  RequirePermission,
} from '../../common/authorization/permissions.guard.js';
import { auditContext } from '../../common/audit/audit.service.js';
import { requireUser } from '../organizations/organizations.controller.js';
import { ApiKeysService } from './api-keys.service.js';

@ApiTags('API keys')
@Controller({ path: 'organizations/:orgSlug/api-keys', version: '1' })
@RequireTenant()
@UseGuards(TenantGuard, PermissionsGuard)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @RequirePermission(Permission.APIKEYS_READ)
  @ApiOperation({ summary: 'List API keys (prefix only, never the secret)' })
  list(@Param('orgSlug') _s: string, @Req() request: Request) {
    return this.apiKeys.list(requireTenant(request));
  }

  /**
   * The only response in the system that contains a raw API key. Every later
   * read returns the prefix alone, because nothing stores the secret.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(Permission.APIKEYS_CREATE)
  @ApiOperation({ summary: 'Create an API key; the secret is shown exactly once' })
  create(
    @Param('orgSlug') _s: string,
    @Body(zodBody(createApiKeySchema)) input: CreateApiKeyInput,
    @Req() request: Request,
  ) {
    return this.apiKeys.create(
      requireTenant(request),
      requireUser(request).id,
      input,
      auditContext(request),
    );
  }

  @Delete(':apiKeyId')
  @RequirePermission(Permission.APIKEYS_REVOKE)
  @ApiOperation({ summary: 'Revoke an API key (irreversible)' })
  revoke(
    @Param('orgSlug') _s: string,
    @Param('apiKeyId') apiKeyId: string,
    @Req() request: Request,
  ) {
    return this.apiKeys.revoke(
      requireTenant(request),
      requireUser(request).id,
      apiKeyId,
      auditContext(request),
    );
  }
}
