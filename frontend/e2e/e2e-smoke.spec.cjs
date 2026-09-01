// e2e-smoke.spec.js
// ─────────────────────────────────────────────────────────────────────────
// One-shot end-to-end smoke test for the AttendancePro dashboard.
//
// What it does:
//   1. Loads a saved logged-in session (see SETUP below — you only log in
//      by hand ONCE, not on every run).
//   2. Visits the dashboard home page.
//   3. Finds every internal nav link on the page (Overview, Branches,
//      Attendance, Payroll, etc.) automatically — no need to hardcode
//      routes or guess URLs.
//   4. Clicks into each one, waits for network to settle, and records:
//        - any XHR/fetch request that came back with status >= 400
//        - any browser console error
//        - a screenshot of the page
//   5. Prints a pass/fail summary at the end and exits non-zero if
//      anything failed, so you can wire this into a "build then test"
//      habit.
//
// SETUP (one-time):
//   cd frontend
//   npm install -D @playwright/test
//   npx playwright install chromium
//
//   # Record a logged-in session once:
//   npx playwright codegen --save-storage=auth.json https://attendancepro.qintellecttechnologies.com/login
//   # -> A browser opens. Log in normally with your real credentials.
//   # -> Once you see the dashboard, just close the browser window.
//   # -> This saves cookies + localStorage (including dashboardAuthToken)
//   #    into auth.json, so future runs skip the login form entirely.
//
// RUN:
//   npx playwright test e2e-smoke.spec.js
//
// Re-run after every deploy. auth.json is reusable until your session
// token expires — if the test suddenly shows every page as "not logged
// in", just re-run the codegen step above to refresh it.
// ─────────────────────────────────────────────────────────────────────────

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.E2E_BASE_URL || 'https://attendancepro.qintellecttechnologies.com';
const STORAGE_STATE = process.env.E2E_STORAGE_STATE || 'auth.json';
const SCREENSHOT_DIR = 'e2e-screenshots';

if (!fs.existsSync(STORAGE_STATE)) {
  throw new Error(
    `\n\nNo saved login found at "${STORAGE_STATE}".\n` +
    `Run this once first:\n\n` +
    `  npx playwright codegen --save-storage=${STORAGE_STATE} ${BASE_URL}/login\n\n` +
    `Log in in the browser that opens, then close it.\n`
  );
}

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

test.use({ storageState: STORAGE_STATE, baseURL: BASE_URL });

/** @type {{page: string, url: string, failures: string[], consoleErrors: string[], screenshot: string}[]} */
const report = [];

test('crawl every nav link and check for broken requests / console errors', async ({ page, context }) => {
  test.setTimeout(5 * 60 * 1000); // 5 min ceiling for the whole crawl

  // 1. Load the dashboard home page.
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Sanity check: did we actually land on the dashboard, or bounce to /login?
  if (page.url().includes('/login')) {
    throw new Error(
      'Landed on the login page — the saved session in auth.json has ' +
      'expired or is invalid. Re-run the codegen step to refresh it.'
    );
  }

  // 2. Discover every internal nav link on the page. We look broadly
  //    (sidebar + top tabs) rather than hardcoding selectors, since we
  //    don't know your exact DOM structure — this just grabs every <a>
  //    that points at the same origin and isn't an obvious non-page link
  //    (mailto:, tel:, external, #anchors, logout).
  const hrefs = await page.$$eval('a[href]', (as) =>
    as
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && h.startsWith('/'))
      .filter((h) => !/logout|signout/i.test(h))
  );
  const uniqueRoutes = [...new Set(hrefs)];

  console.log(`Discovered ${uniqueRoutes.length} internal routes:`, uniqueRoutes);

  if (uniqueRoutes.length === 0) {
    console.warn(
      'No <a href="/..."> links found on the dashboard. If your nav uses ' +
      'JS-driven navigation (onClick handlers instead of real <a> tags), ' +
      'this auto-discovery won\'t find them — see the ROUTES override note ' +
      'at the bottom of this file.'
    );
  }

  // 3. Visit each route, recording failures.
  for (const route of uniqueRoutes) {
    const failedRequests = [];
    const consoleErrors = [];

    const onResponse = (res) => {
      const t = res.request().resourceType();
      if ((t === 'xhr' || t === 'fetch') && res.status() >= 400) {
        failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`);
      }
    };
    const onConsole = (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    };
    const onPageError = (err) => consoleErrors.push(`Uncaught: ${err.message}`);

    page.on('response', onResponse);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    try {
      await page.goto(route, { waitUntil: 'networkidle', timeout: 20000 });
    } catch (e) {
      failedRequests.push(`NAVIGATION TIMEOUT/ERROR: ${e.message}`);
    }

    // Give any late XHRs (e.g. debounced search, polling) a moment to fire.
    await page.waitForTimeout(1500);

    const safeName = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root';
    const screenshotPath = path.join(SCREENSHOT_DIR, `${safeName}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    page.off('response', onResponse);
    page.off('console', onConsole);
    page.off('pageerror', onPageError);

    report.push({
      page: route,
      url: page.url(),
      failures: failedRequests,
      consoleErrors,
      screenshot: screenshotPath,
    });
  }

  // 4. Print the report.
  console.log('\n' + '='.repeat(70));
  console.log('E2E SMOKE TEST REPORT');
  console.log('='.repeat(70));

  let anyFailures = false;
  for (const r of report) {
    const status = r.failures.length === 0 && r.consoleErrors.length === 0 ? 'PASS' : 'FAIL';
    if (status === 'FAIL') anyFailures = true;
    console.log(`\n[${status}] ${r.page}`);
    if (r.failures.length) {
      console.log('  Failed network requests:');
      r.failures.forEach((f) => console.log('    - ' + f));
    }
    if (r.consoleErrors.length) {
      console.log('  Console errors:');
      r.consoleErrors.forEach((c) => console.log('    - ' + c));
    }
    console.log(`  Screenshot: ${r.screenshot}`);
  }
  console.log('\n' + '='.repeat(70));
  console.log(anyFailures ? 'RESULT: ISSUES FOUND — see above' : 'RESULT: ALL PAGES CLEAN');
  console.log('='.repeat(70) + '\n');

  // Also dump machine-readable JSON for later diffing between runs.
  fs.writeFileSync('e2e-report.json', JSON.stringify(report, null, 2));

  expect(anyFailures, 'One or more pages had failed requests or console errors — see printed report above').toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────
// NOTE: if your sidebar/nav doesn't use real <a href="..."> tags (e.g. it's
// all onClick + router.push in React), auto-discovery above will find
// nothing. In that case, replace the `uniqueRoutes` block with a manual
// list, e.g.:
//
//   const uniqueRoutes = [
//     '/admin', '/admin/branches', '/admin/staff', '/admin/attendance',
//     '/admin/leave', '/admin/overtime', '/admin/payroll', '/admin/reports',
//     '/admin/cctv', '/admin/live-attendance', '/admin/settings',
//   ];
//
// Adjust to your app's real paths (check the URL bar as you click each
// nav item once, by hand, the very last time).
// ─────────────────────────────────────────────────────────────────────────
