import { z } from 'zod';
import { ORGANIZATION_ROLES } from '@atlas/types';
import {
  cursorPaginationSchema,
  descriptionSchema,
  displayNameSchema,
  emailSchema,
  offsetPaginationSchema,
  passwordSchema,
  projectKeySchema,
  slugSchema,
  sortDirectionSchema,
  uuidSchema,
} from './primitives.js';

/**
 * Request schemas shared by the API's DTO layer and the web app's forms.
 *
 * Every schema here uses `.strict()`. That is a mass-assignment defence, not
 * a style choice: without it, Zod silently drops unknown keys, and a
 * hand-written `Object.assign(entity, dto)` downstream would happily accept a
 * smuggled `role: 'OWNER'` or `organizationId` from the request body. Strict
 * mode turns that into a 400 at the edge.
 */

// ── Auth ────────────────────────────────────────────────────────────────────

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    // Deliberately not `passwordSchema`. Applying the registration policy at
    // login would reject a legitimate password that predates a policy change,
    // and the difference in error messages would leak whether an account's
    // password meets the current rules.
    password: z.string().min(1, 'Enter your password.'),
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: passwordSchema,
  })
  .strict()
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'Choose a password different from your current one.',
    path: ['newPassword'],
  });

export const updateProfileSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    avatarUrl: z.string().url().max(2048).nullish(),
  })
  .strict();

// ── Organizations ───────────────────────────────────────────────────────────

export const createOrganizationSchema = z
  .object({
    name: displayNameSchema,
    // Optional: the service derives one from the name and resolves collisions
    // when omitted.
    slug: slugSchema.optional(),
  })
  .strict();

export const updateOrganizationSchema = z
  .object({
    name: displayNameSchema.optional(),
  })
  .strict();

/**
 * Organization deletion requires retyping the slug.
 *
 * The confirmation is validated server-side against the real slug, not just in
 * the dialog, so a scripted request has to demonstrate the same intent a human
 * would. See docs/security.md § destructive actions.
 */
export const deleteOrganizationSchema = z
  .object({
    confirmSlug: z.string().min(1, 'Type the organization slug to confirm.'),
  })
  .strict();

export const updateOrganizationSettingsSchema = z
  .object({
    restrictEmailDomains: z.boolean().optional(),
    allowedEmailDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'Enter a valid domain.'),
      )
      .max(50)
      .optional(),
    sessionIdleTimeoutMinutes: z.number().int().min(5).max(43200).nullish(),
    requireTwoFactor: z.boolean().optional(),
  })
  .strict();

// ── Members & invitations ───────────────────────────────────────────────────

const organizationRoleSchema = z.enum(ORGANIZATION_ROLES);

export const inviteMemberSchema = z
  .object({
    email: emailSchema,
    role: organizationRoleSchema,
  })
  .strict();

export const updateMemberRoleSchema = z
  .object({
    role: organizationRoleSchema,
  })
  .strict();

export const acceptInvitationSchema = z
  .object({
    token: z.string().min(32, 'This invitation link is not valid.').max(256),
  })
  .strict();

export const listMembersSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    role: organizationRoleSchema.optional(),
    sortBy: z.enum(['displayName', 'email', 'role', 'joinedAt']).default('joinedAt'),
    sortDirection: sortDirectionSchema,
  })
  .merge(offsetPaginationSchema)
  .strict();

// ── Teams & workspaces ──────────────────────────────────────────────────────

export const createTeamSchema = z
  .object({
    name: displayNameSchema,
    slug: slugSchema.optional(),
    description: descriptionSchema,
  })
  .strict();

export const updateTeamSchema = createTeamSchema.partial().strict();

export const addTeamMemberSchema = z
  .object({
    userId: uuidSchema,
    role: z.enum(['LEAD', 'MEMBER']).default('MEMBER'),
  })
  .strict();

export const createWorkspaceSchema = z
  .object({
    name: displayNameSchema,
    slug: slugSchema.optional(),
    description: descriptionSchema,
  })
  .strict();

export const updateWorkspaceSchema = createWorkspaceSchema.partial().strict();

// ── Projects ────────────────────────────────────────────────────────────────

export const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'] as const;
const projectStatusSchema = z.enum(PROJECT_STATUSES);

export const createProjectSchema = z
  .object({
    name: displayNameSchema,
    key: projectKeySchema.optional(),
    description: z.string().trim().max(2000).optional(),
    workspaceId: uuidSchema,
    teamId: uuidSchema.nullish(),
    status: projectStatusSchema.default('PLANNING'),
  })
  .strict();

export const updateProjectSchema = z
  .object({
    name: displayNameSchema.optional(),
    description: z.string().trim().max(2000).nullish(),
    teamId: uuidSchema.nullish(),
    status: projectStatusSchema.optional(),
  })
  // `key` is absent on purpose. It appears in every work-item reference
  // (PORTAL-42) that people paste into tickets and chat, so changing it would
  // silently break external references. Recreate the project instead.
  .strict();

export const listProjectsSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    status: projectStatusSchema.optional(),
    workspaceId: uuidSchema.optional(),
    teamId: uuidSchema.optional(),
    sortBy: z.enum(['name', 'status', 'createdAt', 'updatedAt']).default('updatedAt'),
    sortDirection: sortDirectionSchema,
  })
  .merge(offsetPaginationSchema)
  .strict();

export const addProjectMemberSchema = z
  .object({
    userId: uuidSchema,
    role: z.enum(['MAINTAINER', 'CONTRIBUTOR', 'OBSERVER']).default('CONTRIBUTOR'),
  })
  .strict();

// ── Work items ──────────────────────────────────────────────────────────────

export const WORK_ITEM_TYPES = ['TASK', 'ISSUE', 'BUG', 'IMPROVEMENT'] as const;
export const WORK_ITEM_STATUSES = [
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
] as const;
export const WORK_ITEM_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

const workItemTypeSchema = z.enum(WORK_ITEM_TYPES);
const workItemStatusSchema = z.enum(WORK_ITEM_STATUSES);
const workItemPrioritySchema = z.enum(WORK_ITEM_PRIORITIES);

export const createWorkItemSchema = z
  .object({
    title: z.string().trim().min(1, 'Enter a title.').max(300),
    description: z.string().trim().max(20000).optional(),
    type: workItemTypeSchema.default('TASK'),
    status: workItemStatusSchema.default('BACKLOG'),
    priority: workItemPrioritySchema.default('MEDIUM'),
    assigneeId: uuidSchema.nullish(),
    // Date-only. Coerced from the ISO string the client sends; time-of-day is
    // meaningless for a due date and would make the value timezone-dependent.
    dueDate: z.coerce.date().nullish(),
  })
  .strict();

export const updateWorkItemSchema = createWorkItemSchema.partial().strict();

export const listWorkItemsSchema = z
  .object({
    search: z.string().trim().max(120).optional(),
    projectId: uuidSchema.optional(),
    status: z.union([workItemStatusSchema, z.array(workItemStatusSchema)]).optional(),
    priority: z.union([workItemPrioritySchema, z.array(workItemPrioritySchema)]).optional(),
    type: workItemTypeSchema.optional(),
    // The literal 'me' resolves to the caller server-side, so the web app does
    // not need the user's own id to build a "my work" filter link.
    assigneeId: z.union([uuidSchema, z.literal('me'), z.literal('unassigned')]).optional(),
    sortBy: z.enum(['updatedAt', 'createdAt', 'priority', 'status', 'dueDate']).default('updatedAt'),
    sortDirection: sortDirectionSchema,
  })
  .merge(offsetPaginationSchema)
  .strict();

// ── API keys ────────────────────────────────────────────────────────────────

export const createApiKeySchema = z
  .object({
    name: displayNameSchema,
    // Null means no expiry. Capped at ~2 years: an unbounded credential is a
    // liability, and forcing a conscious choice beats a silent forever-key.
    expiresInDays: z.number().int().min(1).max(730).nullish(),
  })
  .strict();

// ── Audit ───────────────────────────────────────────────────────────────────

export const listAuditLogsSchema = z
  .object({
    actorId: uuidSchema.optional(),
    action: z.string().trim().max(80).optional(),
    resourceType: z.string().trim().max(40).optional(),
    resourceId: uuidSchema.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  // Cursor rather than offset: the audit log is append-heavy and read
  // newest-first, so offset pagination would both drift as rows arrive and get
  // slower the deeper you page. See docs/api.md § pagination.
  .merge(cursorPaginationSchema)
  .strict()
  .refine((data) => !data.from || !data.to || data.from <= data.to, {
    message: 'The start date must be on or before the end date.',
    path: ['from'],
  });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ListProjectsInput = z.infer<typeof listProjectsSchema>;
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;
export type UpdateWorkItemInput = z.infer<typeof updateWorkItemSchema>;
export type ListWorkItemsInput = z.infer<typeof listWorkItemsSchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type ListAuditLogsInput = z.infer<typeof listAuditLogsSchema>;
