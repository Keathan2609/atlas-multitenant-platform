import { expect, test } from '@playwright/test';
import {
  ACCOUNTS,
  ORG,
  PASSWORD,
  appAlerts,
  openTenant,
  signIn,
  signOutViaApi,
  stateFor,
} from './support';

/**
 * Regressions.
 *
 * One test per defect found during the manual browser pass
 * (docs/verification-log.md). Each of these would have failed against the code
 * as it was, which is the only property that makes a regression test worth
 * keeping.
 */

test.describe('account switching does not leak cached data', () => {
  // Starts from the saved owner session rather than signing in again. Login is
  // rate-limited per IP-and-email, and a suite that signs in as the same
  // account in every test exhausts that budget and starts failing with 429s
  // that look like application bugs. Only the switch itself needs to be real.
  test.use({ storageState: stateFor('owner') });

  // The defect: sign-out cleared the React Query cache but sign-in did not, so
  // signing in as a second account while the first still had a session showed
  // the first account's organizations for the whole staleTime window.
  test('signing in as a different account shows only that account @desktop-only', async ({
    page,
  }) => {
    await page.goto('/organizations');
    await expect(page.getByText('Meridian Labs')).toBeVisible();

    // Straight to sign-in without signing out — the exact path that leaked.
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(ACCOUNTS.member);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/app\//, { timeout: 30_000 });

    // The member belongs to Northstar only. Meridian must not appear from the
    // previous account's cache anywhere on the page.
    await expect(page.getByText('Meridian Labs')).toHaveCount(0);
    await expect(page.getByText('Northstar Systems').first()).toBeVisible();
  });
});

test.describe('dialogs', () => {
  test.use({ storageState: stateFor('owner') });

  // The defect: Radix restores focus to its own Trigger, and these dialogs are
  // opened from ordinary buttons holding state, so closing dropped focus onto
  // <body> and the next Tab restarted from the top of the page.
  test('closing returns focus to the control that opened it @desktop-only', async ({ page }) => {
    await openTenant(page, ORG.northstar, '/workspaces');

    const trigger = page.getByRole('button', { name: 'New workspace' });
    await trigger.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Focus starts inside the dialog.
    await expect(dialog.getByLabel('Name')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await expect(trigger).toBeFocused();
  });

  test('escape closes without committing anything @desktop-only', async ({ page }) => {
    await openTenant(page, ORG.northstar, '/workspaces');
    // Count only once the table is on screen — counting during navigation
    // picks up whatever the previous route was still showing.
    await expect(page.getByRole('table')).toBeVisible();
    const before = await page.getByRole('row').count();

    await page.getByRole('button', { name: 'New workspace' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Abandoned workspace');
    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('row')).toHaveCount(before);
    await expect(page.getByText('Abandoned workspace')).toHaveCount(0);
  });
});

test.describe('mobile navigation', () => {
  test.use({ storageState: stateFor('owner') });

  // The defect: the drawer was parked off-screen with `translate` alone, so
  // every link stayed focusable and announced. Tabbing moved focus somewhere
  // invisible.
  test('the closed drawer is out of the tab order', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the drawer only exists below the sidebar breakpoint');

    await openTenant(page, ORG.northstar);

    const drawerVisibility = await page.evaluate(() => {
      const aside = document.querySelector('aside');
      return aside ? getComputedStyle(aside).visibility : null;
    });
    expect(drawerVisibility, 'closed drawer must be visibility:hidden').toBe('hidden');

    // visibility:hidden removes descendants from the tab order; assert the
    // behaviour rather than trusting the computed style alone.
    await page.locator('body').press('Tab');
    const focusedInsideDrawer = await page.evaluate(
      () => document.activeElement?.closest('aside') !== null,
    );
    expect(focusedInsideDrawer, 'focus entered the closed drawer').toBe(false);
  });

  test('the drawer opens and navigates', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the drawer only exists below the sidebar breakpoint');

    await openTenant(page, ORG.northstar);
    await page.getByRole('button', { name: 'Open navigation' }).click();

    const projects = page.getByRole('link', { name: 'Projects' });
    await expect(projects).toBeVisible();
    await projects.click();

    await expect(page).toHaveURL(new RegExp(`/app/${ORG.northstar}/projects$`));
  });
});

test.describe('tables', () => {
  test.use({ storageState: stateFor('owner') });

  // The defect: under `table-layout: auto`, a nowrap cell sets its column's
  // intrinsic width instead of being clipped, so a long description widened
  // the table past its own scroller.
  test('rows are a uniform height and columns respect their widths', async ({ page }) => {
    await openTenant(page, ORG.northstar, '/work-items');
    await expect(page.getByRole('table')).toBeVisible();

    const heights = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('tbody tr')];
      return [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))];
    });

    // A wrapped cell makes one row taller than its neighbours, which is the
    // one thing a dense table cannot afford.
    expect(heights, `row heights varied: ${heights.join(', ')}`).toHaveLength(1);
  });

  test('a long value is clipped rather than widening the table', async ({ page }) => {
    await openTenant(page, ORG.northstar, '/work-items');
    await expect(page.getByRole('table')).toBeVisible();

    const truncated = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('tbody .truncate-cell')];
      return cells.some((c) => c.scrollWidth > c.clientWidth);
    });

    // The seed deliberately includes titles too long for the column.
    expect(truncated, 'expected at least one clipped cell in the seeded data').toBe(true);
  });
});

test.describe('sign-in', () => {
  // The defect: with a stale session cookie present, AuthGuard resolved a
  // session on the public login route and enforced CSRF, returning 403 with
  // advice to reload — which could not help, because the cookie survived it.
  test('works while a stale session cookie is present @desktop-only', async ({ page }) => {
    // The admin, because nothing else in the suite signs in as them — see the
    // rate-limit note above.
    await signIn(page, 'admin');

    // Revoke the session server-side; the browser keeps the cookie.
    await signOutViaApi(page);

    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(ACCOUNTS.admin);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(/\/app\//, { timeout: 30_000 });
    await expect(appAlerts(page)).toHaveCount(0);
  });

  test('an unknown account is indistinguishable from a wrong password @desktop-only', async ({
    page,
  }) => {
    // Deliberately an address with no account. The response must be the same
    // one a real account with the wrong password gets, or the difference is an
    // enumeration oracle — see docs/security.md § user enumeration. Using a
    // nonexistent address also spends nobody's rate-limit budget.
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('nobody@northstar.example');
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const alert = appAlerts(page).first();
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(/do not match/i);
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
