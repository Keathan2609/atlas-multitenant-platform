import type { OrganizationRole } from '@atlas/types';

/**
 * Request augmentation, declared in one place.
 *
 * These properties are populated by middleware and guards in a fixed order:
 *
 *   RequestContextMiddleware -> requestId, startedAt
 *   ApiKeyGuard              -> apiKeyContext  (API-key callers only)
 *   AuthGuard                -> user, sessionId (cookie callers only)
 *   TenantGuard              -> tenant
 *
 * Declaring them here rather than scattered across the modules that set them
 * keeps the request contract readable and stops two modules disagreeing about
 * a field's type.
 */

export interface ApiKeyContext {
  apiKeyId: string;
  organizationId: string;
}

/**
 * The resolved tenant for this request.
 *
 * `role` is read from the caller's membership row on the server — never from
 * anything the client sent. It is the input to every permission decision.
 */
export interface TenantContext {
  organizationId: string;
  slug: string;
  name: string;
  role: OrganizationRole;
  membershipId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express's own
  // augmentation pattern requires declaration merging into this namespace.
  namespace Express {
    interface Request {
      requestId: string;
      startedAt: bigint;
      user?: {
        id: string;
        email: string;
        displayName: string;
        avatarUrl: string | null;
      };
      sessionId?: string;
      apiKeyContext?: ApiKeyContext;
      tenant?: TenantContext;
    }
  }
}

export {};
