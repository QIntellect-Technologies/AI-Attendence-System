/**
 * packages/shared-types/src/module.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Module entitlement types.
 *
 * Design doc ref — Section 7:
 *   organization_modules: toggled independently from billing.
 *   Only modules present in organization_modules appear in the client dashboard.
 *
 * IMPORTANT: ModuleName here = the backend's module identifier string.
 * It is separate from the frontend moduleRegistry key, though they match
 * for implemented modules.
 */

export type ModuleName =
  | "attendance"
  | "employees"
  | "leave"
  | "payroll"
  | "overtime"
  | "reports"
  | "cctv"
  | "liveattendance"
  | "finance"
  | "assets"
  | "departments"
  | "wellbeing"
  // Backward-compatible aliases from the earlier support-dashboard naming.
  | "staff_directory"
  | "leave_management"
  | "live_attendance"
  | string; // allow future modules without breaking types

export type ModuleEntitlementStatus = "active" | "inactive";

export interface OrganizationModule {
  id: string;
  org_id: string;
  module_name: ModuleName;
  status: ModuleEntitlementStatus;
  purchased_at: string;
}

export interface ToggleModulePayload {
  org_id: string;
  module_name: ModuleName;
  status: ModuleEntitlementStatus;
}

export interface SetModulesPayload {
  org_id: string;
  /** Full replacement — modules not in this list will be deactivated */
  modules: Array<{ module_name: ModuleName; status: ModuleEntitlementStatus }>;
}
