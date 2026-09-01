# API

A JSON HTTP API served by NestJS. Interactive documentation is generated from
the code and available at `/api/docs` outside production — this document covers
the conventions the generated reference cannot explain.

## Shape

Everything lives under `/api/v1`. Versioning is URI-based, which is the
coarsest option and the one that survives a client that will not be redeployed
in step with the server.

Tenant-scoped resources are nested under the organization slug:

```
/api/v1/organizations/:orgSlug/projects
/api/v1/organizations/:orgSlug/work-items/:workItemId
```

The slug in the path is the only place a tenant is named. It is a claim, not a
credential — see [multi-tenancy.md](./multi-tenancy.md#layer-3--the-tenant-is-resolved-never-accepted).

Non-tenant resources sit at the root: `/auth/*`, `/organizations` (the list you
belong to), `/health/*`.

## Authentication

Two mechanisms, resolved by the same guard chain and producing the same tenant
context.

**Session cookie** — for the web app. Established by `POST /auth/login` or
`POST /auth/register`, which set an httpOnly session cookie and return a CSRF
token. Every non-safe method must echo that token in `x-csrf-token`.

**Bearer API key** — for scripts and services.

```
Authorization: Bearer atlas_live_...
```

API keys act as `VIEWER` regardless of who created them, and the organization
slug in the URL must match the one the key was issued for. Both constraints are
deliberate; see [security.md](./security.md#credential-storage).

Guard order is load-bearing: `ApiKeyGuard` runs before `AuthGuard`, because
`AuthGuard` checks for an API-key context first. Reversed, every key request
would be rejected as anonymous. A malformed `Authorization` header fails rather
than falling through to cookies, which would let a caller probe keys while
quietly authenticating as someone else.

Routes are authenticated by default. `@Public()` is the opt-out, so forgetting
a decorator locks a route down rather than exposing it.

## Errors

One envelope, from one exception filter, for every failure:

```json
{
  "error": {
    "code": "INSUFFICIENT_PERMISSIONS",
    "message": "Your role does not permit this action.",
    "requestId": "01a05919-d531-7d7c-b380-7502976a7772",
    "details": [{ "field": "email", "message": "Enter an email address." }]
  }
}
```

`status` says what kind of failure it is. `code` is a stable machine-readable
discriminator — clients branch on it, never on message text. `message` is
written for a person and is safe to display. `requestId` correlates with server
logs. `details` appears on validation failures and maps errors onto the fields
that caused them, which is what lets the web app attach a server message to the
exact input that produced it.

The taxonomy is specific where specificity helps a client (`LAST_OWNER`,
`PROJECT_KEY_TAKEN`, `CANNOT_MODIFY_SELF`) and deliberately vague where it
would leak (`NOT_FOUND` covers both "does not exist" and "exists in another
tenant" — see [security.md § IDOR](./security.md#-idor)).

| Status | When                                                       |
| ------ | ---------------------------------------------------------- |
| 400    | Malformed request — unparseable body, bad query shape      |
| 401    | No credential, or an invalid one                           |
| 403    | Authenticated, but not permitted; also a failed CSRF check |
| 404    | Not found, or not yours                                    |
| 409    | Conflict — slug taken, already a member                    |
| 422    | Validation failed; `details` is populated                  |
| 429    | Rate limited; `Retry-After` is set                         |
| 500    | Unhandled. Never carries an internal message               |

Note 422 versus 403 ordering: guards run before pipes, so an unauthorised
caller sending an invalid body gets 403, not 422. Their payload is never
parsed. That ordering is intentional.

## Validation

Request bodies are validated by Zod schemas from `@atlas/validation`, the same
package the web forms use. One definition, two consumers — a field cannot drift
between the form and the endpoint.

Every schema is `.strict()`. An unknown key is rejected outright rather than
stripped, which is what makes mass assignment a 422 instead of a silent
no-op — a smuggled `role` or `id` fails the whole request.

## § pagination

Two strategies, chosen per resource rather than standardised for the sake of it.

**Offset pagination** — projects, work items, members.

```
?page=2&pageSize=25
```

```json
{ "data": [...], "pagination": { "page": 2, "pageSize": 25, "total": 137, "totalPages": 6 } }
```

These lists are presented as numbered pages with a total count, users jump
around them, and they are small enough per tenant that deep-page cost never
becomes a problem.

**Cursor pagination** — the audit log.

```
?cursor=01a05919-d531-7d7c-b380-7502976a7772&limit=50
```

The audit log is append-heavy and read newest-first. Offset pagination would
drift as rows arrive — page 2 re-showing rows that page 1 already displayed —
and gets slower the deeper you page, because the database still reads every row
it discards.

The cursor is an id, which works as a chronological cursor only because ATLAS
ids are UUIDv7 and therefore time-ordered. `ORDER BY id DESC` needs no
tiebreaker column. See [database.md § identifiers](./database.md#identifiers).

## Sorting and filtering

List endpoints accept `sortBy` and `sortDirection`, validated against an
explicit enum per resource — never an arbitrary column name, which would be
both an injection surface and an unbounded index requirement.

Filters are resource-specific and combine with AND. Two convenience values are
resolved server-side on work items: `assigneeId=me` and
`assigneeId=unassigned`.

## Idempotency and concurrency

Not every write is idempotent, and the ones that need protection get it
explicitly rather than through a general mechanism:

- **Role changes and member removals** run at `Serializable` isolation, so
  concurrent demotions cannot both pass a last-owner check.
- **Invitation acceptance** re-reads the invitation's status inside the
  transaction that consumes the token, so a concurrent request cannot redeem it
  twice.
- **Work-item numbering** allocates from a per-project counter inside the
  creating transaction. The integration suite asserts gapless, unique numbering
  under concurrent creation.

There is no `Idempotency-Key` header. It would be the right addition before
exposing this API to third-party integrators.

## Rate limits

Applied per route with an explicit bucket, returning 429 with `Retry-After`.
The budgets and the reasoning are in
[security.md § rate limiting](./security.md#-rate-limiting).

## Health

| Endpoint                | Meaning                                        |
| ----------------------- | ---------------------------------------------- |
| `GET /api/health/live`  | The process is up. Never touches a dependency. |
| `GET /api/health/ready` | Postgres and Redis both answer.                |
| `GET /api/health`       | Combined detail.                               |

`live` and `ready` are separate on purpose: a liveness probe that checks the
database restarts a healthy application because a dependency blipped.

These are version-neutral — they sit at `/api/health/*`, not `/api/v1/health/*`,
because an orchestrator's probe configuration should not have to change when
the API version does.
