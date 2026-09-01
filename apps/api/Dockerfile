# syntax=docker/dockerfile:1

###############################################################################
# ATLAS API
#
# Multi-stage, and the stages exist for two different reasons. `deps` and
# `build` exist so the final image carries no compiler, no source, and no dev
# dependencies. `prod-deps` exists separately from `deps` because installing
# production dependencies from a lockfile that has already been resolved is far
# cheaper than pruning a full install.
#
# Built from the repository root, not this directory:
#     docker build -f apps/api/Dockerfile .
# The build needs the workspace manifests and the shared packages, and a
# Dockerfile cannot reach above its context.
###############################################################################

ARG NODE_VERSION=22-alpine

# ── Base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ── Dependencies ─────────────────────────────────────────────────────────────
# Only the manifests are copied first, so this layer is cached until a
# dependency actually changes — editing a source file must not reinstall
# node_modules.
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
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages ./packages
COPY . .

# Prisma's client is generated code, not a published artifact, so it has to be
# produced before anything that imports it can compile.
RUN pnpm --filter @atlas/database exec prisma generate
RUN pnpm --filter @atlas/api... build

# ── Production dependencies ──────────────────────────────────────────────────
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/config/package.json packages/config/
COPY packages/types/package.json packages/types/
COPY packages/validation/package.json packages/validation/
COPY packages/database/package.json packages/database/
COPY packages/observability/package.json packages/observability/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @atlas/api...

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime

# dumb-init, because Node as PID 1 does not reap zombies and does not forward
# SIGTERM to its children — which would defeat the graceful shutdown the
# application implements.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Never root. The base image ships a `node` user; use it rather than creating
# another.
USER node

# The hoisted store, plus each workspace package's own node_modules. pnpm puts
# a symlink farm in every package pointing into /app/node_modules/.pnpm, so
# both halves are needed and the absolute paths must match — copying only the
# root leaves @atlas/observability unable to resolve pino, and the container
# dies at boot with a stack trace that names the wrong layer.
#
# The whole packages/ tree is copied rather than each node_modules by name,
# because a package with no *production* dependencies gets no node_modules at
# all and naming it fails the build. At this point the tree holds nothing but
# manifests and dependencies; the built output is overlaid below.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps --chown=node:node /app/packages ./packages

COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/

COPY --from=build --chown=node:node /app/packages/types/dist ./packages/types/dist
COPY --from=build --chown=node:node /app/packages/types/package.json ./packages/types/
COPY --from=build --chown=node:node /app/packages/validation/dist ./packages/validation/dist
COPY --from=build --chown=node:node /app/packages/validation/package.json ./packages/validation/
COPY --from=build --chown=node:node /app/packages/observability/dist ./packages/observability/dist
COPY --from=build --chown=node:node /app/packages/observability/package.json ./packages/observability/
COPY --from=build --chown=node:node /app/packages/database/dist ./packages/database/dist
COPY --from=build --chown=node:node /app/packages/database/package.json ./packages/database/

# The generated Prisma client. See apps/api/prisma-client.sh for why this is a
# script rather than a COPY.
COPY --from=build --chown=node:node /app/node_modules/.pnpm/@prisma+client*/node_modules/.prisma /tmp/prisma-client
COPY --chown=node:node apps/api/prisma-client.sh /tmp/prisma-client.sh
RUN sh /tmp/prisma-client.sh /tmp/prisma-client && rm -f /tmp/prisma-client.sh

# The schema and migrations travel with the image so a release can run
# `prisma migrate deploy` against the database it was built for, rather than
# depending on a separately-versioned copy.
COPY --from=build --chown=node:node /app/packages/database/prisma ./packages/database/prisma

EXPOSE 4000

# Liveness only. A readiness check belongs to the orchestrator, which can drain
# traffic; Docker's HEALTHCHECK would restart the container instead, turning a
# brief database blip into an outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
