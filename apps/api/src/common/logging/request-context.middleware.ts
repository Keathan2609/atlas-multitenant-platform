import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newId } from '@atlas/database';

/**
 * Assigns a request id and logs one line per completed request.
 *
 * The id is echoed in the `x-request-id` response header and in every error
 * body, so a user can quote it and an engineer can retrieve the whole trace.
 *
 * An inbound `x-request-id` is accepted but sanitised, not trusted verbatim.
 * The header is attacker-controlled and ends up in log lines; without the
 * character and length limits below, a caller could inject newlines and forge
 * fake entries in a plaintext log, or blow up log storage with a megabyte
 * header. Anything that fails the check is replaced with a fresh id rather
 * than rejected — a malformed correlation header is not worth failing a
 * request over.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header('x-request-id');
    req.requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : newId();
    req.startedAt = process.hrtime.bigint();

    res.setHeader('x-request-id', req.requestId);
    next();
  }
}
