# 6. Pagination strategy chosen per resource

**Status:** Accepted

## Context

List endpoints need pagination. The usual instinct is to pick one strategy and
apply it everywhere for consistency.

## Decision

Offset pagination for projects, work items and members. Cursor pagination for
the audit log.

## Consequences

They are different problems and one answer serves them badly.

**Projects, work items, members** are browsed. Users jump to page four, want a
total count, and expect the count to mean something. Offset pagination provides
exactly that. These lists are bounded per tenant — hundreds of projects, not
millions — so the cost of a deep `OFFSET` never becomes the problem it is at
scale.

**The audit log** is append-heavy and read newest-first. Offset pagination
fails it twice over. It _drifts_: new entries arrive while you page, so page
two re-shows rows page one already displayed. And it degrades, because the
database still reads and discards every row the offset skips.

A cursor fixes both. Because ATLAS ids are UUIDv7 and therefore time-ordered
([ADR 4](./0004-uuidv7-identifiers.md)), the cursor is just an id and the query
is a single-column index scan with no tiebreaker.

The cost of mixing is that the API is not uniform, so a client cannot write one
pagination helper. That is a real cost, and it is paid deliberately: forcing
cursors onto the browsable lists would remove the page numbers and totals the
interface actually uses, and forcing offsets onto the audit log would ship a
known correctness bug.

The response shapes are distinct enough that a client cannot confuse them —
offset endpoints return a `pagination` object with `total` and `totalPages`;
the cursor endpoint returns a `nextCursor`.

## What would change our mind

- A tenant accumulating enough projects that deep-page cost becomes
  measurable — cursor pagination with an optional count would then be right for
  that resource too.
- Exposing the API to third-party integrators, who would reasonably expect one
  convention. Uniformity matters more when the client is not in this repo.
