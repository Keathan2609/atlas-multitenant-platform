import pino, { type Logger, type LoggerOptions } from 'pino';
import { SENSITIVE_KEYS, redact } from './redaction.js';

/**
 * Structured logging for ATLAS.
 *
 * Every log line is JSON in production and human-readable in development. The
 * fields below are not decoration — they are what makes a production incident
 * answerable:
 *
 *   requestId       correlates every line produced by one HTTP request
 *   userId          who was acting
 *   organizationId  which tenant was affected — the first question in any
 *                   multi-tenant incident
 *
 * `console.log` is banned by lint (no-console) precisely so these fields
 * cannot be bypassed.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerConfig {
  level: LogLevel;
  /** `pretty` for local development, `json` for log ingestion. */
  format: 'pretty' | 'json';
  /** Emitted on every line so entries can be filtered per service. */
  service: string;
  environment: string;
}

/**
 * Pino's own redaction, expressed as paths.
 *
 * This is belt-and-braces alongside `redact()`. Pino's version is faster and
 * catches the common shapes; `redact()` handles the arbitrary-depth and
 * value-pattern cases Pino's path syntax cannot express (an API key echoed
 * inside a message string, for instance).
 */
function buildRedactPaths(): string[] {
  const containers = ['', 'req.body.', 'req.headers.', 'res.headers.', 'context.', 'metadata.'];
  const paths: string[] = [];
  for (const container of containers) {
    for (const key of SENSITIVE_KEYS) {
      paths.push(`${container}${key}`);
    }
  }
  // Header names are lowercased by Node, and these are the ones that actually
  // carry credentials.
  paths.push('req.headers["set-cookie"]', 'req.headers["x-api-key"]');
  return paths;
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: {
      service: config.service,
      environment: config.environment,
    },
    // ISO timestamps rather than epoch millis: logs are read by humans during
    // incidents at least as often as they are parsed by machines.
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: buildRedactPaths(),
      censor: '[redacted]',
      remove: false,
    },
    formatters: {
      // Emit `level: "info"` rather than `level: 30`. Most log backends group
      // on the string, and a numeric level is meaningless when read directly.
      level: (label) => ({ level: label }),
    },
    hooks: {
      logMethod(args, method) {
        // Deep-scrub the merge object before it reaches the transport. This is
        // what catches secrets that Pino's path-based redaction cannot see.
        if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
          args[0] = redact(args[0]) as never;
        }
        return method.apply(this, args as never);
      },
    },
  };

  if (config.format === 'pretty') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,environment',
          messageFormat: '{msg}',
        },
      },
    });
  }

  return pino(options);
}

/**
 * Fields attached to every line within one request.
 *
 * `organizationId` is optional because unauthenticated routes (login,
 * registration, health) have no tenant. Everything after the tenant guard
 * does, and its absence in an authenticated log line is itself a signal worth
 * noticing.
 */
export interface RequestLogContext {
  requestId: string;
  userId?: string;
  organizationId?: string;
  method?: string;
  path?: string;
  /** Set when the caller authenticated with an API key rather than a session. */
  apiKeyId?: string;
}

export function withRequestContext(logger: Logger, context: RequestLogContext): Logger {
  return logger.child(context);
}

export type { Logger };
