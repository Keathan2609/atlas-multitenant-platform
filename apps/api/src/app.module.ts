import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CommonModule } from './common/common.module.js';
import { AllExceptionsFilter } from './common/errors/exception.filter.js';
import { RequestContextMiddleware } from './common/logging/request-context.middleware.js';
import { AuthGuard } from './modules/auth/auth.guard.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';

@Module({
  imports: [CommonModule, AuthModule, HealthModule],
  providers: [
    // Global filter: every error leaves through one place, so no handler can
    // accidentally return an unshaped body or leak an internal message.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Global guard: routes are authenticated by default and must opt out with
    // @Public(). Forgetting a decorator locks a route down rather than
    // exposing it.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
