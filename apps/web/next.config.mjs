import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output is opt-in, via NEXT_OUTPUT=standalone, and only the
  // Docker build sets it.
  //
  // It emits a self-contained server bundle containing just the modules the
  // server actually imports, which is what makes a small image possible out of
  // a pnpm workspace — the alternative is copying a symlinked node_modules
  // tree that is both enormous and fragile.
  //
  // It is not the default because producing that bundle means creating
  // symlinks, and on Windows that needs elevation or Developer Mode. Enabled
  // unconditionally, `pnpm build` fails with EPERM for any developer without
  // it — which is how this comment came to be written.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' } : {}),
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
