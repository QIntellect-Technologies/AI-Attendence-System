from datetime import date
from types import SimpleNamespace

import pytest
import supabase_client

if not hasattr(supabase_client, "reset_supabase_client"):
    supabase_client.reset_supabase_client = lambda: None

import support_db_payroll as payroll_db


class PolicyHistoryQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.rows = client.rows.get(table_name, [])
        self.upsert_rows = None

    def select(self, _columns):
        return self

    def eq(self, field, value):
        self.rows = [row for row in self.rows if row.get(field) == value]
        return self

    def in_(self, field, values):
        self.rows = [row for row in self.rows if row.get(field) in values]
        return self

    def lte(self, field, value):
        self.rows = [row for row in self.rows if row.get(field, "") <= value]
        return self

    def order(self, field, desc=False):
        self.rows = sorted(
            self.rows,
            key=lambda row: row.get(field, ""),
            reverse=desc,
        )
        return self

    def limit(self, count):
        self.rows = self.rows[:count]
        return self

    def upsert(self, rows, on_conflict=None):
        self.upsert_rows = rows
        self.client.upserts.append((self.table_name, rows, on_conflict))
        return self

    def execute(self):
        if self.upsert_rows is not None:
            return SimpleNamespace(data=self.upsert_rows)
        return SimpleNamespace(data=self.rows)


class PolicyHistoryClient:
    def __init__(self, history_rows=None):
        self.rows = {"payroll_policy_history": history_rows or []}
        self.upserts = []

    def table(self, table_name):
        return PolicyHistoryQuery(self, table_name)


def _mock_supabase(monkeypatch, client):
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )


def test_policy_for_past_period_uses_rules_effective_for_that_month(monkeypatch):
    client = PolicyHistoryClient(
        [
            {
                "org_id": "org-1",
                "branch_id": "",
                "staff_id": "",
                "effective_from": "0001-01-01",
                "policy": {"otRatePerHour": 100},
            },
            {
                "org_id": "org-1",
                "branch_id": "",
                "staff_id": "",
                "effective_from": "2026-09-01",
                "policy": {"otRatePerHour": 200},
            },
        ],
    )
    _mock_supabase(monkeypatch, client)

    august = payroll_db.get_payroll_policy_for_period(
        "org-1",
        "2026-08-01",
    )
    september = payroll_db.get_payroll_policy_for_period(
        "org-1",
        "2026-09-01",
    )

    assert august["otRatePerHour"] == 100
    assert september["otRatePerHour"] == 200


def test_current_and_future_periods_use_live_policy(monkeypatch):
    live_policy = {"otRatePerHour": 250, "lateComingPolicy": {"mode": "occurrence_threshold", "thresholdOccurrences": 1}}
    resolved_scopes = []

    monkeypatch.setattr(
        payroll_db,
        "_org_default_payroll_policy",
        lambda _org_id: dict(live_policy),
    )
    monkeypatch.setattr(
        payroll_db,
        "_payroll_policy_override",
        lambda _org_id, *, branch_id=None, staff_id=None: (
            resolved_scopes.append((branch_id, staff_id)) or None
        ),
    )
    monkeypatch.setattr(
        payroll_db,
        "_historical_payroll_policy",
        lambda *_args, **_kwargs: pytest.fail("current/future period used history"),
    )

    current_month = date.today().replace(day=1).isoformat()
    future_month = date(
        date.today().year + (date.today().month == 12),
        date.today().month % 12 + 1,
        1,
    ).isoformat()
    current = payroll_db.get_payroll_policy_for_period(
        "org-1",
        current_month,
        branch_id="branch-1",
        staff_id="staff-1",
    )
    future = payroll_db.get_payroll_policy_for_period(
        "org-1",
        future_month,
        branch_id="branch-1",
    )

    assert current == live_policy
    assert future == live_policy
    assert resolved_scopes == [
        ("branch-1", None),
        (None, "staff-1"),
        ("branch-1", None),
    ]


def test_policy_for_period_applies_org_then_branch_then_staff_rules(monkeypatch):
    client = PolicyHistoryClient(
        [
            {
                "org_id": "org-1",
                "branch_id": "",
                "staff_id": "",
                "effective_from": "0001-01-01",
                "policy": {"otRatePerHour": 100, "incomeTaxEnabled": False},
            },
            {
                "org_id": "org-1",
                "branch_id": "branch-1",
                "staff_id": "",
                "effective_from": "0001-01-01",
                "policy": {"otRatePerHour": 150},
            },
            {
                "org_id": "org-1",
                "branch_id": "",
                "staff_id": "staff-1",
                "effective_from": "0001-01-01",
                "policy": {"incomeTaxEnabled": True},
            },
        ],
    )
    _mock_supabase(monkeypatch, client)

    policy = payroll_db.get_payroll_policy_for_period(
        "org-1",
        "2026-09-01",
        branch_id="branch-1",
        staff_id="staff-1",
    )

    assert policy["otRatePerHour"] == 150
    assert policy["incomeTaxEnabled"] is True


def test_page_overrides_use_latest_rule_effective_for_payroll_month(monkeypatch):
    client = PolicyHistoryClient(
        [
            {
                "org_id": "org-1",
                "branch_id": "branch-1",
                "staff_id": "",
                "effective_from": "0001-01-01",
                "policy": {"otRatePerHour": 100},
            },
            {
                "org_id": "org-1",
                "branch_id": "branch-1",
                "staff_id": "",
                "effective_from": "2026-10-01",
                "policy": {"otRatePerHour": 200},
            },
            {
                "org_id": "org-1",
                "branch_id": "",
                "staff_id": "staff-1",
                "effective_from": "0001-01-01",
                "policy": {"incomeTaxEnabled": False},
            },
            {
                "org_id": "org-1",
                "branch_id": "",
                "staff_id": "staff-1",
                "effective_from": "2026-10-01",
                "policy": {"incomeTaxEnabled": True},
            },
        ],
    )
    _mock_supabase(monkeypatch, client)

    prior_branch, prior_staff = payroll_db._payroll_policy_overrides_for_page(
        "org-1",
        ["branch-1"],
        ["staff-1"],
        effective_on="2026-09-01",
    )
    current_branch, current_staff = payroll_db._payroll_policy_overrides_for_page(
        "org-1",
        ["branch-1"],
        ["staff-1"],
        effective_on="2026-10-01",
    )

    assert prior_branch["branch-1"]["otRatePerHour"] == 100
    assert prior_staff["staff-1"]["incomeTaxEnabled"] is False
    assert current_branch["branch-1"]["otRatePerHour"] == 200
    assert current_staff["staff-1"]["incomeTaxEnabled"] is True


def test_saving_policy_adds_a_version_effective_from_current_month(monkeypatch):
    client = PolicyHistoryClient()
    _mock_supabase(monkeypatch, client)
    monkeypatch.setattr(
        payroll_db,
        "_invalidate_payroll_breakdown_cache",
        lambda _org: None,
    )

    policy = {"otRatePerHour": 175}
    result = payroll_db.save_payroll_policy("org-1", policy)

    history_upserts = [
        (rows, conflict)
        for table, rows, conflict in client.upserts
        if table == "payroll_policy_history"
    ]
    assert result == policy
    assert len(history_upserts) == 1
    saved, conflict = history_upserts[0]
    assert saved["effective_from"] == date.today().replace(day=1).isoformat()
    assert saved["policy"] == policy
    assert conflict == "org_id,branch_id,staff_id,effective_from"
