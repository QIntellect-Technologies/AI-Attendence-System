import { test, expect } from '@playwright/test';
import { ENDPOINTS } from './endpoints';
import { loginAndGetToken, authHeaders } from './auth';

const TEST_EMAIL = process.env.QI_TEST_EMAIL;
const TEST_PASSWORD = process.env.QI_TEST_PASSWORD;
const TEST_ORG_ID = process.env.QI_TEST_ORG_ID;

test.describe('attendance API contract', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    if (!TEST_EMAIL || !TEST_PASSWORD || !TEST_ORG_ID) {
      throw new Error(
        'QI_TEST_EMAIL, QI_TEST_PASSWORD, and QI_TEST_ORG_ID env vars are all required — never point these at production credentials/org.'
      );
    }
    token = await loginAndGetToken(request, TEST_EMAIL, TEST_PASSWORD);
  });

  test('bootstrap returns org config for test org', async ({ request }) => {
    const res = await request.get(ENDPOINTS.bootstrap, {
      headers: authHeaders(token),
      params: { organization_id: TEST_ORG_ID },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  // Regression guard for today's exact bug class: the real registered
  // path is /api/attendance/today. If a frontend change ever calls this
  // without the /api prefix again, THIS test still passes (it hits the
  // backend directly) — it's the grep in the README that catches the
  // frontend-side regression. This test's job is just confirming the
  // backend contract itself hasn't drifted.
  test("attendance today resolves and returns an array", async ({ request }) => {
    const res = await request.get(ENDPOINTS.attendanceToday, {
      headers: authHeaders(token),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('staff directory returns an array for the test org', async ({ request }) => {
    const res = await request.get(ENDPOINTS.staffList, {
      headers: authHeaders(token),
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('manual attendance record can be created for a real staff member', async ({ request }) => {
    // Needs a real staff_id from the test org — pull one from the staff
    // directory rather than hardcoding one that might get archived/deleted.
    const staffRes = await request.get(ENDPOINTS.staffList, { headers: authHeaders(token) });
    const staff = await staffRes.json();
    test.skip(!staff.length, 'No staff members in test org yet — seed one to enable this test.');

    const res = await request.post(ENDPOINTS.attendanceManual, {
      headers: authHeaders(token),
      data: {
        staff_id: staff[0].id,
        check_in: new Date().toISOString(),
        arrival_status: 'on_time',
        notes: 'Created by automated regression suite',
      },
    });
    // api_create_manual_attendance_record is Supabase/UUID-org only —
    // 400 with 'unsupported_organization' is the correct response for a
    // legacy numeric test org, not a failure of this test.
    if (res.status() === 400) {
      const body = await res.json();
      test.skip(body.error === 'unsupported_organization', 'Test org is legacy SQLite, not Supabase.');
    }
    expect(res.status(), await res.text()).toBe(201);
  });

  test('known routes resolve (no prefix-drift regressions)', async ({ request }) => {
    const routesToCheck = [ENDPOINTS.attendanceToday, ENDPOINTS.staffList, ENDPOINTS.leaves, ENDPOINTS.overtime];
    for (const path of routesToCheck) {
      const res = await request.get(path, { headers: authHeaders(token) });
      expect(res.status(), `${path} returned ${res.status()}`).not.toBe(404);
    }
  });
});

test('health check responds without auth', async ({ request }) => {
  const res = await request.get(ENDPOINTS.health);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('healthy');
});
