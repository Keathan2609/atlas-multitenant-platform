import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma configuration.
 *
 * Replaces the deprecated `package.json#prisma` block (removed in Prisma 7).
 *
 * The .env lives at the repository root while the Prisma CLI runs with its cwd
 * set to this package, so a bare `dotenv/config` would look in the wrong
 * directory and leave DATABASE_URL undefined. `process.cwd()` is used rather
 * than `import.meta.url` because this package emits CommonJS — see
 * docs/decisions/008-module-format.md — and import.meta is not available there.
 *
 * `override: false` means a variable already exported in the shell — how CI
 * and the integration suite inject TEST_DATABASE_URL — still wins over the file.
 */
dotenv.config({ path: path.resolve(process.cwd(), '../../.env'), override: false });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx src/seed/index.ts',
  },
});
