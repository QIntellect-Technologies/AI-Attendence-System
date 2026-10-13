/**
 * modules/staff/utils/staffPayload.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * StaffFormData -> backend StaffPayload. Isolated from the modal so payload
 * shape changes are reviewable on their own.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type ShiftDefinition } from "../../../contexts/OrgConfigContext";
import { type StaffPayload } from "../api/staffApi";
import { normalizePeopleType } from "../types/types";
import { type StaffFormData } from "../types/staffForm";
import { persistedMediaUrl } from "./staffMedia";

export const buildStaffApiPayload = (
  data: StaffFormData,
  organizationId: number | string | null,
  selectedBranchName: string,
  selectedBackendBranchId: number | string | null,
  shift: ShiftDefinition,
  createdByUserId?: number | string | null,
  password?: string,
  peopleType = "staff",
  designationName = "",
): StaffPayload => {
  const parsedLat = data.geofenceLat.trim() ? Number(data.geofenceLat) : null;
  const parsedLng = data.geofenceLng.trim() ? Number(data.geofenceLng) : null;
  const parsedRadius = data.geofenceRadiusMeters.trim()
    ? Number(data.geofenceRadiusMeters)
    : null;

  return {
    name: data.name,
    email: data.email || "",
    phone: data.phone,
    // Both keys sent for the same value — backend's incoming_role prefers
    // account_role but falls back to role (support_db_staff.py:615); kept
    // in sync here rather than picking one, matching the existing
    // dual-key convention throughout this payload.
    role: data.accountRole || "staff",
    account_role: data.accountRole || "staff",
    people_type: peopleType,
    peopleType,
    person_code: data.personCode,
    personCode: data.personCode,
    registration_number:
      normalizePeopleType(peopleType) === "student"
        ? data.personCode
        : undefined,
    employee_id:
      normalizePeopleType(peopleType) !== "student"
        ? data.personCode
        : undefined,
    department: data.department,
    designation_id: data.designationId || null,
    designation_name: designationName || null,
    position: data.role,
    salary: data.salary,
    benefits: data.benefits,
    join_date: data.joinDate,
    shift: shift.label,
    duty_start: shift.start,
    duty_end: shift.end,
    staff_type: data.staffType,
    access_modules: data.moduleAccess,
    organization_id: organizationId,
    created_by_user_id: createdByUserId,
    branch_id: selectedBackendBranchId ?? data.branchId,
    branch_ui_id: data.branchId,
    branch_name: selectedBranchName,
    status: data.status,
    shift_id: shift.id,
    shift_label: shift.label,
    // Do not persist browser-only preview URLs such as blob: or data:.
    // The real persisted URLs are returned by the media upload endpoints.
    profile_image_url: persistedMediaUrl(data.profileImageUrl),
    profile_image_name: data.profileImageName,

    // Attendance location config — only meaningful (and only sent) for
    // the matching staff type, so switching a person's type doesn't
    // leave a stale geofence or WiFi config attached to the wrong kind
    // of check. Nulling out the other type's fields lets an admin who
    // switches someone from field -> office also clear a no-longer-
    // relevant geofence by simply saving.
    geofence_lat: data.staffType === "field" ? parsedLat : null,
    geofenceLat: data.staffType === "field" ? parsedLat : null,
    geofence_lng: data.staffType === "field" ? parsedLng : null,
    geofenceLng: data.staffType === "field" ? parsedLng : null,
    geofence_radius_meters: data.staffType === "field" ? parsedRadius : null,
    geofenceRadiusMeters: data.staffType === "field" ? parsedRadius : null,
    geofence_label: data.staffType === "field" ? data.geofenceLabel : null,
    geofenceLabel: data.staffType === "field" ? data.geofenceLabel : null,
    office_ssid: data.staffType === "office" ? data.officeSsid : null,
    officeSsid: data.staffType === "office" ? data.officeSsid : null,
    office_bssid_list:
      data.staffType === "office" ? data.officeBssidList : null,
    officeBssidList: data.staffType === "office" ? data.officeBssidList : null,

    // Identity documents — cnic for non-students, guardian details for
    // students. Sent as whichever this person's peopleType calls for;
    // the other side's fields are simply left unset rather than nulled,
    // since (unlike geofence/WiFi above) a person's peopleType doesn't
    // flip back and forth the way staffType does.
    cnic: normalizePeopleType(peopleType) !== "student" ? data.cnic : undefined,
    father_name:
      normalizePeopleType(peopleType) === "student"
        ? data.fatherName
        : undefined,
    fatherName:
      normalizePeopleType(peopleType) === "student"
        ? data.fatherName
        : undefined,
    father_cnic:
      normalizePeopleType(peopleType) === "student"
        ? data.fatherCnic
        : undefined,
    fatherCnic:
      normalizePeopleType(peopleType) === "student"
        ? data.fatherCnic
        : undefined,
    father_phone:
      normalizePeopleType(peopleType) === "student"
        ? data.fatherPhone
        : undefined,
    fatherPhone:
      normalizePeopleType(peopleType) === "student"
        ? data.fatherPhone
        : undefined,

    ...(password ? { password } : {}),
  };
};

const STAFF_FORM_PAYLOAD_KEYS: Partial<
  Record<keyof StaffFormData, (keyof StaffPayload)[]>
> = {
  name: ["name"],
  personCode: [
    "person_code",
    "personCode",
    "registration_number",
    "employee_id",
  ],
  email: ["email"],
  phone: ["phone"],
  branchId: ["branch_id", "branch_ui_id", "branch_name"],
  department: ["department"],
  designationId: ["designation_id"],
  designationName: ["designation_name"],
  role: ["position"],
  status: ["status"],
  salary: ["salary"],
  benefits: ["benefits"],
  joinDate: ["join_date"],
  staffType: [
    "staff_type",
    "geofence_lat",
    "geofence_lng",
    "geofence_radius_meters",
    "geofence_label",
    "office_ssid",
    "office_bssid_list",
  ],
  shift: ["shift", "shift_id", "shift_label", "duty_start", "duty_end"],
  customShiftStart: ["shift_id", "shift_label", "duty_start", "duty_end"],
  customShiftEnd: ["shift_id", "shift_label", "duty_start", "duty_end"],
  moduleAccess: ["access_modules"],
  profileImageUrl: ["profile_image_url"],
  profileImageName: ["profile_image_name"],
  accountRole: ["account_role"],
  geofenceLat: ["geofence_lat"],
  geofenceLng: ["geofence_lng"],
  geofenceRadiusMeters: ["geofence_radius_meters"],
  geofenceLabel: ["geofence_label"],
  officeSsid: ["office_ssid"],
  officeBssidList: ["office_bssid_list"],
  cnic: ["cnic"],
  fatherName: ["father_name"],
  fatherCnic: ["father_cnic"],
  fatherPhone: ["father_phone"],
};

export function buildChangedStaffApiPayload(
  payload: StaffPayload,
  changedFields: ReadonlySet<keyof StaffFormData>,
): StaffPayload {
  const keys = new Set<keyof StaffPayload>();
  changedFields.forEach((field) =>
    STAFF_FORM_PAYLOAD_KEYS[field]?.forEach((key) => keys.add(key)),
  );

  return Object.fromEntries(
    [...keys]
      .filter((key) => payload[key] !== undefined)
      .map((key) => [key, payload[key]]),
  ) as StaffPayload;
}
