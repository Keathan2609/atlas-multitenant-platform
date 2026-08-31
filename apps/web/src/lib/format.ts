/**
 * Date and number formatting.
 *
 * Relative time is what makes a list scannable — "2 days ago" is compared at a
 * glance where an ISO timestamp has to be read and subtracted. But relative
 * time is imprecise, so every place that renders it also exposes the absolute
 * value through `title` and a `<time dateTime>` attribute. Scannable by
 * default, exact on demand.
 *
 * Formatting uses the browser's locale rather than a hard-coded one: an
 * operations tool is read by people in several countries and 03/04 means two
 * different days depending on where you are.
 */

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return '—';

  const date = typeof value === 'string' ? new Date(value) : value;
  const elapsed = date.getTime() - Date.now();
  const magnitude = Math.abs(elapsed);

  if (magnitude < 45_000) return 'just now';

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (magnitude >= ms) {
      return formatter.format(Math.round(elapsed / ms), unit);
    }
  }
  return 'just now';
}

export function absoluteTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Date only, for due dates — a due date has no meaningful time of day. */
export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * True when a due date has passed and the item is not finished.
 *
 * Compared at day granularity: something due today is not overdue until
 * tomorrow, which is how people actually read a deadline.
 */
export function isOverdue(dueDate: string | null, status: string): boolean {
  if (!dueDate) return false;
  if (status === 'DONE' || status === 'CANCELLED') return false;

  const due = new Date(dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}
