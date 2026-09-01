'use client';

import * as React from 'react';
import { Button, Spinner, cx } from './primitives';

/**
 * The table system.
 *
 * This is the most important component in ATLAS — the product is mostly tables,
 * and an operations tool lives or dies on whether you can scan one.
 *
 * Decisions that shape it:
 *
 *  - Real semantic markup. `<table>`, `<thead>`, `<th scope="col">`, sortable
 *    headers as buttons carrying `aria-sort`. A grid of divs would look
 *    identical and be unusable with a screen reader.
 *  - 36px rows, 13px text. Dense enough that twenty rows fit on a laptop
 *    without scrolling, loose enough to read for an hour.
 *  - Rows are rows. Not cards — a card per row triples the height, destroys
 *    column alignment, and makes comparison across rows impossible, which is
 *    the entire reason a table exists.
 *  - The urgency marker is a 2px left edge rather than another cell. Scanning
 *    the left margin gives triage without adding chrome to every row.
 *  - Horizontal overflow scrolls inside the table's own container, so a wide
 *    table never makes the page scroll sideways.
 */

export type SortDirection = 'asc' | 'desc';

export interface Column<T> {
  id: string;
  header: string;
  /** Omitted for action columns and anything not worth sorting on. */
  sortable?: boolean;
  /** Tailwind width class. Fixed widths stop columns jumping as data loads. */
  width?: string;
  align?: 'left' | 'right';
  /** Hidden below this breakpoint; the column still exists in the DOM order. */
  hideBelow?: 'sm' | 'md' | 'lg';
  render: (row: T) => React.ReactNode;
}

const HIDE_BELOW: Record<string, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  /** Renders the row as a link target and gives it hover/active affordance. */
  onRowClick?: (row: T) => void;
  /** Draws the 2px left edge. Used for urgency and overdue, nothing else. */
  rowAccent?: (row: T) => 'danger' | 'warning' | undefined;
  sort?: { id: string; direction: SortDirection };
  onSortChange?: (id: string, direction: SortDirection) => void;
  loading?: boolean;
  /** Shown when there are no rows and loading has finished. */
  empty?: React.ReactNode;
  caption?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowAccent,
  sort,
  onSortChange,
  loading,
  empty,
  caption,
}: DataTableProps<T>) {
  const showSkeleton = loading && rows.length === 0;

  return (
    <div className="overflow-x-auto">
      {/*
        Fixed layout, not auto. Every column here either declares a width or is
        the one flexible column, which is exactly what `table-fixed` expects —
        and it is what makes `truncate-cell` work: under `auto`, a nowrap cell
        sets the column's intrinsic width instead of being clipped, so a long
        description widens the table until it overflows its scroller.
      */}
      <table className="w-full table-fixed border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}

        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => {
              const isSorted = sort?.id === column.id;
              return (
                <th
                  key={column.id}
                  scope="col"
                  // aria-sort belongs on the header cell, not the button.
                  aria-sort={
                    isSorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={cx(
                    'label-caps h-8 bg-surface-sunken px-3 text-left font-medium',
                    'first:pl-4 last:pr-4',
                    column.align === 'right' && 'text-right',
                    column.width,
                    column.hideBelow && HIDE_BELOW[column.hideBelow],
                  )}
                >
                  {column.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() =>
                        onSortChange(
                          column.id,
                          isSorted && sort.direction === 'desc' ? 'asc' : 'desc',
                        )
                      }
                      className={cx(
                        // `uppercase` is repeated from the th because preflight
                        // resets text-transform on buttons, which otherwise
                        // leaves every sortable column sentence-case beside
                        // uppercase neighbours.
                        'inline-flex items-center gap-1 rounded-sm -mx-1 px-1 uppercase',
                        'hover:text-fg transition-colors',
                        isSorted && 'text-fg',
                        column.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {column.header}
                      <SortMark active={isSorted} direction={sort?.direction} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {showSkeleton && <SkeletonRows columns={columns} />}

          {!showSkeleton && rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-12">
                {empty}
              </td>
            </tr>
          )}

          {rows.map((row) => {
            const accent = rowAccent?.(row);
            return (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cx(
                  'border-b border-border-subtle last:border-b-0',
                  onRowClick && 'cursor-pointer hover:bg-surface-hover',
                  // The accent is a box-shadow inset rather than a border, so it
                  // does not shift the cell contents by 2px.
                  accent === 'danger' && 'shadow-[inset_2px_0_0_0_var(--color-danger)]',
                  accent === 'warning' && 'shadow-[inset_2px_0_0_0_var(--color-warning)]',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cx(
                      'h-9 px-3 first:pl-4 last:pr-4 align-middle',
                      column.align === 'right' && 'text-right',
                      column.hideBelow && HIDE_BELOW[column.hideBelow],
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Refetching with rows already on screen: a quiet bar, not a spinner
          that blanks the table the user is reading. */}
      {loading && rows.length > 0 && (
        <div
          role="status"
          className="flex items-center gap-2 border-t border-border px-4 py-1.5 text-xs text-fg-tertiary"
        >
          <Spinner className="size-3" />
          Updating
        </div>
      )}
    </div>
  );
}

function SortMark({ active, direction }: { active: boolean; direction?: SortDirection }) {
  return (
    <svg
      viewBox="0 0 8 10"
      aria-hidden="true"
      className={cx('size-2 shrink-0', active ? 'text-fg' : 'text-fg-tertiary')}
    >
      <path
        d="M4 0 7 4H1z"
        fill="currentColor"
        opacity={active && direction === 'asc' ? 1 : active ? 0.25 : 0.4}
      />
      <path
        d="M4 10 1 6h6z"
        fill="currentColor"
        opacity={active && direction === 'desc' ? 1 : active ? 0.25 : 0.4}
      />
    </svg>
  );
}

function SkeletonRows<T>({ columns }: { columns: Array<Column<T>> }) {
  return (
    <>
      {Array.from({ length: 8 }, (_, rowIndex) => (
        <tr key={rowIndex} className="border-b border-border-subtle">
          {columns.map((column, columnIndex) => (
            <td
              key={column.id}
              className={cx(
                'h-9 px-3 first:pl-4 last:pr-4',
                column.hideBelow && HIDE_BELOW[column.hideBelow],
              )}
            >
              <div
                className="h-2.5 rounded-sm bg-surface-active"
                // Varied widths so it reads as content loading rather than a
                // progress bar. Deterministic, so it does not flicker on
                // re-render.
                style={{ width: `${45 + ((rowIndex * 7 + columnIndex * 13) % 40)}%` }}
              />
            </td>
          ))}
        </tr>
      ))}
      <tr className="sr-only">
        <td colSpan={columns.length}>
          <span role="status">Loading</span>
        </td>
      </tr>
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Pagination
 * ══════════════════════════════════════════════════════════════════════════ */

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (total === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-4 border-t border-border px-4 py-2"
    >
      <p className="text-xs text-fg-tertiary">
        {from}–{to} of {total}
      </p>

      {totalPages > 1 && (
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <span className="px-2 text-xs text-fg-secondary">
            {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </nav>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * A bordered region that holds a table, its filters and its pagination.
 *
 * Deliberately not called a Card, and deliberately not rounded much: it is a
 * region boundary, not a floating object. One hairline border and a 6px radius.
 * ══════════════════════════════════════════════════════════════════════════ */

export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-hidden rounded-lg border border-border bg-surface', className)}>
      {children}
    </div>
  );
}

export function PanelHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      {children}
    </div>
  );
}
