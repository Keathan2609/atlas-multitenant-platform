'use client';

import * as React from 'react';

/** Minimal class joiner. A dependency for this would be silly. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ══════════════════════════════════════════════════════════════════════════
 * Button
 *
 * Four variants, and the constraint that gives the interface its discipline:
 * only `primary` uses the accent. A screen with two accent buttons has no
 * primary action, so `primary` appears at most once per view.
 * ══════════════════════════════════════════════════════════════════════════ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium ' +
  'whitespace-nowrap transition-colors duration-100 ' +
  'disabled:pointer-events-none disabled:opacity-50 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-white hover:bg-accent-hover active:bg-accent-active',
  secondary:
    'bg-surface text-fg border border-border-strong ' +
    'hover:bg-surface-hover active:bg-surface-active',
  ghost:
    'bg-transparent text-fg-secondary hover:bg-surface-hover hover:text-fg',
  danger:
    'bg-danger text-white hover:bg-danger-hover',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and swaps the label for a progress indicator. */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, disabled, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      disabled={disabled || loading}
      // Announces the pending state to assistive technology; the spinner alone
      // is invisible to a screen reader.
      aria-busy={loading || undefined}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...props}
    >
      {loading && <Spinner className="size-3" />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className)} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reference — the application's signature element.
 *
 * How people actually refer to work: IDENT-3, atlas_live_7f3a. Monospaced,
 * fixed width, click to copy. It is the leading column of every table and the
 * identity of every detail page, because that is the string someone pastes
 * into a message when they want to talk about this thing.
 * ══════════════════════════════════════════════════════════════════════════ */

export function Reference({
  value,
  copyable = false,
  className,
}: {
  value: string;
  copyable?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  if (!copyable) {
    return <span className={cx('reference text-fg-secondary', className)}>{value}</span>;
  }

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
      className={cx(
        'reference group inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 -mx-1',
        'text-fg-secondary hover:bg-surface-hover hover:text-fg',
        className,
      )}
      // The visible label is the reference itself; this says what the button does.
      aria-label={copied ? `${value} copied` : `Copy ${value}`}
    >
      {value}
      <span
        aria-hidden="true"
        className="text-2xs text-fg-tertiary opacity-0 transition-opacity group-hover:opacity-100"
      >
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Status and priority
 *
 * Neutral by default, semantic only where the state genuinely warrants
 * attention. Deliberately not accent-coloured: the accent means "you can act
 * on this", and a status is a fact, not an action.
 * ══════════════════════════════════════════════════════════════════════════ */

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'text-success bg-success-subtle border-success-border',
  DONE: 'text-success bg-success-subtle border-success-border',
  COMPLETED: 'text-success bg-success-subtle border-success-border',
  IN_PROGRESS: 'text-accent bg-accent-subtle border-accent-border',
  IN_REVIEW: 'text-warning bg-warning-subtle border-warning-border',
  PAUSED: 'text-warning bg-warning-subtle border-warning-border',
  CANCELLED: 'text-fg-tertiary bg-surface-sunken border-border',
  ARCHIVED: 'text-fg-tertiary bg-surface-sunken border-border',
  REVOKED: 'text-danger bg-danger-subtle border-danger-border',
  EXPIRED: 'text-fg-tertiary bg-surface-sunken border-border',
};

const DEFAULT_TONE =
  'text-fg-secondary bg-surface-sunken border-border';

/** Turns BACKLOG into Backlog, IN_PROGRESS into In progress. */
export function humanise(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-sm border px-1.5 py-px',
        'text-2xs font-medium whitespace-nowrap',
        STATUS_TONE[status] ?? DEFAULT_TONE,
        className,
      )}
    >
      {humanise(status)}
    </span>
  );
}

/**
 * Priority, shown as a word with a coloured marker rather than a filled pill.
 *
 * Four filled pills per row would make a table read as a colour chart. The
 * marker gives the same scan-ability at a fraction of the visual weight, and
 * the word carries the meaning for anyone who cannot distinguish the hues.
 */
const PRIORITY_MARK: Record<string, string> = {
  URGENT: 'bg-danger',
  HIGH: 'bg-warning',
  MEDIUM: 'bg-fg-tertiary',
  LOW: 'bg-border-strong',
};

export function Priority({ priority }: { priority: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-fg-secondary">
      <span
        aria-hidden="true"
        className={cx('size-1.5 rounded-full', PRIORITY_MARK[priority] ?? PRIORITY_MARK.LOW)}
      />
      {humanise(priority)}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Avatar — initials only.
 *
 * No uploaded images in this build, and a generated identicon would be
 * decoration. Initials on a neutral ground identify a person at a glance and
 * cost nothing to render in a dense table.
 * ══════════════════════════════════════════════════════════════════════════ */

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <span
      // Decorative: the name is always rendered next to it in a readable form.
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full',
        'bg-surface-active font-medium text-fg-secondary select-none',
        size === 'sm' ? 'size-5 text-[9px]' : 'size-6 text-2xs',
        className,
      )}
    >
      {initials}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Form controls
 * ══════════════════════════════════════════════════════════════════════════ */

const FIELD_BASE =
  'w-full rounded-md border bg-surface px-2.5 text-base ' +
  'text-fg placeholder:text-fg-tertiary ' +
  'transition-colors duration-100 disabled:opacity-60 disabled:bg-surface-sunken ' +
  'focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      data-focus-styled
      aria-invalid={invalid || undefined}
      className={cx(
        FIELD_BASE,
        'h-8',
        invalid ? 'border-danger' : 'border-border-strong',
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ invalid, className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      data-focus-styled
      aria-invalid={invalid || undefined}
      className={cx(
        FIELD_BASE,
        'min-h-20 py-1.5 leading-relaxed resize-y',
        invalid ? 'border-danger' : 'border-border-strong',
        className,
      )}
      {...props}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ invalid, className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      data-focus-styled
      aria-invalid={invalid || undefined}
      className={cx(
        FIELD_BASE,
        'h-8 pr-7 appearance-none cursor-pointer',
        // Chevron drawn inline rather than an icon dependency for one glyph.
        "bg-[url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' stroke='%23868c95' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")]",
        'bg-[length:12px] bg-[right_0.5rem_center] bg-no-repeat',
        invalid ? 'border-danger' : 'border-border-strong',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});

/**
 * A labelled field with description and error slots.
 *
 * Wires `htmlFor`, `aria-describedby` and `aria-errormessage` from one place,
 * so every form in the application is announced correctly without each author
 * remembering the plumbing.
 */
export function Field({
  label,
  htmlFor,
  description,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  const descriptionId = description ? `${htmlFor}-description` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg">
        {label}
        {required && (
          <span className="ml-0.5 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>

      {description && (
        <p id={descriptionId} className="text-xs text-fg-tertiary">
          {description}
        </p>
      )}

      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: htmlFor,
            'aria-describedby': cx(descriptionId, errorId) || undefined,
          })
        : children}

      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
