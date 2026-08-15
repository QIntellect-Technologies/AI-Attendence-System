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
import {
  branchIdentityValues,
  cleanId,
  getUiBranchId,
  resolveTenantScope,
} from "../../../utils/tenantScope";

export type ReportPeriod = "today" | "7d" | "30d" | "month" | "all" | string;

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
  period: ReportPeriod;
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

const DAY_MS = 24 * 60 * 60 * 1000;

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

function daysForPeriod(period: ReportPeriod): number {
  if (period === "today") return 1;
  if (period === "30d") return 30;
  if (period === "month") return 30;
  if (period === "all") return 7;
  return 7;
}

function recentDayLabels(
  period: ReportPeriod,
): { label: string; key: string }[] {
  const days = Math.min(daysForPeriod(period), 14);
  const formatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const today = new Date();
  return Array.from({ length: days }).map((_, index) => {
    const date = new Date(today.getTime() - (days - 1 - index) * DAY_MS);
    return {
      label: formatter.format(date),
      key: date.toISOString().slice(0, 10),
    };
  });
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

  const attendance = useAttendanceData({
    organizationId: scope?.organizationId ?? organizationId ?? undefined,
    branchId: scope?.apiBranchId ?? undefined,
    peopleType: peopleTypeKey,
    logsLimit: 3000,
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
    const attendanceToday = toArray(attendance.today as unknown as unknown[]);
    const attendanceLogs = toArray(attendance.logs as unknown as unknown[]);
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

    const todayPresentByStaff = new Map<string, AnyRecord>();
    attendanceToday.forEach((row) => {
      const id = staffIdentity(row);
      if (!id) return;
      if (useSingleBranch) {
        const branchId =
          uiBranchIdForRow(row, branches) ??
          uiBranchIdForRow(staffById.get(id) ?? {}, branches);
        if (branchId === null || !visibleBranchIds.has(branchId)) return;
      }
      todayPresentByStaff.set(id, row);
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
      let present = 0;
      todayPresentByStaff.forEach((_row, id) => {
        if (branchStaffIds.has(id)) present += 1;
      });
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
        let present = 0;
        todayPresentByStaff.forEach((_row, id) => {
          if (staffIds.has(id)) present += 1;
        });
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
    const present = Math.min(
      totalStaff || todayPresentByStaff.size,
      todayPresentByStaff.size,
    );
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

    const labels = recentDayLabels(input.period);
    const trendData = labels.map(({ label, key }) => ({
      label,
      attendance:
        attendanceLogs.filter((row) => dateKey(row) === key).length +
        attendanceToday.filter((row) => dateKey(row) === key).length,
    }));

    const branchTrendData = labels.map(({ label, key }) => {
      const record: ReportTrendRow = { label, attendance: 0 };
      branchMetrics.forEach((branch) => {
        const count = [...attendanceLogs, ...attendanceToday].filter((row) => {
          if (dateKey(row) !== key) return false;
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
    attendance.today,
    cfg.branches,
    input.activeBranchId,
    input.allBranches,
    input.branchFilter,
    input.branchLookup,
    input.isGlobalDashboard,
    input.leave,
    input.payroll,
    input.period,
    input.staff,
    peopleTypeKey,
    scope?.uiBranchId,
  ]);
}

export default useReportMetrics;