import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { RateLimitedError } from '../errors/app-error.js';
import { RedisService } from '../redis/redis.service.js';

export interface RateLimitOptions {
  /** Requests permitted per window. */
  max: number;
  windowSeconds: number;
  /**
   * Bucket discriminator. `ip` for pre-authentication endpoints, `user` once
   * we know who is calling, `ip+body` for endpoints where one IP legitimately
   * serves many users but a single target should still be protected — login
   * being the important case.
   */
  by?: 'ip' | 'user' | 'ip+email';
}

export const RATE_LIMIT = 'atlas:rateLimit';
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT, options);

/**
 * Redis-backed fixed-window rate limiting.
 *
 * Applied to the endpoints where abuse is cheap and consequential: login,
 * registration, and invitation sending. General API traffic is limited
 * separately per API key.
 *
 * Two deliberate decisions:
 *
 *  1. **Fails open.** If Redis is unreachable the request proceeds. Locking
 *     every user out of a working API because a cache is down trades a real
 *     outage for a hypothetical attack. The trade-off, and the monitoring that
 *     compensates for it, is argued in docs/security.md § rate limiting.
 *
 *  2. **Login buckets on IP *and* email.** Bucketing on IP alone lets an
 *     attacker with a botnet spread guesses across addresses; bucketing on
 *     email alone lets one attacker lock a victim out of their own account by
 *     exhausting the budget deliberately. Combining them means an attacker
 *     must own both dimensions, and a victim behind a shared NAT is not
 *     collateral damage.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const key = this.bucketKey(request, options, context);

    const { count, ttl } = await this.redis.incrementWindow(key, options.windowSeconds);

    // count === 0 means Redis was unreachable and incrementWindow failed open.
    if (count > 0 && count > options.max) {
      throw new RateLimitedError(ttl);
    }

    return true;
  }

  private bucketKey(
    request: Request,
    options: RateLimitOptions,
    context: ExecutionContext,
  ): string {
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const by = options.by ?? 'ip';

    switch (by) {
      case 'user':
        return `ratelimit:${route}:user:${request.user?.id ?? this.clientIp(request)}`;
      case 'ip+email': {
        const body = request.body as { email?: unknown } | undefined;
        const email = typeof body?.email === 'string' ? body.email.toLowerCase() : 'anonymous';
        // Hashed so a Redis dump does not become a list of addresses that
        // have attempted to sign in, and so an oversized body value cannot
        // produce an unbounded key.
        const emailKey = createHash('sha256').update(email).digest('hex').slice(0, 32);
        return `ratelimit:${route}:ip:${this.clientIp(request)}:email:${emailKey}`;
      }
      case 'ip':
      default:
        return `ratelimit:${route}:ip:${this.clientIp(request)}`;
    }
  }

  /**
   * Client IP.
   *
   * Express resolves `req.ip` from X-Forwarded-For only when `trust proxy` is
   * configured, which main.ts sets explicitly for the known proxy hop. Without
   * that, a client could spoof the header and give itself a fresh rate-limit
   * bucket on every request.
   */
  private clientIp(request: Request): string {
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }
}
