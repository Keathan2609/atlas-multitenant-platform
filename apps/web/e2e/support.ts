import { expect, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Shared fixtures for the end-to-end suite.
 *
 * The accounts below are created by `pnpm db:seed`. They are referenced by
 * role rather than by address at every call site, so a change to the seed is
 * one edit here rather than a search across the suite.
 */
export const ACCOUNTS = {
  owner: 'dana.whitfield@northstar.example',
  admin: 'marcus.oyelaran@northstar.example',
  member: 'priya.raghunathan@northstar.example',
  viewer: 'rosa.delacruz@northstar.example',
} as const;

export const PASSWORD = 'atlas-demo-password';

/** The seeded tenants. Meridian exists to prove isolation, not to be populated. */
export const ORG = { northstar: 'northstar', meridian: 'meridian' } as const;

export type Role = keyof typeof ACCOUNTS;

/** Where auth.setup.ts writes the saved sessions. Gitignored. */
export const STATE_DIR = path.resolve(__dirname, '../.auth');

export function stateFor(role: Role): string {
  return path.join(STATE_DIR, `${role}.json`);
}

/** The API origin, resolved in Node — `process` does not exist in the page. */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Signs in through the real form.
 *
 * Deliberately not a storage-state shortcut. Sign-in is itself one of the
 * places a defect was found — a stale session cookie made it return 403 — and
 * the redirect it performs (straight in, to the picker, or to onboarding) is
 * behaviour worth exercising on every run rather than bypassing.
 */
export async function signIn(page: Page, role: Role): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(ACCOUNTS[role]);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The owner belongs to two organizations and lands on the picker; everyone
  // else has one and goes straight in.
  await page.waitForURL(/\/(app|organizations)\b/, { timeout: 20_000 });
}

/**
 * Waits for a tenant page to finish resolving.
 *
 * The shell renders a skeleton with an empty heading while `/auth/me` and the
 * organization list are in flight, so asserting on the heading alone races the
 * loading state — that is what made the first run fail on every route.
 */
export async function expectLoaded(page: Page): Promise<void> {
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).not.toBeEmpty();
}

/**
 * The application's own alerts, excluding Next's route announcer.
 *
 * Next injects a permanently-present `role="alert"` element for route change
 * announcements, so a bare `getByRole('alert')` is ambiguous in strict mode.
 */
export function appAlerts(page: Page) {
  return page.getByRole('alert').locator('visible=true').filter({ hasNotText: /^$/ });
}

/**
 * Revokes the current session server-side while leaving the cookie in place.
 *
 * The API origin is passed in from Node: `process` does not exist inside
 * page.evaluate, and referencing it there fails at runtime rather than at
 * compile time — which is how the first version of this helper failed.
 */
export async function signOutViaApi(page: Page): Promise<void> {
  await page.evaluate(async (apiUrl) => {
    const csrf = document.cookie
      .split('; ')
      .find((c) => c.startsWith('atlas_csrf='))
      ?.split('=')[1];
    await fetch(`${apiUrl}/api/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': decodeURIComponent(csrf ?? '') },
    });
  }, API_URL);
}

/** Opens a tenant page using an already-authenticated context. */
export async function openTenant(page: Page, slug: string, sub = ''): Promise<void> {
  await page.goto(`/app/${slug}${sub}`);
  await expectLoaded(page);
}

/**
 * Asserts the page does not scroll sideways.
 *
 * A horizontally scrolling page is the single most common responsive failure
 * and the easiest to miss, because it looks fine until the viewport narrows.
 * A table may scroll inside its own container; the document may not.
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, 'document scrolls horizontally').toBeLessThanOrEqual(0);
}

/** Every route in the tenant shell, from docs/screen-inventory.md. */
export function tenantRoutes(slug: string): Array<{ name: string; path: string }> {
  return [
    { name: 'Overview', path: `/app/${slug}` },
    { name: 'Projects', path: `/app/${slug}/projects` },
    { name: 'Work items', path: `/app/${slug}/work-items` },
    { name: 'Teams', path: `/app/${slug}/teams` },
    { name: 'Workspaces', path: `/app/${slug}/workspaces` },
    { name: 'Members', path: `/app/${slug}/members` },
    { name: 'Activity', path: `/app/${slug}/activity` },
    { name: 'API keys', path: `/app/${slug}/api-keys` },
    { name: 'Settings', path: `/app/${slug}/settings` },
  ];
}
