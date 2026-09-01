import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Logger } from '@atlas/observability';
import { LOGGER_TOKEN } from '../../common/logging/logger.provider.js';
import { ErrorCode, UnauthenticatedError } from '../../common/errors/app-error.js';
import { ApiKeysService } from './api-keys.service.js';

/**
 * Authenticates a bearer API key, if one is presented.
 *
 * Registered globally and *before* AuthGuard, because AuthGuard's first act is
 * to check `request.apiKeyContext` and skip cookie handling when it is set.
 * The ordering is load-bearing: reversed, an API-key request would be treated
 * as anonymous and rejected before this guard ever ran.
 *
 * Absence of an Authorization header is not an error here. The guard simply
 * declines to populate a context and lets AuthGuard handle the cookie path —
 * that is what keeps one API serving both browsers and machines without two
 * parallel authentication systems.
 *
 * A *present but invalid* key, by contrast, fails immediately. Falling through
 * to cookie auth would let a caller probe keys while quietly authenticating as
 * someone else, and would make a broken integration look like a permissions
 * problem rather than a bad credential.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeysService,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header('authorization');

    if (!header) return true;

    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match?.[1]) {
      // An Authorization header we cannot parse is a deliberate attempt to
      // authenticate that we could not honour, not an anonymous request.
      throw new UnauthenticatedError(
        ErrorCode.INVALID_API_KEY,
        'The Authorization header must be "Bearer <api key>".',
      );
    }

    const verified = await this.apiKeys.verify(match[1]);

    if (!verified) {
      // One message for unknown, revoked and expired alike. Distinguishing
      // them would confirm to an attacker that a key was once real.
      this.logger.warn(
        { event: 'security.api_key_rejected', ip: request.ip, path: request.originalUrl },
        'API key rejected',
      );
      throw new UnauthenticatedError(ErrorCode.INVALID_API_KEY, 'That API key is not valid.');
    }

    request.apiKeyContext = verified;
    return true;
  }
}
