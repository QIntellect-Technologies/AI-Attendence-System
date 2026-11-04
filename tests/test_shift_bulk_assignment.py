from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

import support_db_shifts as shifts_db

ORG = "org-1"
BRANCH = "branch-1"
OTHER_BRANCH = "branch-2"
SHIFT = "shift-evening"


class FakeQuery:
    def __init__(self, table):
        self.table = table
        self.operation = "select"
        self.values = {}
        self.filters = []

    def select(self, *_fields):
        self.operation = "select"
        return self

    def update(self, values):
        self.operation = "update"
        self.values = values
        return self

    def eq(self, field, value):
        self.filters.append(lambda row: str(row.get(field)) == str(value))
        return self

    def in_(self, field, values):
        values = {str(value) for value in values}
        self.filters.append(lambda row: str(row.get(field)) in values)
        return self

    def execute(self):
        rows = [
            row
            for row in self.table.rows
            if all(matches(row) for matches in self.filters)
        ]
        if self.operation == "update":
            self.table.update_count += 1
            for row in rows:
                row.update(self.values)
        return SimpleNamespace(data=deepcopy(rows))


class FakeTable:
    def __init__(self, rows):
        self.rows = rows
        self.update_count = 0

    def select(self, *fields):
        return FakeQuery(self).select(*fields)

    def update(self, values):
        return FakeQuery(self).update(values)


class FakeSupabase:
    def __init__(self, staff_rows):
        self.staff = FakeTable(staff_rows)

    def table(self, name):
        assert name == "client_staff"
        return self.staff


@pytest.fixture
def bulk_db(monkeypatch):
    db = FakeSupabase(
        [
            {
                "id": f"staff-{number}",
                "org_id": ORG,
                "branch_id": BRANCH,
                "shift_id_ref": None,
                "check_in_grace_override": 5,
                "check_out_grace_override": 10,
            }
            for number in range(1, 4)
        ]
    )
    monkeypatch.setattr(shifts_db, "get_supabase", lambda: db)
    monkeypatch.setattr(
        shifts_db, "_require_specific_branch", lambda branch, _action: str(branch)
    )
    monkeypatch.setattr(
        shifts_db, "_get_branch_owned_by_org", lambda _org, branch: {"id": branch}
    )
    monkeypatch.setattr(
        shifts_db,
        "_get_shift_owned_by_org",
        lambda _org, shift: {
            "id": shift,
            "branch_id": BRANCH,
            "name": "Evening",
            "is_active": True,
        },
    )
    return db


def test_bulk_assignment_updates_all_staff_with_one_database_write(bulk_db):
    updated = shifts_db.assign_staff_shifts(
        ORG,
        BRANCH,
        ["staff-1", "staff-2", "staff-3"],
        SHIFT,
    )

    assert {row["id"] for row in updated} == {
        "staff-1",
        "staff-2",
        "staff-3",
    }
    assert all(row["shift_id_ref"] == SHIFT for row in updated)
    assert all(row["check_in_grace_override"] is None for row in updated)
    assert all(row["check_out_grace_override"] is None for row in updated)
    assert bulk_db.staff.update_count == 1


def test_bulk_assignment_rejects_cross_branch_targets(bulk_db, monkeypatch):
    bulk_db.staff.rows[1]["branch_id"] = OTHER_BRANCH

    with pytest.raises(ValueError, match="selected branch"):
        shifts_db.assign_staff_shifts(
            ORG,
            BRANCH,
            ["staff-1", "staff-2"],
            SHIFT,
        )

    assert bulk_db.staff.update_count == 0


def test_bulk_assignment_rejects_unknown_staff_ids(bulk_db):
    with pytest.raises(ValueError, match="not found"):
        shifts_db.assign_staff_shifts(
            ORG,
            BRANCH,
            ["staff-1", "missing-staff"],
            SHIFT,
        )

    assert bulk_db.staff.update_count == 0
