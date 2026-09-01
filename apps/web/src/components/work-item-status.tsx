'use client';

import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { StatusBadge, cx, humanise } from './ui/primitives';
import type { WorkItemRow } from '@/lib/queries';

const STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'];

/**
 * Inline status editing inside a table row.
 *
 * Changing a status is the most frequent action in the product. Requiring a
 * detail page for it would turn the table from a workspace into a report, so
 * the badge is itself the control.
 *
 * `stopPropagation` on the trigger is load-bearing: the row is also a link to
 * the item, and without it opening the menu would navigate away instead.
 *
 * The update is optimistic — see useWorkItemStatus. This is the one place
 * optimism is warranted: frequent, low-stakes, and trivially reversible.
 * Destructive and administrative actions deliberately wait for the server.
 */
export function StatusCell({
  item,
  onChange,
}: {
  item: WorkItemRow;
  onChange: (status: string) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          className="rounded-sm -mx-1 px-1 py-0.5 hover:bg-surface-hover"
          aria-label={`Status: ${humanise(item.status)}. Change status`}
        >
          <StatusBadge status={item.status} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          onClick={(event) => event.stopPropagation()}
          className="z-50 min-w-[168px] rounded-lg border border-border bg-surface-raised p-1 shadow-menu"
        >
          {STATUSES.map((status) => (
            <DropdownMenu.Item
              key={status}
              onSelect={() => {
                if (status !== item.status) onChange(status);
              }}
              className={cx(
                'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none',
                'data-[highlighted]:bg-surface-hover',
              )}
            >
              <span
                aria-hidden="true"
                className={cx(
                  'size-1.5 rounded-full',
                  status === item.status ? 'bg-accent' : 'bg-transparent',
                )}
              />
              {humanise(status)}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
