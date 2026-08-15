/**
 * src/app/support-dashboard/packages/shared-types/src/organization.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared Support Dashboard organization/domain types.
 *
 * Backend remains the source of truth. These types describe the response shape
 * used by the Support Dashboard and keep template, billing, branch lifecycle,
 * installer, and node-health fields typed without hardcoding client-side
 * business logic.
 */

export type AttendanceMode = "cloud" | "local";

/**
 * Office vs. field staff — a commercial scope owned by Support, not the
 * client. Support decides (per organization, based on what the client is
 * paying for) whether the Client Dashboard's Add/Edit Staff form offers
 * "Office Staff" only, "Field Staff" only, or both. This is intentionally
 * separate from PeopleType (student/staff/worker/...): PeopleType is the
 * business-template person category, StaffWorkType is the attendance-capture
 * method (WiFi/geofence) and, per this scope, which capture methods a given
 * organization is entitled to offer at all.
 */
export type StaffWorkType = "office" | "field";

export type BusinessType =
  | "company"
  | "school"
  | "factory"
  | "hospital"
  | "ngo"
  | string;

export type PeopleType =
  | "student"
  | "staff"
  | "worker"
  | "employee"
  | "volunteer"
  | "member"
  | "patient"
  | string;

export type PeopleKind =
  | "students"
  | "staff"
  | "workers"
  | "employees"
  | "personnel"
  | "members"
  | "volunteers"
  | "patients"
  | "both";

export type OrgStatus =
  | "active"
  | "grace_period"
  | "suspended"
  | "archived"
  | "deleted"
  | string;

export type BillingCycle = "monthly" | "quarterly" | "annually";
export type ModuleStatus = "active" | "inactive";
export type InvoiceStatus =
  | "pending"
  | "paid"
  | "overdue"
  | "cancelled"
  | string;
export type InternalUserRole =
  | "super_admin"
  | "support_agent"
  | "billing_admin"
  | string;

export type ModuleName =
  | "attendance"
  | "employees"
  | "leave"
  | "payroll"
  | "overtime"
  | "reports"
  | "cctv"
  | "liveattendance"
  | "staff_directory"
  | "leave_management"
  | "live_attendance"
  | string;

export type TerminologyOverrides = Record<string, string>;

export interface PeopleTypeStructure {
  unit_1?: string;
  unit_2?: string;
  [key: string]: unknown;
}

export interface VerticalConfig {
  business_type?: BusinessType;
  primary_people_type?: PeopleType;
  enabled_people_types?: PeopleType[];
  attendance_people_types?: PeopleType[];
  structures?: Record<string, Record<string, string>>;
  labels?: Record<string, string>;
  client_allowed_unit_types?: string[];
  client_can_change_template?: boolean;
  [key: string]: unknown;
}

export interface SupportVerticalTemplateOption {
  business_type: BusinessType;
  label: string;
  primary_people_type: PeopleType;
  enabled_people_types?: PeopleType[];
  attendance_people_types?: PeopleType[];
  structures?: Record<string, Record<string, string>>;
  labels?: Record<string, string>;
  vertical_config?: VerticalConfig;
}

export interface Organization {
  id: string;
  name: string;
  contact_email: string;
  contact_phone: string | null;
  org_type: string | null;

  business_type?: BusinessType;
  biz_type?: BusinessType;
  primary_people_type?: PeopleType;
  enabled_people_types?: PeopleType[];
  attendance_people_types?: PeopleType[];
  vertical_config?: VerticalConfig | null;

  people_kind: PeopleKind;
  terminology_overrides?: TerminologyOverrides | null;

  /**
   * Support-owned commercial scope: which staff work types (office/field)
   * this organization is entitled to add in the Client Dashboard's Staff
   * Directory. Defaults to both for organizations created before this field
   * existed — see DEFAULT enforcement server-side, not here.
   */
  enabled_staff_types?: StaffWorkType[];

  attendance_mode: AttendanceMode;
  node_offline_threshold_seconds: number | null;
  max_branches: number;
  status: OrgStatus;
  created_by: string | null;
  created_at: string;
  updated_at?: string;

  archived_at?: string | null;
  archived_by?: string | null;
  archive_reason?: string | null;
  organization_retention_years?: number | null;
  employee_retention_years?: number | null;
  retention_until?: string | null;
  retention_policy_updated_at?: string | null;
  retention_policy_updated_by?: string | null;
  deletion_requested_at?: string | null;
  deletion_requested_by?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  delete_reason?: string | null;
}

export interface CreateOrganizationPayload {
  name: string;
  contact_email: string;
  contact_phone?: string;
  org_type?: string;
  business_type?: BusinessType;
  attendance_people_types?: PeopleType[];
  enabled_staff_types?: StaffWorkType[];
  people_kind?: PeopleKind;
  terminology_overrides?: TerminologyOverrides;
  attendance_mode: AttendanceMode;
  node_offline_threshold_seconds?: number | null;
  max_branches: number;
}

export interface UpdateOrganizationPayload {
  id: string;
  name?: string;
  contact_email?: string;
  contact_phone?: string | null;
  org_type?: string | null;
  business_type?: BusinessType;
  biz_type?: BusinessType;
  primary_people_type?: PeopleType;
  enabled_people_types?: PeopleType[];
  attendance_people_types?: PeopleType[];
  vertical_config?: VerticalConfig | null;
  people_kind?: PeopleKind;
  terminology_overrides?: TerminologyOverrides | null;
  enabled_staff_types?: StaffWorkType[];
  attendance_mode?: AttendanceMode;
  node_offline_threshold_seconds?: number | null;
  max_branches?: number;
  drop_branch_ids?: string[];
  branch_limit_drop_reason?: string;
}

export interface UpdateOrganizationTemplatePayload {
  id: string;
  business_type: BusinessType;
  attendance_people_types?: PeopleType[];
}

export interface UpdateOrganizationStaffTypeScopePayload {
  id: string;
  enabled_staff_types: StaffWorkType[];
}

export interface ArchiveOrganizationPayload {
  reason?: string;
  retention_years: number;
}

export interface UpdateOrganizationRetentionPayload {
  retention_years: number;
}

export interface RequestOrganizationDeletePayload {
  reason?: string;
}

export interface PermanentDeleteOrganizationPayload {
  confirm_name: string;
  reason?: string;
}

export interface PermanentDeleteResult {
  organization_id: string;
  organization_name: string;
  deleted_at: string;
  deleted_by?: string | null;
  delete_reason?: string | null;
  tables: Array<{
    table: string;
    deleted: boolean;
    column?: string | null;
    error?: string | null;
  }>;
}

export interface Branch {
  id: string;
  org_id: string;
  name: string;
  location: string | null;
  max_staff_capacity: number;
  timezone: string;
  fallback_active?: boolean;
  created_at?: string;
  updated_at?: string;
  dropped_at?: string | null;
  dropped_by?: string | null;
  drop_reason?: string | null;
}

export interface CreateBranchPayload {
  org_id: string;
  name: string;
  location?: string;
  max_staff_capacity: number;
  timezone?: string;
}

export interface UpdateBranchPayload {
  name?: string;
  location?: string | null;
  max_staff_capacity?: number;
  timezone?: string;
}

export interface OrganizationModule {
  id?: string;
  org_id: string;
  module_name: ModuleName;
  status: ModuleStatus;
  purchased_at?: string;
}

export interface ToggleModulePayload {
  org_id: string;
  module_name: ModuleName;
  status: ModuleStatus;
}

export interface Subscription {
  id: string;
  org_id: string;
  billing_cycle: BillingCycle;
  current_period_start: string;
  current_period_end: string;
  created_at?: string;
  updated_at?: string;
}

export interface Invoice {
  id: string;
  org_id: string;
  invoice_number?: string | null;
  amount: number | string;
  currency?: string | null;
  due_date: string;
  grace_period_days: number;
  status: InvoiceStatus;
  paid_at?: string | null;
  marked_paid_by?: string | null;
  notes?: string | null;
  sent_at?: string | null;
  sent_by?: string | null;
  sent_method?: "manual" | "email" | string | null;
  sent_to?: string | null;
  sent_subject?: string | null;
  sent_message_snapshot?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MarkInvoicePaidPayload {
  invoice_id: string;
  notes?: string;
}

export type NodeStatus = "online" | "offline" | "never_connected" | string;

export interface NodeHealth {
  branch_id: string;
  branch_name: string;
  node_id: string | null;
  status: NodeStatus;
  last_seen_at: string | null;
  fallback_active?: boolean;
  node_label?: string | null;
  attendance_mode?: AttendanceMode | string | null;
  configured_cameras?: number | null;
  cycle_status?: string | null;
  last_cycle_at?: string | null;
  last_error?: string | null;
  agent_version?: string | null;
  hostname?: string | null;
  minutes_since_seen?: number | null;
  last_heartbeat_payload?: Record<string, unknown> | null;
}

export interface InternalUser {
  id: string;
  email: string;
  full_name: string;
  role: InternalUserRole;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}
