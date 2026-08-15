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
