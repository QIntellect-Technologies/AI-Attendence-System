export type PeopleFamily = "student" | "workforce";

export interface TemplateConfigLike {
  bizType?: string | null;
  business_type?: string | null;
  businessType?: string | null;
  org_type?: string | null;
  orgType?: string | null;
  primaryPeopleType?: string | null;
  primary_people_type?: string | null;
  enabledPeopleTypes?: unknown;
  enabled_people_types?: unknown;
  attendancePeopleTypes?: unknown;
  attendance_people_types?: unknown;
  verticalConfig?: Record<string, unknown> | null;
  vertical_config?: Record<string, unknown> | null;
  terminologyOverrides?: Record<string, unknown> | null;
  terminology_overrides?: Record<string, unknown> | null;
  features?: unknown;
  attendance?: unknown;
  modules?: unknown;
  modulePeopleTypesByBranch?: Record<string, Record<string, string[]>> | null;
  module_people_types_by_branch?: Record<
    string,
    Record<string, string[]>
  > | null;
}

export interface TemplateTerminologyModel {
  organizationLabel: string;
  branchLabel: string;
  activePeopleTypes: string[];
  hasStudentPeople: boolean;
  hasWorkforcePeople: boolean;
  defaultPeopleType: string;
}

export interface PeopleRenderingModel {
  peopleType: string;
  family: PeopleFamily;
  allPeopleTypes: string[];
  selectablePeopleTypes: Array<{ value: string; label: string }>;
  hasMultiplePeopleTypes: boolean;
  isStudent: boolean;
  isWorkforce: boolean;
  pageTitle: string;
  directoryTitle: string;
  statsTotalLabel: string;
  addButtonLabel: string;
  addRecordLabel: string;
  editRecordLabel: string;
  emptyTitle: string;
  emptySubtitle: string;
  exportEmptyMessage: string;
  exportFilenamePrefix: string;
  exportModuleLabel: string;
  personSingular: string;
  personPlural: string;
  personCodeLabel: string;
  branchLabel: string;
  groupLabel: string;
  groupPlural: string;
  subgroupLabel: string;
  subgroupPlural: string;
  roleLabel: string;
  rolePlural: string;
  statusFilterAllLabel: string;
  groupFilterAllLabel: string;
  subgroupFilterAllLabel: string;
  searchPlaceholder: string;
  showClassSectionFields: boolean;
  showDepartmentDesignationFields: boolean;
  showCompensationFields: boolean;
  showBenefitsFields: boolean;
  showStaffTypeField: boolean;
  showShiftFields: boolean;
  showShiftAllocation: boolean;
  showDashboardModuleAccess: boolean;
  showTrainingMedia: boolean;
  supportsShift: boolean;
  supportsPayroll: boolean;
  supportsLeave: boolean;
  statusLabels: Record<"active" | "inactive" | "pending", string>;
  workTypeLabels: Record<"office" | "field", string>;
  archiveLabel: string;
  archivedPluralLabel: string;
  credentialTitle: string;
}

const STUDENT_TYPES = new Set([
  "student",
  "students",
  "learner",
  "learners",
  "pupil",
  "pupils",
]);

const PEOPLE_LABELS: Record<
  string,
  { singular: string; plural: string; code: string }
> = {
  student: { singular: "Student", plural: "Students", code: "Student ID" },
  teacher: { singular: "Teacher", plural: "Teachers", code: "Teacher ID" },
  staff: { singular: "Staff Member", plural: "Staff", code: "Staff ID" },
  employee: { singular: "Employee", plural: "Employees", code: "Employee ID" },
  worker: { singular: "Worker", plural: "Workers", code: "Worker ID" },
  administration: {
    singular: "Administrator",
    plural: "Administration",
    code: "Admin ID",
  },
  admin: {
    singular: "Administrator",
    plural: "Administration",
    code: "Admin ID",
  },
  faculty: {
    singular: "Faculty Member",
    plural: "Faculty",
    code: "Faculty ID",
  },
  doctor: { singular: "Doctor", plural: "Doctors", code: "Doctor ID" },
  nurse: { singular: "Nurse", plural: "Nurses", code: "Nurse ID" },
  volunteer: {
    singular: "Volunteer",
    plural: "Volunteers",
    code: "Volunteer ID",
  },
  member: { singular: "Member", plural: "Members", code: "Member ID" },
};

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function normalizePeopleType(
  value: unknown,
  fallback = "staff",
): string {
  const normalized = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || fallback;
}

function normalizePeopleTypeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(value.map((item) => normalizePeopleType(item)).filter(Boolean)),
    );
  }

  if (typeof value === "string") {
    return Array.from(
      new Set(
        value
          .split(/[,|]/)
          .map((item) => normalizePeopleType(item))
          .filter(Boolean),
      ),
    );
  }

  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readBooleanFlag(
  source: Record<string, unknown>,
  keys: string[],
): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on", "enabled"].includes(normalized))
        return true;
      if (["false", "0", "no", "off", "disabled"].includes(normalized))
        return false;
    }
  }
  return null;
}

function readFeatureFlag(
  config: TemplateConfigLike,
  keys: string[],
): boolean | null {
  const configRecord = asRecord(config);
  const verticalConfig = asRecord(
    config.verticalConfig ?? config.vertical_config,
  );
  const features = asRecord(verticalConfig.features ?? config.features);
  const attendance = asRecord(verticalConfig.attendance ?? config.attendance);
  const modules = asRecord(verticalConfig.modules ?? config.modules);
  return (
    readBooleanFlag(features, keys) ??
    readBooleanFlag(attendance, keys) ??
    readBooleanFlag(modules, keys) ??
    readBooleanFlag(verticalConfig, keys) ??
    readBooleanFlag(configRecord, keys)
  );
}

function labelFromOverrides(
  overrides: Record<string, unknown>,
  keys: string[],
  fallback: string,
): string {
  for (const key of keys) {
    const value = overrides[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

export function isStudentPeopleType(peopleType: unknown): boolean {
  return STUDENT_TYPES.has(normalizePeopleType(peopleType));
}

export function peopleFamilyForType(peopleType: unknown): PeopleFamily {
  return isStudentPeopleType(peopleType) ? "student" : "workforce";
}

export function resolveActivePeopleTypes(config: TemplateConfigLike): string[] {
  const verticalConfig = asRecord(
    config.verticalConfig ?? config.vertical_config,
  );
  // Prefer explicit attendance/enabled people-type settings when present
  const attendanceTypes = normalizePeopleTypeList(
    config.attendancePeopleTypes ??
      config.attendance_people_types ??
      verticalConfig.attendancePeopleTypes ??
      verticalConfig.attendance_people_types,
  );
  const enabledTypes = normalizePeopleTypeList(
    config.enabledPeopleTypes ??
      config.enabled_people_types ??
      verticalConfig.enabledPeopleTypes ??
      verticalConfig.enabled_people_types,
  );
  const primary = normalizePeopleType(
    config.primaryPeopleType ??
      config.primary_people_type ??
      verticalConfig.primaryPeopleType ??
      verticalConfig.primary_people_type,
  );

  if (attendanceTypes.length) return attendanceTypes;
  if (enabledTypes.length) return enabledTypes;

  // Single source of truth: prefer bizType (provided by support dashboard)
  const bizType =
    firstString(
      config.bizType ?? config.businessType ?? config.business_type,
    ) ?? firstString(verticalConfig.business_type, verticalConfig.bizType);

  if (bizType) {
    return resolvePeopleTypesFromBizType(bizType);
  }
  return [primary];
}

export function resolveTemplateTerminology(
  config: TemplateConfigLike,
): TemplateTerminologyModel {
  const verticalConfig = asRecord(
    config.verticalConfig ?? config.vertical_config,
  );
  const overrides = asRecord(
    config.terminologyOverrides ?? config.terminology_overrides,
  );
  const activePeopleTypes = resolveActivePeopleTypes(config);
  const defaultPeopleType = activePeopleTypes[0] ?? "staff";

  return {
    organizationLabel: labelFromOverrides(
      overrides,
      ["organization", "organizationLabel", "org_label"],
      "Organization",
    ),
    branchLabel: labelFromOverrides(
      overrides,
      ["branch", "branchLabel", "branch_label"],
      "Branch",
    ),
    activePeopleTypes,
    hasStudentPeople: activePeopleTypes.some(isStudentPeopleType),
    hasWorkforcePeople: activePeopleTypes.some(
      (peopleType) => !isStudentPeopleType(peopleType),
    ),
    defaultPeopleType: normalizePeopleType(
      verticalConfig.primaryPeopleType ??
        verticalConfig.primary_people_type ??
        config.primaryPeopleType ??
        config.primary_people_type ??
        defaultPeopleType,
    ),
  };
}

export function resolvePeopleTypesFromBizType(bizType: unknown): string[] {
  const raw = String(bizType ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return ["staff"];

  // Heuristic mappings from business type to people-type lists.
  if (
    raw.includes("school") ||
    raw.includes("college") ||
    raw.includes("academy") ||
    raw.includes("education") ||
    raw.includes("university")
  ) {
    return ["student", "teacher", "staff"];
  }

  if (
    raw.includes("factory") ||
    raw.includes("manufacturing") ||
    raw.includes("plant")
  ) {
    return ["worker", "employee"];
  }

  if (
    raw.includes("hospital") ||
    raw.includes("clinic") ||
    raw.includes("health")
  ) {
    return ["employee", "doctor", "nurse", "staff"];
  }

  if (
    raw.includes("ngo") ||
    raw.includes("nonprofit") ||
    raw.includes("charity")
  ) {
    return ["volunteer", "staff"];
  }

  if (
    raw.includes("hotel") ||
    raw.includes("hospitality") ||
    raw.includes("restaurant")
  ) {
    return ["staff", "employee", "worker"];
  }

  // Fallback: use the first token of the bizType if it looks like a people-type, otherwise default to staff
  const token = raw.split(/[^a-z0-9]+/)[0] || "staff";
  const normalized = normalizePeopleType(token, "staff");
  return [normalized];
}

export function peopleLabelForType(
  peopleType: unknown,
  config?: TemplateConfigLike,
): { singular: string; plural: string; code: string } {
  const key = normalizePeopleType(peopleType);
  const fallback = PEOPLE_LABELS[key] ?? {
    singular: titleCase(key),
    plural: `${titleCase(key)}s`,
    code: `${titleCase(key)} ID`,
  };
  const overrides = asRecord(
    config?.terminologyOverrides ?? config?.terminology_overrides,
  );

  return {
    singular: labelFromOverrides(
      overrides,
      [`${key}Singular`, `${key}_singular`, key, "personSingular"],
      fallback.singular,
    ),
    plural: labelFromOverrides(
      overrides,
      [`${key}Plural`, `${key}_plural`, `${key}s`, "personPlural", "people"],
      fallback.plural,
    ),
    code: labelFromOverrides(
      overrides,
      [`${key}Code`, `${key}_code`, `${key}Id`, `${key}ID`, "personCodeLabel"],
      fallback.code,
    ),
  };
}

export function isOvertimeEnabledForConfig(
  config: TemplateConfigLike,
  peopleType?: string | null,
): boolean {
  const normalizedPeopleType = normalizePeopleType(peopleType);
  if (isStudentPeopleType(normalizedPeopleType)) return false;

  const verticalConfig = asRecord(
    config.verticalConfig ?? config.vertical_config,
  );
  const businessType = String(
    config.bizType ??
      config.businessType ??
      config.business_type ??
      config.orgType ??
      config.org_type ??
      verticalConfig.business_type ??
      "company",
  ).toLowerCase();

  return (
    businessType.includes("factory") ||
    businessType.includes("manufacturing") ||
    businessType.includes("plant") ||
    businessType.includes("hospital") ||
    businessType.includes("clinic") ||
    businessType.includes("ngo") ||
    businessType.includes("nonprofit") ||
    businessType.includes("non-profit") ||
    businessType.includes("charity")
  );
}

export function getModulePeopleTypesForBranch(
  config: TemplateConfigLike,
  branchId?: string | number | null,
  moduleKey?: string | null,
): string[] {
  const branchKey =
    branchId === undefined || branchId === null || branchId === ""
      ? ""
      : String(branchId);
  const moduleConfig = branchKey
    ? (config.modulePeopleTypesByBranch ??
        config.module_people_types_by_branch)?.[branchKey]
    : undefined;
  const moduleEntry =
    moduleConfig?.[normalizePeopleType(moduleKey)] ??
    moduleConfig?.[String(moduleKey ?? "").toLowerCase()];
  if (Array.isArray(moduleEntry) && moduleEntry.length) {
    return moduleEntry.map((item) => normalizePeopleType(item)).filter(Boolean);
  }
  return [];
}

/**
 * Single source of truth for "which people types is `moduleKey` enabled for,
 * in this scope" — replaces per-module ad hoc logic like the old
 * `isOvertimeEnabledForConfig` keyword heuristic.
 *
 * Scope resolution:
 *  - branchId given -> exact branch config from `modulePeopleTypesByBranch`.
 *    An empty result here means the module is genuinely off for that branch
 *    (presence = enabled), NOT "fall back to org defaults" — matching the
 *    no-inheritance decision baked into the backend.
 *  - branchId omitted (global/all-branches view) -> union of every branch's
 *    config for that module, since a global view aggregates across branches.
 *
 * Fallback: if the org has NO `modulePeopleTypesByBranch` data at all (pre-
 * migration org, or the branch_module_people_types table isn't provisioned
 * yet), falls back to the org-wide `resolveActivePeopleTypes` list so
 * un-migrated orgs keep working exactly as before instead of going blank.
 * Once `backfill_branch_module_people_types.py` has run for an org, this
 * fallback never triggers for it again.
 */
export function resolveModulePeopleTypes(
  config: TemplateConfigLike & {
    branches?: Array<{
      id?: string | number;
      backendBranchId?: string | null;
      backend_branch_id?: string | null;
    }>;
  },
  moduleKey: string,
  branchId?: string | number | null,
): string[] {
  const branches = Array.isArray(config.branches) ? config.branches : [];
  const perBranchConfig =
    config.modulePeopleTypesByBranch ?? config.module_people_types_by_branch;
  const hasAnyBranchConfig = !!perBranchConfig && Object.keys(perBranchConfig).length > 0;

  if (!hasAnyBranchConfig) {
    return resolveActivePeopleTypes(config);
  }

  const backendIdForUiId = (uiId: string | number): string | null => {
    const match = branches.find((branch) => String(branch.id) === String(uiId));
    const resolved = match?.backendBranchId ?? match?.backend_branch_id;
    return resolved ? String(resolved) : null;
  };

  if (branchId !== undefined && branchId !== null && branchId !== "") {
    const backendId = backendIdForUiId(branchId) ?? String(branchId);
    return getModulePeopleTypesForBranch(config, backendId, moduleKey);
  }

  const union = new Set<string>();
  for (const branch of branches) {
    const backendId = String(branch.backendBranchId ?? branch.backend_branch_id ?? "");
    if (!backendId) continue;
    getModulePeopleTypesForBranch(config, backendId, moduleKey).forEach((type) =>
      union.add(type),
    );
  }
  return Array.from(union);
}

export function resolvePeopleRenderingModel(
  config: TemplateConfigLike,
  selectedPeopleType?: string | null,
  /**
   * Optional module-scoped restriction, from resolveModulePeopleTypes.
   * Pass `undefined` (omit) to keep today's org-wide behavior unchanged.
   * Pass `[]` explicitly to mean "this module is off for this scope" —
   * allPeopleTypes will be empty and callers should render a disabled/empty
   * state rather than falling back to peopleType: 'staff'.
   */
  restrictToPeopleTypes?: string[],
): PeopleRenderingModel {
  const verticalConfig = asRecord(
    config.verticalConfig ?? config.vertical_config,
  );
  const overrides = asRecord(
    config.terminologyOverrides ?? config.terminology_overrides,
  );
  const businessType = String(
    config.bizType ??
      config.businessType ??
      config.business_type ??
      config.orgType ??
      config.org_type ??
      verticalConfig.business_type ??
      "company",
  ).toLowerCase();
  const resolvedPeopleTypes = resolveActivePeopleTypes(config);
  const allPeopleTypes =
    restrictToPeopleTypes === undefined
      ? resolvedPeopleTypes
      : resolvedPeopleTypes.filter((type) => restrictToPeopleTypes.includes(type));
  const peopleType = allPeopleTypes.includes(
    normalizePeopleType(selectedPeopleType),
  )
    ? normalizePeopleType(selectedPeopleType)
    : (allPeopleTypes[0] ?? "staff");
  const family = peopleFamilyForType(peopleType);
  const isStudent = family === "student";
  const isFactory =
    businessType.includes("factory") ||
    businessType.includes("manufacturing") ||
    allPeopleTypes.some((type) => ["worker", "workers"].includes(type));
  const baseLabel = peopleLabelForType(peopleType, config);

  const groupLabel = isStudent
    ? labelFromOverrides(
        overrides,
        ["studentGroup", "class", "classLabel"],
        "Class",
      )
    : labelFromOverrides(
        overrides,
        ["workforceGroup", "department", "unit", "departmentLabel"],
        isFactory ? "Department / Unit" : "Department",
      );
  const groupPlural = isStudent
    ? labelFromOverrides(
        overrides,
        ["studentGroups", "classes", "classPlural"],
        "Classes",
      )
    : labelFromOverrides(
        overrides,
        ["workforceGroups", "departments", "units", "departmentPlural"],
        isFactory ? "Departments / Units" : "Departments",
      );
  const subgroupLabel = isStudent
    ? labelFromOverrides(
        overrides,
        ["studentSubgroup", "section", "sectionLabel"],
        "Section",
      )
    : labelFromOverrides(
        overrides,
        ["workforceSubgroup", "team", "teamLabel"],
        "Team",
      );
  const subgroupPlural = isStudent
    ? labelFromOverrides(
        overrides,
        ["studentSubgroups", "sections", "sectionPlural"],
        "Sections",
      )
    : labelFromOverrides(
        overrides,
        ["workforceSubgroups", "teams", "teamPlural"],
        "Teams",
      );
  const roleLabel = labelFromOverrides(
    overrides,
    ["workforceRole", "designation", "role", "designationLabel"],
    isStudent ? subgroupLabel : "Designation",
  );
  const rolePlural = labelFromOverrides(
    overrides,
    ["workforceRoles", "designations", "roles", "designationPlural"],
    isStudent ? subgroupPlural : "Designations",
  );
  const branchLabel = labelFromOverrides(
    overrides,
    ["branch", "branchLabel", "branch_label"],
    "Branch",
  );

  const explicitShift = readFeatureFlag(config, [
    "shift",
    "shifts",
    "shiftManagement",
    "shift_management",
    "attendanceShifts",
    "attendance_shifts",
  ]);
  const explicitPayroll = readFeatureFlag(config, [
    "payroll",
    "salary",
    "compensation",
    "payrollManagement",
    "payroll_management",
  ]);
  const explicitLeave = readFeatureFlag(config, [
    "leave",
    "leaves",
    "leaveManagement",
    "leave_management",
  ]);
  // Respect explicit per-people-type shift enablement when provided via
  // `shiftEnabledPeopleTypes` (onboarding/config). If that list exists, use
  // it to decide shift support for the current people type. Otherwise fall
  // back to the legacy feature flag or `!isStudent` heuristic.
  const shiftList = normalizePeopleTypeList(
    (config as Record<string, unknown>).shiftEnabledPeopleTypes ??
      (config as Record<string, unknown>).shift_enabled_people_types ??
      verticalConfig.shiftEnabledPeopleTypes ??
      verticalConfig.shift_enabled_people_types,
  );

  const supportsShift =
    shiftList.length > 0
      ? shiftList.includes(peopleType)
      : (explicitShift ?? !isStudent);
  const supportsPayroll = explicitPayroll ?? !isStudent;
  const supportsLeave = explicitLeave ?? !isStudent;

  return {
    peopleType,
    family,
    allPeopleTypes,
    selectablePeopleTypes: allPeopleTypes.map((type) => ({
      value: type,
      label: peopleLabelForType(type, config).plural,
    })),
    hasMultiplePeopleTypes: allPeopleTypes.length > 1,
    isStudent,
    isWorkforce: !isStudent,
    pageTitle: `${baseLabel.plural} Management`,
    directoryTitle: `${baseLabel.singular} Directory`,
    statsTotalLabel: `Total ${baseLabel.plural}`,
    addButtonLabel: `Add ${baseLabel.singular}`,
    addRecordLabel: `Add ${baseLabel.singular} Record`,
    editRecordLabel: `Edit ${baseLabel.singular} Record`,
    emptyTitle: `No ${baseLabel.plural.toLowerCase()} found`,
    emptySubtitle: `Add your first ${baseLabel.singular.toLowerCase()} to get started`,
    exportEmptyMessage: `No ${baseLabel.plural.toLowerCase()} match the selected filters.`,
    exportFilenamePrefix: baseLabel.plural.replace(/\s+/g, "_"),
    exportModuleLabel: `${baseLabel.plural} Management`,
    personSingular: baseLabel.singular,
    personPlural: baseLabel.plural,
    personCodeLabel: baseLabel.code,
    branchLabel,
    groupLabel,
    groupPlural,
    subgroupLabel,
    subgroupPlural,
    roleLabel,
    rolePlural,
    statusFilterAllLabel: "All Statuses",
    groupFilterAllLabel: `All ${groupPlural}`,
    subgroupFilterAllLabel: `All ${subgroupPlural}`,
    searchPlaceholder: isStudent
      ? `Search ${baseLabel.singular.toLowerCase()} name, email, phone, ID, ${groupLabel.toLowerCase()}, ${subgroupLabel.toLowerCase()}...`
      : `Search ${baseLabel.singular.toLowerCase()} name, email, phone, ID, ${groupLabel.toLowerCase()}, ${roleLabel.toLowerCase()}...`,
    showClassSectionFields: isStudent,
    showDepartmentDesignationFields: !isStudent,
    showCompensationFields: supportsPayroll,
    showBenefitsFields: supportsPayroll,
    showStaffTypeField: !isStudent,
    showShiftFields: supportsShift,
    showShiftAllocation: supportsShift,
    showDashboardModuleAccess: !isStudent,
    showTrainingMedia: true,
    supportsShift,
    supportsPayroll,
    supportsLeave,
    statusLabels: {
      active: "Active",
      inactive: "Inactive",
      pending: "Pending",
    },
    workTypeLabels: {
      office: isFactory ? "Site / Unit" : "Office",
      field: isFactory ? "Field / Floor" : "Field",
    },
    archiveLabel: `Archive ${baseLabel.singular}`,
    archivedPluralLabel: `Archived ${baseLabel.plural}`,
    credentialTitle: `${baseLabel.singular} Login Credentials`,
  };
}

export function configItemFamily(value: unknown): PeopleFamily {
  const item = asRecord(value);
  const rawFamily = firstString(item.personFamily, item.person_family);
  if (rawFamily === "student" || rawFamily === "workforce") return rawFamily;
  const itemKind = firstString(item.itemKind, item.item_kind);
  if (
    itemKind === "class_section" ||
    item.className ||
    item.class_name ||
    item.sectionName ||
    item.section_name
  ) {
    return "student";
  }
  return "workforce";
}

export function configItemName(value: unknown): string {
  const item = asRecord(value);
  return firstString(item.name, item.label, item.title) ?? "";
}

export function configItemClassName(value: unknown): string {
  const item = asRecord(value);
  return (
    firstString(
      item.className,
      item.class_name,
      item.groupName,
      item.group_name,
      item.name,
    ) ?? ""
  );
}

export function configItemSectionName(value: unknown): string {
  const item = asRecord(value);
  return (
    firstString(
      item.sectionName,
      item.section_name,
      item.subgroupName,
      item.subgroup_name,
    ) ?? ""
  );
}