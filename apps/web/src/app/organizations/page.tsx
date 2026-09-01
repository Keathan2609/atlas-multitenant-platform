'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Avatar, Button, Reference } from '@/components/ui/primitives';
import { EmptyState, ErrorState, PageLoading } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import { useOrganizations } from '@/lib/queries';
import { relativeTime } from '@/lib/format';

/**
 * Organization picker.
 *
 * Shown when an account belongs to more than one organization. It is a
 * junction, not a dashboard: a list of names, the role held in each, and
 * nothing that would make anyone linger.
 */
export default function OrganizationsPage() {
  const router = useRouter();
  const query = useOrganizations();

  // An account with exactly one organization has no choice to make; sending
  // them through a one-item list would be a page for its own sake. Sign-in
  // already skips this route, but a bookmark or a "switch organization" click
  // can still land here.
  const only = query.data?.data.length === 1 ? query.data.data[0] : undefined;
  React.useEffect(() => {
    if (only) router.replace(`/app/${only.slug}`);
  }, [only, router]);

  if (query.error instanceof ApiError && query.error.status === 401) {
    router.replace('/sign-in');
    return null;
  }

  if (query.isPending) return <PageLoading label="Loading your organizations" />;

  const rows = query.data?.data ?? [];

  return (
    <main className="mx-auto w-full max-w-lg px-4 py-10 sm:py-16">
      <div className="mb-7">
        <p className="reference text-base font-medium tracking-tight text-fg">ATLAS</p>
        <h1 className="mt-4 text-lg font-semibold text-fg">Choose an organization</h1>
      </div>

      {query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-border bg-surface">
          <EmptyState
            title="You are not in any organization"
            description="Create one to get started, or ask a colleague to invite you."
            action={
              <Link href="/onboarding">
                <Button size="sm" variant="primary">
                  Create an organization
                </Button>
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {rows.map((organization) => (
              <li key={organization.id}>
                <Link
                  href={`/app/${organization.slug}`}
                  className="flex items-center gap-3 rounded-md border border-border bg-surface
                             px-3 py-2.5 transition-colors hover:border-border-strong
                             hover:bg-surface-raised focus-visible:outline focus-visible:outline-2
                             focus-visible:outline-offset-2 focus-visible:outline-accent
                             motion-reduce:transition-none"
                >
                  <Avatar name={organization.name} />
                  <span className="min-w-0 flex-1">
                    <span className="truncate-cell block text-sm font-medium text-fg">
                      {organization.name}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-fg-tertiary">
                      <Reference value={organization.slug} />
                      <span>
                        {organization.memberCount}{' '}
                        {organization.memberCount === 1 ? 'member' : 'members'}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-xs text-fg-secondary">
                      {organization.role.charAt(0) + organization.role.slice(1).toLowerCase()}
                    </span>
                    <span className="block text-2xs text-fg-tertiary">
                      joined {relativeTime(organization.joinedAt)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex items-center justify-between gap-4 text-sm">
            <Link href="/onboarding" className="text-accent hover:underline">
              Create another organization
            </Link>
            <Link href="/profile" className="text-fg-secondary hover:underline">
              Your profile
            </Link>
          </div>
        </>
      )}
    </main>
  );
}
