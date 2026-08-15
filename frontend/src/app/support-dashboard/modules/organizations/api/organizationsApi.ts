/**
 * src/app/support-dashboard/modules/organizations/api/organizationsApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single API boundary for Support Dashboard organization flows.
 *
 * Rules:
 * - Components never build raw URLs.
 * - UUIDs are URL-encoded before being placed in a path.
 * - Module aliases are normalized in one place.
 * - Template API is exposed here so hooks/components do not duplicate calls.
 */

import { supportApiClient } from "../../../api/supportApiClient";
import type {
  Branch,
  BusinessType,
  CreateBranchPayload,
  CreateOrganizationPayload,
  Invoice,
  Organization,
  ArchiveOrganizationPayload,
  UpdateOrganizationRetentionPayload,
  RequestOrganizationDeletePayload,
  PermanentDeleteOrganizationPayload,
  PermanentDeleteResult,
  OrganizationModule,
  PeopleType,
  Subscription,
  SupportVerticalTemplateOption,
  ToggleModulePayload,
  UpdateOrganizationPayload,
  UpdateOrganizationTemplatePayload,
  UpdateOrganizationStaffTypeScopePayload,
  UpdateBranchPayload,
} from "../../../packages/shared-types/src/organization";

const BASE = "/v1/support/organizations";
const PERMANENT_DELETE_TIMEOUT_MS = 120_000;

const encodeId = (value: string): string => encodeURIComponent(String(value));

function filenameFromContentDisposition(
  value: string | undefined,
): string | null {
  if (!value) return null;
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) return decodeURIComponent(utf8[1].replace(/"/g, ""));
  const plain = value.match(/filename="?([^";]+)"?/i);
  return plain?.[1] ? plain[1] : null;
}

async function blobErrorMessage(
  data: unknown,
  fallback: string,
): Promise<string> {
  if (!(data instanceof Blob)) return fallback;
  const text = await data.text().catch(() => "");
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    return parsed.message || parsed.error || fallback;
  } catch {
    return text.slice(0, 300) || fallback;
  }
}

export function extractApiError(
  error: unknown,
  fallback = "Request failed",
): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybe = error as {
      response?: { data?: { error?: string; message?: string } };
      data?: { error?: string; message?: string };
      message?: string;
    };
    return (
      maybe.response?.data?.error ||
      maybe.response?.data?.message ||
      maybe.data?.error ||
      maybe.data?.message ||
      maybe.message ||
      fallback
    );
  }
  return fallback;
}

export type ClientModuleKey =
  | "attendance"
  | "employees"
  | "leave"
  | "payroll"
  | "overtime"
  | "reports"
  | "cctv"
  | "liveattendance";

export interface ModuleDefinition {
  key: ClientModuleKey;
  label: string;
  description: string;
}

export const MODULE_DEFINITIONS: readonly ModuleDefinition[] = [
  {
    key: "employees",
    label: "People Management",
    description:
      "People records, branch assignment, capacity enforcement, and face-training jobs.",
  },
  {
    key: "attendance",
    label: "Attendance",
    description:
      "Face attendance, CCTV/mobile ingestion, and dashboard attendance cards.",
  },
  {
    key: "leave",
    label: "Leave Management",
    description:
      "Leave applications, approvals, balances, and pending leave cards.",
  },
  {
    key: "payroll",
    label: "Payroll",
    description: "Salary configuration, payroll dashboard, and reports.",
  },
  {
    key: "overtime",
    label: "Overtime",
    description: "Overtime requests, policies, approvals, and calculations.",
  },
  {
    key: "reports",
    label: "Reports",
    description: "Organization-scoped exports and management summaries.",
  },
  {
    key: "cctv",
    label: "Live CCTV",
    description: "Live camera preview and recognition/detection feed.",
  },
  {
    key: "liveattendance",
    label: "Live Attendance Monitoring",
    description: "Real-time attendance marking and processing screen.",
  },
] as const;

const MODULE_KEY_ALIASES: Readonly<Record<string, ClientModuleKey>> = {
  attendance: "attendance",
  employees: "employees",
  employee: "employees",
  staff_directory: "employees",
  staffmanagement: "employees",
  staff_management: "employees",
  "staff-management": "employees",
  people: "employees",
  people_management: "employees",
  "people-management": "employees",
  leave: "leave",
  leave_management: "leave",
  "leave-management": "leave",
  payroll: "payroll",
  overtime: "overtime",
  overtime_management: "overtime",
  "overtime-management": "overtime",
  reports: "reports",
  cctv: "cctv",
  livecctv: "cctv",
  live_cctv: "cctv",
  "live-cctv": "cctv",
  liveattendance: "liveattendance",
  live_attendance: "liveattendance",
  "live-attendance": "liveattendance",
  liveattendancemonitoring: "liveattendance",
  live_attendance_monitoring: "liveattendance",
  "live-attendance-monitoring": "liveattendance",
};

export function normalizeClientModuleKey(
  value: unknown,
): ClientModuleKey | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  const snake = raw.replace(/\s+/g, "_");
  return MODULE_KEY_ALIASES[raw] ?? MODULE_KEY_ALIASES[snake] ?? null;
}

export interface ListOrganizationsParams {
  page?: number;
  page_size?: number;
  search?: string;
  status?: string;
  business_type?: BusinessType;
}

interface OrgListEnvelope {
  success: boolean;
  organizations?: Organization[];
  data?: Organization[];
}
interface OrgEnvelope {
  success: boolean;
  organization: Organization;
}
interface PermanentDeleteEnvelope {
  success: boolean;
  deleted: PermanentDeleteResult;
}
interface TemplatesEnvelope {
  success: boolean;
  templates?: SupportVerticalTemplateOption[];
  vertical_templates?: SupportVerticalTemplateOption[];
  data?: SupportVerticalTemplateOption[];
}
interface ModulesEnvelope {
  success: boolean;
  modules: OrganizationModule[];
}
interface ModuleEnvelope {
  success: boolean;
  module: OrganizationModule;
}
interface BranchesEnvelope {
  success: boolean;
  branches: Branch[];
}
interface BranchEnvelope {
  success: boolean;
  branch: Branch;
}
interface InvoicesEnvelope {
  success: boolean;
  invoices: Invoice[];
}
interface InvoiceEnvelope {
  success: boolean;
  invoice: Invoice;
}
interface InviteClientEnvelope {
  success: boolean;
  invite: ClientInviteResult;
}
interface InstallTokenEnvelope {
  success: boolean;
  install_token: BranchInstallTokenResult;
}

export interface InviteClientPayload {
  email: string;
  full_name: string;
  // client_users is admin-only — no role tier to pick here. Any 'role' this
  // client sends is ignored server-side too (see
  // support_db_client_users.create_client_invite).
  temporary_password?: string;
  login_url?: string;
  support_contact?: string;
}

export interface ClientInviteResult {
  user: {
    id: string;
    org_id: string;
    email: string;
    full_name: string;
    role: "admin";
    is_active: boolean;
    must_change_password: boolean;
    created_at?: string;
    last_login_at?: string | null;
  };
  email: string;
  full_name: string;
  role: "admin";
  temporary_password: string;
  login_url: string;
  message?: string;
  invite_message?: string;
  deal_summary?: Record<string, unknown>;
}

export interface BranchInstallTokenResult {
  id: string;
  install_token: string;
  expires_at: string;
  org_id: string;
  organization_name?: string;
  branch_id: string;
  branch_name?: string;
  ttl_days: number;
  message: string;
}

function buildQuery(params?: ListOrganizationsParams): string {
  const query = new URLSearchParams();
  if (!params) return "";
  if (params.page) query.set("page", String(params.page));
  if (params.page_size) query.set("page_size", String(params.page_size));
  if (params.search?.trim()) query.set("search", params.search.trim());
  if (params.status?.trim()) query.set("status", params.status.trim());
  if (params.business_type)
    query.set("business_type", String(params.business_type));
  const text = query.toString();
  return text ? `?${text}` : "";
}

export const verticalTemplatesApi = {
  list: (): Promise<SupportVerticalTemplateOption[]> =>
    supportApiClient
      .get<TemplatesEnvelope>("/v1/support/vertical-templates")
      .then((r) => {
        const rows =
          r.data.templates ?? r.data.vertical_templates ?? r.data.data ?? [];
        return Array.isArray(rows) ? rows : [];
      }),
} as const;

export const organizationsApi = {
  list: (params?: ListOrganizationsParams): Promise<Organization[]> =>
    supportApiClient
      .get<OrgListEnvelope>(`${BASE}${buildQuery(params)}`)
      .then((r) => {
        const rows = r.data.organizations ?? r.data.data ?? [];
        return Array.isArray(rows) ? rows : [];
      }),

  getById: (id: string): Promise<Organization> =>
    supportApiClient
      .get<OrgEnvelope>(`${BASE}/${encodeId(id)}`)
      .then((r) => r.data.organization),

  create: (payload: CreateOrganizationPayload): Promise<Organization> =>
    supportApiClient
      .post<OrgEnvelope>(BASE, payload)
      .then((r) => r.data.organization),

  update: (payload: UpdateOrganizationPayload): Promise<Organization> =>
    supportApiClient
      .patch<OrgEnvelope>(`${BASE}/${encodeId(payload.id)}`, payload)
      .then((r) => r.data.organization),

  updateTemplate: (
    payload: UpdateOrganizationTemplatePayload,
  ): Promise<Organization> =>
    supportApiClient
      .patch<OrgEnvelope>(`${BASE}/${encodeId(payload.id)}/template`, {
        business_type: payload.business_type,
        attendance_people_types: payload.attendance_people_types,
      })
      .then((r) => r.data.organization),

  updateStaffTypeScope: (
    payload: UpdateOrganizationStaffTypeScopePayload,
  ): Promise<Organization> =>
    supportApiClient
      .patch<OrgEnvelope>(`${BASE}/${encodeId(payload.id)}/staff-type-scope`, {
        enabled_staff_types: payload.enabled_staff_types,
      })
      .then((r) => r.data.organization),

  inviteClient: (
    orgId: string,
    payload: InviteClientPayload,
  ): Promise<ClientInviteResult> =>
    supportApiClient
      .post<InviteClientEnvelope>(`${BASE}/${encodeId(orgId)}/invite`, payload)
      .then((r) => r.data.invite),

  archive: (
    orgId: string,
    payload: ArchiveOrganizationPayload,
  ): Promise<Organization> =>
    supportApiClient
      .patch<OrgEnvelope>(`${BASE}/${encodeId(orgId)}/archive`, payload)
      .then((r) => r.data.organization),

  restore: (orgId: string): Promise<Organization> =>
    supportApiClient
      .patch<OrgEnvelope>(`${BASE}/${encodeId(orgId)}/restore`, {})
      .then((r) => r.data.organization),

  updateRetentionPolicy: (
    orgId: string,
    payload: UpdateOrganizationRetentionPayload,
  ): Promise<Organization> =>
    supportApiClient
      .patch<OrgEnvelope>(
        `${BASE}/${encodeId(orgId)}/retention-policy`,
        payload,
      )
      .then((r) => r.data.organization),

  requestDelete: (
    orgId: string,
    payload: RequestOrganizationDeletePayload,
  ): Promise<Organization> =>
    supportApiClient
      .post<OrgEnvelope>(`${BASE}/${encodeId(orgId)}/request-delete`, payload)
      .then((r) => r.data.organization),

  permanentlyDelete: (
    orgId: string,
    payload: PermanentDeleteOrganizationPayload,
  ): Promise<PermanentDeleteResult> =>
    supportApiClient
      .post<PermanentDeleteEnvelope>(
        `${BASE}/${encodeId(orgId)}/permanent-delete`,
        payload,
        { timeout: PERMANENT_DELETE_TIMEOUT_MS },
      )
      .then((r) => r.data.deleted),
} as const;

export const modulesApi = {
  list: (orgId: string): Promise<OrganizationModule[]> =>
    supportApiClient
      .get<ModulesEnvelope>(`${BASE}/${encodeId(orgId)}/modules`)
      .then((r) => r.data.modules),

  setAll: (orgId: string, modules: string[]): Promise<OrganizationModule[]> => {
    const seen = new Set<ClientModuleKey>();
    const canonical: ClientModuleKey[] = [];

    for (const raw of modules) {
      const key = normalizeClientModuleKey(raw);
      if (key && !seen.has(key)) {
        seen.add(key);
        canonical.push(key);
      }
    }

    return supportApiClient
      .put<ModulesEnvelope>(`${BASE}/${encodeId(orgId)}/modules`, {
        modules: canonical,
      })
      .then((r) => r.data.modules);
  },

  toggle: (payload: ToggleModulePayload): Promise<OrganizationModule> =>
    supportApiClient
      .patch<ModuleEnvelope>(
        `${BASE}/${encodeId(payload.org_id)}/modules/${encodeURIComponent(String(payload.module_name))}`,
        {
          status: payload.status,
        },
      )
      .then((r) => r.data.module),
} as const;

export const branchesApi = {
  list: (orgId: string): Promise<Branch[]> =>
    supportApiClient
      .get<BranchesEnvelope>(`${BASE}/${encodeId(orgId)}/branches`)
      .then((r) => r.data.branches),

  create: (
    orgId: string,
    payload: Omit<CreateBranchPayload, "org_id">,
  ): Promise<Branch> =>
    supportApiClient
      .post<BranchEnvelope>(`${BASE}/${encodeId(orgId)}/branches`, payload)
      .then((r) => r.data.branch),

  update: (
    orgId: string,
    branchId: string,
    payload: UpdateBranchPayload,
  ): Promise<Branch> =>
    supportApiClient
      .patch<BranchEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}`,
        payload,
      )
      .then((r) => r.data.branch),

  setFallback: (branchId: string, active: boolean): Promise<Branch> =>
    supportApiClient
      .patch<BranchEnvelope>(
        `/v1/support/branches/${encodeId(branchId)}/fallback`,
        { fallback_active: active },
      )
      .then((r) => r.data.branch),

  getModulePeopleTypes: (
    orgId: string,
    branchId: string,
  ): Promise<Record<string, string[]>> =>
    supportApiClient
      .get<{
        module_people_types: Record<string, string[]>;
      }>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/module-people-types`,
      )
      .then((r) => r.data.module_people_types ?? {}),

  setModulePeopleTypes: (
    orgId: string,
    branchId: string,
    modulePeopleTypes: Record<string, string[] | string>,
  ): Promise<Record<string, string[]>> =>
    supportApiClient
      .put<{
        module_people_types: Record<string, string[]>;
      }>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/module-people-types`,
        modulePeopleTypes,
      )
      .then((r) => r.data.module_people_types ?? {}),

  createInstallToken: (
    orgId: string,
    branchId: string,
    ttlDays = 7,
  ): Promise<BranchInstallTokenResult> =>
    supportApiClient
      .post<InstallTokenEnvelope>(
        `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/install-token`,
        {
          ttl_days: ttlDays,
        },
      )
      .then((r) => r.data.install_token),

  downloadInstaller: async (
    orgId: string,
    branchId: string,
    payload: {
      ttl_days?: number;
      node_label?: string;
      api_base_url?: string;
      package_type?: "exe" | "zip";
    } = {},
  ): Promise<void> => {
    const packageType = payload.package_type ?? "exe";
    const response = await supportApiClient.post(
      `${BASE}/${encodeId(orgId)}/branches/${encodeId(branchId)}/installer`,
      { ...payload, package_type: packageType },
      {
        responseType: "blob",
        timeout: 180_000,
        headers: {
          Accept:
            "application/vnd.microsoft.portable-executable, application/zip, application/json",
        },
      },
    );

    const contentType = String(response.headers?.["content-type"] || "");
    if (contentType.includes("application/json")) {
      throw new Error(
        await blobErrorMessage(response.data, "Installer failed"),
      );
    }

    const isExe =
      contentType.includes("portable-executable") || packageType === "exe";
    const blob = new Blob([response.data], {
      type: isExe
        ? "application/vnd.microsoft.portable-executable"
        : "application/zip",
    });
    const filename =
      filenameFromContentDisposition(
        response.headers?.["content-disposition"],
      ) || `QIntellectAttendanceNodeSetup-${branchId}.${isExe ? "exe" : "zip"}`;

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
} as const;

export const invoicesApi = {
  list: (orgId: string): Promise<Invoice[]> =>
    supportApiClient
      .get<InvoicesEnvelope>(`${BASE}/${encodeId(orgId)}/invoices`)
      .then((r) => r.data.invoices),

  create: (
    orgId: string,
    payload: {
      amount: number;
      due_date: string;
      grace_period_days?: number;
      notes?: string;
    },
  ): Promise<Invoice> =>
    supportApiClient
      .post<InvoiceEnvelope>(`${BASE}/${encodeId(orgId)}/invoices`, payload)
      .then((r) => r.data.invoice),

  markPaid: (invoiceId: string, notes?: string): Promise<Invoice> =>
    supportApiClient
      .patch<InvoiceEnvelope>(
        `/v1/support/invoices/${encodeId(invoiceId)}/mark-paid`,
        { notes },
      )
      .then((r) => r.data.invoice),
} as const;

export interface NodeHealth {
  branch_id: string;
  branch_name: string;
  node_id: string | null;
  status: "online" | "offline" | "never_connected" | string;
  last_seen_at: string | null;
  fallback_active?: boolean;
  node_label?: string | null;
  attendance_mode?: "cloud" | "local" | string | null;
  configured_cameras?: number | null;
  cycle_status?: string | null;
  last_cycle_at?: string | null;
  last_error?: string | null;
  agent_version?: string | null;
  hostname?: string | null;
  minutes_since_seen?: number | null;
  last_heartbeat_payload?: Record<string, unknown> | null;
}

interface NodeHealthEnvelope {
  success: boolean;
  node_health: NodeHealth[];
}

export const nodeHealthApi = {
  list: (orgId: string): Promise<NodeHealth[]> =>
    supportApiClient
      .get<NodeHealthEnvelope>(`${BASE}/${encodeId(orgId)}/node-health`)
      .then((r) => r.data.node_health),
} as const;

void ({} as { s: Subscription; p: PeopleType });
