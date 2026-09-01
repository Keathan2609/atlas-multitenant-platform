'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Permission } from '@atlas/types';
import { createApiKeySchema } from '@atlas/validation';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Button, Field, Input, Reference, Select, StatusBadge } from '@/components/ui/primitives';
import { DataTable, Panel, type Column } from '@/components/ui/table';
import { Dialog, DialogClose, ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorState, ForbiddenState, describeError } from '@/components/ui/states';
import { RowMenu } from '@/components/ui/row-menu';
import { ApiError, api, applyFieldErrors } from '@/lib/api';
import { keys, useApiKeys, type ApiKeyRow } from '@/lib/queries';
import { relativeTime, shortDate } from '@/lib/format';

interface CreateKeyValues {
  name: string;
  expiresInDays?: number | null;
}

export default function ApiKeysPage() {
  const tenant = useTenant();
  const [creating, setCreating] = React.useState(false);
  const [revealed, setRevealed] = React.useState<{ name: string; key: string } | null>(null);

  const canRead = tenant.can(Permission.APIKEYS_READ);
  const query = useApiKeys(tenant.slug, canRead);

  if (!canRead) {
    return (
      <>
        <PageHeader title="API keys" />
        <PageBody>
          <ForbiddenState what="API keys" />
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="API keys"
        description="Keys authenticate machine access to this organization. They act with read-only permission."
        actions={
          tenant.can(Permission.APIKEYS_CREATE) ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create key
            </Button>
          ) : undefined
        }
      />

      <PageBody>
        {query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          <Panel>
            <KeysTable
              rows={query.data?.data ?? []}
              loading={query.isFetching}
              onCreate={() => setCreating(true)}
            />
          </Panel>
        )}
      </PageBody>

      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(name, key) => setRevealed({ name, key })}
      />

      <RevealKeyDialog revealed={revealed} onClose={() => setRevealed(null)} />
    </>
  );
}

function KeysTable({
  rows,
  loading,
  onCreate,
}: {
  rows: ApiKeyRow[];
  loading: boolean;
  onCreate: () => void;
}) {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = React.useState<ApiKeyRow | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function revoke() {
    if (!revoking) return;
    setPending(true);
    try {
      await api.delete(`/organizations/${tenant.slug}/api-keys/${revoking.id}`);
      await queryClient.invalidateQueries({ queryKey: keys.apiKeys(tenant.slug) });
      setRevoking(null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeError(err).description);
    } finally {
      setPending(false);
    }
  }

  const columns: Array<Column<ApiKeyRow>> = [
    {
      id: 'name',
      header: 'Name',
      render: (key) => <span className="truncate-cell block font-medium text-fg">{key.name}</span>,
    },
    {
      id: 'keyPrefix',
      header: 'Key',
      width: 'w-[168px]',
      // The prefix is all that is ever shown after creation — nothing stores
      // the secret. It is enough to recognise which key a row refers to.
      render: (key) => <Reference value={`${key.keyPrefix}…`} />,
    },
    {
      id: 'status',
      header: 'Status',
      width: 'w-[104px]',
      render: (key) => <StatusBadge status={key.status} />,
    },
    {
      id: 'lastUsedAt',
      header: 'Last used',
      width: 'w-[120px]',
      hideBelow: 'sm',
      render: (key) =>
        key.lastUsedAt ? (
          <time
            dateTime={key.lastUsedAt}
            title={new Date(key.lastUsedAt).toLocaleString()}
            className="whitespace-nowrap text-fg-tertiary"
          >
            {relativeTime(key.lastUsedAt)}
          </time>
        ) : (
          <span className="text-fg-tertiary">Never</span>
        ),
    },
    {
      id: 'expiresAt',
      header: 'Expires',
      width: 'w-[120px]',
      hideBelow: 'md',
      render: (key) =>
        key.expiresAt ? (
          <time dateTime={key.expiresAt} className="whitespace-nowrap text-fg-tertiary">
            {shortDate(key.expiresAt)}
          </time>
        ) : (
          <span className="text-fg-tertiary">Never</span>
        ),
    },
    {
      id: 'createdBy',
      header: 'Created by',
      width: 'w-[136px]',
      hideBelow: 'lg',
      render: (key) => (
        <span className="truncate-cell block text-fg-secondary">
          {key.createdBy?.displayName ?? '—'}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[52px]',
      align: 'right',
      render: (key) =>
        key.status === 'ACTIVE' && tenant.can(Permission.APIKEYS_REVOKE) ? (
          <RowMenu
            label={`Actions for ${key.name}`}
            items={[{ label: 'Revoke key', destructive: true, onSelect: () => setRevoking(key) }]}
          />
        ) : null,
    },
  ];

  return (
    <>
      <DataTable
        caption="API keys for this organization"
        columns={columns}
        rows={rows}
        rowKey={(key) => key.id}
        loading={loading}
        empty={
          <EmptyState
            title="No API keys"
            description="Create a key to let a script or service read this organization's data."
            action={
              tenant.can(Permission.APIKEYS_CREATE) ? (
                <Button size="sm" variant="primary" onClick={onCreate}>
                  Create key
                </Button>
              ) : undefined
            }
          />
        }
      />

      <ConfirmDialog
        open={Boolean(revoking)}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
            setError(null);
          }
        }}
        title="Revoke API key"
        description={`Anything using ${revoking?.name ?? 'this key'} will stop working immediately. Revoking cannot be undone — issue a new key instead.`}
        confirmLabel="Revoke key"
        confirmText={revoking?.name}
        confirmTextLabel="Type the key name to confirm"
        onConfirm={() => void revoke()}
        pending={pending}
        {...(error ? { error } : {})}
      />
    </>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (name: string, key: string) => void;
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
  } = useForm<CreateKeyValues>({
    resolver: zodResolver(createApiKeySchema),
    defaultValues: { name: '', expiresInDays: 90 },
  });

  React.useEffect(() => {
    if (open) {
      reset({ name: '', expiresInDays: 90 });
      setFormError(null);
    }
  }, [open, reset]);

  async function onSubmit(values: CreateKeyValues) {
    setFormError(null);
    try {
      const created = await api.post<{ name: string; key: string }>(
        `/organizations/${tenant.slug}/api-keys`,
        {
          name: values.name,
          expiresInDays: values.expiresInDays ? Number(values.expiresInDays) : null,
        },
      );
      await queryClient.invalidateQueries({ queryKey: keys.apiKeys(tenant.slug) });
      onOpenChange(false);
      onCreated(created.name, created.key);
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
      title="Create API key"
      description="The key is shown once, immediately after creation, and never again."
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
          >
            Create key
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        noValidate
        className="flex flex-col gap-4"
      >
        {formError && (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-subtle px-3 py-2 text-sm"
          >
            {formError}
          </p>
        )}

        <Field
          label="Name"
          htmlFor="key-name"
          description="What this key is for, so it can be recognised later."
          error={errors.name?.message}
          required
        >
          <Input
            autoFocus
            placeholder="CI deploy"
            invalid={Boolean(errors.name)}
            {...register('name')}
          />
        </Field>

        <Field
          label="Expires"
          htmlFor="key-expiry"
          description="A key without an expiry is a permanent credential."
          error={errors.expiresInDays?.message}
        >
          <Select {...register('expiresInDays')}>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In a year</option>
            <option value="">Never</option>
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}

/**
 * The one time the secret is visible.
 *
 * Nothing stores it, so if the dialog is dismissed the key cannot be
 * recovered — the copy says so plainly rather than leaving someone to discover
 * it. Closing requires an explicit acknowledgement for the same reason.
 */
function RevealKeyDialog({
  revealed,
  onClose,
}: {
  revealed: { name: string; key: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (revealed) setCopied(false);
  }, [revealed]);

  return (
    <Dialog
      open={Boolean(revealed)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Copy your API key"
      description="This is the only time it is shown. Store it somewhere safe before closing — it cannot be retrieved later."
      footer={
        <Button variant="primary" onClick={onClose}>
          I have stored it
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md border border-border bg-surface-sunken p-3">
          <p className="reference break-all text-fg">{revealed?.key}</p>
        </div>

        <Button
          variant="secondary"
          onClick={() => {
            if (!revealed) return;
            void navigator.clipboard.writeText(revealed.key).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied to clipboard' : 'Copy key'}
        </Button>
      </div>
    </Dialog>
  );
}
