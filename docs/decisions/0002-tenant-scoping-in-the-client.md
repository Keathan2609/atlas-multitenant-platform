# 2. Tenant scoping in the Prisma client, not a repository layer

**Status:** Accepted

## Context

Given [ADR 1](./0001-shared-schema-multi-tenancy.md), something has to
guarantee that `organizationId` appears in every query against a tenant-owned
model. Composite foreign keys constrain _relationships_, but they do nothing
about a bare read:

```ts
prisma.project.findFirst({ where: { id } }); // valid SQL, wrong tenant
```

Options considered:

1. **Convention plus code review.** Every service remembers the predicate.
2. **A repository layer.** One class per model, wrapping Prisma, adding the
   predicate.
3. **A Prisma client extension** intercepting `$allOperations`.
4. **Postgres row-level security**, with the tenant set as a session variable.

## Decision

A Prisma client extension. `forOrganization(prisma, organizationId)` returns a
client that injects `organizationId` into the `where` of every read and the
`data` of every write, for every model in `TENANT_OWNED_MODELS`.

## Consequences

Convention was rejected outright: the failure is silent, and the reviewer who
has to notice a missing line in a fifty-line service will eventually not.

A repository layer would need one wrapper method per model per operation, and
the guarantee would still depend on developers choosing the wrapper over the
raw client — the same discipline problem, one level up, plus a large surface of
hand-written pass-throughs that lose Prisma's type inference.

Row-level security is the strongest option and was the closest call. It was
rejected because the enforcement point moves into the database session, which
means the guarantee depends on every connection in the pool having the right
variable set at the right time — including connections handed out mid-request
by a pooler. When that goes wrong it goes wrong invisibly. RLS is also awkward
to test in the same process as the application, and it does not travel with the
ORM's type system.

The extension has a real cost: it is a layer of indirection that a newcomer
does not expect, and `$allOperations` is untyped across models so the
implementation carries one `any` and a narrowing check. In exchange, a scoped
client **cannot express** a cross-tenant query, and getting the unscoped client
requires asking for it by name — which is greppable, lint-enforced, and
enumerated in the docs.

Two failures this has already caught in review: `MembersService` and
`InvitationsService` each opened a `$transaction` on the _unscoped_ client,
discarding the layer for everything inside. Both are fixed; the scoped client
propagates into `tx`.

## What would change our mind

- Prisma removing or destabilising client extensions.
- A second consumer of the database that is not this application — a reporting
  service, a data pipeline — at which point enforcement belongs in the database
  and RLS becomes correct.
