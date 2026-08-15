/**
 * src/api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for every Flask endpoint.
 *
 * BASE_URL is intentionally empty — Vite's dev-server proxy rewrites all
 * "/api/..." requests to "http://127.0.0.1:5000/api/..." transparently,
 * so there is zero CORS exposure in development.
 *
 * For production, set BASE_URL to your deployed Flask origin:
 *   export const BASE_URL = "https://api.yourcompany.com";
 *
 * Fixes applied (2026-06-24):
 *   • profilePhotoUrl: UUID users now return /client_profile_photos/<id>
 *     instead of an empty string, matching the Vite proxy rule and
 *     Flask's /client_profile_photos static route.
 *   • getUser: now carries organization_id so the backend can scope the
 *     lookup to the correct org DB. Falls back to localStorage if not supplied.
 *   • markUserPresent: now sends organization_id in the POST body.
 *   • getSalaryConfig: now carries organization_id as a query param.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RAW_API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export const BASE_URL =
  RAW_API_BASE_URL && RAW_API_BASE_URL !== "/api"
    ? RAW_API_BASE_URL.replace(/\/$/, "")
    : ""; // empty = same-origin /api through Vite proxy

// Same storage key as modules/staff/api/staffApi.ts's
// getDashboardAuthToken/setDashboardAuthToken and apiClient.ts's
// AUTH_TOKEN_STORAGE_KEY — duplicated as a plain string constant rather
// than imported, since staffApi.ts already imports BASE_URL/User FROM this
// file; importing back from staffApi.ts here would be circular. If this
// key ever changes, it must change in all three places — grep
// "dashboardAuthToken" before renaming any of them.
const DASHBOARD_AUTH_TOKEN_KEY = "dashboardAuthToken";

export function dashboardAuthHeaders(): HeadersInit {
  try {
    const token = localStorage.getItem(DASHBOARD_AUTH_TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

// ─── Generic fetch wrapper ────────────────────────────────────────────────────

async function http<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...dashboardAuthHeaders(),
      ...(options?.headers ?? {}),
    },
    ...options,
  });
  if (!res.ok) {
    // Generic fallback — never surface raw transport text (e.g. a bare
    // "METHOD NOT ALLOWED"/"NOT FOUND" from res.statusText, which shows up
    // whenever the server responds with a non-JSON error page instead of
    // the expected {message} body, such as a route/method mismatch).
    let msg = `Something went wrong (${res.status}). Please try again.`;
    try {
      const errorBody = await res.json();
      msg = errorBody.error ?? errorBody.message ?? msg;
    } catch {
      /* Response wasn't JSON — keep the generic message above. */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ─── Domain types (mirror your SQLite schema exactly) ────────────────────────

export interface User {
  id: number | string;
  name: string;
  email: string;
  role: string; // "admin" | "staff"
  department: string;
  phone: string;
  position: string;
  salary: number;
  join_date: string; // "YYYY-MM-DD"
  cnic?: string;
  notes?: string;
  is_active: number; // 1 | 0
  created_at: string;
  // ── Staff-management extensions ──────────────────────────────────────────
  shift?: string; // "Morning" | "Evening" | "Night" | "Custom"
  duty_start?: string; // "HH:MM"
  duty_end?: string; // "HH:MM"
  staff_type?: "office" | "field";
  access_modules?: string[];

  // ── Organization / staff-directory fields ────────────────────────────────
  organization_id?: number | string | null;
  company_logo?: string | null;
  branch_id?: number | string | null;
  branch_name?: string | null;
  employee_id?: string | null;
  status?: "active" | "inactive" | "pending";
  shift_id?: string | null;
  shift_label?: string | null;
  profile_image_url?: string | null;
  profile_image_name?: string | null;
  training_video_url?: string | null;
  training_video_name?: string | null;
}

export interface OnboardingBranch {
  id: number;
  name: string;
  city: string;
}

export interface OnboardingDepartment {
  id: number;
  name: string;
}

export interface OnboardingRole {
  id: number;
  name: string;
  level: number;
}

// branchId typed as TenantId — will be UUID once Supabase migration lands.
export interface OnboardingCamera {
  id: string;
  branchId: TenantId;
  name: string;
  location: string;
  rtspUrl: string;
  streamPath?: string;
  status?: "Normal" | "Alert" | "Offline";
  lastSeen?: string;
}

export interface OnboardingOrgConfig {
  bizType: string | null;
  orgName: string;
  tagline: string;
  address: string;
  size: string;
  logo?: string | null;
  branches: OnboardingBranch[];
  departments: Record<number, OnboardingDepartment[]>;
  modules: string[];
  roles: Record<number, OnboardingRole[]>;
  cameras: Record<number, OnboardingCamera[]>;
}

export interface OrganizationSummary {
  id: number | string;
  slug: string;
  name: string;
  biz_type: string | null;
  tagline: string;
  address: string;
  size: string;
  logo: string | null;
  db_path: string;
  branch_count: number;
  module_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CompleteOnboardingResponse {
  success: boolean;
  message: string;
  organization?: OrganizationSummary;
  config?: OnboardingOrgConfig;
  dashboard_ready?: boolean;
  requires_onboarding?: boolean;
  owner_user_id?: number | string;
}

function readStoredCurrentUserForOnboarding(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem("currentUser");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const completeOnboarding = (payload: {
  config: OnboardingOrgConfig;
  admin_user_id?: number | string | null;
  user_id?: number | string | null;
  client_user_id?: number | string | null;
  organization_id?: number | string | null;
  org_id?: number | string | null;
  organizationId?: number | string | null;
}) => {
  const storedUser = readStoredCurrentUserForOnboarding();

  const userId =
    payload.user_id ??
    payload.client_user_id ??
    payload.admin_user_id ??
    storedUser?.id ??
    null;

  const organizationId =
    payload.organization_id ??
    payload.org_id ??
    payload.organizationId ??
    storedUser?.organization_id ??
    storedUser?.organizationId ??
    null;

  // Support-created client organizations must complete onboarding through the
  // Supabase-backed endpoint. That endpoint saves client_onboarding_configs and
  // now also mirrors cameras/NVR config into branch_network_configs +
  // branch_cameras for the local attendance node.
  if (organizationId && userId) {
    return http<CompleteOnboardingResponse>("/api/client/onboarding/complete", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        organization_id: organizationId,
        config: payload.config,
      }),
    });
  }

  // Legacy local/dev fallback for old SQLite-only accounts.
  return http<CompleteOnboardingResponse>("/api/onboarding/complete", {
    method: "POST",
    body: JSON.stringify(payload),
  });
};

export const getCurrentOrganization = (user_id?: number | string | null) => {
  const qs = new URLSearchParams();
  if (user_id !== undefined && user_id !== null && String(user_id).trim()) {
    qs.set("user_id", String(user_id));
  }
  return http<CompleteOnboardingResponse>(
    `/api/org/current${qs.toString() ? `?${qs}` : ""}`,
  );
};

export interface AttendanceLog {
  id: number | string;
  user_id: number | string;
  user_name: string;
  confidence: number;
  source: string;
  check_in: string | null;
  check_out: string | null;
  status: string; // "present" | "absent" | "late"
  arrival_status?: string;
  log_date: string; // "YYYY-MM-DD"
  created_at: string;
}

export interface LeaveRequest {
  id: number | string;
  user_id: number | string;
  user_name: string;
  name?: string;
  leave_type: string;
  type?: string;
  start_date: string;
  end_date: string;
  reason: string;
  status: string;
  approved_by: string | null;
  created_at: string;
  updated_at: string;

  branch_id?: number | string | null;
  branch_name?: string | null;
  department?: string | null;
  dept?: string | null;
}

export interface OvertimeRecord {
  id: number | string;
  user_id: number | string;
  user_name: string;
  ot_date: string;
  hours: number;
  reason: string;
  status: string;
  approved_by: string | null;
  created_at: string;
  updated_at?: string;

  branch_id?: number | string | null;
  branch_name?: string | null;
  department?: string | null;
}

export interface SalaryConfig {
  id: number | string;
  user_id: number | string;
  name?: string;
  department?: string;
  position?: string;
  branch_id?: number | string | null;
  branch_name?: string | null;
  basic_salary: number;
  allowances: number;
  deductions: number;
  ot_rate: number;
  effective_from: string | null;
  updated_at: string | null;
  net_pay?: number;
}

export interface LiveDetection {
  name: string;
  timestamp: string;
  confidence: number; // 0–1
  source: string;
  face_crop: string | null; // "data:image/jpeg;base64,…"
  user_id: number | string;
  department: string;
}

export interface SystemHealth {
  status: "healthy" | "degraded" | "error";
  database: "ok" | "error";
  models: "ok" | "error";
  timestamp: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const login = (email: string, password: string) =>
  http<{ success: boolean; user: User }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

export const changePassword = (user_id: TenantId, new_password: string) =>
  http<{ success: boolean }>("/api/change-password", {
    method: "POST",
    body: JSON.stringify({ user_id, new_password }),
  });

// ─── Tenant helpers ───────────────────────────────────────────────────────────

export type TenantId = number | string;

/**
 * Reads the current user's organization_id from localStorage.
 * Used as a last-resort fallback when callers do not pass organization_id
 * explicitly. Prefer passing it explicitly from context.
 */
function getStoredOrganizationId(): string {
  try {
    const raw = localStorage.getItem("currentUser");
    if (!raw) return "";
    const user = JSON.parse(raw) as Record<string, unknown>;
    const orgId =
      user.organization_id ?? user.organizationId ?? user.org_id ?? user.orgId;
    return orgId === undefined || orgId === null ? "" : String(orgId).trim();
  } catch {
    return "";
  }
}

/**
 * Returns true if the value looks like a UUID v1–v5.
 * Used to route requests to the correct backend endpoint (Supabase vs SQLite).
 */
function isUuidLike(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value ?? "").trim(),
  );
}

/**
 * Appends organization_id and branch_id to an existing URLSearchParams.
 * Falls back to localStorage org_id when params does not supply one.
 */
function appendTenantScope(
  qs: URLSearchParams,
  params?: { organization_id?: TenantId | null; branch_id?: TenantId | null },
) {
  const orgId =
    params?.organization_id !== undefined && params.organization_id !== null
      ? String(params.organization_id).trim()
      : getStoredOrganizationId();

  if (orgId) qs.set("organization_id", orgId);

  if (
    params?.branch_id !== undefined &&
    params.branch_id !== null &&
    String(params.branch_id).trim()
  ) {
    qs.set("branch_id", String(params.branch_id));
  }
}

// ─── Staff / Users ─────────────────────────────────────────────────────────────

export const getStaff = (params?: {
  role?: string;
  organization_id?: number | string | null;
  branch_id?: number | string | null;
  user_id?: number | string | null;
}) => {
  const qs = new URLSearchParams();

  const resolvedOrgId =
    params?.organization_id !== undefined &&
    params.organization_id !== null &&
    String(params.organization_id).trim()
      ? String(params.organization_id).trim()
      : getStoredOrganizationId();

  if (params?.role) qs.set("role", params.role);

  // Never call /api/staff unscoped. In a multi-tenant system, a missing
  // organization_id can expose stale or wrong-tenant data.
  if (!resolvedOrgId) {
    return Promise.reject(
      new Error("organization_id is required before loading staff."),
    );
  }

  qs.set("organization_id", resolvedOrgId);

  if (
    params?.branch_id !== undefined &&
    params.branch_id !== null &&
    String(params.branch_id).trim()
  ) {
    qs.set("branch_id", String(params.branch_id));
  }
  if (
    params?.user_id !== undefined &&
    params.user_id !== null &&
    String(params.user_id).trim()
  ) {
    qs.set("user_id", String(params.user_id));
  }

  return http<User[]>(`/api/staff${qs.toString() ? `?${qs}` : ""}`);
};

/**
 * FIX: getUser now always carries organization_id.
 * Without it, the Flask backend cannot resolve which org DB to query,
 * risking a cross-tenant data leak in a multi-tenant system.
 */
export const getUser = (
  user_id: number | string,
  organization_id?: TenantId | null,
) => {
  const qs = new URLSearchParams();
  const orgId =
    organization_id !== undefined && organization_id !== null
      ? String(organization_id).trim()
      : getStoredOrganizationId();
  if (orgId) qs.set("organization_id", orgId);
  return http<User>(`/api/users/${user_id}${qs.toString() ? `?${qs}` : ""}`);
};

export type StaffPayload = Partial<User> & {
  password?: string;
  created_by_user_id?: number | string | null;
  branch_id?: number | string | null;
  branch_name?: string | null;
  organization_id?: number | string | null;
  employee_id?: string | null;
  status?: "active" | "inactive" | "pending";
  shift_id?: string | null;
  shift_label?: string | null;
  profile_image_url?: string | null;
  profile_image_name?: string | null;
  training_video_url?: string | null;
  training_video_name?: string | null;
};

// Return type includes optional `credentials` so StaffManagement can read
// response.credentials without a TS error.
export const addStaff = (data: StaffPayload) =>
  http<{
    success: boolean;
    user: User;
    credentials?: { email: string; password: string };
  }>("/api/staff", {
    method: "POST",
    body: JSON.stringify(data),
  });

export const updateUser = (user_id: number | string, data: StaffPayload) =>
  http<{ success: boolean; message: string; user?: User }>(
    `/api/users/${user_id}`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );

// Prefer these staff-specific endpoints for StaffDirectory and staff hooks.
export const updateStaff = (user_id: number | string, data: StaffPayload) =>
  http<{ success: boolean; message: string; user: User }>(
    `/api/staff/${user_id}`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );

export interface DashboardProfilePayload {
  name?: string;
  email?: string;
  phone?: string;
}

export interface DashboardProfileResponse {
  success: boolean;
  message?: string;
  error?: string;
  user: User;
}

/**
 * Update the logged-in dashboard user's own profile settings (name/email/
 * phone — no password; see changeOwnPassword for that).
 *
 * This intentionally uses the profile-only backend endpoint instead of the
 * staff-management update endpoint, so profile settings cannot accidentally
 * mutate HR/branch/module fields.
 */
export const updateDashboardProfile = (
  userId: number | string,
  data: DashboardProfilePayload,
) => {
  if (isUuidLike(userId)) {
    return http<DashboardProfileResponse>("/api/client/profile", {
      method: "PATCH",
      body: JSON.stringify({
        user_id: String(userId),
        ...data,
      }),
    });
  }

  return http<DashboardProfileResponse>(`/api/users/${userId}/profile`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
};

export interface ChangePasswordResponse {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * Change the logged-in dashboard user's own password. No current password
 * is required — the Bearer session on this request is already the proof
 * of identity (see api_change_own_dashboard_password's docstring on the
 * backend for the full reasoning).
 *
 * Supabase-backed accounts (client_users admin/HR, client_staff
 * manager/staff — both UUID ids) go through the dedicated
 * /api/client/account/password endpoint, which resolves the account
 * entirely from the JWT and works for either account type. Legacy
 * numeric-id SQLite accounts keep using the existing
 * /api/users/<id>/profile route, which now applies the same no-current-
 * password policy.
 */
export const changeOwnPassword = (
  userId: number | string,
  newPassword: string,
) => {
  if (isUuidLike(userId)) {
    return http<ChangePasswordResponse>("/api/client/account/password", {
      method: "PATCH",
      body: JSON.stringify({ new_password: newPassword }),
    });
  }

  return http<DashboardProfileResponse>(`/api/users/${userId}/profile`, {
    method: "PATCH",
    body: JSON.stringify({ new_password: newPassword }),
  });
};

export interface DeleteUserOptions {
  retentionYears?: number | null;
  reason?: string;
  archivedBy?: TenantId | null;
}

export interface RetentionPolicy {
  organization_id: TenantId;
  organization_name?: string;
  employee_retention_years: number;
  retention_policy_updated_at?: string | null;
  retention_policy_updated_by?: TenantId | null;
}

export const getRetentionPolicy = (organizationId: TenantId) =>
  http<RetentionPolicy>(
    `/api/org/retention-policy?organization_id=${encodeURIComponent(String(organizationId))}`,
  );

export const updateRetentionPolicy = (
  organizationId: TenantId,
  employeeRetentionYears: number,
  updatedBy?: TenantId | null,
) =>
  http<{
    success: boolean;
    policy: RetentionPolicy;
    message: string;
  }>("/api/org/retention-policy", {
    method: "PUT",
    body: JSON.stringify({
      organization_id: organizationId,
      employee_retention_years: employeeRetentionYears,
      updated_by: updatedBy ?? null,
    }),
  });

export const archiveStaff = (
  userId: TenantId,
  options: DeleteUserOptions = {},
) =>
  http<{
    success: boolean;
    message: string;
    archive?: {
      user_id: TenantId;
      name: string;
      organization_id: TenantId | null;
      retention_years: number;
      deleted_embeddings: number;
      deleted_at: string;
      retention_until: string;
    };
  }>(`/api/staff/${userId}`, {
    method: "DELETE",
    body: JSON.stringify({
      reason: options.reason ?? "Archived from Staff Management",
      archived_by: options.archivedBy ?? null,
      retention_years: options.retentionYears ?? null,
      organization_id: getStoredOrganizationId() || null,
    }),
  });

// Backward-compatible user archive endpoint retained for older pages.
export const deleteUser = (userId: TenantId, options: DeleteUserOptions = {}) =>
  http<{
    success: boolean;
    message: string;
    archive?: {
      user_id: TenantId;
      name: string;
      organization_id: TenantId | null;
      retention_years: number;
      deleted_embeddings: number;
      deleted_at: string;
      retention_until: string;
    };
  }>(`/api/users/${userId}`, {
    method: "DELETE",
    body: JSON.stringify({
      reason: options.reason ?? "Archived from Staff Management",
      archived_by: options.archivedBy ?? null,
      retention_years: options.retentionYears ?? null,
      organization_id: getStoredOrganizationId() || null,
    }),
  });

export const purgeExpiredRetentionRecords = (
  organizationId?: TenantId | null,
) =>
  http<{
    success: boolean;
    message: string;
    purged_count: number;
    purged_user_ids: number[];
  }>("/api/admin/retention/purge-expired", {
    method: "POST",
    body: JSON.stringify({
      organization_id: organizationId ?? null,
    }),
  });

/**
 * FIX: markUserPresent now sends organization_id in the body.
 * The backend needs it to write the attendance record to the correct org DB.
 */
export const markUserPresent = (
  user_id: TenantId,
  organization_id?: TenantId | null,
) =>
  http<{ success: boolean }>(`/api/users/${user_id}/mark-present`, {
    method: "POST",
    body: JSON.stringify({
      organization_id: (organization_id ?? getStoredOrganizationId()) || null,
    }),
  });

export const markUserAbsent = (
  user_id: TenantId,
  organization_id?: TenantId | null,
) =>
  http<{ success: boolean }>(`/api/attendance/mark-absent`, {
    method: "POST",
    body: JSON.stringify({
      user_id,
      organization_id: (organization_id ?? getStoredOrganizationId()) || null,
    }),
  });

// ─── Profile Photos ────────────────────────────────────────────────────────────

export const uploadUserPhoto = (user_id: number | string, file: File) => {
  const fd = new FormData();
  fd.append("photo", file);

  if (isUuidLike(user_id)) {
    fd.append("user_id", String(user_id));
    return httpForm<{
      success: boolean;
      photo_url: string;
      profile_image_url?: string;
      user?: User;
    }>("/api/client/profile/photo", fd);
  }

  return httpForm<{ success: boolean; photo_url: string }>(
    `/api/users/${user_id}/photo`,
    fd,
  );
};

/**
 * FIX: UUID (Supabase) users previously returned "" — profile photos would
 * never load for any client_users created via the support dashboard.
 *
 * Routing:
 *   UUID user → /client_profile_photos/<id>
 *     (served by Flask's /client_profile_photos static folder,
 *      proxied by Vite via the /client_profile_photos rule in vite.config.js)
 *   Integer user → /api/users/<id>/photo
 *     (served by Flask's legacy photo endpoint, proxied via /api rule)
 */
export const profilePhotoUrl = (user_id: number | string): string =>
  isUuidLike(user_id)
    ? `${BASE_URL}/client_profile_photos/${user_id}`
    : `${BASE_URL}/api/users/${user_id}/photo`;

// ─── Attendance ────────────────────────────────────────────────────────────────

export const getAttendanceToday = (params?: {
  organization_id?: TenantId | null;
  branch_id?: TenantId | null;
}) => {
  const qs = new URLSearchParams();
  appendTenantScope(qs, params);
  return http<AttendanceLog[]>(
    `/api/attendance/today${qs.toString() ? `?${qs}` : ""}`,
  );
};

export const getAttendanceLogs = (
  limit = 200,
  params?: { organization_id?: TenantId | null; branch_id?: TenantId | null },
) => {
  const qs = new URLSearchParams({ limit: String(limit) });
  appendTenantScope(qs, params);
  return http<AttendanceLog[]>(`/api/attendance?${qs}`);
};

export const getUserAttendance = (
  user_id: TenantId,
  start?: string,
  end?: string,
  params?: { organization_id?: TenantId | null; branch_id?: TenantId | null },
) => {
  const qs = new URLSearchParams({ user_id: String(user_id) });
  if (start) qs.set("start", start);
  if (end) qs.set("end", end);
  appendTenantScope(qs, params);
  return http<AttendanceLog[]>(`/api/attendance?${qs}`);
};

export const getStats = (params?: { organization_id?: TenantId | null }) => {
  const qs = new URLSearchParams();
  appendTenantScope(qs, params);
  return http<{
    total_users: number;
    today_attendance: number;
    unique_users_today: number;
    total_logs: number;
    avg_confidence: number;
    recent_entries: AttendanceLog[];
  }>(`/api/stats${qs.toString() ? `?${qs}` : ""}`);
};

// ─── Leave Requests ────────────────────────────────────────────────────────────

export const getLeaves = (params?: {
  user_id?: TenantId;
  status?: string;
  branch_id?: TenantId | null;
  organization_id?: TenantId | null;
}) => {
  const qs = new URLSearchParams();

  if (params?.user_id) qs.set("user_id", String(params.user_id));
  if (params?.status) qs.set("status", params.status);
  appendTenantScope(qs, params);

  return http<LeaveRequest[]>(`/api/leaves${qs.toString() ? `?${qs}` : ""}`);
};

export const addLeave = (data: {
  user_id: TenantId;
  leave_type: string;
  start_date: string;
  end_date: string;
  reason?: string;
  organization_id?: TenantId | null;
  branch_id?: TenantId | null;
}) =>
  http<{ success: boolean; id: TenantId }>("/api/leaves", {
    method: "POST",
    body: JSON.stringify({
      ...data,
      organization_id:
        (data.organization_id ?? getStoredOrganizationId()) || null,
    }),
  });

export const updateLeaveStatus = (
  leave_id: TenantId,
  status: "approved" | "rejected",
  approved_by = "Admin",
  organization_id?: TenantId | null,
) =>
  http<{ success: boolean }>(`/api/leaves/${leave_id}`, {
    method: "PUT",
    body: JSON.stringify({
      status,
      approved_by,
      organization_id: (organization_id ?? getStoredOrganizationId()) || null,
    }),
  });

export const deleteLeave = (
  leave_id: TenantId,
  organization_id?: TenantId | null,
) =>
  http<{ success: boolean }>(`/api/leaves/${leave_id}`, {
    method: "DELETE",
    body: JSON.stringify({
      organization_id: (organization_id ?? getStoredOrganizationId()) || null,
    }),
  });

// ─── Overtime ──────────────────────────────────────────────────────────────────

export const getOvertime = (params?: {
  user_id?: TenantId;
  status?: string;
  branch_id?: TenantId | null;
  organization_id?: TenantId | null;
}) => {
  const qs = new URLSearchParams();

  if (params?.user_id) qs.set("user_id", String(params.user_id));
  if (params?.status) qs.set("status", params.status);
  appendTenantScope(qs, params);

  return http<OvertimeRecord[]>(
    `/api/overtime${qs.toString() ? `?${qs}` : ""}`,
  );
};

export const addOvertime = (data: {
  user_id: TenantId;
  ot_date: string;
  hours: number;
  reason?: string;
  organization_id?: TenantId | null;
  branch_id?: TenantId | null;
}) =>
  http<{ success: boolean; id: TenantId }>("/api/overtime", {
    method: "POST",
    body: JSON.stringify({
      ...data,
      organization_id:
        (data.organization_id ?? getStoredOrganizationId()) || null,
    }),
  });

export const updateOvertimeStatus = (
  ot_id: TenantId,
  status: "approved" | "rejected",
  approved_by = "Admin",
  organization_id?: TenantId | null,
) =>
  http<{ success: boolean }>(`/api/overtime/${ot_id}`, {
    method: "PUT",
    body: JSON.stringify({
      status,
      approved_by,
      organization_id: (organization_id ?? getStoredOrganizationId()) || null,
    }),
  });

// ─── Salary ────────────────────────────────────────────────────────────────────

export const getAllSalaryConfigs = (params?: {
  organization_id?: TenantId | null;
  branch_id?: TenantId | null;
}) => {
  const qs = new URLSearchParams();
  appendTenantScope(qs, params);

  return http<SalaryConfig[]>(`/api/salary${qs.toString() ? `?${qs}` : ""}`);
};

/**
 * FIX: getSalaryConfig now carries organization_id.
 * The backend serves salary data from the per-org SQLite file. Without
 * organization_id the route handler cannot select the correct database.
 */
export const getSalaryConfig = (
  user_id: TenantId,
  organization_id?: TenantId | null,
) => {
  const qs = new URLSearchParams();
  const orgId =
    organization_id !== undefined && organization_id !== null
      ? String(organization_id).trim()
      : getStoredOrganizationId();
  if (orgId) qs.set("organization_id", orgId);
  return http<SalaryConfig>(
    `/api/salary/${user_id}${qs.toString() ? `?${qs}` : ""}`,
  );
};

export const setSalaryConfig = (
  user_id: TenantId,
  basic_salary: number,
  allowances = 0,
  deductions = 0,
  ot_rate = 0,
  organization_id?: TenantId | null,
) =>
  http<{ success: boolean }>(`/api/salary/${user_id}`, {
    method: "PUT",
    body: JSON.stringify({
      basic_salary,
      allowances,
      deductions,
      ot_rate,
      organization_id: (organization_id ?? getStoredOrganizationId()) || null,
    }),
  });

// ─── Enrollment ────────────────────────────────────────────────────────────────

export const createEnrollmentUser = (name: string, email: string) =>
  http<{ success: boolean; user_id: TenantId; name: string }>(
    "/api/enroll/create-user",
    {
      method: "POST",
      body: JSON.stringify({ name, email }),
    },
  );
export interface EnrollmentUploadResponse {
  success: boolean;
  user_id: TenantId;
  embeddings_count: number;
  total_frames_processed: number;
  avg_quality: number;
  spoof_detections?: number;
  warnings?: string[];
  message: string;
}

export const uploadEnrollmentVideo = (user_id: TenantId, videoFile: File) => {
  const fd = new FormData();
  fd.append("user_id", String(user_id));
  fd.append("video", videoFile);

  return httpForm<EnrollmentUploadResponse>("/api/enroll/upload-video", fd);
};

export const getEnrollmentStatus = (user_id: TenantId) =>
  http<{
    enrolled: boolean;
    user_id: TenantId;
    embeddings_count: number;
    message: string;
  }>(`/api/enroll/status/${user_id}`);

// ─── Live Camera ───────────────────────────────────────────────────────────────

export const getLiveDetections = (params?: {
  organization_id?: TenantId | null;
  branch_id?: TenantId | null;
}) => {
  const qs = new URLSearchParams();
  appendTenantScope(qs, params);
  return http<{ detections: LiveDetection[] }>(
    `/api/live-detections${qs.toString() ? `?${qs}` : ""}`,
  );
};

/**
 * MJPEG stream URL — drop directly into <img src>.
 * The browser holds the connection open and renders each frame.
 *   <img src={streamUrl("branch_1_cam1")} alt="Camera" />
 */
export const streamUrl = (
  camera_id: "nvr_office" | "dvr_office" | string,
  params?: { organization_id?: TenantId | null; branch_id?: TenantId | null },
) => {
  const qs = new URLSearchParams();
  appendTenantScope(qs, params);
  return `${BASE_URL}/api/stream/${camera_id}${qs.toString() ? `?${qs}` : ""}`;
};

// ─── System ────────────────────────────────────────────────────────────────────

export const initSystem = () =>
  http<{ status: string; message: string }>("/api/init", { method: "POST" });

export const healthCheck = () =>
  http<{ status: string; timestamp: string }>("/api/health");

export const systemHealth = () => http<SystemHealth>("/api/system/health");

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function httpForm<T>(path: string, formData: FormData): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { ...dashboardAuthHeaders() },
    body: formData,
  });

  if (!res.ok) {
    let msg = `Something went wrong (${res.status}). Please try again.`;
    try {
      const errorBody = await res.json();
      msg = errorBody.error ?? errorBody.message ?? msg;
    } catch {
      /* Response wasn't JSON — keep the generic message above. */
    }
    throw new Error(msg);
  }

  return res.json() as Promise<T>;
}
