/**
 * clientApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared low-level HTTP plumbing for client-dashboard pages that talk to
 * Flask's /api/client/* routes (Settings.tsx, OnboardingWizard.tsx, and any
 * future client-scoped page).
 *
 * Scope note: this module intentionally does NOT export domain types like
 * BootstrapResponse, Branch, GroupItem, etc. Settings.tsx and
 * OnboardingWizard.tsx have genuinely different shapes for those (e.g.
 * personFamily is required post-onboarding but optional during onboarding).
 * Forcing a single shared domain type across both would either loosen
 * Settings' stricter guarantees or require fighting generics to reconcile
 * fields that mean different things in each flow. Sharing only the fetch/auth
 * layer avoids that false-DRY trap while still eliminating the real
 * duplication: both files previously carried byte-identical copies of
 * getClientAuthToken/fetchClientJson, and both had the same bug in
 * loadClientBootstrap (a guaranteed-to-400 bare call before falling back to
 * the org_id-qualified one).
 */

export function getClientAuthToken(): string | null {
  try {
    return (
      // Same key as modules/staff/api/staffApi.ts's
      // getDashboardAuthToken/setDashboardAuthToken, src/api.ts, and
      // apiClient.ts — checked first since it's the token
      // client_dashboard_auth.mint_dashboard_token actually issues today.
      // The legacy keys below are kept as fallbacks for any older
      // /api/client/* auth path this file predates.
      localStorage.getItem("dashboardAuthToken") ||
      localStorage.getItem("client_access_token") ||
      localStorage.getItem("access_token") ||
      localStorage.getItem("auth_token") ||
      localStorage.getItem("token")
    );
  } catch {
    return null;
  }
}

export async function fetchClientJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const token = getClientAuthToken();
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const data = await response.json().catch(() => ({}));
  const failedByEnvelope =
    typeof data === "object" &&
    data !== null &&
    "success" in data &&
    (data as { success?: unknown }).success === false;

  if (!response.ok || failedByEnvelope) {
    throw new Error(
      String(
        (data as { message?: unknown; error?: unknown }).message ||
          (data as { message?: unknown; error?: unknown }).error ||
          "Request failed.",
      ),
    );
  }

  return data as T;
}

/**
 * Loads /api/client/bootstrap scoped to a specific organization.
 *
 * organization_id is always sent explicitly. The backend requires it
 * unconditionally (same pattern as /api/tenant/config) — there is no
 * "session-derived org" mode on this route, so a bare call without it is
 * guaranteed to 400. Both call sites (Settings.tsx, OnboardingWizard.tsx)
 * already guard on organizationId being present before calling this, so no
 * fallback/retry branch is needed here.
 *
 * Generic over T so each caller supplies its own BootstrapResponse shape
 * (Settings.tsx and OnboardingWizard.tsx intentionally have different ones —
 * see file header).
 */
export async function loadClientBootstrap<T>(
  organizationId: string | number,
): Promise<T> {
  return fetchClientJson<T>(
    `/api/client/bootstrap?organization_id=${encodeURIComponent(String(organizationId))}`,
  );
}