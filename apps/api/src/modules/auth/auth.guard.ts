import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode, ForbiddenError, UnauthenticatedError } from '../../common/errors/app-error.js';
import { SessionService } from './session.service.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from './cookies.js';

/** Marks a route as reachable without authentication. */
export const IS_PUBLIC = 'atlas:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Exempts a route from the CSRF check.
 *
 * Deliberately narrow and deliberately explicit. This exists for exactly one
 * situation: an endpoint that *establishes* a session rather than acting with
 * one, which a caller may reach while still holding a stale session cookie
 * from a previous sign-in. Login and registration are the only such endpoints.
 *
 * Two properties make this safe to have in the codebase:
 *
 *  - It is opt-in per route, so a future public mutation does not silently
 *    inherit the exemption. Auditing the exemptions is `grep CsrfExempt`.
 *  - It is only honoured on a route that is also @Public(). Applying it to an
 *    authenticated route does nothing, so it cannot be used — or misused — to
 *    disable CSRF on an endpoint that acts with ambient credentials.
 */
export const IS_CSRF_EXEMPT = 'atlas:csrfExempt';
export const CsrfExempt = () => SetMetadata(IS_CSRF_EXEMPT, true);

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

    const isCsrfExempt = this.reflector.getAllAndOverride<boolean>(IS_CSRF_EXEMPT, [
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

    // signedCookies, not cookies: cookie-parser puts a cookie here only when
    // its signature verifies, so a forged or tampered value never reaches the
    // session lookup. It arrives as `false` when the signature fails.
    const signed = request.signedCookies?.[SESSION_COOKIE] as string | false | undefined;
    const token = typeof signed === 'string' ? signed : undefined;

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

    // CSRF is enforced for authenticated state-changing requests only.
    //
    // Three exclusions, each for a distinct reason:
    //
    //  - Safe methods. GET/HEAD/OPTIONS are required to be side-effect free,
    //    and blocking them would break ordinary navigation into the app.
    //
    //  - Routes marked @CsrfExempt() *and* @Public(). Both are required. This
    //    covers session-establishing endpoints only — login and registration —
    //    which a caller may reach while holding a stale session cookie from a
    //    previous sign-in. Enforcing CSRF there was a real defect: the stale
    //    cookie made the login route resolve a session, which then demanded a
    //    token the caller had no way to hold, locking them out of signing in
    //    and breaking "sign in as someone else". The residual risk, login-CSRF
    //    forcing a victim into an attacker's account, is covered by
    //    SameSite=Lax on the session cookie, which blocks the cross-site POST
    //    that attack requires.
    //
    //    Note this is *not* a blanket exemption for public routes. A public
    //    mutation added later gets CSRF enforced unless someone explicitly and
    //    visibly opts it out.
    //
    //  - API-key callers, handled above: they send no cookies, and CSRF exists
    //    to defend against the browser attaching credentials automatically.
    const skipCsrf = isPublic && isCsrfExempt;

    if (!skipCsrf && !SAFE_METHODS.has(request.method)) {
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
