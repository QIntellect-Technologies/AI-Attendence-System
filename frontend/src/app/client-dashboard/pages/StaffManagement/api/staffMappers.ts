/**
 * modules/staff/api/staffMappers.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Staff API ↔ ModuleContext adapter.
 *
 * Person-code rules:
 * - Students are identified by registration number.
 * - Employees/workers/teachers/staff use their template-specific person code.
 * - Backend UUIDs remain internal and are never used as the visible person code.
 */

import type { User } from "../../../api/api";
import type { StaffMember } from "../../../contexts/ModuleContext";
import type { ShiftDefinition } from "../../../contexts/OrgConfigContext";
import { normalizePeopleType } from "../types/types";

type StaffApiUser = User & {
  updated_at?: string | null;
  branch_ui_id?: number | string | null;
  branchUiId?: number | string | null;
  branchId?: number | string | null;
  branchName?: string | null;
  department_name?: string | null;
  role_name?: string | null;
  people_type?: string | null;
  peopleType?: string | null;
  person_type?: string | null;
  personType?: string | null;
  person_code?: string | null;
  personCode?: string | null;
  registration_number?: string | null;
  registrationNumber?: string | null;
  employee_number?: string | null;
  employeeNumber?: string | null;
  worker_id?: string | null;
  workerId?: string | null;
  teacher_code?: string | null;
  teacherCode?: string | null;
  shift_id_ref?: string | null;
  shiftIdRef?: string | null;

  geofence_lat?: number | string | null;
  geofenceLat?: number | string | null;
  geofence_lng?: number | string | null;
  geofenceLng?: number | string | null;
  geofence_radius_meters?: number | string | null;
  geofenceRadiusMeters?: number | string | null;
  geofence_label?: string | null;
  geofenceLabel?: string | null;

  office_ssid?: string | null;
  officeSsid?: string | null;
  office_bssid_list?: string[] | null;
  officeBssidList?: string[] | null;

  cnic?: string | null;
  father_name?: string | null;
  fatherName?: string | null;
  father_cnic?: string | null;
  fatherCnic?: string | null;
  father_phone?: string | null;
  fatherPhone?: string | null;
  father_number?: string | null;
  fatherNumber?: string | null;
};

export function backendStaffId(member: StaffMember): number | string | null {
  const raw = member.userId ?? member.id;
  if (raw === undefined || raw === null) return null;

  const text = String(raw).trim();
  if (!text) return null;

  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : text;
}

function toUiBranchId(...values: unknown[]): number {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function firstNumberOrNull(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function firstStringArray(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      const cleaned = value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
      if (cleaned.length) return cleaned;
    }
  }
  return [];
}

export function apiUserToStaffMember(user: User): StaffMember {
  const row = user as StaffApiUser;
  const now = new Date().toISOString();

  const branchId = toUiBranchId(
    row.branch_ui_id,
    row.branchUiId,
    row.branchId,
    row.branch_id,
  );

  const peopleType = normalizePeopleType(
    row.peopleType ??
      row.people_type ??
      row.personType ??
      row.person_type ??
      row.role ??
      "staff",
  );

  const personCode = firstText(
    row.personCode,
    row.person_code,
    row.registrationNumber,
    row.registration_number,
    row.employeeNumber,
    row.employee_number,
    row.workerId,
    row.worker_id,
    row.teacherCode,
    row.teacher_code,
    row.employee_id,
  );

  const status = (row.status ?? "active") as StaffMember["status"];
  const shiftId = row.shift_id ?? row.shift ?? "morning";
  const shiftLabel = row.shift_label ?? row.shift ?? "Morning";
  const position = row.position ?? row.role_name ?? "Staff";

  return {
    id: String(row.id),
    employeeId: String(personCode || row.employee_id || row.id),
    personCode,
    registrationNumber:
      peopleType === "student"
        ? personCode
        : firstText(row.registrationNumber, row.registration_number),
    userId: String(row.id),

    name: row.name,
    email: row.email ?? "",
    phone: row.phone ?? "",

    branchId,
    branchName: row.branchName ?? row.branch_name ?? "",

    department: row.department ?? row.department_name ?? "",
    role: position,
    position,
    peopleType,
    personType: peopleType,

    status,
    salary: Number(row.salary ?? 0),
    joinDate: row.join_date ?? "",

    staffType: row.staff_type ?? "office",

    shift: String(shiftId) as StaffMember["shift"],
    shiftId: String(shiftId) as ShiftDefinition["id"],
    shiftLabel: String(shiftLabel),
    shiftStart: row.duty_start ?? "09:00",
    shiftEnd: row.duty_end ?? "17:00",
    // The backend now resolves shift_id_ref -> the real `shifts` row and
    // folds its name/check_in_time/check_out_time into shift_label/
    // duty_start/duty_end above, so shiftLabel/shiftStart/shiftEnd are
    // already correct post-fix. shiftIdRef is carried through anyway so any
    // UI that needs to know "does this person have a real shift assigned"
    // (vs. the legacy free-text shift) doesn't have to re-derive it.
    shiftIdRef: row.shiftIdRef ?? row.shift_id_ref ?? null,

    moduleAccess: row.access_modules ?? [],
    accessModules: row.access_modules ?? [],

    presentDays: 0,

    profileImageUrl: row.profile_image_url ?? undefined,
    profileImageName: row.profile_image_name ?? undefined,

    createdAt: row.created_at ?? now,
    updatedAt: row.updated_at ?? row.created_at ?? now,

    // Field-staff geofence (static-location scenario) — null/undefined
    // means "not configured yet," which the mobile app and dashboard both
    // need to distinguish from "configured at 0,0."
    geofenceLat: firstNumberOrNull(row.geofenceLat, row.geofence_lat),
    geofenceLng: firstNumberOrNull(row.geofenceLng, row.geofence_lng),
    geofenceRadiusMeters: firstNumberOrNull(
      row.geofenceRadiusMeters,
      row.geofence_radius_meters,
    ),
    geofenceLabel: firstText(row.geofenceLabel, row.geofence_label),

    // Office-staff WiFi config — replaces the app's old hardcoded
    // SSID/single-BSSID constants. bssidList supports mesh offices with
    // multiple access points on the same SSID.
    officeSsid: firstText(row.officeSsid, row.office_ssid),
    officeBssidList: firstStringArray(
      row.officeBssidList,
      row.office_bssid_list,
    ),

    // Identity documents. Cast through `as StaffMember` below like every
    // other field in this object, since ModuleContext's StaffMember type
    // isn't the source of truth here — StaffManagement's own StaffMember
    // (built from this via toStaffMember) is what actually declares these.
    cnic: firstText(row.cnic),
    fatherName: firstText(row.fatherName, row.father_name),
    fatherCnic: firstText(row.fatherCnic, row.father_cnic),
    fatherPhone: firstText(
      row.fatherPhone,
      row.father_phone,
      row.fatherNumber,
      row.father_number,
    ),
  } as StaffMember;
}