# Phase 8 screen inventory

The canonical list of product surfaces. Frozen — additions are scope changes,
not implementation details, and belong in a later phase.

## Required surfaces (15)

| #   | Surface                          | Route                                 | Status |
| --- | -------------------------------- | ------------------------------------- | ------ |
| 1   | Sign in                          | `/sign-in`                            | Built  |
| 2   | Sign up                          | `/sign-up`                            | Built  |
| 3   | Organization picker              | `/organizations`                      | Built  |
| 4   | Onboarding (create organization) | `/onboarding`                         | Built  |
| 5   | Overview                         | `/app/[orgSlug]`                      | Built  |
| 6   | Projects                         | `/app/[orgSlug]/projects`             | Built  |
| 7   | Project detail                   | `/app/[orgSlug]/projects/[projectId]` | Built  |
| 8   | Work items                       | `/app/[orgSlug]/work-items`           | Built  |
| 9   | Teams                            | `/app/[orgSlug]/teams`                | Built  |
| 10  | Workspaces                       | `/app/[orgSlug]/workspaces`           | Built  |
| 11  | Members + invitations            | `/app/[orgSlug]/members`              | Built  |
| 12  | Activity (audit log)             | `/app/[orgSlug]/activity`             | Built  |
| 13  | API keys                         | `/app/[orgSlug]/api-keys`             | Built  |
| 14  | Organization settings            | `/app/[orgSlug]/settings`             | Built  |
| 15  | User profile                     | `/profile`                            | Built  |

Invitations is deliberately a section of Members (11) rather than its own
route. A pending invitation is a prospective member; splitting them across two
destinations makes "who is in this organization?" a two-stop question. It
keeps its own API calls, its own `members.invite` gate, and its own empty and
error states.

## Deliberately not built

**Team detail** (`/teams/[teamId]`) and **work item detail**
(`/work-items/[workItemId]`) are not on this list and are not being built.
Both were drifting in as "one more screen for completeness". Measured against
whether an existing required workflow needs them:

- Team membership is managed from a dialog on the Teams screen. A route whose
  only job is to show a list of names and a list of projects — both already
  summarised as counts in the table — does not earn a navigation destination.
- Work items are read and edited where people already are: status is editable
  inline in the Work Items table, and a project's items are listed with their
  descriptions on Project detail. The one thing a dedicated route would add is
  a permalink per item, which matters for a product where people link to
  individual tickets from outside. That is a real argument, but it is a
  product decision for a later phase, not something to absorb silently into
  Phase 8.

The backend supports both cleanly (`GET /teams/:id`, `GET /work-items/:id`),
so neither is blocked — they are declined, not deferred for technical reasons.

The list is unchanged from when it was frozen: fifteen surfaces, no additions.
`/projects/new` was removed rather than built — it was a dangling link from the
Projects screen to a route that never existed, and creating a project is a
focused task with a clear commit point, so it is a dialog like every other
create in the product.

## Verification

A surface counts as complete only after it has been driven in a browser
against real seeded data. Typecheck and build success are not evidence: two
defects this phase — every design token silently emitting invalid CSS, and a
stale session cookie locking users out of sign-in entirely — passed both.

All fifteen have now been driven in a browser against the seeded backend at
1280px, 1600px and 375px, signed in as OWNER and as VIEWER, including a fresh
account with a genuinely empty organization. Defects found and fixed in that
pass are listed in `docs/verification-log.md`.
