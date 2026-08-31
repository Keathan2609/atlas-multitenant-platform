import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests: pure logic, no I/O, no database.
 *
 * SWC rather than esbuild because NestJS relies on `emitDecoratorMetadata`,
 * which esbuild does not implement — without it every constructor-injected
 * dependency resolves as undefined.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    globals: true,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
