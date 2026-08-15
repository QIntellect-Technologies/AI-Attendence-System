/**
 * modules/attendance-settings/api/departmentsApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Client for the Phase-1 `departments` table (UUID, org+branch scoped).
 *
 * This is NOT the same concept as OrgConfigContext's `OrgDepartment`
 * (a numeric-id classification/grouping label used for reporting). This
 * table is what attendance_timing_overrides and client_staff.department_id
 * actually reference — see support_db_attendance_gate.py's resolution
 * precedence. Kept as its own module (not under modules/staff) so both
 * StaffManagement (assignment) and Settings (full CRUD) can depend on it
 * without reaching into each other's feature folders.
 *
 * Mirrors client_attendance_settings_routes.py's department routes 1:1.
 */

import { BASE_URL } from "../../../api/api";

export interface Department {
  id: string;
  org_id: string;
  branch_id: string | null;
  name: string;
  code: string | null;
  status: "active" | "inactive";
  created_at?: string;
  updated_at?: string;
}

export interface DepartmentPayload {
  name?: string;
  code?: string | null;
  status?: "active" | "inactive";
}

interface Envelope<T extends object> {
  success: boolean;
  error?: string;
  message?: string;
}

async function settingsJson<T extends object>(
  path: string,
  options?: RequestInit,
): Promise<T & Envelope<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...options,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    throw new Error(body?.error ?? body?.message ?? res.statusText);
  }
  return body as T & Envelope<T>;
}

function requireId(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export async function listDepartments(
  organizationId: number | string,
  branchId: number | string,
  options: { includeInactive?: boolean } = {},
): Promise<Department[]> {
  const orgId = requireId(organizationId, "organization_id");
  const brId = requireId(branchId, "branch_id");

  const qs = new URLSearchParams({ organization_id: orgId });
  if (options.includeInactive) qs.set("include_inactive", "true");

  const body = await settingsJson<{ departments: Department[] }>(
    `/api/client/branches/${encodeURIComponent(brId)}/departments?${qs.toString()}`,
  );
  return body.departments ?? [];
}

export async function createDepartment(
  organizationId: number | string,
  branchId: number | string | null,
  payload: DepartmentPayload & { name: string },
): Promise<Department> {
  const orgId = requireId(organizationId, "organization_id");
  const brId = branchId ? String(branchId) : "org-wide";

  const body = await settingsJson<{ department: Department }>(
    `/api/client/branches/${encodeURIComponent(brId)}/departments`,
    {
      method: "POST",
      body: JSON.stringify({ ...payload, organization_id: orgId }),
    },
  );
  return body.department;
}

export async function updateDepartment(
  organizationId: number | string,
  departmentId: string,
  payload: DepartmentPayload,
): Promise<Department> {
  const orgId = requireId(organizationId, "organization_id");
  const deptId = requireId(departmentId, "department_id");

  const body = await settingsJson<{ department: Department }>(
    `/api/client/departments/${encodeURIComponent(deptId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...payload, organization_id: orgId }),
    },
  );
  return body.department;
}

export async function deleteDepartment(
  organizationId: number | string,
  departmentId: string,
): Promise<void> {
  const orgId = requireId(organizationId, "organization_id");
  const deptId = requireId(departmentId, "department_id");

  await settingsJson<{ deleted: boolean }>(
    `/api/client/departments/${encodeURIComponent(deptId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ organization_id: orgId }),
    },
  );
}

/**
 * Assign (or clear, if departmentId is null) a staff member's department.
 * Backend: support_db_attendance_settings.assign_staff_department.
 */
export async function assignStaffDepartment(
  organizationId: number | string,
  staffId: number | string,
  departmentId: string | null,
): Promise<void> {
  const orgId = requireId(organizationId, "organization_id");
  const stId = requireId(staffId, "staff_id");

  await settingsJson<{ staff: unknown }>(
    `/api/client/staff/${encodeURIComponent(stId)}/department`,
    {
      method: "PATCH",
      body: JSON.stringify({
        organization_id: orgId,
        department_id: departmentId,
      }),
    },
  );
}
