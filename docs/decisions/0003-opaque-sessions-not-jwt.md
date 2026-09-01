# 3. Opaque session tokens rather than JWTs

**Status:** Accepted

## Context

The web app needs authenticated requests. The default reflex in this stack is a
JWT: signed, self-contained, verifiable without a lookup.

## Decision

Opaque random tokens — 32 bytes of CSPRNG output — stored hashed, resolved
against Postgres, cached in Redis for 60 seconds.

## Consequences

The deciding factor is revocation. ATLAS has three operations that must take
effect _now_:

- "Sign out everywhere", after a password change.
- Membership revocation. Removing someone from an organization has to end
  their access, not schedule it.
- Role changes. A demoted admin must stop being an admin.

A stateless token cannot do any of these. The usual workaround — a short expiry
plus a refresh token — reintroduces server state for the refresh token while
adding a second credential, two endpoints, and a rotation story. At that point
the JWT is carrying complexity without paying for it.

The cost is a lookup per request. The Redis cache reduces that to a network
round trip in the common case, and bounds the revocation delay at 60 seconds:
short enough that "sign out everywhere" feels immediate, long enough to keep
authentication off the database under load.

Being opaque also means the token carries no claims, so there is no risk of a
client trusting a stale role embedded in it, and nothing is disclosed if it
leaks into a log.

## What would change our mind

- **Multiple independent services** needing to authenticate the same caller
  without a shared session store. That is the problem JWTs are actually for.
- Session lookup becoming a measured bottleneck that the cache cannot absorb.
