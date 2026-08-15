"""
payroll_engine.py
──────────────────────────────────────────────────────────────────────────────
Computes the itemized payroll breakdown (deductions + additions) for one
staff member over one pay period, from real attendance + leave data and the
org's configurable PayrollPolicy (see support_db.get_payroll_policy).

Consumes already-grouped, period-bounded data — see
support_db.get_staff_attendance_for_payroll_period /
get_approved_leaves_for_payroll_period. This module has no DB access of its
own, only computation, so it's trivially unit-testable without a Supabase
connection.
"""
from __future__ import annotations
from calendar import monthrange
from datetime import date
from dataclasses import dataclass, asdict


@dataclass
class PayrollBreakdown:
    base_salary: float
    per_day_rate: float
    late_count: int
    late_deduction_days: float
    late_deduction_amount: float
    half_day_attendance_count: int
    half_day_leave_count: float
    half_day_deduction_amount: float
    short_leave_attendance_count: int
    short_leave_hours: float
    short_leave_deduction_amount: float
    unpaid_leave_days: float
    unpaid_leave_deduction_amount: float
    overtime_hours: float
    overtime_amount: float
    attendance_leave_conflict_days: float
    total_deductions: float
    total_additions: float
    net_pay: float

    def to_dict(self) -> dict:
        return asdict(self)


def _per_day_rate(base_salary: float, policy: dict, period_start: date, period_end: date) -> float:
    basis = policy.get('perDayRateBasis', 'calendar_days')
    if basis == 'fixed_days':
        days = max(1, int(policy.get('fixedWorkingDaysPerMonth', 26)))
    elif basis == 'scheduled_days':
        # Needs the staff's assigned shift's working-days-per-week
        # (support_db_shifts doesn't currently model that — shifts define
        # daily check-in/out times, not a weekly working pattern) to count
        # actual scheduled days in-period. Falls back to calendar days
        # until that field exists; flag this to Mia rather than silently
        # guessing a 5- or 6-day week.
        days = (period_end - period_start).days + 1
    else:  # calendar_days
        days = monthrange(period_start.year, period_start.month)[1]
    return base_salary / days if days else 0.0


def _late_deduction(late_count: int, per_day_rate: float, policy: dict) -> tuple[float, float]:
    late_policy = policy.get('lateComingPolicy') or {}
    mode = late_policy.get('mode', 'none')

    if mode == 'occurrence_threshold':
        threshold = max(1, int(late_policy.get('thresholdOccurrences', 3)))
        deduction_days = (late_count // threshold) * 0.5
        return deduction_days, deduction_days * per_day_rate

    if mode == 'flat_per_occurrence':
        return 0.0, float(late_policy.get('flatAmountPerOccurrence', 0)) * late_count

    if mode == 'per_minute':
        # Needs late_minutes per occurrence, which the attendance row
        # doesn't currently expose (only a 'late' status, not a delta
        # against the shift's check_in_time). Needs a small addition to
        # get_staff_attendance_for_payroll_period once you confirm you
        # want this mode enabled.
        return 0.0, 0.0

    return 0.0, 0.0  # mode == 'none'


def _decision_included(row: dict, key: str) -> bool:
    """A row with no decision recorded yet (None -- the pre-migration
    default, and every historical row before Phase 1 shipped) is treated
    as 'include' so turning this gating on doesn't silently change any
    org's payroll the day it ships. Only an explicit 'exclude' removes a
    row from the count."""
    return row.get(key) != 'exclude'


def _reconcile_leave_against_attendance(
    leave_rows: list[dict],
    attendance_dates: set[str],
) -> tuple[list[dict], float]:
    """A day the staff member actually attended (any check-in — present,
    late, or half-day) should never also be counted as a leave day, even
    if an approved leave request still sits on file for that date (e.g.
    they came in and never withdrew the leave). Each leave_rows entry may
    carry a 'dates' list (the individual calendar dates it covers, clipped
    to the pay period — see support_db.get_approved_leaves_for_payroll_period);
    entries without one (legacy callers/tests) are trusted as-is.

    Returns (adjusted_rows, total_conflict_days) — adjusted_rows has each
    entry's 'days' reduced by however many of its dates overlap
    attendance_dates, so the rest of this module only ever sees leave days
    that weren't also worked.
    """
    adjusted: list[dict] = []
    total_conflict = 0.0
    for row in leave_rows:
        dates = row.get('dates')
        if not dates:
            adjusted.append(row)
            continue
        conflict_dates = [d for d in dates if d in attendance_dates]
        if not conflict_dates:
            adjusted.append(row)
            continue
        per_date = row['days'] / len(dates) if dates else 0.0
        conflict_days = per_date * len(conflict_dates)
        total_conflict += conflict_days
        remaining = max(0.0, row['days'] - conflict_days)
        adjusted.append({**row, 'days': remaining})
    return adjusted, total_conflict


def compute_payroll_breakdown(
    *,
    base_salary: float,
    ot_hours: float,
    ot_rate_per_hour: float,
    period_start: date,
    period_end: date,
    policy: dict,
    attendance_rows: list[dict],   # [{date, checkInStatus, dayStatus}]
    leave_rows: list[dict],        # [{leaveType, days, dates?}]
) -> PayrollBreakdown:
    # Guarded here, not just at the route layer, so every current and
    # future caller of this function is protected regardless of how it got
    # here. An inverted period only breaks visibly under the
    # 'scheduled_days' basis -- (period_end - period_start).days + 1 goes
    # negative, producing a negative per-day rate that then multiplies
    # into every deduction line below (late/half-day/short-leave/
    # unpaid-leave), silently inflating pay instead of reducing it.
    # 'calendar_days' and 'fixed_days' don't touch period_end at all, so
    # this stayed invisible under casual testing on those bases -- which
    # is exactly why it belongs here rather than only in the route.
    if period_end < period_start:
        raise ValueError(
            f"Invalid payroll period: period_end ({period_end.isoformat()}) "
            f"is before period_start ({period_start.isoformat()})."
        )

    per_day_rate = _per_day_rate(base_salary, policy, period_start, period_end)

    late_count = sum(
        1 for r in attendance_rows
        if r.get('checkInStatus') == 'late'
        and _decision_included(r, 'checkInPayrollDecision')
    )
    half_day_attendance_count = sum(
        1 for r in attendance_rows
        if r.get('dayStatus') == 'half_day'
        and _decision_included(r, 'checkOutPayrollDecision')
    )
    short_leave_attendance_count = sum(
        1 for r in attendance_rows
        if r.get('dayStatus') == 'short_leave'
        and _decision_included(r, 'checkOutPayrollDecision')
    )

    late_deduction_days, late_deduction_amount = _late_deduction(late_count, per_day_rate, policy)

    # Every attendance row is a real check-in event for that date — present,
    # late, or half-day all count as "was here" for reconciliation purposes.
    attendance_dates = {r['date'] for r in attendance_rows if r.get('date')}
    leave_rows, attendance_leave_conflict_days = _reconcile_leave_against_attendance(
        leave_rows, attendance_dates
    )

    leave_rules: dict = policy.get('leaveTypeRules') or {}
    def _is_unpaid_leave_type(leave_type: str) -> bool:
        normalized = str(leave_type or '').strip().lower()
        if not normalized:
            return False
        if normalized == 'unpaid':
            return True
        return str(leave_rules.get(normalized, 'paid')).strip().lower() == 'unpaid'

    half_day_leave_count = sum(r['days'] for r in leave_rows if r['leaveType'] == 'half_day')
    unpaid_leave_days = sum(
        r['days'] for r in leave_rows
        if r['leaveType'] != 'half_day' and _is_unpaid_leave_type(r.get('leaveType') or '')
    )
    # Unpaid half-day leave only deducts if the org has actually marked
    # 'half_day' as unpaid in leaveTypeRules — some orgs treat half-day
    # leave as a paid perk, so this must respect policy, not assume.
    if leave_rules.get('half_day', 'paid') == 'unpaid':
        unpaid_leave_days += half_day_leave_count * 0.5  # already 0.5/row from grouping

    half_day_deduction_amount = (
        half_day_attendance_count * 0.5 * per_day_rate
        + (half_day_leave_count * 0.5 * per_day_rate if leave_rules.get('half_day', 'paid') == 'unpaid' else 0.0)
    )
    unpaid_leave_deduction_amount = max(
        0.0,
        (unpaid_leave_days - (half_day_leave_count * 0.5 if leave_rules.get('half_day', 'paid') == 'unpaid' else 0.0))
        * per_day_rate,
    )

    short_leave_policy = policy.get('shortLeavePolicy') or {}
    short_leave_fallback_fraction = float(short_leave_policy.get('dayFraction', 0.5))

    short_leave_hours_total = 0.0
    short_leave_deduction_amount = 0.0
    for r in attendance_rows:
        if r.get('dayStatus') != 'short_leave' or not _decision_included(r, 'checkOutPayrollDecision'):
            continue
        shift_hours = float(r.get('shiftScheduledHours') or 0.0)
        hours_short = float(r.get('shortLeaveHours') or 0.0)
        if shift_hours <= 0:
            # Window couldn't be resolved for this row (see
            # compute_short_leave_hours's docstring) -- degrade to the
            # flat fraction rather than deducting nothing for a real
            # short-leave day.
            short_leave_deduction_amount += short_leave_fallback_fraction * per_day_rate
            continue
        short_leave_hours_total += hours_short
        short_leave_deduction_amount += hours_short * (per_day_rate / shift_hours)

    overtime_amount = ot_hours * ot_rate_per_hour

    total_deductions = (
        late_deduction_amount
        + half_day_deduction_amount
        + short_leave_deduction_amount
        + unpaid_leave_deduction_amount
    )
    total_additions = overtime_amount
    net_pay = max(0.0, base_salary + total_additions - total_deductions)

    return PayrollBreakdown(
        base_salary=base_salary,
        per_day_rate=round(per_day_rate, 2),
        late_count=late_count,
        late_deduction_days=late_deduction_days,
        late_deduction_amount=round(late_deduction_amount, 2),
        half_day_attendance_count=half_day_attendance_count,
        half_day_leave_count=half_day_leave_count,
        half_day_deduction_amount=round(half_day_deduction_amount, 2),
        short_leave_attendance_count=short_leave_attendance_count,
        short_leave_hours=round(short_leave_hours_total, 2),
        short_leave_deduction_amount=round(short_leave_deduction_amount, 2),
        unpaid_leave_days=round(unpaid_leave_days, 2),
        unpaid_leave_deduction_amount=round(unpaid_leave_deduction_amount, 2),
        overtime_hours=ot_hours,
        overtime_amount=round(overtime_amount, 2),
        attendance_leave_conflict_days=round(attendance_leave_conflict_days, 2),
        total_deductions=round(total_deductions, 2),
        total_additions=round(total_additions, 2),
        net_pay=round(net_pay, 2),
    )