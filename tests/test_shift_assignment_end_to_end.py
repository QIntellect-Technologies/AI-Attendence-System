"""
tests/test_shift_assignment_end_to_end.py
─────────────────────────────────────────────────────────────────────────────
Ticket #20, second half: does a shift assignment actually reach ATTENDANCE
MARKING correctly — both on the cloud side and on the Local Node?

The other two test files stop at the database. This one follows a single
assignment all the way down the real chain:

    assign_staff_shift()                      writes client_staff.shift_id_ref
      → resolve_staff_shift_windows()         builds config["staff_shift_windows"]
      → shift_gate._resolve_window()          node picks the window for a face
      → shift_gate.is_event_within_shift()    node holds or accepts the punch

and asserts the node ends up gating against the shift that was actually
assigned — not the one it replaced, and not the branch default.

WHY THIS FILE EXISTS SEPARATELY
───────────────────────────────
The overlap guard makes the CATALOG unambiguous. It does not, by itself,
prove that the right window reaches the node, because two things sit between
them that the guard never touches:

  1. resolve_staff_shift_windows only emits an entry for staff who have BOTH
     a shift_id_ref and a person_code. Anyone else silently falls through to
     the branch default at the node.
  2. shift_gate._resolve_window MERGES per field: {**branch, **personal}.
     A personal window missing a key inherits the branch default's value for
     that key. With two overlapping shifts that merge could previously
     produce a window belonging to neither.

Both are exercised below. test_partial_personal_window_does_not_inherit_a_
stale_checkout is the one that would have caught a bad merge.
"""
from __future__ import annotations

import sys
import types
from datetime import datetime, timezone

import pytest

import support_db_shifts as shifts_db

# ─── Import the Local Node gate ────────────────────────────────────────────
# shift_gate does `from local_node.config_store import load_config` at module
# scope. Every call below passes an explicit `config=`, so load_config is
# never actually invoked — but the import has to resolve, and the node's real
# config_store reads from disk. Only that ONE submodule is stubbed; the
# local_node package itself is imported for real, so if the node's gate ever
# stops matching the cloud's resolution this file fails rather than passing
# against a fixture.
if "local_node.config_store" not in sys.modules:
    store = types.ModuleType("local_node.config_store")
    store.load_config = lambda: (_ for _ in ()).throw(
        AssertionError("load_config called — a test forgot to pass config=")
    )
    sys.modules["local_node.config_store"] = store

shift_gate = pytest.importorskip(
    "local_node.shift_gate",
    reason="Local Node package not on sys.path; run from a checkout that "
           "includes local_node/ to exercise the node half of this file.",
)

from support_db_attendance_gate import resolve_staff_shift_windows  # noqa: E402

ORG = "org-1"
BRANCH = "11111111-1111-1111-1111-111111111111"
PERSON_CODE = "0007"
UTC = timezone.utc


@pytest.fixture
def db(monkeypatch, fake_supabase):
    import support_db_attendance_gate as gate

    monkeypatch.setattr(shifts_db, "get_supabase", lambda: fake_supabase)
    monkeypatch.setattr(gate, "get_supabase", lambda: fake_supabase)
    monkeypatch.setattr(
        shifts_db, "_get_branch_owned_by_org", lambda org, branch: {"id": branch}
    )
    monkeypatch.setattr(shifts_db, "_require_specific_branch", lambda b, _a: str(b))
    return fake_supabase


def make_shift(db, name, check_in, check_out, **extra):
    return shifts_db.create_shift(ORG, BRANCH, {
        "name": name,
        "people_type": "staff",
        "check_in_time": check_in,
        "grace_minutes": 15,
        "capture_check_out": check_out is not None,
        "check_out_time": check_out,
        "checkout_grace_minutes": 15,
        **extra,
    })


def add_staff(db, *, person_code=PERSON_CODE, shift_id=None):
    db.table("client_staff").rows.append({
        "id": "staff-1",
        "org_id": ORG,
        "branch_id": BRANCH,
        "people_type": "staff",
        "person_code": person_code,
        "shift_id_ref": shift_id,
        "check_in_grace_override": None,
        "check_out_grace_override": None,
        "is_archived": False,
        "status": "active",
    })


def node_config(db, *, branch_default=None, shift_mode=True):
    """The subset of /v1/node/config the gate reads, built from the SAME
    function get_node_config uses — so this reflects what the node really
    receives, not a hand-written fixture that could drift from it."""
    return {
        "branch": {"timezone": "UTC"},
        "shift_mode_enabled": shift_mode,
        "shift_windows": {"staff": branch_default} if branch_default else {},
        "staff_shift_windows": resolve_staff_shift_windows(ORG, BRANCH),
        "manual_instructions": [],
    }


def at(hour, minute=0):
    return datetime(2026, 3, 10, hour, minute, tzinfo=UTC)


# ─── The core question ─────────────────────────────────────────────────────

def test_reassignment_reaches_the_node_as_the_new_shift(db):
    """Morning, then Evening. The node must gate against Evening — the shift
    that actually won — with no trace of the one it replaced."""
    morning = make_shift(db, "Morning", "06:00", "14:00")
    evening = make_shift(db, "Evening", "14:00", "22:00")
    add_staff(db)

    shifts_db.assign_staff_shift(ORG, "staff-1", morning["id"])
    cfg = node_config(db)
    assert cfg["staff_shift_windows"]["staff:0007"]["check_in_time"] == "06:00:00"

    shifts_db.assign_staff_shift(ORG, "staff-1", evening["id"])
    cfg = node_config(db)
    window = cfg["staff_shift_windows"]["staff:0007"]
    assert window["check_in_time"] == "14:00:00"
    assert window["check_out_time"] == "22:00:00"

    # A 06:00 punch was on time under Morning. Under Evening the node must
    # now hold it; 14:00 must be accepted.
    assert shift_gate.is_event_within_shift(
        "staff", at(6), config=cfg, person_code=PERSON_CODE) is False
    assert shift_gate.is_event_within_shift(
        "staff", at(14), config=cfg, person_code=PERSON_CODE) is True


def test_personal_shift_beats_the_branch_default(db):
    """The whole point of the personal tier. Branch runs Morning; this person
    is on Evening; the node must not gate them on Morning."""
    evening = make_shift(db, "Evening", "14:00", "22:00")
    add_staff(db)
    shifts_db.assign_staff_shift(ORG, "staff-1", evening["id"])

    branch_default = {
        "name": "Morning", "check_in_time": "06:00:00",
        "check_in_grace_minutes": 15, "capture_check_out": True,
        "check_out_time": "14:00:00", "check_out_grace_minutes": 15,
    }
    cfg = node_config(db, branch_default=branch_default)

    assert shift_gate.is_event_within_shift(
        "staff", at(14), config=cfg, person_code=PERSON_CODE) is True
    assert shift_gate.is_event_within_shift(
        "staff", at(6), config=cfg, person_code=PERSON_CODE) is False
    # Someone with no personal shift still gets the branch default.
    assert shift_gate.is_event_within_shift(
        "staff", at(6), config=cfg, person_code="9999") is True


def test_partial_personal_window_does_not_inherit_a_stale_checkout(db):
    """_resolve_window merges per field: {**branch, **personal}. An
    open-ended personal shift (checkout capture off) must null the branch
    default's check_out_time rather than inherit it — otherwise the node
    gates a checkout leg the person's shift doesn't even have, using a time
    borrowed from a different shift."""
    open_ended = make_shift(db, "Gate duty", "09:00", None)
    add_staff(db)
    shifts_db.assign_staff_shift(ORG, "staff-1", open_ended["id"])

    branch_default = {
        "name": "Morning", "check_in_time": "06:00:00",
        "check_in_grace_minutes": 15, "capture_check_out": True,
        "check_out_time": "14:00:00", "check_out_grace_minutes": 15,
    }
    cfg = node_config(db, branch_default=branch_default)
    merged = shift_gate._resolve_window(cfg, "staff", PERSON_CODE, at(9))

    assert merged["check_in_time"] == "09:00:00"
    assert merged["check_out_time"] is None, (
        "personal window leaked the branch default's checkout time"
    )
    assert merged["capture_check_out"] is False


def test_clearing_a_shift_drops_the_person_from_node_config(db):
    """Unassigning must remove the personal entry, not leave a stale one the
    node keeps gating against."""
    morning = make_shift(db, "Morning", "06:00", "14:00")
    add_staff(db)
    shifts_db.assign_staff_shift(ORG, "staff-1", morning["id"])
    assert "staff:0007" in node_config(db)["staff_shift_windows"]

    shifts_db.assign_staff_shift(ORG, "staff-1", None)
    assert node_config(db)["staff_shift_windows"] == {}


# ─── The gap the overlap guard does NOT close ──────────────────────────────

def test_unenrolled_staff_fall_through_to_the_branch_default(db):
    """A person with a shift but no person_code produces no node entry, so
    the NODE gates them on the branch default while the BACKEND resolves
    their real shift at sync time.

    Pinned deliberately: this divergence is pre-existing and out of scope
    for the overlap fix, but overlapping shifts used to make it invisible.
    With a non-overlapping catalog the two tiers can still disagree — they
    just can't be ambiguous about it any more."""
    evening = make_shift(db, "Evening", "14:00", "22:00")
    add_staff(db, person_code=None)
    shifts_db.assign_staff_shift(ORG, "staff-1", evening["id"])

    assert node_config(db)["staff_shift_windows"] == {}


def test_deactivating_a_shift_removes_it_from_node_config(db):
    """_get_shift filters on is_active, so a deactivated shift stops gating
    at the node too — not just in the assignment UI."""
    morning = make_shift(db, "Morning", "06:00", "14:00")
    add_staff(db)
    shifts_db.assign_staff_shift(ORG, "staff-1", morning["id"])
    assert "staff:0007" in node_config(db)["staff_shift_windows"]

    shifts_db.update_shift(ORG, BRANCH, morning["id"], {"is_active": False})
    assert node_config(db)["staff_shift_windows"] == {}


def test_person_code_zero_padding_resolves_either_way(db):
    """client_staff stores "0007"; a node's own enrollment may say "7".
    Both keys must resolve to the same window."""
    morning = make_shift(db, "Morning", "06:00", "14:00")
    add_staff(db)
    shifts_db.assign_staff_shift(ORG, "staff-1", morning["id"])

    windows = node_config(db)["staff_shift_windows"]
    assert windows["staff:0007"] == windows["staff:7"]


# ─── Overnight shifts still bucket correctly ───────────────────────────────

def test_overnight_shift_buckets_a_post_midnight_checkout_to_the_prior_day(db):
    """The overlap guard treats 22:00→06:00 as a wrapping window. Confirm the
    node's own midnight handling still agrees after an assignment."""
    night = make_shift(db, "Night", "22:00", "06:00")
    add_staff(db)
    shifts_db.assign_staff_shift(ORG, "staff-1", night["id"])
    cfg = node_config(db)

    bucket = shift_gate.resolve_attendance_bucket_date(
        "staff", PERSON_CODE, datetime(2026, 3, 11, 1, 0, tzinfo=UTC), cfg
    )
    assert bucket == "2026-03-10", "post-midnight checkout must join the prior day"
