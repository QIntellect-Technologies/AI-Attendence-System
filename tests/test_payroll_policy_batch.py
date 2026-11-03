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
    def __init__(self, branch_rows, staff_rows):
        self.queries = []
        self.responses = {"branch_id": branch_rows, "staff_id": staff_rows}

    def table(self, table_name):
        assert table_name == "payroll_policy_overrides"
        query = PolicyQuery(self, [])
        self.queries.append(query)
        return query


def test_payroll_page_policy_overrides_are_loaded_in_two_batched_queries(monkeypatch):
    branch_rows = [
        {"branch_id": "branch-1", "staff_id": "", "policy": {"otRatePerHour": 100}},
        {"branch_id": "other-branch", "staff_id": "", "policy": {"otRatePerHour": 999}},
    ]
    staff_rows = [
        {"branch_id": "", "staff_id": "staff-1", "policy": {"otRatePerHour": 200}},
        {"branch_id": "", "staff_id": "staff-2", "policy": {"incomeTaxEnabled": True}},
        {"branch_id": "", "staff_id": "other-staff", "policy": {"otRatePerHour": 999}},
    ]
    client = PolicyClient(branch_rows, staff_rows)
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )

    page_staff_ids = [f"staff-{index}" for index in range(120)]
    branch_overrides, staff_overrides = payroll_db._payroll_policy_overrides_for_page(
        "org-1", ["branch-1"], page_staff_ids,
    )

    assert len(client.queries) == 2
    assert branch_overrides == {"branch-1": {"otRatePerHour": 100}}
    assert staff_overrides == {
        "staff-1": {"otRatePerHour": 200},
        "staff-2": {"incomeTaxEnabled": True},
    }
    assert all(("eq", "org_id", "org-1") in query.filters for query in client.queries)
    staff_id_filter = next(
        filter_ for filter_ in client.queries[1].filters if filter_[0] == "in"
    )
    assert len(staff_id_filter[2]) == 120
