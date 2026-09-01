'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Permission, can, type OrganizationRole } from '@atlas/types';
import { api } from '@/lib/api';
import {
  useCurrentUser,
  useOrganizations,
  type CurrentUser,
  type OrganizationSummary,
} from '@/lib/queries';
import { Avatar, Button, cx } from './ui/primitives';

/**
 * The application shell.
 *
 * A 216px sidebar and a 48px header. Both are deliberately small: every pixel
 * of chrome is a pixel not showing work, and this is a tool people keep open
 * all day.
 *
 * The sidebar carries no icons. That is a decision, not an omission — a glyph
 * beside "Members" adds nothing a literate reader needs, and a column of
 * decorative icons is one of the clearest tells of a generated interface.
 * Words are unambiguous and cost less vertical space.
 *
 * Navigation is filtered by permission, but only for presentation. Every route
 * behind these links is enforced server-side; hiding a link is a courtesy so
 * people are not offered doors that will not open.
 */

interface NavItem {
  label: string;
  href: string;
  /** Omitted where every member can see the destination. */
  permission?: Permission;
  /** Matches nested routes, e.g. a project detail under /projects. */
  prefix?: boolean;
}

function navigation(slug: string): Array<{ group: string | null; items: NavItem[] }> {
  const base = `/app/${slug}`;
  return [
    {
      group: null,
      items: [
        { label: 'Overview', href: base },
        {
          label: 'Projects',
          href: `${base}/projects`,
          prefix: true,
          permission: Permission.PROJECTS_READ,
        },
        {
          label: 'Work items',
          href: `${base}/work-items`,
          prefix: true,
          permission: Permission.WORKITEMS_READ,
        },
        { label: 'Teams', href: `${base}/teams`, prefix: true, permission: Permission.TEAMS_READ },
        // Structural rather than daily, but it is where projects come from, so
        // it sits with the work rather than with the administrative group.
        { label: 'Workspaces', href: `${base}/workspaces`, permission: Permission.WORKSPACES_READ },
        { label: 'Members', href: `${base}/members`, permission: Permission.MEMBERS_READ },
      ],
    },
    {
      group: 'Organization',
      items: [
        { label: 'Activity', href: `${base}/activity`, permission: Permission.AUDIT_READ },
        { label: 'API keys', href: `${base}/api-keys`, permission: Permission.APIKEYS_READ },
        {
          label: 'Settings',
          href: `${base}/settings`,
          prefix: true,
          permission: Permission.SETTINGS_READ,
        },
      ],
    },
  ];
}

export interface TenantContextValue {
  slug: string;
  organization: OrganizationSummary;
  role: OrganizationRole;
  user: CurrentUser;
  /** Presentation only — the server decides. */
  can: (permission: Permission) => boolean;
}

const TenantContext = React.createContext<TenantContextValue | null>(null);

/**
 * Reads the current tenant.
 *
 * Throws outside the shell rather than returning undefined, so a component
 * that assumes a tenant fails immediately and visibly instead of rendering
 * blank.
 */
export function useTenant(): TenantContextValue {
  const value = React.useContext(TenantContext);
  if (!value) throw new Error('useTenant must be used inside the application shell.');
  return value;
}

export function AppShell({ slug, children }: { slug: string; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  const userQuery = useCurrentUser();
  const orgsQuery = useOrganizations();

  // Close the mobile drawer on navigation; leaving it open over the new page
  // is a classic small-screen bug.
  React.useEffect(() => setMobileNavOpen(false), [pathname]);

  React.useEffect(() => {
    if (userQuery.error) router.replace('/sign-in');
  }, [userQuery.error, router]);

  const organization = orgsQuery.data?.data.find((org) => org.slug === slug);

  if (userQuery.isPending || orgsQuery.isPending) {
    return <ShellSkeleton />;
  }

  if (!userQuery.data) return null;

  // A slug the user is not a member of. Same treatment as one that does not
  // exist, mirroring the API, which deliberately does not distinguish them.
  if (!organization) {
    return (
      <UnknownOrganization organizations={orgsQuery.data?.data ?? []} user={userQuery.data.user} />
    );
  }

  const context: TenantContextValue = {
    slug,
    organization,
    role: organization.role,
    user: userQuery.data.user,
    can: (permission) => can(organization.role, permission),
  };

  return (
    <TenantContext.Provider value={context}>
      <div className="flex min-h-dvh bg-canvas">
        {/* Skip link: the first tab stop on every page, so keyboard users are
            not forced through the whole sidebar to reach content. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50
                     focus:rounded-md focus:border focus:border-border-strong
                     focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>

        <Sidebar
          slug={slug}
          organization={organization}
          organizations={orgsQuery.data?.data ?? []}
          user={userQuery.data.user}
          role={organization.role}
          open={mobileNavOpen}
          onClose={() => setMobileNavOpen(false)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <MobileBar organization={organization} onOpenNav={() => setMobileNavOpen(true)} />
          <main id="main" className="min-w-0 flex-1">
            {children}
          </main>
        </div>
      </div>
    </TenantContext.Provider>
  );
}

function Sidebar({
  slug,
  organization,
  organizations,
  user,
  role,
  open,
  onClose,
}: {
  slug: string;
  organization: OrganizationSummary;
  organizations: OrganizationSummary[];
  user: CurrentUser;
  role: OrganizationRole;
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const groups = navigation(slug);

  return (
    <>
      {/* Scrim, mobile only. */}
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
        />
      )}

      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-sidebar shrink-0 flex-col',
          'border-r border-border bg-surface',
          'transition-[transform,visibility] duration-150 motion-reduce:transition-none',
          'lg:static lg:translate-x-0 lg:visible',
          // Visibility, not just translation. A drawer parked off-screen with
          // `translate` alone keeps every link in the tab order, so a keyboard
          // user on a phone tabs into navigation they cannot see and loses
          // track of focus entirely. `visibility: hidden` takes the subtree out
          // of the tab order and the accessibility tree, and still animates.
          open ? 'visible translate-x-0' : 'invisible -translate-x-full',
        )}
      >
        <OrganizationSwitcher current={organization} organizations={organizations} />

        <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-2">
          {groups.map((group, index) => {
            const visible = group.items.filter(
              (item) => !item.permission || can(role, item.permission),
            );
            if (visible.length === 0) return null;

            return (
              <div key={group.group ?? 'primary'} className={cx(index > 0 && 'mt-4')}>
                {group.group && <p className="label-caps px-2 pb-1.5 pt-1">{group.group}</p>}
                <ul className="flex flex-col gap-px">
                  {visible.map((item) => {
                    const active = item.prefix
                      ? pathname.startsWith(item.href)
                      : pathname === item.href;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          className={cx(
                            'flex h-7 items-center rounded-md px-2 text-sm',
                            'transition-colors duration-100',
                            active
                              ? 'bg-accent-subtle font-medium text-accent'
                              : 'text-fg-secondary hover:bg-surface-hover hover:text-fg',
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        <UserMenu user={user} role={role} />
      </aside>
    </>
  );
}

/**
 * Organization switcher.
 *
 * Switching navigates to the other tenant's slug route. There is no
 * client-side "current organization" to keep in sync — the URL is the tenant,
 * exactly as the API sees it, so a bookmarked link always lands in the right
 * place and a stale cache cannot show one tenant's data under another's name.
 */
function OrganizationSwitcher({
  current,
  organizations,
}: {
  current: OrganizationSummary;
  organizations: OrganizationSummary[];
}) {
  const router = useRouter();

  return (
    <div className="border-b border-border p-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left
                       hover:bg-surface-hover transition-colors"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-medium text-fg">{current.name}</span>
              <span className="block truncate text-2xs text-fg-tertiary">
                {current.role.toLowerCase()} · {current.memberCount}{' '}
                {current.memberCount === 1 ? 'member' : 'members'}
              </span>
            </span>
            <Chevron />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-50 min-w-[240px] rounded-lg border border-border
                       bg-surface-raised p-1 shadow-menu"
          >
            <DropdownMenu.Label className="label-caps px-2 py-1.5">
              Organizations
            </DropdownMenu.Label>

            {organizations.map((org) => (
              <DropdownMenu.Item
                key={org.id}
                onSelect={() => router.push(`/app/${org.slug}`)}
                className={cx(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5',
                  'text-sm outline-none',
                  'data-[highlighted]:bg-surface-hover',
                  org.slug === current.slug && 'font-medium',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
                <span className="reference shrink-0 text-fg-tertiary">
                  {org.role.toLowerCase()}
                </span>
              </DropdownMenu.Item>
            ))}

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <DropdownMenu.Item
              onSelect={() => router.push('/onboarding')}
              className="cursor-pointer rounded-md px-2 py-1.5 text-sm
                         outline-none data-[highlighted]:bg-surface-hover"
            >
              Create organization
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function UserMenu({ user, role }: { user: CurrentUser; role: OrganizationRole }) {
  const router = useRouter();

  return (
    <div className="border-t border-border p-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left
                       hover:bg-surface-hover transition-colors"
          >
            <Avatar name={user.displayName} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fg">{user.displayName}</span>
              <span className="block truncate text-2xs text-fg-tertiary">{role.toLowerCase()}</span>
            </span>
            <Chevron />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            side="top"
            sideOffset={4}
            className="z-50 min-w-[200px] rounded-lg border border-border
                       bg-surface-raised p-1 shadow-menu"
          >
            <div className="px-2 py-1.5">
              <p className="truncate text-sm text-fg">{user.displayName}</p>
              <p className="truncate text-xs text-fg-tertiary">{user.email}</p>
            </div>

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <DropdownMenu.Item
              onSelect={() => router.push('/profile')}
              className="cursor-pointer rounded-md px-2 py-1.5 text-sm
                         outline-none data-[highlighted]:bg-surface-hover"
            >
              Profile and security
            </DropdownMenu.Item>

            <DropdownMenu.Item
              onSelect={() => {
                void api.post('/auth/logout').finally(() => {
                  // A hard navigation, not a router push: it discards every
                  // cached query so the next user of this browser cannot see
                  // the previous session's data in the React Query cache.
                  window.location.href = '/sign-in';
                });
              }}
              className="cursor-pointer rounded-md px-2 py-1.5 text-sm
                         outline-none data-[highlighted]:bg-surface-hover"
            >
              Sign out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

/** Visible only below lg, where the sidebar is a drawer. */
function MobileBar({
  organization,
  onOpenNav,
}: {
  organization: OrganizationSummary;
  onOpenNav: () => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 lg:hidden">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="flex size-8 items-center justify-center rounded-md hover:bg-surface-hover"
      >
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
          <path
            d="M2 4h12M2 8h12M2 12h12"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <span className="truncate text-base font-medium">{organization.name}</span>
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="size-3 shrink-0 text-fg-tertiary">
      <path
        d="M3 4.5 6 7.5 9 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex min-h-dvh bg-canvas">
      <div className="hidden w-sidebar shrink-0 border-r border-border bg-surface lg:block" />
      <div className="flex-1 p-6">
        <p role="status" className="text-sm text-fg-tertiary">
          Loading
        </p>
      </div>
    </div>
  );
}

function UnknownOrganization({
  organizations,
  user,
}: {
  organizations: OrganizationSummary[];
  user: CurrentUser;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6">
        <h1 className="text-lg font-semibold">Organization not found</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-secondary">
          This organization does not exist, or {user.email} is not a member of it.
        </p>

        {organizations.length > 0 ? (
          <>
            <p className="label-caps mt-5 pb-1.5">Your organizations</p>
            <ul className="flex flex-col gap-px">
              {organizations.map((org) => (
                <li key={org.id}>
                  <Link
                    href={`/app/${org.slug}`}
                    className="flex items-center justify-between rounded-md px-2 py-1.5
                               text-sm hover:bg-surface-hover"
                  >
                    <span className="truncate">{org.name}</span>
                    <span className="reference text-fg-tertiary">{org.role.toLowerCase()}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Button
            variant="primary"
            className="mt-5"
            onClick={() => {
              window.location.href = '/onboarding';
            }}
          >
            Create an organization
          </Button>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Page header
 *
 * 48px, one line: title on the left, the primary action on the right.
 * Deliberately not a hero — a large heading in a tool this dense wastes the
 * row it occupies, and the sidebar already says where you are.
 * ══════════════════════════════════════════════════════════════════════════ */

export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
}: {
  title: string;
  description?: string;
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="flex min-h-header flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
        <div className="min-w-0 flex-1">
          {breadcrumb && <div className="mb-0.5">{breadcrumb}</div>}
          <h1 className="truncate text-lg font-semibold leading-tight text-fg">{title}</h1>
          {description && <p className="mt-0.5 truncate text-xs text-fg-tertiary">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function PageBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cx('px-4 py-4 sm:px-6', className)}>{children}</div>;
}

export function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex items-center gap-1 text-xs text-fg-tertiary">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-1">
            {index > 0 && <span aria-hidden="true">/</span>}
            {item.href ? (
              <Link href={item.href} className="hover:text-fg hover:underline">
                {item.label}
              </Link>
            ) : (
              <span>{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
