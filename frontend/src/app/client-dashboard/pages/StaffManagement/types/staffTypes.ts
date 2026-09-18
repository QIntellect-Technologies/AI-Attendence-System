// /**
//  * modules/staff/types/staffTypes.ts
//  * ─────────────────────────────────────────────────────────────────────────────
//  * Local Staff data contract — the StaffMember shape the directory UI works
//  * with, plus the small unions and option types that hang off it. This is the
//  * leaf of the module's dependency graph: it imports types only, never
//  * components, so anything here is safe to import from anywhere in the module.
//  * ─────────────────────────────────────────────────────────────────────────────
//  */

// import {
//   type ShiftDefinition,
//   type StaffWorkType,
// } from "../../../contexts/OrgConfigContext";

// // ─── Local Staff data contract ───────────────────────────────────────────────
// // DRY / backend-ready media fields:
// // - profileImageUrl is used everywhere as the employee picture.
// // For dummy data these are browser object URLs. Later the backend can return
// // permanent URLs with the same field names, so the UI needs minimal changes.

// export type StaffStatus = "active" | "inactive" | "pending";
// export type StaffDirectoryTab = "directory" | "shifts" | "visits" | "archived";

// export interface StaffMember {
//   id: string;
//   userId: string;
//   employeeId: string;
//   personCode: string;
//   registrationNumber?: string;
//   studentId?: string;
//   rollNo?: string;
//   code?: string;

//   name: string;
//   email?: string;
//   phone: string;

//   branchId: number;
//   branchName: string;

//   department: string;
//   designationId?: string | null;
//   role: string;
//   position: string;
//   peopleType: string;

//   // Client Dashboard permission role (staff/manager/hr/admin/employee) —
//   // deliberately separate from `role`/`position` above, which are the job
//   // TITLE (e.g. "Cashier"), not an account permission. Sourced from the
//   // backend's dedicated `accountRole`/`account_role`/`client_role` fields
//   // (see toStaffMember), never from `role`/`position`, since those already
//   // fall back to displaying the account role as a job-title placeholder
//   // when no position is set — a pre-existing display quirk this must not
//   // inherit for permission purposes.
//   accountRole: string;

//   status: StaffStatus;
//   salary: number;
//   benefits: string[];
//   joinDate: string;

//   moduleAccess: string[];
//   accessModules: string[];

//   staffType: StaffWorkType;
//   shift: string;
//   shiftId: ShiftDefinition["id"];
//   shiftLabel: string;
//   shiftStart: string;
//   shiftEnd: string;

//   presentDays: number;
//   createdAt: string;
//   updatedAt: string;

//   profileImageUrl: string;
//   profileImageName: string;

//   // Reporting Hierarchy — populated by toStaffMember from the /api/staff
//   // list response (manager_id / linked_client_user_id / dashboard_scope).
//   // Optional: legacy numeric-org staff rows and pre-migration schemas may
//   // not carry these yet.
//   managerId?: string;
//   linkedClientUserId?: string;
//   dashboardScope?: "branch" | "team";

//   // ── Attendance location config ──────────────────────────────────────
//   // Field staff: static-location geofence (lat/lng + radius). Null means
//   // "not configured yet" — distinct from 0,0, which would silently pass
//   // a "distance === 0" check.
//   geofenceLat?: number | null;
//   geofenceLng?: number | null;
//   geofenceRadiusMeters?: number | null;
//   geofenceLabel?: string;
//   // Office staff: dynamic WiFi network, replacing the app's old
//   // hardcoded SSID/BSSID constants. Multiple BSSIDs support a branch
//   // with more than one access point (mesh) on the same SSID.
//   officeSsid?: string;
//   officeBssidList?: string[];

//   // ── Identity documents ──────────────────────────────────────────────
//   // CNIC (Pakistani national ID) for the person themselves. Required for
//   // every non-student people type (employees/workers/teachers/staff);
//   // students don't carry their own CNIC in this form — they carry their
//   // father's, below.
//   cnic?: string;
//   // Guardian details, required for students only. Kept as three discrete
//   // fields (not a nested object) so they slot into the same flat
//   // StaffMember/StaffFormData/API-payload shape everything else here uses.
//   fatherName?: string;
//   fatherCnic?: string;
//   fatherPhone?: string;
// }

// export interface NamedConfigOption {
//   id: string;
//   name: string;
//   city?: string;
// }



/**
 * modules/staff/types/staffTypes.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Local Staff data contract — the StaffMember shape the directory UI works
 * with, plus the small unions and option types that hang off it. This is the
 * leaf of the module's dependency graph: it imports types only, never
 * components, so anything here is safe to import from anywhere in the module.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  type ShiftDefinition,
  type StaffWorkType,
} from "../../../contexts/OrgConfigContext";

// ─── Local Staff data contract ───────────────────────────────────────────────
// DRY / backend-ready media fields:
// - profileImageUrl is used everywhere as the employee picture.
// For dummy data these are browser object URLs. Later the backend can return
// permanent URLs with the same field names, so the UI needs minimal changes.

export type StaffStatus = "active" | "inactive" | "pending";
export type StaffDirectoryTab = "directory" | "shifts" | "visits" | "archived";

export interface StaffMember {
  id: string;
  userId: string;
  employeeId: string;
  personCode: string;
  registrationNumber?: string;
  studentId?: string;
  rollNo?: string;
  code?: string;

  name: string;
  email?: string;
  phone: string;

  branchId: number;
  branchName: string;

  department: string;
  /**
   * Real backend department UUID (departments.id) this person is currently
   * assigned to via the Live Assignment panel — distinct from `department`
   * above, which is the legacy free-text name (now just a display fallback
   * for staff never migrated; see support_db_staff._client_staff_safe's
   * department_display). Populated from the API's department_id/
   * departmentId field. null/undefined means "unassigned".
   */
  departmentId?: string | null;
  designationId?: string | null;
  designationName?: string;
  role: string;
  position: string;
  peopleType: string;

  // Client Dashboard permission role (staff/manager/hr/admin/employee) —
  // deliberately separate from `role`/`position` above, which are the job
  // TITLE (e.g. "Cashier"), not an account permission. Sourced from the
  // backend's dedicated `accountRole`/`account_role`/`client_role` fields
  // (see toStaffMember), never from `role`/`position`, since those already
  // fall back to displaying the account role as a job-title placeholder
  // when no position is set — a pre-existing display quirk this must not
  // inherit for permission purposes.
  accountRole: string;

  status: StaffStatus;
  salary: number;
  benefits: string[];
  joinDate: string;

  moduleAccess: string[];
  accessModules: string[];

  staffType: StaffWorkType;
  shift: string;
  shiftId: ShiftDefinition["id"];
  shiftLabel: string;
  shiftStart: string;
  shiftEnd: string;

  presentDays: number;
  createdAt: string;
  updatedAt: string;

  profileImageUrl: string;
  profileImageName: string;

  // Reporting Hierarchy — populated by toStaffMember from the /api/staff
  // list response (manager_id / linked_client_user_id / dashboard_scope).
  // Optional: legacy numeric-org staff rows and pre-migration schemas may
  // not carry these yet.
  managerId?: string;
  linkedClientUserId?: string;
  dashboardScope?: "branch" | "team";

  // ── Attendance location config ──────────────────────────────────────
  // Field staff: static-location geofence (lat/lng + radius). Null means
  // "not configured yet" — distinct from 0,0, which would silently pass
  // a "distance === 0" check.
  geofenceLat?: number | null;
  geofenceLng?: number | null;
  geofenceRadiusMeters?: number | null;
  geofenceLabel?: string;
  // Office staff: dynamic WiFi network, replacing the app's old
  // hardcoded SSID/BSSID constants. Multiple BSSIDs support a branch
  // with more than one access point (mesh) on the same SSID.
  officeSsid?: string;
  officeBssidList?: string[];

  // ── Identity documents ──────────────────────────────────────────────
  // CNIC (Pakistani national ID) for the person themselves. Required for
  // every non-student people type (employees/workers/teachers/staff);
  // students don't carry their own CNIC in this form — they carry their
  // father's, below.
  cnic?: string;
  // Guardian details, required for students only. Kept as three discrete
  // fields (not a nested object) so they slot into the same flat
  // StaffMember/StaffFormData/API-payload shape everything else here uses.
  fatherName?: string;
  fatherCnic?: string;
  fatherPhone?: string;
}

export interface NamedConfigOption {
  id: string;
  name: string;
  city?: string;
}