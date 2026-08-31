import { z } from 'zod';

/**
 * Environment contract.
 *
 * Parsed once at boot. If anything is missing or malformed the process exits
 * before it accepts a connection, rather than throwing on the first request
 * that happens to need the value. A service that starts and then 500s on
 * login because SESSION_SECRET was absent is strictly worse than one that
 * refuses to start and says so.
 */

const nonEmpty = (name: string) => z.string().min(1, `${name} is required.`);

/**
 * Secrets have a hard minimum length. The default values shipped in
 * .env.example are explicitly rejected in production, so a deployment that
 * forgot to set real secrets fails loudly instead of running on a value that
 * is public in the repository.
 */
const DEV_PLACEHOLDER_PATTERN = /^dev_only_/;

const secretSchema = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters.`);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: nonEmpty('DATABASE_URL').url('DATABASE_URL must be a valid connection URL.'),
    REDIS_URL: nonEmpty('REDIS_URL').url('REDIS_URL must be a valid connection URL.'),

    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    API_HOST: z.string().default('0.0.0.0'),

    // Comma-separated. Parsed into an array below; an empty list means no
    // browser origin may send credentialed requests, which is the safe default
    // for a misconfiguration.
    CORS_ORIGINS: z.string().default('http://localhost:3000'),

    SESSION_SECRET: secretSchema('SESSION_SECRET'),
    SESSION_TTL_SECONDS: z.coerce.number().int().min(300).default(604800),
    API_KEY_PEPPER: secretSchema('API_KEY_PEPPER'),

    RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().min(1).default(300),
    RATE_LIMIT_API_MAX: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_API_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

    EMAIL_TRANSPORT: z.enum(['smtp', 'console', 'noop']).default('console'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    EMAIL_FROM: z.string().default('ATLAS <no-reply@atlas.local>'),

    APP_BASE_URL: nonEmpty('APP_BASE_URL').url('APP_BASE_URL must be a valid URL.'),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_FORMAT: z.enum(['pretty', 'json']).default('json'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;

    // Placeholder secrets are fine locally and unacceptable in production.
    // Checked here rather than in the individual schemas so the rule reads as
    // one production-hardening block.
    for (const key of ['SESSION_SECRET', 'API_KEY_PEPPER'] as const) {
      if (DEV_PLACEHOLDER_PATTERN.test(env[key])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} still holds the development placeholder from .env.example. Generate a real secret.`,
        });
      }
    }

    if (env.LOG_FORMAT === 'pretty') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOG_FORMAT'],
        message: 'LOG_FORMAT must be "json" in production so logs are machine-parseable.',
      });
    }

    if (env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message:
          'A wildcard CORS origin cannot be combined with credentialed requests. List explicit origins.',
      });
    }
  });

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig extends Omit<RawEnv, 'CORS_ORIGINS'> {
  corsOrigins: string[];
  isProduction: boolean;
  isTest: boolean;
}

/**
 * Validates `process.env` and returns typed configuration.
 *
 * Throws with every problem listed at once rather than the first one, so a
 * misconfigured deployment is fixed in one pass instead of restart-by-restart.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${problems}\n\n` +
        'See .env.example for the full contract.',
    );
  }

  const { CORS_ORIGINS, ...rest } = result.data;

  return {
    ...rest,
    corsOrigins: CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    isProduction: rest.NODE_ENV === 'production',
    isTest: rest.NODE_ENV === 'test',
  };
}

export const CONFIG_TOKEN = Symbol('ATLAS_CONFIG');
