from types import SimpleNamespace

import support_db_attendance_dashboard as attendance_dashboard
import support_db_payroll as payroll_db


class AttendanceDeleteQuery:
    def __init__(self):
        self.filters = []

    def delete(self):
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def gte(self, field, value):
        self.filters.append((field, value))
        return self

    def lt(self, field, value):
        self.filters.append((field, value))
        return self

    def execute(self):
        return SimpleNamespace(data=[{"id": "attendance-1"}])


class AttendanceDeleteClient:
    def __init__(self):
        self.query = AttendanceDeleteQuery()

    def table(self, table_name):
        assert table_name == "attendance"
        return self.query


def test_mark_absent_deletes_selected_day_and_invalidates_org_payroll_cache(monkeypatch):
    client = AttendanceDeleteClient()
    monkeypatch.setattr(attendance_dashboard, "get_supabase", lambda: client)
    monkeypatch.setattr(
        "support_db_branches.list_branches",
        lambda _org_id: [],
    )
    monkeypatch.setattr(
        "support_db_staff.get_client_staff_member",
        lambda _staff_id: {
            "id": "staff-1",
            "organization_id": "org-1",
            "backend_branch_id": None,
            "join_date": None,
            "name": "Staff One",
        },
    )
    monkeypatch.setattr(
        payroll_db,
        "_PAYROLL_BREAKDOWN_CACHE",
        {
            "org-1:cached-period": (0.0, {}),
            "org-2:other-org": (0.0, {}),
        },
    )

    result = attendance_dashboard.mark_client_staff_absent_today(
        "org-1",
        "staff-1",
        date_value="2026-10-07",
    )

    assert result["deleted_count"] == 1
    assert ("org_id", "org-1") in client.query.filters
    assert ("staff_id", "staff-1") in client.query.filters
    assert ("timestamp", "2026-10-07T00:00:00+00:00") in client.query.filters
    assert ("timestamp", "2026-10-08T00:00:00+00:00") in client.query.filters
    assert payroll_db._PAYROLL_BREAKDOWN_CACHE == {
        "org-2:other-org": (0.0, {}),
    }
