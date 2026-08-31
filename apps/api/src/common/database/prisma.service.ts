import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  assertTenantModelCoverage,
  createPrismaClient,
  forOrganization,
  type PrismaClient,
  type ScopedPrismaClient,
} from '@atlas/database';
import type { Logger } from '@atlas/observability';
import { CONFIG_TOKEN, type AppConfig } from '../../config/env.js';
import { LOGGER_TOKEN } from '../logging/logger.provider.js';

/**
 * Owns the Prisma connection and hands out tenant-scoped clients.
 *
 * Services never receive the raw client through DI. They ask for a scoped one
 * via `forTenant(organizationId)`, which returns a client that cannot read or
 * write another organization's rows. The unscoped client is available as
 * `unscoped` for the handful of genuinely global operations — authentication,
 * organization creation, and the org switcher's membership lookup — each of
 * which is individually reviewed in docs/multi-tenancy.md.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly unscoped: PrismaClient;

  constructor(
    @Inject(CONFIG_TOKEN) config: AppConfig,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {
    this.unscoped = createPrismaClient({
      databaseUrl: config.DATABASE_URL,
      logQueries: config.LOG_LEVEL === 'trace',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.unscoped.$connect();

    // Fails boot if a schema model is neither declared tenant-owned nor
    // explicitly excluded. Adding a table and forgetting to scope it becomes a
    // startup error rather than a silent cross-tenant leak.
    assertTenantModelCoverage(this.unscoped);

    this.logger.info({ event: 'database.connected' }, 'Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.unscoped.$disconnect();
  }

  /**
   * A Prisma client permanently bound to one organization.
   *
   * A tenant mismatch is escalated as a security event before it throws — if
   * application code ever asks a scoped client for another tenant's data, that
   * is worth an alert, not just a stack trace.
   */
  // Explicit return type: the inferred one names a path inside Prisma's
  // generated runtime, which TS refuses to emit as portable (TS2742).
  forTenant(organizationId: string): ScopedPrismaClient {
    return forOrganization(this.unscoped, organizationId, {
      onTenantMismatch: (details) => {
        this.logger.error(
          { event: 'security.tenant_scope_violation', ...details },
          'Tenant scope violation blocked',
        );
        throw new Error(
          `Tenant scope violation on ${details.model}.${details.operation}`,
        );
      },
    });
  }

  /** Liveness probe for the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.unscoped.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
