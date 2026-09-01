'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Permission } from '@atlas/types';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Button, Field, Input, Reference, Select, StatusBadge, Textarea } from '@/components/ui/primitives';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { DataTable, Pagination, Panel, PanelHeader, type Column } from '@/components/ui/table';
import { EmptyState, ErrorState, ForbiddenState, NoResultsState } from '@/components/ui/states';
import { keys, useProjects, useTeams, useWorkspaces, type ProjectRow } from '@/lib/queries';
import { ApiError, api, applyFieldErrors } from '@/lib/api';
import { describeError } from '@/components/ui/states';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createProjectSchema, type CreateProjectInput } from '@atlas/validation';
import { useListParams } from '@/lib/use-list-params';
import { SearchInput, SelectFilter } from '@/components/ui/filters';
import { relativeTime } from '@/lib/format';

const STATUSES = ['PLANNING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'];

export default function ProjectsPage() {
  const router = useRouter();
  const tenant = useTenant();
  const [creating, setCreating] = React.useState(false);
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
          className="whitespace-nowrap text-fg-tertiary"
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
            <Button variant="primary" size="md" onClick={() => setCreating(true)}>
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
                        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
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

      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

/**
 * New project.
 *
 * A project needs a workspace, so the field is populated from the tenant's
 * real workspaces and defaults to the one marked default — the common case is
 * one workspace, and making someone choose from a list of one would be
 * ceremony. The key is left to the server to derive from the name unless
 * someone types one, because it is permanent once work items reference it.
 */
function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tenant = useTenant();
  const router = useRouter();
  const queryClient = useQueryClient();
  const workspaces = useWorkspaces(tenant.slug);
  const teams = useTeams(tenant.slug);
  const [formError, setFormError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateProjectInput>({ resolver: zodResolver(createProjectSchema) });

  const defaultWorkspaceId =
    workspaces.data?.data.find((workspace) => workspace.isDefault)?.id ??
    workspaces.data?.data[0]?.id ??
    '';

  React.useEffect(() => {
    if (!open) return;
    reset({
      name: '',
      description: '',
      workspaceId: defaultWorkspaceId,
      teamId: null,
      status: 'PLANNING',
    });
    setFormError(null);
  }, [open, reset, defaultWorkspaceId]);

  async function onSubmit(values: CreateProjectInput) {
    setFormError(null);
    try {
      const created = await api.post<{ id: string }>(`/organizations/${tenant.slug}/projects`, {
        name: values.name,
        ...(values.key ? { key: values.key } : {}),
        ...(values.description ? { description: values.description } : {}),
        workspaceId: values.workspaceId,
        teamId: values.teamId ? values.teamId : null,
        status: values.status,
      });
      await queryClient.invalidateQueries({ queryKey: keys.projects(tenant.slug) });
      onOpenChange(false);
      // Straight into the project that was just created: creating one is
      // always the start of setting it up, never the end of a task.
      router.push(`/app/${tenant.slug}/projects/${created.id}`);
    } catch (error) {
      if (!applyFieldErrors(error, setError as never)) {
        setFormError(
          error instanceof ApiError ? error.message : describeError(error).description,
        );
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="Projects group work items and belong to a workspace."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="primary" loading={isSubmitting} onClick={(event) => void handleSubmit(onSubmit)(event)}>
            Create project
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate className="flex flex-col gap-4">
        {formError && (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm"
          >
            {formError}
          </p>
        )}

        <Field label="Name" htmlFor="project-name" error={errors.name?.message} required>
          <Input autoFocus invalid={Boolean(errors.name)} {...register('name')} />
        </Field>

        <Field
          label="Key"
          htmlFor="project-key"
          description="Two to six letters, used in every work-item reference. Derived from the name if left empty, and permanent once set."
          error={errors.key?.message}
        >
          <Input
            className="reference uppercase"
            invalid={Boolean(errors.key)}
            // An empty optional field is *absent*, not an empty string. Without
            // this the resolver measures '' against the two-character minimum
            // and refuses a form the server would have accepted, contradicting
            // the description directly above it.
            {...register('key', {
              setValueAs: (value: string) => (value === '' ? undefined : value),
            })}
          />
        </Field>

        <Field
          label="Workspace"
          htmlFor="project-workspace"
          error={errors.workspaceId?.message}
          required
        >
          <Select invalid={Boolean(errors.workspaceId)} {...register('workspaceId')}>
            {(workspaces.data?.data ?? []).map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Team" htmlFor="project-team" error={errors.teamId?.message}>
          {/* Same reasoning as the key field: "Unassigned" is null, not ''. */}
          <Select {...register('teamId', { setValueAs: (value: string) => (value === '' ? null : value) })}>
            <option value="">Unassigned</option>
            {(teams.data?.data ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Description" htmlFor="project-description" error={errors.description?.message}>
          <Textarea rows={3} {...register('description')} />
        </Field>
      </form>
    </Dialog>
  );
}
