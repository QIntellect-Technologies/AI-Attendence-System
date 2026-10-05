// frontend/src/app/client-dashboard/pages/Branches/api/branchApi.ts
import { BASE_URL, dashboardAuthHeaders } from "../../../api/api";
import { cleanId } from "../../../utils/tenantScope";

/**
 * Per-branch row from GET /api/branches/summary.
 *
 * Backend serves two shapes depending on tenant type (see app.py
 * api_get_branch_summary -> database.get_branch_comparison_summary for
 * legacy numeric orgs, support_db.get_client_branch_summary for Supabase
 * UUID orgs). Both emit snake_case + camelCase duplicates of every metric,
 * but only the UUID path includes backend_branch_id/branch_uuid/capacity —
 * legacy numeric orgs never send those. Always alias-check before use.
 */
export interface BranchSummaryRow {
  id: number;
  branchId: number;
  name: string;
  branchName: string;
  city: string;
  branchCity: string;
  staff: number;
  staffCount: number;
  activeStaff: number;
  enrolledStaff: number;
  presentToday: number;
  absentToday: number;
  attendance: number;
  attendanceRate: number;
  payroll: number;
  revenue: number;
  late: number;
  lateCount: number;
  pendingLeaves: number;
  overtimeHours: number;
  // UUID-tenant only (Supabase-backed organizations)
  backend_branch_id?: string;
  backendBranchId?: string;
  branch_uuid?: string;
  branchUuid?: string;
  maxStaffCapacity?: number;
  max_staff_capacity?: number;
}

export interface BranchSummaryTotals {
  branches: number;
  staff: number;
  activeStaff: number;
  enrolledStaff: number;
  presentToday: number;
  absentToday: number;
  payroll: number;
  late: number;
  pendingLeaves: number;
  overtimeHours: number;
  attendanceRate: number;
  archivedStaff?: number; // UUID-tenant only
}

export interface BranchSummaryResponse {
  organization_id: string | number;
  organization_name?: string;
  generated_at: string;
  totals: BranchSummaryTotals;
  branches: BranchSummaryRow[];
}

interface RawBranchSummaryApiResponse extends BranchSummaryResponse {
  success: boolean;
  error?: string;
  message?: string;
}

export interface FetchBranchSummaryParams {
  organizationId: number | string;
  userId?: number | string | null;
  peopleType?: string | null;
}

async function errorFromResponse(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      return new Error(parsed.message || parsed.error || text);
    } catch {
      return new Error(text);
    }
  }
  return new Error(`Request failed: ${response.status} ${response.statusText}`);
}

export async function fetchBranchSummary({
  organizationId,
  userId,
  peopleType,
}: FetchBranchSummaryParams): Promise<BranchSummaryResponse> {
  const cleanOrgId = cleanId(organizationId);
  if (!cleanOrgId) throw new Error("organizationId is required");

  const params = new URLSearchParams({ organization_id: cleanOrgId });
  const cleanUserId = userId != null ? cleanId(userId) : "";
  if (cleanUserId) params.set("user_id", cleanUserId);
  const cleanPeopleType =
    typeof peopleType === "string" ? peopleType.trim() : "";
  if (cleanPeopleType) params.set("people_type", cleanPeopleType);

  const response = await fetch(
    `${BASE_URL}/api/branches/summary?${params.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...dashboardAuthHeaders() },
    },
  );

  if (!response.ok) throw await errorFromResponse(response);

  const data = (await response.json()) as RawBranchSummaryApiResponse;
  if (!data.success) {
    throw new Error(
      data.message || data.error || "Failed to load branch summary.",
    );
  }

  const {
    success: _success,
    error: _error,
    message: _message,
    ...summary
  } = data;
  return summary;
}
