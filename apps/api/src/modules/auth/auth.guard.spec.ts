import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import { AuthGuard, IS_CSRF_EXEMPT, IS_PUBLIC } from './auth.guard.js';
import type { SessionService } from './session.service.js';

/**
 * The CSRF exemption boundary.
 *
 * Tested at the guard rather than over HTTP because the case that matters most
 * — a @Public() mutation that is *not* exempt — has no route in the
 * application to exercise it through. That is the point: the exemption must
 * not be something a future public endpoint inherits by existing. Asserting it
 * here means the rule is pinned before such a route is ever written.
 *
 * The four combinations, and why each is what it is:
 *
 *   public + exempt      -> skip.   Login and registration: session-establishing,
 *                                   reachable with a stale cookie.
 *   public + not exempt  -> ENFORCE. A future public mutation must not silently
 *                                   lose CSRF just by being public.
 *   private + exempt     -> ENFORCE. The decorator cannot be used, or misused,
 *                                   to disable CSRF on an authenticated route.
 *   private + not exempt -> ENFORCE. The ordinary case.
 */

const VALID_SESSION = {
  sessionId: 'session-1',
  user: { id: 'user-1', email: 'dana@northstar.example', displayName: 'Dana', avatarUrl: null },
  expiresAt: new Date(Date.now() + 60_000),
};

function buildContext(options: {
  isPublic: boolean;
  isCsrfExempt: boolean;
  method?: string;
  csrfCookie?: string;
  csrfHeader?: string;
}) {
  const request = {
    method: options.method ?? 'POST',
    // A resolvable session cookie: the stale-cookie situation the fix is about.
    signedCookies: { atlas_session: 'a-valid-session-token-value' } as Record<string, unknown>,
    cookies: { atlas_csrf: options.csrfCookie } as Record<string, unknown>,
    header: (name: string) =>
      name.toLowerCase() === 'x-csrf-token' ? options.csrfHeader : undefined,
    ip: '127.0.0.1',
    originalUrl: '/api/v1/test',
  } as unknown as Record<string, unknown>;

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;

  const reflector = {
    getAllAndOverride: (key: string) =>
      key === IS_PUBLIC ? options.isPublic : key === IS_CSRF_EXEMPT ? options.isCsrfExempt : undefined,
  } as unknown as Reflector;

  const sessions = {
    resolve: vi.fn().mockResolvedValue(VALID_SESSION),
  } as unknown as SessionService;

  return { guard: new AuthGuard(sessions, reflector), context, request };
}

describe('AuthGuard CSRF exemption boundary', () => {
  it('skips CSRF for a public, explicitly exempt route', async () => {
    // Login and register. No token supplied, and none required.
    const { guard, context } = buildContext({ isPublic: true, isCsrfExempt: true });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('ENFORCES CSRF for a public route that is not exempt', async () => {
    // The regression this test exists for. A public mutation added later must
    // not inherit the exemption merely by being public.
    const { guard, context } = buildContext({ isPublic: true, isCsrfExempt: false });
    await expect(guard.canActivate(context)).rejects.toThrow(/CSRF/i);
  });

  it('ENFORCES CSRF on an authenticated route even when marked exempt', async () => {
    // The decorator is only honoured together with @Public(), so it cannot be
    // applied — by accident or otherwise — to an endpoint that acts with
    // ambient credentials.
    const { guard, context } = buildContext({ isPublic: false, isCsrfExempt: true });
    await expect(guard.canActivate(context)).rejects.toThrow(/CSRF/i);
  });

  it('ENFORCES CSRF on an ordinary authenticated route', async () => {
    const { guard, context } = buildContext({ isPublic: false, isCsrfExempt: false });
    await expect(guard.canActivate(context)).rejects.toThrow(/CSRF/i);
  });

  it('accepts an authenticated mutation carrying a matching token', async () => {
    const { guard, context } = buildContext({
      isPublic: false,
      isCsrfExempt: false,
      csrfCookie: 'matching-token-value',
      csrfHeader: 'matching-token-value',
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects a mismatched token', async () => {
    const { guard, context } = buildContext({
      isPublic: false,
      isCsrfExempt: false,
      csrfCookie: 'one-value-here-padded',
      csrfHeader: 'another-value-padded',
    });
    await expect(guard.canActivate(context)).rejects.toThrow(/CSRF/i);
  });

  it('never applies CSRF to safe methods, exempt or not', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const { guard, context } = buildContext({
        isPublic: false,
        isCsrfExempt: false,
        method,
      });
      await expect(guard.canActivate(context), method).resolves.toBe(true);
    }
  });

  it('populates the request with the resolved user on success', async () => {
    const { guard, context, request } = buildContext({ isPublic: true, isCsrfExempt: true });
    await guard.canActivate(context);

    // The role and identity used for every downstream decision come from the
    // server-resolved session, never from anything the client sent.
    expect((request as { user?: { id: string } }).user?.id).toBe('user-1');
    expect((request as { sessionId?: string }).sessionId).toBe('session-1');
  });
});
