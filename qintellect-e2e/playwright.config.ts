import { defineConfig, devices } from '@playwright/test';

/**
 * QIntellect regression suite config.
 *
 * Design:
 *  - Two tiers, split by directory: tests/api (fast, contract-level) and
 *    tests/e2e (slower, UI critical paths). Run them separately in CI so a
 *    slow UI failure doesn't block the fast feedback loop.
 *  - One project per role. Each reuses a storageState captured once via
 *    `npx playwright codegen --save-storage=auth/<role>.json <BASE_URL>`,
 *    so tests never re-run the login flow.
 *  - BASE_URL and TEST_ORG_ID come from env so the same suite can point at
 *    the test org today and, later, be pointed elsewhere without editing
 *    test files.
 */

const BASE_URL = process.env.QI_BASE_URL ?? 'https://attendancepro.qintellecttechnologies.com';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      // No storageState here on purpose: auth is a Bearer JWT in the
      // Authorization header, not a cookie (see app.py's CORS comment
      // and mint_dashboard_token). API-tier tests log in for themselves
      // via tests/api/auth.ts's loginAndGetToken() and attach the token
      // per-request — storageState alone doesn't carry a header into
      // Playwright's `request` fixture the way it does for a real
      // browser page reading localStorage.
      name: 'api',
      testDir: './tests/api',
    },
    {
      name: 'e2e-staff',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'], storageState: 'auth/staff.json' },
    },
    {
      name: 'e2e-admin',
      testDir: './tests/e2e',
      use: { ...devices['Desktop Chrome'], storageState: 'auth/admin.json' },
    },
  ],
});
