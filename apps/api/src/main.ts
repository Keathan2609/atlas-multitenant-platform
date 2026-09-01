import 'reflect-metadata';
import path from 'node:path';
// Type-only, so it is erased at compile time and creates no runtime require —
// which is the whole point of the lazy load below.
import type * as Dotenv from 'dotenv';

/**
 * Development environment file.
 *
 * Must run before anything reads process.env, hence its position above the
 * remaining imports. In production the environment comes from the orchestrator
 * — a container, a systemd unit, a platform's secret store — and no file is
 * read, which is why this is gated on NODE_ENV: a .env sitting on a production
 * host should never silently win over what the platform injected.
 *
 * dotenv does not overwrite variables that are already set, so an explicit
 * `DATABASE_URL=… pnpm dev` still takes precedence over the file.
 *
 * Required lazily, inside the gate, rather than imported at the top. dotenv is
 * a devDependency, so a production image built with `--prod` does not contain
 * it — and a static import is resolved regardless of any runtime condition.
 * The first version of this used one, and the container crashed on boot with
 * "Cannot find module 'dotenv'" while the build itself passed cleanly.
 */
if (process.env.NODE_ENV !== 'production') {
  // cwd is apps/api under `nest start`; the file lives at the repository root
  // so one .env serves the API, the seed script, and the integration suite.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { config: loadDotenv } = require('dotenv') as typeof Dotenv;
  loadDotenv({ path: path.resolve(process.cwd(), '../../.env') });
}

import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Logger } from '@atlas/observability';
import { AppModule } from './app.module.js';
import { CONFIG_TOKEN, type AppConfig } from './config/env.js';
import { LOGGER_TOKEN } from './common/logging/logger.provider.js';

async function bootstrap(): Promise<void> {
  // Config is validated inside CommonModule's factory, so an invalid
  // environment fails here, before the server binds a port.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Application logging goes through Pino. Nest's own logger is kept at
    // error/warn only so bootstrap failures — a DI resolution error, a bad
    // port bind — are still printed. Setting `logger: false` silences those,
    // and Nest's default abortOnError then exits the process with no output
    // at all, which is close to undebuggable.
    logger: ['error', 'warn'],
  });

  const config = app.get<AppConfig>(CONFIG_TOKEN);
  const logger = app.get<Logger>(LOGGER_TOKEN);

  /**
   * Trust exactly as many proxy hops as are actually deployed.
   *
   * Driven by TRUST_PROXY and defaulting to 0, because the failure is silent
   * and one-directional: trusting a hop that does not exist lets any client
   * supply its own X-Forwarded-For, and Express then reports that value as
   * req.ip. req.ip is the login rate-limit bucket key and the address stored
   * on sessions and audit entries, so an over-trusting setting converts a
   * bounded brute-force budget into an unlimited one and lets an attacker
   * write a false origin into the audit trail.
   *
   * Verified before this was fixed: after the login budget returned 429,
   * three forged X-Forwarded-For values each restored a fresh budget.
   *
   * Deployments behind a load balancer set TRUST_PROXY to the hop count.
   */
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    helmet({
      // The API serves JSON, never HTML, so a restrictive CSP costs nothing
      // and removes the browser's ability to execute anything if a response
      // is ever mistakenly rendered.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      // Irrelevant for a JSON API and known to break Swagger UI's assets.
      crossOriginEmbedderPolicy: false,
    }),
  );

  // The secret enables signed cookies; see modules/auth/cookies.ts for what
  // signing does and does not buy here.
  app.use(cookieParser(config.SESSION_SECRET));

  /**
   * CORS with credentials.
   *
   * `credentials: true` is required for the session cookie to travel, and it
   * is precisely why the origin list must be explicit — the spec forbids
   * combining credentials with a wildcard, and permitting one would let any
   * site read authenticated responses.
   */
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 86400,
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // 100kb is generous for the largest legitimate payload here (a work-item
  // description) and small enough that a body-size flood is cheap to reject.
  app.useBodyParser('json', { limit: '100kb' });

  // OpenAPI is exposed outside production only. In production it would
  // advertise the full attack surface, including endpoints a given caller has
  // no business knowing about.
  if (!config.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('ATLAS API')
        .setDescription(
          'Operations infrastructure for modern teams. ' +
            'Session-cookie auth for the web app; bearer API keys for machine access.',
        )
        .setVersion('1.0')
        .addCookieAuth('atlas_session', { type: 'apiKey', in: 'cookie', name: 'atlas_session' })
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', description: 'An ATLAS API key (atlas_live_...)' },
          'apiKey',
        )
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Lets Kubernetes drain connections gracefully instead of severing in-flight
  // requests on SIGTERM.
  app.enableShutdownHooks();

  await app.listen(config.API_PORT, config.API_HOST);

  logger.info(
    {
      event: 'api.started',
      port: config.API_PORT,
      environment: config.NODE_ENV,
      docs: config.isProduction ? null : `http://localhost:${config.API_PORT}/api/docs`,
    },
    'ATLAS API listening',
  );
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet if config validation failed, so this one
  // place legitimately writes to stderr directly.
  console.error('Failed to start ATLAS API:', error);
  process.exit(1);
});
