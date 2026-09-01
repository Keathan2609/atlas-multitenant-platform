'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ORGANIZATION_ROLES,
  Permission,
  ROLE_DESCRIPTIONS,
  assignableRoles,
  type OrganizationRole,
} from '@atlas/types';
import { inviteMemberSchema } from '@atlas/validation';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Avatar, Button, Field, Input, Select, StatusBadge } from '@/components/ui/primitives';
import { DataTable, Pagination, Panel, PanelHeader, type Column } from '@/components/ui/table';
import { Dialog, DialogClose, ConfirmDialog } from '@/components/ui/dialog';
import { EmptyState, ErrorState, ForbiddenState, NoResultsState, describeError } from '@/components/ui/states';
import { SearchInput, SelectFilter } from '@/components/ui/filters';
import { RowMenu } from '@/components/ui/row-menu';
import { ApiError, api, applyFieldErrors } from '@/lib/api';
import { keys, useInvitations, useMembers, type InvitationRow, type MemberRow } from '@/lib/queries';
import { useListParams } from '@/lib/use-list-params';
import { relativeTime, shortDate } from '@/lib/format';

/**
 * Members, and pending invitations.
 *
 * Invitations live here rather than on their own route because a pending
 * invitation is a prospective member — the same mental model. Splitting them
 * across two nav destinations would make "who is in this organization?" a
 * two-stop question.
 *
 * Role changes and removals are never optimistic. They are security
 * operations, and showing one as applied before the server has agreed is worse
 * than a moment of latency — particularly for the rules the server enforces
 * that the client cannot fully predict, like last-owner protection.
 */
export default function MembersPage() {
  const tenant = useTenant();
  const params = useListParams({ sortBy: 'joinedAt', sortDirection: 'desc' });
  const [inviting, setInviting] = React.useState(false);

  const canInvite = tenant.can(Permission.MEMBERS_INVITE);

  const membersQuery = useMembers(tenant.slug, {
    page: params.page,
    pageSize: 25,
    search: params.search || undefined,
    role: params.get('role') || undefined,
    sortBy: params.sortBy,
    sortDirection: params.sortDirection,
  });

  // Only fetched when the caller may see it; otherwise the request would just
  // 403 and put a red box on an otherwise working page.
  const invitationsQuery = useInvitations(tenant.slug, canInvite);

  if (!tenant.can(Permission.MEMBERS_READ)) {
    return (
      <>
        <PageHeader title="Members" />
        <PageBody>
          <ForbiddenState what="members" />
        </PageBody>
      </>
    );
  }

  const pagination = membersQuery.data?.pagination;
  const filtered = Boolean(params.search || params.get('role'));
  const pending = (invitationsQuery.data?.data ?? []).filter((i) => i.status === 'PENDING');

  return (
    <>
      <PageHeader
        title="Members"
        actions={
          canInvite ? (
            <Button variant="primary" onClick={() => setInviting(true)}>
              Invite member
            </Button>
          ) : undefined
        }
      />

      <PageBody className="flex flex-col gap-4">
        {membersQuery.error ? (
          <ErrorState error={membersQuery.error} onRetry={() => void membersQuery.refetch()} />
        ) : (
          <Panel>
            <PanelHeader>
              <SearchInput
                value={params.search}
                onChange={params.setSearch}
                placeholder="Search name or email"
                label="Search members"
              />
              <SelectFilter
                label="Role"
                value={params.get('role')}
                onChange={(value) => params.set('role', value)}
                options={[...ORGANIZATION_ROLES]}
              />
              <span className="ml-auto text-xs text-fg-tertiary">
                {pagination
                  ? `${pagination.total} ${pagination.total === 1 ? 'member' : 'members'}`
                  : null}
              </span>
            </PanelHeader>

            <MembersTable
              rows={membersQuery.data?.data ?? []}
              loading={membersQuery.isFetching}
              sort={{ id: params.sortBy, direction: params.sortDirection }}
              onSortChange={params.setSort}
              empty={
                filtered ? <NoResultsState onClear={params.clear} /> : (
                  <EmptyState title="No members" description="This organization has no members." />
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

        {canInvite && (
          <section>
            <h2 className="mb-2 text-md font-semibold text-fg">Pending invitations</h2>
            {invitationsQuery.error ? (
              <ErrorState
                error={invitationsQuery.error}
                onRetry={() => void invitationsQuery.refetch()}
              />
            ) : (
              <Panel>
                <InvitationsTable rows={pending} loading={invitationsQuery.isFetching} />
              </Panel>
            )}
          </section>
        )}
      </PageBody>

      <InviteDialog open={inviting} onOpenChange={setInviting} />
    </>
  );
}

function MembersTable({
  rows,
  loading,
  sort,
  onSortChange,
  empty,
}: {
  rows: MemberRow[];
  loading: boolean;
  sort: { id: string; direction: 'asc' | 'desc' };
  onSortChange: (id: string, direction: 'asc' | 'desc') => void;
  empty: React.ReactNode;
}) {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = React.useState<MemberRow | null>(null);
  const [pending, setPending] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const canManage = tenant.can(Permission.MEMBERS_UPDATE);
  const assignable = assignableRoles(tenant.role);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['members', tenant.slug] });
    await queryClient.invalidateQueries({ queryKey: keys.organizations });
  }

  async function changeRole(member: MemberRow, role: OrganizationRole) {
    setActionError(null);
    try {
      await api.patch(`/organizations/${tenant.slug}/members/${member.userId}`, { role });
      await refresh();
    } catch (error) {
      // The server enforces rules the client cannot fully predict — last owner,
      // rank comparison — so its refusal is surfaced verbatim rather than
      // guessed at.
      setActionError(
        error instanceof ApiError ? error.message : describeError(error).description,
      );
    }
  }

  async function removeMember() {
    if (!removing) return;
    setPending(true);
    setActionError(null);
    try {
      await api.delete(`/organizations/${tenant.slug}/members/${removing.userId}`);
      await refresh();
      setRemoving(null);
    } catch (error) {
      setActionError(
        error instanceof ApiError ? error.message : describeError(error).description,
      );
    } finally {
      setPending(false);
    }
  }

  const columns: Array<Column<MemberRow>> = [
    {
      id: 'displayName',
      header: 'Member',
      sortable: true,
      render: (member) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={member.displayName} />
          <span className="min-w-0">
            <span className="truncate-cell block font-medium text-fg">{member.displayName}</span>
            <span className="truncate-cell block text-xs text-fg-tertiary">{member.email}</span>
          </span>
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      sortable: true,
      width: 'w-[168px]',
      render: (member) => {
        const isSelf = member.userId === tenant.user.id;
        // A role the caller cannot assign is shown as text, not a disabled
        // control that invites a click which will never work.
        const editable = canManage && !isSelf && assignable.includes(member.role);

        return editable ? (
          <Select
            aria-label={`Role for ${member.displayName}`}
            value={member.role}
            onChange={(event) => void changeRole(member, event.target.value as OrganizationRole)}
            onClick={(event) => event.stopPropagation()}
            className="h-7 w-auto text-xs"
          >
            {assignable.map((role) => (
              <option key={role} value={role}>
                {role.charAt(0) + role.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-fg-secondary">
              {member.role.charAt(0) + member.role.slice(1).toLowerCase()}
            </span>
            {isSelf && <span className="text-2xs text-fg-tertiary">(you)</span>}
          </span>
        );
      },
    },
    {
      id: 'joinedAt',
      header: 'Joined',
      sortable: true,
      width: 'w-[120px]',
      hideBelow: 'md',
      render: (member) => (
        <time
          dateTime={member.joinedAt}
          title={new Date(member.joinedAt).toLocaleString()}
          className="whitespace-nowrap text-fg-tertiary"
        >
          {relativeTime(member.joinedAt)}
        </time>
      ),
    },
    {
      id: 'lastLoginAt',
      header: 'Last seen',
      width: 'w-[120px]',
      hideBelow: 'lg',
      render: (member) =>
        member.lastLoginAt ? (
          <time dateTime={member.lastLoginAt} className="whitespace-nowrap text-fg-tertiary">
            {relativeTime(member.lastLoginAt)}
          </time>
        ) : (
          <span className="text-fg-tertiary">Never</span>
        ),
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[52px]',
      align: 'right',
      render: (member) => {
        const isSelf = member.userId === tenant.user.id;
        const canRemove = isSelf || (tenant.can(Permission.MEMBERS_REMOVE) && assignable.includes(member.role));
        if (!canRemove) return null;

        return (
          <RowMenu
            label={`Actions for ${member.displayName}`}
            items={[
              {
                label: isSelf ? 'Leave organization' : 'Remove from organization',
                destructive: true,
                onSelect: () => setRemoving(member),
              },
            ]}
          />
        );
      },
    },
  ];

  return (
    <>
      {actionError && (
        <p
          role="alert"
          className="border-b border-danger-border bg-danger-subtle px-4 py-2 text-sm text-fg"
        >
          {actionError}
        </p>
      )}

      <DataTable
        caption="Organization members"
        columns={columns}
        rows={rows}
        rowKey={(member) => member.membershipId}
        loading={loading}
        sort={sort}
        onSortChange={onSortChange}
        empty={empty}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            setActionError(null);
          }
        }}
        title={
          removing?.userId === tenant.user.id ? 'Leave organization' : 'Remove member'
        }
        description={
          removing?.userId === tenant.user.id
            ? `You will lose access to ${tenant.organization.name} immediately. An owner or admin would need to invite you back.`
            : `${removing?.displayName ?? 'This person'} will lose access to ${tenant.organization.name} immediately. Work they filed or were assigned is kept.`
        }
        confirmLabel={removing?.userId === tenant.user.id ? 'Leave' : 'Remove'}
        onConfirm={() => void removeMember()}
        pending={pending}
        {...(actionError ? { error: actionError } : {})}
      />
    </>
  );
}

function InvitationsTable({ rows, loading }: { rows: InvitationRow[]; loading: boolean }) {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = React.useState<InvitationRow | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function revoke() {
    if (!revoking) return;
    setPending(true);
    try {
      await api.delete(`/organizations/${tenant.slug}/invitations/${revoking.id}`);
      await queryClient.invalidateQueries({ queryKey: keys.invitations(tenant.slug) });
      setRevoking(null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeError(err).description);
    } finally {
      setPending(false);
    }
  }

  const columns: Array<Column<InvitationRow>> = [
    {
      id: 'email',
      header: 'Email',
      render: (invitation) => (
        <span className="truncate-cell block text-fg">{invitation.email}</span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      width: 'w-[112px]',
      render: (invitation) => (
        <span className="text-fg-secondary">
          {invitation.role.charAt(0) + invitation.role.slice(1).toLowerCase()}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      width: 'w-[104px]',
      render: (invitation) => <StatusBadge status={invitation.status} />,
    },
    {
      id: 'expiresAt',
      header: 'Expires',
      width: 'w-[128px]',
      hideBelow: 'sm',
      render: (invitation) => (
        <time dateTime={invitation.expiresAt} className="whitespace-nowrap text-fg-tertiary">
          {shortDate(invitation.expiresAt)}
        </time>
      ),
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[52px]',
      align: 'right',
      render: (invitation) => (
        <RowMenu
          label={`Actions for the invitation to ${invitation.email}`}
          items={[
            { label: 'Revoke invitation', destructive: true, onSelect: () => setRevoking(invitation) },
          ]}
        />
      ),
    },
  ];

  return (
    <>
      <DataTable
        caption="Pending invitations"
        columns={columns}
        rows={rows}
        rowKey={(invitation) => invitation.id}
        loading={loading}
        empty={
          <EmptyState
            title="No pending invitations"
            description="People you invite will appear here until they accept."
            size="compact"
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
        title="Revoke invitation"
        description={`The link sent to ${revoking?.email ?? 'this address'} will stop working immediately.`}
        confirmLabel="Revoke"
        onConfirm={() => void revoke()}
        pending={pending}
        {...(error ? { error } : {})}
      />
    </>
  );
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const assignable = assignableRoles(tenant.role);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<{ email: string; role: OrganizationRole }>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: '', role: 'MEMBER' },
  });

  React.useEffect(() => {
    if (open) {
      reset({ email: '', role: 'MEMBER' });
      setFormError(null);
    }
  }, [open, reset]);

  const selectedRole = watch('role');

  async function onSubmit(values: { email: string; role: OrganizationRole }) {
    setFormError(null);
    try {
      await api.post(`/organizations/${tenant.slug}/invitations`, values);
      await queryClient.invalidateQueries({ queryKey: keys.invitations(tenant.slug) });
      onOpenChange(false);
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
      title="Invite member"
      description="They receive a link that expires in seven days."
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={isSubmitting}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="primary" loading={isSubmitting} onClick={(event) => void handleSubmit(onSubmit)(event)}>
            Send invitation
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

        <Field label="Email" htmlFor="invite-email" error={errors.email?.message} required>
          <Input type="email" autoFocus invalid={Boolean(errors.email)} {...register('email')} />
        </Field>

        <Field
          label="Role"
          htmlFor="invite-role"
          // The description updates with the selection, so the consequence of
          // the choice is visible at the moment it is made rather than in a
          // help page.
          description={ROLE_DESCRIPTIONS[selectedRole]}
          error={errors.role?.message}
          required
        >
          <Select {...register('role')}>
            {assignable.map((role) => (
              <option key={role} value={role}>
                {role.charAt(0) + role.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
