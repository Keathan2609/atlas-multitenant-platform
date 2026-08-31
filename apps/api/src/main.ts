import 'reflect-metadata';
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
   * Trust exactly one proxy hop.
   *
   * `true` would trust the entire X-Forwarded-For chain, letting any client
   * prepend a fake address and hand itself a fresh rate-limit bucket on every
   * request. `1` trusts only the hop we actually deploy behind.
   */
  app.set('trust proxy', 1);

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

  app.use(cookieParser());

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
  // eslint-disable-next-line no-console
  console.error('Failed to start ATLAS API:', error);
  process.exit(1);
});
