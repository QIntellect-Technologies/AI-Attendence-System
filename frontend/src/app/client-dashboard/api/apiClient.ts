import { handleSessionExpired } from "./sessionExpired";

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

const API_BASE_URL = (import.meta as any).env?.VITE_API_BASE_URL || "";

// Same storage key as modules/staff/api/staffApi.ts's
// getDashboardAuthToken/setDashboardAuthToken — deliberately duplicated as
// a plain string constant rather than imported, to keep this file
// dependency-free of the staff module (apiClient.ts is imported by
// clientBootstrapApi.ts and other non-staff call sites that shouldn't pull
// in staff-module code). If the key ever changes, it must change in both
// places — grep "dashboardAuthToken" before renaming either one.
const AUTH_TOKEN_STORAGE_KEY = "dashboardAuthToken";

function authHeaders(): HeadersInit {
  try {
    const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export function buildQuery(params: QueryParams = {}): string {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") return;
    searchParams.set(key, String(value));
  });
  const qs = searchParams.toString();
  return qs ? `?${qs}` : "";
}

class ApiRequestError extends Error {
  status: number;
  isAuthError: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.isAuthError = status === 401;
  }
}

async function parseBody(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  params?: QueryParams,
  jsonBody?: unknown,
): Promise<T> {
  const url = `${API_BASE_URL}${path}${buildQuery(params)}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
    },
    credentials: "include",
    ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
  });

  const body = await parseBody(res);

  if (res.status === 401) {
    const message =
      body?.message || body?.error || "Session expired. Please log in again.";
    handleSessionExpired(message);
    throw new ApiRequestError(message, res.status);
  }

  if (!res.ok || body?.success === false) {
    const message =
      body?.message || body?.error || `Request failed: ${res.status}`;
    throw new ApiRequestError(message, res.status);
  }

  return body as T;
}

/** GET — unchanged call shape from before, now with the dashboard Bearer
 * token attached automatically. Server-side scoping (branch vs team) is
 * enforced from that token on any route wrapped in
 * @require_client_dashboard_auth; query params here remain advisory only,
 * see the row-scope note in staffApi.ts. */
export function fetchJson<T>(path: string, params?: QueryParams): Promise<T> {
  return request<T>("GET", path, params);
}

export function postJson<T>(
  path: string,
  jsonBody?: unknown,
  params?: QueryParams,
): Promise<T> {
  return request<T>("POST", path, params, jsonBody ?? {});
}

export function putJson<T>(
  path: string,
  jsonBody?: unknown,
  params?: QueryParams,
): Promise<T> {
  return request<T>("PUT", path, params, jsonBody ?? {});
}

export function patchJson<T>(
  path: string,
  jsonBody?: unknown,
  params?: QueryParams,
): Promise<T> {
  return request<T>("PATCH", path, params, jsonBody ?? {});
}

export function deleteJson<T>(
  path: string,
  params?: QueryParams,
  jsonBody?: unknown,
): Promise<T> {
  return request<T>("DELETE", path, params, jsonBody);
}

export { ApiRequestError };
