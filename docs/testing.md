# Testing

242 tests: 74 unit, 125 integration, and 43 end-to-end. What is tested, what
is deliberately not, and why the split falls where it does.

## The principle

Tests here assert **behaviour that would be a defect if it changed**, not
coverage of every line. A test that restates the implementation costs
maintenance and catches nothing; the ones that earn their keep are the ones
that would have failed before a real bug was fixed.

Several tests in this repository exist for exactly that reason. Each of the
following was written after a defect was found, and each fails against the code
as it was:

- Peer owners could never administer each other (`targetRank >= actorRank`).
- A forged `X-Forwarded-For` reset the login rate-limit budget.
- A stale session cookie made sign-in return 403 and locked the user out.
- `@Public()` routes silently lost CSRF protection.

## The split

**Unit tests** (`src/**/*.spec.ts`, run by `pnpm test`) cover pure logic with
no I/O:

| Suite                              | What it pins                                                          |
| ---------------------------------- | --------------------------------------------------------------------- |
| `packages/types/permissions`       | The RBAC matrix, rank comparison, last-owner rules, self-modification |
| `packages/validation/primitives`   | Schema edge cases — control characters, trimming, boundaries          |
| `packages/observability/redaction` | That secrets never reach the log output                               |
| `packages/database/tenant-scope`   | Predicate injection, contradictory-tenant rejection, model coverage   |
| `apps/api/auth.guard`              | The CSRF boundary across all four metadata combinations               |
| `apps/api/password.service`        | Argon2 parameters, rehash detection, dummy-verification timing        |

These run in milliseconds and need nothing running.

**Integration tests** (`apps/api/test/*.integration.spec.ts`, run by
`pnpm --filter @atlas/api test:integration`) exercise the real application
against **real Postgres and real Redis** over HTTP. No mocked database, no
mocked cache.

That is a deliberate choice. The properties worth asserting here — that a
cross-tenant read returns 404, that `Serializable` isolation actually prevents
two concurrent demotions, that a Prisma extension survives into `$transaction`
— are properties of the database, and a mock would assert only that the mock
was configured as expected.

| Suite                | What it pins                                                             |
| -------------------- | ------------------------------------------------------------------------ |
| `tenancy`            | Cross-tenant reads, writes, deletes; slug enumeration; revocation timing |
| `authorization`      | Every role boundary, escalation attempt, last-owner invariant            |
| `auth`               | Registration, login, sessions, password change, profile updates          |
| `credential-hygiene` | Sessions, API keys and invitation tokens never persisted raw             |
| `enterprise`         | API keys, invitations, audit log, settings                               |
| `domains`            | Workspaces, teams, projects, work items                                  |
| `error-handling`     | The error envelope, malformed input, status-code mapping                 |
| `rate-limit`         | Budgets, bucketing, forged proxy headers                                 |
| `session-reuse`      | Session caching and revocation                                           |

## Running them

```bash
pnpm test
```

```bash
pnpm --filter @atlas/api test:integration
```

Integration tests need the Docker stack up:

```bash
docker compose -f infrastructure/docker-compose.yml up -d
```

## The test database

`test/setup.ts` forces `DATABASE_URL` to `TEST_DATABASE_URL` before any test
module loads, and the harness **refuses to run if the resulting URL does not
name the test database**. The suite truncates tables between tests, so a
misconfigured environment would otherwise wipe development data on the first
run.

The test database is created by `infrastructure/docker/postgres-init/` at
container initialisation, so it exists before anything tries to connect.

Truncation order is declared explicitly (`TRUNCATE_ORDER` in `test/harness.ts`)
so foreign keys never block the delete.

## Why the integration suite runs serially

`singleFork`. The suite truncates tables between tests, so parallel workers
sharing one database would delete each other's fixtures.

Isolation could come from a schema per worker instead. Serial execution is
chosen for now because the whole suite runs in about 36 seconds and the
complexity is not yet earning its keep. If it grows past a minute or two,
schema-per-worker is the change to make — not mocking the database.

## Email in tests

The email transport is a console/in-memory implementation, so specs can read
what was "sent". This is not just convenience: the invitation test **has to**
read the token out of the email, because the token is never persisted in the
clear and never returned by the API. Having to fetch it from the message is
itself the assertion that credential hygiene holds.

## SWC, not esbuild

Vitest is configured with `unplugin-swc`. NestJS relies on
`emitDecoratorMetadata`, which esbuild does not implement — without it every
constructor-injected dependency resolves as `undefined` and every test fails in
a way that looks like a DI bug rather than a transform configuration problem.

## End-to-end

`apps/web/e2e`, run by `pnpm test:e2e`. Playwright, Chromium, against a
**production build** and a seeded database.

Two files, with different jobs:

**`regressions.spec.ts`** — one test per defect found in the manual browser
pass. Each would have failed against the code as it was, which is the only
property that makes a regression test worth keeping: the account-switch cache
leak, focus lost when a dialog closes, the closed mobile drawer still in the
tab order, tables unable to truncate, and sign-in with a stale session cookie.

**`surfaces.spec.ts`** — breadth. Every route in the inventory renders, says
who it is, logs no console error, issues no failed request, and does not scroll
sideways; plus the error surfaces, the viewer's read-only view, and keyboard
access.

Three decisions shape it:

_A production build, not the dev server._ Against `next dev` the first hit on
each route triggers a compile, which pushed a full run past thirty minutes and
timed out most of it. The production build runs the same suite in about a
minute, and exercises what actually ships — including the Suspense boundary
whose absence only breaks `next build`.

_Authentication happens once per role_, in `auth.setup.ts`, and the rest of the
suite reuses the saved session. This is not only speed. Login is rate-limited
to ten attempts per five minutes per IP-and-email pair, and the first version
of this suite signed in on every test, exhausted the budget, and started
failing with 429s that looked like application bugs. The tests that are
specifically about sign-in still drive the real form, and they use accounts
nothing else touches.

_Mobile is a real project, not a token gesture._ Three of the pinned defects
only appear below the sidebar breakpoint. Desktop-only tests are excluded from
it by `grepInvert` on a title tag — `testIgnore` matches file paths, which
silently ran the whole desktop suite on a phone viewport.

The database is not managed by the suite. It expects the Docker stack up,
migrations applied and `pnpm db:seed` run, because a suite that provisioned its
own would either reseed on every run or assert against an empty one.

## What is not tested, and why

Stated plainly rather than left as a gap for a reader to find.

**Visual regression is untested.** The end-to-end suite asserts structure,
behaviour and layout properties — no horizontal overflow, uniform row heights,
focus placement — but nothing compares pixels. A change that made every button
magenta would pass. Screenshot comparison is the obvious next addition, and the
reason it is not here is that it needs a stable baseline environment to avoid
being a source of noise.

**Only Chromium.** WebKit and Firefox would each add minutes to a run for
coverage this project's audience does not need yet.

**Load and performance are untested.** No claim is made about throughput.

**The purge job for soft-deleted organizations does not exist**, so nothing
tests it.
