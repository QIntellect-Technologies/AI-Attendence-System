/**
 * modules/attendance/utils/dayStatusLabels.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for the day_status ('half_day'|'short_leave'|
 * 'late'|'overtime') label/color map and the payroll-decision badge derived
 * from it. Extracted out of AttendanceView.tsx so PayrollDecisions.tsx can
 * render the identical badge without a second parallel copy of this map —
 * see support_db_attendance_exceptions.py's _LOCAL_NODE_RESOLVED_STATUSES,
 * which this must stay in sync with.
 */

export type ClassifiedDayStatus =
  | "half_day"
  | "short_leave"
  | "late"
  | "overtime";

export const DAY_STATUS_LABELS: Record<
  ClassifiedDayStatus,
  { label: string; className: string }
> = {
  late: {
    label: "Late",
    className: "bg-orange-50 text-orange-600 border-orange-100",
  },
  short_leave: {
    label: "Short Leave",
    className: "bg-amber-50 text-amber-700 border-amber-100",
  },
  half_day: {
    label: "Half Day",
    className: "bg-violet-50 text-violet-700 border-violet-100",
  },
  overtime: {
    label: "Overtime",
    className: "bg-sky-50 text-sky-700 border-sky-100",
  },
};

export function isClassifiedDayStatus(
  dayStatus: string | null | undefined,
): dayStatus is ClassifiedDayStatus {
  return (dayStatus ?? "").toLowerCase() in DAY_STATUS_LABELS;
}

/**
 * Payroll-decision badge. Only meaningful once day_status has actually been
 * classified — an ordinary present day has nothing to decide and returns
 * null (caller renders "—"). A classified row with no decision yet shows
 * "Pending Decision" rather than blank, so it's visibly distinct from
 * "nothing to decide here".
 *
 * Today this only ever resolves to a real include/exclude for local-node
 * rows (support_db_attendance_exceptions.py's set_local_node_payroll_decision
 * is the only write path) — mobile-sourced classified rows will show
 * "Pending Decision" indefinitely until that flow gets the same field.
 */
export function derivePayrollDecisionBadge(record: {
  dayStatus?: string | null;
  payrollDecision?: string | null;
}): { label: string; className: string } | null {
  if (!isClassifiedDayStatus(record.dayStatus)) return null;

  if (record.payrollDecision === "include") {
    return {
      label: "Included",
      className: "bg-teal-50 text-teal-700 border-teal-100",
    };
  }
  if (record.payrollDecision === "exclude") {
    return {
      label: "Excluded",
      className: "bg-rose-50 text-rose-600 border-rose-100",
    };
  }
  return {
    label: "Pending Decision",
    className: "bg-gray-50 text-gray-500 border-gray-200",
  };
}
