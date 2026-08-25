/**
 * useReportMetrics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Reports metric adapter.
 *
 * Single source of truth:
 * - staff/payroll/leave from ModuleContext stores passed by Reports
 * - attendance from useAttendanceData (Supabase/Flask tenant source)
 *
 * The hook keeps the existing Reports page contract but makes the calculations
 * UUID-safe by matching both UI branch ids and backend branch UUIDs.
 */

import { useMemo } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { useAttendanceData } from "../../attendance_temp/hooks/useAttendanceData";
import { normalizePeopleType } from "../../../utils/templateRendering";
import { getDatesBetween, type DateRange } from "../../../hooks/useDateFilter";
import {
  branchIdentityValues,
  cleanId,
  getUiBranchId,
  resolveTenantScope,
} from "../../../utils/tenantScope";

export type { DateRange };

type AnyRecord = Record<string, any>;

export interface ReportMetricRow {
  branchId: number;
  backendBranchId?: string | null;
  branchName: string;
  department: string;
  totalStaff: number;
  present: number;
  absent: number;
  late: number;
  attendanceRate: number;
  monthlyPayroll: number;
  pendingLeaves: number;
}

export interface ReportTotals {
  totalStaff: number;
  present: number;
  attended: number;
  absent: number;
  late: number;
  attendanceRate: number;
  monthlyPayroll: number;
  pendingLeaves: number;
}

export interface ReportTrendRow {
  label: string;
  attendance: number;
  [key: string]: string | number;
}

export interface UseReportMetricsInput {
  staff: unknown[];
  leave: unknown[];
  payroll: unknown[];
  activeBranchId: number | string | null;
  allBranches: AnyRecord[];
  branchLookup: Map<number, string>;
  branchFilter: string;
  /** "all" (default) or a specific people type, e.g. "student". */
  peopleType?: string;
  /**
   * Real, unbounded start/end date ("YYYY-MM-DD", inclusive) — same shape
   * `useDateFilter` produces for Attendance/Payroll/LeaveManagement. Replaces
   * the old fixed "today"/"7d"/"30d"/"month"/"all" bucket, which silently
   * capped every report (including "All Time") to at most 7-14 days of
   * trend data with no way for the caller to ask for more.
   */
  dateRange: DateRange;
  isGlobalDashboard: boolean;
}

export interface UseReportMetricsReturn {
  branchMetrics: ReportMetricRow[];
  departmentMetrics: ReportMetricRow[];
  totals: ReportTotals;
  trendData: ReportTrendRow[];
  branchTrendData: ReportTrendRow[];
  isAllBranchAdmin: boolean;
  selectedBranchLabel: string;
}

function toArray(value: unknown[]): AnyRecord[] {
  return (Array.isArray(value) ? value : []).filter(Boolean) as AnyRecord[];
}

function staffIdentity(row: AnyRecord): string {
  return cleanId(
    row.staffId ?? row.staff_id ?? row.userId ?? row.user_id ?? row.id,
  );
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
  const keys = new Set(rowBranchKeys(row));
  return (
    branches.find((branch) =>
      branchIdentityValues(branch).some((key) => keys.has(key)),
    ) ?? null
  );
}

function uiBranchIdForRow(
  row: AnyRecord,
  branches: AnyRecord[],
): number | null {
  const branch = branchForRow(row, branches);
  const fromBranch = getUiBranchId(branch);
  if (fromBranch !== null) return fromBranch;
  const raw = Number(
    row.branchId ?? row.branch_id ?? row.branchUiId ?? row.branch_ui_id,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function branchName(branch: AnyRecord, fallbackId: number): string {
  return String(
    branch.name ??
      branch.branchName ??
      branch.branch_name ??
      `Branch ${fallbackId}`,
  );
}

function rowPeopleType(row: AnyRecord): string {
  return normalizePeopleType(
    row.peopleType ?? row.people_type ?? row.personType ?? row.person_type,
  );
}

function departmentOf(row: AnyRecord): string {
  return (
    String(row.department ?? row.department_name ?? row.dept ?? "General") ||
    "General"
  );
}

function payrollStaffId(row: AnyRecord): string {
  return cleanId(
    row.staffId ??
      row.staff_id ??
      row.userId ??
      row.user_id ??
      row.client_staff_id ??
      row.id,
  );
}

function payrollValue(row: AnyRecord): number {
  const value = Number(
    row.netPay ??
      row.net_pay ??
      row.amount ??
      row.salary ??
      row.basicSalary ??
      row.basic_salary ??
      0,
  );
  return Number.isFinite(value) ? value : 0;
}

function leaveIsPending(row: AnyRecord): boolean {
  return (
    String(row.status ?? "pending")
      .trim()
      .toLowerCase() === "pending"
  );
}

function dateKey(row: AnyRecord): string {
  return cleanId(
    row.logDate ??
      row.log_date ??
      row.timestamp ??
      row.checkIn ??
      row.check_in ??
      row.createdAt ??
      row.created_at,
  ).slice(0, 10);
}

/**
 * Number of daily buckets above which the trend chart switches from
 * one-bar-per-day to one-bar-per-week. This is purely a chart-legibility
 * decision (nobody can read 365 daily bars) — it does NOT limit which days'
 * data feed into the bucket, or the totals/export rows below, which always
 * cover the full selected range. This is what makes a quarterly/annual
 * report actually usable, replacing the old hard 7/14-day cap that dropped
 * data outside that window entirely.
 */
const DAILY_BUCKET_THRESHOLD_DAYS = 60;

interface TrendBucket {
  label: string;
  /** Every "YYYY-MM-DD" day-key that rolls up into this bucket. */
  keys: string[];
}

/**
 * rangeTrendBuckets — one bucket per day (short ranges) or per ISO week
 * (long ranges), spanning the *entire* selected date range.
 *
 * Reuses `getDatesBetween` from useDateFilter.ts (the same date-math
 * Attendance/Payroll/LeaveManagement already rely on) instead of
 * reimplementing day-iteration here — one source of truth for "what are
 * the days in this range".
 */
function rangeTrendBuckets(range: DateRange): TrendBucket[] {
  const dates = getDatesBetween(range.startDate, range.endDate);
  if (dates.length === 0) return [];

  if (dates.length <= DAILY_BUCKET_THRESHOLD_DAYS) {
    const formatter = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "2-digit",
    });
    return dates.map((key) => ({
      label: formatter.format(new Date(`${key}T00:00:00`)),
      keys: [key],
    }));
  }

  const weekFormatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
  });
  const buckets: TrendBucket[] = [];
  for (let i = 0; i < dates.length; i += 7) {
    const week = dates.slice(i, i + 7);
    buckets.push({
      label: `Week of ${weekFormatter.format(new Date(`${week[0]}T00:00:00`))}`,
      keys: week,
    });
  }
  return buckets;
}

function buildMetricRow(
  branchId: number,
  backendBranchId: string | null,
  branchNameValue: string,
  department: string,
  totalStaff: number,
  present: number,
  late: number,
  monthlyPayroll: number,
  pendingLeaves: number,
): ReportMetricRow {
  const absent = Math.max(0, totalStaff - present);
  return {
    branchId,
    backendBranchId,
    branchName: branchNameValue,
    department,
    totalStaff,
    present,
    absent,
    late,
    attendanceRate:
      totalStaff > 0 ? Math.round((present / totalStaff) * 100) : 0,
    monthlyPayroll,
    pendingLeaves,
  };
}

export function useReportMetrics(
  input: UseReportMetricsInput,
): UseReportMetricsReturn {
  const { cfg, organizationId } = useOrg();
  const branchFilterValue =
    input.isGlobalDashboard && input.branchFilter !== "all"
      ? input.branchFilter
      : input.activeBranchId;

  const scope = useMemo(() => {
    if (!organizationId) return null;
    return resolveTenantScope(
      { organizationId, branchId: branchFilterValue },
      cfg.branches,
    );
  }, [branchFilterValue, cfg.branches, organizationId]);

  // "all" means no separation requested — undefined so the backend's own
  // attendance_people_types default applies, same convention as branchFilter.
  const peopleTypeKey =
    input.peopleType && input.peopleType !== "all"
      ? normalizePeopleType(input.peopleType)
      : undefined;

  // Fetch volume scales with the selected range instead of a fixed 3000-row
  // guess: a one-day view needs far fewer rows than a full year, and a very
  // large org's year view needs more than 3000. Bounded by the backend's own
  // ceiling (see support_db_attendance_dashboard.py's max_rows=20000).
  const rangeDayCount = useMemo(
    () => getDatesBetween(input.dateRange.startDate, input.dateRange.endDate).length,
    [input.dateRange.startDate, input.dateRange.endDate],
  );
  const logsLimit = useMemo(
    () => Math.min(20000, Math.max(3000, rangeDayCount * 200)),
    [rangeDayCount],
  );

  const attendance = useAttendanceData({
    organizationId: scope?.organizationId ?? organizationId ?? undefined,
    branchId: scope?.apiBranchId ?? undefined,
    peopleType: peopleTypeKey,
    start: input.dateRange.startDate,
    end: input.dateRange.endDate,
    logsLimit,
    autoRefresh: false,
  });

  return useMemo<UseReportMetricsReturn>(() => {
    const staffRows = toArray(input.staff).filter(
      (row) => !peopleTypeKey || rowPeopleType(row) === peopleTypeKey,
    );
    const leaveRows = toArray(input.leave).filter(
      (row) => !peopleTypeKey || rowPeopleType(row) === peopleTypeKey,
    );
    const payrollRows = toArray(input.payroll);
    // NOTE: `attendance.today` is intentionally not used here. Once a real
    // start/end range is passed to useAttendanceData (above), both
    // getAttendanceToday and getAttendanceLogs resolve to the exact same
    // Supabase rows (see _client_attendance_rows' today_only=False path in
    // support_db_attendance_dashboard.py) — summing both would double-count
    // every attendance row across the whole range, not just "today".
    // `attendance.logs` alone is the single source of truth for this hook.
    const attendanceLogs = toArray(attendance.logs as unknown as unknown[]);
    const rangeDates = getDatesBetween(
      input.dateRange.startDate,
      input.dateRange.endDate,
    );

    // presenceByDay: for every day in the selected range, the set of staff
    // ids with at least one attendance row that day. This is the single
    // building block every present/attendanceRate figure below is derived
    // from, so a branch/department/total figure over a 1-day range and a
    // 365-day range use the exact same logic — just averaged over more days.
    const presenceByDay = new Map<string, Set<string>>();
    rangeDates.forEach((day) => presenceByDay.set(day, new Set()));
    attendanceLogs.forEach((row) => {
      const day = dateKey(row);
      const bucket = presenceByDay.get(day);
      if (!bucket) return; // outside the requested range
      const id = staffIdentity(row);
      if (id) bucket.add(id);
    });

    /** Average number of `staffIds` present per day across the whole range. */
    function averagePresent(staffIds: Set<string>): number {
      if (rangeDates.length === 0 || staffIds.size === 0) return 0;
      let total = 0;
      presenceByDay.forEach((presentOnDay) => {
        presentOnDay.forEach((id) => {
          if (staffIds.has(id)) total += 1;
        });
      });
      return total / rangeDates.length;
    }

    const branches = (
      input.allBranches?.length ? input.allBranches : cfg.branches
    ) as AnyRecord[];

    const selectedUiBranch =
      scope?.uiBranchId ??
      (input.branchFilter !== "all" ? Number(input.branchFilter) : null);
    const useSingleBranch = Boolean(
      selectedUiBranch && Number.isFinite(selectedUiBranch),
    );

    const visibleBranches = useSingleBranch
      ? branches.filter((branch) => getUiBranchId(branch) === selectedUiBranch)
      : branches;

    const visibleBranchIds = new Set(
      visibleBranches
        .map((branch) => getUiBranchId(branch))
        .filter((id): id is number => id !== null),
    );

    const scopedStaff = staffRows.filter((row) => {
      if (!useSingleBranch) return true;
      const id = uiBranchIdForRow(row, branches);
      return id !== null && visibleBranchIds.has(id);
    });

    const staffById = new Map<string, AnyRecord>();
    scopedStaff.forEach((row) => {
      const id = staffIdentity(row);
      if (id) staffById.set(id, row);
    });

    const payrollByStaff = new Map<string, number>();
    payrollRows.forEach((row) => {
      const id = payrollStaffId(row);
      if (!id) return;
      if (useSingleBranch) {
        const branchId =
          uiBranchIdForRow(row, branches) ??
          uiBranchIdForRow(staffById.get(id) ?? {}, branches);
        if (branchId === null || !visibleBranchIds.has(branchId)) return;
      }
      payrollByStaff.set(
        id,
        Math.max(payrollByStaff.get(id) ?? 0, payrollValue(row)),
      );
    });

    const branchMetrics = visibleBranches.map((branch) => {
      const branchId = getUiBranchId(branch) ?? 0;
      const branchStaff = scopedStaff.filter(
        (row) => uiBranchIdForRow(row, branches) === branchId,
      );
      const branchStaffIds = new Set(
        branchStaff.map(staffIdentity).filter(Boolean),
      );
      const present = Math.round(averagePresent(branchStaffIds));
      const backendBranchId =
        cleanId(
          branch.backendBranchId ??
            branch.backend_branch_id ??
            branch.branchUuid ??
            branch.branch_uuid,
        ) || null;
      const monthlyPayroll = branchStaff.reduce((sum, row) => {
        const id = staffIdentity(row);
        return sum + (payrollByStaff.get(id) ?? Number(row.salary ?? 0) ?? 0);
      }, 0);
      const pendingLeaves = leaveRows.filter(
        (leave) =>
          leaveIsPending(leave) &&
          uiBranchIdForRow(leave, branches) === branchId,
      ).length;
      return buildMetricRow(
        branchId,
        backendBranchId,
        branchName(branch, branchId),
        "All Departments",
        branchStaff.length,
        present,
        0,
        monthlyPayroll,
        pendingLeaves,
      );
    });

    const departmentBucket = new Map<
      string,
      {
        branchId: number;
        branchName: string;
        department: string;
        staff: AnyRecord[];
      }
    >();
    scopedStaff.forEach((row) => {
      const branchId = uiBranchIdForRow(row, branches) ?? 0;
      const branch = branches.find((item) => getUiBranchId(item) === branchId);
      const dept = departmentOf(row);
      const key = `${branchId}:${dept}`;
      if (!departmentBucket.has(key)) {
        departmentBucket.set(key, {
          branchId,
          branchName: branch
            ? branchName(branch, branchId)
            : `Branch ${branchId}`,
          department: dept,
          staff: [],
        });
      }
      departmentBucket.get(key)?.staff.push(row);
    });

    const departmentMetrics = Array.from(departmentBucket.values()).map(
      (bucket) => {
        const staffIds = new Set(
          bucket.staff.map(staffIdentity).filter(Boolean),
        );
        const present = Math.round(averagePresent(staffIds));
        const monthlyPayroll = bucket.staff.reduce((sum, row) => {
          const id = staffIdentity(row);
          return sum + (payrollByStaff.get(id) ?? Number(row.salary ?? 0) ?? 0);
        }, 0);
        const pendingLeaves = leaveRows.filter(
          (leave) =>
            leaveIsPending(leave) && departmentOf(leave) === bucket.department,
        ).length;
        return buildMetricRow(
          bucket.branchId,
          null,
          bucket.branchName,
          bucket.department,
          bucket.staff.length,
          present,
          0,
          monthlyPayroll,
          pendingLeaves,
        );
      },
    );

    const totalStaff = scopedStaff.length;
    const allStaffIds = new Set(scopedStaff.map(staffIdentity).filter(Boolean));
    const present = Math.min(totalStaff, Math.round(averagePresent(allStaffIds)));
    const absent = Math.max(0, totalStaff - present);
    const monthlyPayroll = branchMetrics.reduce(
      (sum, row) => sum + row.monthlyPayroll,
      0,
    );
    const pendingLeaves = branchMetrics.reduce(
      (sum, row) => sum + row.pendingLeaves,
      0,
    );
    const totals: ReportTotals = {
      totalStaff,
      present,
      attended: present,
      absent,
      late: 0,
      attendanceRate:
        totalStaff > 0 ? Math.round((present / totalStaff) * 100) : 0,
      monthlyPayroll,
      pendingLeaves,
    };

    const buckets = rangeTrendBuckets(input.dateRange);
    const trendData = buckets.map(({ label, keys }) => {
      const keySet = new Set(keys);
      return {
        label,
        attendance: attendanceLogs.filter((row) => keySet.has(dateKey(row)))
          .length,
      };
    });

    const branchTrendData = buckets.map(({ label, keys }) => {
      const keySet = new Set(keys);
      const record: ReportTrendRow = { label, attendance: 0 };
      branchMetrics.forEach((branch) => {
        const count = attendanceLogs.filter((row) => {
          if (!keySet.has(dateKey(row))) return false;
          const id = staffIdentity(row);
          const source = staffById.get(id) ?? row;
          return uiBranchIdForRow(source, branches) === branch.branchId;
        }).length;
        record[`branch_${branch.branchId}`] = count;
        record.attendance = Number(record.attendance) + count;
      });
      return record;
    });

    const isAllBranchAdmin = !useSingleBranch;
    const selectedBranchLabel = useSingleBranch
      ? (branchMetrics[0]?.branchName ??
        input.branchLookup.get(Number(selectedUiBranch)) ??
        "Branch")
      : "All Branches";

    return {
      branchMetrics,
      departmentMetrics,
      totals,
      trendData,
      branchTrendData,
      isAllBranchAdmin,
      selectedBranchLabel,
    };
  }, [
    attendance.logs,
    cfg.branches,
    input.activeBranchId,
    input.allBranches,
    input.branchFilter,
    input.branchLookup,
    input.dateRange.endDate,
    input.dateRange.startDate,
    input.isGlobalDashboard,
    input.leave,
    input.payroll,
    input.staff,
    peopleTypeKey,
    scope?.uiBranchId,
  ]);
}

export default useReportMetrics;