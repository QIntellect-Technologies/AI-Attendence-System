type LabelMap = Record<string, string>;
export type PeopleType = string;
export type VerticalConfig = Record<string, unknown> & {
  labels?: Record<string, unknown> | null;
};

export interface PeopleLabelsConfig {
  verticalConfig?: VerticalConfig | null;
  terminologyOverrides?: Record<string, unknown> | null;
  primaryPeopleType?: PeopleType | null;
  attendancePeopleTypes?: PeopleType[];
}

type LabelConfig = PeopleLabelsConfig | VerticalConfig | null | undefined;

const FALLBACK_LABELS: LabelMap = {
  student: "Student",
  student_plural: "Students",
  staff: "Staff",
  staff_plural: "Staff",
  worker: "Worker",
  worker_plural: "Workers",
  employee: "Employee",
  employee_plural: "Employees",
  volunteer: "Volunteer",
  volunteer_plural: "Volunteers",
  member: "Member",
  member_plural: "Members",
  patient: "Patient",
  patient_plural: "Patients",
  class: "Class",
  class_plural: "Classes",
  section: "Section",
  section_plural: "Sections",
  department: "Department",
  department_plural: "Departments",
  designation: "Designation",
  designation_plural: "Designations",
  role: "Role",
  role_plural: "Roles",
  production_line: "Production Line",
  production_line_plural: "Production Lines",
};

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toLabelMap(value: unknown): LabelMap {
  if (!isRecord(value)) return {};

  return Object.entries(value).reduce<LabelMap>((labels, [key, rawValue]) => {
    if (typeof rawValue === "string" && rawValue.trim()) {
      labels[key.trim().toLowerCase()] = rawValue.trim();
    }
    return labels;
  }, {});
}

function labelsFromConfig(config?: LabelConfig): LabelMap {
  if (!config) return {};

  const source =
    isRecord(config) && "verticalConfig" in config
      ? (config.verticalConfig as VerticalConfig | null | undefined)
      : (config as VerticalConfig);

  const verticalLabels = toLabelMap(source?.labels);
  const terminologyOverrides =
    isRecord(config) && "terminologyOverrides" in config
      ? toLabelMap(config.terminologyOverrides)
      : {};

  return {
    ...verticalLabels,
    ...terminologyOverrides,
  };
}

export function getTenantLabel(
  key: string,
  config?: LabelConfig,
  fallback?: string,
): string {
  const cleanKey = String(key || "")
    .trim()
    .toLowerCase();

  if (!cleanKey) return fallback || "";

  const labels = labelsFromConfig(config);
  return (
    labels[cleanKey] ||
    FALLBACK_LABELS[cleanKey] ||
    fallback ||
    titleCase(cleanKey)
  );
}

export function getPeopleTypeLabel(
  peopleType: PeopleType,
  config?: LabelConfig,
): string {
  return getTenantLabel(String(peopleType), config);
}

export function getPeopleTypePluralLabel(
  peopleType: PeopleType,
  config?: LabelConfig,
): string {
  const key = String(peopleType || "")
    .trim()
    .toLowerCase();

  return getTenantLabel(
    `${key}_plural`,
    config,
    `${getPeopleTypeLabel(key, config)}s`,
  );
}

export function getPrimaryPeoplePluralLabel(
  config: Pick<PeopleLabelsConfig, "primaryPeopleType" | "verticalConfig">,
): string {
  return getPeopleTypePluralLabel(config.primaryPeopleType || "staff", config);
}

export function getPeopleManagementLabel(
  config: Pick<PeopleLabelsConfig, "primaryPeopleType" | "verticalConfig">,
): string {
  return `${getPrimaryPeoplePluralLabel(config)} Management`;
}

export function getAttendanceScopeLabels(
  config: Pick<PeopleLabelsConfig, "attendancePeopleTypes" | "verticalConfig">,
): string[] {
  return (config.attendancePeopleTypes || []).map((peopleType) =>
    getPeopleTypePluralLabel(peopleType, config),
  );
}
