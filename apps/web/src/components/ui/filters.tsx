'use client';

import * as React from 'react';
import { Select, cx, humanise } from './primitives';

/**
 * The filter bar.
 *
 * Sits inside a table's panel header, above the column headers. Controls are
 * 28px — one step smaller than form controls — because a filter is a
 * modifier on the content below it, not a form the page is about.
 *
 * Native `<select>` rather than a custom listbox. It is keyboard accessible
 * everywhere, uses the platform picker on mobile where that is genuinely
 * better than anything a web app can draw, and needs no JavaScript to be
 * usable. A styled dropdown would look more "designed" and work worse.
 */

export function FilterBar({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name; the input carries no visible label in the filter bar. */
  label: string;
}) {
  const id = React.useId();

  return (
    <div className="relative min-w-0 flex-1 sm:max-w-[240px]">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-tertiary"
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        data-focus-styled
        className="h-7 w-full rounded-md border border-border-strong
                   bg-surface pl-7 pr-2 text-sm
                   placeholder:text-fg-tertiary
                   focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
      />
    </div>
  );
}

export function SelectFilter({
  label,
  value,
  onChange,
  options,
  /** Overrides the default humanised labels, for values like team ids. */
  optionLabels,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  optionLabels?: Record<string, string>;
}) {
  const id = React.useId();
  const active = Boolean(value);

  return (
    <div className="flex items-center">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cx(
          'h-7 w-auto min-w-[104px] text-sm',
          // An applied filter is marked, so a user returning to a link can see
          // at a glance that the list is narrowed.
          active && 'border-accent-border bg-accent-subtle text-fg',
        )}
      >
        <option value="">{label}: any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabels?.[option] ?? humanise(option)}
          </option>
        ))}
      </Select>
    </div>
  );
}
