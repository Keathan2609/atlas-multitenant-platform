'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Permission } from '@atlas/types';
import { createTeamSchema } from '@atlas/validation';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Button, Field, Input, Reference, StatusBadge, Textarea } from '@/components/ui/primitives';
import { DataTable, Panel, type Column } from '@/components/ui/table';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { EmptyState, ErrorState, ForbiddenState, describeError } from '@/components/ui/states';
import { api, applyFieldErrors } from '@/lib/api';
import { keys, useTeam, useTeams, type TeamRow } from '@/lib/queries';
import { Avatar } from '@/components/ui/primitives';
import { RowMenu } from '@/components/ui/row-menu';
import { ApiError } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { relativeTime } from '@/lib/format';

interface TeamFormValues {
  name: string;
  slug?: string;
  description?: string;
}

export default function TeamsPage() {
  const tenant = useTenant();
  const [creating, setCreating] = React.useState(false);
  // Team membership is managed here rather than on a detail route — see
  // docs/screen-inventory.md for why that route is deliberately not built.
  const [managing, setManaging] = React.useState<TeamRow | null>(null);
  const query = useTeams(tenant.slug);

  if (!tenant.can(Permission.TEAMS_READ)) {
    return (
      <>
        <PageHeader title="Teams" />
        <PageBody>
          <ForbiddenState what="teams" />
        </PageBody>
      </>
    );
  }

  const columns: Array<Column<TeamRow>> = [
    {
      id: 'slug',
      header: 'Handle',
      width: 'w-[152px]',
      // Same reasoning as Workspaces: the name identifies the team on a phone.
      hideBelow: 'sm',
      render: (team) => <Reference value={team.slug} />,
    },
    {
      id: 'name',
      header: 'Team',
      render: (team) => (
        <div className="min-w-0">
          <div className="truncate-cell font-medium text-fg">{team.name}</div>
          {team.description && (
            <div className="truncate-cell text-xs text-fg-tertiary">{team.description}</div>
          )}
        </div>
      ),
    },
    {
      id: 'memberCount',
      header: 'Members',
      align: 'right',
      width: 'w-[88px]',
      render: (team) => <span className="text-fg-secondary">{team.memberCount}</span>,
    },
    {
      id: 'projectCount',
      header: 'Projects',
      align: 'right',
      width: 'w-[88px]',
      hideBelow: 'sm',
      render: (team) => <span className="text-fg-secondary">{team.projectCount}</span>,
    },
    {
      id: 'createdAt',
      header: 'Created',
      align: 'right',
      width: 'w-[112px]',
      hideBelow: 'lg',
      render: (team) => (
        <time
          dateTime={team.createdAt}
          title={new Date(team.createdAt).toLocaleString()}
          className="whitespace-nowrap text-fg-tertiary"
        >
          {relativeTime(team.createdAt)}
        </time>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Teams"
        actions={
          tenant.can(Permission.TEAMS_CREATE) ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New team
            </Button>
          ) : undefined
        }
      />

      <PageBody>
        {query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <Panel>
            <DataTable
              caption="Teams in this organization"
              columns={columns}
              rows={query.data?.data ?? []}
              rowKey={(team) => team.id}
              loading={query.isFetching}
              onRowClick={(team) => setManaging(team)}
              empty={
                <EmptyState
                  title="No teams yet"
                  description="Teams group people and own projects."
                  action={
                    tenant.can(Permission.TEAMS_CREATE) ? (
                      <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                        New team
                      </Button>
                    ) : undefined
                  }
                />
              }
            />
          </Panel>
        )}
      </PageBody>

      <CreateTeamDialog open={creating} onOpenChange={setCreating} />
      <ManageTeamDialog team={managing} onClose={() => setManaging(null)} />
    </>
  );
}

function CreateTeamDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<TeamFormValues>({ resolver: zodResolver(createTeamSchema) });

  React.useEffect(() => {
    if (open) {
      reset({ name: '', description: '' });
      setFormError(null);
    }
  }, [open, reset]);

  async function onSubmit(values: TeamFormValues) {
    setFormError(null);
    try {
      await api.post(`/organizations/${tenant.slug}/teams`, values);
      await queryClient.invalidateQueries({ queryKey: keys.teams(tenant.slug) });
      onOpenChange(false);
    } catch (error) {
      // Server validation wins; the client schema is only for fast feedback.
      if (!applyFieldErrors(error, setError as never)) {
        setFormError(describeError(error).description);
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New team"
      description="Teams group people and own projects."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="primary"
            loading={isSubmitting}
            onClick={(event) => void handleSubmit(onSubmit)(event)}
            type="submit"
          >
            Create team
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

        <Field label="Name" htmlFor="team-name" error={errors.name?.message} required>
          <Input autoFocus invalid={Boolean(errors.name)} {...register('name')} />
        </Field>

        <Field
          label="Description"
          htmlFor="team-description"
          description="What this team is responsible for."
          error={errors.description?.message}
        >
          <Textarea rows={3} {...register('description')} />
        </Field>
      </form>
    </Dialog>
  );
}

interface TeamMember {
  id: string;
  role: 'LEAD' | 'MEMBER';
  user: { id: string; displayName: string; email: string };
}

interface TeamProject {
  id: string;
  name: string;
  key: string;
  status: string;
}

/**
 * Team membership, managed in place.
 *
 * This is what a team detail route would have shown — its people and its
 * projects. Neither needs a navigation destination of its own: the counts are
 * already in the table, and the only action here is adding or removing
 * someone, which is a focused task with a clear commit point. That is exactly
 * what a dialog is for.
 */
function ManageTeamDialog({ team, onClose }: { team: TeamRow | null; onClose: () => void }) {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);
  const [busyUserId, setBusyUserId] = React.useState<string | null>(null);

  const detail = useTeam(tenant.slug, team?.id ?? '');
  const members = (detail.data?.members ?? []) as TeamMember[];
  const projects = (detail.data?.projects ?? []) as TeamProject[];
  const canManage = tenant.can(Permission.TEAMS_UPDATE);

  async function removeMember(userId: string) {
    if (!team) return;
    setBusyUserId(userId);
    setError(null);
    try {
      await api.delete(`/organizations/${tenant.slug}/teams/${team.id}/members/${userId}`);
      await queryClient.invalidateQueries({ queryKey: keys.team(tenant.slug, team.id) });
      await queryClient.invalidateQueries({ queryKey: keys.teams(tenant.slug) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeError(err).description);
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <Dialog
      open={Boolean(team)}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setError(null);
        }
      }}
      title={team?.name ?? 'Team'}
      {...(team?.description ? { description: team.description } : {})}
      footer={
        <DialogClose asChild>
          <Button variant="secondary">Close</Button>
        </DialogClose>
      }
    >
      <div className="flex flex-col gap-5">
        {error && (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm"
          >
            {error}
          </p>
        )}

        <section>
          <p className="label-caps pb-1.5">Members</p>
          {detail.isPending ? (
            <p role="status" className="text-sm text-fg-tertiary">
              Loading
            </p>
          ) : members.length === 0 ? (
            <p className="text-sm text-fg-tertiary">Nobody is on this team yet.</p>
          ) : (
            <ul className="flex flex-col">
              {members.map((member) => (
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
                    {member.role === 'LEAD' ? 'Lead' : 'Member'}
                  </span>
                  {canManage && (
                    <RowMenu
                      label={`Actions for ${member.user.displayName}`}
                      items={[
                        {
                          label: busyUserId === member.user.id ? 'Removing…' : 'Remove from team',
                          destructive: true,
                          onSelect: () => void removeMember(member.user.id),
                        },
                      ]}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <p className="label-caps pb-1.5">Projects</p>
          {projects.length === 0 ? (
            <p className="text-sm text-fg-tertiary">This team owns no projects.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {projects.map((project) => (
                <li key={project.id} className="flex items-center gap-2 text-sm">
                  <Reference value={project.key} className="w-[72px] shrink-0" />
                  <span className="truncate-cell min-w-0 flex-1 text-fg">{project.name}</span>
                  <StatusBadge status={project.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
