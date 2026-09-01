'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Permission } from '@atlas/types';
import { PROJECT_STATUSES } from '@atlas/validation';
import { Breadcrumb, PageBody, PageHeader, useTenant } from '@/components/app-shell';
import {
  Avatar,
  Button,
  Field,
  Input,
  Priority,
  Reference,
  Select,
  StatusBadge,
  Textarea,
} from '@/components/ui/primitives';
import { DetailRow, Section } from '@/components/ui/section';
import { DataTable, Panel, PanelHeader, type Column } from '@/components/ui/table';
import { Dialog, DialogClose, ConfirmDialog } from '@/components/ui/dialog';
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  PageLoading,
  describeError,
} from '@/components/ui/states';
import { StatusCell } from '@/components/work-item-status';
import { SelectFilter } from '@/components/ui/filters';
import { ApiError, api } from '@/lib/api';
import {
  keys,
  useProject,
  useTeams,
  useWorkItems,
  useWorkItemStatus,
  type ProjectDetail,
  type WorkItemRow,
} from '@/lib/queries';
import { absoluteTime, isOverdue, relativeTime, shortDate } from '@/lib/format';

const WORK_ITEM_STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'];

/**
 * Project detail.
 *
 * The one detail route in the product, and it earns the destination because a
 * project is the unit people organise around: its work, its people, and the
 * decisions about it (status, owning team, description) all live together and
 * are all edited from here. The work-item table repeats the inline status
 * control from the main list rather than sending anyone somewhere else to
 * change one.
 */
export default function ProjectDetailPage() {
  const tenant = useTenant();
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const project = useProject(tenant.slug, projectId);

  if (!tenant.can(Permission.PROJECTS_READ)) {
    return (
      <>
        <PageHeader title="Project" />
        <PageBody>
          <ForbiddenState what="projects" />
        </PageBody>
      </>
    );
  }

  if (project.isPending) return <PageLoading label="Loading project" />;

  if (project.error) {
    const notFound = project.error instanceof ApiError && project.error.isNotFound;
    return (
      <>
        <PageHeader
          title={notFound ? 'Project not found' : 'Project'}
          breadcrumb={
            <Breadcrumb items={[{ label: 'Projects', href: `/app/${tenant.slug}/projects` }]} />
          }
        />
        <PageBody>
          {notFound ? (
            <EmptyState
              title="This project does not exist"
              description="It may have been deleted, or the link may be wrong."
              action={
                <Button size="sm" variant="secondary" onClick={() => history.back()}>
                  Go back
                </Button>
              }
            />
          ) : (
            <ErrorState error={project.error} onRetry={() => void project.refetch()} />
          )}
        </PageBody>
      </>
    );
  }

  // Settled, not errored, so the data is present — the guard is here because
  // the query's success and data types are not linked by the type system.
  if (!project.data) return null;

  return <ProjectDetailView project={project.data} />;
}

function ProjectDetailView({ project }: { project: ProjectDetail }) {
  const tenant = useTenant();
  const [editing, setEditing] = React.useState(false);
  const canUpdate = tenant.can(Permission.PROJECTS_UPDATE);

  return (
    <>
      <PageHeader
        title={project.name}
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Projects', href: `/app/${tenant.slug}/projects` },
              { label: project.key },
            ]}
          />
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={project.status} />
            {canUpdate && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit project
              </Button>
            )}
          </div>
        }
      />

      <PageBody className="flex flex-col gap-4">
        {/*
          Two columns only once the work-item table can hold its own columns
          beside a sidebar — below that the table would be squeezed into a
          horizontal scroller while empty space sat to its right. When stacked,
          the aside comes first so the project's facts stay above the fold.
        */}
        <div className="flex flex-col gap-4 2xl:grid 2xl:grid-cols-[minmax(0,1fr)_300px] 2xl:items-start">
          <div className="order-2 flex min-w-0 flex-col gap-4 2xl:order-none">
            {project.description && (
              <Section title="About">
                <p className="max-w-prose whitespace-pre-wrap text-sm leading-relaxed text-fg-secondary">
                  {project.description}
                </p>
              </Section>
            )}

            <ProjectWorkItems project={project} />
          </div>

          <div className="order-1 flex flex-col gap-4 2xl:order-none">
            <Section title="Details">
              <dl>
                <DetailRow label="Key">
                  <Reference value={project.key} />
                </DetailRow>
                <DetailRow label="Workspace">{project.workspace.name}</DetailRow>
                <DetailRow label="Team">
                  {project.team?.name ?? <span className="text-fg-tertiary">Unassigned</span>}
                </DetailRow>
                <DetailRow label="Work items">{project._count.workItems}</DetailRow>
                <DetailRow label="Created">
                  <time dateTime={project.createdAt} title={absoluteTime(project.createdAt)}>
                    {relativeTime(project.createdAt)}
                  </time>
                </DetailRow>
                <DetailRow label="Updated">
                  <time dateTime={project.updatedAt} title={absoluteTime(project.updatedAt)}>
                    {relativeTime(project.updatedAt)}
                  </time>
                </DetailRow>
                {project.archivedAt && (
                  <DetailRow label="Archived">
                    <time dateTime={project.archivedAt} title={absoluteTime(project.archivedAt)}>
                      {relativeTime(project.archivedAt)}
                    </time>
                  </DetailRow>
                )}
              </dl>
            </Section>

            <ProjectMembers project={project} />
          </div>
        </div>

        {/* Last on the page in both layouts. A destructive action does not
            belong floating in a sidebar next to reference information. */}
        {tenant.can(Permission.PROJECTS_DELETE) && <DeleteProject project={project} />}
      </PageBody>

      <EditProjectDialog project={project} open={editing} onOpenChange={setEditing} />
    </>
  );
}

function ProjectWorkItems({ project }: { project: ProjectDetail }) {
  const tenant = useTenant();
  const [status, setStatus] = React.useState('');
  const statusMutation = useWorkItemStatus(tenant.slug);
  const canUpdate = tenant.can(Permission.WORKITEMS_UPDATE);

  const query = useWorkItems(tenant.slug, {
    projectId: project.id,
    pageSize: 50,
    sortBy: 'updatedAt',
    sortDirection: 'desc',
    status: status || undefined,
  });

  if (!tenant.can(Permission.WORKITEMS_READ)) return null;

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
      width: 'w-[116px]',
      render: (item) =>
        canUpdate ? (
          <StatusCell
            item={item}
            onChange={(next) => statusMutation.mutate({ id: item.id, status: next })}
          />
        ) : (
          <StatusBadge status={item.status} />
        ),
    },
    {
      id: 'priority',
      header: 'Priority',
      width: 'w-[88px]',
      hideBelow: 'sm',
      render: (item) => <Priority priority={item.priority} />,
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

  return query.error ? (
    <ErrorState error={query.error} onRetry={() => void query.refetch()} />
  ) : (
    <Panel>
      <PanelHeader>
        <span className="text-xs font-medium text-fg">Work items</span>
        <SelectFilter
          label="Status"
          value={status}
          onChange={setStatus}
          options={WORK_ITEM_STATUSES}
        />
        <span className="ml-auto text-xs text-fg-tertiary">
          {query.data ? `${query.data.pagination.total} of ${project._count.workItems}` : null}
        </span>
      </PanelHeader>

      <DataTable
        caption={`Work items in ${project.name}`}
        columns={columns}
        rows={query.data?.data ?? []}
        rowKey={(item) => item.id}
        loading={query.isFetching}
        rowAccent={(item) =>
          isOverdue(item.dueDate, item.status)
            ? 'danger'
            : item.priority === 'URGENT' && item.status !== 'DONE'
              ? 'warning'
              : undefined
        }
        empty={
          <EmptyState
            size="compact"
            title={status ? 'No items with that status' : 'No work items in this project'}
            {...(status
              ? {
                  action: (
                    <Button size="sm" variant="secondary" onClick={() => setStatus('')}>
                      Clear filter
                    </Button>
                  ),
                }
              : {})}
          />
        }
      />
    </Panel>
  );
}

function ProjectMembers({ project }: { project: ProjectDetail }) {
  return (
    <Section title="Members" description="People with explicit access to this project.">
      {project.members.length === 0 ? (
        <p className="text-sm text-fg-tertiary">
          No one is assigned to this project directly. Organization members can still see it.
        </p>
      ) : (
        <ul className="flex flex-col">
          {project.members.map((member) => (
            <li
              key={member.id}
              className="flex items-center gap-2.5 border-b border-border-subtle py-1.5 last:border-b-0"
            >
              <Avatar name={member.user.displayName} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="truncate-cell block text-sm text-fg">
                  {member.user.displayName}
                </span>
                <span className="truncate-cell block text-xs text-fg-tertiary">
                  {member.user.email}
                </span>
              </span>
              <span className="shrink-0 text-xs text-fg-tertiary">
                {member.role.charAt(0) + member.role.slice(1).toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function DeleteProject({ project }: { project: ProjectDetail }) {
  const tenant = useTenant();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function remove() {
    setPending(true);
    setError(null);
    try {
      await api.delete(`/organizations/${tenant.slug}/projects/${project.id}`);
      await queryClient.invalidateQueries({ queryKey: ['projects', tenant.slug] });
      router.replace(`/app/${tenant.slug}/projects`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeError(err).description);
      setPending(false);
    }
  }

  return (
    <>
      <Section
        title="Delete project"
        description={
          project._count.workItems === 0
            ? `Removes ${project.name}. It holds no work items, so nothing else is affected.`
            : `Removes ${project.name} and its ${project._count.workItems} work ${
                project._count.workItems === 1 ? 'item' : 'items'
              }. References like ${project.key}-1 stop resolving.`
        }
        className="border-danger-border 2xl:max-w-3xl"
        footer={
          <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
            Delete project
          </Button>
        }
      />

      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(false);
            setError(null);
          }
        }}
        title="Delete this project"
        description={`Everything in ${project.name} is removed. Archiving keeps the history and hides the project instead — edit the project to do that.`}
        confirmLabel="Delete project"
        confirmText={project.key}
        confirmTextLabel="Type the project key to confirm"
        onConfirm={() => void remove()}
        pending={pending}
        {...(error ? { error } : {})}
      />
    </>
  );
}

function EditProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const teams = useTeams(tenant.slug);

  const [name, setName] = React.useState(project.name);
  const [description, setDescription] = React.useState(project.description ?? '');
  const [status, setStatus] = React.useState(project.status);
  const [teamId, setTeamId] = React.useState(project.team?.id ?? '');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName(project.name);
    setDescription(project.description ?? '');
    setStatus(project.status);
    setTeamId(project.team?.id ?? '');
    setError(null);
  }, [open, project]);

  async function save() {
    setPending(true);
    setError(null);
    try {
      await api.patch(`/organizations/${tenant.slug}/projects/${project.id}`, {
        name: name.trim(),
        // Empty means "no description" rather than an empty string, and empty
        // team means explicitly unassigned — both are nullable server-side.
        description: description.trim() === '' ? null : description.trim(),
        status,
        teamId: teamId === '' ? null : teamId,
      });
      await queryClient.invalidateQueries({ queryKey: keys.project(tenant.slug, project.id) });
      await queryClient.invalidateQueries({ queryKey: ['projects', tenant.slug] });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeError(err).description);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit project"
      description={`${project.key} — the key itself cannot change, because it appears in every work-item reference.`}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="primary" loading={pending} onClick={() => void save()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm"
          >
            {error}
          </p>
        )}

        <Field label="Name" htmlFor="project-name" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field label="Status" htmlFor="project-status">
          <Select value={status} onChange={(event) => setStatus(event.target.value)}>
            {PROJECT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.charAt(0) + value.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Team"
          htmlFor="project-team"
          description="The team accountable for this project."
        >
          <Select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
            <option value="">Unassigned</option>
            {(teams.data?.data ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Description" htmlFor="project-description">
          <Textarea
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
