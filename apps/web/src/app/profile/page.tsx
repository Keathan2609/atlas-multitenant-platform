'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordSchema } from '@atlas/validation';
import { Avatar, Button, Field, Input, Reference } from '@/components/ui/primitives';
import { DetailRow, Section } from '@/components/ui/section';
import { DataTable, Panel, type Column } from '@/components/ui/table';
import { ErrorState, PageLoading, describeError } from '@/components/ui/states';
import { ApiError, api, applyFieldErrors } from '@/lib/api';
import {
  keys,
  useCurrentUser,
  useOrganizations,
  useSessions,
  type SessionRow,
} from '@/lib/queries';
import { absoluteTime, relativeTime } from '@/lib/format';

interface PasswordFormValues {
  currentPassword: string;
  newPassword: string;
}

/**
 * Profile.
 *
 * Deliberately outside the tenant shell: an account is not owned by an
 * organization, and reaching your own password through a particular tenant's
 * sidebar would imply otherwise. The organizations you belong to are listed
 * here as the way back in.
 */
export default function ProfilePage() {
  const user = useCurrentUser();

  if (user.isPending) return <PageLoading label="Loading your profile" />;

  if (user.error) {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-10">
        <ErrorState error={user.error} onRetry={() => void user.refetch()} />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-10">
      <header className="mb-6 flex items-center gap-3">
        <Avatar name={user.data?.user.displayName ?? ''} />
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold leading-tight text-fg">
            {user.data?.user.displayName}
          </h1>
          <p className="truncate text-xs text-fg-tertiary">{user.data?.user.email}</p>
        </div>
        <BackLink />
      </header>

      <div className="flex flex-col gap-4">
        <IdentitySection />
        <OrganizationsSection />
        <PasswordSection />
        <SessionsSection />
      </div>
    </main>
  );
}

/**
 * A way back to the product.
 *
 * Points at the first organization the account belongs to, because that is
 * where "back" means something; with none, the picker handles the empty case.
 */
function BackLink() {
  const organizations = useOrganizations();
  const first = organizations.data?.data[0];
  const href = first ? `/app/${first.slug}` : '/organizations';

  return (
    <Link
      href={href}
      className="ml-auto shrink-0 rounded-sm text-xs text-accent hover:underline
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                 focus-visible:outline-accent"
    >
      Back to ATLAS
    </Link>
  );
}

function IdentitySection() {
  const user = useCurrentUser();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const currentName = user.data?.user.displayName ?? '';

  React.useEffect(() => {
    setDisplayName(currentName);
  }, [currentName]);

  const dirty = displayName.trim() !== currentName && displayName.trim().length > 0;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch('/auth/me', { displayName: displayName.trim() });
      await queryClient.invalidateQueries({ queryKey: keys.me });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeError(err).description);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Your details"
      description="Your display name is what colleagues see on work items, teams, and the audit log."
      footer={
        <>
          {saved && !dirty && (
            <span role="status" className="mr-auto text-xs text-fg-tertiary">
              Saved
            </span>
          )}
          {error && (
            <span role="alert" className="mr-auto text-xs text-danger">
              {error}
            </span>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty}
            loading={saving}
            onClick={() => void save()}
          >
            Save name
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="display-name" className="text-xs font-medium text-fg">
            Display name
          </label>
          <Input
            id="display-name"
            value={displayName}
            autoComplete="name"
            onChange={(event) => {
              setDisplayName(event.target.value);
              setSaved(false);
            }}
            className="max-w-sm"
          />
        </div>

        <dl>
          <DetailRow label="Email">
            {/* Not editable here: changing it is an identity change that needs
                the new address verified, which is a flow of its own. */}
            <span className="text-fg-secondary">{user.data?.user.email}</span>
          </DetailRow>
        </dl>
      </div>
    </Section>
  );
}

function OrganizationsSection() {
  const organizations = useOrganizations();
  const rows = organizations.data?.data ?? [];

  return (
    <Section
      title="Organizations"
      description="Your role is set by each organization's owners, not here."
    >
      {rows.length === 0 ? (
        <p className="text-sm text-fg-tertiary">
          You do not belong to any organization yet.{' '}
          <Link href="/onboarding" className="text-accent hover:underline">
            Create one
          </Link>
          .
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((organization) => (
            <li
              key={organization.id}
              className="flex items-center gap-3 border-b border-border-subtle py-2 last:border-b-0"
            >
              <Link
                href={`/app/${organization.slug}`}
                className="min-w-0 flex-1 rounded-sm text-sm font-medium text-fg hover:text-accent
                           hover:underline focus-visible:outline focus-visible:outline-2
                           focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="truncate-cell block">{organization.name}</span>
              </Link>
              <Reference value={organization.slug} />
              <span className="w-[64px] shrink-0 text-right text-xs text-fg-tertiary">
                {organization.role.charAt(0) + organization.role.slice(1).toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function PasswordSection() {
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PasswordFormValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  });

  async function onSubmit(values: PasswordFormValues) {
    setFormError(null);
    setResult(null);
    try {
      const { revokedSessions } = await api.post<{ revokedSessions: number }>(
        '/auth/change-password',
        values,
      );
      reset({ currentPassword: '', newPassword: '' });
      await queryClient.invalidateQueries({ queryKey: keys.sessions });
      setResult(
        revokedSessions === 0
          ? 'Password changed.'
          : `Password changed. ${revokedSessions} other ${
              revokedSessions === 1 ? 'session was' : 'sessions were'
            } signed out.`,
      );
    } catch (err) {
      if (!applyFieldErrors(err, setError as never)) {
        setFormError(err instanceof ApiError ? err.message : describeError(err).description);
      }
    }
  }

  return (
    <Section
      title="Password"
      description="Changing your password signs out every other session, which is what makes it useful if you think someone else has access."
      footer={
        <>
          {result && (
            <span role="status" className="mr-auto text-xs text-fg-tertiary">
              {result}
            </span>
          )}
          <Button
            variant="primary"
            size="sm"
            loading={isSubmitting}
            onClick={(event) => void handleSubmit(onSubmit)(event)}
          >
            Change password
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        noValidate
        className="flex max-w-sm flex-col gap-3"
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
          label="Current password"
          htmlFor="current-password"
          error={errors.currentPassword?.message}
          required
        >
          <Input
            type="password"
            autoComplete="current-password"
            invalid={Boolean(errors.currentPassword)}
            {...register('currentPassword')}
          />
        </Field>

        <Field
          label="New password"
          htmlFor="new-password"
          description="At least 12 characters."
          error={errors.newPassword?.message}
          required
        >
          <Input
            type="password"
            autoComplete="new-password"
            invalid={Boolean(errors.newPassword)}
            {...register('newPassword')}
          />
        </Field>
      </form>
    </Section>
  );
}

function SessionsSection() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = React.useState(false);

  const sessions = useSessions();

  const columns: Array<Column<SessionRow>> = [
    {
      id: 'device',
      header: 'Device',
      render: (session) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate-cell text-fg">{describeAgent(session.userAgent)}</span>
            {session.current && (
              <span className="shrink-0 rounded-sm border border-border bg-surface-sunken px-1.5 py-px text-2xs text-fg-tertiary">
                This device
              </span>
            )}
          </div>
          {session.ipAddress && <Reference value={session.ipAddress} />}
        </div>
      ),
    },
    {
      id: 'lastSeenAt',
      header: 'Last active',
      align: 'right',
      width: 'w-[112px]',
      render: (session) => (
        <time
          dateTime={session.lastSeenAt}
          title={absoluteTime(session.lastSeenAt)}
          className="whitespace-nowrap text-fg-tertiary"
        >
          {relativeTime(session.lastSeenAt)}
        </time>
      ),
    },
    {
      id: 'expiresAt',
      header: 'Expires',
      align: 'right',
      width: 'w-[112px]',
      hideBelow: 'sm',
      render: (session) => (
        <time
          dateTime={session.expiresAt}
          title={absoluteTime(session.expiresAt)}
          className="whitespace-nowrap text-fg-tertiary"
        >
          {relativeTime(session.expiresAt)}
        </time>
      ),
    },
  ];

  async function signOut() {
    setSigningOut(true);
    try {
      await api.post('/auth/logout');
    } finally {
      queryClient.clear();
      router.replace('/sign-in');
    }
  }

  return (
    <Section
      title="Active sessions"
      description="Every place this account is currently signed in."
      footer={
        <Button variant="secondary" size="sm" loading={signingOut} onClick={() => void signOut()}>
          Sign out of this device
        </Button>
      }
    >
      {sessions.error ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : (
        <Panel>
          <DataTable
            caption="Sessions currently signed in to this account"
            columns={columns}
            rows={sessions.data?.data ?? []}
            rowKey={(session) => session.id}
            loading={sessions.isFetching}
          />
        </Panel>
      )}
    </Section>
  );
}

/**
 * Turns a user-agent string into something a person can recognise.
 *
 * Not a browser-detection library — the value is only ever used to help
 * someone spot a session that is not theirs, and getting "Chrome on Windows"
 * from the common cases is enough for that.
 */
function describeAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  const browser = /\bEdg\//.test(userAgent)
    ? 'Edge'
    : /\bOPR\//.test(userAgent)
      ? 'Opera'
      : /\bFirefox\//.test(userAgent)
        ? 'Firefox'
        : /\bChrome\//.test(userAgent)
          ? 'Chrome'
          : /\bSafari\//.test(userAgent)
            ? 'Safari'
            : 'Unknown browser';

  const platform = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /(iPhone|iPad|iPod)/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;

  return platform ? `${browser} on ${platform}` : browser;
}
