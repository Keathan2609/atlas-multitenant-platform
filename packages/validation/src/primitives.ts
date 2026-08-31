import { z } from 'zod';

/**
 * Shared validation primitives.
 *
 * These schemas are imported by both the NestJS DTO layer and the React
 * forms, so a rule is written once and cannot drift between client and
 * server. The client copy exists purely to give fast feedback — the server
 * revalidates everything, because a client can send whatever it likes.
 */

/**
 * Email normalisation.
 *
 * Lowercased and trimmed *before* validation, not after, so the value that
 * reaches the uniqueness check is the value that gets stored. Doing this in
 * the schema rather than in each service is what makes
 * "Alice@Example.com " and "alice@example.com" the same account everywhere,
 * including at the database unique index.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Enter an email address.')
  .max(320, 'Email address is too long.')
  .email('Enter a valid email address.');

/**
 * Password policy.
 *
 * Length is the only hard requirement, deliberately. Composition rules
 * ("one uppercase, one symbol") measurably push people toward predictable
 * patterns like Passw0rd! while blocking strong passphrases, so NIST
 * SP 800-63B advises against them. The 72-byte ceiling is a real constraint
 * of bcrypt-family hashing; Argon2id has no such limit, but capping here
 * keeps the policy stable if the hash is ever changed.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(72, 'Use at most 72 characters.');

/**
 * Slug: the URL segment for organizations, teams and workspaces.
 *
 * Constrained to lowercase alphanumerics and single interior hyphens. This is
 * a security boundary as much as a formatting rule — slugs are interpolated
 * into paths like /app/{slug}/projects, so permitting '.', '/' or '%' would
 * open path traversal and confusable-URL attacks.
 *
 * Note on the line-break guard below: in JavaScript `$` matches before a
 * trailing newline, so this pattern alone would accept "acme\n". In practice
 * `.trim()` runs first and strips it, which makes the guard redundant on the
 * current chain. It is kept as defence-in-depth — it is one cheap predicate,
 * and it is what stops a future refactor that drops or reorders the trim from
 * silently putting a newline into a URL.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slugs that would collide with application routes or be actively misleading.
 * Checked case-insensitively after normalisation.
 */
export const RESERVED_SLUGS = new Set([
  'api', 'app', 'admin', 'administrator', 'auth', 'login', 'logout', 'signup',
  'register', 'settings', 'billing', 'support', 'help', 'docs', 'status',
  'health', 'new', 'create', 'edit', 'delete', 'internal', 'system', 'root',
  'static', 'assets', 'public', 'null', 'undefined', 'atlas', 'www',
]);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Use at least 2 characters.')
  .max(64, 'Use at most 64 characters.')
  .regex(SLUG_PATTERN, 'Use lowercase letters, numbers, and single hyphens.')
  // `$` in JavaScript matches before a trailing newline, so "acme\n" would
  // otherwise satisfy the pattern above and be interpolated into a URL.
  .refine((value) => !/[\r\n]/.test(value), 'Line breaks are not allowed.')
  .refine((value) => !RESERVED_SLUGS.has(value), 'That name is reserved.');

/**
 * Project key: the short prefix in work-item references (PORTAL-42).
 * Uppercase so references are visually distinct from slugs.
 */
export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'Use at least 2 characters.')
  .max(10, 'Use at most 10 characters.')
  .regex(/^[A-Z][A-Z0-9]*$/, 'Start with a letter; use uppercase letters and numbers.');

export const uuidSchema = z.string().uuid('Not a valid identifier.');

/** Display names: people, organizations, teams, workspaces, projects. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'This field is required.')
  .max(120, 'Use at most 120 characters.')
  // Control characters render as invisible glyphs and are a common vector for
  // spoofing names in member lists and audit entries.
  .refine((v) => !/[\u0000-\u001F\u007F]/.test(v), 'Control characters are not allowed.');

export const descriptionSchema = z
  .string()
  .trim()
  .max(500, 'Use at most 500 characters.')
  .optional()
  .or(z.literal('').transform(() => undefined));

/**
 * Derives a candidate slug from a display name.
 *
 * Collisions are resolved by the service, not here — this only produces the
 * first suggestion. Unicode is stripped to ASCII via NFKD so "Café Meridian"
 * becomes "cafe-meridian" rather than percent-encoded noise.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

/** Cursor pagination input, shared by every list endpoint. */
export const cursorPaginationSchema = z.object({
  /** Opaque; currently the id of the last row seen. */
  cursor: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const offsetPaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const sortDirectionSchema = z.enum(['asc', 'desc']).default('desc');

export type CursorPagination = z.infer<typeof cursorPaginationSchema>;
export type OffsetPagination = z.infer<typeof offsetPaginationSchema>;
