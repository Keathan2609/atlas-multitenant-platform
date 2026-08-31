'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { SortDirection } from '@/components/ui/table';

/**
 * List state, kept in the URL.
 *
 * Filters, sort and page live in the query string rather than component state,
 * which buys three things that matter in an operations tool:
 *
 *  - A filtered view is a link. "Everything urgent and unassigned" can be
 *    pasted into a message, which is how people actually hand work over.
 *  - Back and forward behave. Refining a filter and pressing back returns to
 *    the previous view instead of leaving the page.
 *  - Reloading keeps your place, which matters when a request fails and you
 *    retry.
 *
 * Search is debounced before it reaches the URL so typing does not push a
 * history entry per keystroke, while the input itself stays fully controlled
 * and responsive.
 */

export interface ListParams {
  page: number;
  search: string;
  sortBy: string;
  sortDirection: SortDirection;
  get: (key: string) => string;
  set: (key: string, value: string) => void;
  setSearch: (value: string) => void;
  setSort: (id: string, direction: SortDirection) => void;
  setPage: (page: number) => void;
  clear: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;

export function useListParams(defaults: {
  sortBy: string;
  sortDirection: SortDirection;
}): ListParams {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlSearch = searchParams.get('q') ?? '';
  const [searchDraft, setSearchDraft] = React.useState(urlSearch);

  // Keeps the input in step when the URL changes from elsewhere — a back
  // navigation, or the "clear filters" action.
  React.useEffect(() => setSearchDraft(urlSearch), [urlSearch]);

  const commit = React.useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(searchParams.toString());
      mutate(next);
      const query = next.toString();
      // `scroll: false` — changing a filter should not throw the reader back
      // to the top of a table they were part-way down.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  React.useEffect(() => {
    if (searchDraft === urlSearch) return;
    const timer = setTimeout(() => {
      commit((next) => {
        if (searchDraft) next.set('q', searchDraft);
        else next.delete('q');
        // Any change to the filter set invalidates the current page number.
        next.delete('page');
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, urlSearch, commit]);

  const pageValue = Number(searchParams.get('page') ?? '1');

  return {
    page: Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1,
    search: searchDraft,
    sortBy: searchParams.get('sortBy') ?? defaults.sortBy,
    sortDirection: (searchParams.get('sortDirection') as SortDirection) ?? defaults.sortDirection,

    get: (key) => searchParams.get(key) ?? '',

    set: (key, value) =>
      commit((next) => {
        if (value) next.set(key, value);
        else next.delete(key);
        next.delete('page');
      }),

    setSearch: setSearchDraft,

    setSort: (id, direction) =>
      commit((next) => {
        next.set('sortBy', id);
        next.set('sortDirection', direction);
        next.delete('page');
      }),

    setPage: (page) =>
      commit((next) => {
        if (page > 1) next.set('page', String(page));
        else next.delete('page');
      }),

    clear: () => {
      setSearchDraft('');
      router.replace(pathname, { scroll: false });
    },
  };
}
