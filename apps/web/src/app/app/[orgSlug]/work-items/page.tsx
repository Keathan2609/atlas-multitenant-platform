'use client';

import { Permission } from '@atlas/types';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Avatar, Priority, Reference, StatusBadge } from '@/components/ui/primitives';
import { DataTable, Pagination, Panel, PanelHeader, type Column } from '@/components/ui/table';
import { EmptyState, ErrorState, ForbiddenState, NoResultsState } from '@/components/ui/states';
import { SearchInput, SelectFilter } from '@/components/ui/filters';
import { useWorkItems, useWorkItemStatus, type WorkItemRow } from '@/lib/queries';
import { useListParams } from '@/lib/use-list-params';
import { isOverdue, shortDate } from '@/lib/format';
import { StatusCell } from '@/components/work-item-status';

const STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'];
const PRIORITIES = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
const TYPES = ['TASK', 'ISSUE', 'BUG', 'IMPROVEMENT'];

/**
 * Work items.
 *
 * The densest table in the product, and the one people keep open. Two things
 * shape it beyond the usual:
 *
 *  - Status is editable inline. Changing a status is the single most frequent
 *    action in the tool, and making someone open a detail page to do it would
 *    be the difference between the table being useful and being a report.
 *  - The left edge marks rows that need attention — urgent, or overdue. It
 *    costs no column and makes triage a glance down the margin.
 */
export default function WorkItemsPage() {
  const tenant = useTenant();
  const params = useListParams({ sortBy: 'updatedAt', sortDirection: 'desc' });
  const statusMutation = useWorkItemStatus(tenant.slug);

  const query = useWorkItems(tenant.slug, {
    page: params.page,
    pageSize: 25,
    search: params.search || undefined,
    status: params.get('status') || undefined,
    priority: params.get('priority') || undefined,
    type: params.get('type') || undefined,
    assigneeId: params.get('assigneeId') || undefined,
    sortBy: params.sortBy,
    sortDirection: params.sortDirection,
  });

  if (!tenant.can(Permission.WORKITEMS_READ)) {
    return (
      <>
        <PageHeader title="Work items" />
        <PageBody>
          <ForbiddenState what="work items" />
        </PageBody>
      </>
    );
  }

  const canUpdate = tenant.can(Permission.WORKITEMS_UPDATE);

  const columns: Array<Column<WorkItemRow>> = [
    {
      id: 'reference',
      header: 'Ref',
      width: 'w-[92px]',
      render: (item) => <Reference value={item.reference} />,
    },
    {
      id: 'title',
      header: 'Title',
      render: (item) => (
        <span title={item.title} className="truncate-cell block font-medium text-fg">
          {item.title}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      width: 'w-[116px]',
      render: (item) =>
        canUpdate ? (
          <StatusCell
            item={item}
            onChange={(status) => statusMutation.mutate({ id: item.id, status })}
          />
        ) : (
          <StatusBadge status={item.status} />
        ),
    },
    {
      id: 'priority',
      header: 'Priority',
      sortable: true,
      width: 'w-[88px]',
      hideBelow: 'sm',
      render: (item) => <Priority priority={item.priority} />,
    },
    {
      id: 'project',
      header: 'Project',
      width: 'w-[152px]',
      hideBelow: 'lg',
      render: (item) => (
        <span title={item.project.name} className="truncate-cell block text-fg-secondary">
          {item.project.name}
        </span>
      ),
    },
    {
      id: 'assignee',
      header: 'Assignee',
      width: 'w-[152px]',
      hideBelow: 'md',
      render: (item) =>
        item.assignee ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={item.assignee.displayName} size="sm" />
            <span className="truncate-cell text-fg-secondary">{item.assignee.displayName}</span>
          </span>
        ) : (
          <span className="text-fg-tertiary">Unassigned</span>
        ),
    },
    {
      id: 'dueDate',
      header: 'Due',
      sortable: true,
      align: 'right',
      width: 'w-[104px]',
      hideBelow: 'sm',
      render: (item) => {
        if (!item.dueDate) return <span className="text-fg-tertiary">—</span>;
        const overdue = isOverdue(item.dueDate, item.status);
        return (
          <time
            dateTime={item.dueDate}
            title={shortDate(item.dueDate)}
            className={
              overdue
                ? 'whitespace-nowrap text-xs font-medium text-danger'
                : 'whitespace-nowrap text-xs text-fg-tertiary'
            }
          >
            {shortDate(item.dueDate)}
          </time>
        );
      },
    },
  ];

  const rows = query.data?.data ?? [];
  const pagination = query.data?.pagination;
  const filtered = Boolean(
    params.search ||
      params.get('status') ||
      params.get('priority') ||
      params.get('type') ||
      params.get('assigneeId'),
  );

  return (
    <>
      <PageHeader title="Work items" />

      <PageBody>
        {query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <Panel>
            <PanelHeader>
              <SearchInput
                value={params.search}
                onChange={params.setSearch}
                placeholder="Search titles"
                label="Search work items"
              />
              <SelectFilter
                label="Status"
                value={params.get('status')}
                onChange={(value) => params.set('status', value)}
                options={STATUSES}
              />
              <SelectFilter
                label="Priority"
                value={params.get('priority')}
                onChange={(value) => params.set('priority', value)}
                options={PRIORITIES}
              />
              <SelectFilter
                label="Type"
                value={params.get('type')}
                onChange={(value) => params.set('type', value)}
                options={TYPES}
              />
              <SelectFilter
                label="Assignee"
                value={params.get('assigneeId')}
                onChange={(value) => params.set('assigneeId', value)}
                options={['me', 'unassigned']}
                optionLabels={{ me: 'Me', unassigned: 'Unassigned' }}
              />
              <span className="ml-auto text-xs text-fg-tertiary">
                {pagination
                  ? `${pagination.total} ${pagination.total === 1 ? 'item' : 'items'}`
                  : null}
              </span>
            </PanelHeader>

            <DataTable
              caption="Work items in this organization"
              columns={columns}
              rows={rows}
              rowKey={(item) => item.id}
              loading={query.isFetching}
              rowAccent={(item) =>
                isOverdue(item.dueDate, item.status)
                  ? 'danger'
                  : item.priority === 'URGENT' && item.status !== 'DONE'
                    ? 'warning'
                    : undefined
              }
              sort={{ id: params.sortBy, direction: params.sortDirection }}
              onSortChange={params.setSort}
              empty={
                filtered ? (
                  <NoResultsState onClear={params.clear} />
                ) : (
                  <EmptyState
                    title="No work items yet"
                    description="Work items are created inside a project."
                  />
                )
              }
            />

            {pagination && (
              <Pagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                total={pagination.total}
                totalPages={pagination.totalPages}
                onPageChange={params.setPage}
              />
            )}
          </Panel>
        )}
      </PageBody>
    </>
  );
}
