# 9. Shared packages emit CommonJS

**Status:** Accepted

## Context

The shared packages are consumed by two very different runtimes: a NestJS
application running compiled output on Node, and a Next.js application built by
a bundler. ESM is the direction of travel for the ecosystem and the obvious
default for a new project.

## Decision

`@atlas/types`, `@atlas/validation`, `@atlas/database` and
`@atlas/observability` compile to CommonJS. The web app consumes them through
`transpilePackages`.

## Consequences

NestJS is the binding constraint. It depends on `emitDecoratorMetadata` and on
`reflect-metadata`, and its whole dependency-injection model assumes the
CommonJS module graph. Publishing ESM to it means either dual builds or a set
of interop problems that surface at runtime rather than at compile time — and
this project has already paid for one of those: a
`createPrismaClient is not a function` failure that came from exactly this
mismatch.

The costs are real and recurring:

- **Two sets of import rules in one repository.** The API's relative imports
  carry `.js` extensions because Node's CommonJS resolution wants them; the web
  app's must not, because the bundler resolves `.tsx` and a `.js` suffix points
  at a file that does not exist. Getting this backwards is a whole class of
  error, and it has happened here.
- **`import.meta` is unavailable** in the shared packages, so anything needing
  a module path uses `process.cwd()` instead — see `packages/database/prisma.config.ts`.
- The packages are less reusable outside this repository than an ESM build
  would be.

This is recorded as a decision rather than an accident precisely because the
friction is ongoing: someone will eventually try to "fix" it by switching to
ESM, and should know what breaks.

## What would change our mind

- NestJS supporting ESM without the decorator-metadata caveats.
- A consumer outside this repository, which would make a dual build worth its
  complexity.
