import { test, expect } from '@playwright/test';

/**
 * Critical-path check: an authenticated session lands on the real dashboard,
 * not stuck on a spinner or redirected to /onboarding. This is the exact
 * failure mode from today's incident (RuntimeError: can't start new thread
 * causing a request to hang) — this test exists to catch it automatically
 * instead of discovering it by manually watching a spinner.
 */
test('authenticated staff session reaches dashboard, not onboarding', async ({ page }) => {
  await page.goto('/admin');

  // Fail fast and specifically if we get bounced to onboarding.
  await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 10_000 });

  // TODO: replace with a real selector once you confirm the dashboard's
  // stable root element (data-testid preferred over text/class selectors
  // so this doesn't break on copy or style changes).
  await expect(page.locator('[data-testid="dashboard-root"]')).toBeVisible({
    timeout: 10_000,
  });
});
