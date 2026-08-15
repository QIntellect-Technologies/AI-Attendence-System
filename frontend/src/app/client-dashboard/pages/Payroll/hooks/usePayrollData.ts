/**
 * usePayrollData.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical payroll hook.
 *
 * Single source of truth:
 *   Supabase tenant data through payrollApi.ts + staffApi.ts.
 *
 * Rules:
 * - UI branch ids remain for display/filtering inside React.
 * - Backend branch UUIDs are used for API calls for UUID tenants.
 * - Every request carries organization_id.
 * - No page-level fetch and no demo/legacy leakage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { getFastPage } from "../../../services/performanceApi";
import {
  branchIdentityValues,
  cleanId,
  getBackendBranchId,
  getUiBranchId,
  resolveTenantScope,
} from "../../../utils/tenantScope";

import {
  getSalaryConfigs,
  saveSalaryConfig,
  markPayrollPaid,
  markPayrollPending,
  mapBreakdown,
  type PayrollSalaryConfig,
  type PayrollId,
  type PayrollBreakdown,
  type RawPayrollBreakdown,
  type AppliedAllowance,
  type AllowanceBreakdownItem,
} from "../api/payrollApi";
import {
  normalizePeopleType,
  resolveModulePeopleTypes,
} from "../../../utils/templateRendering";

/** Sparse patch applied on top of whatever is already stored for a staff
 * member's salary_configs row — omit a key to leave it untouched (see
 * payrollApi.SaveSalaryConfigPayload / the backend upsert). appliedAllowances
 * is the one exception to "sparse": when present it's a whole-object
 * replace of the applied-allowances map, same as savePayrollPolicy's
 * contract — the edit modal always sends its complete current selection. */
export interface SalaryOverrides {
  allowances?: number;
  deductions?: number;
  otRate?: number;
  appliedAllowances?: Record<string, AppliedAllowance>;
}

export interface UsePayrollDataOptions {
  organizationId?: PayrollId | null;
  organization_id?: PayrollId | null;
  org_id?: PayrollId | null;
  branchId?: PayrollId | null;
  branch_id?: PayrollId | null;
  backendBranchId?: PayrollId | null;
  backend_branch_id?: PayrollId | null;
  branchUuid?: PayrollId | null;
  branch_uuid?: PayrollId | null;
  month?: string;
  peopleType?: string | null;
  autoRefresh?: boolean;
  refreshMs?: number;
}

export interface PayrollRow {
  id: string;
  staffId: PayrollId;
  userId: PayrollId;
  empId: string;
  name: string;
  peopleType: string;
  department: string;
  branchId: number;
  backendBranchId: string | null;
  branchName: string;
  /** Employee's CNIC (national ID). Empty string when not yet on file —
   * e.g. rows built by buildStaffFallbackPayrollRows before the staff
   * record itself has one, or student payroll rows (students don't carry
   * their own CNIC — see StaffManagement's guardian-details fields). */
  cnic: string;
  baseSalary: number;
  basicSalary: number;
  allowances: number;
  manualAllowance: number;
  appliedAllowances: Record<string, AppliedAllowance>;
  allowancesBreakdown: AllowanceBreakdownItem[];
  deductions: number;
  otHours: number;
  /** Effective OT rate applied to this staff member: their override if set, else the org/branch default. */
  otRate: number;
  /** Raw per-staff override as stored on salary_configs.ot_rate; 0 = no override. Use this to prefill an edit form. */
  otRateOverride: number;
  overtimeAmount: number;
  presentDays: number;
  netPay: number;
  effectiveFrom?: string | null;
  updatedAt?: string | null;
  // Itemized, backend-computed — null when no period was resolvable
  // (e.g. "All Branches" view) and the UI should show the flat total only.
  breakdown: PayrollBreakdown | null;
  unpaidLeaveDays: number;
  lateCount: number;
  status: "Paid" | "Pending" | string;
}

export interface PayrollStats {
  totalPayout: number;
  totalOT: number;
  totalStaff: number;
  status: "Paid" | "Pending" | string;
}

export interface DepartmentPayrollSummary {
  name: string;
  total: number;
}

export interface UsePayrollDataReturn {
  rows: PayrollRow[];
  stats: PayrollStats;
  deptSummary: DepartmentPayrollSummary[];
  /** Which people types the "payroll" module is entitled for in this scope. */
  modulePeopleTypes: string[];
  /** The actually-applied people type (requested type if entitled, else fallback). */
  peopleType: string;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  // force=true bypasses the page cache (used after a mutation so the
  // background resync reflects the write instead of the pre-write cache).
  refresh: (options?: { force?: boolean }) => Promise<void>;
  refetch: (options?: { force?: boolean }) => Promise<void>;
  reload: (options?: { force?: boolean }) => Promise<void>;
  // overrides: sparse patch applied on top of whatever is already stored
  // for this staff member — omit a key to leave it untouched (see
  // payrollApi.SaveSalaryConfigPayload / the backend upsert). otRate here
  // is the per-staff override (individual > branch > org precedence on
  // the backend), not the effective rate — pass 0 to explicitly clear an
  // override back to "use the org/branch default".
  updateBaseSalary: (
    staffId: PayrollId,
    nextBaseSalary: number,
    effectiveFrom?: string | null,
    overrides?: SalaryOverrides,
  ) => Promise<void>;
  markPaid: (staffId: PayrollId) => Promise<void>;
  markPending: (staffId: PayrollId) => Promise<void>;
}

type AnyRecord = Record<string, any>;

const EMPTY_STATS: PayrollStats = {
  totalPayout: 0,
  totalOT: 0,
  totalStaff: 0,
  status: "Paid",
};

// ── Page-level cache + in-flight dedup ──────────────────────────────────────
// Mirrors the pattern already established in useLeaveActions.ts /
// useLeaveTypeOptions.ts: a module-scoped Map keyed by org+branch+period, a
// short TTL so a remount (tab away and back, StrictMode double-mount) within
// the window reuses the last page instead of re-downloading up to 250 rows,
// and a shared in-flight promise so concurrent callers for the same key
// (e.g. two components reading payroll for the same scope) collapse into one
// network request rather than firing one each.
//
// TTL matches useLeaveActions's 8s — short enough that a genuine data change
// (mark paid/pending, salary edit) is never masked for long, but long enough
// to absorb the remounts/duplicate-effect-fires this is meant to catch.
const PAYROLL_CACHE_TTL_MS = 8_000;

type PayrollCacheEntry = { expiresAt: number; rows: AnyRecord[] };
const payrollPageCache = new Map<string, PayrollCacheEntry>();
const payrollPageInflight = new Map<string, Promise<AnyRecord[]>>();

function payrollCacheKey(
  organizationId: string | number,
  branchId: string | number | null | undefined,
  periodStart: string | undefined,
  periodEnd: string | undefined,
  peopleType: string | undefined,
): string {
  return `${organizationId}::${branchId ?? "all"}::${periodStart ?? "none"}::${periodEnd ?? "none"}::${peopleType ?? "all"}`;
}

/**
 * force=true bypasses both the TTL cache and any in-flight dedup and starts
 * a fresh fetch — used after a mutation (mark paid/pending, salary edit) so
 * the background resync isn't served a stale cached page.
 */
async function loadPayrollPageCached(
  key: string,
  fetcher: () => Promise<AnyRecord[]>,
  force = false,
): Promise<AnyRecord[]> {
  if (!force) {
    const cached = payrollPageCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.rows;

    const existing = payrollPageInflight.get(key);
    if (existing) return existing;
  }

  const promise = fetcher()
    .then((rows) => {
      payrollPageCache.set(key, {
        expiresAt: Date.now() + PAYROLL_CACHE_TTL_MS,
        rows,
      });
      return rows;
    })
    .finally(() => {
      payrollPageInflight.delete(key);
    });

  payrollPageInflight.set(key, promise);
  return promise;
}

function invalidatePayrollPageCache(
  organizationId?: string | number | null,
): void {
  if (!organizationId) {
    payrollPageCache.clear();
    return;
  }
  const prefix = `${organizationId}::`;
  Array.from(payrollPageCache.keys()).forEach((k) => {
    if (k.startsWith(prefix)) payrollPageCache.delete(k);
  });
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function staffIdentity(row: AnyRecord): string {
  return cleanId(
    row.staffId ??
      row.staff_id ??
      row.userId ??
      row.user_id ??
      row.client_staff_id ??
      row.id,
  );
}

/** 'YYYY-MM' or undefined -> full calendar-month period. Defaults to the
 * current month when no month filter is set, matching PayrollModule's own
 * default date-filter behavior. */
function monthToPeriod(month?: string): {
  periodStart?: string;
  periodEnd?: string;
} {
  const now = new Date();
  const [year, monthIdx] = month
    ? [Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1]
    : [now.getFullYear(), now.getMonth()];
  if (!Number.isFinite(year) || !Number.isFinite(monthIdx)) return {};
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  // Build the date string from the local Y/M/D components directly —
  // toISOString() converts to UTC first, which shifts the boundary back
  // a day in any timezone ahead of UTC (e.g. PKT/UTC+5): local midnight
  // July 1 becomes "2026-06-30" once converted. Never round-trip a pay
  // period through toISOString().
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    periodStart: `${year}-${pad(monthIdx + 1)}-01`,
    periodEnd: `${year}-${pad(monthIdx + 1)}-${pad(lastDay)}`,
  };
}

/** Local Y/M/D 'YYYY-MM-DD' for today — never round-trip through
 * toISOString() for a calendar date (see monthToPeriod above); that
 * converts to UTC first and shifts the date back a day in any timezone
 * ahead of UTC. Used as the default effective_from when a caller doesn't
 * supply one explicitly. */
function todayDateString(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function rowBranchKeys(row: AnyRecord): string[] {
  return [
    row.branchId,
    row.branch_id,
    row.branchUiId,
    row.branch_ui_id,
    row.backendBranchId,
    row.backend_branch_id,
    row.branchUuid,
    row.branch_uuid,
  ]
    .map(cleanId)
    .filter(Boolean);
}

function branchForRow(row: AnyRecord, branches: AnyRecord[]): AnyRecord | null {
  const rowKeys = new Set(rowBranchKeys(row));
  return (
    branches.find((branch) =>
      branchIdentityValues(branch).some((key) => rowKeys.has(key)),
    ) ?? null
  );
}

function branchNameFromRow(row: AnyRecord, branch: AnyRecord | null): string {
  return String(
    row.branchName ??
      row.branch_name ??
      branch?.name ??
      branch?.branchName ??
      "Main Branch",
  );
}

function normalizePayrollRow(
  rawPayroll: Partial<PayrollSalaryConfig> | AnyRecord,
  staffById: Map<string, AnyRecord>,
  branches: AnyRecord[],
  orgDefaultOtRate: number,
): PayrollRow {
  const raw = rawPayroll as AnyRecord;
  const staffId = staffIdentity(raw);
  const staff = staffById.get(staffId) ?? {};
  const merged = { ...staff, ...raw } as AnyRecord;
  const branch = branchForRow(merged, branches);
  const uiBranchId =
    getUiBranchId(branch) ??
    numberValue(merged.branchId ?? merged.branch_id, 0);
  const backendBranchId =
    getBackendBranchId(branch) ??
    (cleanId(
      merged.backendBranchId ??
        merged.backend_branch_id ??
        merged.branchUuid ??
        merged.branch_uuid,
    ) ||
      null);

  const baseSalary = numberValue(
    merged.basicSalary ??
      merged.basic_salary ??
      merged.baseSalary ??
      merged.base_salary ??
      merged.salary,
  );
  const allowances = numberValue(merged.allowances ?? merged.allowance);
  const manualAllowance = numberValue(
    merged.manualAllowance ?? merged.manual_allowance,
  );
  const appliedAllowancesRaw =
    merged.appliedAllowances ?? merged.applied_allowances;
  const appliedAllowances: Record<string, AppliedAllowance> =
    appliedAllowancesRaw && typeof appliedAllowancesRaw === "object"
      ? appliedAllowancesRaw
      : {};
  const allowancesBreakdownRaw =
    merged.allowancesBreakdown ?? merged.allowances_breakdown;
  const allowancesBreakdown: AllowanceBreakdownItem[] = Array.isArray(
    allowancesBreakdownRaw,
  )
    ? allowancesBreakdownRaw
    : [];
  const deductions = numberValue(merged.deductions ?? merged.deduction);
  const staffKey = staffId || cleanId(merged.id);
  // OT Hours always reflects the real approved-hours total for this pay
  // period, computed on the backend from overtime_requests — there is no
  // local override for it; edit that via Overtime Management, not here.
  const otHours = numberValue(merged.otHours ?? merged.ot_hours);
  // otRateOverride is the raw per-staff value stored on salary_configs.ot_rate
  // (0 means "no override set") — used only to prefill the edit form.
  //
  // otRate is the *effective* rate actually applied to this staff member's
  // pay. The backend now resolves this itself (individual > branch > org —
  // see support_db_payroll.resolve_effective_ot_rate) and sends it as
  // effectiveOtRate/effective_ot_rate, because the frontend cannot resolve
  // this correctly on its own: orgDefaultOtRate only knows the org-wide
  // default (OrgConfigContext.cfg.payrollPolicy), with no visibility into
  // per-branch overrides — so a client-side `otRateOverride || orgDefault`
  // guess silently ignores a branch-level override on any staff member
  // without their own individual override, which is exactly wrong on an
  // "All Branches" view spanning multiple branches with different rates.
  // orgDefaultOtRate is kept only as a defensive fallback for a response
  // that predates this field.
  const otRateOverride = numberValue(merged.otRate ?? merged.ot_rate);
  const otRate = numberValue(
    merged.effectiveOtRate ?? merged.effective_ot_rate,
    otRateOverride || orgDefaultOtRate,
  );
  // After — resolve breakdown once, from whichever shape this row came in as:
  // getSalaryConfigs() (fallback path) already returns a mapped, camelCase
  // `.breakdown`; getFastPage() (primary path) returns raw `payroll_breakdown`
  // (snake_case) straight off the Supabase/payroll_engine response and needs
  // the same mapBreakdown() the fallback path already uses under the hood —
  // reusing it here instead of re-deriving fields keeps both paths in lockstep
  // by construction (DRY), rather than by two people remembering to agree.
  const breakdown: PayrollBreakdown | null =
    (merged.breakdown as PayrollBreakdown | undefined) ??
    mapBreakdown(merged.payroll_breakdown as RawPayrollBreakdown | undefined) ??
    null;

  const overtimeAmount = numberValue(
    merged.overtimeAmount ??
      merged.overtime_amount ??
      breakdown?.overtimeAmount,
    otHours * otRate,
  );
  const computedNetPay = Math.max(
    0,
    baseSalary + allowances + overtimeAmount - deductions,
  );
  const netPay = numberValue(merged.netPay ?? merged.net_pay, computedNetPay);
  const employeeId =
    cleanId(merged.empId ?? merged.employeeId ?? merged.employee_id) ||
    staffKey;
  const peopleType = normalizePeopleType(
    merged.peopleType ??
      merged.people_type ??
      merged.personType ??
      merged.person_type ??
      "staff",
  );

  return {
    id: cleanId(merged.id) || staffKey,
    staffId: staffKey,
    userId: cleanId(merged.userId ?? merged.user_id) || staffKey,
    empId: employeeId,
    name: String(
      merged.name ?? merged.staff_name ?? merged.staffName ?? "Unknown",
    ),
    peopleType,
    department: String(
      merged.department ?? merged.department_name ?? merged.dept ?? "General",
    ),
    branchId: uiBranchId,
    backendBranchId,
    branchName: branchNameFromRow(merged, branch),
    cnic: String(merged.cnic ?? ""),
    baseSalary,
    basicSalary: baseSalary,
    allowances,
    manualAllowance,
    appliedAllowances,
    allowancesBreakdown,
    deductions,
    otHours,
    otRate,
    otRateOverride,
    overtimeAmount,
    presentDays: numberValue(merged.presentDays ?? merged.present_days),
    netPay,
    unpaidLeaveDays: numberValue(
      breakdown?.unpaidLeaveDays ??
        merged.unpaid_leave_days ??
        merged.unpaidLeaveDays,
    ),
    lateCount: numberValue(
      breakdown?.lateCount ?? merged.late_count ?? merged.lateCount,
    ),
    status:
      String(merged.status ?? "Pending").toLowerCase() === "paid"
        ? "Paid"
        : "Pending",
    effectiveFrom: merged.effectiveFrom ?? merged.effective_from ?? null,
    updatedAt: merged.updatedAt ?? merged.updated_at ?? null,
    breakdown,
  };
}

function buildStaffFallbackPayrollRows(staffRows: AnyRecord[]): AnyRecord[] {
  return staffRows.map((staff) => ({
    id: staff.id,
    user_id: staff.id,
    staff_id: staff.id,
    client_staff_id: staff.id,
    employee_id: staff.employeeId ?? staff.employee_id,
    name: staff.name,
    people_type:
      staff.peopleType ??
      staff.people_type ??
      staff.personType ??
      staff.person_type,
    department: staff.department ?? staff.department_name ?? staff.dept,
    branch_id:
      staff.backendBranchId ??
      staff.backend_branch_id ??
      staff.branchUuid ??
      staff.branch_uuid ??
      staff.branchId ??
      staff.branch_id,
    backend_branch_id:
      staff.backendBranchId ??
      staff.backend_branch_id ??
      staff.branchUuid ??
      staff.branch_uuid,
    branchId:
      staff.branchId ??
      staff.branch_id ??
      staff.branchUiId ??
      staff.branch_ui_id,
    branch_name: staff.branchName ?? staff.branch_name,
    cnic: staff.cnic ?? "",
    basic_salary: staff.salary ?? staff.basicSalary ?? staff.basic_salary ?? 0,
    allowances: 0,
    deductions: 0,
    ot_rate: 0,
    net_pay: staff.salary ?? staff.basicSalary ?? staff.basic_salary ?? 0,
    status: "Pending",
  }));
}

function uniquePayrollRows(rows: PayrollRow[]): PayrollRow[] {
  const map = new Map<string, PayrollRow>();
  rows.forEach((row) => {
    const key = cleanId(row.staffId) || cleanId(row.id);
    if (!key) return;
    map.set(key, row);
  });
  return Array.from(map.values());
}

export function usePayrollData(
  options: UsePayrollDataOptions = {},
): UsePayrollDataReturn {
  const {
    cfg,
    organizationId: contextOrganizationId,
    activeBranchId,
  } = useOrg();
  const [salaryRows, setSalaryRows] = useState<AnyRecord[]>([]);
  const [staffRows, setStaffRows] = useState<AnyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const scope = useMemo(() => {
    const org =
      options.organization_id ??
      options.organizationId ??
      options.org_id ??
      contextOrganizationId;
    if (!org) return null;
    return resolveTenantScope(
      {
        organizationId: org,
        branchId:
          options.backend_branch_id ??
          options.backendBranchId ??
          options.branch_uuid ??
          options.branchUuid ??
          options.branch_id ??
          options.branchId ??
          activeBranchId,
      },
      cfg.branches,
    );
  }, [
    activeBranchId,
    cfg.branches,
    contextOrganizationId,
    options.backendBranchId,
    options.backend_branch_id,
    options.branchId,
    options.branchUuid,
    options.branch_id,
    options.branch_uuid,
    options.org_id,
    options.organizationId,
    options.organization_id,
  ]);

  // Support-owned entitlement: which people types the "payroll" module is
  // enabled for, per branch (cfg.modulePeopleTypesByBranch). Mirrors the
  // resolveModulePeopleTypes("attendance"/"leave"/"employees", ...) calls
  // elsewhere, keyed to "payroll". options.branchId is the UI branch id
  // (or undefined for the global/all-branches view) — resolveModulePeopleTypes
  // handles the UI→backend translation and the global union internally.
  const modulePeopleTypes = useMemo(
    () =>
      resolveModulePeopleTypes(
        cfg as unknown as Record<string, unknown>,
        "payroll",
        options.branchId ?? null,
      ),
    [cfg, options.branchId],
  );

  // The type actually applied: the requested one if it's entitled, else a
  // safe fallback within the entitled set. No "all" option — payroll always
  // shows exactly one people type at a time, same as Staff Management.
  const resolvedPeopleType = useMemo(() => {
    if (!modulePeopleTypes.length) return "staff";
    const requested = options.peopleType
      ? normalizePeopleType(options.peopleType)
      : null;
    if (requested && modulePeopleTypes.includes(requested)) return requested;
    return modulePeopleTypes.includes("staff") ? "staff" : modulePeopleTypes[0];
  }, [modulePeopleTypes, options.peopleType]);

  const requestIdRef = useRef(0);
  // The controller behind the most recently *started* request from this
  // hook instance. When scope/month changes (or a caller forces a refresh)
  // before the previous response has landed, we abort it: the requestId
  // check below already stopped it from overwriting state, but without this
  // the backend (get_client_payroll_page, a real query + compute_payroll_
  // breakdown pass per staff row) kept running to completion anyway for a
  // result nobody would ever read.
  const abortRef = useRef<AbortController | null>(null);

  const fetchPayrollPage = useCallback(
    async (
      periodStart: string | undefined,
      periodEnd: string | undefined,
      signal: AbortSignal,
      peopleTypeForFetch: string | undefined,
    ): Promise<AnyRecord[]> => {
      if (!scope?.organizationId) return [];
      try {
        const page = await getFastPage<AnyRecord>({
          entity: "payroll",
          orgId: String(scope.organizationId),
          branchId: scope.apiBranchId ? String(scope.apiBranchId) : undefined,
          page: 1,
          pageSize: 250,
          sortBy: "name",
          sortDir: "asc",
          periodStart,
          periodEnd,
          // Same people-type scoping as Staff Management/Attendance —
          // resolvedPeopleType is always one of modulePeopleTypes (never
          // "all"), so the backend can filter server-side rather than the
          // client having to hide rows of the wrong type after the fact.
          peopleType: peopleTypeForFetch,
          // Forwarded to the underlying fetch call so a superseded request
          // (scope/month changed, or a forced refresh started) actually
          // cancels on the wire instead of just being ignored client-side.
          // getFastPage needs to pass this through to its fetch() call for
          // that cancellation to take effect — if it doesn't yet, this is a
          // harmless no-op today and starts working the moment it does.
          signal,
          // [Fix] Casting the whole object to `AnyRecord` (as before) threw
          // away getFastPage's real parameter type, so TS could no longer
          // verify `entity` against the literal FastPageEntity union it
          // requires -- structurally AnyRecord doesn't guarantee that field
          // exists at all, hence "Property 'entity' is missing in type
          // 'AnyRecord'". `signal` isn't declared on FastPageRequest, so we
          // still need *some* cast to add it -- but intersecting with the
          // function's actual parameter type (via Parameters<>) keeps every
          // other field, including `entity`, fully checked against the real
          // shape instead of erasing it.
        } as Parameters<typeof getFastPage>[0] & { signal?: AbortSignal });
        return (page.rows || []) as AnyRecord[];
      } catch (err) {
        // An intentional cancellation is not "the primary source failed,
        // fall back" — propagate it so the caller can tell it apart from a
        // real error and skip both the fallback request and the error UI.
        if (signal.aborted) throw err;
        const fallback = await getSalaryConfigs({
          organizationId: scope.organizationId,
          branchId: scope.apiBranchId,
          periodStart,
          periodEnd,
          peopleType: peopleTypeForFetch,
        }).catch(() => []);
        return fallback as AnyRecord[];
      }
    },
    [scope?.apiBranchId, scope?.organizationId],
  );

  const refresh = useCallback(
    async (refreshOptions: { force?: boolean } = {}) => {
      if (!scope?.organizationId) {
        setSalaryRows([]);
        setStaffRows([]);
        setLoading(false);
        return;
      }

      // Cancel whatever this instance's previous request was still doing —
      // its result is about to be superseded either way.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Guard against out-of-order responses (StrictMode's double mount
      // effect, or a mark-paid/pending refresh racing an earlier in-flight
      // refresh). Only the most recently *started* request may write state —
      // an older response arriving late must never overwrite a newer one.
      const requestId = ++requestIdRef.current;

      try {
        setRefreshing(true);
        setError(null);
        const { periodStart, periodEnd } = monthToPeriod(options.month);
        const key = payrollCacheKey(
          scope.organizationId,
          scope.apiBranchId,
          periodStart,
          periodEnd,
          resolvedPeopleType,
        );
        const rows = await loadPayrollPageCached(
          key,
          () =>
            fetchPayrollPage(
              periodStart,
              periodEnd,
              controller.signal,
              resolvedPeopleType,
            ),
          refreshOptions.force,
        );

        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        setSalaryRows(rows);
        setStaffRows(rows);
      } catch (err) {
        // Superseded by a newer request from this same instance — not a
        // real failure, so don't surface an error or clear good data.
        if (controller.signal.aborted) return;
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        setError(
          err instanceof Error ? err.message : "Failed to load payroll data.",
        );
        setSalaryRows([]);
        setStaffRows([]);
      } finally {
        if (!mountedRef.current) return;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [
      fetchPayrollPage,
      options.month,
      resolvedPeopleType,
      scope?.apiBranchId,
      scope?.organizationId,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!options.autoRefresh) return undefined;
    const id = window.setInterval(
      () => void refresh(),
      Math.max(10_000, options.refreshMs ?? 30_000),
    );
    return () => window.clearInterval(id);
  }, [options.autoRefresh, options.refreshMs, refresh]);

  // Org/branch-default OT rate, used as the fallback whenever a staff
  // member has no per-staff override — same source PayrollModule.tsx
  // reads for the Payroll Rules modal, kept as one input to
  // normalizePayrollRow rather than re-derived per row.
  const orgDefaultOtRate = numberValue(cfg.payrollPolicy?.otRatePerHour);

  const rows = useMemo<PayrollRow[]>(() => {
    const staffById = new Map<string, AnyRecord>();
    staffRows.forEach((staff) => {
      const id = staffIdentity(staff);
      if (id) staffById.set(id, staff);
    });

    const sourceRows =
      salaryRows.length > 0
        ? salaryRows
        : buildStaffFallbackPayrollRows(staffRows);

    const normalizedRows = uniquePayrollRows(
      sourceRows.map((row) =>
        normalizePayrollRow(
          row,
          staffById,
          cfg.branches as AnyRecord[],
          orgDefaultOtRate,
        ),
      ),
    );

    // stats/deptSummary below derive from this already-scoped list, so
    // they never need a second, separate filter pass.
    //
    // Always filter by resolvedPeopleType — never bypass just because
    // modulePeopleTypes came back empty (e.g. entitlements not loaded yet,
    // or a transient reload of org config). resolvedPeopleType itself
    // already has a safe default ("staff") for that exact case; skipping
    // the filter here would silently show every people type (workers
    // included) the moment that happens, even though the selector still
    // reads "Staff" — which is exactly the bug this guarded against
    // failing safe for.
    return normalizedRows.filter(
      (row) => row.peopleType === resolvedPeopleType,
    );
  }, [
    cfg.branches,
    modulePeopleTypes,
    orgDefaultOtRate,
    resolvedPeopleType,
    salaryRows,
    staffRows,
  ]);

  const stats = useMemo<PayrollStats>(() => {
    if (!rows.length) return EMPTY_STATS;
    return {
      totalPayout: rows.reduce((sum, row) => sum + row.netPay, 0),
      totalOT: rows.reduce((sum, row) => sum + row.overtimeAmount, 0),
      totalStaff: rows.length,
      status: rows.some((row) => row.status !== "Paid") ? "Pending" : "Paid",
    };
  }, [rows]);

  const deptSummary = useMemo<DepartmentPayrollSummary[]>(() => {
    const totals = new Map<string, number>();
    rows.forEach((row) => {
      const dept = row.department || "General";
      totals.set(dept, (totals.get(dept) ?? 0) + row.netPay);
    });
    return Array.from(totals.entries()).map(([name, total]) => ({
      name,
      total,
    }));
  }, [rows]);

  const updateBaseSalary = useCallback(
    async (
      staffId: PayrollId,
      nextBaseSalary: number,
      effectiveFrom?: string | null,
      overrides?: SalaryOverrides,
    ) => {
      if (!scope?.organizationId)
        throw new Error("organization_id is required for payroll.");
      await saveSalaryConfig(staffId, {
        basicSalary: Number(nextBaseSalary || 0),
        // Only forward keys the caller actually passed — an omitted key
        // reaches saveSalaryConfig as `undefined` and is dropped from the
        // request body entirely, so the backend's merge-safe upsert leaves
        // that column as-is instead of zeroing it (see payrollApi.ts).
        ...(overrides?.allowances !== undefined
          ? { allowances: Number(overrides.allowances || 0) }
          : {}),
        ...(overrides?.deductions !== undefined
          ? { deductions: Number(overrides.deductions || 0) }
          : {}),
        ...(overrides?.otRate !== undefined
          ? { otRate: Number(overrides.otRate || 0) }
          : {}),
        // appliedAllowances is a whole-object replace when present — the
        // edit modal always sends its complete current checklist selection,
        // never a partial patch of the map (see SalaryOverrides doc above).
        ...(overrides?.appliedAllowances !== undefined
          ? { appliedAllowances: overrides.appliedAllowances }
          : {}),
        // effective_from is a `date` column on salary_configs — it must be
        // a real calendar date (YYYY-MM-DD), never the "YYYY-MM" shape used
        // elsewhere for report-period filters (that shape throws a Postgres
        // 22007 invalid-date-syntax error). Defaults to today, i.e. "this
        // edit took effect today" — not the period currently being viewed,
        // which would misdate the change whenever an admin edits salary
        // while looking at a past or future month's report.
        effectiveFrom: effectiveFrom ?? todayDateString(),
        organizationId: scope.organizationId,
        branchId: scope.apiBranchId,
      });
      // A salary edit changes the row's whole breakdown (per-day rate, every
      // deduction derived from it), not just one field — unlike markPaid/
      // markPending there's no single value to patch in optimistically, so
      // this still waits on the real page refetch. force:true so that
      // refetch isn't served the pre-write cache.
      invalidatePayrollPageCache(scope.organizationId);
      await refresh({ force: true });
    },
    [refresh, scope?.apiBranchId, scope?.organizationId],
  );

  // Optimistically flip a single row's status in local state, returning a
  // rollback closure that restores whatever the row's previous status was.
  // Used by markPaid/markPending so the UI reflects the change the instant
  // the mutation call resolves, instead of waiting on a full 250-row
  // refetch just to see one status flip.
  const setRowStatusOptimistically = useCallback(
    (staffId: PayrollId, nextStatus: "Paid" | "Pending") => {
      const key = cleanId(staffId);
      let previousStatus: unknown;
      let matched = false;
      setSalaryRows((current) =>
        current.map((row) => {
          if (staffIdentity(row) !== key) return row;
          matched = true;
          previousStatus = row.status;
          return { ...row, status: nextStatus };
        }),
      );
      return () => {
        if (!matched) return;
        setSalaryRows((current) =>
          current.map((row) =>
            staffIdentity(row) === key
              ? { ...row, status: previousStatus }
              : row,
          ),
        );
      };
    },
    [],
  );

  const markPaid = useCallback(
    async (staffId: PayrollId) => {
      if (!scope?.organizationId)
        throw new Error("organization_id is required for payroll.");
      const { periodStart, periodEnd } = monthToPeriod(options.month);
      if (!periodStart || !periodEnd)
        throw new Error("A pay period is required to mark payroll as paid.");

      const rollback = setRowStatusOptimistically(staffId, "Paid");
      try {
        await markPayrollPaid(
          scope.organizationId,
          staffId,
          periodStart,
          periodEnd,
        );
      } catch (err) {
        rollback();
        throw err;
      }
      // The mutation is the source of truth for whoever's waiting on this
      // call; the full page resync below is a background reconciliation
      // (picks up anything else a real refetch would surface) and isn't
      // awaited, so it can't add a 250-row round trip to markPaid's own
      // latency. force:true so it doesn't just re-serve the pre-write cache.
      invalidatePayrollPageCache(scope.organizationId);
      void refresh({ force: true });
    },
    [options.month, refresh, scope?.organizationId, setRowStatusOptimistically],
  );

  const markPending = useCallback(
    async (staffId: PayrollId) => {
      if (!scope?.organizationId)
        throw new Error("organization_id is required for payroll.");
      const { periodStart, periodEnd } = monthToPeriod(options.month);
      if (!periodStart || !periodEnd)
        throw new Error("A pay period is required to mark payroll as pending.");

      const rollback = setRowStatusOptimistically(staffId, "Pending");
      try {
        await markPayrollPending(
          scope.organizationId,
          staffId,
          periodStart,
          periodEnd,
        );
      } catch (err) {
        rollback();
        throw err;
      }
      invalidatePayrollPageCache(scope.organizationId);
      void refresh({ force: true });
    },
    [options.month, refresh, scope?.organizationId, setRowStatusOptimistically],
  );

  return {
    rows,
    stats,
    deptSummary,
    modulePeopleTypes,
    peopleType: resolvedPeopleType,
    loading,
    refreshing,
    error,
    refresh,
    refetch: refresh,
    reload: refresh,
    updateBaseSalary,
    markPaid,
    markPending,
  };
}

export default usePayrollData;