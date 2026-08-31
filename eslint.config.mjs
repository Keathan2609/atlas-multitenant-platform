import { baseConfig } from './packages/config/eslint/base.mjs';

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
];
