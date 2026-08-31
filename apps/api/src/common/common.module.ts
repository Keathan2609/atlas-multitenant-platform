import { Global, Module } from '@nestjs/common';
import { loadConfig, CONFIG_TOKEN } from '../config/env.js';
import { loggerProvider, LOGGER_TOKEN } from './logging/logger.provider.js';
import { PrismaService } from './database/prisma.service.js';
import { RedisService } from './redis/redis.service.js';
import { RateLimitGuard } from './http/rate-limit.guard.js';
import { TenantGuard } from './tenancy/tenant.guard.js';
import { PermissionsGuard } from './authorization/permissions.guard.js';

/**
 * Cross-cutting infrastructure, available everywhere without re-importing.
 *
 * Global because configuration, logging, the database handle and Redis are
 * needed by essentially every feature module. Making each one import them
 * would be ceremony, not encapsulation. Domain modules are deliberately not
 * global — those boundaries are meaningful.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG_TOKEN, useFactory: () => loadConfig() },
    loggerProvider,
    PrismaService,
    RedisService,
    RateLimitGuard,
    TenantGuard,
    PermissionsGuard,
  ],
  // LOGGER_TOKEN must be exported, not merely provided: @Global() shares a
  // module's *exports* with the rest of the app, not its private providers.
  exports: [
    CONFIG_TOKEN,
    LOGGER_TOKEN,
    PrismaService,
    RedisService,
    RateLimitGuard,
    TenantGuard,
    PermissionsGuard,
  ],
})
export class CommonModule {}
