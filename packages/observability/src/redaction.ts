/**
 * Log redaction.
 *
 * Kept separate from the logger itself, and unit tested, because "we redact
 * secrets" is the kind of claim that is easy to assert in a README and hard to
 * keep true as fields are added. The tests here are the actual guarantee.
 */

/**
 * Field names whose values must never reach a log sink.
 *
 * Matched case-insensitively against the *leaf* key name, so
 * `user.passwordHash` and `body.password` are both caught without needing a
 * path for every call site.
 */
export const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'tokenhash',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'apikey',
  'keyhash',
  'secret',
  'sessionsecret',
  'authorization',
  'cookie',
  'setcookie',
  'creditcard',
  'cardnumber',
  'cvv',
  'ssn',
];

export const REDACTED = '[redacted]';

/** Maximum depth walked before bailing out. Guards against cyclic structures. */
const MAX_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEYS.includes(normalised);
}

/**
 * The `atlas_live_...` API key format is recognisable, so a raw key can be
 * caught even when it appears in a value rather than under a known field name
 * — for example inside an error message that echoed a request header.
 */
const API_KEY_IN_TEXT = /atlas_(live|test)_[A-Za-z0-9_-]{8,}/g;

/** Bearer tokens and basic-auth credentials pasted into free text. */
const BEARER_IN_TEXT = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi;

export function scrubString(value: string): string {
  return value.replace(API_KEY_IN_TEXT, REDACTED).replace(BEARER_IN_TEXT, `$1 ${REDACTED}`);
}

/**
 * Returns a deep copy with sensitive values replaced.
 *
 * Copies rather than mutating: the object being logged is usually still in use
 * by the request that produced it, and redacting in place would blank a value
 * the application still needs.
 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';

  if (typeof input === 'string') return scrubString(input);
  if (input === null || typeof input !== 'object') return input;

  if (input instanceof Error) {
    return {
      name: input.name,
      message: scrubString(input.message),
      stack: input.stack ? scrubString(input.stack) : undefined,
    };
  }

  if (Array.isArray(input)) {
    return input.map((item) => redact(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redact(value, depth + 1);
  }
  return output;
}
