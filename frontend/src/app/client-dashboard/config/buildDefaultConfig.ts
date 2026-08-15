import type { OrgCamera, OrgConfig } from "../contexts/OrgConfigContext";
import {
  DEFAULT_SHIFT_DEFINITIONS,
  normalizeOrgConfig,
} from "../contexts/OrgConfigContext";
import type { BizPreset } from "./bizConfig";

/**
 * Build the initial onboarding config for a business preset.
 *
 * Runtime dashboard data must come from Supabase/bootstrap. This helper is only
 * for creating a complete OrgConfig draft before onboarding is saved.
 */
export function buildDefaultConfig(
  bizType: string,
  biz: BizPreset,
  overrides?: Partial<OrgConfig>,
): OrgConfig {
  const branches: OrgConfig["branches"] = biz.branches.map((name, index) => ({
    id: index + 1,
    name,
    city: "",
  }));

  const departments: OrgConfig["departments"] = {};
  branches.forEach((branch) => {
    departments[branch.id] = [];
  });

  biz.departments.forEach((name, index) => {
    const branchId = branches[index % branches.length]?.id;
    if (!branchId) return;

    departments[branchId].push({
      id: index + 1,
      name,
    });
  });

  const roles: OrgConfig["roles"] = {};
  branches.forEach((branch) => {
    roles[branch.id] = [];
  });

  biz.roles.forEach((role, index) => {
    const branchId = branches[index % branches.length]?.id;
    if (!branchId) return;

    roles[branchId].push({
      id: index + 1,
      name: role.name,
      level: role.level,
    });
  });

  // Do not auto-seed CCTV devices. Cameras are real configuration and should
  // only appear after Support/onboarding saves them.
  const cameras: Record<number, OrgCamera[]> = {};
  branches.forEach((branch) => {
    cameras[branch.id] = [];
  });

  const baseConfig: OrgConfig = {
    bizType,
    orgName: "QIntellect Technologies",
    tagline: "Intelligence at Scale",
    address: "Lahore, Pakistan",
    size: "51–200",
    logo: null,
    branches,
    departments,
    roles,
    modules: [...biz.modules],
    cameras,
    staffShiftDefinitions: DEFAULT_SHIFT_DEFINITIONS,
    liveCctvSource: "mock",
    users: [],
    employeeProfiles: {},
    payrollPolicy: {
      otRatePerHour: 500,
      defaultSalary: 50_000,
    },
  };

  return normalizeOrgConfig({
    ...baseConfig,
    ...overrides,
  });
}
