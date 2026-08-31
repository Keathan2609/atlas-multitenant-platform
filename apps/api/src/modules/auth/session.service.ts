import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@atlas/database';
import type { Logger } from '@atlas/observability';
import { CONFIG_TOKEN, type AppConfig } from '../../config/env.js';
import { LOGGER_TOKEN } from '../../common/logging/logger.provider.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { RedisService } from '../../common/redis/redis.service.js';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ActiveSession {
  sessionId: string;
  user: SessionUser;
  expiresAt: Date;
}

/** Bytes of entropy in a session token. 32 bytes = 256 bits. */
const TOKEN_BYTES = 32;

/**
 * How long a cached session may be trusted without re-reading Postgres.
 *
 * The cache is what keeps authentication off the database on every request,
 * but it also means a revoked session stays usable for up to this long. 60
 * seconds is the chosen bound: short enough that "sign out everywhere" feels
 * immediate, long enough to absorb the request rate of a normal page load.
 *
 * Revocation deletes the cache key directly, so in practice logout is instant
 * on a healthy Redis; this TTL only matters if that delete fails.
 */
const SESSION_CACHE_TTL_SECONDS = 60;

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {}

  /**
   * Hashes a session token for storage.
   *
   * SHA-256 with no salt or stretching, deliberately. Unlike a password, the
   * token is 256 bits of cryptographic randomness, so there is no dictionary
   * to attack and no benefit from a slow KDF — a fast hash keeps the
   * per-request verification cheap. What matters is that the database never
   * holds a usable token: an attacker with a full dump cannot reverse these
   * into session cookies.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Issues a session and returns the raw token, which is shown exactly once —
   * to be set as an HTTP-only cookie. Only the hash is persisted.
   */
  async create(
    userId: string,
    context: { ipAddress?: string; userAgent?: string },
  ): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = this.hashToken(token);
    const sessionId = newId();
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_SECONDS * 1000);

    await this.prisma.unscoped.session.create({
      data: {
        id: sessionId,
        userId,
        tokenHash,
        expiresAt,
        ipAddress: context.ipAddress?.slice(0, 45) ?? null,
        userAgent: context.userAgent?.slice(0, 512) ?? null,
      },
    });

    return { token, sessionId, expiresAt };
  }

  /**
   * Resolves a raw token to an active session, or null.
   *
   * Checks Redis first, then Postgres. A miss on both is an anonymous request;
   * callers must treat null as unauthenticated rather than as an error.
   */
  async resolve(token: string): Promise<ActiveSession | null> {
    if (!token || token.length < 16) return null;

    const tokenHash = this.hashToken(token);
    const cacheKey = `session:${tokenHash}`;

    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const session = await this.prisma.unscoped.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: { id: true, email: true, displayName: true, avatarUrl: true },
        },
      },
    });

    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      return null;
    }

    const active: ActiveSession = {
      sessionId: session.id,
      user: session.user,
      expiresAt: session.expiresAt,
    };

    await this.writeCache(cacheKey, active);

    // Fire-and-forget: lastSeenAt drives the "active sessions" list in
    // settings, and is not worth adding a write to the critical path of every
    // authenticated request. Failure is logged, never surfaced.
    void this.touch(session.id);

    return active;
  }

  private async readCache(key: string): Promise<ActiveSession | null> {
    try {
      const raw = await this.redis.client.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ActiveSession & { expiresAt: string };
      const expiresAt = new Date(parsed.expiresAt);
      if (expiresAt <= new Date()) return null;
      return { ...parsed, expiresAt };
    } catch {
      // A cache miss and a cache failure are the same thing to the caller:
      // fall through to Postgres.
      return null;
    }
  }

  private async writeCache(key: string, session: ActiveSession): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(session), 'EX', SESSION_CACHE_TTL_SECONDS);
    } catch {
      // Degraded cache is acceptable; correctness comes from Postgres.
    }
  }

  private async touch(sessionId: string): Promise<void> {
    try {
      await this.prisma.unscoped.session.update({
        where: { id: sessionId },
        data: { lastSeenAt: new Date() },
      });
    } catch (error) {
      this.logger.debug({ event: 'session.touch_failed', err: error }, 'Could not update lastSeenAt');
    }
  }

  /** Revokes one session and evicts it from cache immediately. */
  async revoke(sessionId: string): Promise<void> {
    const session = await this.prisma.unscoped.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
      select: { tokenHash: true },
    });
    await this.redis.client.del(`session:${session.tokenHash}`).catch(() => undefined);
  }

  /**
   * Revokes every session for a user — "sign out everywhere".
   *
   * Called on password change, which is what makes a password reset actually
   * evict an attacker who already holds a session cookie.
   */
  async revokeAllForUser(userId: string, options: { exceptSessionId?: string } = {}): Promise<number> {
    const sessions = await this.prisma.unscoped.session.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
      },
      select: { id: true, tokenHash: true },
    });

    if (sessions.length === 0) return 0;

    await this.prisma.unscoped.session.updateMany({
      where: { id: { in: sessions.map((s) => s.id) } },
      data: { revokedAt: new Date() },
    });

    await Promise.all(
      sessions.map((s) => this.redis.client.del(`session:${s.tokenHash}`).catch(() => undefined)),
    );

    return sessions.length;
  }

  async listForUser(userId: string) {
    return this.prisma.unscoped.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
      },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /**
   * Constant-time comparison for the CSRF double-submit check.
   *
   * `===` on secrets short-circuits at the first differing byte, which leaks
   * how much of a guess was correct.
   */
  static safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
