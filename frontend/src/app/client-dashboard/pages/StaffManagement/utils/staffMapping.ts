/**
 * modules/staff/utils/staffMapping.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * ModuleContext StaffMember -> local StaffMember adapter, plus backend id
 * resolution. Complements api/staffMappers.ts (backend row -> ModuleContext);
 * this file is the second hop of that same chain.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type StaffMember as ModuleStaffMember } from "../../../contexts/ModuleContext";
import { type ShiftDefinition } from "../../../contexts/OrgConfigContext";
import { normalizePeopleType } from "../types/types";
import { type NamedConfigOption, type StaffMember } from "../types/staffTypes";
import {
  asNumber,
  asNumberOrNull,
  asRecord,
  asStaffWorkType,
  asStatus,
  asString,
  asStringArray,
} from "./staffCoercions";

export const toStaffMember = (member: ModuleStaffMember): StaffMember => {
  const raw = asRecord(member);

  const id = asString(
    raw.id ?? raw.userId ?? raw.user_id ?? raw.employeeId ?? raw.employee_id,
    "",
  );

  const userId = asString(raw.userId ?? raw.user_id ?? raw.id, id);
  const peopleType = asString(
    raw.peopleType ?? raw.people_type ?? raw.personType ?? raw.person_type,
    "staff",
  );

  const externalCode = asString(
    raw.personCode ??
      raw.person_code ??
      raw.registrationNumber ??
      raw.registration_number ??
      raw.studentId ??
      raw.student_id ??
      raw.rollNo ??
      raw.roll_no ??
      raw.admissionNo ??
      raw.admission_no ??
      raw.employeeId ??
      raw.employee_id ??
      raw.employeeNumber ??
      raw.employee_number ??
      raw.workerId ??
      raw.worker_id ??
      raw.teacherCode ??
      raw.teacher_code ??
      raw.code ??
      raw.empId,
    "",
  );

  const branchId = asNumber(raw.branchId ?? raw.branch_id, 0);
  const accessModules = asStringArray(
    raw.moduleAccess ?? raw.accessModules ?? raw.access_modules,
  );

  const roleName = asString(
    raw.position ?? raw.role ?? raw.designation,
    "Staff Member",
  );

  const shiftLabel = asString(
    raw.shiftLabel ?? raw.shift_label ?? raw.shift,
    "Morning",
  );
  const shiftId = asString(
    raw.shiftId ?? raw.shift_id ?? raw.shift ?? "morning",
    "morning",
  ) as ShiftDefinition["id"];

  return {
    id,
    userId,
    employeeId: externalCode,
    personCode: externalCode,
    registrationNumber:
      normalizePeopleType(peopleType) === "student" ? externalCode : "",
    studentId: asString(raw.studentId ?? raw.student_id, externalCode),
    rollNo: asString(raw.rollNo ?? raw.roll_no, ""),
    code: externalCode,

    name: asString(
      raw.name ?? raw.staffName ?? raw.fullName,
      "Unknown Employee",
    ),
    email: asString(raw.email, ""),
    phone: asString(raw.phone, ""),

    branchId,
    branchName: asString(raw.branchName ?? raw.branch_name, ""),

    department: asString(raw.department ?? raw.dept, "Unassigned"),
    role: roleName,
    position: roleName,
    accountRole: asString(
      raw.accountRole ?? raw.account_role ?? raw.client_role,
      "staff",
    ),

    status: asStatus(raw.status),
    salary: asNumber(raw.salary ?? raw.basicSalary ?? raw.basic_salary, 0),
    benefits: asStringArray(
      raw.benefits ?? raw.staffBenefits ?? raw.staff_benefits,
    ),
    joinDate: asString(
      raw.joinDate ?? raw.join_date ?? raw.createdAt ?? raw.created_at,
      "",
    ),

    moduleAccess: accessModules,
    accessModules,

    staffType: asStaffWorkType(raw.staffType ?? raw.staff_type),
    shift: shiftId,
    shiftId,
    shiftLabel,
    shiftStart: asString(
      raw.shiftStart ?? raw.dutyStart ?? raw.duty_start,
      "09:00",
    ),
    shiftEnd: asString(raw.shiftEnd ?? raw.dutyEnd ?? raw.duty_end, "17:00"),

    presentDays: asNumber(raw.presentDays ?? raw.present_days, 0),
    createdAt: asString(raw.createdAt ?? raw.created_at, ""),
    updatedAt: asString(raw.updatedAt ?? raw.updated_at, ""),

    profileImageUrl: asString(raw.profileImageUrl ?? raw.profile_image_url, ""),
    profileImageName: asString(
      raw.profileImageName ?? raw.profile_image_name,
      "",
    ),
    peopleType,

    // Reporting Hierarchy fields — must be carried through here, since this
    // is the ONE function every list-population site (staff.items.map,
    // archivedStaff.map, the refreshStaff() re-fetch) funnels through to
    // build the StaffMember objects that become `editMember`/modal `initial`.
    // Omitting these previously meant the modal always read `undefined`
    // for dashboardScope/managerId/linkedClientUserId — refetching after a
    // save (onHierarchyChanged) re-ran this same mapper and stripped the
    // just-saved value right back out, independent of whether the DB write
    // or the route filtering were correct.
    managerId: asString(raw.managerId ?? raw.manager_id, ""),
    linkedClientUserId: asString(
      raw.linkedClientUserId ?? raw.linked_client_user_id,
      "",
    ),
    dashboardScope:
      (raw.dashboardScope ?? raw.dashboard_scope) === "team"
        ? "team"
        : "branch",

    // Attendance location config — same "must be carried through here"
    // reasoning as the hierarchy fields above: this mapper is the single
    // funnel every list/refetch site uses to build StaffMember, so
    // omitting these means the modal silently forgets a saved geofence
    // or WiFi config the next time it (re)initializes from `initial`.
    geofenceLat: asNumberOrNull(raw.geofenceLat ?? raw.geofence_lat),
    geofenceLng: asNumberOrNull(raw.geofenceLng ?? raw.geofence_lng),
    geofenceRadiusMeters: asNumberOrNull(
      raw.geofenceRadiusMeters ?? raw.geofence_radius_meters,
    ),
    geofenceLabel: asString(raw.geofenceLabel ?? raw.geofence_label, ""),
    officeSsid: asString(raw.officeSsid ?? raw.office_ssid, ""),
    officeBssidList: asStringArray(
      raw.officeBssidList ?? raw.office_bssid_list,
    ),

    // Identity documents — carried through the same "must be mapped here"
    // reasoning as the hierarchy/geofence fields above: this function is
    // the single funnel every list/refetch site uses to build StaffMember.
    cnic: asString(raw.cnic, ""),
    fatherName: asString(raw.fatherName ?? raw.father_name, ""),
    fatherCnic: asString(raw.fatherCnic ?? raw.father_cnic, ""),
    fatherPhone: asString(
      raw.fatherPhone ??
        raw.father_phone ??
        raw.father_number ??
        raw.fatherNumber,
      "",
    ),
  };
};

export const backendUserId = (member: StaffMember): number | string | null => {
  const raw = member.userId || member.id;
  if (raw === undefined || raw === null) return null;

  const text = String(raw).trim();
  if (!text) return null;

  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : text;
};

export function toNamedConfigOption(
  value: unknown,
  index: number,
): NamedConfigOption {
  const raw = asRecord(value);
  const name = asString(raw.name ?? raw.label ?? raw.title, "").trim();

  return {
    id: asString(raw.id ?? raw.key ?? name ?? index, String(index)),
    name,
    city: asString(raw.city, ""),
  };
}

export function configItemName(value: unknown): string {
  return toNamedConfigOption(value, 0).name;
}

// ─── Branch id resolution (UI ordinal -> backend UUID) ───────────────────────
// Every branch-scoped attendance-settings endpoint (shifts, departments,
// capture settings, visit plans) requires the real Supabase branch UUID and
// rejects anything else — see support_db_time_utils.get_branch_owned_by_org,
// which UUID-parses branch_id before ever querying the DB. cfg.branches[i].id
// is a local UI ordinal (1, 2, 3…), NOT that UUID, so it must never be sent to
// those endpoints directly. resolveApiBranchId (utils/tenantScope.ts) is the
// single canonical resolver for this translation — imported here rather than
// re-implemented, so there is exactly one place in the frontend that knows
// how to turn a UI branch id into the backend id.
