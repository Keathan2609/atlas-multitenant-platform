'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Permission } from '@atlas/types';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Button, Reference, StatusBadge } from '@/components/ui/primitives';
import { DataTable, Pagination, Panel, PanelHeader, type Column } from '@/components/ui/table';
import { EmptyState, ErrorState, ForbiddenState, NoResultsState } from '@/components/ui/states';
import { useProjects, type ProjectRow } from '@/lib/queries';
import { useListParams } from '@/lib/use-list-params';
import { SearchInput, SelectFilter } from '@/components/ui/filters';
import { relativeTime } from '@/lib/format';

const STATUSES = ['PLANNING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'];

export default function ProjectsPage() {
  const router = useRouter();
  const tenant = useTenant();
  const params = useListParams({ sortBy: 'updatedAt', sortDirection: 'desc' });

  const query = useProjects(tenant.slug, {
    page: params.page,
    pageSize: 25,
    search: params.search || undefined,
    status: params.get('status') || undefined,
    sortBy: params.sortBy,
    sortDirection: params.sortDirection,
  });

  // Permission gate is presentation only. The API refuses the request
  // regardless of what this component renders.
  if (!tenant.can(Permission.PROJECTS_READ)) {
    return (
      <>
        <PageHeader title="Projects" />
        <PageBody>
          <ForbiddenState what="projects" />
        </PageBody>
      </>
    );
  }

  const columns: Array<Column<ProjectRow>> = [
    {
      id: 'key',
      header: 'Key',
      width: 'w-[92px]',
      render: (project) => <Reference value={project.key} />,
    },
    {
      id: 'name',
      header: 'Project',
      sortable: true,
      render: (project) => (
        <div className="min-w-0">
          <div className="truncate-cell font-medium text-fg">{project.name}</div>
          {project.description && (
            <div className="truncate-cell text-xs text-fg-tertiary">
              {project.description}
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      width: 'w-[112px]',
      render: (project) => <StatusBadge status={project.status} />,
    },
    {
      id: 'team',
      header: 'Team',
      width: 'w-[152px]',
      hideBelow: 'md',
      render: (project) => (
        <span className="truncate-cell block text-fg-secondary">
          {project.team?.name ?? <span className="text-fg-tertiary">Unassigned</span>}
        </span>
      ),
    },
    {
      id: 'workItemCount',
      header: 'Items',
      align: 'right',
      width: 'w-[72px]',
      hideBelow: 'sm',
      render: (project) => (
        <span className="text-fg-secondary">{project.workItemCount}</span>
      ),
    },
    {
      id: 'updatedAt',
      header: 'Updated',
      sortable: true,
      align: 'right',
      width: 'w-[112px]',
      hideBelow: 'lg',
      render: (project) => (
        <time
          dateTime={project.updatedAt}
          // The exact timestamp on hover: relative time is scannable, absolute
          // time is what you need when it matters.
          title={new Date(project.updatedAt).toLocaleString()}
          className="text-fg-tertiary"
        >
          {relativeTime(project.updatedAt)}
        </time>
      ),
    },
  ];

  const rows = query.data?.data ?? [];
  const pagination = query.data?.pagination;
  const filtered = Boolean(params.search || params.get('status'));

  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          tenant.can(Permission.PROJECTS_CREATE) ? (
            <Button
              variant="primary"
              size="md"
              onClick={() => router.push(`/app/${tenant.slug}/projects/new`)}
            >
              New project
            </Button>
          ) : undefined
        }
      />

      <PageBody>
        {query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <Panel>
            <PanelHeader>
              <SearchInput
                value={params.search}
                onChange={params.setSearch}
                placeholder="Search projects"
                label="Search projects"
              />
              <SelectFilter
                label="Status"
                value={params.get('status')}
                onChange={(value) => params.set('status', value)}
                options={STATUSES}
              />
              <span className="ml-auto text-xs text-fg-tertiary">
                {pagination ? `${pagination.total} ${pagination.total === 1 ? 'project' : 'projects'}` : null}
              </span>
            </PanelHeader>

            <DataTable
              caption="Projects in this organization"
              columns={columns}
              rows={rows}
              rowKey={(project) => project.id}
              loading={query.isFetching}
              onRowClick={(project) =>
                router.push(`/app/${tenant.slug}/projects/${project.id}`)
              }
              sort={{ id: params.sortBy, direction: params.sortDirection }}
              onSortChange={params.setSort}
              empty={
                filtered ? (
                  <NoResultsState onClear={params.clear} />
                ) : (
                  <EmptyState
                    title="No projects yet"
                    description="Projects group the work your teams are doing. Create one to get started."
                    action={
                      tenant.can(Permission.PROJECTS_CREATE) ? (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => router.push(`/app/${tenant.slug}/projects/new`)}
                        >
                          New project
                        </Button>
                      ) : undefined
                    }
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
