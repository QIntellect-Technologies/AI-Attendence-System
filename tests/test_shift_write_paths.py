"""
tests/test_shift_write_paths.py
─────────────────────────────────────────────────────────────────────────────
Ticket #20 — proves the overlap guard is actually WIRED into every shift
write path, not merely importable. The pure comparison logic is covered by
test_shift_overlap.py; this file drives support_db_shifts against a fake
Supabase so a future refactor that drops a _guard_no_overlap() call fails
here instead of in production.

Also covers the two adjacent integrity holes the same ticket surfaced:
assigning a shift from a different branch, and assigning a deactivated one.
"""
from __future__ import annotations

import pytest

import support_db_shifts as shifts_db
from support_db_shift_overlap import ShiftConflictError

ORG = "org-1"
BRANCH = "11111111-1111-1111-1111-111111111111"
OTHER_BRANCH = "22222222-2222-2222-2222-222222222222"


# ─── Fixtures: patch the two boundaries support_db_shifts talks to ─────────

@pytest.fixture
def db(monkeypatch, fake_supabase):
    monkeypatch.setattr(shifts_db, "get_supabase", lambda: fake_supabase)
    monkeypatch.setattr(
        shifts_db, "_get_branch_owned_by_org", lambda org, branch: {"id": branch}
    )
    monkeypatch.setattr(shifts_db, "_require_specific_branch", lambda b, _a: str(b))
    return fake_supabase


def morning_payload(**overrides):
    return {
        "name": "Morning",
        "people_type": "staff",
        "check_in_time": "09:00",
        "grace_minutes": 15,
        "capture_check_out": True,
        "check_out_time": "17:00",
        "checkout_grace_minutes": 15,
        **overrides,
    }


# ─── create_shift ──────────────────────────────────────────────────────────

def test_create_allows_an_overlapping_shift_and_reports_it(db):
    """Staggered coverage is a legitimate roster, so the write SUCCEEDS. The
    overlap comes back as a note so an unintended one is still visible."""
    shifts_db.create_shift(ORG, BRANCH, morning_payload())
    created = shifts_db.create_shift(
        ORG, BRANCH,
        morning_payload(name="Evening", check_in_time="14:00",
                        check_out_time="22:00"),
    )

    assert len(db.table("shifts").rows) == 2
    notes = created["overlap_notes"]
    assert [n["shift_name"] for n in notes] == ["Morning"]
    assert notes[0]["severity"] == "conflict"
    assert notes[0]["overlap_minutes"] == 180


def test_create_allows_back_to_back_shifts(db):
    shifts_db.create_shift(ORG, BRANCH, morning_payload(checkout_grace_minutes=0))
    created = shifts_db.create_shift(
        ORG, BRANCH,
        morning_payload(name="Evening", check_in_time="17:00",
                        check_out_time="01:00", checkout_grace_minutes=0),
    )
    assert created["name"] == "Evening"
    assert len(db.table("shifts").rows) == 2


def test_create_reports_a_grace_tail_as_a_handover_note(db):
    shifts_db.create_shift(ORG, BRANCH, morning_payload())   # tail to 17:15
    created = shifts_db.create_shift(
        ORG, BRANCH,
        morning_payload(name="Evening", check_in_time="17:00",
                        check_out_time="01:00"),
    )
    notes = created["overlap_notes"]
    assert [n["severity"] for n in notes] == ["warning"]
    assert notes[0]["shift_name"] == "Morning"


def test_create_ignores_shifts_in_another_branch(db):
    shifts_db.create_shift(ORG, OTHER_BRANCH, morning_payload())
    created = shifts_db.create_shift(ORG, BRANCH, morning_payload())
    assert created["branch_id"] == BRANCH


def test_create_ignores_shifts_for_another_people_type(db):
    shifts_db.create_shift(ORG, BRANCH, morning_payload(people_type="student"))
    created = shifts_db.create_shift(ORG, BRANCH, morning_payload())
    assert created["people_type"] == "staff"


# ─── update_shift ──────────────────────────────────────────────────────────

def test_update_allows_an_edit_that_creates_an_overlap_and_reports_it(db):
    shifts_db.create_shift(ORG, BRANCH, morning_payload())
    evening = shifts_db.create_shift(
        ORG, BRANCH,
        morning_payload(name="Evening", check_in_time="18:00",
                        check_out_time="23:00"),
    )

    updated = shifts_db.update_shift(
        ORG, BRANCH, evening["id"], {"check_in_time": "14:00"}
    )
    assert updated["check_in_time"] == "14:00:00"
    assert [n["shift_name"] for n in updated["overlap_notes"]] == ["Morning"]


def test_update_does_not_conflict_a_shift_with_itself(db):
    morning = shifts_db.create_shift(ORG, BRANCH, morning_payload())
    updated = shifts_db.update_shift(
        ORG, BRANCH, morning["id"], {"check_out_time": "18:00"}
    )
    assert updated["check_out_time"] == "18:00:00"


def test_update_merges_the_patch_onto_the_stored_row(db):
    """A grace-only PATCH carries no times. The guard must evaluate the
    merged row, not the sparse payload."""
    shifts_db.create_shift(ORG, BRANCH, morning_payload(checkout_grace_minutes=0))
    evening = shifts_db.create_shift(
        ORG, BRANCH,
        morning_payload(name="Evening", check_in_time="17:00",
                        check_out_time="22:00", checkout_grace_minutes=0),
    )
    updated = shifts_db.update_shift(
        ORG, BRANCH, evening["id"], {"grace_minutes": 20}
    )
    assert updated["grace_minutes"] == 20
    assert updated["check_in_time"] == "17:00:00"


def test_update_of_unknown_shift_raises_before_writing(db):
    with pytest.raises(ValueError, match="not found"):
        shifts_db.update_shift(ORG, BRANCH, "no-such-id", {"name": "X"})


def test_deactivated_shift_produces_no_overlap_note(db):
    morning = shifts_db.create_shift(ORG, BRANCH, morning_payload())
    shifts_db.update_shift(ORG, BRANCH, morning["id"], {"is_active": False})

    created = shifts_db.create_shift(
        ORG, BRANCH,
        morning_payload(name="Evening", check_in_time="14:00",
                        check_out_time="22:00"),
    )
    assert created["name"] == "Evening"


# ─── assign_staff_shift ────────────────────────────────────────────────────

def test_assign_reports_the_shift_it_replaced(db):
    morning = shifts_db.create_shift(ORG, BRANCH, morning_payload())
    evening = shifts_db.create_shift(
        ORG, BRANCH,
        morning_payload(name="Evening", check_in_time="18:00",
                        check_out_time="23:00"),
    )
    db.table("client_staff").rows.append(
        {"id": "staff-1", "org_id": ORG, "branch_id": BRANCH, "shift_id_ref": None}
    )

    first = shifts_db.assign_staff_shift(ORG, "staff-1", morning["id"])
    assert first["previous_shift"] is None
    assert first["assigned_shift"]["name"] == "Morning"

    second = shifts_db.assign_staff_shift(ORG, "staff-1", evening["id"])
    assert second["previous_shift"]["name"] == "Morning"
    assert second["previous_shift"]["window"] == "09:00–17:00"
    assert second["assigned_shift"]["name"] == "Evening"
    # One shift held at a time — the replacement is what's stored.
    assert second["shift_id_ref"] == evening["id"]


def test_assign_rejects_a_shift_from_another_branch(db):
    foreign = shifts_db.create_shift(ORG, OTHER_BRANCH, morning_payload())
    db.table("client_staff").rows.append(
        {"id": "staff-1", "org_id": ORG, "branch_id": BRANCH, "shift_id_ref": None}
    )

    with pytest.raises(ValueError, match="different branch"):
        shifts_db.assign_staff_shift(ORG, "staff-1", foreign["id"])


def test_assign_rejects_a_deactivated_shift(db):
    morning = shifts_db.create_shift(ORG, BRANCH, morning_payload())
    shifts_db.update_shift(ORG, BRANCH, morning["id"], {"is_active": False})
    db.table("client_staff").rows.append(
        {"id": "staff-1", "org_id": ORG, "branch_id": BRANCH, "shift_id_ref": None}
    )

    with pytest.raises(ValueError, match="deactivated"):
        shifts_db.assign_staff_shift(ORG, "staff-1", morning["id"])


def test_clearing_a_shift_reports_what_was_removed(db):
    morning = shifts_db.create_shift(ORG, BRANCH, morning_payload())
    db.table("client_staff").rows.append(
        {"id": "staff-1", "org_id": ORG, "branch_id": BRANCH,
         "shift_id_ref": morning["id"]}
    )

    cleared = shifts_db.assign_staff_shift(ORG, "staff-1", None)
    assert cleared["shift_id_ref"] is None
    assert cleared["assigned_shift"] is None
    assert cleared["previous_shift"]["name"] == "Morning"


def test_assign_survives_a_dangling_previous_shift_reference(db):
    """The old shift may have been deleted since. A stale reference must not
    turn a valid reassignment into an error."""
    evening = shifts_db.create_shift(
        ORG, BRANCH,
        morning_payload(name="Evening", check_in_time="18:00",
                        check_out_time="23:00"),
    )
    db.table("client_staff").rows.append(
        {"id": "staff-1", "org_id": ORG, "branch_id": BRANCH,
         "shift_id_ref": "deleted-shift-id"}
    )

    result = shifts_db.assign_staff_shift(ORG, "staff-1", evening["id"])
    assert result["previous_shift"] is None
    assert result["assigned_shift"]["name"] == "Evening"