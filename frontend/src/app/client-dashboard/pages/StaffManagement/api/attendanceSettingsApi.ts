/**
 * modules/staff/api/attendanceSettingsApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Client API adapter for the real shift/department assignment + attendance
 * settings endpoints registered by client_shift_routes.py and
 * client_attendance_settings_routes.py (blueprint prefix /api/client).
 *
 * This is intentionally a separate file from staffApi.ts: staffApi.ts owns
 * the legacy /api/staff CRUD surface (including the free-text `shift`/
 * `department` fields still written by StaffModal's create/edit form).
 * This file owns the newer, real-relation endpoints — assigning a staff
 * member to an actual `shifts` row or `departments` row by id — and is
 * additive. Nothing here repurposes or removes the legacy fields.
 */

import { BASE_URL, type User } from "../../../api/api";
import type { ShiftConflict } from "../utils/shiftOverlap";

/**
 * A 409 from a shift write: the request was well-formed but collides with a
 * shift that already exists (see support_db_shift_overlap.py).
 *
 * A plain `new Error(message)` would flatten the backend's structured
 * `conflicts` array into a sentence, so the UI could only ever print it —
 * it couldn't highlight the specific row that collides, or distinguish a
 * blocking duty overlap from a non-blocking grace-tail warning. Subclasses
 * Error, so every existing `catch (e) { e instanceof Error ? e.message : … }`
 * call site keeps rendering the same message it already did.
 */
export class ShiftConflictApiError extends Error {
  readonly conflicts: ShiftConflict[];

  constructor(message: string, conflicts: ShiftConflict[]) {
    super(message);
    this.name = "ShiftConflictApiError";
    this.conflicts = conflicts;
  }
}

/** Backend conflict rows are snake_case; the shared shiftOverlap module is
 * camelCase. Converted at this boundary so a conflict from the server and a
 * conflict found locally are the same shape everywhere downstream. */
function toShiftConflicts(raw: unknown): ShiftConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      shiftId: row.shift_id ? String(row.shift_id) : undefined,
      shiftName: String(row.shift_name ?? "Untitled shift"),
      severity: row.severity === "warning" ? "warning" : "conflict",
      overlapMinutes: Number(row.overlap_minutes ?? 0),
      window: String(row.window ?? ""),
    };
  });
}

async function clientJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    const message =
      data?.message || data?.error || `Request failed: ${res.status}`;
    if (res.status === 409 && Array.isArray(data?.conflicts)) {
      throw new ShiftConflictApiError(message, toShiftConflicts(data.conflicts));
    }
    throw new Error(message);
  }
  return data as T;
}

function qs(
  params: Record<string, string | number | null | undefined>,
): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      search.set(key, String(value));
    }
  });
  const str = search.toString();
  return str ? `?${str}` : "";
}

// ─── Departments ────────────────────────────────────────────────────────────

export interface DepartmentRecord {
  id: string;
  name: string;
  branch_id?: string;
  organization_id?: string | number;
  status?: "active" | "inactive" | string;
  is_active?: boolean;
  [key: string]: unknown;
}

export async function listBranchDepartments(
  branchId: number | string,
  organizationId: number | string,
  includeInactive = false,
): Promise<DepartmentRecord[]> {
  const res = await clientJson<{ departments: DepartmentRecord[] }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/departments${qs(
      {
        organization_id: organizationId,
        include_inactive: includeInactive ? "true" : undefined,
      },
    )}`,
  );
  return res.departments ?? [];
}

export async function createDepartment(
  branchId: number | string,
  organizationId: number | string,
  payload: { name: string; [key: string]: unknown },
): Promise<DepartmentRecord> {
  const res = await clientJson<{ department: DepartmentRecord }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/departments`,
    {
      method: "POST",
      body: JSON.stringify({ ...payload, organization_id: organizationId }),
    },
  );
  return res.department;
}

export async function updateDepartment(
  departmentId: string,
  organizationId: number | string,
  payload: Record<string, unknown>,
): Promise<DepartmentRecord> {
  const res = await clientJson<{ department: DepartmentRecord }>(
    `/api/client/departments/${encodeURIComponent(departmentId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...payload, organization_id: organizationId }),
    },
  );
  return res.department;
}

export async function deleteDepartment(
  departmentId: string,
  organizationId: number | string,
): Promise<void> {
  await clientJson<{ deleted: boolean }>(
    `/api/client/departments/${encodeURIComponent(departmentId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ organization_id: organizationId }),
    },
  );
}

/**
 * Assigns a staff member to a real department row. Additive: does not
 * touch the legacy free-text `department` string field managed by
 * staffApi.ts's updateStaffRecord.
 */
export async function assignStaffDepartment(
  staffId: number | string,
  departmentId: string | null,
  organizationId: number | string,
): Promise<Record<string, unknown>> {
  const res = await clientJson<{ staff: Record<string, unknown> }>(
    `/api/client/staff/${encodeURIComponent(String(staffId))}/department`,
    {
      method: "PATCH",
      body: JSON.stringify({
        department_id: departmentId,
        organization_id: organizationId,
      }),
    },
  );
  return res.staff;
}

// ─── Shifts ─────────────────────────────────────────────────────────────────

export interface ShiftRecord {
  id: string;
  branch_id?: string;
  organization_id?: string | number;
  people_type?: string;
  name: string;
  check_in_time: string;
  grace_minutes?: number;
  check_out_time?: string | null;
  checkout_grace_minutes?: number | null;
  /** Minutes to wait AFTER this shift's own grace window closes before
   * auto-syncing a confirmed leg to the cloud — see attendance_sync_worker's
   * anchor logic. Per-shift, not branch-wide: different shifts on the same
   * branch can have different sync cadences. */
  sync_delay_minutes?: number;
  is_active?: boolean;
  [key: string]: unknown;
}

export interface ShiftCreatePayload {
  name: string;
  people_type?: string;
  check_in_time: string;
  grace_minutes?: number;
  capture_check_out?: boolean;
  check_out_time?: string;
  checkout_grace_minutes?: number;
  sync_delay_minutes?: number;
}

export interface ShiftUpdatePayload {
  name?: string;
  check_in_time?: string;
  grace_minutes?: number;
  capture_check_out?: boolean;
  check_out_time?: string | null;
  checkout_grace_minutes?: number | null;
  sync_delay_minutes?: number;
  is_active?: boolean;
}

export async function listBranchShifts(
  branchId: number | string,
  organizationId: number | string,
  peopleType?: string | null,
): Promise<ShiftRecord[]> {
  const res = await clientJson<{ shifts: ShiftRecord[] }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/shifts${qs({
      organization_id: organizationId,
      people_type: peopleType,
    })}`,
  );
  return res.shifts ?? [];
}

/** A saved shift plus any non-blocking grace-tail warnings the backend
 * raised. A duty overlap never reaches here — it throws
 * ShiftConflictApiError from the 409. */
export interface ShiftWriteResult {
  shift: ShiftRecord;
  warnings: ShiftConflict[];
}

export async function createShift(
  branchId: number | string,
  organizationId: number | string,
  payload: ShiftCreatePayload,
): Promise<ShiftWriteResult> {
  const res = await clientJson<{ shift: ShiftRecord; warnings?: unknown }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/shifts`,
    {
      method: "POST",
      body: JSON.stringify({ ...payload, organization_id: organizationId }),
    },
  );
  return { shift: res.shift, warnings: toShiftConflicts(res.warnings) };
}

export async function updateShift(
  branchId: number | string,
  shiftId: string,
  organizationId: number | string,
  payload: ShiftUpdatePayload,
): Promise<ShiftWriteResult> {
  const res = await clientJson<{ shift: ShiftRecord; warnings?: unknown }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/shifts/${encodeURIComponent(shiftId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...payload, organization_id: organizationId }),
    },
  );
  return { shift: res.shift, warnings: toShiftConflicts(res.warnings) };
}

export async function deleteShift(
  branchId: number | string,
  shiftId: string,
  organizationId: number | string,
): Promise<void> {
  await clientJson<{ deleted: boolean }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/shifts/${encodeURIComponent(shiftId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ organization_id: organizationId }),
    },
  );
}

/**
 * Assigns a staff member to a real `shifts` row (shift_id_ref, per
 * support_db_attendance_gate.py's resolution precedence). The backend
 * response is the fully-resolved staff row — shift_label/duty_start/
 * duty_end already folded in from the `shifts` row (see
 * support_db_shifts.assign_staff_shift), not just the raw shift_id_ref —
 * so the caller can rebuild a complete StaffMember via
 * apiUserToStaffMember() instead of hand-patching individual fields.
 */
/** The name + window of a shift, as the backend reports it on an assignment
 * so the UI can say what changed. */
export interface AssignedShiftSummary {
  id: string;
  name: string;
  /** "09:00–17:00", or "09:00 (open-ended)". */
  window: string;
}

/** A staff member holds exactly ONE shift, so assigning a second REPLACES
 * the first. These two fields make that swap visible instead of silent —
 * see support_db_shifts.assign_staff_shift. `previous_shift` is null on a
 * first assignment, or when the shift being replaced has since been
 * deleted. They ride on the staff row itself, so this stays a `User` and
 * every existing caller keeps working unchanged. */
export type StaffWithShiftSwap = User & {
  assigned_shift?: AssignedShiftSummary | null;
  previous_shift?: AssignedShiftSummary | null;
};

export async function assignStaffShift(
  staffId: number | string,
  shiftId: string | null,
  organizationId: number | string,
): Promise<StaffWithShiftSwap> {
  const res = await clientJson<{ staff: StaffWithShiftSwap }>(
    `/api/client/staff/${encodeURIComponent(String(staffId))}/shift`,
    {
      method: "PATCH",
      body: JSON.stringify({
        shift_id: shiftId,
        organization_id: organizationId,
      }),
    },
  );
  return res.staff;
}

// ─── Capture settings / half-day windows / timing overrides ───────────────
// (Used by the Settings screens, not by StaffManagement.)

export interface CaptureSettings {
  mode: "shift" | "simple";
  check_in_time?: string | null;
  check_in_grace_minutes?: number;
  capture_check_out?: boolean;
  check_out_time?: string | null;
  check_out_grace_minutes?: number;
  sync_delay_minutes?: number;
  [key: string]: unknown;
}

export async function getCaptureSettings(
  branchId: number | string,
  peopleType: string,
  organizationId: number | string,
): Promise<CaptureSettings | null> {
  const res = await clientJson<{ capture_settings: CaptureSettings | null }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/capture-settings/${encodeURIComponent(peopleType)}${qs(
      {
        organization_id: organizationId,
      },
    )}`,
  );
  return res.capture_settings ?? null;
}

export async function upsertCaptureSettings(
  branchId: number | string,
  peopleType: string,
  organizationId: number | string,
  payload: Partial<CaptureSettings>,
): Promise<CaptureSettings> {
  const res = await clientJson<{ capture_settings: CaptureSettings }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/capture-settings/${encodeURIComponent(peopleType)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...payload, organization_id: organizationId }),
    },
  );
  return res.capture_settings;
}

/**
 * Period vocabulary MUST match the backend exactly — this is not a display
 * label, it's a lookup key. support_db_attendance_settings.py's
 * _HALF_DAY_PERIODS = ("first_half", "second_half") is the source of truth
 * (upsert_half_day_window rejects anything else with a 400), and
 * support_db.py's create_client_leave_request validates the same two values
 * for leave_requests.half_day_period — which is exactly the column
 * support_db_attendance_gate.py's _find_approved_half_day_leave joins
 * against to pick a window. "morning"/"afternoon" would save successfully
 * as its own row but would never be found by that lookup, so the half-day
 * override would silently never apply. Kept as a union type (not `string`)
 * so a third value anywhere in this file is a compile-time error, not a
 * runtime surprise.
 */

// Timing overrides and half-day windows removed from client API surface.
// Use manual instructions and branch default-shift endpoints instead.

// ─── Manual attendance instructions (admin-created overrides) ─────────────

export interface ManualInstruction {
  id: string;
  org_id?: string;
  branch_id?: string;
  staff_id?: string | null;
  person_code?: string | null;
  people_type?: string | null;
  attendance_date: string;
  check_in_time?: string | null;
  check_in_grace_minutes?: number | null;
  check_out_time?: string | null;
  check_out_grace_minutes?: number | null;
  reason?: string | null;
  notes?: string | null;
  status?: string;
  [key: string]: unknown;
}

export async function listManualInstructions(
  branchId: number | string,
  organizationId: number | string,
  peopleType?: string | null,
  staffId?: number | string | null,
): Promise<ManualInstruction[]> {
  const res = await clientJson<{ manual_instructions: ManualInstruction[] }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/manual-instructions${qs(
      {
        organization_id: organizationId,
        people_type: peopleType,
        staff_id: staffId,
      },
    )}`,
  );
  return res.manual_instructions ?? [];
}

export async function createManualInstruction(
  branchId: number | string,
  organizationId: number | string,
  payload: Partial<ManualInstruction>,
): Promise<ManualInstruction> {
  const res = await clientJson<{ manual_instruction: ManualInstruction }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/manual-instructions`,
    {
      method: "POST",
      body: JSON.stringify({ ...payload, organization_id: organizationId }),
    },
  );
  return res.manual_instruction;
}

export async function deleteManualInstruction(
  instructionId: string,
  organizationId: number | string,
): Promise<void> {
  await clientJson<{ deleted: boolean }>(
    `/api/client/manual-instructions/${encodeURIComponent(instructionId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ organization_id: organizationId }),
    },
  );
}

// ─── Branch default shift / grace override helper

export async function setBranchDefaultShift(
  branchId: number | string,
  peopleType: string,
  organizationId: number | string,
  payload: {
    shift_id?: string | null;
    check_in_grace_override?: number | null;
    check_out_grace_override?: number | null;
  },
): Promise<Record<string, unknown>> {
  const res = await clientJson<{ default_shift: Record<string, unknown> }>(
    `/api/client/branches/${encodeURIComponent(String(branchId))}/default-shift/${encodeURIComponent(peopleType)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ...payload, organization_id: organizationId }),
    },
  );
  return res.default_shift;
}