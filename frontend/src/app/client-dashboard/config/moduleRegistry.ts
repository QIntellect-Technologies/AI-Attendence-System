/**
 * moduleRegistry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Central registry of every module in the platform.
 *
 * Rules:
 *   1. Only lazy-import folders that physically exist in src/app/modules.
 *   2. A module with implemented: false must use an existing fallback component.
 *   3. Route paths are generated from the registry key so pages stay DRY.
 */

import React from "react";
import type { LucideIcon } from "lucide-react";
import {
  Users,
  Calendar,
  DollarSign,
  Truck,
  Clock,
  Monitor,
  Library,
  BarChart2,
  HeartPulse,
  CalendarCheck,
  Pill,
  Receipt,
  Bed,
  Stethoscope,
  Cpu,
  CheckCircle2,
  Wrench,
  Package,
  Heart,
  UserPlus,
  Megaphone,
  HandHeart,
  ShoppingBag,
  UtensilsCrossed,
  Landmark,
  FileText,
  Activity,
  Building2,
  Settings as SettingsIcon,
} from "lucide-react";

export type ModuleScope = "global" | "branch" | "both";

export interface ModuleDefinition {
  key: string;
  label: string;
  Icon: LucideIcon;
  scope: ModuleScope;
  bizTypes?: string[];
  implemented: boolean;
  component: React.LazyExoticComponent<React.ComponentType>;
}

export type ModuleDef = ModuleDefinition & {
  path: string;
  fullPath: string;
  branchPath: (branchId: number) => string;
  Component: React.LazyExoticComponent<React.ComponentType>;
};

export type NavItem = {
  key: string;
  label: string;
  Icon: LucideIcon;
  path: string;
  fullPath: string;
  branchPath: (branchId: number) => string;
  isSubItem?: boolean;
};

// ─── Lazy imports ─────────────────────────────────────────────────────────────
// Import paths must match the real folders under src/app/modules.

const LazyStaff = React.lazy(
  () => import(/* webpackChunkName: "mod-staff" */ "../pages/StaffManagement"),
);

const LazyLeave = React.lazy(
  () => import(/* webpackChunkName: "mod-leave" */ "../pages/LeaveManagement"),
);

const LazyPayroll = React.lazy(
  () => import(/* webpackChunkName: "mod-payroll" */ "../pages/Payroll"),
);

const LazyAttendance = React.lazy(
  () =>
    import(/* webpackChunkName: "mod-attendance" */ "../pages/attendance_temp"),
);

const LazyReports = React.lazy(
  () => import(/* webpackChunkName: "mod-reports" */ "../pages/Reports"),
);

const LazyOvertime = React.lazy(
  () => import(/* webpackChunkName: "mod-overtime" */ "../pages/Overtime"),
);

const LazyCctv = React.lazy(
  () => import(/* webpackChunkName: "mod-cctv" */ "../pages/CCTV"),
);

const LazyMonitoring = React.lazy(
  () =>
    import(
      /* webpackChunkName: "mod-liveattendance" */ "../pages/LiveAttendance"
    ),
);

const LazyBranches = React.lazy(
  () => import(/* webpackChunkName: "mod-branches" */ "../pages/Branches"),
);

const LazySettings = React.lazy(
  () => import(/* webpackChunkName: "mod-settings" */ "../pages/Settings/Settings"),
);

const LazyPlaceholder = LazyReports;

const LazyBranchDashboard = React.lazy(
  () =>
    import(
      /* webpackChunkName: "page-branch-dashboard" */ "../pages/BranchDashboard/BranchDashboard"
    ),
);

export const ADMIN_ROUTE = "/admin";

export const BRANCH_ROUTE = {
  key: "branch",
  label: "Branch Dashboard",
  path: "branch/:branchId",
  fullPath: `${ADMIN_ROUTE}/branch/:branchId`,
  Component: LazyBranchDashboard,
} as const;

export const modulePath = (key: string): string => `${ADMIN_ROUTE}/${key}`;
export const moduleBranchPath = (key: string, branchId: number): string =>
  `${ADMIN_ROUTE}/branch/${branchId}/${key}`;

export const getModulePath = modulePath;
export const getBranchModulePath = moduleBranchPath;

const withRoutes = (definition: ModuleDefinition): ModuleDef => ({
  ...definition,
  path: modulePath(definition.key),
  fullPath: modulePath(definition.key),
  branchPath: (branchId: number) => moduleBranchPath(definition.key, branchId),
  Component: definition.component,
});

// ─── Registry ─────────────────────────────────────────────────────────────────
// Ordered by display priority. Keep implemented=true only for real module folders.

export const MODULE_REGISTRY_RAW: ModuleDefinition[] = [
  {
    key: "employees",
    label: "People Management",
    Icon: Users,
    scope: "both",
    implemented: true,
    component: LazyStaff,
  },
  {
    key: "attendance",
    label: "Attendance",
    Icon: Calendar,
    scope: "both",
    implemented: true,
    component: LazyAttendance,
  },
  {
    key: "leave",
    label: "Leave Management",
    Icon: CalendarCheck,
    scope: "both",
    implemented: true,
    component: LazyLeave,
  },
  {
    key: "overtime",
    label: "Overtime Management",
    Icon: Clock,
    scope: "both",
    implemented: true,
    component: LazyOvertime,
  },
  {
    key: "payroll",
    label: "Payroll",
    Icon: DollarSign,
    scope: "both",
    implemented: true,
    component: LazyPayroll,
  },
  {
    key: "reports",
    label: "Reports",
    Icon: BarChart2,
    scope: "both",
    implemented: true,
    component: LazyReports,
  },
  {
    key: "cctv",
    label: "Live CCTV",
    Icon: Monitor,
    scope: "both",
    implemented: true,
    component: LazyCctv,
  },
  {
    key: "liveattendance",
    label: "Live Attendance Monitoring",
    Icon: Activity,
    scope: "both",
    implemented: true,
    component: LazyMonitoring,
  },
  {
    key: "branches",
    label: "Branch Comparison",
    Icon: Building2,
    scope: "global",
    implemented: true,
    component: LazyBranches,
  },
  {
    // Structural, entitlement-exempt like "branches" above — Settings is
    // baseline branch-admin configuration (departments, capture settings,
    // half-day windows, timing overrides, plus every org's branch/company
    // profile editor), never a purchasable module. AdminLayout's gear icon
    // and Settings.tsx itself gate this by role/allowedModules directly —
    // it must never be filtered through cfg.modules (the purchased set),
    // the same reasoning that already exempts "branches".
    key: "settings",
    label: "Settings",
    Icon: SettingsIcon,
    scope: "both",
    implemented: true,
    component: LazySettings,
  },
  {
    key: "finance",
    label: "Finance",
    Icon: Landmark,
    scope: "both",
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "timetable",
    label: "Timetable",
    Icon: Clock,
    scope: "both",
    bizTypes: ["school"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "examinations",
    label: "Examinations",
    Icon: FileText,
    scope: "both",
    bizTypes: ["school"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "library",
    label: "Library",
    Icon: Library,
    scope: "both",
    bizTypes: ["school"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "patients",
    label: "Patients",
    Icon: HeartPulse,
    scope: "both",
    bizTypes: ["hospital"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "appointments",
    label: "Appointments",
    Icon: CalendarCheck,
    scope: "both",
    bizTypes: ["hospital"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "pharmacy",
    label: "Pharmacy",
    Icon: Pill,
    scope: "both",
    bizTypes: ["hospital"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "billing",
    label: "Billing",
    Icon: Receipt,
    scope: "both",
    bizTypes: ["hospital"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "wards",
    label: "Wards",
    Icon: Bed,
    scope: "both",
    bizTypes: ["hospital"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "doctors",
    label: "Doctors",
    Icon: Stethoscope,
    scope: "both",
    bizTypes: ["hospital"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "lab",
    label: "Lab",
    Icon: Activity,
    scope: "both",
    bizTypes: ["hospital"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "inventory",
    label: "Inventory",
    Icon: Package,
    scope: "both",
    bizTypes: ["factory", "retail", "restaurant", "hospital"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "maintenance",
    label: "Maintenance",
    Icon: Wrench,
    scope: "both",
    bizTypes: ["factory"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "transport",
    label: "Transport",
    Icon: Truck,
    scope: "both",
    bizTypes: ["factory", "school", "hospital"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "donations",
    label: "Donations",
    Icon: HandHeart,
    scope: "both",
    bizTypes: ["ngo"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "volunteers",
    label: "Volunteers",
    Icon: UserPlus,
    scope: "both",
    bizTypes: ["ngo"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "campaigns",
    label: "Campaigns",
    Icon: Megaphone,
    scope: "both",
    bizTypes: ["ngo", "retail"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "sales",
    label: "Sales",
    Icon: ShoppingBag,
    scope: "both",
    bizTypes: ["retail"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "dining",
    label: "Dining",
    Icon: UtensilsCrossed,
    scope: "both",
    bizTypes: ["restaurant"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "assets",
    label: "Assets",
    Icon: Cpu,
    scope: "both",
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "quality",
    label: "Quality Checks",
    Icon: CheckCircle2,
    scope: "both",
    bizTypes: ["factory"],
    implemented: false,
    component: LazyPlaceholder,
  },
  {
    key: "wellbeing",
    label: "Wellbeing",
    Icon: Heart,
    scope: "both",
    implemented: false,
    component: LazyPlaceholder,
  },
];

export const MODULE_REGISTRY: ModuleDef[] = MODULE_REGISTRY_RAW.map(withRoutes);

export const moduleRegistry = MODULE_REGISTRY;
export const allModules = MODULE_REGISTRY;

export const IMPLEMENTED_MODULES: ModuleDef[] = MODULE_REGISTRY.filter(
  (module) => module.implemented,
);

export const MODULE_MAP: ReadonlyMap<string, ModuleDef> = new Map(
  MODULE_REGISTRY.map((module) => [module.key, module]),
);

export type EnabledModulesOptions = {
  /** global/admin modules, branch modules, or both */
  scope?: ModuleScope;
  /** optional business type filter, for example factory, school, hospital */
  bizType?: string;
  /** Optional allow-list from company config. Empty/undefined means use every module that matches scope. */
  enabledKeys?: readonly string[];
  /** Include placeholder modules that are not implemented yet. Defaults to false. */
  includeUnimplemented?: boolean;
};

const isModuleScope = (value: unknown): value is ModuleScope =>
  value === "global" || value === "branch" || value === "both";

const isReadonlyStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isEnabledModulesOptions = (
  value: unknown,
): value is EnabledModulesOptions =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeEnabledModuleOptions = (
  scopeOrOptions?:
    | ModuleScope
    | string
    | readonly string[]
    | EnabledModulesOptions,
  bizType?: string,
  includeUnimplemented = false,
): EnabledModulesOptions => {
  if (isReadonlyStringArray(scopeOrOptions)) {
    return { enabledKeys: scopeOrOptions, bizType, includeUnimplemented };
  }

  if (isEnabledModulesOptions(scopeOrOptions)) {
    return scopeOrOptions;
  }

  if (isModuleScope(scopeOrOptions)) {
    return { scope: scopeOrOptions, bizType, includeUnimplemented };
  }

  if (typeof scopeOrOptions === "string") {
    return { bizType: scopeOrOptions, includeUnimplemented };
  }

  return { bizType, includeUnimplemented };
};

const matchesModuleScope = (
  module: ModuleDef,
  scope?: ModuleScope,
): boolean => {
  if (!scope || scope === "both") return true;
  return module.scope === "both" || module.scope === scope;
};

const matchesBusinessType = (module: ModuleDef, bizType?: string): boolean => {
  if (!bizType || !module.bizTypes?.length) return true;
  return module.bizTypes.includes(bizType);
};

const matchesEnabledKeys = (
  module: ModuleDef,
  enabledKeys?: readonly string[],
): boolean => {
  if (!enabledKeys || enabledKeys.length === 0) return true;
  return enabledKeys.includes(module.key);
};

/**
 * Canonical module lookup used by ModuleRenderer and navigation code.
 *
 * This is intentionally exported as the primary API, not as an alias, because
 * callers across the app already depend on `getModule` as the registry
 * contract. Keeping the contract here prevents runtime import errors and keeps
 * module lookup centralized.
 */
export function getModule(key: string): ModuleDef | undefined {
  return MODULE_MAP.get(key);
}

/** More explicit lookup name for newer call sites. Same central implementation. */
export function getModuleByKey(key: string): ModuleDef | undefined {
  return getModule(key);
}

/** Compatibility name used by older pages. Same central implementation. */
export function getModuleDefinition(key: string): ModuleDef | undefined {
  return getModule(key);
}

export const isModuleImplemented = (key: string): boolean =>
  Boolean(getModule(key)?.implemented);

export const getModules = (options: EnabledModulesOptions = {}): ModuleDef[] =>
  MODULE_REGISTRY.filter((module) => {
    if (!options.includeUnimplemented && !module.implemented) return false;
    if (!matchesModuleScope(module, options.scope)) return false;
    if (!matchesBusinessType(module, options.bizType)) return false;
    if (!matchesEnabledKeys(module, options.enabledKeys)) return false;
    return true;
  });

export const getModulesForScope = (
  scope: ModuleScope,
  bizType?: string,
  includeUnimplemented = false,
): ModuleDef[] => getModules({ scope, bizType, includeUnimplemented });

export const getImplementedModules = (
  scope: ModuleScope = "both",
  bizType?: string,
): ModuleDef[] => getModules({ scope, bizType, includeUnimplemented: false });

/**
 * Canonical enabled-module API used by dashboards.
 *
 * Supports both modern object usage:
 *   getEnabledModules({ scope: "global", bizType, enabledKeys })
 *
 * and older positional usage:
 *   getEnabledModules("global", bizType)
 *   getEnabledModules(["employees", "attendance"])
 *
 * This keeps the registry contract stable while all filtering still flows
 * through the same single source of truth: MODULE_REGISTRY.
 */
export function getEnabledModules(options?: EnabledModulesOptions): ModuleDef[];
export function getEnabledModules(
  scope?: ModuleScope,
  bizType?: string,
  includeUnimplemented?: boolean,
): ModuleDef[];
export function getEnabledModules(
  enabledKeys?: readonly string[],
  bizType?: string,
  includeUnimplemented?: boolean,
): ModuleDef[];
export function getEnabledModules(
  scopeOrOptions?:
    | ModuleScope
    | string
    | readonly string[]
    | EnabledModulesOptions,
  bizType?: string,
  includeUnimplemented = false,
): ModuleDef[] {
  return getModules(
    normalizeEnabledModuleOptions(
      scopeOrOptions,
      bizType,
      includeUnimplemented,
    ),
  );
}

export const getNavItems = (
  scope: ModuleScope,
  bizType?: string,
  includeUnimplemented = false,
): NavItem[] =>
  getModulesForScope(scope, bizType, includeUnimplemented).map(
    ({ key, label, Icon, path, fullPath, branchPath }) => ({
      key,
      label,
      Icon,
      path,
      fullPath,
      branchPath,
    }),
  );

export const getNavItemsForScope = getNavItems;

export default MODULE_REGISTRY;
