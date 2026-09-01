import { defineConfig, devices } from '@playwright/test';

// Deliberately does NOT load the root .env. Doing so put NODE_ENV=development
// into this process, which Playwright then passed to `next build` — and a
// production build under a development NODE_ENV fails while prerendering the
// error page. Next reads its own env files from apps/web; this config needs
// only a URL.
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3000';

/**
 * End-to-end tests.
 *
 * These exist because of what the manual browser pass found: fourteen defects
 * in code that was typecheck-clean, lint-clean and rendered without error.
 * Five of them — a client cache leaking one account's data to the next, focus
 * lost when a dialog closes, an off-screen drawer still in the tab order, a
 * table unable to truncate, a missing Suspense boundary — are invisible to
 * every other kind of test in this repository. See docs/verification-log.md.
 *
 * The suite therefore asserts *observable behaviour in a browser* and nothing
 * that a unit or integration test already covers. It does not re-check
 * authorization rules; the integration suite does that against the API
 * directly, which is where the real control lives.
 *
 * It drives a **production build**, not the dev server. That is not a detail:
 * against `next dev` the first hit on each route triggers a compile, which
 * pushed a full run past thirty minutes and timed out most of it. It also
 * means the suite exercises what actually ships — including the Suspense
 * boundary whose absence only breaks `next build`.
 *
 * The database is not managed here. The suite needs seeded data, so it expects
 * the Docker stack up, migrations applied and `pnpm db:seed` run; a suite that
 * provisioned its own database would either reseed on every run or assert
 * against an empty one.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',

  // The seeded database is shared state: two workers signing in as the same
  // account and mutating the same organization would interfere. Serial, for
  // the same reason the API integration suite is serial.
  fullyParallel: false,
  workers: 1,

  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: WEB_URL,
    // Artifacts only for failures — a passing run should leave nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  // Port 3000 specifically: the API's CORS_ORIGINS allows that origin and no
  // other, so a suite on a different port would have every request rejected.
  webServer: {
    command: 'pnpm build && pnpm start',
    url: WEB_URL,
    // Explicit, not inherited. `next build` under NODE_ENV=development fails
    // prerendering /500 with "<Html> should not be imported outside of
    // pages/_document" — an error that says nothing about its real cause.
    env: { NODE_ENV: 'production' },
    // A cold production build is slow; this is the build plus boot.
    timeout: 300_000,
    // Locally, reuse whatever is already serving 3000 — a developer with the
    // dev server up should not wait for a build. CI always builds.
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },

  // Generous, because the first navigation in a run pays for cold caches on
  // both the server and the database.
  timeout: 45_000,
  expect: { timeout: 10_000 },

  projects: [
    // Signs in once per role and saves the session. Everything else reuses it,
    // which keeps the suite inside the login rate limit — see e2e/auth.setup.ts.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      // Not a token gesture at responsiveness: three of the defects this suite
      // pins only appear below the sidebar breakpoint.
      name: 'mobile',
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'] },
      // grepInvert, not testIgnore: testIgnore matches file paths, so a
      // `@desktop-only` tag in a test *title* does not exclude it and the
      // whole desktop suite ran on a phone viewport.
      grepInvert: /@desktop-only/,
    },
  ],
});
