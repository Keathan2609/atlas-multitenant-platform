# 7. Role-based access control, not attribute-based

**Status:** Accepted

## Context

ATLAS needs to decide who may do what. Two models were realistic:

- **RBAC.** A fixed set of roles, each granting a fixed set of permissions.
- **ABAC.** Decisions computed from attributes of the actor, the resource and
  the context — "an author may edit their own work item while the project is
  open".

## Decision

RBAC, with four roles — `OWNER`, `ADMIN`, `MEMBER`, `VIEWER` — and one
permission matrix in `packages/types/src/permissions.ts`.

## Consequences

The decisive property is **auditability**. When the whole matrix is one table,
answering "who can delete a project?" is reading one screen of code. Under
ABAC, the same question means tracing predicates across every resource, and the
answer can change with data rather than with a deploy.

Scattering the same checks through controllers is the usual source of
privilege-escalation bugs, because the copies drift. One table means a change
is one edit rather than a codebase-wide grep, and the same definition is shared
by the API — which uses it to decide what is _allowed_ — and the web app, which
uses it to decide what to _render_.

What RBAC cannot express is relationship: "your own work item", "a project you
belong to". Those rules exist, and they live in the services rather than in the
matrix, because they depend on the _target_ of an operation rather than only on
the actor. Rank comparison, self-modification and last-owner protection are all
of this kind. The split is a real cost: authorization is in two places, and a
reader has to know that route-level authority is in the matrix while
relationship rules are beside the query they protect.

Four roles is also coarse. There is no "billing admin" and no per-project role
that overrides the organization role, and adding one means adding a role to the
matrix rather than composing a permission set.

## Migration path to ABAC

If relationship rules multiply, the change is not to abandon the matrix but to
make the permission check take the target as an argument — `can(role,
permission, resource)` — keeping the matrix as the coarse gate and moving the
relationship predicates behind the same call. That keeps one entry point while
allowing the decisions to become richer. Nothing in the current design blocks
it; the matrix is already the only route-level authority.

## What would change our mind

- Customer-defined roles. As soon as a tenant wants to name its own role, the
  matrix must become data rather than code.
- Rules that depend on time, location, or resource state at the route level
  rather than inside a service.
