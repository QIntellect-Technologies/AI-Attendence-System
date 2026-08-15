import { supportApiClient } from "../../../api/supportApiClient";

export type InternalUserRole =
  | "super_admin"
  | "admin"
  | "support"
  | "support_agent"
  | "billing"
  | "billing_admin"
  | "operations";

export interface InternalUserRow {
  id: string;
  email: string;
  full_name?: string | null;
  role: InternalUserRole | string;
  is_active: boolean;
  last_login_at?: string | null;
  created_at?: string | null;
}

export interface PageMeta {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  has_more: boolean;
}

export interface InternalUsersQuery {
  page?: number;
  page_size?: number;
  search?: string;
  role?: string;
  active?: string;
}

export interface CreateInternalUserPayload {
  email: string;
  full_name: string;
  role: InternalUserRole;
  password: string;
  is_active?: boolean;
}

export interface UpdateInternalUserPayload {
  full_name?: string;
  role?: InternalUserRole;
  is_active?: boolean;
}

interface ListEnvelope {
  success: boolean;
  internal_users: InternalUserRow[];
  page: PageMeta;
}

interface UserEnvelope {
  success: boolean;
  internal_user: InternalUserRow;
}

const encodeId = (value: string): string => encodeURIComponent(String(value));

const buildQuery = (query: InternalUsersQuery = {}) => {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim()) {
      params.set(key, String(value));
    }
  });
  const text = params.toString();
  return text ? `?${text}` : "";
};

export function extractSupportError(error: unknown, fallback = "Request failed"): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybe = error as { response?: { data?: { error?: string; message?: string } }; message?: string };
    return maybe.response?.data?.error || maybe.response?.data?.message || maybe.message || fallback;
  }
  return fallback;
}

export const internalUsersApi = {
  list: async (query: InternalUsersQuery) => {
    const res = await supportApiClient.get<ListEnvelope>(`/v1/support/internal-users${buildQuery(query)}`);
    return { rows: res.data.internal_users || [], page: res.data.page };
  },

  create: async (payload: CreateInternalUserPayload): Promise<InternalUserRow> => {
    const res = await supportApiClient.post<UserEnvelope>("/v1/support/internal-users", payload);
    return res.data.internal_user;
  },

  update: async (id: string, payload: UpdateInternalUserPayload): Promise<InternalUserRow> => {
    const res = await supportApiClient.patch<UserEnvelope>(`/v1/support/internal-users/${encodeId(id)}`, payload);
    return res.data.internal_user;
  },

  resetPassword: async (id: string, password: string): Promise<InternalUserRow> => {
    const res = await supportApiClient.post<UserEnvelope>(`/v1/support/internal-users/${encodeId(id)}/reset-password`, { password });
    return res.data.internal_user;
  },
} as const;
