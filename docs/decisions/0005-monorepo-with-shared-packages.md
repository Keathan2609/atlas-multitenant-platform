# 5. A monorepo with genuinely shared packages

**Status:** Accepted

## Context

An API and a web app that must agree about validation rules and about who is
allowed to do what. Separate repositories, or one.

## Decision

One repository: pnpm workspaces plus Turborepo, with four shared packages —
`@atlas/types`, `@atlas/validation`, `@atlas/database`, `@atlas/observability`.

## Consequences

The monorepo is justified by the sharing, not the other way round. Two packages
carry their weight immediately:

**`@atlas/types`** holds the RBAC matrix. One definition, two consumers. The
API uses it to decide what is _allowed_; the web app uses it to decide what to
_render_. Those are different jobs — only the first is a security control — but
they must agree, or the interface offers buttons that 403.

**`@atlas/validation`** holds the Zod schemas. The same schema validates the
form and the endpoint, so a field's rules cannot drift between them, and the
error messages a user sees are the ones the server would produce.

With separate repositories both of these become a published package with a
version number, and every rule change becomes a release plus a coordinated
upgrade. In practice they would drift.

The costs are real and were paid:

- **CommonJS versus ESM.** The shared packages emit CommonJS for NestJS, while
  the web app uses bundler resolution. That mismatch produced a
  `createPrismaClient is not a function` at runtime and a round of `.js`
  extension errors in the web imports. Different module systems, different
  rules, one repository — the friction is inherent.
- **Build orchestration.** `apps/web` cannot typecheck until `packages/types`
  has emitted. Turborepo's `dependsOn: ["^build"]` handles it, but the
  dependency is now something to reason about.
- **A shared toolchain** means one ESLint config and one TypeScript base for
  five very different packages, and getting that wrong breaks everything at
  once — as it did when a single `tsBuildInfoFile` in the shared base caused
  the API to build an empty `dist` while exiting 0.

## What would change our mind

- The web app and API being owned by different teams with different release
  cadences.
- A third consumer outside this repository needing the shared packages, which
  would make publishing them the honest answer.
