/**
 * src/app/utils/moduleAccess.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for "which module keys should be visible right now
 * for this user/org/scope."
 *
 * Extracted from AdminLayout.tsx's `getFirstPaintModuleKeys` (originally
 * written to close a staff privilege-escalation gap — see FIX #2 history
 * below). Previously this logic only backed the Sidebar; DashboardTabBar
 * (the top tab bar) had its own independent, pre-fix copy that dropped the
 * staff restriction once org bootstrap completed. Both now import from here
 * so there is exactly one place that decides module visibility, instead of
 * two implementations that can silently drift apart again.
 *
 * Also now the single home for the per-people-type module gate (Dashboard
 * Overview cards) — see resolveModulePeopleTypesForModule /
 * isModuleEnabledForPeopleType / isDashboardModuleVisible below.
 *
 * FIX #7 (this revision): DashboardOverviewTab.tsx used to carry its own,
 * more permissive alias table locally ("people", "students", "workers",
 * "attendance management", "payroll management", ...) that this file never
 * had. Centralizing module-visibility logic here without folding that
 * coverage in would have silently broken card visibility the moment
 * DashboardOverviewTab.tsx switched over to this file — an org whose
 * purchased-module list says "Students" or "Workers Management" would have
 * had its People card vanish, because "people"/"students"/"workers" had no
 * alias pointing at the canonical "employees" key. Merged that whole set in
 * below so nothing that used to match stops matching.
 *
 * FIX #8 (this revision): normalizeModuleKey previously only trimmed and
 * lowercased before the alias lookup, so a stored value like "Live CCTV" or
 * "staff_directory" (mixed case / spaces / underscores) would fail to match
 * a punctuation-free alias key. It now also strips non-alphanumeric
 * characters before lookup — matching the alphanumeric-stripping
 * normalizeModuleKey DashboardOverviewTab.tsx used to do locally — so alias
 * matching is robust to "Attendance Management", "attendance-management",
 * "attendance_management", and "attendancemanagement" all resolving the
 * same way. MODULE_ALIASES keys below are written alphanumeric-only to stay
 * consistent with that.
 */

import {
  resolveModulePeopleTypes,
  normalizePeopleType,
  type TemplateConfigLike,
} from "./templateRendering";

/**
 * Aliases so callers can gate on either the legacy key or the canonical
 * one interchangeably (e.g. a tab written against "staff" still resolves
 * correctly if cfg.modules stores "employees"). Kept here — not duplicated
 * in ModuleGate.tsx — since alias drift between two copies is exactly how
 * a module ends up gated correctly in one place and not another.
 *
 * Keys are alphanumeric-only (see normalizeModuleKey) so "Staff Directory",
 * "staff_directory", and "staffdirectory" all normalize to the same lookup.
 */
const MODULE_ALIASES: Record<string, string> = {
  // → employees (People / Staff Directory card)
  staff: "employees",
  employee: "employees",
  employees: "employees",
  staffdirectory: "employees",
  staffmanagement: "employees",
  employeemanagement: "employees",
  people: "employees",
  peoplemanagement: "employees",
  students: "employees",
  studentsmanagement: "employees",
  workers: "employees",
  workersmanagement: "employees",

  // → leave
  leavemanagement: "leave",
  leaves: "leave",

  // → liveattendance
  liveattendance: "liveattendance",
  liveattendancemonitoring: "liveattendance",

  // → cctv
  camera: "cctv",
  cameras: "cctv",
  livecctv: "cctv",
  cctvtracking: "cctv",
  security: "cctv",

  // → attendance
  attendancemanagement: "attendance",
  biometricattendance: "attendance",

  // → payroll
  salary: "payroll",
  salaries: "payroll",
  payrollmanagement: "payroll",
};

export function normalizeModuleKey(key: unknown): string {
  const raw = String(key ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return MODULE_ALIASES[raw] ?? raw;
}

/**
 * Single source of truth for "is `moduleKey` enabled for this org", given
 * the org's `cfg.modules` array. Used both by route-level gates
 * (ModuleGate.tsx) and by in-page tab/section visibility (e.g. Reports'
 * Payroll Analysis sub-tab) — anywhere that needs to check module
 * entitlement, not just people-type capability, should call this rather
 * than re-deriving it.
 */
export function isModuleEnabled(
  enabledModules: readonly string[],
  moduleKey: string,
): boolean {
  const normalized = new Set(enabledModules.map(normalizeModuleKey));
  return (
    normalized.has("*") ||
    normalized.has("all") ||
    normalized.has(normalizeModuleKey(moduleKey))
  );
}

/**
 * Trim/dedupe an org's raw purchased-module list into a clean string[].
 * Was previously duplicated locally inside DashboardOverviewTab.tsx; this
 * is now the one place both Overview tabs (and anything else) pull
 * "this org's enabled modules" from.
 */
export function activeModulesFromConfig(modules: unknown): string[] {
  return uniqueStrings(
    (Array.isArray(modules) ? modules : [])
      .map((moduleName) => String(moduleName ?? "").trim())
      .filter(Boolean),
  );
}

export interface ModuleAccessUser {
  role?: string;
  allowedModules?: string[] | string;
  accessModules?: string[] | string;
  moduleAccess?: string[] | string;
  access_modules?: string[] | string;
}

export function isStaffUser(
  user: ModuleAccessUser | null | undefined,
): boolean {
  return String(user?.role ?? "").toLowerCase() === "staff";
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

export function uniqueStrings(vals: string[]): string[] {
  return Array.from(new Set(vals.map((s) => s.trim()).filter(Boolean)));
}

export function getUserAllowedModules(
  user: ModuleAccessUser | null | undefined,
): string[] {
  return uniqueStrings(
    toStringArray(
      user?.allowedModules ??
        user?.accessModules ??
        user?.moduleAccess ??
        user?.access_modules,
    ),
  );
}

/**
 * Alias of getUserAllowedModules under the name BranchOverviewTab.tsx and
 * DashboardOverviewTab.tsx call sites were written against. Kept as a thin
 * re-export — not a second implementation — so the two names can never
 * drift apart again the way "people" vs "employees" just did above.
 */
export const accountModuleKeysFromUser = getUserAllowedModules;

/**
 * FIX #2: Staff module privilege escalation guard.
 *
 * Previous (buggy) behaviour, still present wherever this hasn't been
 * adopted:
 *   const safeModuleKeys = isOrgReady ? orgModules : sessionModules;
 *   → Once org bootstrap completes, staff silently fall through to the
 *     org-wide module list instead of their own session grant, leaking
 *     access to modules their role was never given.
 *
 * Fixed behaviour:
 *   Staff always receive only their own sessionModules, narrowed further
 *   by whatever the org still has enabled post-bootstrap. If the token
 *   contains no modules, we return [] — callers treat an empty result as
 *   "show nothing / skeleton" rather than "show everything".
 *   Admins fall through to orgModules (the Supabase-owned source of truth)
 *   once bootstrap completes; during first paint they use the session
 *   snapshot so nav isn't blank while Supabase responds.
 */
export function getFirstPaintModuleKeys(
  user: ModuleAccessUser | null | undefined,
  cfgModules: unknown,
  isOrgReady: boolean,
  isStaffDashboard: boolean,
): string[] {
  const sessionModules = getUserAllowedModules(user);

  if (isStaffDashboard) {
    if (!isOrgReady) return sessionModules;

    const orgModules = uniqueStrings(
      Array.isArray(cfgModules) ? cfgModules.map(String) : [],
    );
    return sessionModules.filter((key) =>
      orgModules.length > 0 ? orgModules.includes(key) : true,
    );
  }

  const orgModules = uniqueStrings(
    Array.isArray(cfgModules) ? cfgModules.map(String) : [],
  );

  if (isOrgReady) return orgModules;
  return sessionModules;
}

/**
 * Per-account "Dashboard Module Access" gate for a single module card —
 * the Overview-cards equivalent of getFirstPaintModuleKeys, for call sites
 * that check one module at a time (a stat card, a chart) rather than
 * building a full nav key list.
 *
 * Deliberately reuses the SAME FIX #2 contract as getFirstPaintModuleKeys,
 * not a looser one: a staff/manager account's own access_modules list, if
 * non-empty, is the ONLY thing that decides which cards they see — an
 * empty list means "no per-account grants configured yet," which shows
 * NOTHING, not everything. (An earlier draft of dashboard-card gating
 * treated an empty list as unrestricted; that inverted FIX #2's fix and
 * would have silently re-opened the same privilege-escalation gap for
 * dashboard cards that FIX #2 closed for the Sidebar/DashboardTabBar.)
 *
 * Non-staff users (role !== "staff" — org/branch admins) are unrestricted
 * here, same as getFirstPaintModuleKeys's non-staff-dashboard branch.
 */
export function accountAllowsModule(
  user: ModuleAccessUser | null | undefined,
  moduleKey: string,
): boolean {
  if (!isStaffUser(user)) return true;

  const sessionModules = getUserAllowedModules(user);
  if (sessionModules.length === 0) return false;

  const normalizedKey = normalizeModuleKey(moduleKey);
  return sessionModules.some(
    (key) => normalizeModuleKey(key) === normalizedKey,
  );
}

// ── Dashboard Overview cards: per-people-type module gating ───────────────
//
// A third, independent axis on top of org entitlement (isModuleEnabled) and
// account restriction (accountAllowsModule): whether `moduleKey` is enabled
// for the CURRENTLY SELECTED people type, in this branch. Delegates entirely
// to templateRendering.ts's resolveModulePeopleTypes — the existing single
// source of truth for that scope — rather than re-deriving branch/people-
// type resolution here. This file only adds alias tolerance on top of it so
// callers can keep using the same MODULE_ALIASES keys as everywhere else in
// this module, instead of having to know the raw key the per-branch config
// happens to be saved under.

type ModulePeopleTypeConfig = TemplateConfigLike & {
  branches?: Array<{
    id?: string | number;
    backendBranchId?: string | null;
    backend_branch_id?: string | null;
  }>;
};

/** Every raw key this module might be saved under, canonical key first. */
function aliasesFor(moduleKey: string): string[] {
  const canonical = normalizeModuleKey(moduleKey);
  const rawAliases = Object.entries(MODULE_ALIASES)
    .filter(([, target]) => target === canonical)
    .map(([alias]) => alias);
  return Array.from(new Set([canonical, moduleKey, ...rawAliases]));
}

export function resolveModulePeopleTypesForModule(
  config: ModulePeopleTypeConfig,
  moduleKey: string,
  branchId?: string | number | null,
): string[] {
  const union = new Set<string>();
  for (const alias of aliasesFor(moduleKey)) {
    resolveModulePeopleTypes(config, alias, branchId).forEach((type) =>
      union.add(type),
    );
  }
  return Array.from(union);
}

/**
 * Presence = enabled (same contract resolveModulePeopleTypes documents):
 * if the org has real per-branch module config and none of this module's
 * aliases appear in it, the module is genuinely off for every people type
 * in that branch — this does not silently fall back to "enabled".
 */
export function isModuleEnabledForPeopleType(
  config: ModulePeopleTypeConfig,
  moduleKey: string,
  peopleType: string | null | undefined,
  branchId?: string | number | null,
): boolean {
  const enabledFor = resolveModulePeopleTypesForModule(
    config,
    moduleKey,
    branchId,
  );
  if (!enabledFor.length) return false;
  return enabledFor.includes(normalizePeopleType(peopleType));
}

export interface DashboardModuleVisibilityArgs {
  config: ModulePeopleTypeConfig;
  enabledModules: readonly string[];
  user: ModuleAccessUser | null | undefined;
  moduleKey: string;
  peopleType: string | null | undefined;
  branchId?: string | number | null;
}

/**
 * The one call every Dashboard Overview card should make: org entitlement +
 * account restriction + this people type, all three gates in one boolean.
 */
export function isDashboardModuleVisible({
  config,
  enabledModules,
  user,
  moduleKey,
  peopleType,
  branchId,
}: DashboardModuleVisibilityArgs): boolean {
  return (
    isModuleEnabled(enabledModules, moduleKey) &&
    accountAllowsModule(user, moduleKey) &&
    isModuleEnabledForPeopleType(config, moduleKey, peopleType, branchId)
  );
}