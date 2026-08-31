'use client';

import Link from 'next/link';
import { Permission } from '@atlas/types';
import { PageBody, PageHeader, useTenant } from '@/components/app-shell';
import { Avatar, Priority, Reference, StatusBadge } from '@/components/ui/primitives';
import { Panel } from '@/components/ui/table';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { useProjects, useWorkItems, type ProjectRow, type WorkItemRow } from '@/lib/queries';
import { isOverdue, relativeTime, shortDate } from '@/lib/format';

/**
 * Overview.
 *
 * Deliberately not a dashboard of metric tiles. Counts of things are trivia —
 * "34 work items" tells you nothing you can act on. What a platform lead
 * actually opens this page to learn is: what is overdue, what is assigned to
 * me, and what moved since I last looked. So the page is three lists of real
 * rows, each one a link into the thing itself.
 *
 * There are no charts. A chart would need a trend to plot, and nothing here
 * has one worth the space — a bar chart of items-by-status is a table with the
 * numbers removed.
 */
export default function OverviewPage() {
  const tenant = useTenant();
  const canReadWork = tenant.can(Permission.WORKITEMS_READ);

  // Fetched as three narrow, specific queries rather than one broad one, so
  // each section renders as soon as its own data lands.
  const needsAttention = useWorkItems(tenant.slug, {
    priority: 'URGENT',
    status: 'TODO',
    pageSize: 6,
    sortBy: 'dueDate',
    sortDirection: 'asc',
  });

  const myWork = useWorkItems(tenant.slug, {
    assigneeId: 'me',
    pageSize: 6,
    sortBy: 'updatedAt',
    sortDirection: 'desc',
  });

  const recentProjects = useProjects(tenant.slug, {
    pageSize: 6,
    sortBy: 'updatedAt',
    sortDirection: 'desc',
  });

  return (
    <>
      <PageHeader
        title={tenant.organization.name}
        description={`You are ${articleFor(tenant.role)} ${tenant.role.toLowerCase()} in this organization`}
      />

      <PageBody className="flex flex-col gap-4">
        {canReadWork && (
          <Section
            title="Needs attention"
            description="Urgent and not yet started."
            href={`/app/${tenant.slug}/work-items?priority=URGENT&status=TODO`}
            query={needsAttention}
            emptyTitle="Nothing urgent"
            emptyDescription="No urgent work is waiting to be picked up."
            renderRow={(item) => <WorkItemLine key={item.id} item={item} slug={tenant.slug} showProject />}
          />
        )}

        {canReadWork && (
          <Section
            title="Assigned to you"
            description="Your open work, most recently updated first."
            href={`/app/${tenant.slug}/work-items?assigneeId=me`}
            query={myWork}
            emptyTitle="Nothing assigned to you"
            emptyDescription="Work assigned to you will appear here."
            renderRow={(item) => <WorkItemLine key={item.id} item={item} slug={tenant.slug} showProject />}
          />
        )}

        {tenant.can(Permission.PROJECTS_READ) && (
          <Section
            title="Recently updated projects"
            href={`/app/${tenant.slug}/projects`}
            query={recentProjects}
            emptyTitle="No projects yet"
            emptyDescription="Projects group the work your teams are doing."
            renderRow={(project) => (
              <ProjectLine key={project.id} project={project} slug={tenant.slug} />
            )}
          />
        )}
      </PageBody>
    </>
  );
}

/** "an owner", "a member" — small thing, but the alternative reads as machine output. */
function articleFor(role: string): string {
  return /^[AEIOU]/.test(role) ? 'an' : 'a';
}

interface SectionQuery<T> {
  data?: { data: T[] };
  isPending: boolean;
  error: unknown;
  refetch: () => unknown;
}

function Section<T>({
  title,
  description,
  href,
  query,
  emptyTitle,
  emptyDescription,
  renderRow,
}: {
  title: string;
  description?: string;
  href: string;
  query: SectionQuery<T>;
  emptyTitle: string;
  emptyDescription: string;
  renderRow: (row: T) => React.ReactNode;
}) {
  const rows = query.data?.data ?? [];

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-md font-semibold text-fg">{title}</h2>
          {description && <p className="text-xs text-fg-tertiary">{description}</p>}
        </div>
        <Link href={href} className="shrink-0 text-xs text-accent hover:underline">
          View all
        </Link>
      </div>

      {query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Panel>
          {query.isPending ? (
            <ul className="divide-y divide-border-subtle">
              {Array.from({ length: 4 }, (_, index) => (
                <li key={index} className="flex items-center gap-3 px-4 py-2.5">
                  <Skeleton className="h-2.5 w-16" />
                  <Skeleton className="h-2.5 flex-1" />
                  <Skeleton className="h-2.5 w-20" />
                </li>
              ))}
              <li className="sr-only" role="status">
                Loading {title}
              </li>
            </ul>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6">
              <EmptyState title={emptyTitle} description={emptyDescription} size="compact" />
            </div>
          ) : (
            <ul className="divide-y divide-border-subtle">{rows.map(renderRow)}</ul>
          )}
        </Panel>
      )}
    </section>
  );
}

function WorkItemLine({
  item,
  slug,
  showProject,
}: {
  item: WorkItemRow;
  slug: string;
  showProject?: boolean;
}) {
  const overdue = isOverdue(item.dueDate, item.status);

  return (
    <li>
      <Link
        href={`/app/${slug}/work-items/${item.id}`}
        className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover"
      >
        <Reference value={item.reference} className="w-[76px] shrink-0" />

        <span className="truncate-cell min-w-0 flex-1 text-fg">{item.title}</span>

        {showProject && (
          <span className="hidden shrink-0 text-xs text-fg-tertiary lg:inline">
            {item.project.name}
          </span>
        )}

        <span className="hidden shrink-0 sm:block">
          <Priority priority={item.priority} />
        </span>

        {item.dueDate ? (
          <time
            dateTime={item.dueDate}
            title={shortDate(item.dueDate)}
            className={
              overdue
                ? 'w-[92px] shrink-0 text-right text-xs font-medium text-danger'
                : 'w-[92px] shrink-0 text-right text-xs text-fg-tertiary'
            }
          >
            {overdue ? 'Overdue' : shortDate(item.dueDate)}
          </time>
        ) : (
          <span className="w-[92px] shrink-0" />
        )}

        {item.assignee ? (
          <Avatar name={item.assignee.displayName} size="sm" />
        ) : (
          // Keeps the column aligned when nobody is assigned, rather than
          // letting the row above and below disagree about where things sit.
          <span className="size-5 shrink-0" aria-hidden="true" />
        )}
      </Link>
    </li>
  );
}

function ProjectLine({ project, slug }: { project: ProjectRow; slug: string }) {
  return (
    <li>
      <Link
        href={`/app/${slug}/projects/${project.id}`}
        className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-hover"
      >
        <Reference value={project.key} className="w-[76px] shrink-0" />
        <span className="truncate-cell min-w-0 flex-1 text-fg">{project.name}</span>
        <span className="hidden shrink-0 text-xs text-fg-tertiary md:inline">
          {project.workItemCount} {project.workItemCount === 1 ? 'item' : 'items'}
        </span>
        <StatusBadge status={project.status} />
        <time
          dateTime={project.updatedAt}
          title={new Date(project.updatedAt).toLocaleString()}
          className="hidden w-[92px] shrink-0 text-right text-xs text-fg-tertiary lg:block"
        >
          {relativeTime(project.updatedAt)}
        </time>
      </Link>
    </li>
  );
}
