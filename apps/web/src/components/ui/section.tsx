import * as React from 'react';
import { cx } from './primitives';

/**
 * A titled settings section.
 *
 * Settings screens are the one place in this product where a page is a stack
 * of unrelated decisions rather than a table. Each decision gets a heading, a
 * sentence of consequence, and its own commit point — so someone changing a
 * session timeout is never wondering whether they also just changed the
 * organization's name.
 */
export function Section({
  title,
  description,
  footer,
  children,
  className,
}: {
  title: string;
  description?: string;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-md border border-border bg-surface', className)}>
      <div className="px-4 py-3.5">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {description && (
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-fg-tertiary">{description}</p>
        )}
        {children && <div className="mt-3.5">{children}</div>}
      </div>

      {footer && (
        <div
          className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2
                     border-t border-border bg-surface-sunken px-4 py-2.5"
        >
          {footer}
        </div>
      )}
    </section>
  );
}

/** A definition row — label left, value right, for read-only facts. */
export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-1.5 last:border-b-0">
      <dt className="shrink-0 text-xs text-fg-tertiary">{label}</dt>
      {/* break-words, because the longest value on these rows is an email
          address, and an unbroken one would otherwise push the row past the
          panel on a narrow screen. */}
      <dd className="min-w-0 break-words text-right text-sm text-fg">{children}</dd>
    </div>
  );
}

/**
 * A labelled switch.
 *
 * A real checkbox input underneath, so it is reachable by keyboard, announced
 * as a checkbox, and toggled with space — the styling is on the label, not a
 * div pretending to be a control.
 */
export function Toggle({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 cursor-pointer rounded-sm border-border-strong
                   text-accent accent-accent focus-visible:outline focus-visible:outline-2
                   focus-visible:outline-offset-2 focus-visible:outline-accent
                   disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="min-w-0">
        <label
          htmlFor={id}
          className={cx(
            'block text-sm text-fg',
            disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
          )}
        >
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="mt-0.5 text-xs leading-relaxed text-fg-tertiary">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
