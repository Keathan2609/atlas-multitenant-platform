# syntax=docker/dockerfile:1

###############################################################################
# ATLAS web
#
# Uses Next's standalone output, which traces the modules the server actually
# imports and emits a self-contained bundle. Without it, shipping a Next app
# from a pnpm workspace means copying a symlinked node_modules tree that is
# both enormous and fragile.
#
# Built from the repository root:
#     docker build -f apps/web/Dockerfile .
###############################################################################

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ── Dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/types/package.json packages/types/
COPY packages/validation/package.json packages/validation/
COPY packages/database/package.json packages/database/
COPY packages/observability/package.json packages/observability/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── Build ────────────────────────────────────────────────────────────────────
FROM base AS build

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, not
# read at runtime. That means this image is specific to the API origin it was
# built against, and a different environment needs a different build — which is
# a property of Next, not a choice made here, and worth knowing before someone
# tries to promote one image between environments.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Opt into the standalone bundle. Off by default in next.config.mjs because it
# requires symlink creation, which needs elevation on Windows.
ENV NEXT_OUTPUT=standalone
ENV NEXT_TELEMETRY_DISABLED=1
# Explicitly production: `next build` under a development NODE_ENV fails while
# prerendering the error page, with a message that points nowhere near the
# cause.
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages ./packages
COPY . .

RUN pnpm --filter @atlas/web... build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

WORKDIR /app
USER node

# The standalone bundle carries its own minimal node_modules, but not the
# static assets — those are served from disk and have to be copied alongside.
#
# There is deliberately no `public/` copy: this application has no public
# directory, and COPYing a path that does not exist fails the build. Add one
# here if static files are ever introduced.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
