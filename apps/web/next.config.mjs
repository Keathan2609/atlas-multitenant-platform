import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared packages ship TypeScript-built CommonJS; Next must compile them
  // rather than treat them as pre-built external ESM.
  transpilePackages: ['@atlas/types', '@atlas/validation'],
  // Pinned to the monorepo root. Next otherwise walks up looking for a lockfile
  // and finds an unrelated one in the user's home directory, which makes it
  // trace files from the wrong tree.
  outputFileTracingRoot: path.join(here, '..', '..'),
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
};

export default nextConfig;
