'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Permission } from '@atlas/types';
import { createWorkspaceSchema } from '@atlas/validation';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Button, Field, Input, Reference, Textarea } from '@/components/ui/primitives';
import { DataTable, Panel, type Column } from '@/components/ui/table';
import { Dialog, DialogClose, ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorState, ForbiddenState, describeError } from '@/components/ui/states';
import { RowMenu } from '@/components/ui/row-menu';
import { ApiError, api, applyFieldErrors } from '@/lib/api';
import { keys, useWorkspaces, type WorkspaceRow } from '@/lib/queries';
import { relativeTime } from '@/lib/format';

interface WorkspaceFormValues {
  name: string;
  slug?: string;
  description?: string;
}

/**
 * Workspaces.
 *
 * A thin surface on purpose — a workspace is a container for projects, and
 * most organizations have one or two. The screen exists so the default is
 * visible and a second can be created, not to be somewhere people spend time.
 */
export default function WorkspacesPage() {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<WorkspaceRow | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const query = useWorkspaces(tenant.slug);

  if (!tenant.can(Permission.WORKSPACES_READ)) {
    return (
      <>
        <PageHeader title="Workspaces" />
        <PageBody>
          <ForbiddenState what="workspaces" />
        </PageBody>
      </>
    );
  }

  async function remove() {
    if (!deleting) return;
    setPending(true);
    try {
      await api.delete(`/organizations/${tenant.slug}/workspaces/${deleting.id}`);
      await queryClient.invalidateQueries({ queryKey: keys.workspaces(tenant.slug) });
      setDeleting(null);
      setError(null);
    } catch (err) {
      // The server refuses a default or non-empty workspace with a specific
      // message; showing it verbatim explains the refusal better than a
      // generic failure would.
      setError(err instanceof ApiError ? err.message : describeError(err).description);
    } finally {
      setPending(false);
    }
  }

  const columns: Array<Column<WorkspaceRow>> = [
    {
      id: 'slug',
      header: 'Handle',
      width: 'w-[176px]',
      // On a phone the name is what identifies a workspace; a fixed 176px of
      // slug would leave the name about eighty pixels and push the rest of the
      // row into a horizontal scroll.
      hideBelow: 'sm',
      render: (workspace) => <Reference value={workspace.slug} />,
    },
    {
      id: 'name',
      header: 'Workspace',
      render: (workspace) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate-cell font-medium text-fg">{workspace.name}</span>
            {workspace.isDefault && (
              <span className="shrink-0 rounded-sm border border-border bg-surface-sunken px-1.5 py-px text-2xs text-fg-tertiary">
                Default
              </span>
            )}
          </div>
          {workspace.description && (
            <div className="truncate-cell text-xs text-fg-tertiary">{workspace.description}</div>
          )}
        </div>
      ),
    },
    {
      id: 'projectCount',
      header: 'Projects',
      align: 'right',
      width: 'w-[88px]',
      render: (workspace) => <span className="text-fg-secondary">{workspace.projectCount}</span>,
    },
    {
      id: 'createdAt',
      header: 'Created',
      align: 'right',
      width: 'w-[112px]',
      hideBelow: 'md',
      render: (workspace) => (
        <time
          dateTime={workspace.createdAt}
          title={new Date(workspace.createdAt).toLocaleString()}
          className="whitespace-nowrap text-fg-tertiary"
        >
          {relativeTime(workspace.createdAt)}
        </time>
      ),
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[52px]',
      align: 'right',
      render: (workspace) => {
        // The default workspace and any workspace holding projects cannot be
        // deleted. Offering a menu item that always fails would be worse than
        // offering none.
        if (!tenant.can(Permission.WORKSPACES_DELETE)) return null;
        if (workspace.isDefault || workspace.projectCount > 0) return null;
        return (
          <RowMenu
            label={`Actions for ${workspace.name}`}
            items={[
              { label: 'Delete workspace', destructive: true, onSelect: () => setDeleting(workspace) },
            ]}
          />
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Workspaces"
        description="Workspaces group projects. Every organization has one default."
        actions={
          tenant.can(Permission.WORKSPACES_CREATE) ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New workspace
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
              caption="Workspaces in this organization"
              columns={columns}
              rows={query.data?.data ?? []}
              rowKey={(workspace) => workspace.id}
              loading={query.isFetching}
              empty={<EmptyState title="No workspaces" description="Every organization has at least one." />}
            />
          </Panel>
        )}
      </PageBody>

      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setError(null);
          }
        }}
        title="Delete workspace"
        description={`${deleting?.name ?? 'This workspace'} will be removed. It holds no projects, so nothing else is affected.`}
        confirmLabel="Delete workspace"
        onConfirm={() => void remove()}
        pending={pending}
        {...(error ? { error } : {})}
      />
    </>
  );
}

function CreateWorkspaceDialog({
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
  } = useForm<WorkspaceFormValues>({ resolver: zodResolver(createWorkspaceSchema) });

  React.useEffect(() => {
    if (open) {
      reset({ name: '', description: '' });
      setFormError(null);
    }
  }, [open, reset]);

  async function onSubmit(values: WorkspaceFormValues) {
    setFormError(null);
    try {
      await api.post(`/organizations/${tenant.slug}/workspaces`, values);
      await queryClient.invalidateQueries({ queryKey: keys.workspaces(tenant.slug) });
      onOpenChange(false);
    } catch (error) {
      if (!applyFieldErrors(error, setError as never)) {
        setFormError(describeError(error).description);
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New workspace"
      description="A separate container for projects."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="primary" loading={isSubmitting} onClick={(event) => void handleSubmit(onSubmit)(event)}>
            Create workspace
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

        <Field label="Name" htmlFor="workspace-name" error={errors.name?.message} required>
          <Input autoFocus invalid={Boolean(errors.name)} {...register('name')} />
        </Field>

        <Field
          label="Description"
          htmlFor="workspace-description"
          error={errors.description?.message}
        >
          <Textarea rows={3} {...register('description')} />
        </Field>
      </form>
    </Dialog>
  );
}
