import { AppError, ErrorCode, NotFoundError } from './app-error.js';

/**
 * Translates the Prisma errors that represent *client* mistakes into the
 * ATLAS error taxonomy.
 *
 * Everything Prisma throws is otherwise an unknown exception, which the filter
 * correctly reports as a bare 500. That is right for a genuine fault and wrong
 * for the cases below, where the caller sent something malformed and a 500
 * both misrepresents the failure and fills the error log with stack traces
 * that any client can trigger at will.
 *
 * Done centrally rather than with a ParseUUIDPipe on each id parameter. There
 * are already fifteen such parameters and every new endpoint adds more; a rule
 * that must be remembered fifteen times is a rule that will eventually be
 * forgotten. This is the same reasoning behind scoping tenants with a client
 * extension instead of a repository layer developers have to opt into.
 */

/** Prisma's code for a value that cannot be coerced to the column's type. */
const INCONSISTENT_COLUMN_DATA = 'P2023';

interface PrismaKnownError {
  code?: unknown;
  message?: unknown;
  name?: unknown;
}

/**
 * A malformed identifier maps to 404, not 400.
 *
 * A value that is not a UUID cannot name any resource, so "not found" is
 * literally true. It also keeps malformed and merely-absent identifiers
 * indistinguishable from outside: before this, `/work-items/not-a-uuid`
 * returned 500 while `/work-items/<unused-uuid>` returned 404, which told a
 * caller which of the two had happened.
 *
 * The match is deliberately narrow. P2023 also covers genuine column-data
 * corruption, which is a real fault that must keep surfacing as a 500 — so the
 * message is checked for the UUID-parsing case specifically rather than
 * treating the whole code as a client error.
 */
export function translatePrismaError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return undefined;

  const candidate = error as PrismaKnownError;
  if (candidate.name !== 'PrismaClientKnownRequestError') return undefined;
  if (candidate.code !== INCONSISTENT_COLUMN_DATA) return undefined;

  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (!message.includes('Error creating UUID')) return undefined;

  return new NotFoundError(ErrorCode.NOT_FOUND, 'The requested resource could not be found.');
}
