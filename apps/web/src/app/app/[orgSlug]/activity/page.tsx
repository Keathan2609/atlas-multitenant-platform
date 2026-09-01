'use client';

import * as React from 'react';
import { Permission } from '@atlas/types';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Avatar, Button, Reference, humanise } from '@/components/ui/primitives';
import { Panel, PanelHeader } from '@/components/ui/table';
import { EmptyState, ErrorState, ForbiddenState, Skeleton } from '@/components/ui/states';
import { SelectFilter } from '@/components/ui/filters';
import { useAuditActions, useAuditLogs, type AuditEntry } from '@/lib/queries';
import { useListParams } from '@/lib/use-list-params';
import { absoluteTime, relativeTime } from '@/lib/format';

/**
 * Activity — the audit log.
 *
 * A list rather than a table, because an audit entry is a sentence, not a row
 * of parallel fields. "Dana changed Marcus's role from member to admin" reads
 * as one thing; split across five columns it reads as five.
 *
 * Cursor-paginated with a "Load more" button rather than numbered pages. The
 * log is append-heavy, so page 3 means something different a minute later —
 * and nobody wants to jump to page 47 of an audit trail, they want to keep
 * reading backwards.
 */
export default function ActivityPage() {
  const tenant = useTenant();
  const params = useListParams({ sortBy: 'createdAt', sortDirection: 'desc' });
  const [cursors, setCursors] = React.useState<string[]>([]);

  const canRead = tenant.can(Permission.AUDIT_READ);

  const filters = {
    action: params.get('action') || undefined,
    limit: 50,
  };

  const query = useAuditLogs(tenant.slug, filters, canRead);
  const actionsQuery = useAuditActions(tenant.slug, canRead);

  // Additional pages, appended. Held here rather than pushed into the query
  // key so that changing a filter resets the accumulation instead of mixing
  // pages from two different filter sets.
  const [extraPages, setExtraPages] = React.useState<AuditEntry[]>([]);
  const [loadingMore, setLoadingMore] = React.useState(false);

  React.useEffect(() => {
    setExtraPages([]);
    setCursors([]);
  }, [params.get('action')]);

  if (!canRead) {
    return (
      <>
        <PageHeader title="Activity" />
        <PageBody>
          <ForbiddenState what="the activity log" />
        </PageBody>
      </>
    );
  }

  const entries = [...(query.data?.data ?? []), ...extraPages];
  const nextCursor =
    extraPages.length > 0 ? cursors[cursors.length - 1] : query.data?.pagination.nextCursor;
  const hasMore = Boolean(nextCursor);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const { api } = await import('@/lib/api');
      const page = await api.get<{
        data: AuditEntry[];
        pagination: { nextCursor: string | null };
      }>(`/organizations/${tenant.slug}/audit-logs`, { ...filters, cursor: nextCursor });
      setExtraPages((current) => [...current, ...page.data]);
      setCursors((current) => [...current, page.pagination.nextCursor ?? '']);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Activity"
        description="Administrative actions in this organization. Entries cannot be edited or deleted."
      />

      <PageBody>
        {query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <Panel>
            <PanelHeader>
              <SelectFilter
                label="Action"
                value={params.get('action')}
                onChange={(value) => params.set('action', value)}
                options={actionsQuery.data?.data ?? []}
                optionLabels={Object.fromEntries(
                  (actionsQuery.data?.data ?? []).map((action) => [action, describeAction(action)]),
                )}
              />
              <span className="ml-auto text-xs text-fg-tertiary">
                {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
                {hasMore ? '+' : ''}
              </span>
            </PanelHeader>

            {query.isPending ? (
              <ul className="divide-y divide-border-subtle">
                {Array.from({ length: 8 }, (_, index) => (
                  <li key={index} className="flex items-center gap-3 px-4 py-2.5">
                    <Skeleton className="size-6 rounded-full" />
                    <Skeleton className="h-2.5 flex-1" />
                    <Skeleton className="h-2.5 w-24" />
                  </li>
                ))}
                <li className="sr-only" role="status">
                  Loading activity
                </li>
              </ul>
            ) : entries.length === 0 ? (
              <div className="px-4 py-10">
                <EmptyState
                  title={params.get('action') ? 'No matching entries' : 'No activity yet'}
                  description={
                    params.get('action')
                      ? 'No entries match this action.'
                      : 'Administrative actions will be recorded here.'
                  }
                  action={
                    params.get('action') ? (
                      <Button size="sm" variant="secondary" onClick={params.clear}>
                        Clear filter
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <>
                <ul className="divide-y divide-border-subtle">
                  {entries.map((entry) => (
                    <AuditLine key={entry.id} entry={entry} />
                  ))}
                </ul>

                {hasMore && (
                  <div className="border-t border-border px-4 py-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={loadingMore}
                      onClick={() => void loadMore()}
                    >
                      Load older entries
                    </Button>
                  </div>
                )}
              </>
            )}
          </Panel>
        )}
      </PageBody>
    </>
  );
}

function AuditLine({ entry }: { entry: AuditEntry }) {
  const actor = entry.actor?.displayName ?? 'System';

  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      {entry.actor ? (
        <Avatar name={entry.actor.displayName} />
      ) : (
        <span
          aria-hidden="true"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-active text-2xs text-fg-tertiary"
        >
          SY
        </span>
      )}

      <div className="min-w-0 flex-1">
        <p className="text-sm text-fg">
          <span className="font-medium">{actor}</span>{' '}
          <span className="text-fg-secondary">{describeAction(entry.action)}</span>
        </p>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-tertiary">
          <Reference value={entry.action} />
          {renderMetadata(entry.metadata)}
          {entry.ipAddress && <span className="reference">{entry.ipAddress}</span>}
        </div>
      </div>

      <time
        dateTime={entry.createdAt}
        title={absoluteTime(entry.createdAt)}
        className="shrink-0 text-xs text-fg-tertiary"
      >
        {relativeTime(entry.createdAt)}
      </time>
    </li>
  );
}

/**
 * Turns a dotted action name into a readable clause.
 *
 * The mapping is explicit rather than derived from the string, because
 * "member.role_changed" is not "Member role changed" in a sentence that starts
 * with someone's name — it is "changed a member's role".
 */
function describeAction(action: string): string {
  const phrases: Record<string, string> = {
    'organization.created': 'created the organization',
    'organization.updated': 'updated organization details',
    'organization.deleted': 'deleted the organization',
    'organization.settings_updated': 'changed organization settings',
    'member.invited': 'invited someone to join',
    'member.joined': 'joined the organization',
    'member.role_changed': "changed a member's role",
    'member.removed': 'removed a member',
    'member.left': 'left the organization',
    'invitation.revoked': 'revoked an invitation',
    'team.created': 'created a team',
    'team.updated': 'updated a team',
    'team.deleted': 'deleted a team',
    'workspace.created': 'created a workspace',
    'workspace.updated': 'updated a workspace',
    'workspace.deleted': 'deleted a workspace',
    'project.created': 'created a project',
    'project.updated': 'updated a project',
    'project.archived': 'archived a project',
    'project.deleted': 'deleted a project',
    'apikey.created': 'created an API key',
    'apikey.revoked': 'revoked an API key',
  };
  return phrases[action] ?? humanise(action.replace(/\./g, ' '));
}

/** Renders the handful of metadata keys worth showing inline. */
function renderMetadata(metadata: AuditEntry['metadata']): React.ReactNode {
  const interesting = ['name', 'key', 'slug', 'email', 'from', 'to', 'role', 'keyPrefix'];
  const parts = interesting
    .filter((key) => metadata[key] !== undefined && metadata[key] !== null)
    .map((key) => `${key}: ${String(metadata[key])}`);

  if (parts.length === 0) return null;
  return <span className="truncate-cell max-w-[420px]">{parts.join(' · ')}</span>;
}
