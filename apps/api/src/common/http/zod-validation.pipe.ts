import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import type { SafeParseReturnType, ZodIssue, ZodSchema } from 'zod';
import { ValidationError, type ErrorDetail } from '../errors/app-error.js';

/**
 * Validates and transforms a request payload against a Zod schema.
 *
 * Used instead of class-validator so the API and the web forms share exactly
 * one schema per rule (see @atlas/validation). A DTO class duplicated with
 * decorators would be a second definition free to drift from the first.
 *
 * The pipe returns the *parsed* value, not the original. That matters: the
 * schemas normalise as they validate (email lowercased, slug trimmed), and
 * services must receive the normalised form or the database sees a value the
 * uniqueness checks never examined.
 *
 * ── Why safeParse and not try/catch on ZodError ──────────────────────────────
 * The obvious implementation is `schema.parse()` wrapped in a try/catch that
 * tests `error instanceof ZodError`. That is subtly broken here, and it was
 * broken in this file before an integration test caught it.
 *
 * The schemas live in @atlas/validation and are built against *that* package's
 * copy of zod. This pipe imports zod from apps/api. When the two resolve to
 * separate instances — which pnpm's isolated node_modules makes easy, and any
 * transitive dependency pinning a different zod version makes likely — the
 * thrown error is a ZodError whose prototype chain belongs to the other copy.
 * `instanceof` returns false, the catch re-throws, and a routine 422 becomes a
 * 500 that tells the caller nothing about which field was wrong.
 *
 * `safeParse` returns a discriminated result instead of throwing, so
 * correctness no longer depends on two packages agreeing about class identity.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    const result: SafeParseReturnType<unknown, T> = this.schema.safeParse(value);

    if (!result.success) {
      throw new ValidationError(toDetails(result.error.issues));
    }

    return result.data;
  }
}

/**
 * Flattens Zod issues into the API's error detail format.
 *
 * Paths are dotted (`members.0.email`) so a client can map an error straight
 * onto the field that produced it. Zod's own message text is used verbatim,
 * which is why the schemas are written with user-facing wording rather than
 * developer shorthand.
 */
function toDetails(issues: readonly ZodIssue[]): ErrorDetail[] {
  return issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

/** Convenience factory so controllers read `@Body(zodBody(schema))`. */
export function zodBody<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/** Same pipe, used for query strings. */
export function zodQuery<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
