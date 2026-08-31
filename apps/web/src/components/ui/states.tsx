'use client';

import * as React from 'react';
import { ApiError, NetworkError } from '@/lib/api';
import { Button, cx } from './primitives';

/**
 * Page states.
 *
 * Every screen in ATLAS can be empty, loading, forbidden, missing or broken.
 * Writing those five states once means they are consistent and actually
 * present, rather than the three that got remembered on each screen.
 *
 * The copy follows one rule: say what happened and what to do about it. No
 * apologies, no personality, no "Oops!". An error in an operations tool is
 * read by someone trying to get work done.
 */

/* ── Empty ─────────────────────────────────────────────────────────────── */

/**
 * Deliberately plain: a line of text, an explanation, and the action if the
 * viewer is permitted to take it. No illustration — a drawing of an empty box
 * tells an engineer nothing they did not already know from the empty table.
 */
export function EmptyState({
  title,
  description,
  action,
  size = 'default',
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /**
   * `compact` for a section inside an otherwise populated page. A tall empty
   * box there pushes everything below it off the screen to say nothing, which
   * is the most common way an interface ends up feeling airy and useless.
   */
  size?: 'default' | 'compact';
}) {
  const compact = size === 'compact';
  return (
    <div
      className={cx(
        'mx-auto flex max-w-sm flex-col items-center text-center',
        compact ? 'gap-1 py-1' : 'gap-1.5 py-4',
      )}
    >
      <p className={cx('font-medium text-fg', compact ? 'text-sm' : 'text-base')}>{title}</p>
      {description && (
        <p className={cx('leading-relaxed text-fg-secondary', compact ? 'text-xs' : 'text-sm')}>
          {description}
        </p>
      )}
      {action && <div className={compact ? 'mt-1.5' : 'mt-2'}>{action}</div>}
    </div>
  );
}

/**
 * Empty because a filter excluded everything, which is a different problem
 * from having no data — the fix is to clear the filter, not to create
 * something.
 */
export function NoResultsState({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      title="No matches"
      description="No records match the current filters."
      action={
        <Button size="sm" variant="secondary" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  );
}

/* ── Error ─────────────────────────────────────────────────────────────── */

/**
 * Turns any thrown value into something worth reading.
 *
 * A 403 and a dropped connection are different problems with different fixes,
 * and a user who sees the same grey box for both learns to ignore it. The
 * request id is surfaced on unexpected failures because it is the one thing
 * that makes a support conversation productive.
 */
export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const { title, description, retryable, requestId } = describeError(error);

  return (
    <div
      role="alert"
      className={cx(
        'rounded-lg border border-danger-border bg-danger-subtle px-4 py-3',
        className,
      )}
    >
      <p className="text-base font-medium text-fg">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-fg-secondary">
        {description}
      </p>

      {requestId && (
        <p className="mt-2 text-xs text-fg-tertiary">
          Reference <span className="reference">{requestId}</span>
        </p>
      )}

      {retryable && onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry} className="mt-3">
          Try again
        </Button>
      )}
    </div>
  );
}

export function describeError(error: unknown): {
  title: string;
  description: string;
  retryable: boolean;
  requestId?: string;
} {
  if (error instanceof NetworkError) {
    return {
      title: 'Could not reach the server',
      description: 'Check your connection. Nothing was changed.',
      retryable: true,
    };
  }

  if (error instanceof ApiError) {
    if (error.isForbidden) {
      return {
        title: 'You do not have access to this',
        description:
          'Your role in this organization does not permit it. An owner or admin can change your role.',
        retryable: false,
      };
    }
    if (error.isNotFound) {
      return {
        title: 'Not found',
        description: 'This may have been deleted, or it belongs to a different organization.',
        retryable: false,
      };
    }
    if (error.status === 429) {
      return {
        title: 'Too many requests',
        description: 'Wait a moment and try again.',
        retryable: true,
      };
    }
    if (error.status >= 500) {
      return {
        title: 'Something went wrong on our side',
        description: 'The request did not complete. Quote the reference below if you contact support.',
        retryable: true,
        requestId: error.requestId,
      };
    }
    return { title: 'Request rejected', description: error.message, retryable: false };
  }

  return {
    title: 'Something went wrong',
    description: 'The request did not complete.',
    retryable: true,
  };
}

/* ── Forbidden ─────────────────────────────────────────────────────────── */

/**
 * Shown when a nav destination exists but this role cannot open it.
 *
 * The UI hides links a role cannot use, so reaching this usually means a
 * bookmark or a role that changed. It explains rather than stonewalling —
 * and it is presentation only. The server refused the request first; this
 * screen is what the refusal looks like.
 */
export function ForbiddenState({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-8">
      <EmptyState
        title={`You do not have access to ${what}`}
        description="Your role in this organization does not include this area. An owner or admin can change your role."
      />
    </div>
  );
}

/* ── Loading ───────────────────────────────────────────────────────────── */

/** Skeleton block for non-table content. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx('animate-pulse rounded-sm bg-surface-active', className)}
    />
  );
}

/**
 * Full-page loading, used only where nothing meaningful can render yet — the
 * shell before the session resolves. Inside the shell, screens use skeletons
 * that preserve layout instead, so the page does not jump when data lands.
 */
export function PageLoading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <p role="status" className="text-sm text-fg-tertiary">
        {label}
      </p>
    </div>
  );
}
