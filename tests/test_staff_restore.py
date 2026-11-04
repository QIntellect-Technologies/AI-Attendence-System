from copy import deepcopy
from types import SimpleNamespace

import support_db_client_users as client_users
import support_db_staff as staff_db


class FakeQuery:
    def __init__(self, row):
        self.row = row
        self.values = {}

    def update(self, values):
        self.values = values
        return self

    def eq(self, field, value):
        assert field == "id"
        assert str(self.row[field]) == str(value)
        return self

    def execute(self):
        self.row.update(self.values)
        return SimpleNamespace(data=[deepcopy(self.row)])


class FakeSupabase:
    def __init__(self, row):
        self.row = row

    def table(self, name):
        assert name == "client_staff"
        return SimpleNamespace(update=lambda values: FakeQuery(self.row).update(values))


def archived_staff(**overrides):
    return {
        "id": "staff-1",
        "org_id": "org-1",
        "organization_id": "org-1",
        "branch_id": "branch-1",
        "backend_branch_id": "branch-1",
        "people_type": "staff",
        "person_code": "STF-0004",
        "employee_id": "STF-0004",
        "is_archived": True,
        "status": "inactive",
        **overrides,
    }


def run_restore(monkeypatch, row, uniqueness_check):
    monkeypatch.setattr(staff_db, "get_supabase", lambda: FakeSupabase(row))
    monkeypatch.setattr(staff_db, "get_client_staff_member", lambda _staff_id: row.copy())
    monkeypatch.setattr(staff_db, "_client_staff_safe", lambda updated, _org_id: updated)
    monkeypatch.setattr(
        client_users,
        "_assert_unique_client_staff_person_code",
        uniqueness_check,
    )
    return staff_db.restore_client_staff("staff-1", "admin-1")


def test_restore_preserves_person_code_when_it_is_available(monkeypatch):
    checked_codes = []

    def assert_unique(**kwargs):
        checked_codes.append(kwargs["person_code"])

    row = archived_staff()
    restored = run_restore(monkeypatch, row, assert_unique)

    assert row["person_code"] == "STF-0004"
    assert row["employee_id"] == "STF-0004"
    assert restored["person_code_changed"] is False
    assert restored["message"] == "Employee restored. Biometric training is required again."
    assert checked_codes == ["STF-0004"]


def test_restore_assigns_unique_code_when_existing_code_conflicts(monkeypatch):
    checked_codes = []

    def assert_unique(**kwargs):
        code = kwargs["person_code"]
        checked_codes.append(code)
        if code == "STF-0004":
            raise ValueError("Staff ID already exists in this branch.")

    row = archived_staff()
    restored = run_restore(monkeypatch, row, assert_unique)

    assert restored["person_code_changed"] is True
    assert restored["person_code"] != "STF-0004"
    assert restored["person_code"].startswith("STF-0004-R")
    assert row["person_code"] == restored["person_code"]
    assert row["employee_id"] == restored["person_code"]
    assert row["status"] == "active"
    assert row["is_archived"] is False
    assert checked_codes[0] == "STF-0004"
    assert checked_codes[1] == restored["person_code"]
    assert restored["person_code"] in restored["message"]


def test_restore_updates_student_registration_number_with_new_code(monkeypatch):
    def assert_unique(**kwargs):
        if kwargs["person_code"] == "REG-0004":
            raise ValueError("Registration Number already exists in this branch.")

    row = archived_staff(
        people_type="student",
        person_code="REG-0004",
        employee_id="REG-0004",
        registration_number="REG-0004",
    )
    restored = run_restore(monkeypatch, row, assert_unique)

    assert row["person_code"] == restored["person_code"]
    assert row["employee_id"] == restored["person_code"]
    assert row["registration_number"] == restored["person_code"]


def test_restore_reuses_prefetched_record_instead_of_reading_it_again(monkeypatch):
    row = archived_staff()
    monkeypatch.setattr(staff_db, "get_supabase", lambda: FakeSupabase(row))
    monkeypatch.setattr(
        staff_db,
        "get_client_staff_member",
        lambda _staff_id: (_ for _ in ()).throw(AssertionError("unexpected extra read")),
    )
    monkeypatch.setattr(staff_db, "_client_staff_safe", lambda updated, _org_id: updated)
    monkeypatch.setattr(
        client_users,
        "_assert_unique_client_staff_person_code",
        lambda **_kwargs: None,
    )

    restored = staff_db.restore_client_staff(
        "staff-1",
        "admin-1",
        _prefetched=row.copy(),
    )

    assert restored["user"]["id"] == "staff-1"
    assert restored["user"]["is_archived"] is False
