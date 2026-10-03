from types import SimpleNamespace

import supabase_client

if not hasattr(supabase_client, "reset_supabase_client"):
    supabase_client.reset_supabase_client = lambda: None

import support_db_payroll as payroll_db


class SnapshotQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.rows = client.rows.get(table_name, [])

    def select(self, _columns):
        return self

    def eq(self, field, value):
        self.rows = [row for row in self.rows if row.get(field) == value]
        return self

    def gte(self, field, value):
        self.rows = [row for row in self.rows if row.get(field, "") >= value]
        return self

    def lt(self, field, value):
        self.rows = [row for row in self.rows if row.get(field, "") < value]
        return self

    def in_(self, field, values):
        self.rows = [row for row in self.rows if row.get(field) in values]
        return self

    def upsert(self, rows, on_conflict):
        self.client.upserts.append((self.table_name, rows, on_conflict))
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class SnapshotClient:
    def __init__(self, paid_rows, existing_rows):
        self.rows = {
            "payroll_payments": paid_rows,
            "payroll_salary_period_snapshots": existing_rows,
        }
        self.upserts = []

    def table(self, table_name):
        return SnapshotQuery(self, table_name)


def _run_snapshot_save(monkeypatch, action):
    client = SnapshotClient(
        [
            {
                "org_id": "org-1",
                "staff_id": "staff-1",
                "period_start": "2026-01-01",
                "period_end": "2026-01-31",
            }
        ],
        [
            {
                "org_id": "org-1",
                "staff_id": "staff-1",
                "period_start": "2026-03-01",
                "period_end": "2026-03-31",
                "basic_salary": 45000,
            }
        ],
    )
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )
    monkeypatch.setattr(
        payroll_db,
        "_invalidate_payroll_breakdown_cache",
        lambda _org: None,
    )

    payroll_db.save_pending_payroll_salary_snapshots(
        "org-1",
        "staff-1",
        "2026-01-10",
        "2026-04-01",
        50000,
        60000,
        action,
    )
    return client.upserts[0][1]


def test_preserve_action_keeps_pending_salary_and_paid_period_salary(monkeypatch):
    snapshots = _run_snapshot_save(monkeypatch, "preserve")

    assert [row["basic_salary"] for row in snapshots] == [50000, 50000, 45000]
    assert [row["period_start"] for row in snapshots] == [
        "2026-01-01",
        "2026-02-01",
        "2026-03-01",
    ]


def test_update_action_changes_only_pending_months(monkeypatch):
    snapshots = _run_snapshot_save(monkeypatch, "update")

    assert [row["basic_salary"] for row in snapshots] == [50000, 60000, 60000]


def test_period_snapshot_lookup_is_scoped_to_staff_and_period(monkeypatch):
    client = SnapshotClient(
        [],
        [
            {
                "org_id": "org-1",
                "staff_id": "staff-1",
                "period_start": "2026-03-01",
                "period_end": "2026-03-31",
                "basic_salary": 45000,
            },
            {
                "org_id": "org-1",
                "staff_id": "staff-2",
                "period_start": "2026-03-01",
                "period_end": "2026-03-31",
                "basic_salary": 52000,
            },
        ],
    )
    monkeypatch.setattr(payroll_db, "get_supabase", lambda: client)
    monkeypatch.setattr(
        payroll_db,
        "_execute_supabase",
        lambda _label, query_builder: query_builder().execute(),
    )

    assert payroll_db.get_payroll_salary_period_snapshots(
        "org-1",
        ["staff-1"],
        "2026-03-01",
        "2026-03-31",
    ) == {"staff-1": 45000}
