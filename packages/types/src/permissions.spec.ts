import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  ORGANIZATION_ROLES,
  Permission,
  ROLE_PERMISSIONS,
  assignableRoles,
  can,
  canChangeRole,
  canRemoveMember,
  isRoleAtLeast,
  permissionsFor,
  type OrganizationRole,
} from './permissions.js';

/**
 * These tests assert the *security properties* of the authorization model,
 * not that a lookup table contains what it contains. Each one corresponds to
 * a real escalation or lockout path; a failure here is a vulnerability, not a
 * style regression.
 */

describe('role/permission matrix', () => {
  it('grants OWNER every defined permission', () => {
    // If a permission is added and never assigned, OWNER should still hold it.
    // Catching that here stops a feature shipping that nobody can use.
    for (const permission of ALL_PERMISSIONS) {
      expect(can('OWNER', permission), `OWNER missing ${permission}`).toBe(true);
    }
  });

  it('gives VIEWER no mutating permission anywhere', () => {
    // The core promise of the VIEWER role. Written as a pattern match over the
    // permission names so a newly added `something.delete` is covered
    // automatically rather than needing this test to be remembered.
    const mutating = ALL_PERMISSIONS.filter((p) =>
      /\.(create|update|delete|archive|invite|remove|revoke)$/.test(p),
    );
    expect(mutating.length).toBeGreaterThan(10);

    for (const permission of mutating) {
      expect(can('VIEWER', permission), `VIEWER must not hold ${permission}`).toBe(false);
    }
  });

  it('nests roles so each level is a superset of the one below', () => {
    // Guards the "privilege ladder" assumption that roleRank encodes. If ADMIN
    // ever lost a permission MEMBER has, rank comparisons elsewhere would be
    // making decisions on a false premise.
    const ladder: OrganizationRole[] = ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'];
    for (let i = 1; i < ladder.length; i++) {
      const lower = ROLE_PERMISSIONS[ladder[i - 1]!];
      const higher = ROLE_PERMISSIONS[ladder[i]!];
      for (const permission of lower) {
        expect(higher.has(permission), `${ladder[i]} missing ${permission} held by ${ladder[i - 1]}`).toBe(true);
      }
    }
  });

  it('reserves organization deletion for OWNER alone', () => {
    expect(can('OWNER', Permission.ORGANIZATION_DELETE)).toBe(true);
    for (const role of ['ADMIN', 'MEMBER', 'VIEWER'] as const) {
      expect(can(role, Permission.ORGANIZATION_DELETE)).toBe(false);
    }
  });

  it('keeps the audit log and API credentials away from MEMBER and VIEWER', () => {
    for (const role of ['MEMBER', 'VIEWER'] as const) {
      expect(can(role, Permission.AUDIT_READ)).toBe(false);
      expect(can(role, Permission.APIKEYS_READ)).toBe(false);
      expect(can(role, Permission.APIKEYS_CREATE)).toBe(false);
      expect(can(role, Permission.APIKEYS_REVOKE)).toBe(false);
    }
  });

  it('exposes a stable permission list per role', () => {
    for (const role of ORGANIZATION_ROLES) {
      expect(permissionsFor(role)).toEqual([...ROLE_PERMISSIONS[role]]);
    }
  });
});

describe('canChangeRole — privilege escalation guards', () => {
  const base = { actorIsTarget: false, ownerCount: 2 };

  it('refuses an actor without members.update', () => {
    expect(
      canChangeRole({ ...base, actorRole: 'MEMBER', targetCurrentRole: 'VIEWER', targetNewRole: 'ADMIN' }),
    ).toEqual({ allowed: false, reason: 'MISSING_PERMISSION' });
  });

  it('stops an ADMIN granting OWNER — the self-escalation path', () => {
    // Without the "cannot grant above your own role" rule, any admin could
    // mint an owner and then have that account promote them.
    expect(
      canChangeRole({ ...base, actorRole: 'ADMIN', targetCurrentRole: 'MEMBER', targetNewRole: 'OWNER' }),
    ).toEqual({ allowed: false, reason: 'CANNOT_GRANT_ABOVE_OWN_ROLE' });
  });

  it('stops an ADMIN demoting an OWNER or a peer ADMIN', () => {
    expect(
      canChangeRole({ ...base, actorRole: 'ADMIN', targetCurrentRole: 'OWNER', targetNewRole: 'MEMBER' }),
    ).toEqual({ allowed: false, reason: 'TARGET_OUTRANKS_ACTOR' });

    expect(
      canChangeRole({ ...base, actorRole: 'ADMIN', targetCurrentRole: 'ADMIN', targetNewRole: 'VIEWER' }),
    ).toEqual({ allowed: false, reason: 'TARGET_OUTRANKS_ACTOR' });
  });

  it('refuses self-modification even for an OWNER', () => {
    expect(
      canChangeRole({
        actorRole: 'OWNER',
        targetCurrentRole: 'OWNER',
        targetNewRole: 'ADMIN',
        actorIsTarget: true,
        ownerCount: 3,
      }),
    ).toEqual({ allowed: false, reason: 'CANNOT_MODIFY_SELF' });
  });

  it('refuses demoting the last OWNER', () => {
    expect(
      canChangeRole({
        actorRole: 'OWNER',
        targetCurrentRole: 'OWNER',
        targetNewRole: 'ADMIN',
        actorIsTarget: false,
        ownerCount: 1,
      }),
    ).toEqual({ allowed: false, reason: 'LAST_OWNER' });
  });

  it('allows an OWNER to demote a peer OWNER while another remains', () => {
    // Owners may administer their peers. Without this a two-owner org is
    // frozen: neither can ever remove the other, so a departing co-founder
    // keeps full access forever.
    expect(
      canChangeRole({
        actorRole: 'OWNER',
        targetCurrentRole: 'OWNER',
        targetNewRole: 'ADMIN',
        actorIsTarget: false,
        ownerCount: 2,
      }),
    ).toEqual({ allowed: true });
  });

  it('still stops an ADMIN acting on a peer ADMIN', () => {
    // The peer exception is OWNER-only; admins must not be able to demote
    // each other, or one compromised admin account takes the tenant hostage.
    expect(
      canChangeRole({ ...base, actorRole: 'ADMIN', targetCurrentRole: 'ADMIN', targetNewRole: 'VIEWER' }),
    ).toEqual({ allowed: false, reason: 'TARGET_OUTRANKS_ACTOR' });
  });

  it('allows an ADMIN the moves that are legitimately theirs', () => {
    expect(
      canChangeRole({ ...base, actorRole: 'ADMIN', targetCurrentRole: 'VIEWER', targetNewRole: 'MEMBER' }),
    ).toEqual({ allowed: true });
  });
});

describe('canRemoveMember — lockout guards', () => {
  it('lets a non-last OWNER leave voluntarily', () => {
    expect(
      canRemoveMember({ actorRole: 'OWNER', targetRole: 'OWNER', actorIsTarget: true, ownerCount: 2 }),
    ).toEqual({ allowed: true });
  });

  it('refuses to let the last OWNER leave', () => {
    // The organization would become permanently un-administrable.
    expect(
      canRemoveMember({ actorRole: 'OWNER', targetRole: 'OWNER', actorIsTarget: true, ownerCount: 1 }),
    ).toEqual({ allowed: false, reason: 'LAST_OWNER' });
  });

  it('lets any member leave on their own', () => {
    for (const role of ['ADMIN', 'MEMBER', 'VIEWER'] as const) {
      expect(
        canRemoveMember({ actorRole: role, targetRole: role, actorIsTarget: true, ownerCount: 1 }),
      ).toEqual({ allowed: true });
    }
  });

  it('allows an OWNER to remove a peer OWNER while another remains', () => {
    expect(
      canRemoveMember({ actorRole: 'OWNER', targetRole: 'OWNER', actorIsTarget: false, ownerCount: 2 }),
    ).toEqual({ allowed: true });
  });

  it('refuses removing the last OWNER even by another OWNER', () => {
    expect(
      canRemoveMember({ actorRole: 'OWNER', targetRole: 'OWNER', actorIsTarget: false, ownerCount: 1 }),
    ).toEqual({ allowed: false, reason: 'LAST_OWNER' });
  });

  it('stops an ADMIN removing an OWNER or a peer ADMIN', () => {
    expect(
      canRemoveMember({ actorRole: 'ADMIN', targetRole: 'OWNER', actorIsTarget: false, ownerCount: 2 }),
    ).toEqual({ allowed: false, reason: 'TARGET_OUTRANKS_ACTOR' });

    expect(
      canRemoveMember({ actorRole: 'ADMIN', targetRole: 'ADMIN', actorIsTarget: false, ownerCount: 2 }),
    ).toEqual({ allowed: false, reason: 'TARGET_OUTRANKS_ACTOR' });
  });

  it('refuses a MEMBER removing anyone else', () => {
    expect(
      canRemoveMember({ actorRole: 'MEMBER', targetRole: 'VIEWER', actorIsTarget: false, ownerCount: 2 }),
    ).toEqual({ allowed: false, reason: 'MISSING_PERMISSION' });
  });
});

describe('assignableRoles', () => {
  it('never offers a role above the actor', () => {
    expect(assignableRoles('ADMIN')).not.toContain('OWNER');
    expect(assignableRoles('OWNER')).toEqual([...ORGANIZATION_ROLES]);
  });

  it('offers nothing to roles that cannot invite', () => {
    expect(assignableRoles('MEMBER')).toEqual([]);
    expect(assignableRoles('VIEWER')).toEqual([]);
  });
});

describe('isRoleAtLeast', () => {
  it('orders the ladder correctly', () => {
    expect(isRoleAtLeast('OWNER', 'ADMIN')).toBe(true);
    expect(isRoleAtLeast('ADMIN', 'ADMIN')).toBe(true);
    expect(isRoleAtLeast('MEMBER', 'ADMIN')).toBe(false);
    expect(isRoleAtLeast('VIEWER', 'MEMBER')).toBe(false);
  });
});
