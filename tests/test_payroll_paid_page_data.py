from datetime import date, timedelta
from types import SimpleNamespace

import supabase_client
import pytest

if not hasattr(supabase_client, "reset_supabase_client"):
    supabase_client.reset_supabase_client = lambda: None

import support_db_payroll as payroll_db


class PaymentQuery:
    def __init__(self, rows, query_record, client=None):
        self.rows = rows
        self.query_record = query_record
        self.client = client
        self.selected_columns = None
        self.predicates = []
        self.upsert_payload = None

    def select(self, columns):
        self.query_record["columns"] = columns
        self.selected_columns = [
            column.strip() for column in columns.split(",")
        ]
        return self

    def eq(self, field, value):
        self.query_record.setdefault("filters", []).append((field, value))
        self.predicates.append(("eq", field, value))
        return self

    def gte(self, field, value):
        self.query_record.setdefault("range_filters", []).append(
            ("gte", field, value)
        )
        self.predicates.append(("gte", field, value))
        return self

    def lt(self, field, value):
        self.query_record.setdefault("range_filters", []).append(
            ("lt", field, value)
        )
        self.predicates.append(("lt", field, value))
        return self

    def upsert(self, payload, on_conflict):
        self.query_record["upsert"] = payload
        self.query_record["on_conflict"] = on_conflict
        self.upsert_payload = payload
        return self

    def execute(self):
        if (
            self.upsert_payload is not None
            and self.client is not None
            and self.client.persist_upserts
        ):
            conflict_fields = self.query_record["on_conflict"].split(",")
            existing = next(
                (
                    row
                    for row in self.rows
                    if all(
                        row.get(field) == self.upsert_payload.get(field)
                        for field in conflict_fields
                    )
                ),
                None,
            )
            if existing is None:
                self.rows.append(dict(self.upsert_payload))
            else:
                existing.update(self.upsert_payload)

        matching_rows = [
            row
            for row in self.rows
            if all(
                (row.get(field) == value)
                if operation == "eq"
                else (
                    row.get(field) >= value
                    if operation == "gte"
                    else row.get(field) < value
                )
                for operation, field, value in self.predicates
            )
        ]
        if self.selected_columns is not None:
            matching_rows = [
                {
                    column: row[column]
                    for column in self.selected_columns
                    if column in row
                }
                for row in matching_rows
            ]
        return SimpleNamespace(data=matching_rows)


class PaymentClient:
    def __init__(self, rows, persist_upserts=True):
        self.rows = rows
        self.queries = []
        self.persist_upserts = persist_upserts

    def table(self, table_name):
        assert table_name == "payroll_payments"
        query_record = {}
        self.queries.append(query_record)
        return PaymentQuery(self.rows, query_record, self)


def test_paid_payroll_page_data_uses_one_query_and_keeps_incomplete_paid_rows(
    monkeypatch,
):
    client = PaymentClient(
        [
            {
                "staff_id": "paid-with-snapshot",
                "org_id": "org-1",
                "period_start": "2026-10-01",
                "period_end": "2026-10-31",
                "breakdown": {"complete": True, "base_salary": 52000},
            },
            {
                "staff_id": "paid-old-snapshot",
                "org_id": "org-1",
                "period_start": "2026-10-01",
                "period_end": "2026-10-31",
                "breakdown": {"partial": True, "base_salary": 48000},
            },
            {
                "staff_id": "paid-without-snapshot",
                "org_id": "org-1",
                "period_start": "2026-10-01",
                "period_end": "2026-10-31",
                "breakdown": None,
            },
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
    assert client.queries[0]["columns"] == (
        "staff_id, breakdown, period_start, period_end"
    )
    assert client.queries[0]["filters"] == [
        ("org_id", "org-1"),
    ]
    assert client.queries[0]["range_filters"] == [
        ("gte", "period_start", "2026-10-01"),
        ("lt", "period_start", "2026-11-01"),
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


def test_paid_payroll_row_uses_saved_compensation_instead_of_current_policy():
    row = payroll_db._payroll_page_row(
        "org-1",
        {
            "id": "staff-1",
            "name": "Example",
            "branch_id": "branch-1",
            "salary": 50000,
        },
        {},
        {},
        salary_config={
            "basic_salary": 50000,
            "allowances": 999,
            "applied_allowances": {"housing": {"enabled": True}},
        },
        breakdown={
            "base_salary": 50000,
            "overtime_hours": 4,
            "overtime_amount": 200,
            "total_deductions": 800,
            "compensation_snapshot": {
                "manual_allowance": 100,
                "applied_allowances": {"travel": {"enabled": True}},
                "allowances_breakdown": [
                    {
                        "key": "travel",
                        "label": "Travel",
                        "mode": "fixed",
                        "value": 1100,
                        "amount": 1100,
                    }
                ],
                "allowances": 1200,
                "effective_ot_rate": 50,
                "present_days": 19,
            },
        },
        present_days=25,
        paid_staff_ids={"staff-1"},
        effective_ot_rate=900,
        policy={
            "allowanceTypes": {
                "housing": {"label": "Housing", "mode": "fixed", "value": 9000},
            },
        },
    )

    assert row["status"] == "Paid"
    assert row["allowances"] == 1200
    assert row["manual_allowance"] == 100
    assert row["applied_allowances"] == {"travel": {"enabled": True}}
    assert row["allowances_breakdown"][0]["amount"] == 1100
    assert row["effective_ot_rate"] == 50
    assert row["present_days"] == 19
    assert row["net_pay"] == 50600


def test_paid_payroll_row_without_snapshot_does_not_apply_current_policy():
    row = payroll_db._payroll_page_row(
        "org-1",
        {
            "id": "staff-1",
            "name": "Example",
            "branch_id": "branch-1",
            "salary": 50000,
        },
        {},
        {},
        salary_config={
            "basic_salary": 50000,
            "allowances": 300,
            "applied_allowances": {"housing": {"enabled": True}},
            "ot_hours": 4,
        },
        paid_staff_ids={"staff-1"},
        effective_ot_rate=900,
        policy={
            "allowanceTypes": {
                "housing": {"label": "Housing", "mode": "fixed", "value": 9000},
            },
        },
    )

    assert row["status"] == "Paid"
    assert row["allowances"] == 300
    assert row["allowances_breakdown"] == []
    assert row["effective_ot_rate"] == 0
    assert row["overtime_amount"] == 0
    assert row["net_pay"] == 50300


def test_mark_payroll_paid_verifies_the_saved_staff_and_period(monkeypatch):
    client = PaymentClient([])
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )

    payroll_db.mark_payroll_paid(
        "org-1",
        "staff-1",
        "2026-10-01",
        "2026-10-31",
    )

    assert len(client.rows) == 1
    assert {
        field: client.rows[0][field]
        for field in ("org_id", "staff_id", "period_start", "period_end")
    } == {
        "org_id": "org-1",
        "staff_id": "staff-1",
        "period_start": "2026-10-01",
        "period_end": "2026-10-31",
    }
    verification_query = client.queries[-1]
    assert verification_query["columns"] == (
        "staff_id, period_start, period_end"
    )
    assert verification_query["filters"] == [("org_id", "org-1")]
    assert verification_query["range_filters"] == [
        ("gte", "period_start", "2026-10-01"),
        ("lt", "period_start", "2026-11-01"),
    ]
    paid_staff_ids, _, _ = payroll_db.get_paid_payroll_page_data(
        "org-1",
        "2026-10-01",
        "2026-10-31",
    )
    assert paid_staff_ids == {"staff-1"}


def test_mark_payroll_paid_does_not_report_success_without_saved_payment(
    monkeypatch,
):
    client = PaymentClient([], persist_upserts=False)
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )

    with pytest.raises(RuntimeError, match="could not be verified"):
        payroll_db.mark_payroll_paid(
            "org-1",
            "staff-1",
            "2026-10-01",
            "2026-10-31",
        )


def test_paid_status_read_does_not_convert_database_error_to_pending(
    monkeypatch,
):
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: PaymentClient([]))
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )

    with pytest.raises(RuntimeError, match="database unavailable"):
        payroll_db.get_paid_payroll_page_data(
            "org-1",
            "2026-10-01",
            "2026-10-31",
        )
