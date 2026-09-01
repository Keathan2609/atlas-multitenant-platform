import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from '@atlas/observability';
import { AppError, ErrorCode, RateLimitedError, type ErrorDetail } from './app-error.js';
import { translatePrismaError } from './prisma-error.js';
import { LOGGER_TOKEN } from '../logging/logger.provider.js';

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: ErrorDetail[];
  };
}

/**
 * The single place an error becomes an HTTP response.
 *
 * Two rules govern everything here:
 *
 *  1. A deliberate failure (AppError) is reported faithfully — its code,
 *     message and validation details reach the client, because the client is
 *     expected to act on them.
 *
 *  2. Anything else is a bug, and the client is told nothing beyond
 *     INTERNAL_ERROR and the request id. The real error, with stack, goes to
 *     the log. This is what stops a Prisma constraint message, a file path, or
 *     a SQL fragment reaching a caller.
 *
 * The requestId appears in both the response and every log line for that
 * request, so a user can quote it in a support ticket and an engineer can find
 * the exact trace.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER_TOKEN) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = (request as Request & { requestId?: string }).requestId ?? 'unknown';

    const { status, body, logLevel, logPayload } = this.translate(exception, requestId);

    if (exception instanceof RateLimitedError) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    // 5xx is our fault and gets a stack; 4xx is the caller's and is logged at
    // warn without one, so genuine faults stay visible in a noisy log.
    this.logger[logLevel](
      {
        requestId,
        method: request.method,
        path: request.originalUrl,
        status,
        ...logPayload,
      },
      body.error.message,
    );

    response.status(status).json(body);
  }

  private translate(
    exception: unknown,
    requestId: string,
  ): {
    status: number;
    body: ErrorResponseBody;
    logLevel: 'warn' | 'error';
    logPayload: Record<string, unknown>;
  } {
    // Prisma errors that represent a malformed request rather than a fault
    // are translated first, so they take the AppError path below and are
    // reported faithfully instead of becoming an opaque 500.
    const translated = translatePrismaError(exception);
    const candidate = translated ?? exception;

    if (candidate instanceof AppError) {
      const appError = candidate;
      return {
        status: appError.status,
        body: {
          error: {
            code: appError.code,
            message: appError.message,
            requestId,
            ...(appError.details ? { details: appError.details } : {}),
          },
        },
        logLevel: Number(appError.status) >= 500 ? 'error' : 'warn',
        logPayload: {
          code: appError.code,
          ...(appError.logContext ?? {}),
          // A translated Prisma error keeps the original attached at warn
          // level, so genuine column-data corruption is still diagnosable
          // even though the client sees a 404.
          ...(translated ? { translatedFrom: 'prisma', err: exception } : {}),
          ...(Number(appError.status) >= 500 ? { err: exception } : {}),
        },
      };
    }

    // Nest's own exceptions — thrown by guards, pipes and the router before
    // our code runs. Mapped onto the taxonomy so a 404 from an unmatched route
    // has the same envelope as a 404 from a service.
    if (exception instanceof HttpException) {
      // getStatus() is typed `number`; every value it returns here is an
      // HttpStatus, and the switches below are written against that enum.
      const status: HttpStatus = exception.getStatus();
      return {
        status,
        body: {
          error: {
            code: this.codeForStatus(status),
            message: this.messageForStatus(status),
            requestId,
          },
        },
        logLevel: Number(status) >= 500 ? 'error' : 'warn',
        logPayload: { nestException: exception.name },
      };
    }

    // Unknown: a genuine bug. The client learns nothing; the log gets
    // everything. Never echo `exception.message` here — that is exactly how
    // ORM and driver internals leak into a public response.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred. Quote the request id if you contact support.',
          requestId,
        },
      },
      logLevel: 'error',
      logPayload: { err: exception },
    };
  }

  private codeForStatus(status: HttpStatus): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.MALFORMED_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }

  private messageForStatus(status: HttpStatus): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'The request could not be understood.';
      case HttpStatus.UNAUTHORIZED:
        return 'Authentication is required.';
      case HttpStatus.FORBIDDEN:
        return 'You do not have permission to perform this action.';
      case HttpStatus.NOT_FOUND:
        return 'The requested resource could not be found.';
      case HttpStatus.CONFLICT:
        return 'The request conflicts with the current state.';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'Too many requests. Try again shortly.';
      default:
        return 'An unexpected error occurred.';
    }
  }
}
