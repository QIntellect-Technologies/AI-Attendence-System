from datetime import date, timedelta
from types import SimpleNamespace

import pytest
import supabase_client
import payroll_engine

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
                "department_id": "",
                "staff_id": "",
                "effective_from": "0001-01-01",
                "policy": {"otRatePerHour": 100},
            },
            {
                "org_id": "org-1",
                "branch_id": "",
                "department_id": "",
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


def test_branch_department_policy_precedes_global_department_override(monkeypatch):
    monkeypatch.setattr(
        payroll_db,
        "_org_default_payroll_policy",
        lambda _org_id: {"otRatePerHour": 100},
    )

    def policy_override(_org_id, *, branch_id=None, department_id=None, staff_id=None):
        if staff_id:
            return None
        if branch_id and department_id:
            return {"otRatePerHour": 300}
        if department_id:
            return {"otRatePerHour": 200}
        if branch_id:
            return {"incomeTaxEnabled": True}
        return None

    monkeypatch.setattr(payroll_db, "_payroll_policy_override", policy_override)

    resolved = payroll_db.get_payroll_policy(
        "org-1",
        branch_id="branch-1",
        department_id="department-1",
    )

    assert resolved["otRatePerHour"] == 300
    assert resolved["incomeTaxEnabled"] is True


def test_policy_for_period_applies_org_then_branch_then_staff_rules(monkeypatch):
    client = PolicyHistoryClient(
        [
            {
                "org_id": "org-1",
                "branch_id": "",
                "department_id": "",
                "staff_id": "",
                "effective_from": "0001-01-01",
                "policy": {"otRatePerHour": 100, "incomeTaxEnabled": False},
            },
            {
                "org_id": "org-1",
                "branch_id": "branch-1",
                "department_id": "",
                "staff_id": "",
                "effective_from": "0001-01-01",
                "policy": {"otRatePerHour": 150},
            },
            {
                "org_id": "org-1",
                "branch_id": "",
                "department_id": "department-1",
                "staff_id": "",
                "effective_from": "0001-01-01",
                "policy": {"otRatePerHour": 175},
            },
            {
                "org_id": "org-1",
                "branch_id": "",
                "department_id": "",
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
        department_id="department-1",
    )

    assert policy["otRatePerHour"] == 175
    assert policy["incomeTaxEnabled"] is True


def test_page_overrides_use_latest_rule_effective_for_payroll_month(monkeypatch):
    client = PolicyHistoryClient(
        [
            {
                "org_id": "org-1",
                "branch_id": "branch-1",
                "department_id": "",
                "staff_id": "",
                "effective_from": "0001-01-01",
                "policy": {"otRatePerHour": 100},
            },
            {
                "org_id": "org-1",
                "branch_id": "branch-1",
                "department_id": "",
                "staff_id": "",
                "effective_from": "2026-10-01",
                "policy": {"otRatePerHour": 200},
            },
            {
                "org_id": "org-1",
                "branch_id": "",
                "department_id": "",
                "staff_id": "staff-1",
                "effective_from": "0001-01-01",
                "policy": {"incomeTaxEnabled": False},
            },
            {
                "org_id": "org-1",
                "branch_id": "",
                "department_id": "",
                "staff_id": "staff-1",
                "effective_from": "2026-10-01",
                "policy": {"incomeTaxEnabled": True},
            },
        ],
    )
    _mock_supabase(monkeypatch, client)

    prior_branch, _prior_departments, _prior_branch_departments, prior_staff = (
        payroll_db._payroll_policy_overrides_for_page(
            "org-1",
            ["branch-1"],
            ["staff-1"],
            effective_on="2026-09-01",
        )
    )
    current_branch, _current_departments, _current_branch_departments, current_staff = (
        payroll_db._payroll_policy_overrides_for_page(
            "org-1",
            ["branch-1"],
            ["staff-1"],
            effective_on="2026-10-01",
        )
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
    assert conflict == "org_id,branch_id,department_id,staff_id,effective_from"


def test_saving_policy_can_override_previous_month_history(monkeypatch):
    client = PolicyHistoryClient()
    _mock_supabase(monkeypatch, client)
    monkeypatch.setattr(
        payroll_db,
        "_invalidate_payroll_breakdown_cache",
        lambda _org: None,
    )

    policy = {"otRatePerHour": 175}
    payroll_db.save_payroll_policy(
        "org-1",
        policy,
        override_previous_month=True,
    )

    history_upserts = [
        rows
        for table, rows, _conflict in client.upserts
        if table == "payroll_policy_history"
    ]
    previous_month_end = date.today().replace(day=1) - timedelta(days=1)
    assert [row["effective_from"] for row in history_upserts] == [
        date.today().replace(day=1).isoformat(),
        previous_month_end.replace(day=1).isoformat(),
    ]
    assert all(row["policy"] == policy for row in history_upserts)


def test_saving_department_policy_uses_department_scope(monkeypatch):
    client = PolicyHistoryClient()
    _mock_supabase(monkeypatch, client)
    monkeypatch.setattr(
        payroll_db,
        "_invalidate_payroll_breakdown_cache",
        lambda _org: None,
    )

    current_month = date.today().replace(day=1)
    previous_month_end = current_month - timedelta(days=1)
    previous_month = previous_month_end.replace(day=1)
    policy = {
        "otRatePerHour": 225,
        "payrollWeeklyOffDays": ["friday", "saturday", "sunday"],
        "payrollWeeklyOffDaysEffectiveFrom": current_month.strftime("%Y-%m"),
        "payrollCalendarsByMonth": {},
        "workingDayCalendarsByPeopleType": {
            "student": {
                "weeklyOffDays": ["saturday", "sunday"],
                "weeklyOffDaysEffectiveFrom": current_month.strftime("%Y-%m"),
                "calendarsByMonth": {},
            },
        },
    }
    payroll_db.save_payroll_policy(
        "org-1",
        policy,
        branch_id="branch-1",
        department_id="department-1",
        override_previous_month=True,
    )

    saved_history = [
        rows
        for table, rows, _conflict in client.upserts
        if table == "payroll_policy_history"
    ]
    saved_override, override_conflict = next(
        (rows, conflict)
        for table, rows, conflict in client.upserts
        if table == "payroll_policy_overrides"
    )
    assert [row["effective_from"] for row in saved_history] == [
        current_month.isoformat(),
        previous_month.isoformat(),
    ]
    assert all(row["branch_id"] == "" for row in saved_history)
    assert all(row["department_id"] == "department-1" for row in saved_history)
    assert all(row["staff_id"] == "" for row in saved_history)
    current_policy, previous_policy = (
        row["policy"] for row in saved_history
    )
    assert current_policy == policy
    assert previous_policy["payrollWeeklyOffDaysEffectiveFrom"] == (
        previous_month.strftime("%Y-%m")
    )
    assert (
        previous_policy["workingDayCalendarsByPeopleType"]["student"][
            "weeklyOffDaysEffectiveFrom"
        ]
        == previous_month.strftime("%Y-%m")
    )
    for month_start, month_end, month_policy in (
        (previous_month, previous_month_end, previous_policy),
        (
            current_month,
            date(
                current_month.year + (current_month.month == 12),
                current_month.month % 12 + 1,
                1,
            ) - timedelta(days=1),
            current_policy,
        ),
    ):
        expected_work_days = sum(
            (month_start + timedelta(days=offset)).weekday() not in {4, 5, 6}
            for offset in range(month_end.day)
        )
        assert len(
            payroll_engine.scheduled_work_dates_for_month(
                month_start.strftime("%Y-%m"),
                month_policy,
            )
        ) == expected_work_days
    assert saved_override["branch_id"] == ""
    assert saved_override["department_id"] == "department-1"
    assert saved_override["staff_id"] == ""
    assert saved_override["policy"] == policy
    assert override_conflict == "org_id,branch_id,department_id,staff_id"


def test_organization_override_replaces_all_existing_policy_scopes(monkeypatch):
    client = PolicyHistoryClient()
    client.rows["payroll_policy_overrides"] = [
        {"org_id": "org-1", "branch_id": "branch-1", "department_id": "", "staff_id": ""},
        {"org_id": "org-1", "branch_id": "", "department_id": "department-1", "staff_id": ""},
        {"org_id": "org-1", "branch_id": "", "department_id": "", "staff_id": "staff-1"},
    ]
    _mock_supabase(monkeypatch, client)
    monkeypatch.setattr(
        payroll_db,
        "_invalidate_payroll_breakdown_cache",
        lambda _org: None,
    )

    policy = {"otRatePerHour": 325}
    payroll_db.save_payroll_policy(
        "org-1",
        policy,
        override_existing_scopes=True,
    )

    replaced = next(
        rows
        for table, rows, _conflict in client.upserts
        if table == "payroll_policy_overrides" and isinstance(rows, list)
    )
    assert {
        (row["branch_id"], row["department_id"], row["staff_id"])
        for row in replaced
    } == {
        ("branch-1", "", ""),
        ("", "department-1", ""),
        ("", "", "staff-1"),
    }
    assert all(row["policy"] == policy for row in replaced)


def test_branch_override_applies_to_all_branch_departments_and_staff(monkeypatch):
    client = PolicyHistoryClient()
    client.rows["payroll_policy_overrides"] = [
        {"org_id": "org-1", "branch_id": "", "department_id": "department-1", "staff_id": ""},
    ]
    client.rows["client_staff"] = [
        {"org_id": "org-1", "branch_id": "branch-1", "id": "staff-1", "department_id": "department-1"},
        {"org_id": "org-1", "branch_id": "branch-1", "id": "staff-2", "department_id": "department-2"},
    ]
    _mock_supabase(monkeypatch, client)
    monkeypatch.setattr(
        payroll_db,
        "_invalidate_payroll_breakdown_cache",
        lambda _org: None,
    )

    policy = {"otRatePerHour": 425}
    payroll_db.save_payroll_policy(
        "org-1",
        policy,
        branch_id="branch-1",
        override_existing_scopes=True,
    )

    replaced = next(
        rows
        for table, rows, _conflict in client.upserts
        if table == "payroll_policy_overrides" and isinstance(rows, list)
    )
    assert {
        (row["branch_id"], row["department_id"], row["staff_id"])
        for row in replaced
    } == {
        ("", "", "staff-1"),
        ("", "", "staff-2"),
        ("branch-1", "department-1", ""),
        ("branch-1", "department-2", ""),
    }
    assert all(row["policy"] == policy for row in replaced)
