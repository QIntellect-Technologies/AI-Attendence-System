/// <reference types="vite/client" />

/**
 * payrollApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Backend API wrapper for Payroll. UUID-safe and tenant-scoped.
 */

import { cleanId } from "../../../utils/tenantScope";
import { friendlyRequestFailureMessage } from "../../../utils/apiErrors";

export type PayrollId = number | string;

export const PAYROLL_VALUE_MIN = 1;
export const PAYROLL_VALUE_MAX = 100_000_000;
export const PAYROLL_PERCENT_MAX = 100;

/** Throws if periodEnd is before periodStart. Both are 'YYYY-MM-DD' —
 * zero-padded ISO date strings sort lexicographically the same as they sort
 * chronologically, so a plain string comparison is correct here without
 * parsing into Date objects.
 *
 * Mirrors app.py's _validate_payroll_period_order / payroll_engine's
 * compute_payroll_breakdown guard on the backend. The current UI can only
 * ever reach markPayrollPaid/markPayrollPending with a period derived from
 * a single month picker (see usePayrollData.ts's monthToPeriod), which by
 * construction always produces periodStart <= periodEnd — so this can't
 * fire from today's UI. It's here anyway so any future caller (a custom
 * date-range picker, a bulk-import flow, a different page reusing this
 * API wrapper) fails fast in the browser with a clear message instead of
 * discovering the problem from a 400 after a network round trip — and so
 * the backend's own validation is never the only thing standing between a
 * typo and an inverted payroll period.
 */
function assertValidPayrollPeriodOrder(
  periodStart: string,
  periodEnd: string,
): void {
  if (periodEnd < periodStart) {
    throw new Error(
      `period_end (${periodEnd}) cannot be before period_start (${periodStart}).`,
    );
  }
}

export type LeavePayStatus = "paid" | "unpaid";
export type AllowanceMode = "fixed" | "percent" | "none";

/** One org/branch-configurable allowance type, e.g. "Transport": fixed
 * PKR 3000, or "Housing": 10% of basic salary. Lives in PayrollPolicy so it
 * follows the same org→branch→staff scoping as leaveTypeRules/otRatePerHour
 * (see PayrollPolicyScope). 'none' is a non-monetary type that always
 * resolves to 0 — for perks worth recording without a dollar value. */
export interface AllowanceType {
  label: string;
  mode: AllowanceMode;
  value: number;
}

/** Which allowance types are actually applied to one staff member, and any
 * per-person override on the value — lives on salary_configs, edited only
 * from PayrollModule's per-staff edit modal (see saveSalaryConfig). */
export interface AppliedAllowance {
  enabled: boolean;
  overrideValue?: number;
}

/** One resolved allowance line for display — backend-computed via
 * resolve_effective_allowances, mirrors payroll_engine's breakdown pattern. */
export interface AllowanceBreakdownItem {
  key: string;
  label: string;
  mode: AllowanceMode;
  value: number;
  amount: number;
}
export type LateComingMode =
  | "none"
  | "occurrence_threshold"
  | "flat_per_occurrence"
  | "per_minute";
export type PerDayRateBasis = "calendar_days" | "fixed_days" | "scheduled_days";

export interface LateComingPolicy {
  mode: LateComingMode;
  thresholdOccurrences?: number;
  flatAmountPerOccurrence?: number;
  perMinuteRate?: number;
}

export interface PayrollPolicy {
  otRatePerHour: number;
  defaultSalary: number;
  perDayRateBasis: PerDayRateBasis;
  fixedWorkingDaysPerMonth: number;
  lateComingPolicy: LateComingPolicy;
  leaveTypeRules: Record<string, LeavePayStatus>;
  /**
   * Annual paid-day quota per leave type, e.g. { annual: 12, sick: 6 }.
   * Keys mirror leaveTypeRules 1:1 — kept in lockstep by PayrollModule
   * whenever a leave type is added/removed there. A type absent from this
   * map has no configured quota (unknown, not zero) — see
   * useLeaveHistory's handling of that case.
   */
  leaveTypeQuotas: Record<string, number>;
  /** Org/branch-scoped catalog of named allowance types. Keyed the same way
   * as leaveTypeRules (lowercase slug). See AllowanceType. */
  allowanceTypes: Record<string, AllowanceType>;
}

export const DEFAULT_PAYROLL_POLICY: PayrollPolicy = {
  otRatePerHour: 0,
  defaultSalary: 0,
  perDayRateBasis: "calendar_days",
  fixedWorkingDaysPerMonth: 26,
  lateComingPolicy: { mode: "occurrence_threshold", thresholdOccurrences: 3 },
  leaveTypeRules: {},
  leaveTypeQuotas: {},
  allowanceTypes: {},
};

// Mirrors payroll_engine.PayrollBreakdown.to_dict() on the backend — keep
// these two shapes in lockstep; this is the itemized view the UI renders.
export interface PayrollBreakdown {
  baseSalary: number;
  perDayRate: number;
  lateCount: number;
  lateDeductionDays: number;
  lateDeductionAmount: number;
  halfDayAttendanceCount: number;
  halfDayLeaveCount: number;
  halfDayDeductionAmount: number;
  unpaidLeaveDays: number;
  unpaidLeaveDeductionAmount: number;
  overtimeHours: number;
  overtimeAmount: number;
  // Leave days that were excluded from the deduction because attendance
  // shows the staff member actually checked in that day (see
  // payroll_engine._reconcile_leave_against_attendance on the backend).
  // Worth surfacing in the UI as a "review" signal, not just a silent fix.
  attendanceLeaveConflictDays: number;
  totalDeductions: number;
  totalAdditions: number;
  netPay: number;
}

export interface PayrollSalaryConfig {
  id: PayrollId;
  userId: PayrollId;
  name: string;
  peopleType: string;
  department: string;
  branchId: PayrollId | null;
  backendBranchId?: string | null;
  branchName: string;
  basicSalary: number;
  /** Total allowance amount folded into net pay — manualAllowance (the
   * legacy flat "Other / Manual Adjustment" number) plus the sum of every
   * enabled named allowance in allowancesBreakdown. This is what payroll
   * tables should render in the "Allowances" column. */
  allowances: number;
  /** The old flat salary_configs.allowances number, kept as an escape hatch
   * for one-off adjustments — no longer editable as a bare number in the UI
   * once named allowance types exist, but still added into `allowances`. */
  manualAllowance: number;
  /** Which named allowance types this staff member has, and any per-person
   * override value — the raw selection, for prefilling the edit modal. */
  appliedAllowances: Record<string, AppliedAllowance>;
  /** Backend-resolved itemized allowance lines (label, mode, value, amount)
   * for display — see resolve_effective_allowances. */
  allowancesBreakdown: AllowanceBreakdownItem[];
  deductions: number;
  /** Raw per-staff override as stored on salary_configs.ot_rate; 0 = no override. */
  otRate: number;
  /**
   * The rate actually applied to this staff member's pay: individual
   * override > branch override > org default (see backend
   * resolve_effective_ot_rate / support_db_payroll.get_payroll_policy).
   * This is what should be displayed as "OT RATE/HR" — otRate above is
   * only for prefilling an edit form with the raw override.
   */
  effectiveOtRate: number;
  otPay: number;
  effectiveFrom: string | null;
  updatedAt: string | null;
  netPay: number;
  breakdown: PayrollBreakdown | null;
}

export interface RawPayrollBreakdown {
  base_salary?: number;
  per_day_rate?: number;
  late_count?: number;
  late_deduction_days?: number;
  late_deduction_amount?: number;
  half_day_attendance_count?: number;
  half_day_leave_count?: number;
  half_day_deduction_amount?: number;
  unpaid_leave_days?: number;
  unpaid_leave_deduction_amount?: number;
  overtime_hours?: number;
  overtime_amount?: number;
  attendance_leave_conflict_days?: number;
  total_deductions?: number;
  total_additions?: number;
  net_pay?: number;
}

interface RawPayrollSalaryConfig {
  id?: PayrollId;
  user_id?: PayrollId;
  staff_id?: PayrollId;
  client_staff_id?: PayrollId;
  name?: string;
  staff_name?: string;
  peopleType?: string;
  people_type?: string;
  personType?: string;
  person_type?: string;
  department?: string;
  department_name?: string;
  branch_id?: PayrollId | null;
  backend_branch_id?: string | null;
  branchId?: PayrollId | null;
  backendBranchId?: string | null;
  branch_name?: string | null;
  branchName?: string | null;
  basic_salary?: number;
  basicSalary?: number;
  allowances?: number;
  manual_allowance?: number;
  manualAllowance?: number;
  applied_allowances?: Record<string, AppliedAllowance> | null;
  appliedAllowances?: Record<string, AppliedAllowance> | null;
  allowances_breakdown?: AllowanceBreakdownItem[] | null;
  allowancesBreakdown?: AllowanceBreakdownItem[] | null;
  deductions?: number;
  ot_rate?: number;
  otRate?: number;
  effective_ot_rate?: number;
  effectiveOtRate?: number;
  ot_pay?: number;
  effective_from?: string | null;
  effectiveFrom?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
  net_pay?: number;
  netPay?: number;
  payroll_breakdown?: RawPayrollBreakdown | null;
}

export function mapBreakdown(
  raw?: RawPayrollBreakdown | null,
): PayrollBreakdown | null {
  if (!raw) return null;
  return {
    baseSalary: Number(raw.base_salary ?? 0),
    perDayRate: Number(raw.per_day_rate ?? 0),
    lateCount: Number(raw.late_count ?? 0),
    lateDeductionDays: Number(raw.late_deduction_days ?? 0),
    lateDeductionAmount: Number(raw.late_deduction_amount ?? 0),
    halfDayAttendanceCount: Number(raw.half_day_attendance_count ?? 0),
    halfDayLeaveCount: Number(raw.half_day_leave_count ?? 0),
    halfDayDeductionAmount: Number(raw.half_day_deduction_amount ?? 0),
    unpaidLeaveDays: Number(raw.unpaid_leave_days ?? 0),
    unpaidLeaveDeductionAmount: Number(raw.unpaid_leave_deduction_amount ?? 0),
    overtimeHours: Number(raw.overtime_hours ?? 0),
    overtimeAmount: Number(raw.overtime_amount ?? 0),
    attendanceLeaveConflictDays: Number(
      raw.attendance_leave_conflict_days ?? 0,
    ),
    totalDeductions: Number(raw.total_deductions ?? 0),
    totalAdditions: Number(raw.total_additions ?? 0),
    netPay: Number(raw.net_pay ?? 0),
  };
}

export interface SaveSalaryConfigPayload {
  basicSalary: number;
  // Omit a field entirely (rather than passing 0) to leave that column
  // untouched server-side — the backend upsert now patches only the keys
  // it receives and keeps whatever is already stored for the rest (see
  // app.py:_upsert_tenant_salary_config). Only pass a value when the
  // caller actually means to set/overwrite it.
  allowances?: number;
  deductions?: number;
  otRate?: number;
  /** Whole-object replace, same contract as savePayrollPolicy — the caller
   * always sends its complete current selection of applied allowance
   * types, never a partial patch of the map itself. Omit the key entirely
   * (not an empty object) to leave whatever's already stored untouched. */
  appliedAllowances?: Record<string, AppliedAllowance>;
  effectiveFrom?: string | null;
  organizationId?: PayrollId | null;
  branchId?: PayrollId | null;
}

const API_BASE = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) || "/api"
).replace(/\/$/, "");

function normalizeBase(path: string): string {
  if (API_BASE.endsWith("/api") && path.startsWith("/api/"))
    return `${API_BASE}${path.slice(4)}`;
  return `${API_BASE}${path}`;
}

// Duplicated from leaveApi.ts rather than imported, matching that file's
// own documented reasoning (see its DASHBOARD_AUTH_TOKEN_KEY comment) —
// dependency isolation between API modules. If this key ever changes, grep
// "dashboardAuthToken" across the codebase and update every copy.
const DASHBOARD_AUTH_TOKEN_KEY = "dashboardAuthToken";

function dashboardAuthHeaders(): HeadersInit {
  try {
    const token = localStorage.getItem(DASHBOARD_AUTH_TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function requestJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const authHeader = dashboardAuthHeaders() as Record<string, string>;
  if (authHeader.Authorization && !headers.has("Authorization")) {
    headers.set("Authorization", authHeader.Authorization);
  }

  const response = await fetch(normalizeBase(path), {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false) {
    throw new Error(
      data?.message ||
        data?.error ||
        friendlyRequestFailureMessage(response.status, "payroll"),
    );
  }
  return data as T;
}

function cleanPayrollId(value: unknown): PayrollId | null {
  const text = cleanId(value);
  if (!text) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) && String(numeric) === text ? numeric : text;
}

function mapSalaryConfig(raw: RawPayrollSalaryConfig): PayrollSalaryConfig {
  const basicSalary = Number(raw.basic_salary ?? raw.basicSalary ?? 0);
  const allowances = Number(raw.allowances ?? 0);
  const manualAllowance = Number(
    raw.manual_allowance ?? raw.manualAllowance ?? 0,
  );
  const appliedAllowancesRaw = raw.applied_allowances ?? raw.appliedAllowances;
  const appliedAllowances: Record<string, AppliedAllowance> =
    appliedAllowancesRaw && typeof appliedAllowancesRaw === "object"
      ? appliedAllowancesRaw
      : {};
  const allowancesBreakdownRaw =
    raw.allowances_breakdown ?? raw.allowancesBreakdown;
  const allowancesBreakdown: AllowanceBreakdownItem[] = Array.isArray(
    allowancesBreakdownRaw,
  )
    ? allowancesBreakdownRaw
    : [];
  const deductions = Number(raw.deductions ?? 0);
  const branchId = cleanPayrollId(raw.branchId ?? raw.branch_id ?? null);
  const backendBranchId =
    cleanId(
      raw.backendBranchId ??
        raw.backend_branch_id ??
        (typeof branchId === "string" ? branchId : null),
    ) || null;

  const breakdown = mapBreakdown(raw.payroll_breakdown);

  return {
    id:
      cleanPayrollId(raw.id) ??
      String(raw.user_id ?? raw.staff_id ?? raw.client_staff_id ?? ""),
    userId:
      cleanPayrollId(raw.user_id ?? raw.staff_id ?? raw.client_staff_id) ??
      cleanPayrollId(raw.id) ??
      "",
    name: raw.name ?? raw.staff_name ?? "Unknown",
    peopleType: String(
      raw.peopleType ??
        raw.people_type ??
        raw.personType ??
        raw.person_type ??
        "staff",
    ).toLowerCase(),
    department: raw.department ?? raw.department_name ?? "General",
    branchId,
    backendBranchId,
    branchName: raw.branchName ?? raw.branch_name ?? "",
    basicSalary,
    allowances,
    manualAllowance,
    appliedAllowances,
    allowancesBreakdown,
    deductions,
    otRate: Number(raw.ot_rate ?? raw.otRate ?? 0),
    // Falls back to raw ot_rate only if the backend response predates this
    // field (defensive during rollout) — see PayrollSalaryConfig.effectiveOtRate.
    effectiveOtRate: Number(
      raw.effective_ot_rate ??
        raw.effectiveOtRate ??
        raw.ot_rate ??
        raw.otRate ??
        0,
    ),
    otPay: Number(raw.ot_pay ?? breakdown?.overtimeAmount ?? 0),
    effectiveFrom: raw.effective_from ?? raw.effectiveFrom ?? null,
    updatedAt: raw.updated_at ?? raw.updatedAt ?? null,
    netPay: Number(
      raw.net_pay ?? raw.netPay ?? basicSalary + allowances - deductions,
    ),
    breakdown,
  };
}

export async function getSalaryConfigs(params?: {
  branchId?: PayrollId | null;
  organizationId?: PayrollId | null;
  periodStart?: string | null; // 'YYYY-MM-DD' — omit for manual-deductions fallback
  periodEnd?: string | null;
  /** Same people-type scoping as the primary payroll page (worker/staff/
   * student/etc) — omit to leave the fallback list unscoped by type. */
  peopleType?: string | null;
}): Promise<PayrollSalaryConfig[]> {
  const query = new URLSearchParams();
  const organizationId = cleanPayrollId(params?.organizationId);
  if (organizationId === null)
    throw new Error("organization_id is required for payroll.");
  query.set("organization_id", String(organizationId));

  const branchId = cleanPayrollId(params?.branchId);
  if (branchId !== null) query.set("branch_id", String(branchId));
  if (params?.periodStart) query.set("period_start", params.periodStart);
  if (params?.periodEnd) query.set("period_end", params.periodEnd);
  if (params?.periodStart && params?.periodEnd) {
    assertValidPayrollPeriodOrder(params.periodStart, params.periodEnd);
  }
  if (params?.peopleType) query.set("people_type", params.peopleType);

  const raw = await requestJson<RawPayrollSalaryConfig[]>(
    `/salary?${query.toString()}`,
  );
  return raw.map(mapSalaryConfig);
}

/** Single-staff, read-only lookup — used by the StaffManagement profile
 * drawer to show a staff member's applied allowances (display only; that
 * screen has no write path into salary_configs, see hierarchyApi.ts's own
 * doc comment on why manager-hierarchy fields split into their own file —
 * same "one file per concern" reasoning applies to why this stays a plain
 * read here rather than growing an edit affordance). Returns null if the
 * staff member has no salary_configs row yet (never created a payroll
 * entry) rather than throwing, since "no allowances configured" is a valid
 * and common state, not an error. */
export async function getSalaryConfigForStaff(
  staffId: PayrollId,
  organizationId: PayrollId,
): Promise<PayrollSalaryConfig | null> {
  const query = new URLSearchParams({
    organization_id: String(organizationId),
  });
  const raw = await requestJson<RawPayrollSalaryConfig | Record<string, never>>(
    `/salary/${encodeURIComponent(String(staffId))}?${query.toString()}`,
  );
  if (!raw || Object.keys(raw).length === 0) return null;
  return mapSalaryConfig(raw as RawPayrollSalaryConfig);
}

export interface PayrollPolicyScope {
  // Neither set -> org-wide default. branchId -> branch override. staffId
  // -> individual override (also folds in that staff member's effective
  // branch override, if any — see backend get_payroll_policy precedence:
  // individual > branch > org default).
  branchId?: PayrollId | null;
  staffId?: PayrollId | null;
}

export async function getPayrollPolicy(
  organizationId: PayrollId,
  scope?: PayrollPolicyScope,
): Promise<PayrollPolicy> {
  const query = new URLSearchParams({
    organization_id: String(organizationId),
  });
  const branchId = cleanPayrollId(scope?.branchId);
  if (branchId !== null) query.set("branch_id", String(branchId));
  const staffId = cleanPayrollId(scope?.staffId);
  if (staffId !== null) query.set("staff_id", String(staffId));

  const data = await requestJson<{ policy: Partial<PayrollPolicy> }>(
    `/payroll/policy?${query.toString()}`,
  );
  return { ...DEFAULT_PAYROLL_POLICY, ...data.policy };
}

export async function savePayrollPolicy(
  organizationId: PayrollId,
  policy: PayrollPolicy,
  scope?: PayrollPolicyScope,
): Promise<PayrollPolicy> {
  const branchId = cleanPayrollId(scope?.branchId);
  const staffId = cleanPayrollId(scope?.staffId);
  const data = await requestJson<{ policy: PayrollPolicy }>("/payroll/policy", {
    method: "PUT",
    body: JSON.stringify({
      organization_id: String(organizationId),
      policy,
      branch_id: branchId !== null ? String(branchId) : undefined,
      staff_id: staffId !== null ? String(staffId) : undefined,
    }),
  });
  return data.policy;
}

export async function markPayrollPaid(
  organizationId: PayrollId,
  staffId: PayrollId,
  periodStart: string,
  periodEnd: string,
): Promise<void> {
  assertValidPayrollPeriodOrder(periodStart, periodEnd);
  await requestJson<{ success: boolean }>("/payroll/mark-paid", {
    method: "POST",
    body: JSON.stringify({
      organization_id: String(organizationId),
      staff_id: String(staffId),
      period_start: periodStart,
      period_end: periodEnd,
    }),
  });
}

export async function markPayrollPending(
  organizationId: PayrollId,
  staffId: PayrollId,
  periodStart: string,
  periodEnd: string,
): Promise<void> {
  assertValidPayrollPeriodOrder(periodStart, periodEnd);
  await requestJson<{ success: boolean }>("/payroll/mark-pending", {
    method: "POST",
    body: JSON.stringify({
      organization_id: String(organizationId),
      staff_id: String(staffId),
      period_start: periodStart,
      period_end: periodEnd,
    }),
  });
}

export async function saveSalaryConfig(
  userId: PayrollId,
  payload: SaveSalaryConfigPayload,
): Promise<void> {
  const organizationId = cleanPayrollId(payload.organizationId);
  if (organizationId === null)
    throw new Error("organization_id is required for payroll.");

  // Sparse-patch body: basic_salary + identity/scope fields always go,
  // allowances/deductions/ot_rate are included only when the caller
  // actually passed them, so an omitted field reaches the backend as
  // "leave alone" rather than an implicit zero (see backend upsert).
  const body: Record<string, unknown> = {
    user_id: String(userId),
    basic_salary: payload.basicSalary,
    effective_from: payload.effectiveFrom ?? null,
    organization_id: String(organizationId),
    branch_id: payload.branchId ?? null,
  };
  if (payload.allowances !== undefined) body.allowances = payload.allowances;
  if (payload.deductions !== undefined) body.deductions = payload.deductions;
  if (payload.otRate !== undefined) body.ot_rate = payload.otRate;
  if (payload.appliedAllowances !== undefined)
    body.applied_allowances = payload.appliedAllowances;

  await requestJson<{ success: boolean }>("/salary", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
