# Architecture decision records

One file per decision that was genuinely contested — where a competent engineer
could have chosen differently and the choice has consequences worth living
with.

Decisions that were obvious are not recorded here. An ADR for "we used
TypeScript" is filler; it hides the records that matter.

Each record states what would change our mind, because a decision you cannot
imagine revisiting is a belief, not a decision.

| #                                               | Decision                                                    | Status   |
| ----------------------------------------------- | ----------------------------------------------------------- | -------- |
| [0001](./0001-shared-schema-multi-tenancy.md)   | Shared-schema multi-tenancy                                 | Accepted |
| [0002](./0002-tenant-scoping-in-the-client.md)  | Tenant scoping in the Prisma client, not a repository layer | Accepted |
| [0003](./0003-opaque-sessions-not-jwt.md)       | Opaque session tokens rather than JWTs                      | Accepted |
| [0004](./0004-uuidv7-identifiers.md)            | UUIDv7 primary keys generated in the application            | Accepted |
| [0005](./0005-monorepo-with-shared-packages.md) | A monorepo with genuinely shared packages                   | Accepted |
| [0006](./0006-pagination-per-resource.md)       | Pagination strategy chosen per resource                     | Accepted |
