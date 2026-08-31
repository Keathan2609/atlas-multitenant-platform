import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CommonModule } from './common/common.module.js';
import { AllExceptionsFilter } from './common/errors/exception.filter.js';
import { RequestContextMiddleware } from './common/logging/request-context.middleware.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuditModule } from './common/audit/audit.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { MembersModule } from './modules/members/members.module.js';
import { WorkspacesModule } from './modules/workspaces/workspaces.module.js';
import { TeamsModule } from './modules/teams/teams.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { WorkItemsModule } from './modules/work-items/work-items.module.js';
import { EmailModule } from './common/email/email.module.js';
import { ApiKeysModule } from './modules/api-keys/api-keys.module.js';
import { ApiKeyGuard } from './modules/api-keys/api-key.guard.js';
import { InvitationsModule } from './modules/invitations/invitations.module.js';
import { AuditLogModule } from './modules/audit/audit-log.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';

@Module({
  imports: [
    CommonModule,
    AuditModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    MembersModule,
    WorkspacesModule,
    TeamsModule,
    ProjectsModule,
    WorkItemsModule,
    EmailModule,
    ApiKeysModule,
    InvitationsModule,
    AuditLogModule,
    SettingsModule,
  ],
  providers: [
    // Global filter: every error leaves through one place, so no handler can
    // accidentally return an unshaped body or leak an internal message.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Guard order is load-bearing. ApiKeyGuard runs first and populates
    // request.apiKeyContext; AuthGuard's first act is to check that field and
    // skip cookie handling when it is set. Reversed, every API-key request
    // would be rejected as anonymous before the key was ever examined.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    // Routes are authenticated by default and must opt out with @Public().
    // Forgetting a decorator locks a route down rather than exposing it.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
