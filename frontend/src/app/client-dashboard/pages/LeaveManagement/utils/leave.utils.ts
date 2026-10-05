/**
 * src/modules/leave/utils/leave.utils.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Leave management utility functions.
 *
 * Normalizers, calculations, text helpers, and other pure functions
 * used across leave management module.
 */

import type { PendingLeaveItem } from "../types/leave";

/**
 * Normalize a raw people-type string (from a leave request or a staff
 * record) to the canonical slug used for module-scoping comparisons —
 * lowercase, underscore-separated, common plural aliases collapsed to
 * singular. Shared by useLeaveActions (leave rows) and useLeaveHistory
 * (staff roster rows) so both agree on what counts as e.g. "worker"
 * without each maintaining its own copy of this list.
 */
export function normalizeLeavePeopleType(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    workers: "worker",
    employees: "employee",
    staff_members: "staff",
    staffs: "staff",
  };
  return aliases[normalized] ?? normalized;
}

/**
 * Normalize and validate a leave record from any data source.
 *
 * Handles inconsistent field names from different APIs/dummy data:
 * - name vs staffName vs employeeName
 * - appliedOn vs submittedAt vs createdAt
 * - dept vs department
 * - type vs leaveType
 *
 * @param record Raw leave record from API or dummy data
 * @param index Index in array (used for fallback ID generation)
 * @returns Normalized PendingLeaveItem
 */
export function normalizeLeaveRecord(
  record: any,
  index: number,
): PendingLeaveItem {
  // Extract name (multiple possible field names)
  const name = String(
    record.name ??
      record.staffName ??
      record.employeeName ??
      record.staffMemberName ??
      `Unknown (${index})`,
  ).trim();

  // Extract department (multiple possible field names)
  const dept = String(
    record.dept ?? record.department ?? record.departmentName ?? "General",
  ).trim();

  // Extract branch name (with fallback)
  const branchName = String(
    record.branchName ?? record.branch_name ?? "Main Branch",
  ).trim();

  // Extract leave type (multiple possible field names)
  const type = String(
    record.type ?? record.leaveType ?? record.leave_type ?? "Leave",
  ).trim();

  // Extract days (handle various field names and ensure it's a number)
  const days = Math.max(
    1,
    Number(record.days ?? record.totalDays ?? record.total_days ?? 1),
  );

  // Extract applied date (try multiple field names, normalize to YYYY-MM-DD)
  let appliedOn: string | undefined;
  const rawDate =
    record.appliedOn ??
    record.submittedAt ??
    record.createdAt ??
    record.applied_on ??
    record.submitted_at ??
    "";

  if (rawDate) {
    // Convert to string and extract date part (YYYY-MM-DD)
    const dateStr = String(rawDate).slice(0, 10);
    // Validate it looks like a date
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      appliedOn = dateStr;
    }
  }

  return {
    id: String(record.id ?? `leave_${index}`),
    name,
    dept,
    branchName,
    type,
    days,
    appliedOn,
    status: "Pending",
  };
}

/**
 * Format a leave date to human-readable format.
 *
 * @param dateStr ISO date string (YYYY-MM-DD)
 * @param locale Locale for formatting (default: en-US)
 * @returns Formatted date (e.g., "Jan 15, 2025")
 */
export function formatLeaveDate(dateStr?: string, locale = "en-US"): string {
  if (!dateStr) return "—";

  try {
    const date = new Date(dateStr + "T00:00:00Z");
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  } catch {
    return "—";
  }
}

/**
 * Get the range label for CSV export (e.g., "Jan 1 – Jan 15, 2025").
 *
 * @param fromDate Start date (YYYY-MM-DD)
 * @param toDate End date (YYYY-MM-DD)
 * @returns Human-readable date range
 */
export function formatLeaveExportDateRange(
  fromDate?: string,
  toDate?: string,
): string {
  if (!fromDate) return "Date Range";

  const from = formatLeaveDate(fromDate);
  if (!toDate || fromDate === toDate) {
    return from;
  }

  const to = formatLeaveDate(toDate);
  return `${from} – ${to}`;
}

/**
 * Calculate statistics about leaves.
 *
 * Returns counts and aggregations useful for KPI cards.
 */
export interface LeaveStatistics {
  total: number;
  byType: Record<string, number>;
  byDepartment: Record<string, number>;
  totalDays: number;
  avgDaysPerLeave: number;
}

export function calculateLeaveStats(
  leaves: PendingLeaveItem[],
): LeaveStatistics {
  const byType: Record<string, number> = {};
  const byDepartment: Record<string, number> = {};
  let totalDays = 0;

  leaves.forEach((leave) => {
    // Count by type
    byType[leave.type] = (byType[leave.type] ?? 0) + 1;

    // Count by department
    byDepartment[leave.dept] = (byDepartment[leave.dept] ?? 0) + 1;

    // Sum total days
    totalDays += leave.days;
  });

  return {
    total: leaves.length,
    byType,
    byDepartment,
    totalDays,
    avgDaysPerLeave: leaves.length > 0 ? totalDays / leaves.length : 0,
  };
}

/**
 * Validate a leave record for completeness.
 *
 * Ensures required fields are present and non-empty.
 *
 * @returns Error message if invalid, null if valid
 */
export function validateLeaveRecord(leave: PendingLeaveItem): string | null {
  if (!leave.id || leave.id.trim() === "") {
    return "Missing leave ID";
  }

  if (!leave.name || leave.name.trim() === "") {
    return "Missing employee name";
  }

  if (!leave.dept || leave.dept.trim() === "") {
    return "Missing department";
  }

  if (!leave.type || leave.type.trim() === "") {
    return "Missing leave type";
  }

  if (leave.days < 1) {
    return "Leave days must be at least 1";
  }

  if (!leave.branchName || leave.branchName.trim() === "") {
    return "Missing branch";
  }

  return null; // Valid
}

/**
 * Compare two leaves for sorting.
 *
 * Sort order: by applied date (newest first), then by name.
 */
export function compareLeaves(
  a: PendingLeaveItem,
  b: PendingLeaveItem,
): number {
  // Sort by appliedOn date (newest first)
  if (a.appliedOn && b.appliedOn) {
    return b.appliedOn.localeCompare(a.appliedOn);
  }

  // If one has date and other doesn't, put dated first
  if (a.appliedOn && !b.appliedOn) return -1;
  if (!a.appliedOn && b.appliedOn) return 1;

  // Fallback: sort by name
  return a.name.localeCompare(b.name);
}

/**
 * Export a leave record as CSV row.
 *
 * Formats fields appropriately for CSV (quotes strings, etc.).
 *
 * @param leave Leave record
 * @param includeDate Include appliedOn date in output?
 * @returns Object ready for CSV export
 */
export function leaveToExportRow(
  leave: PendingLeaveItem,
  includeDate = true,
): Record<string, string | number> {
  return {
    "Employee Name": leave.name,
    Branch: leave.branchName,
    Department: leave.dept,
    "Leave Type": leave.type,
    Days: leave.days,
    Status: leave.status ?? "Pending",
    ...(includeDate && { "Applied On": leave.appliedOn ?? "—" }),
  };
}

/**
 * Group leaves by a field.
 *
 * Useful for organizing leaves by department, type, etc.
 *
 * @param leaves Leaves to group
 * @param getKey Function to extract grouping key from each leave
 * @returns Object with keys mapping to arrays of leaves
 */
export function groupLeavesBy(
  leaves: PendingLeaveItem[],
  getKey: (leave: PendingLeaveItem) => string,
): Record<string, PendingLeaveItem[]> {
  const grouped: Record<string, PendingLeaveItem[]> = {};

  leaves.forEach((leave) => {
    const key = getKey(leave);
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(leave);
  });

  return grouped;
}

/**
 * Check if a leave record is recent (applied within last N days).
 *
 * Useful for highlighting new requests.
 *
 * @param leave Leave record
 * @param days How many days back to consider "recent" (default: 7)
 * @returns true if leave was applied within the timeframe
 */
export function isRecentLeave(leave: PendingLeaveItem, days = 7): boolean {
  if (!leave.appliedOn) return false;

  try {
    const appliedDate = new Date(leave.appliedOn);
    const today = new Date();
    const daysSinceApplied = Math.floor(
      (today.getTime() - appliedDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    return daysSinceApplied >= 0 && daysSinceApplied < days;
  } catch {
    return false;
  }
}