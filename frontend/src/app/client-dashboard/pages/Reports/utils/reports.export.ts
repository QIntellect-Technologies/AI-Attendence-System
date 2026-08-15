/**
 * utils/reports.export.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CSV export utilities — designed to work with both frontend and backend.
 *
 * Frontend: exportReportsCsv() is called from Reports component
 *   → generates CSV in memory
 *   → triggers browser download
 *
 * Backend (future): Same export logic can be reused
 *   → API endpoint calls exportReportsCsv()
 *   → returns CSV string to client
 *   → client triggers download from response
 *   (No code changes to export functions)
 *
 * Design:
 *   - Pure functions (no React, no side effects)
 *   - Work with computed metrics (ReportExportMetricRow, as produced by
 *     hooks/useReportMetrics.ts)
 *   - No network calls
 *   - Testable
 */

import {
  formatPKR,
  periodLabel,
  monthLabel,
  todayISO,
} from "./reports.metrics";

/**
 * Row shape actually produced by hooks/useReportMetrics.ts at runtime.
 *
 * NOTE: this intentionally does NOT reuse BranchMetric/DepartmentMetric from
 * reports.metrics.ts — those describe the older pure-calculator path (which
 * includes an `activeStaff` field) and are no longer what Reports.tsx feeds
 * in here. Importing that type but receiving this shape was the cause of a
 * live bug: `${b.activeStaff} active` rendered as the literal string
 * "undefined active" in the Report Data table, because the field never
 * existed on the object at runtime. Defining the row shape from what's
 * actually passed keeps this file honest about its real input.
 */
export interface ReportExportMetricRow {
  branchId: number;
  branchName: string;
  department: string;
  totalStaff: number;
  present: number;
  late: number;
  absent: number;
  attendanceRate: number;
  monthlyPayroll: number;
  pendingLeaves: number;
}

export interface ReportExportRow {
  branch: string;
  department: string;
  metric: string;
  value: string | number;
  period: string;
  notes: string;
  // Index signature so ReportExportRow satisfies Record<string, string | number>
  [key: string]: string | number;
}

export interface ReportExportMeta {
  module: string;
  scope: string;
  branch: string;
  period: string;
  records: number;
  generatedOn: string;
}

/**
 * buildExportRows — transform metrics into flat export table rows.
 *
 * Output: Array of {branch, department, metric, value, period, notes}
 *
 * People-type awareness: `personPlural`/`groupLabel`/`groupPlural` come from
 * the caller's resolved PeopleRenderingModel (e.g. "Students"/"Class"/
 * "Classes" vs "Staff"/"Department"/"Departments") so row labels match
 * whatever's selected in the People Type filter. `supportsPayroll` gates
 * the Payroll rows entirely — a people type that doesn't support payroll
 * (e.g. students) gets no payroll rows at all, rather than a zeroed-out row.
 *
 * Used by:
 *   - Frontend: to display table of exportable metrics
 *   - API: to generate CSV response
 */
export function buildExportRows(args: {
  branchMetrics: ReportExportMetricRow[];
  departmentMetrics: ReportExportMetricRow[];
  selectedBranchLabel: string;
  period: "today" | "7d" | "30d" | "month" | "all";
  search: string;
  personPlural: string;
  groupLabel: string;
  groupPlural: string;
  supportsPayroll: boolean;
}): ReportExportRow[] {
  const {
    branchMetrics,
    departmentMetrics,
    selectedBranchLabel,
    period,
    search,
    personPlural,
    groupLabel,
    groupPlural,
    supportsPayroll,
  } = args;

  const periodText = periodLabel(period);
  const allGroupsLabel = `All ${groupPlural}`;
  const attendanceNotes = (row: ReportExportMetricRow) =>
    `${row.present} present, ${row.late} late, ${row.absent} absent`;
  const rows: ReportExportRow[] = [];

  // ─── Branch-level metrics ──────────────────────────────────────────────────
  branchMetrics.forEach((b) => {
    rows.push(
      {
        branch: b.branchName,
        department: allGroupsLabel,
        metric: `Total ${personPlural}`,
        value: b.totalStaff,
        period: periodText,
        notes: attendanceNotes(b),
      },
      {
        branch: b.branchName,
        department: allGroupsLabel,
        metric: "Attendance Rate",
        value: `${b.attendanceRate}%`,
        period: periodText,
        notes: attendanceNotes(b),
      },
    );

    if (supportsPayroll) {
      rows.push({
        branch: b.branchName,
        department: allGroupsLabel,
        metric: "Monthly Payroll",
        value: b.monthlyPayroll,
        period: monthLabel(),
        notes: formatPKR(b.monthlyPayroll),
      });
    }

    rows.push({
      branch: b.branchName,
      department: allGroupsLabel,
      metric: "Pending Leaves",
      value: b.pendingLeaves,
      period: periodText,
      notes: "Pending approval",
    });
  });

  // ─── Group-level metrics (Department/Class/etc., per people type) ─────────
  departmentMetrics.forEach((d) => {
    rows.push(
      {
        branch: selectedBranchLabel,
        department: d.department,
        metric: `${groupLabel} ${personPlural}`,
        value: d.totalStaff,
        period: periodText,
        notes: attendanceNotes(d),
      },
      {
        branch: selectedBranchLabel,
        department: d.department,
        metric: `${groupLabel} Attendance Rate`,
        value: `${d.attendanceRate}%`,
        period: periodText,
        notes: attendanceNotes(d),
      },
    );

    if (supportsPayroll) {
      rows.push({
        branch: selectedBranchLabel,
        department: d.department,
        metric: `${groupLabel} Payroll`,
        value: d.monthlyPayroll,
        period: monthLabel(),
        notes: formatPKR(d.monthlyPayroll),
      });
    }
  });

  // ─── Apply search filter ────────────────────────────────────────────────────
  if (!search.trim()) return rows;

  const q = search.trim().toLowerCase();
  return rows.filter((r) =>
    [r.branch, r.department, r.metric, r.notes]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

/**
 * rowsToCsvString — convert array of objects to CSV string.
 *
 * Usage:
 *   const csv = rowsToCsvString(rows, ["branch", "department", "metric", "value"]);
 *   // → "branch,department,metric,value\n..."
 */
export function rowsToCsvString(
  rows: Record<string, string | number>[],
  columns: string[],
): string {
  // ─── Header ────────────────────────────────────────────────────────────────
  const header = columns.map((col) => `"${col}"`).join(",");

  // ─── Body ──────────────────────────────────────────────────────────────────
  const body = rows
    .map((row) =>
      columns
        .map((col) => {
          const value = row[col];
          const str = String(value ?? "");
          // Escape quotes and wrap in quotes if contains comma
          const escaped = str.replace(/"/g, '""');
          return escaped.includes(",") ? `"${escaped}"` : str;
        })
        .join(","),
    )
    .join("\n");

  return `${header}\n${body}`;
}

/**
 * exportReportsCsv — frontend helper to download CSV.
 *
 * Usage:
 *   const csv = rowsToCsvString(rows, columns);
 *   exportReportsCsv("reports.csv", csv);
 *   // → triggers browser download
 */
export function exportReportsCsv(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * buildExportMeta — create metadata footer for CSV.
 *
 * Included at bottom of exported data for traceability.
 */
export function buildExportMeta(args: {
  scope: "global" | "branch";
  selectedBranchLabel: string;
  period: "today" | "7d" | "30d" | "month" | "all";
  recordCount: number;
}): ReportExportMeta {
  const { scope, selectedBranchLabel, period, recordCount } = args;

  return {
    module: "Reports & Analytics",
    scope: scope === "global" ? "Admin / All Branches" : "Branch Dashboard",
    branch: selectedBranchLabel,
    period: periodLabel(period),
    records: recordCount,
    generatedOn: todayISO(),
  };
}
