# 8. Redis holds only reconstructible state

**Status:** Accepted

## Context

Redis is in the stack for two jobs: rate-limit counters and a session cache. It
could equally have become the home for other things — a job queue, a pub/sub
bus, denormalised read models.

## Decision

Redis holds only state that can be reconstructed or safely lost. It is
explicitly not a source of truth, and the container runs with persistence
disabled (`--save "" --appendonly no`).

## Consequences

Everything currently in Redis satisfies the rule:

- **Rate-limit counters.** Losing them resets budgets. The worst case is that
  an attacker mid-campaign gets a fresh allowance.
- **Session cache.** Losing it means the next request reads Postgres, which
  holds the authoritative session.

Because nothing durable lives there, the failure posture is simple: the rate
limiter **fails open** and the session cache **falls through to Postgres**. A
Redis outage degrades the system rather than stopping it.

That is a genuine trade-off, not a free win. A silent Redis outage silently
removes rate limiting, so Redis availability must alert — see
[security.md § rate limiting](../security.md#-rate-limiting). Without that
monitoring this decision is indefensible, and the monitoring is therefore part
of the decision rather than an operational afterthought.

Disabling persistence also means Redis restarts empty and fast, with no AOF
rewrite pauses and no risk of restoring a stale snapshot that resurrects
already-revoked sessions.

The cost is that Redis cannot be reached for anything else without revisiting
this. A job queue in this instance would be data loss on restart.

## What would change our mind

- Needing a durable queue or a stream. That is a different instance with
  persistence enabled, not a relaxation of this rule on this one.
- Session lookup load justifying Redis as the primary store — which would mean
  accepting that a Redis loss signs everyone out.
