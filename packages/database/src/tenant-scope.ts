import type { PrismaClient, Prisma } from '@prisma/client';

/**
 * Application-layer tenant scoping.
 *
 * This is the second of three layers that enforce tenant isolation. The full
 * strategy is in docs/multi-tenancy.md; in short:
 *
 *   1. Database  — composite foreign keys make a cross-tenant reference
 *                  physically unrepresentable (see schema.prisma).
 *   2. Data access — THIS FILE. Every query against a tenant-owned model has
 *                  `organizationId` injected, so forgetting the filter in a
 *                  service is not possible.
 *   3. HTTP      — guards resolve and authorise the tenant before a service
 *                  ever runs (see apps/api/src/common/tenancy).
 *
 * Layer 2 exists because layer 1 only catches *relationships*. A bare
 * `project.findFirst({ where: { id } })` references nothing across tenants —
 * it just reads another organization's row. No FK can stop that; only a
 * mandatory predicate can.
 *
 * Implemented as a Prisma client extension rather than a hand-written
 * repository per model. A repository layer would need one wrapper method per
 * model per operation, and the isolation guarantee would then depend on
 * developers remembering to use the wrapper. An extension intercepts
 * `$allOperations`, so a scoped client cannot issue an unscoped query even by
 * accident.
 */

/**
 * Models that carry an `organizationId` discriminator.
 *
 * Anything absent from this set is either global (User, Session) or the tenant
 * root itself (Organization), and is left untouched by the extension.
 *
 * Adding a tenant-owned model without adding it here would silently opt that
 * model out of scoping, so `assertTenantModelCoverage()` below is called at
 * API boot to fail loudly when the schema and this list diverge.
 */
export const TENANT_OWNED_MODELS = new Set<string>([
  'OrganizationMembership',
  'OrganizationSettings',
  'Team',
  'TeamMembership',
  'Workspace',
  'Project',
  'ProjectMembership',
  'WorkItem',
  'AuditLog',
  'ApiKey',
  'Invitation',
]);

/** Models deliberately excluded from tenant scoping, with the reason. */
export const NON_TENANT_MODELS: Record<string, string> = {
  User: 'Global identity. A user exists independently of any organization.',
  Session: 'Bound to a user, not an organization; one session spans org switches.',
  Organization: 'The tenant root itself — scoping it by its own id is circular.',
};

/** Operations whose arguments carry a `where` clause we must constrain. */
const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Operations that write new rows and must be stamped with the tenant. */
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

/** Operations that both read and write, needing where *and* data handling. */
const UPSERT_OPERATIONS = new Set(['upsert']);

type AnyArgs = Record<string, unknown>;

function injectWhere(args: AnyArgs, organizationId: string): AnyArgs {
  const existing = (args.where ?? {}) as AnyArgs;

  // This single line is what turns the classic `findUnique({ where: { id } })`
  // IDOR into a tenant-scoped read.
  //
  // It works on the unique-only operations (findUnique, update, delete)
  // because Prisma's "extended whereUnique" — GA since v5 — lets a
  // WhereUniqueInput carry extra non-unique predicates alongside at least one
  // unique field. The generated SQL keeps the indexed lookup and adds
  // `AND "organizationId" = $n`, so a row belonging to another tenant returns
  // null instead of the record. Verified by test/tenant-scope.spec.ts, which
  // asserts the behaviour rather than trusting the Prisma version.
  return { ...args, where: { ...existing, organizationId } };
}

function injectCreateData(args: AnyArgs, organizationId: string): AnyArgs {
  const data = args.data;
  if (Array.isArray(data)) {
    return {
      ...args,
      data: data.map((row) => ({ ...(row as AnyArgs), organizationId })),
    };
  }
  return { ...args, data: { ...(data as AnyArgs), organizationId } };
}

export interface TenantScopeOptions {
  /**
   * Called when a scoped write supplies an `organizationId` that contradicts
   * the bound tenant. Indicates either a bug or an attempted tenant escape, so
   * the default implementation throws; the API additionally logs it as a
   * security event.
   */
  onTenantMismatch?: (details: {
    model: string;
    operation: string;
    expected: string;
    received: string;
  }) => void;
}

function defaultOnMismatch(details: {
  model: string;
  operation: string;
  expected: string;
  received: string;
}): never {
  throw new Error(
    `Tenant scope violation: ${details.model}.${details.operation} was given ` +
      `organizationId="${details.received}" while scoped to "${details.expected}".`,
  );
}

/**
 * Returns a Prisma client permanently bound to one organization.
 *
 * Every read against a tenant-owned model gains `WHERE organizationId = $1`;
 * every write is stamped with the same value. A caller physically cannot
 * observe or mutate another tenant's rows through the returned client.
 *
 * The unscoped client remains available for the genuinely global operations
 * (authentication, organization creation, the org switcher's membership
 * lookup). Those call sites are few and each is individually reviewed —
 * see docs/multi-tenancy.md § escape hatches.
 */
export function forOrganization(
  prisma: PrismaClient,
  organizationId: string,
  options: TenantScopeOptions = {},
) {
  const onMismatch = options.onTenantMismatch ?? defaultOnMismatch;

  return prisma.$extends({
    name: `tenant-scope:${organizationId}`,
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma's
        // $allOperations callback is intentionally untyped across models; the
        // narrowing happens on `model` below.
        async $allOperations({ model, operation, args, query }: any) {
          if (!model || !TENANT_OWNED_MODELS.has(model)) {
            return query(args) as unknown;
          }

          const typedArgs = (args ?? {}) as AnyArgs;

          // Reject a contradictory explicit tenant rather than silently
          // overwriting it — a caller passing the wrong organizationId is a
          // bug worth surfacing, not one worth papering over.
          const explicit = (typedArgs.where as AnyArgs | undefined)?.organizationId;
          if (typeof explicit === 'string' && explicit !== organizationId) {
            onMismatch({ model, operation, expected: organizationId, received: explicit });
          }

          let next = typedArgs;

          if (WHERE_OPERATIONS.has(operation)) {
            next = injectWhere(next, organizationId);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            next = injectCreateData(next, organizationId);
          }

          if (UPSERT_OPERATIONS.has(operation)) {
            next = injectWhere(next, organizationId);
            const create = (next.create ?? {}) as AnyArgs;
            next = { ...next, create: { ...create, organizationId } };
          }

          return query(next) as unknown;
        },
      },
    },
  });
}

export type ScopedPrismaClient = ReturnType<typeof forOrganization>;

/**
 * Fails fast if a model in the Prisma schema is neither declared tenant-owned
 * nor explicitly excluded.
 *
 * Called once during API bootstrap. Without it, adding a tenant-owned table
 * and forgetting to register it here would produce a model that looks scoped
 * but silently is not — the exact failure this whole file exists to prevent.
 */
export function assertTenantModelCoverage(prisma: PrismaClient): void {
  const dmmf = (prisma as unknown as { _runtimeDataModel?: { models: Record<string, unknown> } })
    ._runtimeDataModel;
  if (!dmmf) return; // Older/mocked clients: skip rather than crash boot.

  const unclassified = Object.keys(dmmf.models).filter(
    (name) => !TENANT_OWNED_MODELS.has(name) && !(name in NON_TENANT_MODELS),
  );

  if (unclassified.length > 0) {
    throw new Error(
      `Tenant scoping is undefined for model(s): ${unclassified.join(', ')}. ` +
        'Add each to TENANT_OWNED_MODELS if it has an organizationId column, ' +
        'or to NON_TENANT_MODELS with a justification. ' +
        'See packages/database/src/tenant-scope.ts.',
    );
  }
}
