from datetime import date

import payroll_engine
from payroll_engine import compute_payroll_breakdown


def _policy(**overrides):
    policy = {
        'perDayRateBasis': 'scheduled_days',
        'payrollCalendarsByMonth': {
            '2024-02': {
                'weeklyOffDays': ['sunday'],
                'holidayDates': ['2024-02-02'],
            },
        },
        'lateComingPolicy': {'mode': 'none'},
        'leaveTypeRules': {'annual': 'paid'},
    }
    policy.update(overrides)
    return policy


def _breakdown(
    *,
    attendance_rows=None,
    leave_rows=None,
    policy=None,
    period_end=date(2024, 2, 5),
):
    return compute_payroll_breakdown(
        base_salary=24_000,
        ot_hours=0,
        ot_rate_per_hour=0,
        period_start=date(2024, 2, 1),
        period_end=period_end,
        policy=policy or _policy(),
        attendance_rows=attendance_rows or [],
        leave_rows=leave_rows or [],
    )


def test_scheduled_day_rate_and_missing_workday_absence():
    result = _breakdown()

    assert result.scheduled_work_days == 3
    assert result.per_day_rate == 1_000
    assert result.absent_days == 3
    assert result.absence_deduction_amount == 3_000
    assert result.net_pay == 21_000


def test_month_working_dates_reuse_payroll_calendar_rules():
    working_dates = payroll_engine.scheduled_work_dates_for_month(
        '2024-02',
        _policy(),
    )

    assert len(working_dates) == 24
    assert '2024-02-02' not in working_dates
    assert all(date.fromisoformat(day).weekday() != 6 for day in working_dates)


def test_month_working_dates_use_people_type_calendar_without_changing_payroll_calendar():
    policy = _policy(
        workingDayCalendarsByPeopleType={
            'student': {
                'weeklyOffDays': ['saturday', 'sunday'],
                'weeklyOffDaysEffectiveFrom': '2024-02',
                'calendarsByMonth': {
                    '2024-02': {
                        'holidayDates': ['2024-02-05'],
                    },
                },
            },
        },
    )

    student_dates = payroll_engine.scheduled_work_dates_for_month(
        '2024-02',
        policy,
        people_type='student',
    )
    staff_dates = payroll_engine.scheduled_work_dates_for_month(
        '2024-02',
        policy,
        people_type='staff',
    )

    assert len(student_dates) == 20
    assert '2024-02-05' not in student_dates
    assert all(date.fromisoformat(day).weekday() not in {5, 6} for day in student_dates)
    assert len(staff_dates) == 24


def test_payroll_breakdown_uses_people_type_calendar():
    policy = _policy(
        workingDayCalendarsByPeopleType={
            'student': {
                'weeklyOffDays': ['saturday', 'sunday'],
                'weeklyOffDaysEffectiveFrom': '2024-02',
                'calendarsByMonth': {
                    '2024-02': {
                        'holidayDates': ['2024-02-05'],
                    },
                },
            },
        },
    )
    common = {
        'base_salary': 24_000,
        'ot_hours': 0,
        'ot_rate_per_hour': 0,
        'period_start': date(2024, 2, 1),
        'period_end': date(2024, 2, 29),
        'policy': policy,
        'attendance_rows': [],
        'leave_rows': [],
    }

    student_result = compute_payroll_breakdown(
        **common,
        people_type='student',
    )
    staff_result = compute_payroll_breakdown(**common, people_type='staff')

    assert student_result.scheduled_work_days == 20
    assert staff_result.scheduled_work_days == 24


def test_weekly_off_day_and_holiday_are_not_absences():
    result = _breakdown(
        attendance_rows=[
            {'date': '2024-02-01', 'checkInStatus': 'on_time'},
            {'date': '2024-02-02', 'checkInStatus': 'on_time'},
            {'date': '2024-02-04', 'checkInStatus': 'on_time'},
        ],
    )

    assert result.absent_days == 2
    assert result.absence_deduction_amount == 2_000


def test_current_period_absences_only_count_scheduled_days_through_today(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return date(2024, 2, 3)

    monkeypatch.setattr(payroll_engine, 'date', FixedDate)
    result = _breakdown(
        attendance_rows=[{'date': '2024-02-01', 'checkInStatus': 'on_time'}],
        period_end=date(2024, 2, 29),
    )

    assert result.scheduled_work_days == 24
    assert result.absent_days == 1
    assert result.absence_deduction_amount == 1_000


def test_current_period_absences_exclude_future_days_holidays_and_weekly_offs(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return date(2024, 2, 4)

    monkeypatch.setattr(payroll_engine, 'date', FixedDate)
    result = _breakdown(
        period_end=date(2024, 2, 29),
    )

    assert result.absent_days == 2


def test_deductions_only_include_scheduled_attendance_and_leave_through_today(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return date(2024, 2, 3)

    monkeypatch.setattr(payroll_engine, 'date', FixedDate)
    policy = _policy(
        lateComingPolicy={
            'mode': 'occurrence_threshold',
            'thresholdOccurrences': 1,
        },
        leaveTypeRules={'annual': 'unpaid'},
    )
    attendance_rows = [
        {'date': '2024-02-03', 'checkInStatus': 'late', 'dayStatus': 'half_day'},
        {'date': '2024-02-02', 'checkInStatus': 'late', 'dayStatus': 'half_day'},
        {'date': '2024-02-04', 'checkInStatus': 'late', 'dayStatus': 'half_day'},
        {'date': '2024-02-05', 'checkInStatus': 'late', 'dayStatus': 'short_leave'},
    ]

    result = _breakdown(
        attendance_rows=attendance_rows,
        leave_rows=[
            {'leaveType': 'annual', 'days': 1, 'dates': ['2024-02-05']},
        ],
        policy=policy,
        period_end=date(2024, 2, 29),
    )

    assert result.late_count == 2
    # The holiday late arrival is reported, but only the scheduled-day late
    # arrival contributes to the payroll deduction.
    assert result.late_deduction_amount == result.per_day_rate
    assert result.half_day_attendance_count == 1
    assert result.half_day_deduction_amount == result.per_day_rate * 0.5
    assert result.short_leave_attendance_count == 0
    assert result.short_leave_deduction_amount == 0
    assert result.unpaid_leave_days == 0


def test_approved_paid_leave_prevents_absence_deduction():
    result = _breakdown(
        attendance_rows=[{'date': '2024-02-01', 'checkInStatus': 'on_time'}],
        leave_rows=[{'leaveType': 'annual', 'days': 1, 'dates': ['2024-02-03']}],
    )

    assert result.absent_days == 1
    assert result.absence_deduction_amount == 1_000
    assert result.net_pay == 23_000


def test_unpaid_leave_is_not_double_deducted_as_absence():
    policy = _policy(leaveTypeRules={'annual': 'unpaid'})
    result = _breakdown(
        attendance_rows=[{'date': '2024-02-01', 'checkInStatus': 'on_time'}],
        leave_rows=[{'leaveType': 'annual', 'days': 1, 'dates': ['2024-02-03']}],
        policy=policy,
    )

    assert result.absent_days == 1
    assert result.unpaid_leave_days == 1
    assert result.total_deductions == 2_000
    assert result.net_pay == 22_000


def test_missing_month_calendar_defaults_to_sunday_off():
    result = _breakdown(
        attendance_rows=[{'date': '2024-02-01', 'checkInStatus': 'on_time'}],
        leave_rows=[{'leaveType': 'annual', 'days': 1, 'dates': ['2024-02-03']}],
        policy=_policy(payrollCalendarsByMonth={}),
    )

    assert result.per_day_rate == 24_000 / 25


def test_legacy_single_weekly_off_day_remains_supported():
    result = _breakdown(
        policy=_policy(
            payrollCalendarsByMonth={
                '2024-02': {'weeklyOffDay': 'friday', 'holidayDates': []},
            },
        ),
    )

    assert result.scheduled_work_days == 4


def test_month_calendar_can_configure_monday_as_weekly_off():
    result = _breakdown(
        policy=_policy(
            payrollCalendarsByMonth={
                '2024-02': {'weeklyOffDays': ['monday'], 'holidayDates': []},
            },
        ),
    )

    assert result.scheduled_work_days == 4
    assert result.per_day_rate == 24_000 / 25


def test_multiple_weekly_off_days_are_excluded():
    result = _breakdown(
        policy=_policy(
            payrollCalendarsByMonth={
                '2024-02': {
                    'weeklyOffDays': ['saturday', 'sunday'],
                    'holidayDates': [],
                },
            },
        ),
    )

    assert result.scheduled_work_days == 3


def test_late_arrival_threshold_deducts_one_full_day_per_threshold():
    policy = _policy(
        lateComingPolicy={
            'mode': 'occurrence_threshold',
            'thresholdOccurrences': 3,
        },
    )
    attendance_rows = [
        {'date': '2024-02-01', 'checkInStatus': 'late'},
        {'date': '2024-02-03', 'checkInStatus': 'late'},
        {'date': '2024-02-05', 'checkInStatus': 'late'},
    ]

    result = _breakdown(attendance_rows=attendance_rows, policy=policy)

    assert result.late_count == 3
    assert result.late_deduction_days == 1
    assert result.late_deduction_amount == result.per_day_rate


def test_current_month_single_late_arrival_deducts_at_threshold_one():
    result = compute_payroll_breakdown(
        base_salary=3_000,
        ot_hours=0,
        ot_rate_per_hour=0,
        period_start=date(2026, 10, 1),
        period_end=date(2026, 10, 31),
        policy={
            'perDayRateBasis': 'scheduled_days',
            'payrollWeeklyOffDays': ['sunday'],
            'lateComingPolicy': {
                'mode': 'occurrence_threshold',
                'thresholdOccurrences': 1,
            },
        },
        attendance_rows=[
            {
                'date': '2026-10-03',
                'checkInStatus': 'late',
                'dayStatus': 'present',
                'captureChannel': 'manual',
            },
        ],
        leave_rows=[],
    )

    assert result.late_count == 1
    assert result.late_deduction_days == 1
    assert result.late_deduction_amount == result.per_day_rate


def test_fixed_late_arrival_rate_is_applied_for_each_included_late_checkin():
    result = _breakdown(
        attendance_rows=[
            {'date': '2024-02-01', 'checkInStatus': 'late'},
            {'date': '2024-02-03', 'checkInStatus': 'late'},
        ],
        policy=_policy(
            lateComingPolicy={
                'mode': 'flat_per_occurrence',
                'flatAmountPerOccurrence': 500,
            },
        ),
    )

    assert result.late_count == 2
    assert result.late_deduction_amount == 1_000


def test_late_arrival_threshold_counts_only_complete_groups():
    policy = _policy(
        lateComingPolicy={
            'mode': 'occurrence_threshold',
            'thresholdOccurrences': 3,
        },
    )
    attendance_rows = [
        {'date': '2024-02-01', 'checkInStatus': 'late'},
        {'date': '2024-02-03', 'checkInStatus': 'late'},
        {'date': '2024-02-05', 'checkInStatus': 'late'},
    ]

    result = _breakdown(
        attendance_rows=[*attendance_rows, {'date': '2024-02-06', 'checkInStatus': 'late'}],
        policy=policy,
        period_end=date(2024, 2, 6),
    )

    assert result.late_count == 4
    assert result.late_deduction_days == 1


def test_pending_late_decisions_follow_capture_channel_and_exclude_resolved_rows(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return date(2024, 2, 5)

    monkeypatch.setattr(payroll_engine, 'date', FixedDate)
    result = _breakdown(
        attendance_rows=[
            {
                'attendanceId': 'mobile-pending',
                'date': '2024-02-01',
                'checkInStatus': 'late',
                'dayStatus': 'late',
                'captureChannel': 'mobile_app',
            },
            {
                'attendanceId': 'mobile-excluded',
                'date': '2024-02-01',
                'checkInStatus': 'late',
                'dayStatus': 'late',
                'checkInPayrollDecision': 'exclude',
                'captureChannel': 'mobile_app',
            },
            {
                'attendanceId': 'mobile-unresolved',
                'date': '2024-02-01',
                'checkInStatus': 'late',
                'dayStatus': 'present',
                'captureChannel': 'mobile_app',
            },
            {
                'attendanceId': 'node-excluded',
                'date': '2024-02-01',
                'dayStatus': 'late',
                'checkOutPayrollDecision': 'exclude',
                'captureChannel': 'local_node',
            },
            {
                'attendanceId': 'node-pending',
                'date': '2024-02-01',
                'dayStatus': 'late',
                'captureChannel': 'local_node',
            },
        ],
        policy=_policy(
            lateComingPolicy={
                'mode': 'occurrence_threshold',
                'thresholdOccurrences': 1,
            },
        ),
    )

    assert result.late_count == 0
    assert result.pending_late_decisions == [
        {'attendance_id': 'mobile-pending', 'date': '2024-02-01'},
        {'attendance_id': 'node-pending', 'date': '2024-02-01'},
    ]
    assert result.late_deduction_amount == 0


def test_pending_late_decisions_are_not_deducted_until_explicitly_included(monkeypatch):
    class FixedDate(date):
        @classmethod
        def today(cls):
            return date(2024, 2, 5)

    monkeypatch.setattr(payroll_engine, 'date', FixedDate)
    attendance_row = {
        'attendanceId': 'mobile-pending',
        'date': '2024-02-01',
        'checkInStatus': 'late',
        'captureChannel': 'mobile_app',
    }
    policy = _policy(
        lateComingPolicy={
            'mode': 'occurrence_threshold',
            'thresholdOccurrences': 1,
        },
    )

    pending_result = _breakdown(attendance_rows=[attendance_row], policy=policy)
    included_result = _breakdown(
        attendance_rows=[
            {**attendance_row, 'checkInPayrollDecision': 'include'},
        ],
        policy=policy,
    )

    assert pending_result.late_count == 0
    assert pending_result.late_deduction_amount == 0
    assert included_result.late_count == 1
    assert included_result.late_deduction_amount == included_result.per_day_rate


def test_recurring_weekly_off_days_apply_to_months_without_month_specific_holidays():
    result = _breakdown(
        policy=_policy(
            payrollWeeklyOffDays=['saturday', 'sunday'],
            payrollCalendarsByMonth={},
        ),
    )

    assert result.scheduled_work_days == 3


def test_month_specific_holidays_use_recurring_weekly_off_days():
    result = _breakdown(
        policy=_policy(
            payrollWeeklyOffDays=['friday'],
            payrollCalendarsByMonth={
                '2024-02': {'holidayDates': ['2024-02-01']},
            },
        ),
    )

    assert result.scheduled_work_days == 3


def test_recurring_schedule_does_not_rewrite_months_before_its_effective_date():
    result = _breakdown(
        policy=_policy(
            payrollWeeklyOffDays=['sunday'],
            payrollWeeklyOffDaysEffectiveFrom='2024-03',
            payrollCalendarsByMonth={
                '2024-02': {
                    'weeklyOffDays': ['friday'],
                    'holidayDates': ['2024-02-02'],
                },
            },
        ),
    )

    assert result.scheduled_work_days == 4
