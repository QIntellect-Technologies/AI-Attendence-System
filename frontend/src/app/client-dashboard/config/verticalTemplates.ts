export type BusinessType = "company" | "school" | "factory" | string;
export type PeopleType = "student" | "staff" | "worker" | "employee" | string;

export type VerticalStructure = {
  unit_1?: string;
  unit_2?: string;
};

export type VerticalConfig = {
  business_type: BusinessType;
  primary_people_type: PeopleType;
  enabled_people_types: PeopleType[];
  structures?: Record<string, VerticalStructure>;
  labels?: Record<string, string>;
  client_allowed_unit_types?: string[];
  client_can_change_template?: boolean;
};

export function getLabel(config: VerticalConfig | undefined, key: string, fallback?: string): string {
  if (!config?.labels) return fallback || key;
  return config.labels[key] || fallback || key;
}

export function getPeopleLabel(config: VerticalConfig | undefined, peopleType?: string): string {
  if (!peopleType) return "Staff";
  return getLabel(config, peopleType, peopleType);
}

export function getPeoplePluralLabel(config: VerticalConfig | undefined, peopleType?: string): string {
  if (!peopleType) return "Staff";
  return getLabel(config, `${peopleType}_plural`, getPeopleLabel(config, peopleType));
}

export function getUnitLabel(config: VerticalConfig | undefined, unitType?: string): string {
  if (!unitType) return "Unit";
  return getLabel(config, unitType, unitType);
}

export function getUnitPluralLabel(config: VerticalConfig | undefined, unitType?: string): string {
  if (!unitType) return "Units";
  return getLabel(config, `${unitType}_plural`, getUnitLabel(config, unitType));
}

export function getPrimaryPeopleType(config: VerticalConfig | undefined): string {
  return config?.primary_people_type || "staff";
}

export function getPrimaryStructure(config: VerticalConfig | undefined): VerticalStructure {
  const primary = getPrimaryPeopleType(config);
  return config?.structures?.[primary] || {
    unit_1: "department",
    unit_2: "designation",
  };
}

export function isUnitTypeAllowed(config: VerticalConfig | undefined, unitType: string): boolean {
  const allowed = config?.client_allowed_unit_types || [];
  return allowed.includes(unitType);
}