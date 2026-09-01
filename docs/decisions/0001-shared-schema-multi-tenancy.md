# 1. Shared-schema multi-tenancy

**Status:** Accepted

## Context

Every tenant's data has to be isolated. Three shapes were available:

1. **Database per tenant.** Strongest isolation; a query cannot cross a
   boundary that does not exist in the connection.
2. **Schema per tenant.** One database, `SET search_path` per request.
3. **Shared schema.** One set of tables, an `organizationId` discriminator on
   every row.

ATLAS is expected to hold many small-to-medium organizations rather than a
handful of large ones, and to onboard them self-service — an organization is
created by filling in one form.

## Decision

Shared schema, with `organizationId` on every tenant-owned table.

## Consequences

**What it costs.** Isolation becomes entirely a property of application
correctness. A single forgotten `WHERE organizationId = ?` is a data breach,
not a bug report. That is a severe failure mode and it is the whole reason
[three enforcement layers](../multi-tenancy.md) exist rather than a convention
and a code review.

Every tenant-owned table carries a redundant column, and every relationship
between tenant-owned rows is a composite foreign key — wider indexes, slightly
larger rows.

There is also no per-tenant restore. Recovering one organization from backup
means extracting its rows, not restoring a database.

**What it buys.** Migrations run once. Connection pooling works normally
instead of multiplying by tenant count. Onboarding is an `INSERT`, not a
provisioning job — which is what makes self-service signup possible at all.
Cross-tenant operational queries ("how many organizations have more than ten
projects?") are ordinary SQL.

## What would change our mind

- A tenant with a **regulatory requirement** for physical separation. That is
  not a reason to migrate everyone; it is a reason to support a dedicated
  deployment for that tenant.
- **Wildly uneven tenant sizes**, where one organization's data volume
  degrades queries for everyone. Partitioning by `organizationId` is the first
  response; a separate database for the outlier is the second.
- **Per-tenant restore** becoming a routine support request rather than a rare
  incident.
