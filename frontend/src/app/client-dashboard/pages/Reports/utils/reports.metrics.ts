/**
 * utils/reports.metrics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure metric calculators for reports.
 *
 * Design:
 *   - NO React dependencies
 *   - NO side effects
 *   - Pure functions: same input → same output
 *   - Testable without mocking
 *   - Reusable by backend API layer (same logic)
 *
 * Entities flow: ModuleContext (source) → useReportMetrics hook → Reports component
 * Backend flow:  API (source) → useReportMetrics hook → Reports component
 * (No code changes in useReportMetrics or Reports when switching sources)
 *
 * Migration: When backend is ready, replace ModuleContext data source in
 * the hook — metric functions remain unchanged.
 */

import type {
  StaffMember,
  LeaveRequest,
  PayrollRecord,
} from "../../../contexts/ModuleContext";

// ─── Metric types ─────────────────────────────────────────────────────────────

export interface BranchMetric {
  branchId: number;
  branchName: string;
  totalStaff: number;
  activeStaff: number;
  present: number;
  late: number;
  absent: number;
  attendanceRate: number;
  monthlyPayroll: number;
  pendingLeaves: number;
}

export interface DepartmentMetric {
  department: string;
  totalStaff: number;
  activeStaff: number;
  present: number;
  late: number;
  absent: number;
  attendanceRate: number;
  monthlyPayroll: number;
  pendingLeaves: number;
}

export interface TrendPoint {
  label: string;
  attendance: number;
  payroll: number;
  performance: number;
}

export interface BranchTrendPoint {
  label: string;
  [key: `branch_${number}`]: number;
}

export interface ReportTotals {
  totalStaff: number;
  present: number;
  late: number;
  absent: number;
  attended: number;
  attendanceRate: number;
  monthlyPayroll: number;
  pendingLeaves: number;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export const sum = <T>(items: T[], fn: (item: T) => number): number =>
  items.reduce((acc, item) => acc + fn(item), 0);

export const count = <T>(items: T[], fn: (item: T) => boolean): number =>
  items.filter(fn).length;

export const normalize = (s: string): string => s.trim().toLowerCase();

// ─── Domain accessors ─────────────────────────────────────────────────────────

export const getAttendanceStatus = (m: StaffMember): string =>
  normalize(
    (m as unknown as { attendanceStatus?: string }).attendanceStatus ?? "",
  );

export const isPresent = (m: StaffMember): boolean => {
  const s = getAttendanceStatus(m);
  return s === "present" || s === "completed";
};

export const isLate = (m: StaffMember): boolean =>
  getAttendanceStatus(m) === "late";

export const getNetPay = (r: PayrollRecord): number => r.salary || 0;

export const getLeaveStatus = (r: LeaveRequest): string => normalize(r.status);

// ─── Metric builders ──────────────────────────────────────────────────────────

/**
 * buildBranchMetric — pure computation of one branch's KPIs.
 *
 * Usage:
 *   const metric = buildBranchMetric(
 *     staff.filter(m => m.branchId === 1),
 *     leaves.filter(r => r.branchId === 1),
 *     payroll.filter(r => r.branchId === 1),
 *     "Karachi", 1
 *   );
 *
 * Backend integration:
 *   API returns: { branchId, branchName, totalStaff, activeStaff, ... }
 *   (This function is NOT called when using pre-aggregated API responses)
 */
export function buildBranchMetric(
  branchStaff: StaffMember[],
  branchLeaves: LeaveRequest[],
  branchPayroll: PayrollRecord[],
  branchName: string,
  branchId: number,
): BranchMetric {
  const totalStaff = branchStaff.length;
  const activeStaff = count(branchStaff, (m) => m.status === "active");
  const present = count(branchStaff, isPresent);
  const late = count(branchStaff, isLate);
  const absent = Math.max(totalStaff - present - late, 0);

  return {
    branchId,
    branchName,
    totalStaff,
    activeStaff,
    present,
    late,
    absent,
    attendanceRate: totalStaff
      ? Math.round(((present + late) / totalStaff) * 100)
      : 0,
    monthlyPayroll: sum(branchPayroll, getNetPay),
    pendingLeaves: count(branchLeaves, (r) => getLeaveStatus(r) === "pending"),
  };
}

/**
 * buildDepartmentMetric — pure computation of one department's KPIs.
 */
export function buildDepartmentMetric(
  dept: string,
  deptStaff: StaffMember[],
  deptLeaves: LeaveRequest[],
  deptPayroll: PayrollRecord[],
): DepartmentMetric {
  const totalStaff = deptStaff.length;
  const activeStaff = count(deptStaff, (m) => m.status === "active");
  const present = count(deptStaff, isPresent);
  const late = count(deptStaff, isLate);
  const absent = Math.max(totalStaff - present - late, 0);

  return {
    department: dept,
    totalStaff,
    activeStaff,
    present,
    late,
    absent,
    attendanceRate: totalStaff
      ? Math.round(((present + late) / totalStaff) * 100)
      : 0,
    monthlyPayroll: sum(deptPayroll, getNetPay),
    pendingLeaves: count(deptLeaves, (r) => getLeaveStatus(r) === "pending"),
  };
}

/**
 * buildTotals — aggregate KPIs across all scoped data.
 */
export function buildTotals(
  staff: StaffMember[],
  leaves: LeaveRequest[],
  payroll: PayrollRecord[],
): ReportTotals {
  const totalStaff = staff.length;
  const present = count(staff, isPresent);
  const late = count(staff, isLate);
  const absent = Math.max(totalStaff - present - late, 0);
  const attended = present + late;

  return {
    totalStaff,
    present,
    late,
    absent,
    attended,
    attendanceRate: totalStaff ? Math.round((attended / totalStaff) * 100) : 0,
    monthlyPayroll: sum(payroll, getNetPay),
    pendingLeaves: count(leaves, (r) => getLeaveStatus(r) === "pending"),
  };
}

// ─── Trend data generation ─────────────────────────────────────────────────────

const TREND_FACTORS = [0.74, 0.86, 0.92, 1, 0.96, 0.9, 0.82];

export const trendLabels = (
  period: "today" | "7d" | "30d" | "month" | "all",
): string[] =>
  ({
    today: ["08 AM", "10 AM", "12 PM", "02 PM", "04 PM", "06 PM"],
    "7d": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    "30d": ["Day 1", "Day 7", "Day 14", "Day 21", "Day 30"],
    month: ["Week 1", "Week 2", "Week 3", "Week 4"],
    all: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
  })[period];

/**
 * buildTrend — synthetic trend data for a single aggregate.
 *
 * Usage: When you have totals for all branches/departments combined
 * and want to show how attendance/payroll/performance trended.
 */
export function buildTrend(
  metrics: BranchMetric[],
  period: "today" | "7d" | "30d" | "month" | "all",
): TrendPoint[] {
  const labels = trendLabels(period);
  const totalStaff = sum(metrics, (m) => m.totalStaff);
  const attended = sum(metrics, (m) => m.present + m.late);
  const payroll = sum(metrics, (m) => m.monthlyPayroll);
  const rate = totalStaff ? Math.round((attended / totalStaff) * 100) : 0;

  return labels.map((label, i) => {
    const f = TREND_FACTORS[i % TREND_FACTORS.length];
    return {
      label,
      attendance: Math.max(0, Math.round(attended * f)),
      payroll: Math.max(0, Math.round(payroll * f)),
      performance: Math.min(100, Math.max(0, Math.round(rate * f))),
    };
  });
}

/**
 * buildBranchTrend — multi-branch trend (one line per branch).
 *
 * Usage: When you want to show trend comparison across multiple branches.
 */
export function buildBranchTrend(
  metrics: BranchMetric[],
  period: "today" | "7d" | "30d" | "month" | "all",
): BranchTrendPoint[] {
  const labels = trendLabels(period);
  return labels.map((label, i) => {
    const row: BranchTrendPoint = { label };
    metrics.forEach((m) => {
      const f = Math.max(
        0.62,
        TREND_FACTORS[i % TREND_FACTORS.length] - metrics.indexOf(m) * 0.035,
      );
      row[`branch_${m.branchId}`] = Math.max(
        0,
        Math.round((m.present + m.late) * f),
      );
    });
    return row;
  });
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

export const formatPKR = (v: number): string => {
  if (v >= 1_000_000) return `PKR ${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `PKR ${(v / 1_000).toFixed(0)}K`;
  return `PKR ${Math.round(v).toLocaleString()}`;
};

export const periodLabel = (
  p: "today" | "7d" | "30d" | "month" | "all",
): string =>
  ({
    today: "Today",
    "7d": "Last 7 Days",
    "30d": "Last 30 Days",
    month: "This Month",
    all: "All Time",
  })[p];

export const todayISO = (): string => new Date().toISOString().slice(0, 10);
export const monthLabel = (): string =>
  new Date().toLocaleString("en", { month: "short", year: "numeric" });
