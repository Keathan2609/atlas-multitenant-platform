import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@atlas/database';
import type { Logger } from '@atlas/observability';
import type { CreateApiKeyInput } from '@atlas/validation';
import type { TenantContext } from '../../common/http/express.js';
import { CONFIG_TOKEN, type AppConfig } from '../../config/env.js';
import { LOGGER_TOKEN } from '../../common/logging/logger.provider.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { AuditAction, AuditService, type AuditEvent } from '../../common/audit/audit.service.js';
import { ErrorCode, NotFoundError } from '../../common/errors/app-error.js';

/**
 * Key format: atlas_live_<43 base64url chars>.
 *
 * The `atlas_live_` prefix is deliberate and public. It makes a leaked key
 * recognisable in a log, a paste, or a repository scan — GitHub's secret
 * scanning and similar tools match on exactly this kind of fixed prefix — and
 * it lets us reject obvious non-keys before touching the database.
 */
const KEY_PREFIX = 'atlas_live_';
const KEY_BYTES = 32;

/** Characters of the key stored in the clear so a key is recognisable in the UI. */
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 6;

/**
 * How stale `lastUsedAt` may become before it is rewritten.
 *
 * Updating it on every authenticated request would add a write to the hot
 * path of an API that exists to serve reads. A minute of staleness is
 * invisible in the UI, which shows it as "last used 3 minutes ago".
 */
const LAST_USED_REFRESH_SECONDS = 60;

export interface VerifiedApiKey {
  apiKeyId: string;
  organizationId: string;
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {}

  /**
   * Hashes a raw key for storage and lookup.
   *
   * SHA-256 over key + server pepper. A fast hash rather than Argon2, and
   * that is the right call here: the input is 256 bits of CSPRNG output, so
   * there is no dictionary to attack and a slow KDF would only tax every
   * authenticated request. What matters is that the stored value is not a
   * usable credential — a database dump yields nothing.
   *
   * The pepper lives in configuration rather than the database, so an
   * attacker with only a database dump cannot compute hashes to compare
   * against. Rotating it invalidates every existing key, which is the
   * intended emergency lever.
   */
  private hash(rawKey: string): string {
    return createHash('sha256').update(`${rawKey}${this.config.API_KEY_PEPPER}`, 'utf8').digest('hex');
  }

  /**
   * Creates a key and returns the raw value exactly once.
   *
   * Nothing anywhere stores the raw key after this method returns — not the
   * database, not the log. If the caller loses it they must issue a new one.
   */
  async create(
    tenant: TenantContext,
    actorId: string,
    input: CreateApiKeyInput,
    requestContext: Pick<AuditEvent, 'ipAddress' | 'userAgent'>,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const rawKey = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString('base64url')}`;
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const created = await db.apiKey.create({
      data: {
        id: newId(),
        name: input.name,
        keyPrefix: rawKey.slice(0, DISPLAY_PREFIX_LENGTH),
        keyHash: this.hash(rawKey),
        createdById: actorId,
        expiresAt,
      } as never,
      select: { id: true, name: true, keyPrefix: true, expiresAt: true, createdAt: true },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      actorId,
      action: AuditAction.APIKEY_CREATED,
      resourceType: 'api_key',
      resourceId: created.id,
      // Name and prefix only. The raw key and its hash are both excluded —
      // the audit log is admin-readable and long-lived.
      metadata: { name: created.name, keyPrefix: created.keyPrefix },
      ...requestContext,
    });

    this.logger.info(
      { event: 'apikey.created', organizationId: tenant.organizationId, apiKeyId: created.id },
      'API key created',
    );

    // `key` is present on this response and on no other. Every later read
    // returns the prefix alone.
    return { ...created, key: rawKey };
  }

  async list(tenant: TenantContext) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const keys = await db.apiKey.findMany({
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
        createdBy: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    return {
      data: keys.map((key) => ({
        ...key,
        // Derived rather than stored: a stored status would drift out of date
        // the moment a key passed its expiry without anything writing to it.
        status: key.revokedAt
          ? ('REVOKED' as const)
          : key.expiresAt && key.expiresAt <= now
            ? ('EXPIRED' as const)
            : ('ACTIVE' as const),
      })),
    };
  }

  /**
   * Revokes a key.
   *
   * Irreversible by design — there is no un-revoke. A key is revoked because
   * it may be compromised, and offering restoration would invite someone to
   * undo the containment rather than issue a fresh one.
   */
  async revoke(
    tenant: TenantContext,
    actorId: string,
    apiKeyId: string,
    requestContext: Pick<AuditEvent, 'ipAddress' | 'userAgent'>,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const key = await db.apiKey.findFirst({
      where: { id: apiKeyId },
      select: { id: true, name: true, keyPrefix: true, revokedAt: true },
    });

    if (!key) {
      throw new NotFoundError(ErrorCode.API_KEY_NOT_FOUND, 'That API key could not be found.');
    }

    // Revoking an already-revoked key is a no-op rather than an error: the
    // caller's intent is already satisfied, and failing would push a panicking
    // operator to retry against a key they think is still live.
    if (key.revokedAt) return { id: key.id, revokedAt: key.revokedAt };

    const revokedAt = new Date();
    await db.$transaction(async (tx) => {
      await tx.apiKey.update({ where: { id: apiKeyId }, data: { revokedAt } });
      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          actorId,
          action: AuditAction.APIKEY_REVOKED,
          resourceType: 'api_key',
          resourceId: apiKeyId,
          metadata: { name: key.name, keyPrefix: key.keyPrefix },
          ...requestContext,
        },
        tx,
      );
    });

    this.logger.warn(
      { event: 'apikey.revoked', organizationId: tenant.organizationId, apiKeyId },
      'API key revoked',
    );

    return { id: apiKeyId, revokedAt };
  }

  /**
   * Verifies a presented key and resolves it to its organization.
   *
   * Returns null for every failure — unknown, revoked, expired — so a caller
   * cannot distinguish them. Telling an attacker that a key is "revoked"
   * rather than "unknown" confirms the key was once real.
   *
   * Lookup is a single indexed equality probe on the hash, so a wrong key
   * costs one index hit rather than a scan.
   */
  async verify(rawKey: string): Promise<VerifiedApiKey | null> {
    if (!rawKey.startsWith(KEY_PREFIX) || rawKey.length < KEY_PREFIX.length + 20) {
      return null;
    }

    const record = await this.prisma.unscoped.apiKey.findUnique({
      where: { keyHash: this.hash(rawKey) },
      select: {
        id: true,
        organizationId: true,
        keyHash: true,
        revokedAt: true,
        expiresAt: true,
        lastUsedAt: true,
        organization: { select: { deletedAt: true } },
      },
    });

    if (!record) return null;

    // The unique index already selected this row by hash, so this comparison
    // is belt-and-braces. It costs microseconds and removes any dependence on
    // the index lookup being the only equality check in the path.
    if (!safeCompare(record.keyHash, this.hash(rawKey))) return null;

    if (record.revokedAt) return null;
    if (record.expiresAt && record.expiresAt <= new Date()) return null;
    // A key must not outlive its organization.
    if (record.organization.deletedAt) return null;

    void this.touch(record.id, record.lastUsedAt);

    return { apiKeyId: record.id, organizationId: record.organizationId };
  }

  /** Refreshes lastUsedAt at most once per LAST_USED_REFRESH_SECONDS. */
  private async touch(apiKeyId: string, lastUsedAt: Date | null): Promise<void> {
    const staleAfter = Date.now() - LAST_USED_REFRESH_SECONDS * 1000;
    if (lastUsedAt && lastUsedAt.getTime() > staleAfter) return;

    try {
      await this.prisma.unscoped.apiKey.update({
        where: { id: apiKeyId },
        data: { lastUsedAt: new Date() },
      });
    } catch (error) {
      this.logger.debug({ event: 'apikey.touch_failed', err: error }, 'Could not update lastUsedAt');
    }
  }
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
