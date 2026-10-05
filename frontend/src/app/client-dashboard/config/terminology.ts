/**
 * config/terminology.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One source of truth for business terminology.
 *
 * Backend/table names can stay stable as staff/client_staff, but the dashboard
 * labels change according to business type and selected people kind.
 */

export type PeopleKind =
  | "students"
  | "staff"
  | "workers"
  | "employees"
  | "personnel"
  | "patients"
  | "members"
  | "volunteers"
  | "both";

export interface DashboardTerminology {
  peopleKind: PeopleKind;
  personSingular: string;
  personPlural: string;
  personLower: string;
  personPluralLower: string;
  personIdLabel: string;
  peopleManagementTitle: string;
  directoryTitle: string;
  addPersonLabel: string;
  editPersonLabel: string;
  archivedPeopleTitle: string;
  noPeopleFoundTitle: string;
  emptyPeopleMessage: string;
  attendanceTitle: string;
  totalPeopleLabel: string;
  activePeopleSubLabel: string;
  portalLabel: string;
  staffTypeLabel: string;
  officeTypeLabel: string;
  fieldTypeLabel: string;
  biometricMediaLabel: string;
  credentialsTitle: string;
}

const DEFAULT_KIND_BY_BIZ: Record<string, PeopleKind> = {
  school: "students",
  college: "students",
  university: "students",
  academy: "students",
  factory: "workers",
  manufacturing: "workers",
  plant: "workers",
  company: "employees",
  corporate: "employees",
  office: "employees",
  business: "employees",
  ngo: "personnel",
  nonprofit: "personnel",
  "non-profit": "personnel",
  restaurant: "staff",
  hospitality: "staff",
  hospital: "staff",
  clinic: "staff",
};

const LABELS: Record<PeopleKind, { singular: string; plural: string }> = {
  students: { singular: "Student", plural: "Students" },
  staff: { singular: "Staff Member", plural: "Staff" },
  workers: { singular: "Worker", plural: "Workers" },
  employees: { singular: "Employee", plural: "Employees" },
  personnel: { singular: "Personnel Member", plural: "Personnel" },
  patients: { singular: "Patient", plural: "Patients" },
  members: { singular: "Member", plural: "Members" },
  volunteers: { singular: "Volunteer", plural: "Volunteers" },
  both: { singular: "Student / Staff", plural: "Students & Staff" },
};

export function normalizeBizType(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, "-")
    .replace(/\s+/g, "-");
}

export function isSchoolBizType(value: unknown): boolean {
  const key = normalizeBizType(value);
  return ["school", "college", "university", "academy", "school-college"].some(
    (item) => key.includes(item),
  );
}

export function inferDefaultPeopleKind(bizType: unknown): PeopleKind {
  const key = normalizeBizType(bizType);
  const exact = DEFAULT_KIND_BY_BIZ[key];
  if (exact) return exact;

  if (isSchoolBizType(key)) return "students";
  if (key.includes("factory") || key.includes("manufacturing") || key.includes("plant")) return "workers";
  if (key.includes("hospital") || key.includes("clinic")) return "staff";
  if (key.includes("ngo") || key.includes("non-profit") || key.includes("nonprofit")) return "personnel";
  if (key.includes("restaurant") || key.includes("hotel") || key.includes("hospitality")) return "staff";

  return "employees";
}

export function normalizePeopleKind(value: unknown, bizType?: unknown): PeopleKind {
  const raw = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const map: Record<string, PeopleKind> = {
    student: "students",
    students: "students",
    staff: "staff",
    staff_member: "staff",
    staff_members: "staff",
    worker: "workers",
    workers: "workers",
    employee: "employees",
    employees: "employees",
    personnel: "personnel",
    patient: "patients",
    patients: "patients",
    member: "members",
    members: "members",
    volunteer: "volunteers",
    volunteers: "volunteers",
    both: "both",
    students_staff: "both",
    student_staff: "both",
    students_and_staff: "both",
  };
  return map[raw] ?? inferDefaultPeopleKind(bizType);
}

export function buildDashboardTerminology(
  bizType: unknown,
  peopleKind?: unknown,
  overrides?: Partial<DashboardTerminology>,
): DashboardTerminology {
  const normalizedKind = normalizePeopleKind(peopleKind, bizType);
  const label = LABELS[normalizedKind];
  const singular = label.singular;
  const plural = label.plural;
  const singularLower = singular.toLowerCase();
  const pluralLower = plural.toLowerCase();

  const base: DashboardTerminology = {
    peopleKind: normalizedKind,
    personSingular: singular,
    personPlural: plural,
    personLower: singularLower,
    personPluralLower: pluralLower,
    personIdLabel: `${singular} ID`,
    peopleManagementTitle: `${singular} Management`,
    directoryTitle:
      normalizedKind === "students"
        ? "Student Management"
        : normalizedKind === "workers"
          ? "Worker Management"
          : normalizedKind === "employees"
            ? "Employee Management"
            : `${plural} Management`,
    addPersonLabel: `Add ${singular}`,
    editPersonLabel: `Edit ${singular}`,
    archivedPeopleTitle: `Archived ${plural}`,
    noPeopleFoundTitle: `No ${pluralLower} found`,
    emptyPeopleMessage: `Add your first ${singularLower} to get started`,
    attendanceTitle: `${singular} Attendance`,
    totalPeopleLabel: `Total ${plural}`,
    activePeopleSubLabel: `Active ${pluralLower}`,
    portalLabel: `${singular} Portal`,
    staffTypeLabel: `${singular} Type`,
    officeTypeLabel: `Office ${singular}`,
    fieldTypeLabel: `Field ${singular}`,
    biometricMediaLabel: `${singular} Media for CCTV Attendance`,
    credentialsTitle: `${singular} Login Credentials`,
  };

  return { ...base, ...(overrides ?? {}), peopleKind: normalizedKind };
}

export function moduleLabelForTerminology(
  key: unknown,
  fallbackLabel: unknown,
  terminology: DashboardTerminology,
): string {
  const rawKey = String(key ?? "").trim().toLowerCase();
  const rawLabel = String(fallbackLabel ?? "").trim();

  if (["employees", "staff", "staff_directory", "students", "workers"].includes(rawKey)) {
    return terminology.directoryTitle;
  }
  if (rawKey === "attendance") return terminology.attendanceTitle;
  if (rawKey === "liveattendancemonitoring") return `Live ${terminology.attendanceTitle}`;

  return applyTerminologyToText(rawLabel || String(key ?? "Module"), terminology);
}

export function applyTerminologyToText(text: string, terminology: DashboardTerminology): string {
  if (!text) return text;
  const pairs: Array<[RegExp, string]> = [
    [/Staff Directory/g, terminology.directoryTitle],
    [/Staff Management/g, terminology.directoryTitle],
    [/Add Staff Member/g, terminology.addPersonLabel],
    [/Add Staff/g, terminology.addPersonLabel],
    [/Edit Staff Member/g, terminology.editPersonLabel],
    [/Archived Employees/g, terminology.archivedPeopleTitle],
    [/Archived Staff/g, terminology.archivedPeopleTitle],
    [/No staff members found/gi, terminology.noPeopleFoundTitle],
    [/Total Staff/g, terminology.totalPeopleLabel],
    [/Active employees/g, terminology.activePeopleSubLabel],
    [/Employee Attendance/g, terminology.attendanceTitle],
    [/Staff Attendance/g, terminology.attendanceTitle],
    [/Employee ID/g, terminology.personIdLabel],
    [/Staff ID/g, terminology.personIdLabel],
    [/Employee Media for CCTV Attendance/g, terminology.biometricMediaLabel],
    [/Staff Type/g, terminology.staffTypeLabel],
    [/Office Staff/g, terminology.officeTypeLabel],
    [/Field Staff/g, terminology.fieldTypeLabel],
    [/Flutter Staff Portal/g, `Flutter ${terminology.portalLabel}`],
    [/Staff Portal/g, terminology.portalLabel],
    [/\bstaff\b/g, terminology.personPluralLower],
    [/\bStaff\b/g, terminology.personPlural],
    [/\bemployee\b/g, terminology.personLower],
    [/\bEmployee\b/g, terminology.personSingular],
    [/\bemployees\b/g, terminology.personPluralLower],
    [/\bEmployees\b/g, terminology.personPlural],
  ];

  return pairs.reduce((next, [pattern, replacement]) => next.replace(pattern, replacement), text);
}
