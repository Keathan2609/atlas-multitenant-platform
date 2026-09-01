'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cx } from './primitives';

/**
 * Row action menu.
 *
 * A single trigger rather than a row of buttons: most rows have one or two
 * actions, and laying them out inline would add a wide, mostly-empty column to
 * every table.
 *
 * `stopPropagation` on both the trigger and the content is load-bearing —
 * rows are usually clickable, and without it opening the menu would navigate.
 */
export function RowMenu({
  label,
  items,
}: {
  label: string;
  items: Array<{ label: string; destructive?: boolean; onSelect: () => void }>;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(event) => event.stopPropagation()}
          className="inline-flex size-6 items-center justify-center rounded-md text-fg-tertiary hover:bg-surface-hover hover:text-fg"
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            <circle cx="8" cy="3.5" r="1.25" fill="currentColor" />
            <circle cx="8" cy="8" r="1.25" fill="currentColor" />
            <circle cx="8" cy="12.5" r="1.25" fill="currentColor" />
          </svg>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          onClick={(event) => event.stopPropagation()}
          className="z-50 min-w-[200px] rounded-lg border border-border bg-surface-raised p-1 shadow-menu"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              onSelect={item.onSelect}
              className={cx(
                'cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none',
                'data-[highlighted]:bg-surface-hover',
                item.destructive && 'text-danger',
              )}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
