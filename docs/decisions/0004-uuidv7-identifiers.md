# 4. UUIDv7 primary keys, generated in the application

**Status:** Accepted

## Context

Primary keys for fourteen models, two of which are append-heavy
(`audit_logs`, `work_items`). Candidates:

1. `bigserial` — small, ordered, database-generated.
2. UUIDv4 — globally unique, unguessable, random.
3. UUIDv7 — globally unique, unguessable, time-ordered.

## Decision

UUIDv7, generated in application code (`packages/database/src/id.ts`).

## Consequences

`bigserial` was rejected because sequential integers are enumerable. A project
at `/projects/41` invites a request for `/projects/42`, and while the tenant
guard refuses it, the id itself leaks how many rows exist platform-wide. It
also requires a database round trip before an entity has an identity.

UUIDv4 fixes both and costs write throughput: random keys scatter across the
B-tree, so every insert dirties a different page. On append-heavy tables that
is the difference between writing to the hot end of an index and writing
everywhere.

UUIDv7 keeps unguessability and adds two things:

- **Insert locality.** Time-ordered high bits mean sequential inserts land on
  adjacent pages.
- **A free chronological cursor.** `ORDER BY id DESC` _is_ `ORDER BY created_at
DESC`, with no tiebreaker column. Audit-log cursor pagination is therefore a
  single-column index scan. See [api.md § pagination](../api.md#-pagination).

Generating in the application rather than the database means an entity has its
id before it is persisted, so a service can build a whole object graph and
write it in one transaction without round-tripping for keys. Organization
creation does exactly that: organization, owner membership, settings, default
workspace and audit entry, in one statement batch.

The cost is that ids **leak approximate creation time**. For this product that
is not sensitive — anyone who can read a work item can already see its
`createdAt`. For a product where creation time is confidential, this is the
wrong choice and UUIDv4 is correct.

## What would change our mind

- Creation timestamps becoming confidential.
- A dependency conflict making a maintained UUIDv7 implementation unavailable —
  though Postgres 18's native `uuidv7()` would then be the answer, moving
  generation back into the database.
