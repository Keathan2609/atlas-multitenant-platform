import { Injectable } from '@nestjs/common';
import type { ListAuditLogsInput } from '@atlas/validation';
import type { TenantContext } from '../../common/http/express.js';
import { PrismaService } from '../../common/database/prisma.service.js';

/**
 * One audit entry as the API returns it.
 *
 * Declared explicitly rather than inferred. The `metadata` column is Prisma
 * Json, whose generated type names a path inside Prisma's runtime that
 * TypeScript refuses to emit as portable (TS2742) — and stating the wire shape
 * here also stops an added `select` field leaking into the public response by
 * accident.
 */
export interface AuditLogEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  ipAddress: string | null;
  createdAt: Date;
  actor: {
    id: string;
    displayName: string;
    email: string;
    avatarUrl: string | null;
  } | null;
}

export interface AuditLogPage {
  data: AuditLogEntry[];
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
}

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the audit log, newest first, with cursor pagination.
   *
   * Cursor rather than offset, for two reasons specific to this table. It is
   * append-heavy, so an offset page drifts as rows arrive — a reader paging
   * through would see entries twice or skip them. And it grows without bound,
   * where `OFFSET 50000` costs the database 50,000 discarded rows.
   *
   * The cursor is an id, which works as a chronological cursor only because
   * ATLAS ids are UUIDv7 and therefore time-ordered. `WHERE id < cursor ORDER
   * BY id DESC` is a single-column index scan against
   * `@@index([organizationId, id(sort: Desc)])` with no tiebreaker column.
   * See docs/decisions/0004-uuidv7-identifiers.md.
   */
  async list(tenant: TenantContext, query: ListAuditLogsInput): Promise<AuditLogPage> {
    const db = this.prisma.forTenant(tenant.organizationId);

    const where = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      ...(query.resourceId ? { resourceId: query.resourceId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
    };

    // One extra row tells us whether another page exists without a second
    // COUNT query — which on an unbounded table would be the expensive part.
    const rows = await db.auditLog.findMany({
      where,
      select: {
        id: true,
        action: true,
        resourceType: true,
        resourceId: true,
        metadata: true,
        ipAddress: true,
        createdAt: true,
        actor: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    return {
      data: page as AuditLogEntry[],
      pagination: {
        limit: query.limit,
        hasMore,
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      },
    };
  }

  /**
   * Distinct action names present in this tenant's log.
   *
   * Populates the filter dropdown from what has actually happened, rather than
   * from the full AuditAction catalogue — offering filters that can only ever
   * return nothing is worse than offering fewer.
   */
  async actions(tenant: TenantContext): Promise<{ data: string[] }> {
    const db = this.prisma.forTenant(tenant.organizationId);
    const rows = await db.auditLog.findMany({
      select: { action: true },
      distinct: ['action'],
      orderBy: { action: 'asc' },
    });
    return { data: rows.map((row) => row.action) };
  }
}
