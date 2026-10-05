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
 * Resolves which payroll-decision column actually holds the admin's
 * include/exclude call for this row. Mirrors set_local_node_payroll_decision
 * (support_db_attendance_exceptions.py) EXACTLY -- that function picks the
 * column by capture_channel + day_status, not by which leg (check-in vs
 * check-out) originally produced the classification:
 *
 *   target_column = "check_in_payroll_decision"
 *     if (capture_channel == "mobile_app" and day_status == "late")
 *     else "check_out_payroll_decision"
 *
 * So even though resolve_attendance_exception can classify half_day/
 * short_leave from the check-in leg, that decision still lands on
 * check_out_payroll_decision -- and a LOCAL-NODE 'late' row also uses
 * check_out_payroll_decision (the node has one day_status for the whole
 * day, so there's only ever one decision to make). check_in_payroll_decision
 * is reserved for the single case of a MOBILE-sourced 'late' row, which is
 * a check-in-side decision recorded separately so it can't collide with an
 * unrelated check-out-side outcome on the same row.
 *
 * Checking dayStatus alone (without captureChannel) would misroute a
 * local_node 'late' row to the wrong (always-empty) column, permanently
 * showing "Pending Decision" even after it's been decided.
 */
export function resolvePayrollDecision(record: {
  dayStatus?: string | null;
  captureChannel?: string | null;
  checkInPayrollDecision?: string | null;
  checkOutPayrollDecision?: string | null;
}): string | null {
  const dayStatus = (record.dayStatus ?? "").toLowerCase();
  const captureChannel = (record.captureChannel ?? "").toLowerCase();
  const usesCheckInColumn =
    captureChannel === "mobile_app" && dayStatus === "late";
  return usesCheckInColumn
    ? (record.checkInPayrollDecision ?? null)
    : (record.checkOutPayrollDecision ?? null);
}

/**
 * Payroll-decision badge. Only meaningful once day_status has actually been
 * classified — an ordinary present day has nothing to decide and returns
 * null (caller renders "—"). A classified row with no decision yet shows
 * "Pending Decision" rather than blank, so it's visibly distinct from
 * "nothing to decide here".
 *
 * Callers should pass `payrollDecision` already resolved via
 * resolvePayrollDecision (see above) -- which underlying column holds the
 * decision depends on day_status, and this function has no row data to
 * re-derive that from.
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
