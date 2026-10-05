from payroll_trends import aggregate_paid_payroll_monthly_trends


def test_paid_payroll_trends_keep_snapshot_branch_after_staff_transfer():
    rows = aggregate_paid_payroll_monthly_trends(
        [
            {
                "staff_id": "staff-1",
                "period_start": "2026-09-01",
                "breakdown": {
                    "net_pay": 45000,
                    "snapshot_branch_id": "branch-old",
                },
            },
            {
                "staff_id": "staff-1",
                "period_start": "2026-10-01",
                "breakdown": {
                    "net_pay": 50000,
                    "snapshot_branch_id": "branch-new",
                },
            },
        ],
        [
            {
                "id": "staff-1",
                "branch_id": "branch-new",
                "people_type": "staff",
                "department": "Administration",
                "name": "A Staff Member",
            }
        ],
        month_keys=["2026-09", "2026-10"],
        people_type="staff",
        department="Administration",
    )

    assert rows == [
        {"month": "2026-09", "branch_id": "branch-old", "payroll": 45000},
        {"month": "2026-10", "branch_id": "branch-new", "payroll": 50000},
    ]


def test_paid_payroll_trends_apply_search_department_and_amount_filters():
    rows = aggregate_paid_payroll_monthly_trends(
        [
            {
                "staff_id": "staff-1",
                "period_start": "2026-10-01",
                "breakdown": {"net_pay": 45000, "snapshot_branch_id": "branch-1"},
            },
            {
                "staff_id": "staff-2",
                "period_start": "2026-10-01",
                "breakdown": {"net_pay": 70000, "snapshot_branch_id": "branch-1"},
            },
        ],
        [
            {
                "id": "staff-1",
                "branch_id": "branch-1",
                "people_type": "staff",
                "department": "Administration",
                "name": "A Staff Member",
            },
            {
                "id": "staff-2",
                "branch_id": "branch-1",
                "people_type": "staff",
                "department": "Sales",
                "name": "Another Staff Member",
            },
        ],
        month_keys=["2026-10"],
        branch_id="branch-1",
        people_type="staff",
        department="Administration",
        search="A Staff",
        amount_operator="gt",
        amount_value=40000,
    )

    assert rows == [
        {"month": "2026-10", "branch_id": "branch-1", "payroll": 45000}
    ]
