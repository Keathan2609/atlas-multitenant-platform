# Phase 8 browser verification

What driving the real application against the seeded backend found, after every
screen in `screen-inventory.md` was written and typecheck-clean.

Conditions: Next dev server on :3000, API on :4000, Postgres and Redis in
Docker, Northstar Systems (7 members, 4 teams, 6 projects, 26 work items) and a
newly registered account with an empty organization. Viewports 1280×800,
1600×1000 and 375×812. Signed in as OWNER and as VIEWER.

## Defects found and fixed

**Workspaces was unreachable.** The route existed and worked; nothing in the
sidebar linked to it. Added to the main navigation group, gated on
`workspaces.read`.

**`/projects/new` was a dangling link.** Both "New project" buttons pushed to a
route that was never built. Because `[projectId]` is a dynamic segment it would
have matched, and the screen would have tried to load a project with the id
`new`. Replaced with a create dialog, consistent with Teams and Workspaces.

**An empty optional field was sent as an empty string.** `createProjectSchema`
makes `key` optional, but the form registered `''`, which the client resolver
measured against the two-character minimum and refused — so a project could not
be created without typing a key, directly contradicting the field's own
description. Same shape for `teamId`, where "Unassigned" has to be `null`.
Fixed with `setValueAs` on both.

**Signing in did not clear the previous account's cached data.** Sign-out
cleared the React Query cache; sign-in and sign-up did not. Registering while
another account's session was open left that account's organization list on
screen, and `staleTime` would have served it for thirty seconds before the
first refetch. On a shared machine that is one user seeing another's data.
Both now clear the cache the moment a new session is established.

**Closing a dialog dropped focus on `<body>`.** Radix restores focus to its own
`Trigger`; these dialogs are opened from ordinary buttons and row menus holding
state, so there was nothing to restore to. A keyboard user closing a dialog
started their next Tab from the top of the page. The `Dialog` wrapper now
tracks the last focused element outside any dialog and returns focus there.

**The closed mobile drawer stayed in the tab order.** It was parked off-screen
with `translate` alone, so every navigation link remained focusable and
announced — tabbing on a phone moved focus somewhere invisible. Now
`invisible` when closed, which removes the subtree from the tab order and the
accessibility tree and still animates.

**Sortable column headers were sentence case.** Preflight resets
`text-transform` on buttons, so every sortable header rendered "Project" beside
an uppercase "TEAM". Affected every table in the product.

**The focus ring took each element's text colour.** `outline-color` initialises
to `currentColor`, and something in the cascade was resetting it on elements
carrying utility classes: navigation links rang grey, the account button rang
white, against a base rule that specifies the accent. Pinned on `*` so
whichever rule turns an outline on, the colour is the accent.

**Tables could not truncate.** Under `table-layout: auto` a `white-space:
nowrap` cell sets the column's intrinsic width instead of being clipped, so a
long workspace description widened the table past its scroller — 131px of
horizontal scrolling at 375px for a two-column table. Switched to
`table-fixed`, which is what the design already assumed: every column declares
a width except the one flexible column.

**Project detail squeezed its own table.** The two-column layout engaged at
`lg`, leaving the work-item table 703px for 875px of columns — a horizontal
scrollbar at ordinary desktop width with empty space beside it. The split now
happens at `2xl`; below that the page stacks with the project's facts first,
and the destructive action moved to the end of the page rather than floating in
a sidebar.

**Relative dates wrapped, so rows were uneven.** "2 months ago" broke across
two lines in a 112px column while "last week" did not, making some rows 36px
and others taller — the one thing a dense table cannot afford. `nowrap` on
every relative-time cell across six screens.

**Column widths were misallocated on the work-item table.** Status held 136px
for a badge and Priority 104px for a dot and one short word, while Title — the
column people actually read — truncated on nearly every row. Rebalanced to give
Title 295px, and truncated cells now carry the full value as a `title`.

**The API could not start from a clean checkout.** Nothing loaded the root
`.env`; the environment had to be exported by hand, and `pnpm dev` failed
validation with five missing variables. `main.ts` now loads it outside
production, where the platform supplies the environment instead.

**`updateProfileSchema` had no endpoint behind it.** The profile screen needs
it, so `PATCH /auth/me` was added — scoped to the caller's own id, taken from
the session and never from the payload. Sessions cache the user record, so the
write also clears that user's cached sessions; without it a rename stayed
invisible for up to a minute. Six integration tests cover it.

**"This field is required."** was the message for every empty name, beside
specific ones like "Enter an email address." Now "Enter a name."

**"Removes Fleet Telemetry and its 0 work items."** Zero-item projects get
their own sentence.

## Confirmed working

Authorization is enforced by the API, not by the interface. As VIEWER, with the
UI offering no controls at all: reading settings 403, patching settings 403,
creating a workspace 403, and reaching a tenant the account does not belong to
404 — not 403, so tenant slugs cannot be enumerated.

Real mutations round-trip against the API and persist: organization settings,
project status and team, display name, project creation and deletion, workspace
creation. Destructive dialogs keep their confirm button disabled until the
exact key or slug is typed, and stay open until the server answers.

Empty, loading, forbidden and not-found states all render from real conditions
rather than mocks — including a brand-new organization with no projects, a
malformed UUID in the URL, a well-formed UUID that does not exist, and an
organization slug the account is not a member of.

Dialogs trap focus, close on Escape, and return focus to what opened them.
Every interactive element shows a 2px accent ring at 2px offset. The skip link
is the first tab stop. Reduced motion is honoured by an unconditional
`!important` rule.

No page scrolls horizontally at any tested width.
