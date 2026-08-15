import { BASE_URL } from "../../../api/api";
import { cleanId, type MaybeTenantId } from "../../../utils/tenantScope";

// Same storage key as apiClient.ts/staffApi.ts/clintApi.ts/OrgConfigContext.tsx's
// dashboardAuthToken. Every route in this file is wrapped in
// @require_client_dashboard_auth server-side (e.g. /api/notifications/
// unread-count, polled every 30s by useUnreadNotificationCount or similar),
// so a request with no Authorization header 401s unconditionally — this
// file's fetch wrapper never attached one. Duplicated as a plain constant
// rather than imported, same dependency-isolation reason apiClient.ts
// gives — grep "dashboardAuthToken" before renaming any of them.
function notificationAuthHeaders(): HeadersInit {
  try {
    const token = localStorage.getItem("dashboardAuthToken");
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export interface DashboardNotification {
  id: number;
  organization_id?: number | string | null;
  branch_id?: number | string | null;
  module_key: string;
  event_type: string;
  title: string;
  body: string;
  actor_user_id?: number | string | null;
  actor_name?: string | null;
  target_user_id?: number | string | null;
  target_entity_id?: number | string | null;
  target_entity_type?: string | null;
  target_route?: string | null;
  is_read: boolean;
  read_at?: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

export interface NotificationListResponse {
  success: boolean;
  notifications: DashboardNotification[];
  unread_count: number;
}

interface NotificationCountResponse {
  success: boolean;
  unread_count: number;
}

type IdParam = number | string;

async function notificationJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const authHeaders = notificationAuthHeaders();
  Object.entries(authHeaders).forEach(([key, value]) =>
    headers.set(key, value as string),
  );

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false) {
    throw new Error(
      data?.message ||
        data?.error ||
        `Notification request failed: ${response.status}`,
    );
  }
  return data as T;
}

function query(
  params: Record<string, string | number | boolean | null | undefined>,
) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    search.set(key, String(value));
  });
  const result = search.toString();
  return result ? `?${result}` : "";
}

function requireOrg(value: MaybeTenantId): string {
  const orgId = cleanId(value);
  if (!orgId) throw new Error("organization_id is required for notifications.");
  return orgId;
}

export async function listNotifications(params: {
  userId: IdParam;
  organizationId: MaybeTenantId;
  unreadOnly?: boolean;
  limit?: number;
}): Promise<NotificationListResponse> {
  return notificationJson<NotificationListResponse>(
    `/api/notifications${query({
      user_id: cleanId(params.userId),
      organization_id: requireOrg(params.organizationId),
      unread_only: params.unreadOnly ? "true" : undefined,
      limit: params.limit ?? 100,
    })}`,
  );
}

export async function getUnreadNotificationCount(params: {
  userId: IdParam;
  organizationId: MaybeTenantId;
}): Promise<number> {
  const response = await notificationJson<NotificationCountResponse>(
    `/api/notifications/unread-count${query({
      user_id: cleanId(params.userId),
      organization_id: requireOrg(params.organizationId),
    })}`,
  );
  return Number(response.unread_count || 0);
}

export async function markNotificationRead(params: {
  notificationId: number;
  userId: IdParam;
  organizationId: MaybeTenantId;
}): Promise<void> {
  await notificationJson<{ success: boolean }>(
    `/api/notifications/${params.notificationId}/read`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: cleanId(params.userId),
        organization_id: requireOrg(params.organizationId),
      }),
    },
  );
}

export async function markAllNotificationsRead(params: {
  userId: IdParam;
  organizationId: MaybeTenantId;
}): Promise<number> {
  const response = await notificationJson<{
    success: boolean;
    updated_count: number;
  }>("/api/notifications/mark-all-read", {
    method: "POST",
    body: JSON.stringify({
      user_id: cleanId(params.userId),
      organization_id: requireOrg(params.organizationId),
    }),
  });
  return Number(response.updated_count || 0);
}

export async function deleteNotification(params: {
  notificationId: number;
  userId: IdParam;
  organizationId: MaybeTenantId;
}): Promise<void> {
  await notificationJson<{ success: boolean }>(
    `/api/notifications/${params.notificationId}/delete`,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: cleanId(params.userId),
        organization_id: requireOrg(params.organizationId),
      }),
    },
  );
}

export async function bulkDeleteNotifications(params: {
  notificationIds: number[];
  userId: IdParam;
  organizationId: MaybeTenantId;
}): Promise<number> {
  const response = await notificationJson<{
    success: boolean;
    deleted_count: number;
  }>("/api/notifications/bulk-delete", {
    method: "POST",
    body: JSON.stringify({
      notification_ids: params.notificationIds,
      user_id: cleanId(params.userId),
      organization_id: requireOrg(params.organizationId),
    }),
  });
  return Number(response.deleted_count || 0);
}
