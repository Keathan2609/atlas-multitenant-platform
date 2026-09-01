/**
 * ATLAS authorization model.
 *
 * This file is the single source of truth for "who may do what". Nothing else
 * in the codebase compares a role to a string literal — services and guards
 * ask `can(role, Permission.X)`, and the React layer imports the same matrix
 * so the UI hides actions the server would reject anyway.
 *
 * Why one file: scattered `if (role === 'ADMIN')` checks are the usual origin
 * of privilege-escalation bugs, because the checks drift. When the whole
 * matrix is one table, an audit is reading one screen of code, and a change
 * is one edit rather than a codebase-wide grep.
 *
 * Model: role-based, not attribute-based. The reasoning and the migration
 * path to ABAC are in docs/decisions/0007-rbac-not-abac.md.
 *
 * ── Security boundary ────────────────────────────────────────────────────────
 * Every check that *matters* runs on the server. The web app imports this
 * module for presentation only: to decide whether to render a button, not
 * whether an operation is allowed. A client that lies about its role changes
 * what it draws and nothing else.
 */

/** Organization-level roles, ordered most to least privileged. */
export const ORGANIZATION_ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * Every permission in the system.
 *
 * Named `resource.action`. Kept as a const object rather than a TypeScript
 * `enum` so the values are plain strings at runtime — they cross the network
 * in API error payloads and are stored in audit metadata, and a numeric enum
 * would make those payloads meaningless.
 */
export const Permission = {
  ORGANIZATION_READ: 'organization.read',
  ORGANIZATION_UPDATE: 'organization.update',
  ORGANIZATION_DELETE: 'organization.delete',

  MEMBERS_READ: 'members.read',
  MEMBERS_INVITE: 'members.invite',
  MEMBERS_UPDATE: 'members.update',
  MEMBERS_REMOVE: 'members.remove',

  TEAMS_READ: 'teams.read',
  TEAMS_CREATE: 'teams.create',
  TEAMS_UPDATE: 'teams.update',
  TEAMS_DELETE: 'teams.delete',

  WORKSPACES_READ: 'workspaces.read',
  WORKSPACES_CREATE: 'workspaces.create',
  WORKSPACES_UPDATE: 'workspaces.update',
  WORKSPACES_DELETE: 'workspaces.delete',

  PROJECTS_READ: 'projects.read',
  PROJECTS_CREATE: 'projects.create',
  PROJECTS_UPDATE: 'projects.update',
  PROJECTS_ARCHIVE: 'projects.archive',
  PROJECTS_DELETE: 'projects.delete',

  WORKITEMS_READ: 'workitems.read',
  WORKITEMS_CREATE: 'workitems.create',
  WORKITEMS_UPDATE: 'workitems.update',
  WORKITEMS_DELETE: 'workitems.delete',

  APIKEYS_READ: 'apikeys.read',
  APIKEYS_CREATE: 'apikeys.create',
  APIKEYS_REVOKE: 'apikeys.revoke',

  AUDIT_READ: 'audit.read',

  SETTINGS_READ: 'settings.read',
  SETTINGS_UPDATE: 'settings.update',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS = Object.values(Permission) as readonly Permission[];

/**
 * The authorization matrix.
 *
 * Read this as the product's access policy, because that is what it is.
 *
 *  OWNER   Full control, including destroying the organization and managing
 *          other owners. Every organization always has at least one; see
 *          the last-owner invariants in docs/security.md.
 *  ADMIN   Runs the organization day to day — members, teams, projects,
 *          credentials, audit. Deliberately cannot delete the organization
 *          or change an OWNER's role, so a compromised admin account cannot
 *          take the tenant away from its owners.
 *  MEMBER  Does the work: creates and updates projects and work items.
 *          Cannot invite people, manage credentials, or read the audit log.
 *  VIEWER  Read-only. Intended for auditors, contractors, and stakeholders
 *          who need visibility without any ability to mutate state.
 *
 * VIEWER holds no `*.create`, `*.update`, `*.delete` or `*.invite`
 * permission anywhere. That invariant is asserted by a test rather than left
 * as a comment, because it is the kind of thing a careless edit breaks.
 */
const VIEWER_PERMISSIONS: readonly Permission[] = [
  Permission.ORGANIZATION_READ,
  Permission.MEMBERS_READ,
  Permission.TEAMS_READ,
  Permission.WORKSPACES_READ,
  Permission.PROJECTS_READ,
  Permission.WORKITEMS_READ,
];

const MEMBER_PERMISSIONS: readonly Permission[] = [
  ...VIEWER_PERMISSIONS,
  Permission.PROJECTS_CREATE,
  Permission.PROJECTS_UPDATE,
  Permission.WORKITEMS_CREATE,
  Permission.WORKITEMS_UPDATE,
  Permission.WORKITEMS_DELETE,
];

const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...MEMBER_PERMISSIONS,
  Permission.ORGANIZATION_UPDATE,
  Permission.MEMBERS_INVITE,
  Permission.MEMBERS_UPDATE,
  Permission.MEMBERS_REMOVE,
  Permission.TEAMS_CREATE,
  Permission.TEAMS_UPDATE,
  Permission.TEAMS_DELETE,
  Permission.WORKSPACES_CREATE,
  Permission.WORKSPACES_UPDATE,
  Permission.WORKSPACES_DELETE,
  Permission.PROJECTS_ARCHIVE,
  Permission.PROJECTS_DELETE,
  Permission.APIKEYS_READ,
  Permission.APIKEYS_CREATE,
  Permission.APIKEYS_REVOKE,
  Permission.AUDIT_READ,
  Permission.SETTINGS_READ,
  Permission.SETTINGS_UPDATE,
];

const OWNER_PERMISSIONS: readonly Permission[] = [
  ...ADMIN_PERMISSIONS,
  Permission.ORGANIZATION_DELETE,
];

/**
 * Frozen so a runtime mutation cannot widen anyone's access. Sets rather than
 * arrays because `can()` is called on essentially every authorized request and
 * on every permission-gated element the UI renders.
 */
export const ROLE_PERMISSIONS: Readonly<Record<OrganizationRole, ReadonlySet<Permission>>> =
  Object.freeze({
    OWNER: new Set(OWNER_PERMISSIONS),
    ADMIN: new Set(ADMIN_PERMISSIONS),
    MEMBER: new Set(MEMBER_PERMISSIONS),
    VIEWER: new Set(VIEWER_PERMISSIONS),
  });

/** Does this role hold this permission? */
export function can(role: OrganizationRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Does this role hold every one of these permissions? */
export function canAll(role: OrganizationRole, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}

/** Does this role hold at least one of these permissions? */
export function canAny(role: OrganizationRole, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => can(role, p));
}

/** Full permission list for a role. Sent to the web app once per org context. */
export function permissionsFor(role: OrganizationRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/**
 * Privilege ordering, used for the "cannot act on someone at or above your own
 * level" rules below. Higher number means more privileged.
 */
const ROLE_RANK: Readonly<Record<OrganizationRole, number>> = Object.freeze({
  OWNER: 4,
  ADMIN: 3,
  MEMBER: 2,
  VIEWER: 1,
});

export function roleRank(role: OrganizationRole): number {
  return ROLE_RANK[role];
}

/**
 * May `actorRole` administer a member currently holding `targetRole`?
 *
 * Everyone below OWNER may only act on strictly lower roles. That is what
 * stops a compromised ADMIN account from demoting the other admins and the
 * owners and taking the tenant hostage.
 *
 * OWNER is the deliberate exception: owners may administer their peers.
 * Without it, the moment an organization has two owners neither can ever
 * remove the other, and a departing co-founder becomes permanently
 * irremovable. The last-owner rule still applies on top, so the exception
 * cannot be used to empty the owner set.
 */
function outranksOrEquals(actorRole: OrganizationRole, targetRole: OrganizationRole): boolean {
  if (ROLE_RANK[targetRole] > ROLE_RANK[actorRole]) return true;
  if (ROLE_RANK[targetRole] < ROLE_RANK[actorRole]) return false;
  return actorRole !== 'OWNER';
}

export function isRoleAtLeast(role: OrganizationRole, minimum: OrganizationRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/**
 * Why a role change was refused. Returned as a discriminated result rather
 * than thrown, so the caller decides the HTTP status and the UI can explain
 * the refusal precisely instead of showing a generic 403.
 */
export type RoleChangeDenial =
  | { allowed: false; reason: 'MISSING_PERMISSION' }
  | { allowed: false; reason: 'CANNOT_MODIFY_SELF' }
  | { allowed: false; reason: 'TARGET_OUTRANKS_ACTOR' }
  | { allowed: false; reason: 'CANNOT_GRANT_ABOVE_OWN_ROLE' }
  | { allowed: false; reason: 'LAST_OWNER' };

export type RoleChangeDecision = { allowed: true } | RoleChangeDenial;

export interface RoleChangeRequest {
  actorRole: OrganizationRole;
  targetCurrentRole: OrganizationRole;
  targetNewRole: OrganizationRole;
  actorIsTarget: boolean;
  /** Number of OWNERs in the organization *before* this change. */
  ownerCount: number;
}

/**
 * Decides whether one member may change another's role.
 *
 * Permission alone is not sufficient here, so this cannot collapse into a
 * `can()` call. Three additional rules apply, each closing a real escalation
 * or lockout path:
 *
 *  1. You cannot act on someone whose role outranks or equals yours. Without
 *     it, any admin could demote every other admin and the owners.
 *  2. You cannot grant a role above your own — the classic self-escalation
 *     via a target you are permitted to edit.
 *  3. The last OWNER cannot be demoted. Combined with the equivalent check on
 *     removal, this is what stops an organization becoming permanently
 *     un-administrable. See docs/security.md § owner safety.
 *
 * Self-modification is refused outright: an owner demoting themselves is the
 * most common way to lock an organization, and the product offers explicit
 * ownership transfer instead.
 */
export function canChangeRole(request: RoleChangeRequest): RoleChangeDecision {
  const { actorRole, targetCurrentRole, targetNewRole, actorIsTarget, ownerCount } = request;

  if (!can(actorRole, Permission.MEMBERS_UPDATE)) {
    return { allowed: false, reason: 'MISSING_PERMISSION' };
  }
  if (actorIsTarget) {
    return { allowed: false, reason: 'CANNOT_MODIFY_SELF' };
  }
  if (outranksOrEquals(actorRole, targetCurrentRole)) {
    return { allowed: false, reason: 'TARGET_OUTRANKS_ACTOR' };
  }
  if (ROLE_RANK[targetNewRole] > ROLE_RANK[actorRole]) {
    return { allowed: false, reason: 'CANNOT_GRANT_ABOVE_OWN_ROLE' };
  }
  if (targetCurrentRole === 'OWNER' && targetNewRole !== 'OWNER' && ownerCount <= 1) {
    return { allowed: false, reason: 'LAST_OWNER' };
  }
  return { allowed: true };
}

export interface MemberRemovalRequest {
  actorRole: OrganizationRole;
  targetRole: OrganizationRole;
  actorIsTarget: boolean;
  ownerCount: number;
}

/**
 * Decides whether a member may be removed from the organization.
 *
 * Leaving voluntarily is permitted for everyone *except* the last owner,
 * which is why `actorIsTarget` is allowed here but not in `canChangeRole`.
 */
export function canRemoveMember(request: MemberRemovalRequest): RoleChangeDecision {
  const { actorRole, targetRole, actorIsTarget, ownerCount } = request;

  if (actorIsTarget) {
    if (targetRole === 'OWNER' && ownerCount <= 1) {
      return { allowed: false, reason: 'LAST_OWNER' };
    }
    return { allowed: true };
  }

  if (!can(actorRole, Permission.MEMBERS_REMOVE)) {
    return { allowed: false, reason: 'MISSING_PERMISSION' };
  }
  if (outranksOrEquals(actorRole, targetRole)) {
    return { allowed: false, reason: 'TARGET_OUTRANKS_ACTOR' };
  }
  if (targetRole === 'OWNER' && ownerCount <= 1) {
    return { allowed: false, reason: 'LAST_OWNER' };
  }
  return { allowed: true };
}

/**
 * Roles an actor may hand out when inviting someone.
 *
 * You cannot invite above your own level, which is the same escalation guard
 * as `canChangeRole` applied at the entry point. An admin inviting a new owner
 * would otherwise be a one-step takeover.
 */
export function assignableRoles(actorRole: OrganizationRole): OrganizationRole[] {
  if (!can(actorRole, Permission.MEMBERS_INVITE)) return [];
  return ORGANIZATION_ROLES.filter((role) => ROLE_RANK[role] <= ROLE_RANK[actorRole]);
}

/** Human-readable role descriptions, shown inline in the member UI. */
export const ROLE_DESCRIPTIONS: Readonly<Record<OrganizationRole, string>> = Object.freeze({
  OWNER: 'Full access, including billing, organization settings, and deletion.',
  ADMIN: 'Manages members, teams, projects, and API credentials. Cannot delete the organization.',
  MEMBER: 'Creates and updates projects and work items.',
  VIEWER: 'Read-only access to projects and work items.',
});
