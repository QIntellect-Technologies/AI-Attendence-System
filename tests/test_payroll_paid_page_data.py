from datetime import date, timedelta
from types import SimpleNamespace

import supabase_client

if not hasattr(supabase_client, "reset_supabase_client"):
    supabase_client.reset_supabase_client = lambda: None

import support_db_payroll as payroll_db


class PaymentQuery:
    def __init__(self, rows, query_record):
        self.rows = rows
        self.query_record = query_record

    def select(self, columns):
        self.query_record["columns"] = columns
        return self

    def eq(self, field, value):
        self.query_record.setdefault("filters", []).append((field, value))
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class PaymentClient:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []

    def table(self, table_name):
        assert table_name == "payroll_payments"
        query_record = {}
        self.queries.append(query_record)
        return PaymentQuery(self.rows, query_record)


def test_paid_payroll_page_data_uses_one_query_and_keeps_incomplete_paid_rows(
    monkeypatch,
):
    client = PaymentClient(
        [
            {
                "staff_id": "paid-with-snapshot",
                "breakdown": {"complete": True, "base_salary": 52000},
            },
            {
                "staff_id": "paid-old-snapshot",
                "breakdown": {"partial": True, "base_salary": 48000},
            },
            {"staff_id": "paid-without-snapshot", "breakdown": None},
        ]
    )
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )
    monkeypatch.setattr(
        payroll_db.payroll_engine,
        "is_complete_breakdown_snapshot",
        lambda snapshot: snapshot.get("complete") is True,
    )

    paid_staff_ids, snapshots, salary_snapshots = payroll_db.get_paid_payroll_page_data(
        "org-1", "2026-10-01", "2026-10-31",
    )

    assert len(client.queries) == 1
    assert client.queries[0]["columns"] == "staff_id, breakdown"
    assert client.queries[0]["filters"] == [
        ("org_id", "org-1"),
        ("period_start", "2026-10-01"),
        ("period_end", "2026-10-31"),
    ]
    assert paid_staff_ids == {
        "paid-with-snapshot",
        "paid-old-snapshot",
        "paid-without-snapshot",
    }
    assert snapshots == {
        "paid-with-snapshot": {"complete": True, "base_salary": 52000},
    }
    assert salary_snapshots == {
        "paid-with-snapshot": 52000,
        "paid-old-snapshot": 48000,
    }


def test_breakdown_cache_is_limited_to_closed_paid_rows_with_snapshots():
    closed_period_end = date.today() - timedelta(days=1)
    paid_staff_ids = {"staff-1"}

    assert not payroll_db._can_cache_payroll_breakdown(
        closed_period_end,
        ["staff-1"],
        set(),
        {},
    )
    assert not payroll_db._can_cache_payroll_breakdown(
        closed_period_end,
        ["staff-1"],
        paid_staff_ids,
        {},
    )
    assert payroll_db._can_cache_payroll_breakdown(
        closed_period_end,
        ["staff-1"],
        paid_staff_ids,
        {"staff-1": {"late_count": 2}},
    )
    assert not payroll_db._can_cache_payroll_breakdown(
        date.today(),
        ["staff-1"],
        paid_staff_ids,
        {"staff-1": {"late_count": 2}},
    )
