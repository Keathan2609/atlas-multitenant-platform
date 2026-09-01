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
              // Escaping the package, not merely climbing inside it. `../../*`
              // was the original pattern and it condemned every ordinary
              // intra-package import — `../../common/errors/app-error.js` from
              // a controller is the convention here, not a violation. What
              // actually breaks the boundary is a relative path that reaches
              // back down into another workspace package.
              group: ['../**/packages/**', '../**/apps/**'],
              message:
                'Reach across package boundaries with the @atlas/* workspace alias, not a relative path.',
            },
            {
              // Importing a sibling's build output couples to an artefact that
              // may not exist yet and skips the type source entirely.
              group: ['**/dist/**'],
              message: 'Import from the package entry point, not its build output.',
            },
          ],
        },
      ],
    },
  },
  prettier,
];

/*
 * Tenant-safety rules — the lint-level half of the strategy in
 * docs/multi-tenancy.md, and the third layer behind the composite foreign keys
 * and the scoped Prisma client.
 *
 * The selector is deliberately narrow, because a rule that fires on correct
 * code is a rule that gets disabled wholesale, taking the real protection with
 * it. It matches only the intersection that is genuinely dangerous:
 *
 *   - the *unscoped* client. `forTenant()` returns a client whose extension
 *     injects organizationId into every query, so `db.project.findFirst()` is
 *     safe by construction — and it is the very remedy this rule recommends.
 *   - a *tenant-owned* model. User, Session and Organization are global by
 *     design (see NON_TENANT_MODELS in @atlas/database); demanding an
 *     organizationId on a login lookup would be nonsense.
 *   - a `where` with no organizationId, on a read that returns a single row.
 *
 * What survives is the real hazard: reaching a tenant's row through the
 * unscoped client on a bare id or unique column. The two legitimate cases —
 * resolving an API key or an invitation token, where the credential *is* the
 * claim and the tenant is not yet known — carry an inline disable naming the
 * reason, which is exactly the point: each escape hatch is visible in the code
 * rather than buried in a commit message.
 */
const TENANT_OWNED_ACCESSORS = [
  'organizationMembership',
  'organizationSettings',
  'team',
  'teamMembership',
  'workspace',
  'project',
  'projectMembership',
  'workItem',
  'auditLog',
  'apiKey',
  'invitation',
].join('|');

const unscopedTenantRead = (method) =>
  `CallExpression[callee.property.name='${method}']` +
  `[callee.object.object.property.name='unscoped']` +
  `[callee.object.property.name=/^(${TENANT_OWNED_ACCESSORS})$/]` +
  ` > ObjectExpression > Property[key.name='where']` +
  ` > ObjectExpression:not(:has(Property[key.name='organizationId']))`;

export const prismaTenantSafetyConfig = {
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: unscopedTenantRead('findUnique'),
        message:
          'findUnique() on a tenant-owned model through the unscoped client bypasses tenant scoping. Use prisma.forTenant(organizationId), or include organizationId in the where clause. See docs/multi-tenancy.md.',
      },
      {
        selector: unscopedTenantRead('findFirst'),
        message:
          'findFirst() on a tenant-owned model through the unscoped client bypasses tenant scoping. Use prisma.forTenant(organizationId), or include organizationId in the where clause. See docs/multi-tenancy.md.',
      },
      {
        selector: "CallExpression[callee.property.name='$queryRawUnsafe']",
        message: '$queryRawUnsafe permits SQL injection. Use $queryRaw with a tagged template.',
      },
    ],
  },
};

export default baseConfig;
