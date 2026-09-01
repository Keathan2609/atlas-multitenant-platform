import { expect, test } from '@playwright/test';
import {
  ORG,
  expectLoaded,
  expectNoHorizontalOverflow,
  openTenant,
  stateFor,
  tenantRoutes,
} from './support';

/**
 * Every surface, at every viewport.
 *
 * The manual pass had to walk these by hand. What is asserted per route is
 * deliberately shallow — it renders, it says who it is, it does not scroll
 * sideways, it logs no errors — because depth belongs in the regression and
 * workflow suites. The value here is breadth: no route may silently break.
 */

// Serial, sharing one page. Signing in once and navigating is not just faster
// than nine fresh sign-ins — it is closer to how the product is used, and it
// exercises client-side navigation rather than nine cold loads.
test.describe.configure({ mode: 'serial' });

test.describe('every tenant surface', () => {
  let page: import('@playwright/test').Page;
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ storageState: stateFor('owner') });

    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      // Aborted requests are TanStack Query cancelling a superseded fetch.
      const failure = request.failure()?.errorText ?? '';
      if (!failure.includes('ERR_ABORTED')) failedRequests.push(`${request.url()} ${failure}`);
    });

    await openTenant(page, ORG.northstar);
  });

  test.afterAll(async () => {
    await page.close();
  });

  for (const route of tenantRoutes(ORG.northstar)) {
    test(`${route.name} renders`, async () => {
      consoleErrors.length = 0;
      failedRequests.length = 0;

      await page.goto(route.path);
      await expectLoaded(page);

      // Nothing on a working page should be an unhandled failure state.
      await expect(page.getByText('Something went wrong')).toHaveCount(0);

      await expectNoHorizontalOverflow(page);

      expect(consoleErrors, `console errors on ${route.path}`).toEqual([]);
      expect(failedRequests, `failed requests on ${route.path}`).toEqual([]);
    });
  }
});

test.describe('surfaces outside the tenant shell', () => {
  test.use({ storageState: stateFor('owner') });

  test('the profile screen renders and is reachable @desktop-only', async ({ page }) => {
    await page.goto('/profile');

    await expect(page.getByRole('heading', { level: 1, name: 'Dana Whitfield' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Active sessions' })).toBeVisible();
    // The current device must be identifiable among the sessions.
    await expect(page.getByText('This device', { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('the organization picker lists both tenants @desktop-only', async ({ page }) => {
    await page.goto('/organizations');

    await expect(page.getByRole('link', { name: /Northstar Systems/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Meridian Labs/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('sign-up renders its three fields', async ({ page }) => {
    await page.goto('/sign-up');
    await expect(page.getByLabel('Name')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('error surfaces', () => {
  test.use({ storageState: stateFor('owner') });

  test('an unknown organization does not 500 @desktop-only', async ({ page }) => {
    await page.goto('/app/no-such-organization');

    await expect(page.getByText('Organization not found')).toBeVisible();
    // It offers a way out rather than stranding the visitor.
    await expect(page.getByText('Northstar Systems')).toBeVisible();
  });

  test('a malformed project id is a not-found, not a crash @desktop-only', async ({ page }) => {
    await page.goto(`/app/${ORG.northstar}/projects/not-a-uuid`);

    await expect(page.getByText('This project does not exist')).toBeVisible();
  });

  test('a well-formed but absent project id is the same @desktop-only', async ({ page }) => {
    await page.goto(`/app/${ORG.northstar}/projects/01a05825-0000-7000-8000-000000000000`);

    await expect(page.getByText('This project does not exist')).toBeVisible();
  });
});

test.describe('a viewer sees a read-only product', () => {
  test.use({ storageState: stateFor('viewer') });

  // Presentation only — the API refuses these regardless, and the integration
  // suite proves that. What is asserted here is that the interface does not
  // offer doors that will not open.
  test('no administrative controls are offered @desktop-only', async ({ page }) => {
    await openTenant(page, ORG.northstar, '/workspaces');
    await expect(page.getByRole('button', { name: 'New workspace' })).toHaveCount(0);
    // The list itself is still readable.
    await expect(page.getByRole('table')).toBeVisible();

    await page.goto(`/app/${ORG.northstar}/projects`);
    await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0);
  });

  test('a forbidden area explains itself @desktop-only', async ({ page }) => {
    await openTenant(page, ORG.northstar, '/settings');

    await expect(page.getByText(/do not have access/i)).toBeVisible();
  });

  test('settings is absent from the navigation @desktop-only', async ({ page }) => {
    await openTenant(page, ORG.northstar);
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
  });
});

test.describe('keyboard access', () => {
  test.use({ storageState: stateFor('owner') });

  test('the skip link is the first stop and reaches the content @desktop-only', async ({
    page,
  }) => {
    await openTenant(page, ORG.northstar);

    await page.locator('body').press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();

    await skip.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('focus is always visible @desktop-only', async ({ page }) => {
    await openTenant(page, ORG.northstar, '/projects');

    // Walk into the navigation and confirm the ring is drawn, not suppressed.
    await page.locator('body').press('Tab');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');

    const indicator = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        // A component may draw its own ring instead of an outline.
        boxShadow: style.boxShadow,
      };
    });

    expect(indicator).not.toBeNull();
    const hasOutline = indicator!.outlineStyle !== 'none' && indicator!.outlineWidth !== '0px';
    const hasOwnRing = indicator!.boxShadow !== 'none';
    expect(hasOutline || hasOwnRing, 'focused element has no visible indicator').toBe(true);
  });
});
