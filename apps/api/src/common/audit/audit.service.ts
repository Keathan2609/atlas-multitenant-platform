import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { newId } from '@atlas/database';
import type { Logger } from '@atlas/observability';
import { LOGGER_TOKEN } from '../logging/logger.provider.js';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Audit action names.
 *
 * Kept as a const object rather than a database enum: audit history has to
 * survive an action being removed from the code, and an enum migration would
 * have to rewrite or drop historical rows. The database column is a plain
 * string for exactly that reason.
 */
export const AuditAction = {
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  ORGANIZATION_DELETED: 'organization.deleted',
  SETTINGS_UPDATED: 'organization.settings_updated',

  MEMBER_INVITED: 'member.invited',
  MEMBER_JOINED: 'member.joined',
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  MEMBER_REMOVED: 'member.removed',
  MEMBER_LEFT: 'member.left',
  INVITATION_REVOKED: 'invitation.revoked',

  TEAM_CREATED: 'team.created',
  TEAM_UPDATED: 'team.updated',
  TEAM_DELETED: 'team.deleted',

  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_DELETED: 'workspace.deleted',

  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_ARCHIVED: 'project.archived',
  PROJECT_DELETED: 'project.deleted',

  APIKEY_CREATED: 'apikey.created',
  APIKEY_REVOKED: 'apikey.revoked',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * The only capability the audit writer needs from a client.
 *
 * Kept minimal so both the scoped and unscoped Prisma clients — and their
 * transaction variants — satisfy it structurally.
 */
export interface AuditCapableClient {
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface AuditEvent {
  organizationId: string;
  /** Null for system-originated events such as scheduled cleanup. */
  actorId: string | null;
  action: AuditAction;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Metadata keys that must never be persisted, whatever a caller passes.
 *
 * The audit log is read by admins in the product UI and is one of the longest
 * lived tables in the system, so a secret written here would be both widely
 * visible and durable. Callers are not trusted to remember that.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'token',
  'tokenhash',
  'keyhash',
  'apikey',
  'secret',
  'authorization',
  'cookie',
]);

/**
 * Records administratively significant actions.
 *
 * Centralised rather than inserted ad hoc at each call site, for two reasons:
 * the metadata scrub below applies uniformly, and `record()` can be enlisted
 * in a caller's transaction so an audit entry and the change it describes
 * commit or roll back together. An audit trail that can disagree with the
 * state it describes is worse than none, because it is trusted.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {}

  /**
   * Writes an audit entry.
   *
   * Pass `tx` to enlist in an existing transaction — the org-creation flow
   * does this so the organization, its owner membership and the audit event
   * are one atomic unit.
   *
   * `tx` is typed structurally rather than as Prisma.TransactionClient so it
   * accepts a transaction from a *tenant-scoped* client as well as an
   * unscoped one. Those are different generated types, and requiring the
   * unscoped one would push callers toward `unscoped.$transaction` — giving
   * up tenant scoping precisely inside the mutations that most need it.
   */
  async record(event: AuditEvent, tx?: AuditCapableClient): Promise<void> {
    const client: AuditCapableClient = tx ?? (this.prisma.unscoped as unknown as AuditCapableClient);

    await client.auditLog.create({
      data: {
        id: newId(),
        organizationId: event.organizationId,
        actorId: event.actorId,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId ?? null,
        metadata: scrubMetadata(event.metadata ?? {}),
        ipAddress: event.ipAddress?.slice(0, 45) ?? null,
        userAgent: event.userAgent?.slice(0, 512) ?? null,
      },
    });

    this.logger.info(
      {
        event: 'audit.recorded',
        action: event.action,
        organizationId: event.organizationId,
        actorId: event.actorId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
      },
      'Audit event recorded',
    );
  }

  /**
   * Records outside the caller's transaction and never throws.
   *
   * For events where losing the entry is preferable to failing the user's
   * operation — a successful login, say. Anything administratively
   * significant uses `record()` inside a transaction instead, so it cannot
   * silently go missing.
   */
  async recordBestEffort(event: AuditEvent): Promise<void> {
    try {
      await this.record(event);
    } catch (error) {
      this.logger.error(
        { event: 'audit.write_failed', action: event.action, err: error },
        'Failed to write audit entry',
      );
    }
  }
}

/** Extracts request context for an audit entry. */
export function auditContext(request: Request): Pick<AuditEvent, 'ipAddress' | 'userAgent'> {
  return {
    ipAddress: request.ip ?? null,
    userAgent: request.header('user-agent') ?? null,
  };
}

/**
 * Drops forbidden keys and caps the payload.
 *
 * Shallow by design: audit metadata is a flat descriptor of what changed, and
 * accepting nested structures would invite callers to dump whole entities —
 * which is how a passwordHash ends up in a table admins can read.
 */
/**
 * Post-scrub metadata is always flat and JSON-primitive, which is exactly
 * what Prisma's Json column accepts. Stating that in the type rather than
 * casting keeps the guarantee checked: if the scrub ever started letting a
 * nested object through, this would stop compiling instead of storing an
 * unreviewed structure.
 */
type ScrubbedMetadata = Record<string, string | number | boolean | null>;

function scrubMetadata(metadata: Record<string, unknown>): ScrubbedMetadata {
  const output: ScrubbedMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''))) continue;
    if (value === undefined) continue;

    // Flatten anything non-primitive to a short string rather than storing a
    // structure whose contents nobody reviewed.
    if (value !== null && typeof value === 'object') {
      output[key] = JSON.stringify(value).slice(0, 500);
      continue;
    }

    if (typeof value === 'string') {
      output[key] = value.slice(0, 500);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
    } else {
      // bigint, symbol, function: not representable as JSON. Record the
      // shape rather than dropping it silently, so a caller passing the
      // wrong thing is visible in the trail.
      output[key] = `[${typeof value}]`;
    }
  }

  return output;
}
