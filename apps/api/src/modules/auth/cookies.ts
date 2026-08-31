import { randomBytes } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../../config/env.js';

export const SESSION_COOKIE = 'atlas_session';
export const CSRF_COOKIE = 'atlas_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Cookie policy.
 *
 * The session cookie is:
 *   httpOnly  — script cannot read it, so an XSS foothold cannot exfiltrate
 *               the session token itself.
 *   sameSite  — 'lax' blocks the cross-site POST that CSRF depends on while
 *               still allowing normal top-level navigation into the app.
 *   secure    — HTTPS-only in production. Left off in development because
 *               localhost is plain HTTP and a secure cookie would simply never
 *               be sent, making local login silently impossible.
 *   path '/'  — sent to the whole API surface.
 *
 * No `domain` is set, so the cookie stays host-only. Setting a parent domain
 * would share it with every subdomain, including anything else deployed there.
 */
export function sessionCookieOptions(config: AppConfig, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

/**
 * The CSRF cookie is deliberately NOT httpOnly.
 *
 * This is the double-submit pattern: the browser holds a random value the
 * client-side code reads and echoes back in a header. A cross-site attacker
 * can cause the cookie to be *sent* but — blocked by the same-origin policy —
 * cannot read it to set the matching header, so the two never agree.
 *
 * Readability is the mechanism, not an oversight. It carries no authority on
 * its own: knowing the CSRF value grants nothing without the httpOnly session
 * cookie alongside it.
 */
export function csrfCookieOptions(config: AppConfig, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: false,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function setAuthCookies(
  response: Response,
  config: AppConfig,
  token: string,
  maxAgeSeconds: number,
): string {
  const csrfToken = newCsrfToken();
  response.cookie(SESSION_COOKIE, token, sessionCookieOptions(config, maxAgeSeconds));
  response.cookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(config, maxAgeSeconds));
  return csrfToken;
}

export function clearAuthCookies(response: Response, config: AppConfig): void {
  // Clearing must repeat the original attributes. A cookie set with
  // sameSite/secure/path is not removed by a bare clearCookie(name) — the
  // browser treats it as a different cookie and the session survives logout.
  response.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(config, 0), maxAge: undefined });
  response.clearCookie(CSRF_COOKIE, { ...csrfCookieOptions(config, 0), maxAge: undefined });
}
