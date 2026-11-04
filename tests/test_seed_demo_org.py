from datetime import date

from seed_demo_org import build_dataset, summarize, verify_dataset


def test_demo_seed_payslips_include_present_late_and_tax_without_unpaid_leave():
    dataset = build_dataset(
        lambda password: f"hash:{password}",
        window=(date(2026, 5, 1), date(2026, 6, 30)),
    )

    assert verify_dataset(dataset) == []
    assert "income_tax" in {row["module_name"] for row in dataset.modules}
    assert all(
        row["leave_type"] != "Leave Without Pay"
        for row in dataset.leave_requests
    )

    payroll_breakdowns = [row["breakdown"] for row in dataset.payroll]
    assert any(item["attendance"]["present_days"] > 0 for item in payroll_breakdowns)
    assert any(item["attendance"]["late_days"] > 0 for item in payroll_breakdowns)
    assert any(item["deductions"]["income_tax"] > 0 for item in payroll_breakdowns)
    assert all("unpaid_leave_days" not in row for row in dataset.payroll)
    assert all(
        "unpaid_leave_days" not in item["attendance"]
        and "unpaid_leave" not in item["deductions"]
        for item in payroll_breakdowns
    )

    periods = summarize(dataset)["payroll_periods"]
    assert all(period["income_tax"] > 0 for period in periods)
    assert all(period["taxed_payslips"] > 0 for period in periods)
    assert all("unpaid_leave_days" not in period for period in periods)
