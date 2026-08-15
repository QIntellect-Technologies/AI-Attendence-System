/**
 * templateColumns.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for template/business-type based rendering.
 *
 * Purpose:
 * - Pages must not hardcode table columns, form fields, filters, stat labels,
 *   or empty-state text for Staff/Students/Workers/Teachers.
 * - This resolver converts Support Dashboard configuration into a small render
 *   model that every page can consume.
 * - It supports student-only, staff-only, workers-only, students+staff,
 *   workers+staff, and future people types through config labels/overrides.
 *
 * This file is framework-agnostic and intentionally has no React imports.
 */

export type Primitive = string | number | boolean | null | undefined;
export type RecordLike = Record<string, unknown>;
export type PeopleType = string;

export type TemplateFeature =
  | "identity"
  | "contact"
  | "branch"
  | "studentStructure"
  | "workforceStructure"
  | "attendance"
  | "shift"
  | "payroll"
  | "benefits"
  | "media"
  | "moduleAccess"
  | "archive"
  | "status";

export interface TemplateColumn<Row = RecordLike> {
  key: string;
  label: string;
  dataKey?: keyof Row | string;
  aliases?: string[];
  width?: number | string;
  minWidth?: number | string;
  align?: "left" | "center" | "right";
  hidden?: boolean;
  sortable?: boolean;
  exportable?: boolean;
  searchable?: boolean;
  feature?: TemplateFeature;
}

export interface TemplateFilterOption {
  value: string;
  label: string;
  description?: string;
  count?: number;
}

export interface TemplateFilter {
  key: string;
  type: "select" | "search" | "date" | "scope";
  label: string;
  placeholder?: string;
  options?: TemplateFilterOption[];
  hidden?: boolean;
  feature?: TemplateFeature;
}

export interface TemplateFormField {
  key: string;
  label: string;
  type:
    | "text"
    | "email"
    | "tel"
    | "number"
    | "date"
    | "select"
    | "file"
    | "multiSelect";
  required?: boolean;
  placeholder?: string;
  options?: TemplateFilterOption[];
  hidden?: boolean;
  feature?: TemplateFeature;
}

export interface TemplateStatCard {
  key: string;
  label: string;
  valueKey: string;
  subLabel?: string;
  hidden?: boolean;
  feature?: TemplateFeature;
}

export interface TemplateConfigInput extends Record<string, unknown> {
  businessType?: string | null;
  business_type?: string | null;
  bizType?: string | null;
  biz_type?: string | null;
  orgType?: string | null;
  org_type?: string | null;

  primaryPeopleType?: PeopleType | null;
  primary_people_type?: PeopleType | null;
  enabledPeopleTypes?: PeopleType[] | null;
  enabled_people_types?: PeopleType[] | null;
  attendancePeopleTypes?: PeopleType[] | null;
  attendance_people_types?: PeopleType[] | null;

  verticalConfig?: RecordLike | null;
  vertical_config?: RecordLike | null;
  terminologyOverrides?: RecordLike | null;
  terminology_overrides?: RecordLike | null;

  departments?: Record<string, RecordLike[]> | null;
  roles?: Record<string, RecordLike[]> | null;
  classes?: Record<string, RecordLike[]> | null;
  sections?: Record<string, RecordLike[]> | null;
  groups?: Record<string, RecordLike[]> | null;
  subGroups?: Record<string, RecordLike[]> | null;
  sub_groups?: Record<string, RecordLike[]> | null;
  staffShiftDefinitions?: RecordLike[] | null;
  staff_shift_definitions?: RecordLike[] | null;
  shifts?: RecordLike[] | null;
  modules?: string[] | null;
  activeModules?: string[] | null;
  active_modules?: string[] | null;
}

export interface TemplateRenderingModel {
  businessType: string;
  primaryPeopleType: PeopleType;
  activePeopleTypes: PeopleType[];
  attendancePeopleTypes: PeopleType[];
  selectedPeopleType: PeopleType;
  isStudentScope: boolean;
  isWorkerScope: boolean;
  isWorkforceScope: boolean;
  hasMultipleAttendanceScopes: boolean;
  labels: {
    singular: string;
    plural: string;
    management: string;
    directory: string;
    add: string;
    addRecord: string;
    noRecords: string;
    code: string;
    group: string;
    groupPlural: string;
    subGroup: string;
    subGroupPlural: string;
    designation: string;
    designationPlural: string;
    branch: string;
    branchPlural: string;
    shift: string;
    shiftPlural: string;
  };
  features: Record<TemplateFeature, boolean>;
  peopleColumns: TemplateColumn[];
  attendanceColumns: TemplateColumn[];
  formFields: TemplateFormField[];
  filters: TemplateFilter[];
  overviewCards: TemplateStatCard[];
  peopleTypeOptions: TemplateFilterOption[];
}

const FALLBACK_LABELS: Record<string, string> = {
  student: "Student",
  student_plural: "Students",
  staff: "Staff",
  staff_plural: "Staff",
  teacher: "Teacher",
  teacher_plural: "Teachers",
  administration: "Administration",
  administration_plural: "Administration",
  admin_staff: "Administration",
  admin_staff_plural: "Administration",
  worker: "Worker",
  worker_plural: "Workers",
  employee: "Employee",
  employee_plural: "Employees",
  member: "Member",
  member_plural: "Members",
  volunteer: "Volunteer",
  volunteer_plural: "Volunteers",
  patient: "Patient",
  patient_plural: "Patients",
  class: "Class",
  class_plural: "Classes",
  section: "Section",
  section_plural: "Sections",
  department: "Department",
  department_plural: "Departments",
  unit: "Unit",
  unit_plural: "Units",
  designation: "Designation",
  designation_plural: "Designations",
  role: "Role",
  role_plural: "Roles",
  position: "Position",
  position_plural: "Positions",
  branch: "Branch",
  branch_plural: "Branches",
  shift: "Shift",
  shift_plural: "Shifts",
};

const STUDENT_TYPES = new Set([
  "student",
  "students",
  "learner",
  "learners",
  "pupil",
  "pupils",
]);
const WORKER_TYPES = new Set([
  "worker",
  "workers",
  "labor",
  "labour",
  "operator",
  "operators",
]);
const WORKFORCE_TYPES = new Set([
  "staff",
  "employee",
  "employees",
  "teacher",
  "teachers",
  "faculty",
  "administration",
  "admin_staff",
  "worker",
  "workers",
  "doctor",
  "doctors",
  "nurse",
  "nurses",
  "member",
  "members",
  "volunteer",
  "volunteers",
]);

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeKey(value: unknown, fallback = ""): string {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return text || fallback;
}

function uniqueLower(values: unknown, fallback: string[] = []): string[] {
  const raw = Array.isArray(values) ? values : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const key = normalizeKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result.length ? result : fallback;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function labelMapFrom(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.entries(value).reduce<Record<string, string>>(
    (acc, [key, raw]) => {
      if (typeof raw === "string" && raw.trim())
        acc[normalizeKey(key)] = raw.trim();
      return acc;
    },
    {},
  );
}

function readLabels(config: TemplateConfigInput): Record<string, string> {
  const verticalConfig = isRecord(config.verticalConfig)
    ? config.verticalConfig
    : isRecord(config.vertical_config)
      ? config.vertical_config
      : {};
  return {
    ...labelMapFrom(verticalConfig.labels),
    ...labelMapFrom(config.terminologyOverrides),
    ...labelMapFrom(config.terminology_overrides),
  };
}

function tenantLabel(
  labels: Record<string, string>,
  key: string,
  fallback?: string,
): string {
  const clean = normalizeKey(key);
  return (
    labels[clean] || FALLBACK_LABELS[clean] || fallback || titleCase(clean)
  );
}

function peopleSingular(
  labels: Record<string, string>,
  peopleType: PeopleType,
): string {
  return tenantLabel(labels, peopleType);
}

function peoplePlural(
  labels: Record<string, string>,
  peopleType: PeopleType,
): string {
  const key = normalizeKey(peopleType);
  return tenantLabel(
    labels,
    `${key}_plural`,
    `${peopleSingular(labels, key)}s`,
  );
}

function personCodeLabel(
  labels: Record<string, string>,
  peopleType: PeopleType,
): string {
  const key = normalizeKey(peopleType);
  if (isStudentPeopleType(key)) return "Registration Number";
  if (key === "teacher" || key === "teachers" || key === "faculty")
    return "Teacher Code";
  if (isWorkerPeopleType(key)) return "Worker ID";
  if (key === "employee" || key === "employees") return "Employee ID";
  return tenantLabel(labels, `${key}_code`, "Staff ID");
}

function personCodePlaceholder(peopleType: PeopleType): string {
  const key = normalizeKey(peopleType);
  if (isStudentPeopleType(key)) return "REG-001";
  if (key === "teacher" || key === "teachers" || key === "faculty")
    return "TCH-001";
  if (isWorkerPeopleType(key)) return "WRK-001";
  if (key === "employee" || key === "employees") return "EMP-001";
  return "STF-001";
}

function moduleEnabled(
  config: TemplateConfigInput,
  moduleKey: string,
): boolean {
  const modules = uniqueLower(
    config.activeModules ?? config.active_modules ?? config.modules,
    [],
  );
  if (!modules.length) return false;
  const normalized = normalizeKey(moduleKey).replace(/_/g, "");
  return modules.some((item) => {
    const key = item.replace(/_/g, "");
    return key === normalized || key === "all" || key === "*";
  });
}

function hasAnyBranchItems(bucket: unknown): boolean {
  if (!isRecord(bucket)) return false;
  return Object.values(bucket).some(
    (items) => Array.isArray(items) && items.length > 0,
  );
}

function hasShiftConfig(config: TemplateConfigInput): boolean {
  const shifts =
    config.staffShiftDefinitions ??
    config.staff_shift_definitions ??
    config.shifts ??
    [];
  return Array.isArray(shifts) && shifts.length > 0;
}

function inferBusinessType(config: TemplateConfigInput): string {
  return normalizeKey(
    firstString(
      config.businessType,
      config.business_type,
      config.bizType,
      config.biz_type,
      config.orgType,
      config.org_type,
    ),
    "company",
  );
}

function isStudentPeopleType(peopleType: string): boolean {
  return STUDENT_TYPES.has(normalizeKey(peopleType));
}

function isWorkerPeopleType(peopleType: string): boolean {
  return WORKER_TYPES.has(normalizeKey(peopleType));
}

function isWorkforcePeopleType(peopleType: string): boolean {
  const key = normalizeKey(peopleType);
  return WORKFORCE_TYPES.has(key) || (!isStudentPeopleType(key) && key !== "");
}

function resolveActivePeopleTypes(config: TemplateConfigInput): string[] {
  const verticalConfig = isRecord(config.verticalConfig)
    ? config.verticalConfig
    : isRecord(config.vertical_config)
      ? config.vertical_config
      : {};

  const enabled = uniqueLower(
    config.enabledPeopleTypes ??
      config.enabled_people_types ??
      verticalConfig.enabled_people_types,
    [],
  );
  const attendance = uniqueLower(
    config.attendancePeopleTypes ??
      config.attendance_people_types ??
      verticalConfig.attendance_people_types,
    [],
  );

  if (attendance.length) return attendance;
  if (enabled.length) return enabled;

  const primary = normalizeKey(
    config.primaryPeopleType ?? config.primary_people_type,
  );
  return primary ? [primary] : ["staff"];
}

function resolvePrimaryPeopleType(
  config: TemplateConfigInput,
  activePeopleTypes: string[],
): string {
  const verticalConfig = isRecord(config.verticalConfig)
    ? config.verticalConfig
    : isRecord(config.vertical_config)
      ? config.vertical_config
      : {};
  const primary = normalizeKey(
    config.primaryPeopleType ??
      config.primary_people_type ??
      verticalConfig.primary_people_type,
  );
  return primary || activePeopleTypes[0] || "staff";
}

function selectedScope(
  active: string[],
  selectedPeopleType?: string | null,
): string {
  const selected = normalizeKey(selectedPeopleType);
  if (selected && active.includes(selected)) return selected;
  return active[0] || "staff";
}

function structureLabels(
  labels: Record<string, string>,
  businessType: string,
  selectedPeopleType: string,
): Pick<
  TemplateRenderingModel["labels"],
  | "group"
  | "groupPlural"
  | "subGroup"
  | "subGroupPlural"
  | "designation"
  | "designationPlural"
> {
  if (isStudentPeopleType(selectedPeopleType)) {
    return {
      group: tenantLabel(labels, "class"),
      groupPlural: tenantLabel(labels, "class_plural"),
      subGroup: tenantLabel(labels, "section"),
      subGroupPlural: tenantLabel(labels, "section_plural"),
      designation: tenantLabel(labels, "designation"),
      designationPlural: tenantLabel(labels, "designation_plural"),
    };
  }

  const factoryLike = ["factory", "manufacturing", "plant", "warehouse"].some(
    (part) => businessType.includes(part),
  );
  return {
    group:
      factoryLike || isWorkerPeopleType(selectedPeopleType)
        ? tenantLabel(labels, "unit", "Unit")
        : tenantLabel(labels, "department"),
    groupPlural:
      factoryLike || isWorkerPeopleType(selectedPeopleType)
        ? tenantLabel(labels, "unit_plural", "Units")
        : tenantLabel(labels, "department_plural"),
    subGroup: tenantLabel(labels, "section"),
    subGroupPlural: tenantLabel(labels, "section_plural"),
    designation: tenantLabel(labels, "designation"),
    designationPlural: tenantLabel(labels, "designation_plural"),
  };
}

function resolveFeatures(
  config: TemplateConfigInput,
  selectedPeopleType: string,
): Record<TemplateFeature, boolean> {
  const student = isStudentPeopleType(selectedPeopleType);
  const workforce = isWorkforcePeopleType(selectedPeopleType);
  const hasStudentStructure =
    hasAnyBranchItems(config.classes) ||
    hasAnyBranchItems(config.sections) ||
    hasAnyBranchItems(config.groups) ||
    student;
  const hasWorkforceStructure =
    hasAnyBranchItems(config.departments) ||
    hasAnyBranchItems(config.roles) ||
    workforce;

  // Match templateRendering.ts logic: check shiftEnabledPeopleTypes list
  // If list exists and has items, only enable for types in that list
  // Otherwise fall back to non-student logic
  const verticalConfig = isRecord(config.verticalConfig)
    ? config.verticalConfig
    : isRecord(config.vertical_config)
      ? config.vertical_config
      : {};
  const shiftEnabledList = uniqueLower(
    config.shiftEnabledPeopleTypes ??
      config.shift_enabled_people_types ??
      verticalConfig.shiftEnabledPeopleTypes ??
      verticalConfig.shift_enabled_people_types,
    [],
  );
  const supportsShift =
    shiftEnabledList.length > 0
      ? shiftEnabledList.includes(normalizeKey(selectedPeopleType))
      : !student;

  const payrollEnabled = moduleEnabled(config, "payroll");
  const leaveEnabled =
    moduleEnabled(config, "leave") || moduleEnabled(config, "leave_management");

  return {
    identity: true,
    contact: true,
    branch: true,
    studentStructure: student && hasStudentStructure,
    workforceStructure: !student && hasWorkforceStructure,
    attendance: true,
    shift: supportsShift,
    payroll: !student && payrollEnabled,
    benefits: !student && (payrollEnabled || selectedPeopleType === "staff"),
    media: true,
    moduleAccess: !student,
    archive: true,
    status: true,
  };
}

function buildPeopleColumns(
  model: Omit<
    TemplateRenderingModel,
    | "peopleColumns"
    | "attendanceColumns"
    | "formFields"
    | "filters"
    | "overviewCards"
  >,
): TemplateColumn[] {
  const L = model.labels;
  const F = model.features;
  const columns: TemplateColumn[] = [
    {
      key: "code",
      label: L.code,
      dataKey: "personCode",
      aliases: [
        "person_code",
        "registrationNumber",
        "registration_number",
        "employeeId",
        "employee_id",
        "studentId",
        "rollNo",
        "code",
      ],
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "identity",
    },
    {
      key: "name",
      label: "Name",
      dataKey: "name",
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "identity",
    },
    {
      key: "branch",
      label: L.branch,
      dataKey: "branchName",
      sortable: true,
      exportable: true,
      feature: "branch",
    },
    {
      key: "class",
      label: L.group,
      dataKey: "department",
      aliases: ["class", "className", "groupName"],
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "studentStructure",
      hidden: !F.studentStructure,
    },
    {
      key: "section",
      label: L.subGroup,
      dataKey: "role",
      aliases: ["section", "sectionName", "subGroupName"],
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "studentStructure",
      hidden: !F.studentStructure,
    },
    {
      key: "department",
      label: L.group,
      dataKey: "department",
      aliases: [
        "department",
        "departmentName",
        "unit",
        "unitName",
        "groupName",
      ],
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "workforceStructure",
      hidden: !F.workforceStructure,
    },
    {
      key: "designation",
      label: L.designation,
      dataKey: "position",
      aliases: ["designation", "roleName", "position"],
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "workforceStructure",
      hidden: !F.workforceStructure,
    },
    {
      key: "shift",
      label: L.shift,
      dataKey: "shiftLabel",
      sortable: true,
      exportable: true,
      feature: "shift",
      hidden: !F.shift,
    },
    {
      key: "salary",
      label: "Salary",
      dataKey: "salary",
      align: "right",
      sortable: true,
      exportable: true,
      feature: "payroll",
      hidden: !F.payroll,
    },
    {
      key: "status",
      label: "Status",
      dataKey: "status",
      sortable: true,
      exportable: true,
      feature: "status",
    },
  ];
  return columns.filter((column) => !column.hidden);
}

function buildAttendanceColumns(
  model: Omit<
    TemplateRenderingModel,
    | "peopleColumns"
    | "attendanceColumns"
    | "formFields"
    | "filters"
    | "overviewCards"
  >,
): TemplateColumn[] {
  const L = model.labels;
  const F = model.features;
  const columns: TemplateColumn[] = [
    {
      key: "code",
      label: L.code,
      dataKey: "code",
      aliases: ["employeeId", "studentId", "rollNo"],
      sortable: true,
      searchable: true,
      exportable: true,
    },
    {
      key: "name",
      label: "Name",
      dataKey: "name",
      sortable: true,
      searchable: true,
      exportable: true,
    },
    {
      key: "branch",
      label: L.branch,
      dataKey: "branchName",
      sortable: true,
      exportable: true,
      feature: "branch",
    },
    {
      key: "class",
      label: L.group,
      dataKey: "department",
      aliases: ["class", "className"],
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "studentStructure",
      hidden: !F.studentStructure,
    },
    {
      key: "section",
      label: L.subGroup,
      dataKey: "designation",
      aliases: ["section", "sectionName"],
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "studentStructure",
      hidden: !F.studentStructure,
    },
    {
      key: "department",
      label: L.group,
      dataKey: "department",
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "workforceStructure",
      hidden: !F.workforceStructure,
    },
    {
      key: "designation",
      label: L.designation,
      dataKey: "designation",
      sortable: true,
      searchable: true,
      exportable: true,
      feature: "workforceStructure",
      hidden: !F.workforceStructure,
    },
    {
      key: "checkIn",
      label: "Check In",
      dataKey: "checkIn",
      sortable: true,
      exportable: true,
    },
    {
      key: "checkOut",
      label: "Check Out",
      dataKey: "checkOut",
      sortable: true,
      exportable: true,
    },
    {
      key: "duration",
      label: "Duration",
      dataKey: "duration",
      exportable: true,
    },
    {
      key: "arrival",
      label: "Arrival",
      dataKey: "status",
      sortable: true,
      exportable: true,
    },
    { key: "action", label: "Action", dataKey: "id", exportable: false },
  ];
  return columns.filter((column) => !column.hidden);
}

function buildFormFields(
  model: Omit<
    TemplateRenderingModel,
    | "peopleColumns"
    | "attendanceColumns"
    | "formFields"
    | "filters"
    | "overviewCards"
  >,
): TemplateFormField[] {
  const L = model.labels;
  const F = model.features;
  const fields: TemplateFormField[] = [
    {
      key: "name",
      label: `${L.singular} Name`,
      type: "text",
      required: true,
      placeholder: `Enter ${L.singular.toLowerCase()} name`,
      feature: "identity",
    },
    {
      key: "personCode",
      label: L.code,
      type: "text",
      required: true,
      placeholder: personCodePlaceholder(model.selectedPeopleType),
      feature: "identity",
    },
    {
      key: "phone",
      label: "Phone",
      type: "tel",
      placeholder: "0300-1234567",
      feature: "contact",
    },
    {
      key: "joinDate",
      label: "Joining Date",
      type: "date",
      feature: "identity",
    },
    {
      key: "branchId",
      label: L.branch,
      type: "select",
      required: true,
      feature: "branch",
    },
    {
      key: "class",
      label: L.group,
      type: "select",
      required: F.studentStructure,
      feature: "studentStructure",
      hidden: !F.studentStructure,
    },
    {
      key: "section",
      label: L.subGroup,
      type: "select",
      required: F.studentStructure,
      feature: "studentStructure",
      hidden: !F.studentStructure,
    },
    {
      key: "department",
      label: L.group,
      type: "select",
      required: F.workforceStructure,
      feature: "workforceStructure",
      hidden: !F.workforceStructure,
    },
    {
      key: "designation",
      label: L.designation,
      type: "select",
      required: F.workforceStructure,
      feature: "workforceStructure",
      hidden: !F.workforceStructure,
    },
    {
      key: "salary",
      label: "Salary",
      type: "number",
      feature: "payroll",
      hidden: !F.payroll,
    },
    {
      key: "benefits",
      label: "Benefits",
      type: "multiSelect",
      feature: "benefits",
      hidden: !F.benefits,
    },
    {
      key: "staffType",
      label: `${L.singular} Type`,
      type: "select",
      feature: "shift",
      hidden: !F.shift,
    },
    {
      key: "shiftId",
      label: `Default ${L.shift}`,
      type: "select",
      feature: "shift",
      hidden: !F.shift,
    },
    {
      key: "status",
      label: "Status",
      type: "select",
      required: true,
      feature: "status",
    },
    {
      key: "profileImage",
      label: "Profile Image",
      type: "file",
      required: true,
      feature: "media",
    },
    {
      key: "accessModules",
      label: "Dashboard Module Access",
      type: "multiSelect",
      feature: "moduleAccess",
      hidden: !F.moduleAccess,
    },
  ];
  return fields.filter((field) => !field.hidden);
}

function buildFilters(
  model: Omit<
    TemplateRenderingModel,
    | "peopleColumns"
    | "attendanceColumns"
    | "formFields"
    | "filters"
    | "overviewCards"
  >,
): TemplateFilter[] {
  const L = model.labels;
  const F = model.features;
  const filters: TemplateFilter[] = [
    {
      key: "peopleType",
      type: "scope",
      label: "Attendance Scope",
      hidden: !model.hasMultipleAttendanceScopes,
      options: model.peopleTypeOptions,
    },
    {
      key: "branchId",
      type: "select",
      label: L.branchPlural,
      placeholder: `All ${L.branchPlural}`,
      feature: "branch",
    },
    {
      key: "class",
      type: "select",
      label: L.groupPlural,
      placeholder: `All ${L.groupPlural}`,
      feature: "studentStructure",
      hidden: !F.studentStructure,
    },
    {
      key: "section",
      type: "select",
      label: L.subGroupPlural,
      placeholder: `All ${L.subGroupPlural}`,
      feature: "studentStructure",
      hidden: !F.studentStructure,
    },
    {
      key: "department",
      type: "select",
      label: L.groupPlural,
      placeholder: `All ${L.groupPlural}`,
      feature: "workforceStructure",
      hidden: !F.workforceStructure,
    },
    {
      key: "designation",
      type: "select",
      label: L.designationPlural,
      placeholder: `All ${L.designationPlural}`,
      feature: "workforceStructure",
      hidden: !F.workforceStructure,
    },
    {
      key: "status",
      type: "select",
      label: "Statuses",
      placeholder: "All Statuses",
      feature: "status",
    },
    {
      key: "search",
      type: "search",
      label: "Search",
      placeholder: F.studentStructure
        ? `Search ${L.singular.toLowerCase()} name, ${L.code.toLowerCase()}, ${L.group.toLowerCase()}, ${L.subGroup.toLowerCase()}...`
        : `Search ${L.singular.toLowerCase()} name, ${L.code.toLowerCase()}, ${L.group.toLowerCase()}, ${L.designation.toLowerCase()}...`,
    },
  ];
  return filters.filter((filter) => !filter.hidden);
}

function buildOverviewCards(
  model: Omit<
    TemplateRenderingModel,
    | "peopleColumns"
    | "attendanceColumns"
    | "formFields"
    | "filters"
    | "overviewCards"
  >,
): TemplateStatCard[] {
  const L = model.labels;
  const F = model.features;
  const cards: TemplateStatCard[] = [
    {
      key: "branches",
      label: `Total ${L.branchPlural}`,
      valueKey: "totalBranches",
      subLabel: "Active locations",
      feature: "branch",
    },
    {
      key: "people",
      label: `Total ${L.plural}`,
      valueKey: "totalPeople",
      subLabel: "Across all branches",
      feature: "identity",
    },
    {
      key: "present",
      label: "Present Today",
      valueKey: "presentToday",
      subLabel: "attendance",
      feature: "attendance",
    },
    {
      key: "absent",
      label: "Absent Today",
      valueKey: "absentToday",
      subLabel: "late",
      feature: "attendance",
    },
    {
      key: "avgAttendance",
      label: "Avg Attendance",
      valueKey: "avgAttendance",
      subLabel: "Weighted global rate",
      feature: "attendance",
    },
    {
      key: "payroll",
      label: "Monthly Payroll",
      valueKey: "monthlyPayroll",
      subLabel: "All branches",
      feature: "payroll",
      hidden: !F.payroll,
    },
    {
      key: "pendingLeaves",
      label: "Pending Leaves",
      valueKey: "pendingLeaves",
      subLabel: "Need review",
      feature: "benefits",
      hidden: model.isStudentScope,
    },
    {
      key: "shiftDistribution",
      label: `${L.shift} Distribution`,
      valueKey: "shiftDistribution",
      feature: "shift",
      hidden: !F.shift,
    },
  ];
  return cards.filter((card) => !card.hidden);
}

export function resolveTemplateRenderingModel(
  config: unknown,
  selectedPeopleType?: string | null,
  /**
   * Optional module-scoped restriction (e.g. from
   * templateRendering.ts's resolveModulePeopleTypes). Pass `undefined` to
   * keep today's org-wide behavior. Pass `[]` explicitly to mean "this
   * module is off for this branch" — peopleTypeOptions will be empty rather
   * than silently falling back to the full org-wide list.
   *
   * NOTE: this file maintains its own independent copy of
   * resolveActivePeopleTypes/resolvePrimaryPeopleType rather than importing
   * templateRendering.ts's — that duplication predates this change and is
   * a separate cleanup, not something this fix attempts to silently merge.
   */
  restrictToPeopleTypes?: string[],
): TemplateRenderingModel {
  const input = (
    config && typeof config === "object" ? config : {}
  ) as TemplateConfigInput;
  const labels = readLabels(input);
  const businessType = inferBusinessType(input);
  const resolvedPeopleTypes = resolveActivePeopleTypes(input);
  const attendancePeopleTypes =
    restrictToPeopleTypes === undefined
      ? resolvedPeopleTypes
      : resolvedPeopleTypes.filter((type) =>
          restrictToPeopleTypes.includes(type),
        );
  const primaryPeopleType = resolvePrimaryPeopleType(
    input,
    attendancePeopleTypes,
  );
  const selected =
    selectedPeopleType === "all"
      ? primaryPeopleType
      : selectedScope(attendancePeopleTypes, selectedPeopleType);
  const student = isStudentPeopleType(selected);
  const worker = isWorkerPeopleType(selected);
  const workforce = isWorkforcePeopleType(selected);
  const structure = structureLabels(labels, businessType, selected);
  const singular = peopleSingular(labels, selected);
  const plural = peoplePlural(labels, selected);
  const features = resolveFeatures(input, selected);

  const peopleTypeOptions: TemplateFilterOption[] = [
    { value: "all", label: "All Attendance People" },
    ...attendancePeopleTypes.map((type) => ({
      value: type,
      label: peoplePlural(labels, type),
    })),
  ];

  const base: Omit<
    TemplateRenderingModel,
    | "peopleColumns"
    | "attendanceColumns"
    | "formFields"
    | "filters"
    | "overviewCards"
  > = {
    businessType,
    primaryPeopleType,
    activePeopleTypes: attendancePeopleTypes,
    attendancePeopleTypes,
    selectedPeopleType: selected,
    isStudentScope: student,
    isWorkerScope: worker,
    isWorkforceScope: workforce,
    hasMultipleAttendanceScopes: attendancePeopleTypes.length > 1,
    peopleTypeOptions,
    labels: {
      singular,
      plural,
      management: `${plural} Management`,
      directory: `${singular} Directory`,
      add: `Add ${singular}`,
      addRecord: `Add ${singular} Record`,
      noRecords: `No ${plural.toLowerCase()} found`,
      code: personCodeLabel(labels, selected),
      ...structure,
      branch: tenantLabel(labels, "branch"),
      branchPlural: tenantLabel(labels, "branch_plural"),
      shift: tenantLabel(labels, "shift"),
      shiftPlural: tenantLabel(labels, "shift_plural"),
    },
    features,
  };

  return {
    ...base,
    peopleColumns: buildPeopleColumns(base),
    attendanceColumns: buildAttendanceColumns(base),
    formFields: buildFormFields(base),
    filters: buildFilters(base),
    overviewCards: buildOverviewCards(base),
  };
}

export function resolveColumnsForPage(
  page: "people" | "attendance",
  config: unknown,
  selectedPeopleType?: string | null,
): TemplateColumn[] {
  const model = resolveTemplateRenderingModel(config, selectedPeopleType);
  return page === "attendance" ? model.attendanceColumns : model.peopleColumns;
}

export function resolveFiltersForPage(
  config: unknown,
  selectedPeopleType?: string | null,
  restrictToPeopleTypes?: string[],
): TemplateFilter[] {
  return resolveTemplateRenderingModel(
    config,
    selectedPeopleType,
    restrictToPeopleTypes,
  ).filters;
}

export function resolveFormFieldsForPeople(
  config: unknown,
  selectedPeopleType?: string | null,
): TemplateFormField[] {
  return resolveTemplateRenderingModel(config, selectedPeopleType).formFields;
}

export function resolveOverviewCards(
  config: unknown,
  selectedPeopleType?: string | null,
): TemplateStatCard[] {
  return resolveTemplateRenderingModel(config, selectedPeopleType)
    .overviewCards;
}

export const resolveTemplateFilters = resolveFiltersForPage;
export const resolveTemplateFormFields = resolveFormFieldsForPeople;

export function readColumnValue<Row extends RecordLike>(
  row: Row,
  column: TemplateColumn<Row>,
): Primitive {
  const keys = [column.dataKey, column.key, ...(column.aliases || [])]
    .filter(Boolean)
    .map(String);

  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null || value === "") continue;

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }

    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  return "";
}