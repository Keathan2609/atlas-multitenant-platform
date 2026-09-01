import { uuidv7 } from 'uuidv7';

/**
 * ATLAS identifier strategy: UUIDv7 generated in application code.
 *
 * UUIDv7 embeds a millisecond timestamp in its high bits, so values sort
 * chronologically. Two consequences the schema depends on:
 *
 *  1. Insert locality. New rows land at the right edge of the primary-key
 *     B-tree instead of scattering random pages the way UUIDv4 does, which
 *     keeps write amplification and index bloat low on the high-churn tables
 *     (audit_logs, work_items).
 *
 *  2. Free chronological cursors. `ORDER BY id DESC` is `ORDER BY created_at
 *     DESC` without a second column, so audit-log cursor pagination is a
 *     single-column index scan with no tiebreaker. See docs/api.md.
 *
 * Generated client-side rather than by a database default so a service can
 * build a full object graph — organization, membership, workspace, audit
 * event — and know every id before opening the transaction.
 *
 * See docs/decisions/0004-uuidv7-identifiers.md.
 */
export function newId(): string {
  return uuidv7();
}

/** Structural check only — does not verify the value exists. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
