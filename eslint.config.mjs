import { baseConfig, prismaTenantSafetyConfig } from './packages/config/eslint/base.mjs';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/database/generated/**',
    ],
  },
  ...baseConfig,

  /*
   * The lint-level half of tenant isolation (docs/multi-tenancy.md).
   *
   * These rules were written, exported, and then never imported — so until now
   * they applied to no files at all. They are scoped to the places a Prisma
   * client is actually in scope: the API's source, and the database package
   * that defines the scoping extension itself.
   */
  {
    files: ['apps/api/src/**/*.ts', 'packages/database/src/**/*.ts'],
    ...prismaTenantSafetyConfig,
  },
];
