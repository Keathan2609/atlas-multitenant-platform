import { test as setup } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNTS, PASSWORD, STATE_DIR, stateFor, type Role } from './support';

/**
 * Signs in once per role and saves the session for the rest of the suite.
 *
 * Not merely an optimisation. Login is rate-limited to ten attempts per five
 * minutes per IP-and-email pair — deliberately, see docs/security.md — and a
 * suite where every test signs in exhausts that budget and starts failing with
 * 429s that look like application bugs. The first version of this suite did
 * exactly that.
 *
 * Sign-in itself is still exercised through the real form: by this file, and
 * by the tests in regressions.spec.ts that are specifically about it.
 */

const ROLES: Role[] = ['owner', 'viewer'];

for (const role of ROLES) {
  setup(`authenticate as ${role}`, async ({ page }) => {
    fs.mkdirSync(STATE_DIR, { recursive: true });

    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(ACCOUNTS[role]);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The owner belongs to two organizations and lands on the picker; everyone
    // else has one and goes straight in.
    await page.waitForURL(/\/(app|organizations)\b/, { timeout: 30_000 });

    await page.context().storageState({ path: path.resolve(stateFor(role)) });
  });
}
