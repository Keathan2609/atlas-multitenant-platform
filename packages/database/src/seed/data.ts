/**
 * Seed narrative.
 *
 * Two organizations, because one cannot demonstrate tenant isolation. Northstar
 * Systems is the primary tenant and is populated as a mid-sized platform team
 * mid-way through several pieces of work; Meridian Labs exists so a reviewer can
 * sign in as one of its members and confirm that none of Northstar's data is
 * reachable.
 *
 * The content is written as a coherent operational picture rather than filler.
 * Work items reference the projects they belong to, statuses are distributed the
 * way a real backlog is (most things not done), and a few items are deliberately
 * awkward — a very long title, an unassigned item, an overdue one — because
 * those are the cases that break a table layout and they should be visible in
 * the seeded state rather than discovered in production.
 */

export const DEMO_PASSWORD = 'atlas-demo-password';

export interface SeedUser {
  key: string;
  email: string;
  displayName: string;
}

/**
 * Demo accounts.
 *
 * One per role in Northstar so a reviewer can sign in and see exactly what each
 * role can and cannot do. `dana` also owns Meridian, which makes the
 * organization switcher meaningful without inventing a second identity.
 */
export const USERS: SeedUser[] = [
  { key: 'dana', email: 'dana.whitfield@northstar.example', displayName: 'Dana Whitfield' },
  { key: 'marcus', email: 'marcus.oyelaran@northstar.example', displayName: 'Marcus Oyelaran' },
  { key: 'priya', email: 'priya.raghunathan@northstar.example', displayName: 'Priya Raghunathan' },
  { key: 'tomas', email: 'tomas.lindqvist@northstar.example', displayName: 'Tomas Lindqvist' },
  { key: 'aisha', email: 'aisha.bello@northstar.example', displayName: 'Aisha Bello' },
  { key: 'ken', email: 'ken.matsuda@northstar.example', displayName: 'Ken Matsuda' },
  { key: 'rosa', email: 'rosa.delacruz@northstar.example', displayName: 'Rosa de la Cruz' },
  // Meridian only — used to prove a non-member sees nothing of Northstar.
  { key: 'jonas', email: 'jonas.eriksen@meridian.example', displayName: 'Jonas Eriksen' },
];

export const NORTHSTAR_MEMBERS: Array<{ user: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' }> = [
  { user: 'dana', role: 'OWNER' },
  { user: 'marcus', role: 'ADMIN' },
  { user: 'priya', role: 'MEMBER' },
  { user: 'tomas', role: 'MEMBER' },
  { user: 'aisha', role: 'MEMBER' },
  { user: 'ken', role: 'MEMBER' },
  // A read-only stakeholder, which is what the VIEWER role is actually for.
  { user: 'rosa', role: 'VIEWER' },
];

export const MERIDIAN_MEMBERS: Array<{ user: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' }> = [
  { user: 'jonas', role: 'OWNER' },
  { user: 'dana', role: 'ADMIN' },
];

export const TEAMS = [
  {
    key: 'platform',
    name: 'Platform',
    slug: 'platform',
    description: 'Core services, shared libraries, and the internal developer surface.',
    members: [
      { user: 'marcus', role: 'LEAD' as const },
      { user: 'priya', role: 'MEMBER' as const },
      { user: 'ken', role: 'MEMBER' as const },
    ],
  },
  {
    key: 'infrastructure',
    name: 'Infrastructure',
    slug: 'infrastructure',
    description: 'Compute, networking, deployment tooling, and cost.',
    members: [
      { user: 'tomas', role: 'LEAD' as const },
      { user: 'ken', role: 'MEMBER' as const },
    ],
  },
  {
    key: 'security',
    name: 'Security',
    slug: 'security',
    description: 'Identity, access review, and vulnerability response.',
    members: [
      { user: 'aisha', role: 'LEAD' as const },
      { user: 'dana', role: 'MEMBER' as const },
    ],
  },
  {
    key: 'product-engineering',
    name: 'Product Engineering',
    slug: 'product-engineering',
    description: 'Customer-facing surfaces and the design system.',
    members: [{ user: 'priya', role: 'LEAD' as const }],
  },
];

export const WORKSPACES = [
  {
    key: 'general',
    name: 'General',
    slug: 'general',
    description: 'Default workspace.',
    isDefault: true,
  },
  {
    key: 'platform-modernisation',
    name: 'Platform Modernisation',
    slug: 'platform-modernisation',
    description: 'The multi-quarter programme to retire the legacy monolith.',
    isDefault: false,
  },
];

export const PROJECTS = [
  {
    key: 'identity',
    name: 'Identity Service Migration',
    projectKey: 'IDENT',
    workspace: 'platform-modernisation',
    team: 'security',
    status: 'ACTIVE' as const,
    description:
      'Move authentication off the monolith onto the standalone identity service. Sessions and API credentials first; SSO follows once the cutover is stable.',
  },
  {
    key: 'billing',
    name: 'Billing Infrastructure',
    projectKey: 'BILL',
    workspace: 'platform-modernisation',
    team: 'platform',
    status: 'ACTIVE' as const,
    description:
      'Replace the nightly invoice batch with an event-driven ledger. Blocked on the identity cutover for service-to-service auth.',
  },
  {
    key: 'portal',
    name: 'Developer Portal',
    projectKey: 'PORTAL',
    workspace: 'general',
    team: 'product-engineering',
    status: 'ACTIVE' as const,
    description: 'Self-service documentation, API key management, and sandbox credentials.',
  },
  {
    key: 'reliability',
    name: 'Q4 Reliability Initiative',
    projectKey: 'REL',
    workspace: 'general',
    team: 'infrastructure',
    status: 'PLANNING' as const,
    description:
      'Reduce p99 latency on the checkout path and remove the three remaining single points of failure.',
  },
  {
    key: 'search',
    name: 'Search Relevance Rework',
    projectKey: 'SRCH',
    workspace: 'general',
    team: 'product-engineering',
    status: 'PAUSED' as const,
    description: 'Paused pending the outcome of the Q4 reliability work.',
  },
  {
    key: 'legacy-reporting',
    name: 'Legacy Reporting Decommission',
    projectKey: 'LEGACY',
    workspace: 'platform-modernisation',
    team: 'platform',
    status: 'COMPLETED' as const,
    description: 'Retired the 2019 reporting stack. Kept for historical reference.',
  },
];

export interface SeedWorkItem {
  project: string;
  title: string;
  description?: string;
  type: 'TASK' | 'ISSUE' | 'BUG' | 'IMPROVEMENT';
  status: 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'CANCELLED';
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  assignee?: string;
  reporter: string;
  /** Days from today. Negative is overdue. */
  dueInDays?: number;
}

/**
 * Work items.
 *
 * Weighted the way a real backlog is: mostly not-done, a handful in flight, a
 * few finished. The awkward cases are deliberate — an unusually long title, an
 * unassigned item, an overdue one, a cancelled one — so the table and detail
 * layouts are exercised by the seed rather than only by a reviewer's
 * imagination.
 */
export const WORK_ITEMS: SeedWorkItem[] = [
  // Identity Service Migration
  { project: 'identity', title: 'Move session issuance behind the identity service', type: 'TASK', status: 'IN_PROGRESS', priority: 'URGENT', assignee: 'aisha', reporter: 'dana', dueInDays: 4,
    description: 'Sessions are still minted by the monolith. Cut over issuance first, keep verification dual-path until the old sessions expire.' },
  { project: 'identity', title: 'Argon2id parameters need a decision before rollout', type: 'ISSUE', status: 'IN_REVIEW', priority: 'HIGH', assignee: 'aisha', reporter: 'marcus', dueInDays: 2 },
  { project: 'identity', title: 'Password reset emails are delivered twice when the retry queue drains after a partial SMTP failure', type: 'BUG', status: 'TODO', priority: 'HIGH', assignee: 'ken', reporter: 'rosa', dueInDays: -3 },
  { project: 'identity', title: 'Document the session revocation contract for downstream services', type: 'TASK', status: 'BACKLOG', priority: 'MEDIUM', reporter: 'aisha' },
  { project: 'identity', title: 'Remove the legacy /login endpoint', type: 'TASK', status: 'BACKLOG', priority: 'LOW', reporter: 'marcus' },
  { project: 'identity', title: 'Dual-path verification shim', type: 'TASK', status: 'DONE', priority: 'HIGH', assignee: 'aisha', reporter: 'dana' },

  // Billing Infrastructure
  { project: 'billing', title: 'Model the ledger entry schema', type: 'TASK', status: 'IN_PROGRESS', priority: 'HIGH', assignee: 'marcus', reporter: 'dana', dueInDays: 9 },
  { project: 'billing', title: 'Invoice totals drift by one cent on multi-currency accounts', type: 'BUG', status: 'TODO', priority: 'URGENT', assignee: 'priya', reporter: 'rosa', dueInDays: 1 },
  { project: 'billing', title: 'Retire the nightly batch job once the ledger is authoritative', type: 'TASK', status: 'BACKLOG', priority: 'MEDIUM', reporter: 'marcus' },
  { project: 'billing', title: 'Blocked: service-to-service auth pending identity cutover', type: 'ISSUE', status: 'BACKLOG', priority: 'HIGH', assignee: 'marcus', reporter: 'marcus' },
  { project: 'billing', title: 'Backfill historical invoices into the ledger', type: 'TASK', status: 'BACKLOG', priority: 'LOW', reporter: 'ken' },

  // Developer Portal
  { project: 'portal', title: 'API key creation flow', type: 'TASK', status: 'DONE', priority: 'HIGH', assignee: 'priya', reporter: 'dana' },
  { project: 'portal', title: 'Sandbox credentials expire without warning the developer', type: 'BUG', status: 'IN_PROGRESS', priority: 'MEDIUM', assignee: 'priya', reporter: 'tomas', dueInDays: 6 },
  { project: 'portal', title: 'Add copy-to-clipboard on credential fields', type: 'IMPROVEMENT', status: 'IN_REVIEW', priority: 'LOW', assignee: 'priya', reporter: 'rosa' },
  { project: 'portal', title: 'Search across the documentation set', type: 'TASK', status: 'TODO', priority: 'MEDIUM', reporter: 'priya', dueInDays: 14 },
  { project: 'portal', title: 'Dark mode for embedded code samples', type: 'IMPROVEMENT', status: 'BACKLOG', priority: 'LOW', reporter: 'tomas' },
  { project: 'portal', title: 'Rewrite the getting-started guide against the v1 API', type: 'TASK', status: 'BACKLOG', priority: 'MEDIUM', assignee: 'rosa', reporter: 'priya' },

  // Q4 Reliability Initiative
  { project: 'reliability', title: 'Identify the remaining single points of failure', type: 'TASK', status: 'IN_PROGRESS', priority: 'HIGH', assignee: 'tomas', reporter: 'dana', dueInDays: 11 },
  { project: 'reliability', title: 'p99 checkout latency exceeds the 400ms objective under load', type: 'ISSUE', status: 'TODO', priority: 'URGENT', assignee: 'tomas', reporter: 'marcus', dueInDays: -1 },
  { project: 'reliability', title: 'Connection pool saturates during the nightly batch window', type: 'BUG', status: 'TODO', priority: 'HIGH', assignee: 'ken', reporter: 'tomas', dueInDays: 5 },
  { project: 'reliability', title: 'Add read replicas for the reporting queries', type: 'TASK', status: 'BACKLOG', priority: 'MEDIUM', reporter: 'tomas' },
  { project: 'reliability', title: 'Chaos test the failover path', type: 'TASK', status: 'BACKLOG', priority: 'MEDIUM', reporter: 'aisha' },

  // Search Relevance Rework (paused)
  { project: 'search', title: 'Evaluate whether Postgres full-text is sufficient', type: 'TASK', status: 'BACKLOG', priority: 'LOW', reporter: 'priya' },
  { project: 'search', title: 'Relevance scoring spike', type: 'TASK', status: 'CANCELLED', priority: 'LOW', reporter: 'priya' },

  // Legacy Reporting Decommission (completed)
  { project: 'legacy-reporting', title: 'Export historical reports to cold storage', type: 'TASK', status: 'DONE', priority: 'MEDIUM', assignee: 'ken', reporter: 'marcus' },
  { project: 'legacy-reporting', title: 'Decommission the 2019 reporting cluster', type: 'TASK', status: 'DONE', priority: 'MEDIUM', assignee: 'tomas', reporter: 'marcus' },
];

/** Meridian is intentionally sparse — it exists to prove isolation, not to be explored. */
export const MERIDIAN_PROJECTS = [
  {
    key: 'instrument',
    name: 'Instrument Data Pipeline',
    projectKey: 'INSTR',
    status: 'ACTIVE' as const,
    description: 'Ingest and normalise readings from the sequencing instruments.',
  },
];

export const MERIDIAN_WORK_ITEMS: Array<Omit<SeedWorkItem, 'project'> & { project: string }> = [
  { project: 'instrument', title: 'Normalise vendor timestamp formats', type: 'TASK', status: 'IN_PROGRESS', priority: 'HIGH', assignee: 'jonas', reporter: 'jonas' },
  { project: 'instrument', title: 'Backpressure when the ingest queue is saturated', type: 'BUG', status: 'TODO', priority: 'MEDIUM', reporter: 'jonas' },
];
