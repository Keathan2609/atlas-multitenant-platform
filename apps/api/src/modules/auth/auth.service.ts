import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@atlas/database';
import type { Logger } from '@atlas/observability';
import type { LoginInput, RegisterInput, UpdateProfileInput } from '@atlas/validation';
import { LOGGER_TOKEN } from '../../common/logging/logger.provider.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import {
  AppError,
  ConflictError,
  ErrorCode,
  UnauthenticatedError,
} from '../../common/errors/app-error.js';
import { PasswordService } from './password.service.js';
import { SessionService, type SessionUser } from './session.service.js';

export interface AuthResult {
  user: SessionUser;
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {}

  /**
   * Registers a new account.
   *
   * Registration is the one place a duplicate-email response is unavoidable —
   * the user has to be told the address is taken or they cannot proceed. Login
   * and invitation flows do not leak the same fact; see `login` below.
   *
   * The uniqueness check is advisory only. The authoritative guarantee is the
   * unique index on users.email, and the P2002 catch below is what makes two
   * simultaneous signups for the same address resolve correctly instead of
   * racing between the SELECT and the INSERT.
   */
  async register(input: RegisterInput, context: RequestContext): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(input.password);

    let user: SessionUser;
    try {
      user = await this.prisma.unscoped.user.create({
        data: {
          id: newId(),
          email: input.email,
          displayName: input.displayName,
          passwordHash,
        },
        select: { id: true, email: true, displayName: true, avatarUrl: true },
      });
    } catch (error) {
      if (isUniqueViolation(error, 'email')) {
        throw new ConflictError(
          ErrorCode.EMAIL_ALREADY_REGISTERED,
          'An account with this email address already exists.',
          [{ field: 'email', message: 'This email address is already registered.' }],
        );
      }
      throw error;
    }

    this.logger.info({ event: 'auth.registered', userId: user.id }, 'Account created');

    const session = await this.sessions.create(user.id, context);
    return { user, ...session };
  }

  /**
   * Authenticates an existing account.
   *
   * Every failure path returns the same INVALID_CREDENTIALS error and takes
   * comparable time:
   *
   *  - Unknown email  -> verifyDummy() burns equivalent Argon2 work.
   *  - Wrong password -> real verification fails.
   *  - SSO-only user  -> verifyDummy(), so the absence of a password hash is
   *                      not observable either.
   *
   * Without the dummy verification, an unknown address returns in
   * microseconds and a real one in tens of milliseconds, which is a reliable
   * account-enumeration oracle no matter how carefully the message is worded.
   */
  async login(input: LoginInput, context: RequestContext): Promise<AuthResult> {
    const user = await this.prisma.unscoped.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        passwordHash: true,
      },
    });

    if (!user?.passwordHash) {
      await this.passwords.verifyDummy(input.password);
      this.logger.warn(
        { event: 'auth.login_failed', reason: 'unknown_account', ip: context.ipAddress },
        'Login failed',
      );
      throw new UnauthenticatedError(
        ErrorCode.INVALID_CREDENTIALS,
        'That email address and password do not match.',
      );
    }

    const valid = await this.passwords.verify(user.passwordHash, input.password);
    if (!valid) {
      this.logger.warn(
        {
          event: 'auth.login_failed',
          reason: 'bad_password',
          userId: user.id,
          ip: context.ipAddress,
        },
        'Login failed',
      );
      throw new UnauthenticatedError(
        ErrorCode.INVALID_CREDENTIALS,
        'That email address and password do not match.',
      );
    }

    // Transparent upgrade: if policy has strengthened since this hash was
    // written, replace it now while the plaintext is in hand. Users migrate to
    // stronger parameters without a forced reset.
    if (this.passwords.needsRehash(user.passwordHash)) {
      const rehashed = await this.passwords.hash(input.password);
      await this.prisma.unscoped.user
        .update({ where: { id: user.id }, data: { passwordHash: rehashed } })
        .catch((error: unknown) => {
          // A failed upgrade must not fail an otherwise valid login.
          this.logger.warn({ event: 'auth.rehash_failed', err: error }, 'Password rehash failed');
        });
    }

    await this.prisma.unscoped.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const session = await this.sessions.create(user.id, context);
    this.logger.info({ event: 'auth.login', userId: user.id }, 'Login succeeded');

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
      ...session,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
  }

  /**
   * Updates the caller's own profile.
   *
   * Scoped to the authenticated user by construction — the id comes from the
   * resolved session, never from the request body, so there is no shape of
   * payload that edits somebody else's account. Email is not editable here:
   * changing it is an identity change that needs verification of the new
   * address, which is a flow of its own rather than a field on this form.
   */
  async updateProfile(userId: string, input: UpdateProfileInput): Promise<SessionUser> {
    const user = await this.prisma.unscoped.user.update({
      where: { id: userId },
      data: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl ?? null } : {}),
      },
      select: { id: true, email: true, displayName: true, avatarUrl: true },
    });

    // Sessions cache the user record; without this the old name is served for
    // up to a minute from any request that hits the cache.
    await this.sessions.clearCacheForUser(userId);

    this.logger.info({ event: 'auth.profile_updated', userId }, 'Profile updated');

    return user;
  }

  /**
   * Changes a password and evicts every other session.
   *
   * Revoking the other sessions is the point of the operation from a security
   * standpoint: without it, an attacker holding a stolen session cookie keeps
   * their access after the victim changes their password.
   */
  async changePassword(
    userId: string,
    currentSessionId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ revokedSessions: number }> {
    const user = await this.prisma.unscoped.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user?.passwordHash) {
      throw new UnauthenticatedError(
        ErrorCode.INVALID_CREDENTIALS,
        'This account does not use password sign-in.',
      );
    }

    const valid = await this.passwords.verify(user.passwordHash, input.currentPassword);
    if (!valid) {
      throw new UnauthenticatedError(
        ErrorCode.INVALID_CREDENTIALS,
        'Your current password is not correct.',
      );
    }

    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.prisma.unscoped.user.update({ where: { id: userId }, data: { passwordHash } });

    const revokedSessions = await this.sessions.revokeAllForUser(userId, {
      exceptSessionId: currentSessionId,
    });

    this.logger.info(
      { event: 'auth.password_changed', userId, revokedSessions },
      'Password changed; other sessions revoked',
    );

    return { revokedSessions };
  }
}

/**
 * Recognises a Prisma unique-constraint violation on a given field.
 *
 * Matched structurally rather than by message text, which changes between
 * Prisma releases. Kept local to this module so the Prisma error shape does
 * not leak into services that do not care about it.
 */
function isUniqueViolation(error: unknown, field: string): boolean {
  if (error instanceof AppError) return false;
  const candidate = error as { code?: string; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === 'string') return target.includes(field);
  // P2002 with an unknown target still means "unique violation"; treat it as a
  // match rather than falling through to a 500.
  return true;
}
