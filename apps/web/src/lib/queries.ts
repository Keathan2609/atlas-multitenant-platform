'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type { OrganizationRole, Permission } from '@atlas/types';
import { ApiError, api } from './api';

/**
 * Server state.
 *
 * Query keys are structured `[resource, orgSlug, ...params]` so invalidating a
 * whole tenant is one call, and so switching organizations cannot show the
 * previous tenant's cached rows — the slug is part of every key rather than
 * ambient state.
 */

export const keys = {
  me: ['me'] as const,
  sessions: ['sessions'] as const,
  organizations: ['organizations'] as const,
  organization: (slug: string) => ['organization', slug] as const,
  members: (slug: string, params?: unknown) => ['members', slug, params] as const,
  invitations: (slug: string) => ['invitations', slug] as const,
  teams: (slug: string) => ['teams', slug] as const,
  team: (slug: string, id: string) => ['team', slug, id] as const,
  workspaces: (slug: string) => ['workspaces', slug] as const,
  projects: (slug: string, params?: unknown) => ['projects', slug, params] as const,
  project: (slug: string, id: string) => ['project', slug, id] as const,
  workItems: (slug: string, params?: unknown) => ['work-items', slug, params] as const,
  workItem: (slug: string, id: string) => ['work-item', slug, id] as const,
  apiKeys: (slug: string) => ['api-keys', slug] as const,
  auditLogs: (slug: string, params?: unknown) => ['audit-logs', slug, params] as const,
  auditActions: (slug: string) => ['audit-actions', slug] as const,
  settings: (slug: string) => ['settings', slug] as const,
};

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  memberCount: number;
  joinedAt: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Retry policy.
 *
 * A 401, 403 or 404 is a settled answer, not a transient failure — retrying
 * one wastes time and, for a 401, delays the redirect to sign-in. Only
 * genuinely retryable failures get a second attempt.
 */
function retryPolicy(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.status < 500) return false;
  }
  return failureCount < 2;
}

export const defaultQueryOptions = {
  retry: retryPolicy,
  // Application data changes as colleagues work, but not second to second.
  staleTime: 30_000,
  refetchOnWindowFocus: true,
} as const;

type QueryConfig<T> = Omit<
  UseQueryOptions<T, Error, T, readonly unknown[]>,
  'queryKey' | 'queryFn'
>;

export function useCurrentUser(config?: QueryConfig<{ user: CurrentUser }>) {
  return useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => api.get<{ user: CurrentUser }>('/auth/me', undefined, signal),
    ...defaultQueryOptions,
    ...config,
  });
}

export interface SessionRow {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** Set by the server so the UI can mark "this device" without comparing ids. */
  current: boolean;
}

export function useSessions() {
  return useQuery({
    queryKey: keys.sessions,
    queryFn: ({ signal }) => api.get<{ data: SessionRow[] }>('/auth/sessions', undefined, signal),
    ...defaultQueryOptions,
  });
}

export function useOrganizations() {
  return useQuery({
    queryKey: keys.organizations,
    queryFn: ({ signal }) =>
      api.get<{ data: OrganizationSummary[] }>('/organizations', undefined, signal),
    ...defaultQueryOptions,
  });
}

export interface OrganizationDetail {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  role: OrganizationRole;
  counts: { members: number; projects: number; teams: number };
}

export function useOrganization(slug: string) {
  return useQuery({
    queryKey: keys.organization(slug),
    queryFn: ({ signal }) =>
      api.get<OrganizationDetail>(`/organizations/${slug}`, undefined, signal),
    enabled: Boolean(slug),
    ...defaultQueryOptions,
  });
}

/** Generic tenant-scoped list hook, so each resource is three lines rather than fifteen. */
function useTenantQuery<T>(
  key: readonly unknown[],
  path: string,
  params?: Record<string, string | number | boolean | undefined | null>,
  enabled = true,
) {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.get<T>(path, params, signal),
    enabled,
    ...defaultQueryOptions,
  });
}

export interface ProjectRow {
  id: string;
  name: string;
  key: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  workspace: { id: string; name: string; slug: string };
  team: { id: string; name: string; slug: string } | null;
  workItemCount: number;
  memberCount: number;
}

export function useProjects(slug: string, params: Record<string, string | number | undefined>) {
  return useTenantQuery<{ data: ProjectRow[]; pagination: Pagination }>(
    keys.projects(slug, params),
    `/organizations/${slug}/projects`,
    params,
    Boolean(slug),
  );
}

export interface ProjectMember {
  id: string;
  role: 'MAINTAINER' | 'CONTRIBUTOR' | 'OBSERVER';
  user: { id: string; displayName: string; email: string; avatarUrl: string | null };
}

export interface ProjectDetail {
  id: string;
  name: string;
  key: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  workspace: { id: string; name: string; slug: string };
  team: { id: string; name: string; slug: string } | null;
  members: ProjectMember[];
  _count: { workItems: number };
}

export function useProject(slug: string, projectId: string) {
  return useTenantQuery<ProjectDetail>(
    keys.project(slug, projectId),
    `/organizations/${slug}/projects/${projectId}`,
    undefined,
    Boolean(slug && projectId),
  );
}

export interface WorkItemRow {
  id: string;
  number: number;
  reference: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  project: { id: string; key: string; name: string };
  assignee: { id: string; displayName: string; avatarUrl: string | null } | null;
  reporter: { id: string; displayName: string } | null;
}

export function useWorkItems(slug: string, params: Record<string, string | number | undefined>) {
  return useTenantQuery<{ data: WorkItemRow[]; pagination: Pagination }>(
    keys.workItems(slug, params),
    `/organizations/${slug}/work-items`,
    params,
    Boolean(slug),
  );
}

export interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: OrganizationRole;
  joinedAt: string;
  lastLoginAt: string | null;
}

export function useMembers(slug: string, params: Record<string, string | number | undefined>) {
  return useTenantQuery<{ data: MemberRow[]; pagination: Pagination }>(
    keys.members(slug, params),
    `/organizations/${slug}/members`,
    params,
    Boolean(slug),
  );
}

export interface TeamRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: string;
  memberCount: number;
  projectCount: number;
}

export function useTeams(slug: string) {
  return useTenantQuery<{ data: TeamRow[] }>(
    keys.teams(slug),
    `/organizations/${slug}/teams`,
    undefined,
    Boolean(slug),
  );
}

export function useTeam(slug: string, teamId: string) {
  return useTenantQuery<Record<string, unknown>>(
    keys.team(slug, teamId),
    `/organizations/${slug}/teams/${teamId}`,
    undefined,
    Boolean(slug && teamId),
  );
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  projectCount: number;
}

export function useWorkspaces(slug: string) {
  return useTenantQuery<{ data: WorkspaceRow[] }>(
    keys.workspaces(slug),
    `/organizations/${slug}/workspaces`,
    undefined,
    Boolean(slug),
  );
}

export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  createdBy: { id: string; displayName: string } | null;
}

export function useApiKeys(slug: string, enabled = true) {
  return useTenantQuery<{ data: ApiKeyRow[] }>(
    keys.apiKeys(slug),
    `/organizations/${slug}/api-keys`,
    undefined,
    Boolean(slug) && enabled,
  );
}

export interface InvitationRow {
  id: string;
  email: string;
  role: OrganizationRole;
  status: string;
  expiresAt: string;
  createdAt: string;
  invitedBy: { id: string; displayName: string } | null;
}

export function useInvitations(slug: string, enabled = true) {
  return useTenantQuery<{ data: InvitationRow[] }>(
    keys.invitations(slug),
    `/organizations/${slug}/invitations`,
    undefined,
    Boolean(slug) && enabled,
  );
}

export interface AuditEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, string | number | boolean | null>;
  ipAddress: string | null;
  createdAt: string;
  actor: { id: string; displayName: string; email: string; avatarUrl: string | null } | null;
}

export function useAuditLogs(
  slug: string,
  params: Record<string, string | number | undefined>,
  enabled = true,
) {
  return useTenantQuery<{
    data: AuditEntry[];
    pagination: { limit: number; hasMore: boolean; nextCursor: string | null };
  }>(
    keys.auditLogs(slug, params),
    `/organizations/${slug}/audit-logs`,
    params,
    Boolean(slug) && enabled,
  );
}

export function useAuditActions(slug: string, enabled = true) {
  return useTenantQuery<{ data: string[] }>(
    keys.auditActions(slug),
    `/organizations/${slug}/audit-logs/actions`,
    undefined,
    Boolean(slug) && enabled,
  );
}

export interface OrganizationSettings {
  restrictEmailDomains: boolean;
  allowedEmailDomains: string[];
  sessionIdleTimeoutMinutes: number | null;
  requireTwoFactor: boolean;
  updatedAt: string | null;
}

export function useSettings(slug: string, enabled = true) {
  return useTenantQuery<OrganizationSettings>(
    keys.settings(slug),
    `/organizations/${slug}/settings`,
    undefined,
    Boolean(slug) && enabled,
  );
}

/**
 * Mutation helper that invalidates the tenant's cached lists on success.
 *
 * Deliberately coarse. Surgical cache updates are a common source of stale
 * screens, and for a tool at this scale a refetch is cheap and always correct.
 * Optimistic updates are applied only where explicitly justified — see
 * useWorkItemStatus below.
 */
export function useTenantMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  invalidate: (keyFactory: typeof keys) => readonly unknown[][],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all(
        invalidate(keys).map((key) => queryClient.invalidateQueries({ queryKey: key })),
      );
    },
  });
}

/**
 * Work-item status change, applied optimistically.
 *
 * This is the one place optimism is warranted: it is frequent, low-stakes, and
 * trivially reversible by the user. Destructive and administrative operations
 * — deleting a project, changing a role, revoking a key — deliberately wait
 * for the server, because showing a security change as done before it is done
 * is worse than a moment of latency.
 */
export function useWorkItemStatus(slug: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch<WorkItemRow>(`/organizations/${slug}/work-items/${id}`, { status }),

    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ['work-items', slug] });
      const snapshot = queryClient.getQueriesData({ queryKey: ['work-items', slug] });

      queryClient.setQueriesData<{ data: WorkItemRow[] }>(
        { queryKey: ['work-items', slug] },
        (old) =>
          old ? { ...old, data: old.data.map((w) => (w.id === id ? { ...w, status } : w)) } : old,
      );

      // Returned so onError can put the previous state back exactly.
      return { snapshot };
    },

    onError: (_error, _vars, context) => {
      for (const [key, value] of context?.snapshot ?? []) {
        queryClient.setQueryData(key, value);
      }
    },

    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['work-items', slug] });
    },
  });
}

export type { Permission };
