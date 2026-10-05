/**
 * modules/attendance/api/attendanceExceptionsApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin adapter for the two routes support_db_attendance_exceptions.py backs:
 *   GET  /api/client/attendance/exceptions
 *   POST /api/client/attendance/<attendance_id>/resolve
 *
 * Mirrors leaveApi.ts's conventions exactly (same BASE_URL, same
 * dashboardAuthToken header, same {success,...}/{success:false,error}
 * envelope handling) so this file introduces no new fetch pattern.
 */

import { BASE_URL } from "../../../api/api";
import { cleanId, type MaybeTenantId } from "../../../utils/tenantScope";

export type ExceptionLeg = "check_in" | "check_out";

/** check_in: 'late' | 'half_day'. check_out: 'early_leave' | 'late' |
 * 'overtime' | 'half_day'. Kept as `string` here (not a union) since the
 * two legs have different valid sets and the picker UI already only ever
 * offers the right subset per row — support_db_attendance_exceptions.py is
 * the single source of truth for which values are actually valid. */
export type ExceptionDecision = string;

export interface AttendanceException {
  id: string;
  org_id?: string;
  branch_id?: string | null;
  staff_id?: string | null;
  staff_name?: string | null;
  name?: string | null;
  timestamp?: string | null;
  check_out_timestamp?: string | null;
  status?: string | null;
  check_out_status?: string | null;
  notes?: string | null;
  day_status?: string | null;
  check_in_hold_reason?: string | null;
  check_out_hold_reason?: string | null;
  [key: string]: unknown;
}

interface ExceptionsListResponse {
  success: boolean;
  exceptions: AttendanceException[];
}

// Same storage key as leaveApi.ts/staffApi.ts — see leaveApi.ts's comment
// on why this is a duplicated plain constant rather than a shared import.
const DASHBOARD_AUTH_TOKEN_KEY = "dashboardAuthToken";

function dashboardAuthHeaders(): HeadersInit {
  try {
    const token = localStorage.getItem(DASHBOARD_AUTH_TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function exceptionsJson<T>(
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
      data?.message ||
        data?.error ||
        `Attendance exceptions request failed: ${res.status}`,
    );
  }
  return data as T;
}

function requireOrg(value: MaybeTenantId): string {
  const orgId = cleanId(value);
  if (!orgId) throw new Error("organization_id is required.");
  return orgId;
}

export async function listAttendanceExceptions(params: {
  organizationId: MaybeTenantId;
  branchId?: MaybeTenantId;
}): Promise<AttendanceException[]> {
  const qs = new URLSearchParams();
  qs.set("organization_id", requireOrg(params.organizationId));
  const branchId = cleanId(params.branchId);
  if (branchId) qs.set("branch_id", branchId);

  const response = await exceptionsJson<ExceptionsListResponse>(
    `/api/client/attendance/exceptions?${qs.toString()}`,
  );
  return response.exceptions ?? [];
}

export async function resolveAttendanceException(params: {
  organizationId: MaybeTenantId;
  attendanceId: string;
  leg: ExceptionLeg;
  decision: ExceptionDecision;
  note?: string;
  resolvedBy?: string | null;
}): Promise<AttendanceException> {
  const response = await exceptionsJson<{
    success: boolean;
    attendance: AttendanceException;
  }>(
    `/api/client/attendance/${encodeURIComponent(params.attendanceId)}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({
        organization_id: requireOrg(params.organizationId),
        leg: params.leg,
        decision: params.decision,
        note: params.note ?? null,
        resolved_by: params.resolvedBy ?? null,
      }),
    },
  );
  return response.attendance;
}

/** 'include' | 'exclude' -- an admin's payroll call on an already-classified
 * local-node row (day_status already half_day/short_leave/late/overtime).
 * Backed by client_payroll_decision_routes.py's
 * POST /api/client/payroll-decisions/<attendance_id> -- a lighter sibling
 * of resolveAttendanceException above: this row isn't awaiting
 * classification (that already happened on-device), only the payroll
 * effect is still undecided. See
 * support_db_attendance_exceptions.list_local_node_payroll_pending's
 * docstring for why this is a separate queue/endpoint from /resolve. */
export type PayrollDecision = "include" | "exclude";

export interface PayrollPendingRow extends AttendanceException {
  day_status?: string | null;
  check_out_payroll_decision?: PayrollDecision | null;
}

interface PayrollPendingListResponse {
  success: boolean;
  payroll_decisions: PayrollPendingRow[];
}

/**
 * Backed by client_payroll_decision_routes.py's
 * GET /api/client/branches/<branch_id>/payroll-decisions — the Phase 3
 * counterpart to listAttendanceExceptions above. branchId defaults to
 * "all" (every branch in the org), matching support_db_shifts.
 * list_branch_shifts' aggregate convention, since branch_id is a required
 * path segment on this route rather than an optional query param.
 */
export async function listLocalNodePayrollPending(params: {
  organizationId: MaybeTenantId;
  branchId?: MaybeTenantId;
}): Promise<PayrollPendingRow[]> {
  const qs = new URLSearchParams();
  qs.set("organization_id", requireOrg(params.organizationId));
  const branchId = cleanId(params.branchId) || "all";

  const response = await exceptionsJson<PayrollPendingListResponse>(
    `/api/client/branches/${encodeURIComponent(branchId)}/payroll-decisions?${qs.toString()}`,
  );
  return response.payroll_decisions ?? [];
}

export async function setPayrollDecision(params: {
  organizationId: MaybeTenantId;
  attendanceId: string;
  decision: PayrollDecision;
  note?: string;
  decidedBy?: string | null;
}): Promise<AttendanceException> {
  const response = await exceptionsJson<{
    success: boolean;
    attendance: AttendanceException;
  }>(
    `/api/client/payroll-decisions/${encodeURIComponent(params.attendanceId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        organization_id: requireOrg(params.organizationId),
        decision: params.decision,
        note: params.note ?? null,
        decided_by: params.decidedBy ?? null,
      }),
    },
  );
  return response.attendance;
}