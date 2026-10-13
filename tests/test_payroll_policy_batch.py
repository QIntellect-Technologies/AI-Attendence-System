from types import SimpleNamespace

import supabase_client

if not hasattr(supabase_client, "reset_supabase_client"):
    supabase_client.reset_supabase_client = lambda: None

import support_db_payroll as payroll_db


class PolicyQuery:
    def __init__(self, client, filters):
        self.client = client
        self.filters = filters
        self.scope_column = None

    def select(self, *_args):
        return self

    def eq(self, *args):
        self.filters.append(("eq", *args))
        return self

    def in_(self, *args):
        self.filters.append(("in", *args))
        self.scope_column = args[0]
        return self

    def execute(self):
        return SimpleNamespace(data=self.client.responses[self.scope_column])


class PolicyClient:
    def __init__(self, branch_rows, department_rows, staff_rows):
        self.queries = []
        self.responses = {
            "branch_id": branch_rows,
            "department_id": department_rows,
            "staff_id": staff_rows,
        }

    def table(self, table_name):
        assert table_name == "payroll_policy_overrides"
        query = PolicyQuery(self, [])
        self.queries.append(query)
        return query


class PendingPayrollQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.filters = []

    def select(self, *_args):
        return self

    def eq(self, *args):
        self.filters.append(("eq", *args))
        return self

    def gte(self, *args):
        self.filters.append(("gte", *args))
        return self

    def lt(self, *args):
        self.filters.append(("lt", *args))
        return self

    def execute(self):
        self.client.queries.append((self.table_name, self.filters))
        return SimpleNamespace(data=self.client.responses[self.table_name])


class PendingPayrollClient:
    def __init__(self, staff_rows, payment_rows):
        self.responses = {
            "client_staff": staff_rows,
            "payroll_payments": payment_rows,
        }
        self.queries = []

    def table(self, table_name):
        return PendingPayrollQuery(self, table_name)


def test_payroll_page_policy_overrides_are_loaded_in_two_batched_queries(monkeypatch):
    branch_rows = [
        {"branch_id": "branch-1", "department_id": "", "staff_id": "", "policy": {"otRatePerHour": 100}},
        {"branch_id": "other-branch", "department_id": "", "staff_id": "", "policy": {"otRatePerHour": 999}},
    ]
    staff_rows = [
        {"branch_id": "", "department_id": "", "staff_id": "staff-1", "policy": {"otRatePerHour": 200}},
        {"branch_id": "", "department_id": "", "staff_id": "staff-2", "policy": {"incomeTaxEnabled": True}},
        {"branch_id": "", "department_id": "", "staff_id": "other-staff", "policy": {"otRatePerHour": 999}},
    ]
    department_rows = [
        {
            "branch_id": "",
            "department_id": "department-1",
            "staff_id": "",
            "policy": {"otRatePerHour": 150},
        },
    ]
    client = PolicyClient(branch_rows, department_rows, staff_rows)
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )

    page_staff_ids = [f"staff-{index}" for index in range(120)]
    (
        branch_overrides,
        department_overrides,
        branch_department_overrides,
        staff_overrides,
    ) = (
        payroll_db._payroll_policy_overrides_for_page(
            "org-1", ["branch-1"], page_staff_ids, ["department-1"],
        )
    )

    assert len(client.queries) == 4
    assert branch_overrides == {"branch-1": {"otRatePerHour": 100}}
    assert department_overrides == {"department-1": {"otRatePerHour": 150}}
    assert branch_department_overrides == {}
    assert staff_overrides == {
        "staff-1": {"otRatePerHour": 200},
        "staff-2": {"incomeTaxEnabled": True},
    }
    assert all(("eq", "org_id", "org-1") in query.filters for query in client.queries)
    staff_id_filter = next(
        filter_
        for query in client.queries
        for filter_ in query.filters
        if filter_[:2] == ("in", "staff_id")
    )
    assert len(staff_id_filter[2]) == 120


def test_previous_month_pending_check_requires_all_active_staff_to_be_unpaid(monkeypatch):
    client = PendingPayrollClient(
        [
            {"id": "staff-1"},
            {"id": "staff-2"},
        ],
        [
            {
                "staff_id": "staff-2",
                "period_start": "2026-09-01",
                "period_end": "2026-09-30",
            },
        ],
    )
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )

    all_pending, staff_count = payroll_db.are_all_payroll_staff_pending(
        "org-1",
        "2026-09-01",
        "2026-09-30",
        department_id="department-1",
    )

    assert (all_pending, staff_count) == (False, 2)
    staff_filters = client.queries[0][1]
    assert ("eq", "org_id", "org-1") in staff_filters
    assert ("eq", "role", "staff") in staff_filters
    assert ("eq", "is_archived", False) in staff_filters
    assert ("eq", "department_id", "department-1") in staff_filters


def test_previous_month_pending_check_reports_all_pending_when_no_payments(monkeypatch):
    client = PendingPayrollClient([{"id": "staff-1"}], [])
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )

    all_pending, staff_count = payroll_db.are_all_payroll_staff_pending(
        "org-1",
        "2026-09-01",
        "2026-09-30",
    )

    assert (all_pending, staff_count) == (True, 1)


def test_leave_compensation_uses_each_staff_department_policy(monkeypatch):
    resolved_scopes = []

    def leave_rules(_org_id, *, branch_id=None, department_id=None):
        resolved_scopes.append((branch_id, department_id))
        return {
            "annual": "paid" if department_id == "department-1" else "unpaid",
        }

    monkeypatch.setattr(payroll_db, "get_leave_type_rules", leave_rules)
    rows = [
        {
            "branch_id": "branch-1",
            "department_id": "department-1",
            "leave_type": "annual",
            "reason": "",
        },
        {
            "branch_id": "branch-1",
            "department_id": "department-2",
            "leave_type": "annual",
            "reason": "",
        },
    ]

    payroll_db.annotate_leave_payroll_treatment("org-1", rows)

    assert [row["leave_compensation"] for row in rows] == ["paid", "unpaid"]
    assert resolved_scopes == [
        ("branch-1", "department-1"),
        ("branch-1", "department-2"),
    ]
