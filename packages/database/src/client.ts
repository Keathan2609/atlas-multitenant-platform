import { PrismaClient } from '@prisma/client';

export type { Prisma } from '@prisma/client';
export * from '@prisma/client';

/**
 * Prisma client factory.
 *
 * In development the Next.js/Nest dev servers re-evaluate modules on reload.
 * Constructing a new PrismaClient each time exhausts the Postgres connection
 * limit within a few dozen saves, so the instance is cached on globalThis —
 * the standard Prisma guidance. Production gets a single fresh instance
 * because the process is not hot-reloaded.
 */
const globalForPrisma = globalThis as unknown as {
  atlasPrisma: PrismaClient | undefined;
};

export interface PrismaFactoryOptions {
  databaseUrl?: string;
  /** Emit query events. Wired to the structured logger by the API. */
  logQueries?: boolean;
}

export function createPrismaClient(options: PrismaFactoryOptions = {}): PrismaClient {
  return new PrismaClient({
    ...(options.databaseUrl ? { datasources: { db: { url: options.databaseUrl } } } : {}),
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });
}

export function getPrismaClient(options: PrismaFactoryOptions = {}): PrismaClient {
  if (process.env.NODE_ENV === 'production') {
    return createPrismaClient(options);
  }
  globalForPrisma.atlasPrisma ??= createPrismaClient(options);
  return globalForPrisma.atlasPrisma;
}
