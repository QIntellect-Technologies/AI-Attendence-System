/**
 * Auth is a Bearer JWT in the Authorization header (see app.py's
 * mint_dashboard_token / require_client_dashboard_auth and the CORS
 * comment: "the dashboard JWT travelling in an Authorization header,
 * not a cookie"). storageState alone does NOT carry this into API
 * request-context calls — a browser page reads the token out of
 * localStorage and attaches it itself; Playwright's `request` fixture
 * does not. So the API tier authenticates by calling POST /api/login
 * directly and reusing the returned token, rather than relying on
 * storageState like the UI tier does.
 *
 * TODO(IsaBella): set real test-org credentials via env vars before
 * running — never hardcode credentials in this file.
 */
import { APIRequestContext } from '@playwright/test';

export async function loginAndGetToken(
  request: APIRequestContext,
  email: string,
  password: string
): Promise<string> {
  const res = await request.post('/api/login', {
    data: { email, password },
  });
  if (!res.ok()) {
    throw new Error(`Login failed for ${email}: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json();
  if (!body.token) {
    // api_login() returns token: null when the account has no organization
    // yet (pre-onboarding) — a clear signal to fix the test account, not a
    // transport failure, so this is a distinct error message on purpose.
    throw new Error(
      `Login succeeded for ${email} but no token was returned — account may be pre-onboarding.`
    );
  }
  return body.token as string;
}

export function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}
