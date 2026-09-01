'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Permission } from '@atlas/types';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Button, Input, Reference } from '@/components/ui/primitives';
import { DetailRow, Section, Toggle } from '@/components/ui/section';
import { ConfirmDialog } from '@/components/ui/dialog';
import { ErrorState, ForbiddenState, describeError } from '@/components/ui/states';
import { ApiError, api } from '@/lib/api';
import { keys, useOrganization, useSettings, type OrganizationSettings } from '@/lib/queries';
import { absoluteTime } from '@/lib/format';

/**
 * Organization settings.
 *
 * Four sections, each committed on its own. Grouping unrelated settings behind
 * one "Save" button is how people change a security policy while meaning to
 * rename their organization — so identity, access policy, session policy and
 * deletion each keep their own button and their own state.
 *
 * Everything here is gated server-side. The permission checks below decide
 * what to render, not what is allowed: a VIEWER who forges a request still
 * gets a 403 from the API.
 */
export default function SettingsPage() {
  const tenant = useTenant();
  const canRead = tenant.can(Permission.SETTINGS_READ);
  const organization = useOrganization(tenant.slug);
  const settings = useSettings(tenant.slug, canRead);

  if (!canRead) {
    return (
      <>
        <PageHeader title="Settings" />
        <PageBody>
          <ForbiddenState what="organization settings" />
        </PageBody>
      </>
    );
  }

  const error = organization.error ?? settings.error;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Organization identity, access policy, and deletion."
      />

      <PageBody>
        {error ? (
          <ErrorState
            error={error}
            onRetry={() => {
              void organization.refetch();
              void settings.refetch();
            }}
          />
        ) : (
          <div className="flex max-w-3xl flex-col gap-4">
            <IdentitySection />
            <AccessPolicySection settings={settings.data} loading={settings.isPending} />
            <SessionPolicySection settings={settings.data} loading={settings.isPending} />
            {tenant.can(Permission.ORGANIZATION_DELETE) && <DangerSection />}
          </div>
        )}
      </PageBody>
    </>
  );
}

function IdentitySection() {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const organization = useOrganization(tenant.slug);
  const canEdit = tenant.can(Permission.ORGANIZATION_UPDATE);

  const [name, setName] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const currentName = organization.data?.name ?? '';

  // Seeded once the server value arrives, and not on every render — otherwise
  // a background refetch would discard what someone is in the middle of typing.
  React.useEffect(() => {
    setName(currentName);
  }, [currentName]);

  const dirty = name.trim() !== currentName && name.trim().length > 0;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/organizations/${tenant.slug}`, { name: name.trim() });
      await queryClient.invalidateQueries({ queryKey: keys.organization(tenant.slug) });
      await queryClient.invalidateQueries({ queryKey: keys.organizations });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeError(err).description);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title="Identity"
      description="The name appears wherever this organization is listed. The handle is part of every URL and cannot be changed."
      footer={
        canEdit ? (
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
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="org-name" className="text-xs font-medium text-fg">
            Name
          </label>
          <Input
            id="org-name"
            value={name}
            disabled={!canEdit || organization.isPending}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
            className="max-w-sm"
          />
        </div>

        <dl>
          <DetailRow label="Handle">
            <Reference value={tenant.slug} />
          </DetailRow>
          <DetailRow label="Created">
            {organization.data ? absoluteTime(organization.data.createdAt) : '—'}
          </DetailRow>
          <DetailRow label="Members">{organization.data?.counts.members ?? '—'}</DetailRow>
        </dl>
      </div>
    </Section>
  );
}

function AccessPolicySection({
  settings,
  loading,
}: {
  settings: OrganizationSettings | undefined;
  loading: boolean;
}) {
  const tenant = useTenant();
  const canEdit = tenant.can(Permission.SETTINGS_UPDATE);
  const save = useSaveSettings();

  const [restrict, setRestrict] = React.useState(false);
  const [domains, setDomains] = React.useState('');

  React.useEffect(() => {
    if (!settings) return;
    setRestrict(settings.restrictEmailDomains);
    setDomains(settings.allowedEmailDomains.join(', '));
  }, [settings]);

  const parsed = domains
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

  const dirty =
    Boolean(settings) &&
    (restrict !== settings!.restrictEmailDomains ||
      parsed.join(',') !== settings!.allowedEmailDomains.join(','));

  return (
    <Section
      title="Access policy"
      description="Restricting domains applies to new invitations. It does not remove members who are already here."
      footer={
        canEdit ? (
          <>
            {save.error && (
              <span role="alert" className="mr-auto text-xs text-danger">
                {save.error}
              </span>
            )}
            <Button
              variant="primary"
              size="sm"
              disabled={!dirty}
              loading={save.pending}
              onClick={() =>
                void save.run({ restrictEmailDomains: restrict, allowedEmailDomains: parsed })
              }
            >
              Save policy
            </Button>
          </>
        ) : undefined
      }
    >
      <Toggle
        id="restrict-domains"
        label="Restrict invitations to specific email domains"
        description="Anyone invited must have an address at one of the domains listed below."
        checked={restrict}
        disabled={!canEdit || loading}
        onChange={setRestrict}
      />

      <div className="mt-2 flex flex-col gap-1.5">
        <label htmlFor="allowed-domains" className="text-xs font-medium text-fg">
          Allowed domains
        </label>
        <p id="allowed-domains-description" className="text-xs text-fg-tertiary">
          Comma separated, without the @ — for example{' '}
          <span className="reference">northstar.example</span>.
        </p>
        <Input
          id="allowed-domains"
          value={domains}
          aria-describedby="allowed-domains-description"
          disabled={!canEdit || !restrict || loading}
          onChange={(event) => setDomains(event.target.value)}
          className="max-w-lg"
        />
      </div>
    </Section>
  );
}

function SessionPolicySection({
  settings,
  loading,
}: {
  settings: OrganizationSettings | undefined;
  loading: boolean;
}) {
  const tenant = useTenant();
  const canEdit = tenant.can(Permission.SETTINGS_UPDATE);
  const save = useSaveSettings();

  const [idleTimeout, setIdleTimeout] = React.useState('');
  const [requireTwoFactor, setRequireTwoFactor] = React.useState(false);

  React.useEffect(() => {
    if (!settings) return;
    setIdleTimeout(
      settings.sessionIdleTimeoutMinutes === null ? '' : String(settings.sessionIdleTimeoutMinutes),
    );
    setRequireTwoFactor(settings.requireTwoFactor);
  }, [settings]);

  const parsedTimeout = idleTimeout.trim() === '' ? null : Number(idleTimeout);
  const timeoutValid =
    parsedTimeout === null ||
    (Number.isInteger(parsedTimeout) && parsedTimeout >= 5 && parsedTimeout <= 43200);

  const dirty =
    Boolean(settings) &&
    (parsedTimeout !== settings!.sessionIdleTimeoutMinutes ||
      requireTwoFactor !== settings!.requireTwoFactor);

  return (
    <Section
      title="Sessions"
      description="How long an inactive session stays valid before it has to be re-established."
      footer={
        canEdit ? (
          <>
            {save.error && (
              <span role="alert" className="mr-auto text-xs text-danger">
                {save.error}
              </span>
            )}
            <Button
              variant="primary"
              size="sm"
              disabled={!dirty || !timeoutValid}
              loading={save.pending}
              onClick={() =>
                void save.run({
                  sessionIdleTimeoutMinutes: parsedTimeout,
                  requireTwoFactor,
                })
              }
            >
              Save sessions
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="idle-timeout" className="text-xs font-medium text-fg">
          Idle timeout
        </label>
        <p id="idle-timeout-description" className="text-xs text-fg-tertiary">
          Minutes, between 5 and 43200. Leave empty for no idle timeout.
        </p>
        <Input
          id="idle-timeout"
          inputMode="numeric"
          value={idleTimeout}
          aria-describedby="idle-timeout-description"
          invalid={!timeoutValid}
          disabled={!canEdit || loading}
          onChange={(event) => setIdleTimeout(event.target.value)}
          className="max-w-[120px]"
        />
        {!timeoutValid && (
          <p role="alert" className="text-xs text-danger">
            Enter a whole number of minutes between 5 and 43200, or leave it empty.
          </p>
        )}
      </div>

      <div className="mt-2">
        <Toggle
          id="require-2fa"
          label="Require two-factor authentication"
          description="Recorded as policy. Enforcement arrives with the second-factor enrolment flow."
          checked={requireTwoFactor}
          disabled={!canEdit || loading}
          onChange={setRequireTwoFactor}
        />
      </div>
    </Section>
  );
}

function DangerSection() {
  const tenant = useTenant();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function remove(confirmSlug: string) {
    setPending(true);
    setError(null);
    try {
      await api.delete(`/organizations/${tenant.slug}`, { confirmSlug });
      // The cache is cleared rather than invalidated: every key under this
      // tenant now refers to something the user can no longer read, and
      // refetching them would produce a screenful of 404s on the way out.
      queryClient.clear();
      router.replace('/organizations');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeError(err).description);
      setPending(false);
    }
  }

  return (
    <>
      <Section
        title="Delete organization"
        description="Removes this organization and everything in it — projects, work items, teams, and the audit log. Members lose access immediately."
        className="border-danger-border"
        footer={
          <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
            Delete organization
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
        title="Delete this organization"
        description="Everything in this organization becomes inaccessible. This is not something an administrator can undo for you later."
        confirmLabel="Delete organization"
        confirmText={tenant.slug}
        confirmTextLabel="Type the organization handle to confirm"
        onConfirm={() => void remove(tenant.slug)}
        pending={pending}
        {...(error ? { error } : {})}
      />
    </>
  );
}

/** Shared save mechanics for the two settings sections that PATCH the same resource. */
function useSaveSettings() {
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function run(patch: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      await api.patch(`/organizations/${tenant.slug}/settings`, patch);
      await queryClient.invalidateQueries({ queryKey: keys.settings(tenant.slug) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : describeError(err).description);
    } finally {
      setPending(false);
    }
  }

  return { run, pending, error };
}
