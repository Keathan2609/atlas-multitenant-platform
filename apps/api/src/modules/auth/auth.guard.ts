import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode, ForbiddenError, UnauthenticatedError } from '../../common/errors/app-error.js';
import { SessionService } from './session.service.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from './cookies.js';

/** Marks a route as reachable without authentication. */
export const IS_PUBLIC = 'atlas:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Authenticates every request unless the route is explicitly `@Public()`.
 *
 * Registered globally, so the default for a new endpoint is "protected".
 * Opt-in authentication is the wrong default: forgetting a decorator should
 * lock a route down, not expose it.
 *
 * CSRF is enforced here too, because the two are inseparable — the check only
 * matters for cookie-authenticated requests, and this is where we know that a
 * request is one.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request>();

    // An API-key authenticated request is resolved by ApiKeyGuard earlier in
    // the chain. It carries no cookies, so CSRF does not apply — CSRF defends
    // against the browser attaching ambient credentials, and there are none.
    if (request.apiKeyContext) {
      return true;
    }

    const token = request.cookies?.[SESSION_COOKIE] as string | undefined;

    if (!token) {
      if (isPublic) return true;
      throw new UnauthenticatedError();
    }

    const session = await this.sessions.resolve(token);

    if (!session) {
      if (isPublic) return true;
      throw new UnauthenticatedError(
        ErrorCode.SESSION_EXPIRED,
        'Your session has expired. Sign in again.',
      );
    }

    // Enforced for authenticated state-changing requests only. GET/HEAD/
    // OPTIONS are required to be side-effect free, and blocking them would
    // break ordinary navigation into the app.
    if (!SAFE_METHODS.has(request.method)) {
      this.assertCsrf(request);
    }

    request.user = session.user;
    request.sessionId = session.sessionId;
    return true;
  }

  /**
   * Double-submit CSRF check.
   *
   * The attacker's page can make the browser send our cookie, but the
   * same-origin policy stops it reading that cookie to construct the matching
   * header. Compared in constant time so a near-miss does not leak how much of
   * a guess was right.
   */
  private assertCsrf(request: Request): void {
    const cookieToken = request.cookies?.[CSRF_COOKIE] as string | undefined;
    const headerToken = request.header(CSRF_HEADER);

    if (!cookieToken || !headerToken) {
      throw new ForbiddenError(
        ErrorCode.FORBIDDEN,
        'Missing CSRF token. Reload the page and try again.',
        { reason: 'csrf_token_absent' },
      );
    }

    if (!SessionService.safeCompare(cookieToken, headerToken)) {
      throw new ForbiddenError(
        ErrorCode.FORBIDDEN,
        'Invalid CSRF token. Reload the page and try again.',
        { reason: 'csrf_token_mismatch' },
      );
    }
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
