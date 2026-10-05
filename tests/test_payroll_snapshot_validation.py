from datetime import date

from payroll_engine import (
    compute_payroll_breakdown,
    is_complete_breakdown_snapshot,
)


def _snapshot():
    return compute_payroll_breakdown(
        base_salary=50_000,
        ot_hours=0,
        ot_rate_per_hour=0,
        period_start=date(2026, 10, 1),
        period_end=date(2026, 10, 31),
        policy={
            "payrollWeeklyOffDays": ["sunday"],
            "payrollWeeklyOffDaysEffectiveFrom": "2026-01",
            "payrollCalendarsByMonth": {},
            "lateComingPolicy": {"mode": "none"},
            "leaveTypeRules": {},
        },
        attendance_rows=[{"date": "2026-10-01", "checkInStatus": "on_time"}],
        leave_rows=[],
    ).to_dict()


def test_complete_paid_breakdown_snapshot_is_kept():
    assert is_complete_breakdown_snapshot(_snapshot())


def test_incomplete_or_zero_workday_snapshot_is_ignored():
    incomplete = _snapshot()
    del incomplete["scheduled_work_days"]
    assert not is_complete_breakdown_snapshot(incomplete)

    zero_workdays = _snapshot()
    zero_workdays["scheduled_work_days"] = 0
    assert not is_complete_breakdown_snapshot(zero_workdays)
