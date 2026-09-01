# Security

The decisions behind ATLAS's security posture, and the trade-offs each one
accepts. Tenant isolation has its own document — see
[multi-tenancy.md](./multi-tenancy.md).

Sections here are cited directly from the code, so if you arrived from a
comment saying "see § rate limiting", that section is below.

## Threat model

ATLAS holds one organization's operational data and is used by people who
belong to several organizations at once. The adversaries worth designing
against:

- **A member of another tenant.** Authenticated, legitimate, and one URL away
  from someone else's data. This is the primary threat and it drives the whole
  isolation design.
- **A member of the same tenant with a lower role.** Wants to escalate, or to
  act beyond their permissions.
- **An unauthenticated attacker with a stolen credential** — a session cookie,
  an API key, a forwarded invitation link.
- **An unauthenticated attacker with no credential**, probing for accounts,
  tenants, and resources that exist.

Explicitly _not_ in scope: a malicious operator with database access, and
side-channel attacks against the host.

## Authentication

**Passwords are hashed with Argon2id** at the OWASP-recommended parameters:
19 MiB memory, 2 iterations, parallelism 1. `memoryCost` is the lever to raise
first if hardware allows. Hashes carry their parameters, so a policy change
does not invalidate existing accounts — `needsRehash` detects a weaker hash at
login and transparently upgrades it while the plaintext is in hand. A failed
upgrade never fails an otherwise valid login.

**Sessions are opaque random tokens**, 32 bytes of CSPRNG output, stored as a
hash. The raw token exists only in the cookie. There is no JWT: a stateless
token cannot be revoked, and "sign out everywhere" and immediate membership
revocation both matter more here than saving a lookup. Sessions are cached in
Redis for 60 seconds, which bounds how long a revoked session stays usable —
short enough that revocation feels immediate, long enough to keep
authentication off the database on every request.

**Cookies.** The session cookie is `httpOnly` (an XSS foothold cannot
exfiltrate it), `sameSite=lax` (blocks the cross-site POST that CSRF depends
on), `secure` in production, and signed with `SESSION_SECRET`. Signing is
defence in depth rather than the primary control — the token is already 256
bits of CSPRNG output — but it means a tampered cookie is rejected before it
reaches a database lookup.

### § user enumeration

Every login failure path returns the same `INVALID_CREDENTIALS` error **and
takes comparable time**:

| Case                                | How timing is equalised                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| Unknown email                       | `verifyDummy()` burns equivalent Argon2 work                |
| Wrong password                      | Real verification fails                                     |
| Account with no password (SSO-only) | `verifyDummy()`, so the absence of a hash is not observable |

Without the dummy verification an unknown address returns in microseconds while
a real one takes ~50ms. That difference is a reliable enumeration oracle no
matter how carefully the error message is worded.

Registration is the one place this cannot hold: the user has to be told the
address is taken or they cannot proceed. Invitation flows do not leak it.

## Authorization

Roles are `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`. The permission matrix lives in
one place — `packages/types/src/permissions.ts` — and is shared by the API and
the web app. The web app uses it to decide what to _render_; the API uses it to
decide what to _allow_. Those are different jobs and only one of them is a
security control.

Route-level authority comes from `PermissionsGuard`, reading the role from the
server-resolved tenant context. Nothing the client sent participates.

Relationship rules stay in the services, because they depend on the _target_ of
the operation rather than just the actor:

- **Rank comparison.** You cannot act on someone who outranks you. Owners are
  the exception to strict inequality: two co-owners can administer each other,
  or an organization with two owners would have no one able to manage either.
  (This was a real bug, caught by its own test — `targetRank >= actorRank` made
  co-owners permanently unmanageable.)
- **No self-escalation.** You cannot change your own role, and you cannot grant
  a role above your own.
- **No escalation via a permitted target.** An ADMIN cannot invite or promote
  an OWNER.

### § owner safety

**The last OWNER cannot be demoted, removed, or allowed to leave.** Together
these stop an organization becoming permanently un-administrable — a state no
amount of support tooling can fix without direct database access.

The check runs at `Serializable` isolation. Without it, two concurrent
demotions of the last two owners could each read `ownerCount = 2`, both pass,
and leave the organization with none. The audit entry is written inside the
same transaction, so a refused action cannot leave a trail suggesting it
succeeded.

A `VIEWER` may still leave voluntarily despite holding no remove permission —
leaving is not an administrative act on someone else.

### § IDOR

A resource in another organization returns **404, not 403**. A 403 confirms the
id exists, which lets an attacker enumerate project and work-item ids across
the platform. The same conflation applies at the tenant level: a foreign
organization slug and a nonexistent one produce byte-identical responses.

Malformed identifiers are handled centrally in the exception filter rather than
by a `ParseUUIDPipe` on each of fifteen routes. A malformed UUID previously
produced a 500, which is both a status-code oracle and a log-flooding vector.
The mapping is narrow — Prisma's `P2023` with an "Error creating UUID" message
— so genuine column-data corruption still surfaces as a 500.

## CSRF

Session authentication travels in a cookie, so mutations need a second factor
the attacker's site cannot read. ATLAS uses **double-submit**: an httpOnly
session cookie plus a readable `atlas_csrf` cookie, echoed by the client in the
`x-csrf-token` header and compared in constant time.

The CSRF cookie is deliberately _not_ httpOnly (the client has to read it) and
_not_ signed. Knowing its value grants nothing without the httpOnly session
cookie.

**Exemptions are opt-in per route.** `@CsrfExempt()` is honoured only when the
route is also `@Public()`, so applying it to an authenticated route does
nothing. Auditing every exemption is `grep CsrfExempt` — currently exactly two,
login and register.

Those two are exempt because they are _session-establishing_: a caller may hold
a stale session cookie from a previous sign-in, and demanding a CSRF token they
cannot have locks them out of the front door entirely. That was a real
regression — with a stale cookie, sign-in returned 403 advising a page reload,
which could not help because the cookie survived the reload. The residual risk,
login-CSRF forcing a victim into an attacker's account, is covered by
`sameSite=lax`.

The first fix for it exempted _all_ `@Public()` routes, which was too broad:
any public mutation added later would silently lose CSRF protection just by
being public. The narrower rule is the one in place.

## Credential storage

Three credential types, one rule: **the raw value appears in exactly one
response and nowhere else** — not in the database, not in the audit log, not in
any later read.

| Credential       | At rest                               | Why                                                                                                                                       |
| ---------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Session token    | SHA-256                               | Fast hash is correct: the input is 256 bits of CSPRNG output, so there is no dictionary to attack and a slow KDF would tax every request. |
| API key          | SHA-256 over key + server-side pepper | Same reasoning, plus the pepper means a database dump alone cannot compute hashes.                                                        |
| Invitation token | SHA-256                               | Exists in the clear only in the emailed link.                                                                                             |

`apps/api/test/credential-hygiene.integration.spec.ts` asserts this property
across all three at once rather than per service, because they were written by
three services at three different times and the shared rule should not quietly
stop holding for one of them.

API keys carry a public `atlas_live_` prefix. That is deliberate: it makes a
leaked key recognisable to secret scanners and lets obvious non-keys be
rejected before a database round trip. Unknown, revoked and expired keys all
return the same 401 with the same message — distinguishing them would confirm a
key was once real.

## § rate limiting

Fixed-window counters in Redis, applied per route with an explicit bucket:

| Route                        | Budget            | Bucketed by      |
| ---------------------------- | ----------------- | ---------------- |
| `POST /auth/register`        | 5 / hour          | IP               |
| `POST /auth/login`           | 10 / 5 min        | IP **and** email |
| `POST /auth/change-password` | 5 / 15 min        | User             |
| `POST /organizations`        | 10 / hour         | User             |
| Invitations, API keys        | 20–30 / 10–60 min | User or IP       |

Login is bucketed on IP _and_ email together because neither alone is
sufficient: IP-only lets a botnet spread guesses against one account,
email-only lets one attacker lock a victim out by exhausting their budget.

**Two trade-offs are accepted deliberately.**

_A fixed window admits up to 2× the limit across a boundary._ For login
throttling the goal is making automated guessing expensive, and a sliding-log
window buys little against that for meaningfully more complexity.

_It fails open._ If Redis is unreachable, requests proceed. Locking every user
out of a working API because a cache is down trades a real outage for a
hypothetical attack. This is only defensible with monitoring: Redis
availability must alert, because a silent Redis outage silently removes
throttling. That is the compensating control, and it is a genuine operational
obligation, not a footnote.

### Trusting the proxy

`TRUST_PROXY` defaults to **0**. Rate-limit buckets and audit entries both key
on `req.ip`, and Express derives that from `X-Forwarded-For` when it trusts a
proxy. Trusting a hop that does not exist lets any client supply its own
address.

This was verified as exploitable before it was fixed: after the login budget
returned 429, three forged `X-Forwarded-For` values each restored a fresh
budget. Deployments behind a load balancer must set `TRUST_PROXY` to the actual
hop count.

## § destructive actions

Deleting an organization or a project requires **retyping its slug or key**,
validated server-side against the real value — not only in the dialog. A
scripted request therefore has to demonstrate the same intent a human would.

This is not the security control; the permission check is. It is what stops a
mis-click destroying something that cannot be restored. Organization deletion
is soft and owner-only.

Destructive confirmations are never optimistic in the UI: the dialog stays open
with the button in its pending state until the server confirms, because showing
a deletion as done before it is done is worse than a moment of waiting.

## Audit log

Administratively significant actions are recorded through one service that
scrubs forbidden keys before writing. The log is admin-readable and
long-lived, so a secret written there would be both visible and durable.

It is **read-only by construction** — no write, update or delete route exists,
because a trail an administrator can edit is not a trail. Entries are written
inside the same transaction as the action, so a refused mutation leaves no
trail suggesting it succeeded.

Pagination is cursor-based on the id, which is chronological only because ATLAS
uses UUIDv7. Offset pagination would drift as rows arrive under an
append-heavy table.

## Transport and headers

Helmet sets a restrictive CSP (`default-src 'none'`, `frame-ancestors 'none'`)
— the API serves JSON and never HTML, so this costs nothing and removes the
browser's ability to execute anything if a response is ever mistakenly
rendered.

CORS lists explicit origins with `credentials: true`. The spec forbids
combining credentials with a wildcard, and permitting one would let any site
read authenticated responses.

The JSON body limit is 100 kB — generous for the largest legitimate payload (a
work-item description) and small enough that a body-size flood is cheap to
reject.

OpenAPI is served outside production only. In production it would advertise the
full attack surface, including endpoints a given caller has no business
knowing about.

## Known gaps

Stated plainly rather than left for a reader to discover:

- **Two-factor authentication is a setting, not an enforcement.** The
  organization setting records the policy; the enrolment and challenge flow
  does not exist. The UI says so.
- **Email is not verified** at registration, and changing an email address is
  not offered at all, precisely because doing it properly requires that flow.
- **No account lockout** after repeated failures — only rate limiting. Lockout
  is a denial-of-service vector against a known address, and the trade-off has
  not been made either way here.
- **The audit log has no retention or export.** It grows without bound.
