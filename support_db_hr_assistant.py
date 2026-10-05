"""
support_db_hr_assistant.py
───────────────────────────────────────────────────────────────────────────────
Assembles the real, token-scoped HR snapshot the mobile HR Assistant chatbot
answers from — salary (last processed payroll), this-month attendance, this-
year leave usage, and overtime status.

Deliberately does NOT introduce any new source of truth. Every number here
is read through the SAME functions the Leave/Overtime/Attendance/Payroll
screens already call:

    salary      -> get_own_salary_snapshot (support_db_payroll)      [new, see below]
    attendance  -> get_client_staff_attendance_history (support_db_attendance_dashboard)
    leave       -> list_client_leave_requests (support_db_payroll)
    overtime    -> list_client_overtime_requests (support_db_payroll)

so the chatbot's answer can never disagree with what the same employee sees
on their own Leave/Overtime/Attendance tabs.

Two things this module explicitly does NOT fabricate, per product decision:
  - Leave "total entitlement" / "remaining" — no leave-quota system exists
    yet (see payroll_policy_overrides for the pattern a future one should
    follow). Only real usage (approved/pending days, this calendar year,
    per leave_type) is returned.
  - Performance rating — no such data exists anywhere in this schema.
    Not included in the context at all; the Flutter quick-action for it
    has been removed to match.

org_id/branch_id/staff_id must always come from the caller's verified JWT
(g.client_staff in the route layer) — this module takes them as plain
arguments and does no auth itself, same division of responsibility as
every other support_db_* module.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from calendar import monthrange

from support_db_staff import get_client_staff_member
from support_db_payroll import (
    get_own_salary_snapshot,
    list_client_overtime_requests,
)
# list_client_leave_requests lives in the main support_db module (same
# function client_staff_leave_routes.py calls as support_cp_db.list_client_leave_requests)
# -- NOT in support_db_payroll, which only owns the leave *write*/status
# helpers (create/get_owned_by_org/update_status/delete). Importing it from
# support_db_payroll raises ImportError at blueprint-load time in app.py,
# which Flask surfaces to callers as a 405 on /api/staff/hr-assistant/message
# (the blueprint never registers, so the URL falls through to whatever
# other rule matches the prefix).
from support_db import list_client_leave_requests
from support_db_attendance_dashboard import get_client_staff_attendance_history


# ─── Attendance (this calendar month) ───────────────────────────────────────

def _weekday_count_elapsed(today: date) -> int:
    """Mon–Fri count from the 1st of this month through today, inclusive.
    Used as the 'expected working days so far' denominator — a dynamic,
    date-aware replacement for the fixed '22 working days' constant the
    Flutter screens currently hardcode (office_home_screen.dart /
    profile_screen.dart), which over/under-counts depending on what day
    of the month it actually is."""
    first = today.replace(day=1)
    count = 0
    d = first
    while d <= today:
        if d.weekday() < 5:  # Mon=0 .. Fri=4
            count += 1
        d = date.fromordinal(d.toordinal() + 1)
    return count


def _monthly_attendance_summary(org_id: str, staff_id: str) -> dict:
    """Present-day count for the current calendar month, from the SAME
    /history rows the Attendance tab and Profile tab already fetch
    (get_client_staff_attendance_history) — one row per staff per day
    (mark_client_staff_attendance upserts, it doesn't insert a second row
    for a same-day checkout), so counting distinct 'date' values is the
    same technique profile_screen.dart already uses for the office path.

    limit=60 comfortably covers the current month plus buffer regardless
    of which day of the month 'today' is.
    """
    today = date.today()
    month_prefix = today.strftime('%Y-%m')

    try:
        logs = get_client_staff_attendance_history(org_id=org_id, staff_id=staff_id, limit=60) or []
    except Exception:
        logs = []

    present_dates = {
        str(row.get('date'))
        for row in logs
        if str(row.get('date') or '').startswith(month_prefix)
    }
    present_count = len(present_dates)
    working_days_elapsed = _weekday_count_elapsed(today)
    absent_count = max(0, working_days_elapsed - present_count)
    rate = round((present_count / working_days_elapsed) * 100) if working_days_elapsed else 0

    return {
        'month_label': today.strftime('%B %Y'),
        'present_days': present_count,
        'working_days_elapsed': working_days_elapsed,
        'absent_days': absent_count,
        'attendance_rate_pct': rate,
    }


# ─── Leave (this calendar year, usage only — no quota exists) ──────────────

def _leave_days_for_row(row: dict, year_start: date, year_end: date) -> float:
    is_half_day = bool(row.get('half_day_period'))
    if is_half_day:
        return 0.5
    try:
        start = date.fromisoformat(str(row.get('start_date')))
        end = date.fromisoformat(str(row.get('end_date')))
    except (TypeError, ValueError):
        return 0.0
    overlap_start, overlap_end = max(start, year_start), min(end, year_end)
    if overlap_start > overlap_end:
        return 0.0
    return (overlap_end - overlap_start).days + 1


def _leave_usage_summary(org_id: str, staff_id: str) -> dict:
    """Real leave usage this calendar year, grouped by leave_type and
    status — approved days actually taken, and pending days awaiting a
    decision. Deliberately has no 'total'/'remaining' field: there is
    nothing to subtract from (see module docstring)."""
    today = date.today()
    year_start, year_end = date(today.year, 1, 1), today

    try:
        rows = list_client_leave_requests(org_id=org_id, user_id=staff_id) or []
    except Exception:
        rows = []

    by_type: dict[str, dict] = {}
    for row in rows:
        status = str(row.get('status') or '').strip().lower()
        if status not in ('approved', 'pending'):
            continue
        days = _leave_days_for_row(row, year_start, year_end)
        if days <= 0:
            continue
        leave_type = str(row.get('leave_type') or 'annual').strip().title()
        bucket = by_type.setdefault(leave_type, {'approved_days': 0.0, 'pending_days': 0.0})
        bucket['approved_days' if status == 'approved' else 'pending_days'] += days

    return {
        'year': today.year,
        'by_type': by_type,
        'total_approved_days': round(sum(b['approved_days'] for b in by_type.values()), 1),
        'total_pending_days': round(sum(b['pending_days'] for b in by_type.values()), 1),
    }


# ─── Overtime (live request status, not the last-processed payroll figure) ─

def _overtime_summary(org_id: str, staff_id: str, ot_rate: float) -> dict:
    """Live overtime_requests status — distinct from salary snapshot's
    overtime_amount, which reflects whatever was on the LAST PROCESSED
    payroll row (an admin-entered figure, possibly stale). This is what
    the employee actually filed for, same source as the Overtime tab."""
    try:
        rows = list_client_overtime_requests(org_id=org_id, user_id=staff_id) or []
    except Exception:
        rows = []

    approved_hours = 0.0
    pending_hours = 0.0
    pending_count = 0
    for row in rows:
        status = str(row.get('status') or '').strip().lower()
        hours = float(row.get('hours') or 0)
        if status == 'approved':
            approved_hours += hours
        elif status == 'pending':
            pending_hours += hours
            pending_count += 1

    return {
        'approved_hours': round(approved_hours, 2),
        'pending_hours': round(pending_hours, 2),
        'pending_count': pending_count,
        'approved_pay': round(approved_hours * ot_rate, 2) if ot_rate else 0.0,
    }


# ─── Top-level assembly ─────────────────────────────────────────────────────

def build_hr_assistant_context(org_id: str, branch_id: str | None, staff_id: str) -> dict:
    """Everything the HR Assistant needs for one reply, scoped entirely to
    (org_id, staff_id) from the caller's verified JWT. Never accepts these
    ids from anywhere else — see client_staff_hr_assistant_routes.py."""
    staff = get_client_staff_member(staff_id) or {}
    salary = get_own_salary_snapshot(org_id, staff_id)
    attendance = _monthly_attendance_summary(org_id, staff_id)
    leave = _leave_usage_summary(org_id, staff_id)
    overtime = _overtime_summary(org_id, staff_id, salary.get('ot_rate', 0.0))

    return {
        'staff': {
            'name': staff.get('name') or 'Employee',
            'employee_id': staff.get('employee_id') or staff_id,
            'department': staff.get('department_name') or staff.get('department') or 'N/A',
            'role': staff.get('role') or 'staff',
            'staff_type': staff.get('staff_type') or 'office',
        },
        'salary': salary,
        'attendance': attendance,
        'leave': leave,
        'overtime': overtime,
    }