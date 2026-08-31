import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Shared ESLint baseline for every ATLAS package.
 *
 * The `no-restricted-syntax` rules below are load-bearing, not style rules:
 * they are the lint-level half of the tenant-isolation strategy documented in
 * docs/multi-tenancy.md. Prisma's `findUnique`/`findFirst` accept a bare `id`,
 * which silently crosses tenant boundaries. Tenant-owned models must be read
 * through the scoped repository helpers instead.
 */
export const baseConfig = [
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../*'],
              message:
                'Reach across package boundaries with the @atlas/* workspace alias, not a relative path.',
            },
          ],
        },
      ],
    },
  },
  prettier,
];

/** Rules that only make sense where a Prisma client is in scope. */
export const prismaTenantSafetyConfig = {
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "CallExpression[callee.property.name='findUnique'] > ObjectExpression > Property[key.name='where'] > ObjectExpression:not(:has(Property[key.name='organizationId']))",
        message:
          'findUnique() on a tenant-owned model bypasses tenant scoping. Use the scoped repository (TenantScope) or include organizationId in the where clause. See docs/multi-tenancy.md.',
      },
      {
        selector: "CallExpression[callee.property.name='$queryRawUnsafe']",
        message: '$queryRawUnsafe permits SQL injection. Use $queryRaw with a tagged template.',
      },
    ],
  },
};

export default baseConfig;
