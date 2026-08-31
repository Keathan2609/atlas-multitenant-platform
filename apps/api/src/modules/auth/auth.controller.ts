import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from '@atlas/validation';
import { CONFIG_TOKEN, type AppConfig } from '../../config/env.js';
import { zodBody } from '../../common/http/zod-validation.pipe.js';
import { RateLimit, RateLimitGuard } from '../../common/http/rate-limit.guard.js';
import { UnauthenticatedError } from '../../common/errors/app-error.js';
import { AuthService } from './auth.service.js';
import { SessionService } from './session.service.js';
import { CsrfExempt, Public } from './auth.guard.js';
import { clearAuthCookies, setAuthCookies } from './cookies.js';

@ApiTags('Authentication')
@Controller({ path: 'auth', version: '1' })
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
  ) {}

  @Public()
  // Session-establishing: a caller may still hold a stale session cookie from a
  // previous sign-in, and demanding a CSRF token they cannot have would lock
  // them out of creating an account at all.
  @CsrfExempt()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an account and start a session' })
  // Registration is bucketed by IP alone: there is no account to protect yet,
  // and the abuse being prevented is bulk account creation from one source.
  @RateLimit({ max: 5, windowSeconds: 3600, by: 'ip' })
  async register(
    @Body(zodBody(registerSchema)) input: RegisterInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.register(input, requestContext(request));
    const csrfToken = setAuthCookies(
      response,
      this.config,
      result.token,
      this.config.SESSION_TTL_SECONDS,
    );
    return { user: result.user, csrfToken, expiresAt: result.expiresAt };
  }

  @Public()
  // Session-establishing, same reasoning as register. This is what makes
  // "sign in as someone else" work while a session cookie is present.
  @CsrfExempt()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate and start a session' })
  // Bucketed on IP *and* email together — see RateLimitGuard for why neither
  // dimension alone is sufficient.
  @RateLimit({ max: 10, windowSeconds: 300, by: 'ip+email' })
  async login(
    @Body(zodBody(loginSchema)) input: LoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(input, requestContext(request));
    const csrfToken = setAuthCookies(
      response,
      this.config,
      result.token,
      this.config.SESSION_TTL_SECONDS,
    );
    return { user: result.user, csrfToken, expiresAt: result.expiresAt };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End the current session' })
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    if (request.sessionId) {
      await this.auth.logout(request.sessionId);
    }
    // Cookies are cleared even when no session was resolved, so a client
    // holding a stale or malformed cookie is returned to a clean state rather
    // than looping on a session it cannot use.
    clearAuthCookies(response, this.config);
  }

  @Get('me')
  @ApiOperation({ summary: 'The authenticated user' })
  me(@Req() request: Request) {
    if (!request.user) throw new UnauthenticatedError();
    return { user: request.user };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Active sessions for the authenticated user' })
  async listSessions(@Req() request: Request) {
    if (!request.user) throw new UnauthenticatedError();
    const sessions = await this.sessions.listForUser(request.user.id);
    return {
      data: sessions.map((session) => ({
        ...session,
        // Lets the UI mark "this device" without exposing any other session's
        // identifier in a way the client could act on.
        current: session.id === request.sessionId,
      })),
    };
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password and revoke other sessions' })
  @RateLimit({ max: 5, windowSeconds: 900, by: 'user' })
  async changePassword(
    @Body(zodBody(changePasswordSchema)) input: { currentPassword: string; newPassword: string },
    @Req() request: Request,
  ) {
    if (!request.user || !request.sessionId) throw new UnauthenticatedError();
    const { revokedSessions } = await this.auth.changePassword(
      request.user.id,
      request.sessionId,
      input,
    );
    return { revokedSessions };
  }
}

function requestContext(request: Request) {
  return {
    ipAddress: request.ip,
    userAgent: request.header('user-agent'),
  };
}
