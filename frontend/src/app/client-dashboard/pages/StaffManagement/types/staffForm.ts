/**
 * modules/staff/types/staffForm.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Add/Edit form contract. Kept separate from StaffModal so the validation,
 * payload-building and credential helpers can depend on the form shape
 * without importing the modal component (which would be a cycle).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type StaffWorkType } from "../../../contexts/OrgConfigContext";
import { type StaffMember } from "./staffTypes";

// ─── Form data type ───────────────────────────────────────────────────────────
// Mirrors the string-based fields on StaffMember exactly.
// department and role are stored as strings (names), not numeric IDs.

export interface StaffFormData {
  name: string;
  personCode: string;
  email?: string;
  phone: string;
  branchId: number;
  department: string;
  role: string;
  status: StaffMember["status"];
  salary: number;
  benefits: string[];
  joinDate: string;
  staffType: StaffWorkType;
  shift: string;
  /**
   * Only meaningful when shift === "custom". This person's own start/end
   * time — never written into shiftDefinitions/cfg.staffShiftDefinitions,
   * never shown in "Company Shift Timings," never offered to anyone else
   * in the Default Shift dropdown. Persisted only on this staff member's
   * own shiftStart/shiftEnd fields.
   */
  customShiftStart?: string;
  customShiftEnd?: string;
  moduleAccess: string[];

  /**
   * Real backend shift UUID (shifts.id), selected from the live "Shift"
   * dropdown — distinct from `shift`/`customShiftStart`/`customShiftEnd`
   * above, which drive the legacy ShiftDefinition system. Empty string
   * means "unassigned". For an existing staff member this is applied
   * immediately (see handleShiftAssignmentChange); for a new one it's
   * applied right after creation (see handleSave).
   */
  liveShiftId?: string;

  profileImageUrl?: string;
  profileImageName?: string;

  /**
   * Reporting Hierarchy selections. On the Edit modal these are applied
   * immediately (see handleManagerChange/handleLinkedAccountChange/
   * handleDashboardScopeChange — PATCH-on-change against the real
   * staff_id). On the Add modal there is no staff_id yet, so a selection
   * here is only staged locally and applied right after createStaff()
   * resolves — same "apply right after creation" pattern liveShiftId
   * already uses for the live shift dropdown (see handleSave).
   */
  managerId?: string;
  linkedClientUserId?: string;
  dashboardScope?: "branch" | "team";

  /**
   * Client Dashboard permission role for this person's own login — see
   * StaffMember.accountRole for why this is separate from `role` above
   * (job title). Only "admin" or "staff" now (the old hr/manager/employee
   * presets are gone — see role_permissions.py). Defaults to "staff" (no
   * dashboard admin access; actual module access comes from moduleAccess
   * below, not from this field). Only settable by a session with
   * canGrantAdmin (StaffModal prop) — that gate is enforced again
   * server-side (support_db_staff's granted_by_is_admin check) since a
   * hidden form control is a UX nicety, not a security boundary.
   */
  accountRole: string;

  // ── Attendance location config ──────────────────────────────────────
  // Field staff (static-location scenario): geofence center + radius.
  // Kept as strings in the form (raw input text) so the lat/lng fields
  // can be empty/partial mid-typing without fighting a number input;
  // parsed to number | null only when building the API payload.
  geofenceLat: string;
  geofenceLng: string;
  geofenceRadiusMeters: string;
  geofenceLabel: string;
  // Office staff: dynamic WiFi network config, replacing the app's old
  // hardcoded SSID/BSSID constants.
  officeSsid: string;
  officeBssidList: string[];

  // ── Identity documents ──────────────────────────────────────────────
  // cnic: required for every non-student people type.
  // fatherName/fatherCnic/fatherPhone: required for students only.
  cnic: string;
  fatherName: string;
  fatherCnic: string;
  fatherPhone: string;
}

export interface StaffMediaFiles {
  profileImageFile: File | null;
}

export const EMPTY_FORM: StaffFormData = {
  name: "",
  personCode: "",
  email: "",
  phone: "",
  branchId: 0,
  department: "",
  role: "",
  status: "active",
  salary: 50000,
  benefits: [],
  joinDate: new Date().toISOString().split("T")[0],
  staffType: "office",
  shift: "morning",
  customShiftStart: "09:00",
  customShiftEnd: "17:00",
  moduleAccess: [],
  liveShiftId: "",
  profileImageUrl: "",
  profileImageName: "",
  managerId: "",
  linkedClientUserId: "",
  dashboardScope: "branch",
  accountRole: "staff",
  geofenceLat: "",
  geofenceLng: "",
  geofenceRadiusMeters: "100",
  geofenceLabel: "",
  officeSsid: "",
  officeBssidList: [],
  cnic: "",
  fatherName: "",
  fatherCnic: "",
  fatherPhone: "",
};
