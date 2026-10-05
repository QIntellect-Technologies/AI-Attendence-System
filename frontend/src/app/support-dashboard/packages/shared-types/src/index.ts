/**
 * packages/shared-types/src/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Barrel export for all shared types.
 *
 * Import from here in both dashboards:
 *   import type { Organization, Branch } from "../../packages/shared-types";
 *
 * Never import directly from sub-files to keep the import path stable
 * if files are reorganized later.
 */

export type {
  AttendanceMode,
  PeopleKind,
  TerminologyOverrides,
  OrgStatus,
  BillingCycle,
  Organization,
  CreateOrganizationPayload,
  UpdateOrganizationPayload,
} from "./organization";

export type {
  NodeStatus,
  Branch,
  CreateBranchPayload,
  UpdateBranchPayload,
  InstallToken,
} from "./branch";

export type {
  InvoiceStatus,
  Invoice,
  Subscription,
  MarkInvoicePaidPayload,
  UpdateInvoiceGracePayload,
} from "./invoice";

export type {
  ModuleName,
  ModuleEntitlementStatus,
  OrganizationModule,
  ToggleModulePayload,
  SetModulesPayload,
} from "./module";

export type {
  NodeHealth,
  ManualFallbackPayload,
  IncidentSeverity,
  IncidentStatus,
  ModuleIncident,
} from "./node";
