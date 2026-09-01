import { HttpStatus } from '@nestjs/common';

/**
 * The ATLAS error taxonomy.
 *
 * Every failure the API returns is one of these codes. Clients switch on
 * `error.code`, never on the message — messages are for humans and may be
 * reworded at any time, codes are part of the API contract.
 *
 * The wire format is:
 *
 *   {
 *     "error": {
 *       "code": "PROJECT_NOT_FOUND",
 *       "message": "The requested project could not be found.",
 *       "requestId": "01a0569d-...",
 *       "details": [ ... ]        // validation errors only
 *     }
 *   }
 */
export const ErrorCode = {
  // 400 / 422
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',

  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  INVALID_API_KEY: 'INVALID_API_KEY',
  API_KEY_REVOKED: 'API_KEY_REVOKED',
  API_KEY_EXPIRED: 'API_KEY_EXPIRED',

  // 403
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  NOT_ORGANIZATION_MEMBER: 'NOT_ORGANIZATION_MEMBER',
  CANNOT_MODIFY_SELF: 'CANNOT_MODIFY_SELF',
  TARGET_OUTRANKS_ACTOR: 'TARGET_OUTRANKS_ACTOR',
  CANNOT_GRANT_ABOVE_OWN_ROLE: 'CANNOT_GRANT_ABOVE_OWN_ROLE',
  LAST_OWNER: 'LAST_OWNER',

  // 404
  NOT_FOUND: 'NOT_FOUND',
  ORGANIZATION_NOT_FOUND: 'ORGANIZATION_NOT_FOUND',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  WORK_ITEM_NOT_FOUND: 'WORK_ITEM_NOT_FOUND',
  TEAM_NOT_FOUND: 'TEAM_NOT_FOUND',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  API_KEY_NOT_FOUND: 'API_KEY_NOT_FOUND',

  // 409
  CONFLICT: 'CONFLICT',
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  SLUG_TAKEN: 'SLUG_TAKEN',
  PROJECT_KEY_TAKEN: 'PROJECT_KEY_TAKEN',
  ALREADY_A_MEMBER: 'ALREADY_A_MEMBER',
  INVITATION_ALREADY_SENT: 'INVITATION_ALREADY_SENT',
  INVITATION_ALREADY_ACCEPTED: 'INVITATION_ALREADY_ACCEPTED',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  INVITATION_REVOKED: 'INVITATION_REVOKED',
  TEAM_HAS_PROJECTS: 'TEAM_HAS_PROJECTS',
  WORKSPACE_NOT_EMPTY: 'WORKSPACE_NOT_EMPTY',
  CANNOT_DELETE_DEFAULT_WORKSPACE: 'CANNOT_DELETE_DEFAULT_WORKSPACE',
  CONFIRMATION_MISMATCH: 'CONFIRMATION_MISMATCH',

  // 429
  RATE_LIMITED: 'RATE_LIMITED',

  // 500
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorDetail {
  /** Dotted path into the request body, e.g. "members.0.email". */
  field: string;
  message: string;
}

/**
 * Base class for every deliberate failure.
 *
 * Anything thrown that is *not* an AppError is treated as a bug by the
 * exception filter: it is logged with a stack and reported to the client as a
 * bare INTERNAL_ERROR with no detail. That asymmetry is deliberate — it means
 * an unexpected exception can never leak an ORM message, a file path, or a
 * SQL fragment to a caller.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: HttpStatus;
  readonly details?: ErrorDetail[];
  /** Extra context for the log line only. Never serialised to the client. */
  readonly logContext?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    status: HttpStatus,
    message: string,
    options: { details?: ErrorDetail[]; logContext?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.logContext = options.logContext;
    Error.captureStackTrace?.(this, AppError);
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[], message = 'The request contains invalid values.') {
    super(ErrorCode.VALIDATION_FAILED, HttpStatus.UNPROCESSABLE_ENTITY, message, { details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(
    code: ErrorCode = ErrorCode.UNAUTHENTICATED,
    message = 'Authentication is required.',
  ) {
    super(code, HttpStatus.UNAUTHORIZED, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    code: ErrorCode = ErrorCode.FORBIDDEN,
    message = 'You do not have permission to perform this action.',
    logContext?: Record<string, unknown>,
  ) {
    super(code, HttpStatus.FORBIDDEN, message, { logContext });
  }
}

/**
 * Resource-not-found.
 *
 * Note the deliberate conflation with "exists but belongs to another tenant".
 * Returning 404 rather than 403 for a resource in a different organization
 * means an attacker cannot use the status code to enumerate which project ids
 * exist across the platform. See docs/security.md § IDOR.
 */
export class NotFoundError extends AppError {
  constructor(
    code: ErrorCode = ErrorCode.NOT_FOUND,
    message = 'The requested resource could not be found.',
  ) {
    super(code, HttpStatus.NOT_FOUND, message);
  }
}

export class ConflictError extends AppError {
  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(code, HttpStatus.CONFLICT, message, { details });
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = 'Too many requests. Try again shortly.') {
    super(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
