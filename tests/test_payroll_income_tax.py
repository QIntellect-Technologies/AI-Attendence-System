from datetime import date

from payroll_engine import compute_payroll_breakdown


def test_income_tax_slab_is_included_in_total_deductions():
    result = compute_payroll_breakdown(
        base_salary=150_000,
        ot_hours=0,
        ot_rate_per_hour=0,
        period_start=date(2024, 2, 1),
        period_end=date(2024, 2, 5),
        policy={
            "perDayRateBasis": "scheduled_days",
            "payrollCalendarsByMonth": {
                "2024-02": {
                    "weeklyOffDays": ["sunday"],
                    "holidayDates": ["2024-02-02"],
                }
            },
            "lateComingPolicy": {"mode": "none"},
            "incomeTaxEnabled": True,
            "incomeTaxSlabs": [
                {"lowerLimit": 0, "upperLimit": 600_000, "baseTax": 0, "rate": 0},
                {
                    "lowerLimit": 600_000,
                    "upperLimit": 1_200_000,
                    "baseTax": 0,
                    "rate": 1,
                },
                {
                    "lowerLimit": 1_200_000,
                    "upperLimit": 2_200_000,
                    "baseTax": 6_000,
                    "rate": 11,
                },
                {
                    "lowerLimit": 2_200_000,
                    "upperLimit": None,
                    "baseTax": 116_000,
                    "rate": 20,
                },
            ],
        },
        attendance_rows=[
            {"date": "2024-02-01", "checkInStatus": "on_time"},
            {"date": "2024-02-03", "checkInStatus": "on_time"},
            {"date": "2024-02-05", "checkInStatus": "on_time"},
        ],
        leave_rows=[],
        monthly_gross_salary=175_000,
    )

    assert result.income_tax_amount == 8_750
    assert result.total_deductions == 8_750
    assert result.net_pay == 141_250
