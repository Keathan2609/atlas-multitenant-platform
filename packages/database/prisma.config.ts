import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

const packageDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Prisma configuration.
 *
 * Replaces the deprecated `package.json#prisma` block (removed in Prisma 7).
 *
 * The .env lives at the repository root, but the Prisma CLI runs with its cwd
 * set to this package, so a bare `dotenv/config` would look in the wrong
 * directory and silently leave DATABASE_URL undefined. Resolve it explicitly
 * relative to this file. `override: false` means a variable already exported
 * in the shell — how CI and the integration suite inject TEST_DATABASE_URL —
 * still wins over the file.
 */
dotenv.config({ path: path.resolve(packageDir, '../../.env'), override: false });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx src/seed/index.ts',
  },
});
