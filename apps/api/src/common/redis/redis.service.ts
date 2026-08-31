import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import type { Logger } from '@atlas/observability';
import { CONFIG_TOKEN, type AppConfig } from '../../config/env.js';
import { LOGGER_TOKEN } from '../logging/logger.provider.js';

/**
 * Redis connection.
 *
 * What ATLAS actually uses Redis for, and deliberately nothing more:
 *
 *   - Rate-limit counters (login, registration, invitations, API-key traffic)
 *   - Session lookup cache, in front of the Postgres session table
 *   - Invitation send throttling
 *   - Short-lived locks around non-idempotent operations
 *
 * Every one of those is reconstructible, which is why the container runs with
 * persistence disabled. Redis is not a source of truth here; if it is wiped,
 * the system loses rate-limit history and a warm cache, not data.
 *
 * See docs/decisions/007-redis-usage.md.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;

  constructor(
    @Inject(CONFIG_TOKEN) config: AppConfig,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {
    this.client = new Redis(config.REDIS_URL, {
      // Fail fast rather than queueing commands forever behind a dead server.
      maxRetriesPerRequest: 3,
      // Do not block application boot on Redis; a degraded cache should not
      // take the API down. Health readiness reports the real state.
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });

    this.client.on('error', (error: Error) => {
      // Logged at warn, not error: a transient Redis blip degrades rate
      // limiting and cache hits but does not break correctness.
      this.logger.warn({ event: 'redis.error', err: error }, 'Redis connection error');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.info({ event: 'redis.connected' }, 'Redis connection established');
    } catch (error) {
      this.logger.warn(
        { event: 'redis.connect_failed', err: error },
        'Redis unavailable at boot; continuing in degraded mode',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Fixed-window counter.
   *
   * Returns the count after increment and the seconds until the window
   * resets. INCR and EXPIRE are pipelined so the key cannot be left without a
   * TTL if the process dies between them — an un-expiring counter would lock
   * a user out permanently.
   *
   * A fixed window admits up to 2x the limit across a boundary. That is
   * accepted deliberately: for login throttling the goal is to make automated
   * guessing expensive, and the extra complexity of a sliding-log window buys
   * little against that. Documented in docs/security.md § rate limiting.
   */
  async incrementWindow(key: string, windowSeconds: number): Promise<{ count: number; ttl: number }> {
    const results = await this.client
      .multi()
      .incr(key)
      .expire(key, windowSeconds, 'NX')
      .ttl(key)
      .exec();

    if (!results) {
      // Redis unreachable. Fail open rather than locking every user out of a
      // working API — the trade-off is argued in docs/security.md.
      return { count: 0, ttl: windowSeconds };
    }

    const count = Number(results[0]?.[1] ?? 0);
    const ttl = Number(results[2]?.[1] ?? windowSeconds);
    return { count, ttl: ttl > 0 ? ttl : windowSeconds };
  }

  async resetWindow(key: string): Promise<void> {
    await this.client.del(key).catch(() => undefined);
  }
}
