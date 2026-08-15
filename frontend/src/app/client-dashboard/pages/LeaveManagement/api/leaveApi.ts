/**
 * modules/leave/api/leaveApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * UUID-safe tenant-scoped Leave API adapter.
 */

import { BASE_URL } from "../../../api/api";
import {
  appendTenantQuery,
  cleanId,
  type MaybeTenantId,
} from "../../../utils/tenantScope";

export interface LeaveRequest {
  id: string;
  userId: number | string | null;
  user_id?: number | string | null;
  staffId?: number | string | null;
  staff_id?: number | string | null;
  name: string;
  userName?: string;
  user_name?: string;
  staffName?: string;
  staff_name?: string;
  branchId?: number | string | null;
  branch_id?: number | string | null;
  backendBranchId?: number | string | null;
  backend_branch_id?: number | string | null;
  branchName?: string | null;
  branch_name?: string | null;
  peopleType?: string;
  people_type?: string;
  dept?: string | null;
  department?: string | null;
  type: string;
  leave_type?: string;
  leaveCompensation?:
    | "paid"
    | "unpaid"
    | "excluded"
    | "not_configured"
    | string;
  leave_compensation?:
    | "paid"
    | "unpaid"
    | "excluded"
    | "not_configured"
    | string;
  leavePayrollDecision?: "include" | "exclude" | null | string;
  leave_payroll_decision?: "include" | "exclude" | null | string;
  halfDayPeriod?: "first_half" | "second_half" | "morning" | "afternoon" | null;
  half_day_period?:
    | "first_half"
    | "second_half"
    | "morning"
    | "afternoon"
    | null;
  halfDayStartTime?: string | null;
  half_day_start_time?: string | null;
  halfDayEndTime?: string | null;
  half_day_end_time?: string | null;
  days: number;
  status: "pending" | "approved" | "rejected" | string;
  startDate: string;
  start_date?: string;
  endDate: string;
  end_date?: string;
  reason: string;
  approvedBy?: string | null;
  approved_by?: string | null;
  /** Raw manager user ID when approved_by came back as an unresolved UUID
   * (auto-approval flows) rather than a plain label like "Admin". Consumers
   * resolve this against the staff directory to get a display name +
   * person code — never render this value directly. */
  approvedById?: string | null;
  approved_by_id?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
}

export interface CreateLeavePayload {
  organizationId: number | string;
  branchId?: number | string | null;
  userId?: number | string | null;
  user_id?: number | string | null;
  staffId?: number | string | null;
  staff_id?: number | string | null;
  userName?: string;
  user_name?: string;
  type?: string;
  leave_type?: string;
  halfDayPeriod?: "first_half" | "second_half" | "morning" | "afternoon" | null;
  half_day_period?:
    | "first_half"
    | "second_half"
    | "morning"
    | "afternoon"
    | null;
  halfDayStartTime?: string | null;
  half_day_start_time?: string | null;
  halfDayEndTime?: string | null;
  half_day_end_time?: string | null;
  startDate?: string;
  start_date?: string;
  endDate?: string;
  end_date?: string;
  reason?: string;
  days?: number;
}

/**
 * Org (+ optional branch-override) leave-type paid/unpaid map. Sourced
 * from support_db_payroll's PayrollPolicy.leaveTypeRules on the backend
 * (see GET /api/leaves/types) — this is the single source of truth for
 * "which leave types exist for this tenant and are they paid", shared by
 * the Leave Management filter, payroll_engine's deduction math, and the
 * mobile leave-request form. Keys are the lowercase slugs configured in
 * the Payroll Rules modal (e.g. "sick", "casual", "half_day"), not
 * display labels.
 */
export type LeaveTypeRules = Record<string, "paid" | "unpaid" | string>;

interface RawLeaveRequest extends Record<string, unknown> {}

function first<T = unknown>(
  raw: Record<string, unknown>,
  ...keys: string[]
): T | undefined {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "")
      return raw[key] as T;
  }
  return undefined;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `value` looks like a raw UUID rather than a human-readable
 * name/label. Used to keep unresolved backend IDs (staff ids, attendance
 * ids, etc.) from leaking into user-facing UI.
 */
export function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

/**
 * Strips the internal `(attendance_id=<uuid>)` audit marker that the
 * backend appends to auto-recorded leave reasons (see support_db.py).
 * Centralized here so every caller of mapLeave gets a clean, user-facing
 * reason string instead of each component patching it independently.
 */
function stripInternalRefs(reason: string): string {
  // Trailing "." after the closing paren (see support_db.py's
  // auto-recorded reason text) is optional here — without it, a real
  // reason like "...(attendance_id=...)." never matched the old $ anchor
  // and the marker silently stayed in the string.
  return reason.replace(/\s*\(attendance_id=[0-9a-f-]+\)\.?\s*$/i, "").trim();
}

function calcDays(start?: string, end?: string): number {
  if (!start || !end) return 1;
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 1;
  return Math.max(1, Math.floor((e.getTime() - s.getTime()) / 86_400_000) + 1);
}

function mapLeave(raw: RawLeaveRequest): LeaveRequest {
  const userId = first(raw, "user_id", "userId", "staff_id", "staffId") ?? null;
  const name = String(
    first(raw, "user_name", "userName", "staff_name", "staffName", "name") ??
      "Unknown",
  );
  const branchId =
    first(
      raw,
      "branch_id",
      "branchId",
      "backend_branch_id",
      "backendBranchId",
    ) ?? null;
  const type = String(
    first(raw, "type", "leave_type", "leaveType") ?? "annual",
  );
  const rawLeaveCompensation = String(
    first(raw, "leaveCompensation", "leave_compensation") ?? "not_configured",
  ).toLowerCase();
  const leavePayrollDecision = String(
    first(raw, "leavePayrollDecision", "leave_payroll_decision") ?? "",
  ).toLowerCase();
  const rawReason = String(first(raw, "reason") ?? "");
  const isAttendanceAdjustment =
    type.trim().toLowerCase() === "attendance_adjustment" ||
    /attendance_id=[0-9a-f-]{8,}/i.test(rawReason);

  // Safety fallback: attendance-adjustment leaves are payroll-decision
  // driven. If the backend payload is stale/missing classification, show
  // the correct treatment client-side: exclude => Excluded; otherwise Unpaid.
  const leaveCompensation =
    leavePayrollDecision === "exclude"
      ? "excluded"
      : isAttendanceAdjustment
        ? "unpaid"
        : rawLeaveCompensation;
  const halfDayPeriodRaw = first(raw, "half_day_period", "halfDayPeriod") as
    | string
    | undefined;
  // Backend (support_db.py) validates and stores 'first_half'/'second_half'
  // exclusively -- 'morning'/'afternoon' only ever appear as UI-facing
  // labels (e.g. leave_screen.dart's dropdown), never as the stored value.
  // Accepting only the UI labels here silently dropped every real
  // half-day request's period on the way into the frontend.
  const halfDayPeriod =
    halfDayPeriodRaw === "first_half" ||
    halfDayPeriodRaw === "second_half" ||
    halfDayPeriodRaw === "morning" ||
    halfDayPeriodRaw === "afternoon"
      ? halfDayPeriodRaw
      : null;
  const halfDayStartTime =
    (first(raw, "half_day_start_time", "halfDayStartTime") as
      | string
      | undefined) ?? null;
  const halfDayEndTime =
    (first(raw, "half_day_end_time", "halfDayEndTime") as string | undefined) ??
    null;
  const startDate = String(first(raw, "startDate", "start_date") ?? "");
  const endDate = String(first(raw, "endDate", "end_date") ?? startDate);
  const days = Number(first(raw, "days") ?? calcDays(startDate, endDate));
  const status = String(first(raw, "status") ?? "pending").toLowerCase();
  const branchName =
    (first(raw, "branchName", "branch_name") as string | undefined) ?? null;
  const department =
    (first(raw, "department", "dept") as string | undefined) ?? null;
  const peopleType = String(
    first(raw, "peopleType", "people_type") ?? "staff",
  ).toLowerCase();

  // approved_by is currently returned by the backend as either a plain
  // label ("Admin") or the approving manager's raw user ID (auto-approval
  // flows). Split the two: approvedBy stays a display-ready label,
  // approvedById carries the raw ID for callers to resolve against a
  // staff directory. Never surface approvedById in the UI directly.
  const approvedByRaw =
    (first(raw, "approvedBy", "approved_by") as string | undefined) ?? null;
  const approvedBy =
    approvedByRaw && !isUuid(approvedByRaw) ? approvedByRaw : null;
  const approvedById =
    approvedByRaw && isUuid(approvedByRaw) ? approvedByRaw : null;

  return {
    id: String(first(raw, "id") ?? ""),
    userId: userId as number | string | null,
    user_id: userId as number | string | null,
    staffId: userId as number | string | null,
    staff_id: userId as number | string | null,
    name,
    userName: name,
    user_name: name,
    staffName: name,
    staff_name: name,
    branchId: branchId as number | string | null,
    branch_id: branchId as number | string | null,
    backendBranchId:
      (first(raw, "backendBranchId", "backend_branch_id") as
        | number
        | string
        | undefined) ?? (branchId as number | string | null),
    backend_branch_id:
      (first(raw, "backendBranchId", "backend_branch_id") as
        | number
        | string
        | undefined) ?? (branchId as number | string | null),
    branchName,
    branch_name: branchName,
    dept: department,
    department,
    peopleType,
    people_type: peopleType,
    type,
    leave_type: type,
    leaveCompensation,
    leave_compensation: leaveCompensation,
    leavePayrollDecision:
      leavePayrollDecision === "include" || leavePayrollDecision === "exclude"
        ? leavePayrollDecision
        : null,
    leave_payroll_decision:
      leavePayrollDecision === "include" || leavePayrollDecision === "exclude"
        ? leavePayrollDecision
        : null,
    halfDayPeriod,
    half_day_period: halfDayPeriod,
    halfDayStartTime,
    half_day_start_time: halfDayStartTime,
    halfDayEndTime,
    half_day_end_time: halfDayEndTime,
    days,
    status,
    startDate,
    start_date: startDate,
    endDate,
    end_date: endDate,
    reason: stripInternalRefs(rawReason),
    approvedBy,
    approved_by: approvedBy,
    approvedById,
    approved_by_id: approvedById,
    createdAt:
      (first(raw, "createdAt", "created_at") as string | undefined) ?? null,
    created_at:
      (first(raw, "createdAt", "created_at") as string | undefined) ?? null,
    updatedAt:
      (first(raw, "updatedAt", "updated_at") as string | undefined) ?? null,
    updated_at:
      (first(raw, "updatedAt", "updated_at") as string | undefined) ?? null,
  };
}

// Same storage key as modules/staff/api/staffApi.ts's
// getDashboardAuthToken/setDashboardAuthToken, src/api.ts, apiClient.ts,
// and clintApi.ts — duplicated as a plain constant rather than imported
// for the same dependency-isolation reason apiClient.ts documents. If this
// key ever changes, grep "dashboardAuthToken" and update every copy.
const DASHBOARD_AUTH_TOKEN_KEY = "dashboardAuthToken";

function dashboardAuthHeaders(): HeadersInit {
  try {
    const token = localStorage.getItem(DASHBOARD_AUTH_TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function leaveJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const authHeader = dashboardAuthHeaders() as Record<string, string>;
  if (authHeader.Authorization && !headers.has("Authorization")) {
    headers.set("Authorization", authHeader.Authorization);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(
      data?.message || data?.error || `Leave request failed: ${res.status}`,
    );
  }
  return data as T;
}

function tenantPath(
  path: string,
  params: {
    organizationId?: MaybeTenantId;
    branchId?: MaybeTenantId;
    status?: string;
    userId?: MaybeTenantId;
  } = {},
) {
  const [pathname, existing = ""] = path.split("?");
  const qs = new URLSearchParams(existing);
  appendTenantQuery(qs, {
    organizationId: params.organizationId,
    branchId: params.branchId,
  });
  if (params.status) qs.set("status", params.status);
  if (cleanId(params.userId)) qs.set("user_id", cleanId(params.userId));
  return `${pathname}?${qs.toString()}`;
}

export async function getLeaves(params: {
  organizationId: number | string;
  branchId?: number | string | null;
  status?: string;
  userId?: number | string | null;
}): Promise<LeaveRequest[]> {
  const rows = await leaveJson<RawLeaveRequest[]>(
    tenantPath("/api/leaves", params),
  );
  return rows.map(mapLeave);
}

/**
 * Effective, branch-aware leave-type paid/unpaid map for the current
 * tenant scope (GET /api/leaves/types — org_id is pinned server-side to
 * the authenticated dashboard session; branchId here is only ever used
 * as an optional override on top of the org-wide default). Single source
 * of truth for "which leave types exist" across the Leave Management
 * filter and (via the mobile-facing counterpart route) the app's
 * Apply-for-Leave form — see support_db_payroll.get_leave_type_rules.
 */
export async function getLeaveTypeRules(params: {
  organizationId: number | string;
  branchId?: number | string | null;
}): Promise<LeaveTypeRules> {
  const response = await leaveJson<{ leaveTypeRules?: LeaveTypeRules }>(
    tenantPath("/api/leaves/types", params),
  );
  return response.leaveTypeRules ?? {};
}

/** Per-leave-type annual paid-day quota, e.g. { annual: 12, sick: 6 }. A
 * type absent from this map has no configured quota (unknown, not zero —
 * see useLeaveHistory). Sourced from the same PayrollPolicy.leaveTypeQuotas
 * field getLeaveTypeRules reads leaveTypeRules from. */
export type LeaveTypeQuotas = Record<string, number>;

/**
 * leaveTypeRules + leaveTypeQuotas in a single request — the Leave
 * Management History tab needs both to render "Total Paid Leaves" and
 * "Remaining", and they always come from the same PayrollPolicy read on
 * the backend (see support_db_payroll.get_leave_type_allocations), so
 * fetching them separately would just be two round trips for one answer.
 */
export async function getLeaveTypeAllocations(params: {
  organizationId: number | string;
  branchId?: number | string | null;
}): Promise<{ leaveTypeRules: LeaveTypeRules; leaveTypeQuotas: LeaveTypeQuotas }> {
  const response = await leaveJson<{
    leaveTypeRules?: LeaveTypeRules;
    leaveTypeQuotas?: LeaveTypeQuotas;
  }>(tenantPath("/api/leaves/types", params));
  return {
    leaveTypeRules: response.leaveTypeRules ?? {},
    leaveTypeQuotas: response.leaveTypeQuotas ?? {},
  };
}

export async function createLeaveRequest(
  payload: CreateLeavePayload,
): Promise<LeaveRequest> {
  const organizationId = cleanId(payload.organizationId);
  if (!organizationId)
    throw new Error("organization_id is required to create leave request.");

  const body = {
    ...payload,
    organization_id: organizationId,
    branch_id: payload.branchId ?? null,
    user_id:
      payload.user_id ?? payload.userId ?? payload.staff_id ?? payload.staffId,
    leave_type: payload.leave_type ?? payload.type ?? "annual",
    half_day_period: payload.half_day_period ?? payload.halfDayPeriod ?? null,
    half_day_start_time:
      payload.half_day_start_time ?? payload.halfDayStartTime ?? null,
    half_day_end_time:
      payload.half_day_end_time ?? payload.halfDayEndTime ?? null,
    start_date: payload.start_date ?? payload.startDate,
    end_date: payload.end_date ?? payload.endDate,
  };

  const response = await leaveJson<
    RawLeaveRequest | { leave?: RawLeaveRequest; id?: string }
  >("/api/leaves", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return mapLeave((response as any).leave ?? (response as RawLeaveRequest));
}

export async function updateLeaveStatus(
  leaveId: string,
  status: "approved" | "rejected",
  approvedBy = "Admin",
  organizationId?: number | string | null,
): Promise<void> {
  const orgId = cleanId(organizationId);
  if (!orgId)
    throw new Error("organization_id is required to update leave status.");
  await leaveJson<{ success: boolean }>(
    `/api/leaves/${encodeURIComponent(String(leaveId))}`,
    {
      method: "PUT",
      body: JSON.stringify({
        status,
        approved_by: approvedBy,
        organization_id: orgId,
      }),
    },
  );
}

export async function deleteLeaveRequest(
  leaveId: string,
  organizationId?: number | string | null,
): Promise<void> {
  const orgId = cleanId(organizationId);
  if (!orgId)
    throw new Error("organization_id is required to delete leave request.");
  await leaveJson<{ success: boolean }>(
    `/api/leaves/${encodeURIComponent(String(leaveId))}`,
    {
      method: "DELETE",
      body: JSON.stringify({ organization_id: orgId }),
    },
  );
}