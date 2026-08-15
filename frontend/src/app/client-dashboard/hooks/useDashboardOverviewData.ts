/**
 * useDashboardOverviewData.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Dashboard Overview snapshot adapter.
 *
 * Performance contract:
 *   Dashboard Overview makes one tenant-scoped request only:
 *   /api/v2/dashboard/overview
 *
 * Module pages still use their own paginated APIs, but overview cards/charts no
 * longer mount separate attendance, payroll, leave, CCTV, and staff fetch hooks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg, type CctvDevice } from "../contexts/OrgConfigContext";
import { resolveTenantScope } from "../utils/tenantScope";

export type { CctvDevice };

type LooseRecord = Record<string, unknown>;

export type DashboardScope = "global" | "branch";
export type AttendanceStatus = "Present" | "Absent" | "Late";

export interface UseDashboardOverviewDataArgs {
  scope: DashboardScope;
  branchId?: number | string | null;
  selectedBranchId?: number | string | null;
  /** Business/template attendance scope, for example student, staff, worker. */
  peopleType?: string | null;
  /**
   * Display-preference hint for a 'branch'-scoped manager who also has
   * direct reports: 'team' asks the backend to voluntarily narrow the
   * response to this caller's own subordinate tree (safe — the backend
   * always resolves the id set from the caller's own verified identity,
   * never from anything sent here). Omit/undefined or 'branch' means the
   * caller's normal (unrestricted, within their org/branch token) view.
   * Has no effect for a dashboard_scope='team' account — the backend
   * enforces that restriction unconditionally regardless of this value.
   */
  teamView?: "team" | "branch" | null;
}

export interface DashboardLiveLogItem {
  id: string;
  name: string;
  department: string;
  branchName: string;
  status: AttendanceStatus;
  time: string;
}

export interface ShiftMemberItem {
  id: string;
  name: string;
  department: string;
  position: string;
  branchId: number;
  branchName: string;
}

export interface ShiftDepartmentGroup {
  name: string;
  count: number;
  members?: ShiftMemberItem[];
}

export interface ShiftBranchGroup {
  branchId: number;
  branchName: string;
  city?: string;
  staffCount: number;
  departments: ShiftDepartmentGroup[];
}

export interface ShiftDistributionItem {
  key: string;
  label: string;
  time: string;
  staffCount: number;
  departments: { name: string; count: number }[];
  branches: ShiftBranchGroup[];
  members: ShiftMemberItem[];
}

export interface TodayStatusItem {
  name: AttendanceStatus;
  value: number;
}

export interface WeeklyAttendanceItem {
  day: string;
  count: number;
  branchId?: number;
  branchName?: string;
}

export interface BranchWeeklySeries {
  branchId: number;
  branchName: string;
  data: WeeklyAttendanceItem[];
}

export interface AttendancePerformanceItem {
  month: string;
  "On Time": number;
  Late: number;
  Absent: number;
}

export interface BranchAttendanceSeries {
  branchId: number;
  branchName: string;
  avgAttendance: number;
  data: AttendancePerformanceItem[];
}

export interface PayrollTrendItem {
  month: string;
  Payroll: number;
  Overtime: number;
}

export interface BranchPayrollSeries {
  branchId: number;
  branchName: string;
  totalPayroll: number;
  data: PayrollTrendItem[];
}

export type PendingLeaveStatus = "Pending" | "Approved" | "Rejected";

export interface PendingLeaveItem {
  id: string;
  name: string;
  dept: string;
  department?: string;
  branchName: string;
  type: string;
  days: number;
  status?: PendingLeaveStatus;
  metaText?: string;
}

export interface BranchPerformanceItem {
  branchId: number;
  branchName: string;
  city?: string;
  totalStaff: number;
  presentToday: number;
  absentToday: number;
  avgAttendance: number;
  lateToday: number;
  payroll: number;
  cctvAlerts: number;
}

export interface DashboardOverviewStats {
  totalBranches: number;
  totalStaff: number;
  presentToday: number;
  absentToday: number;
  avgAttendance: number;
  lateToday: number;
  earlyLeft: number;
  pendingLeaves: number;
  monthlyPayroll: number;
  cctvAlerts: number;
}

export interface DashboardOverviewData {
  scope: DashboardScope;
  peopleType?: string | null;
  branchId?: number | string;
  branchName?: string;
  branchCity?: string;
  title: string;
  subtitle: string;

  globalFilterBranchId?: number | string;
  selectedBranchId?: number | string;
  selectedBranchName?: string;
  branchFilterOptions: { id: number; name: string }[];

  stats: DashboardOverviewStats;

  staff: LooseRecord[];
  liveLog: DashboardLiveLogItem[];
  shiftDistribution: ShiftDistributionItem[];
  todayStatus: TodayStatusItem[];

  weeklyAttendance: WeeklyAttendanceItem[];
  branchWeeklyAttendance: BranchWeeklySeries[];

  pendingLeaves: PendingLeaveItem[];
  cctvStatus: CctvDevice[];

  attendancePerformance: AttendancePerformanceItem[];
  branchAttendancePerformance: BranchAttendanceSeries[];

  payrollTrends: PayrollTrendItem[];
  branchPayrollTrends: BranchPayrollSeries[];

  branchPerformance: BranchPerformanceItem[];

  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  refresh?: () => Promise<void>;
  refetch?: () => Promise<void>;
  reload?: () => Promise<void>;
}

const SNAPSHOT_CACHE_TTL_MS = 5_000;

type CachedSnapshot = {
  expiresAt: number;
  data: DashboardOverviewData;
};

const snapshotCache = new Map<string, CachedSnapshot>();
const snapshotInflight = new Map<string, Promise<DashboardOverviewData>>();

const EMPTY_STATS: DashboardOverviewStats = {
  totalBranches: 0,
  totalStaff: 0,
  presentToday: 0,
  absentToday: 0,
  avgAttendance: 0,
  lateToday: 0,
  earlyLeft: 0,
  pendingLeaves: 0,
  monthlyPayroll: 0,
  cctvAlerts: 0,
};

const DEFAULT_STATUS: TodayStatusItem[] = [
  { name: "Present", value: 0 },
  { name: "Late", value: 0 },
  { name: "Absent", value: 0 },
];

// No hardcoded placeholder shifts. Shift distribution must always reflect
// the branch's actual configured shifts (see api_v2_dashboard_overview /
// get_fast_dashboard_overview on the backend) — an empty array here means
// either "not loaded yet" or "this branch has no shifts configured", and
// ShiftDistributionCard / showShiftDistribution already render that
// correctly as an empty state rather than needing fake rows to fall back to.
const DEFAULT_SHIFTS: ShiftDistributionItem[] = [];

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, fallback = ""): string {
  const raw = String(value ?? "").trim();
  return raw || fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toLooseRecords(value: readonly unknown[]): LooseRecord[] {
  return value.filter(isRecord);
}

function normalizePendingLeaveStatus(value: unknown): PendingLeaveStatus {
  const raw = String(value ?? "pending")
    .trim()
    .toLowerCase();
  if (raw === "approved") return "Approved";
  if (raw === "rejected") return "Rejected";
  return "Pending";
}

function normalizePendingLeaves(value: unknown): PendingLeaveItem[] {
  return asArray<unknown>(value)
    .filter(isRecord)
    .map((item, index) => {
      const name = text(
        item.name ?? item.staffName ?? item.staff_name,
        "Unknown Employee",
      );
      const dept = text(
        item.dept ??
          item.department ??
          item.departmentName ??
          item.department_name,
        "General",
      );
      const branchName = text(
        item.branchName ?? item.branch_name,
        "Main Branch",
      );
      const type = text(
        item.type ?? item.leaveType ?? item.leave_type,
        "Leave",
      );
      const days = numberValue(
        item.days ?? item.durationDays ?? item.duration_days,
        0,
      );
      const metaText = text(item.metaText ?? item.meta_text);

      return {
        id: text(item.id, `leave-${index}`),
        name,
        dept,
        department: dept,
        branchName,
        type,
        days,
        status: normalizePendingLeaveStatus(item.status),
        ...(metaText ? { metaText } : {}),
      };
    });
}

function branchOptionsFromConfig(
  branches: LooseRecord[],
): { id: number; name: string }[] {
  return branches.map((branch, index) => ({
    id: numberValue(branch.id, index + 1),
    name: text(branch.name, `Branch ${index + 1}`),
  }));
}

function fallbackData(
  scope: DashboardScope,
  branches: LooseRecord[],
  selectedBranchId?: number | string | null,
): DashboardOverviewData {
  const branchOptions = branchOptionsFromConfig(branches);
  const selected = branchOptions.find(
    (branch) => String(branch.id) === String(selectedBranchId ?? ""),
  );
  const nowText = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return {
    scope,
    peopleType: null,
    branchId: selected?.id,
    branchName: selected?.name,
    title: scope === "global" ? "Organization Overview" : "Attendance Overview",
    subtitle:
      scope === "global"
        ? `All Branches · ${branchOptions.length} branches · ${nowText}`
        : `${selected?.name ?? "Branch"} · ${nowText}`,
    globalFilterBranchId: selected?.id,
    selectedBranchId: selected?.id,
    selectedBranchName: selected?.name,
    branchFilterOptions: branchOptions,
    stats: { ...EMPTY_STATS, totalBranches: branchOptions.length },
    staff: [],
    liveLog: [],
    shiftDistribution: DEFAULT_SHIFTS,
    todayStatus: DEFAULT_STATUS,
    weeklyAttendance: [],
    branchWeeklyAttendance: [],
    pendingLeaves: [],
    cctvStatus: [],
    attendancePerformance: [],
    branchAttendancePerformance: [],
    payrollTrends: [],
    branchPayrollTrends: [],
    branchPerformance: [],
  };
}

function normalizeStats(value: unknown): DashboardOverviewStats {
  const raw = isRecord(value) ? value : {};
  return {
    totalBranches: numberValue(raw.totalBranches ?? raw.total_branches),
    totalStaff: numberValue(raw.totalStaff ?? raw.total_staff),
    presentToday: numberValue(raw.presentToday ?? raw.present_today),
    absentToday: numberValue(raw.absentToday ?? raw.absent_today),
    avgAttendance: numberValue(
      raw.avgAttendance ??
        raw.avg_attendance ??
        raw.attendanceRate ??
        raw.attendance_rate,
    ),
    lateToday: numberValue(raw.lateToday ?? raw.late_today),
    earlyLeft: numberValue(raw.earlyLeft ?? raw.early_left),
    pendingLeaves: numberValue(raw.pendingLeaves ?? raw.pending_leaves),
    monthlyPayroll: numberValue(raw.monthlyPayroll ?? raw.monthly_payroll),
    cctvAlerts: numberValue(raw.cctvAlerts ?? raw.cctv_alerts),
  };
}

function normalizeSnapshot(
  rawPayload: unknown,
  fallback: DashboardOverviewData,
): DashboardOverviewData {
  const raw = isRecord(rawPayload) ? rawPayload : {};
  const stats = normalizeStats(raw.stats);

  return {
    ...fallback,
    scope: text(raw.scope, fallback.scope) as DashboardScope,
    peopleType:
      text(raw.peopleType ?? raw.people_type, fallback.peopleType ?? "") ||
      null,
    branchId: (raw.branchId ?? raw.branch_id ?? fallback.branchId) as
      | number
      | string
      | undefined,
    branchName: text(raw.branchName ?? raw.branch_name, fallback.branchName),
    branchCity: text(raw.branchCity ?? raw.branch_city, fallback.branchCity),
    title: text(raw.title, fallback.title),
    subtitle: text(raw.subtitle, fallback.subtitle),
    globalFilterBranchId: (raw.globalFilterBranchId ??
      raw.global_filter_branch_id ??
      fallback.globalFilterBranchId) as number | string | undefined,
    selectedBranchId: (raw.selectedBranchId ??
      raw.selected_branch_id ??
      fallback.selectedBranchId) as number | string | undefined,
    selectedBranchName: text(
      raw.selectedBranchName ?? raw.selected_branch_name,
      fallback.selectedBranchName,
    ),
    branchFilterOptions: asArray<{ id: number; name: string }>(
      raw.branchFilterOptions ?? raw.branch_filter_options,
    ).length
      ? asArray<{ id: number; name: string }>(
          raw.branchFilterOptions ?? raw.branch_filter_options,
        )
      : fallback.branchFilterOptions,
    stats: {
      ...stats,
      totalBranches: stats.totalBranches || fallback.stats.totalBranches,
      absentToday: Math.max(0, stats.absentToday),
    },
    staff: asArray<LooseRecord>(raw.staff),
    liveLog: asArray<DashboardLiveLogItem>(raw.liveLog ?? raw.live_log),
    shiftDistribution: asArray<ShiftDistributionItem>(
      raw.shiftDistribution ?? raw.shift_distribution,
    ).length
      ? asArray<ShiftDistributionItem>(
          raw.shiftDistribution ?? raw.shift_distribution,
        )
      : fallback.shiftDistribution,
    todayStatus: asArray<TodayStatusItem>(raw.todayStatus ?? raw.today_status)
      .length
      ? asArray<TodayStatusItem>(raw.todayStatus ?? raw.today_status)
      : [
          { name: "Present", value: stats.presentToday },
          { name: "Late", value: stats.lateToday },
          { name: "Absent", value: stats.absentToday },
        ],
    weeklyAttendance: asArray<WeeklyAttendanceItem>(
      raw.weeklyAttendance ?? raw.weekly_attendance,
    ),
    branchWeeklyAttendance: asArray<BranchWeeklySeries>(
      raw.branchWeeklyAttendance ?? raw.branch_weekly_attendance,
    ),
    pendingLeaves: normalizePendingLeaves(
      raw.pendingLeaves ?? raw.pending_leaves,
    ),
    cctvStatus: asArray<CctvDevice>(raw.cctvStatus ?? raw.cctv_status),
    attendancePerformance: asArray<AttendancePerformanceItem>(
      raw.attendancePerformance ?? raw.attendance_performance,
    ),
    branchAttendancePerformance: asArray<BranchAttendanceSeries>(
      raw.branchAttendancePerformance ?? raw.branch_attendance_performance,
    ),
    payrollTrends: asArray<PayrollTrendItem>(
      raw.payrollTrends ?? raw.payroll_trends,
    ),
    branchPayrollTrends: asArray<BranchPayrollSeries>(
      raw.branchPayrollTrends ?? raw.branch_payroll_trends,
    ),
    branchPerformance: asArray<BranchPerformanceItem>(
      raw.branchPerformance ?? raw.branch_performance,
    ),
  };
}

// Same duplication reasoning noted in BranchOverviewTab.tsx/
// DashboardOverviewTab.tsx re: the dashboardAuthToken constant repeated
// across api.ts/apiClient.ts/leaveApi.ts. Every /api/v2/* route this hook
// calls is now behind @require_client_dashboard_auth (see app.py), so a
// request with no Authorization header 401s — this hook was the one
// remaining caller still doing a bare, unauthenticated fetch().
//
// NOTE: verify "dashboardAuthToken" below against the exact literal key
// api.ts/apiClient.ts write to localStorage with — those files weren't
// available to check directly. If they wrap it in a helper instead of a
// raw localStorage key, swap this for that helper so there's one source
// of truth, not a third copy of the same string.
function dashboardAuthHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem("dashboardAuthToken");
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function fetchSnapshot(
  cacheKey: string,
  url: string,
  fallback: DashboardOverviewData,
  force = false,
): Promise<DashboardOverviewData> {
  const cached = snapshotCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  if (!force) {
    const existing = snapshotInflight.get(cacheKey);
    if (existing) return existing;
  }

  const promise = fetch(url, {
    headers: { Accept: "application/json", ...dashboardAuthHeaders() },
  })
    .then(async (res) => {
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.success === false) {
        throw new Error(
          text(
            payload?.message ?? payload?.error,
            `Dashboard overview failed (${res.status})`,
          ),
        );
      }
      const data = normalizeSnapshot(payload, fallback);
      snapshotCache.set(cacheKey, {
        expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS,
        data,
      });
      return data;
    })
    .finally(() => {
      snapshotInflight.delete(cacheKey);
    });

  snapshotInflight.set(cacheKey, promise);
  return promise;
}

export function useDashboardOverviewData({
  scope,
  branchId,
  selectedBranchId,
  peopleType,
  teamView,
}: UseDashboardOverviewDataArgs): DashboardOverviewData {
  const { cfg, organizationId } = useOrg();
  const mountedRef = useRef(true);
  const requestedBranchId = scope === "branch" ? branchId : selectedBranchId;
  const normalizedPeopleType = String(peopleType ?? "")
    .trim()
    .toLowerCase();
  const normalizedTeamView = teamView === "team" ? "team" : null;

  const resolvedScope = useMemo(() => {
    if (!organizationId) return null;
    return resolveTenantScope(
      { organizationId, branchId: requestedBranchId ?? undefined },
      cfg.branches,
    );
  }, [cfg.branches, organizationId, requestedBranchId]);

  const fallback = useMemo(
    () => fallbackData(scope, toLooseRecords(cfg.branches), requestedBranchId),
    [cfg.branches, requestedBranchId, scope],
  );

  const [data, setData] = useState<DashboardOverviewData>(fallback);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestUrl = useMemo(() => {
    if (!resolvedScope?.organizationId) return null;
    const params = new URLSearchParams();
    params.set("organization_id", String(resolvedScope.organizationId));
    params.set("scope", scope);
    params.set("days", "7");
    const apiBranchId = resolvedScope.apiBranchId;
    if (apiBranchId) params.set("branch_id", String(apiBranchId));
    if (normalizedPeopleType) params.set("people_type", normalizedPeopleType);
    if (normalizedTeamView) params.set("view", normalizedTeamView);
    return `/api/v2/dashboard/overview?${params.toString()}`;
  }, [
    normalizedPeopleType,
    normalizedTeamView,
    resolvedScope?.apiBranchId,
    resolvedScope?.organizationId,
    scope,
  ]);

  const cacheKey = useMemo(
    () =>
      `${resolvedScope?.organizationId ?? "no-org"}|${resolvedScope?.apiBranchId ?? "all"}|${scope}|${normalizedPeopleType || "all-people"}|${normalizedTeamView || "unscoped-view"}`,
    [
      normalizedPeopleType,
      normalizedTeamView,
      resolvedScope?.apiBranchId,
      resolvedScope?.organizationId,
      scope,
    ],
  );

  const load = useCallback(
    async (force = false) => {
      if (!requestUrl || !resolvedScope?.organizationId) {
        setData(fallback);
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const cached = snapshotCache.get(cacheKey);
      if (!force && cached && cached.expiresAt > Date.now()) {
        setData(cached.data);
        setLoading(false);
        setRefreshing(false);
        setError(null);
        return;
      }

      try {
        if (force) setRefreshing(true);
        else setLoading((current) => current && !data);
        setError(null);
        const next = await fetchSnapshot(cacheKey, requestUrl, fallback, force);
        if (!mountedRef.current) return;
        setData(next);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load dashboard overview.",
        );
      } finally {
        if (!mountedRef.current) return;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [cacheKey, data, fallback, requestUrl, resolvedScope?.organizationId],
  );

  useEffect(() => {
    mountedRef.current = true;
    void load(false);
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    await load(true);
  }, [load]);

  return {
    ...(data ?? fallback),
    loading,
    refreshing,
    error,
    refresh,
    refetch: refresh,
    reload: refresh,
  };
}

export default useDashboardOverviewData;
