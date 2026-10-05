"""
tests/test_shift_overlap.py
─────────────────────────────────────────────────────────────────────────────
Regression coverage for Ticket #20 — overlapping shift assignment accepted
with no conflict detection.

The reported case is the first test below: the branch's own default presets
ship Morning 09:00–17:00 and Evening 14:00–22:00, which overlap by three
hours, and both were accepted. A punch at 15:00 belonged to neither shift
in particular, leaving attendance in an undefined state.

The rest of the file pins the boundaries that a naive `start < other_end and
end > other_start` check gets wrong: back-to-back shifts, midnight wrap,
open-ended shifts, and grace tails.
"""
from __future__ import annotations

import pytest

import support_db_shift_overlap as ov
from support_db_shift_overlap import ShiftConflictError


def shift(name, check_in, check_out=None, *, grace=15, out_grace=15,
          shift_id=None, branch="branch-1", people="staff", active=True):
    return {
        "id": shift_id,
        "branch_id": branch,
        "people_type": people,
        "name": name,
        "check_in_time": check_in,
        "grace_minutes": grace,
        "check_out_time": check_out,
        "checkout_grace_minutes": out_grace if check_out else None,
        "is_active": active,
    }


MORNING = shift("Morning", "09:00", "17:00", shift_id="s-morning")
EVENING = shift("Evening", "14:00", "22:00", shift_id="s-evening")
NIGHT = shift("Night", "22:00", "06:00", shift_id="s-night")


# ─── The reported bug ───────────────────────────────────────────────────────

def test_reported_case_morning_and_evening_overlap_is_reported():
    """The case from the ticket. It is REPORTED, not refused: a caf\u00e9 running
    Morning 09:00\u201317:00 beside Evening 14:00\u201322:00 so two people cover the
    lunch rush together is a normal roster, and nothing resolves a shift by
    matching a punch time, so the overlap is never ambiguous."""
    conflicts = ov.check_overlaps(EVENING, [MORNING])

    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert conflict.shift_name == "Morning"
    assert conflict.severity == "conflict"
    assert conflict.overlap_minutes == 180          # 14:00 \u2192 17:00


def test_the_same_overlap_is_refused_under_strict():
    """An org that genuinely runs a tiling roster can opt into enforcement."""
    with pytest.raises(ShiftConflictError) as excinfo:
        ov.check_overlaps(EVENING, [MORNING], strict=True)
    assert "Morning" in str(excinfo.value)


def test_conflict_is_symmetric():
    assert ov.compare(MORNING, EVENING).overlap_minutes == 180
    assert ov.compare(EVENING, MORNING).overlap_minutes == 180


# ─── Adjacency must stay legal ──────────────────────────────────────────────

def test_back_to_back_shifts_share_no_duty_time():
    """Morning 09:00–17:00 handing over to Evening 17:00–01:00. Half-open
    intervals mean the shared 17:00 boundary is adjacency, so even under
    strict this must never be refused."""
    evening = shift("Evening", "17:00", "01:00")
    conflicts = ov.check_overlaps(evening, [MORNING], strict=True)
    assert all(c.severity == "warning" for c in conflicts)


def test_back_to_back_grace_tail_is_reported_as_a_warning():
    """Morning's 15-minute checkout grace runs to 17:15, into Evening's first
    quarter hour. Worth surfacing, never worth blocking."""
    evening = shift("Evening", "17:00", "01:00")
    conflicts = ov.find_conflicts(evening, [MORNING])
    assert [c.severity for c in conflicts] == ["warning"]
    assert conflicts[0].overlap_minutes == 15


def test_zero_grace_back_to_back_produces_no_conflict_at_all():
    morning = shift("Morning", "09:00", "17:00", out_grace=0)
    evening = shift("Evening", "17:00", "01:00", out_grace=0)
    assert ov.find_conflicts(evening, [morning]) == []


def test_fully_separate_shifts_do_not_conflict():
    early = shift("Early", "05:00", "08:00", out_grace=0)
    assert ov.find_conflicts(early, [MORNING]) == []


# ─── Midnight wrap ──────────────────────────────────────────────────────────

def test_overnight_shift_conflicts_with_early_morning_shift():
    """Night runs 22:00 → 06:00. A 05:00 start sits inside its tail even
    though 05:00 < 22:00 — the case a flat numeric comparison misses."""
    dawn = shift("Dawn", "05:00", "09:00")
    conflict = ov.compare(dawn, NIGHT)
    assert conflict is not None
    assert conflict.severity == "conflict"
    assert conflict.overlap_minutes == 60           # 05:00 → 06:00


def test_overnight_shift_conflicts_with_late_evening_shift():
    late = shift("Late", "21:00", "23:30")
    assert ov.compare(late, NIGHT).overlap_minutes == 90   # 22:00 → 23:30


def test_overnight_and_daytime_shift_can_coexist():
    day = shift("Day", "07:00", "15:00", out_grace=0)
    night = shift("Night", "22:00", "06:00", out_grace=0)
    assert ov.find_conflicts(day, [night]) == []


def test_two_overnight_shifts_overlap():
    a = shift("Night A", "22:00", "06:00")
    b = shift("Night B", "23:00", "07:00")
    assert ov.compare(a, b).severity == "conflict"


def test_checkout_equal_to_checkin_is_a_full_day_shift():
    """A round-the-clock post (09:00 → 09:00) covers 1440 minutes, so it
    collides with everything — not zero minutes, which would collide with
    nothing."""
    round_clock = shift("Round the clock", "09:00", "09:00")
    assert ov.compare(round_clock, MORNING).overlap_minutes == 480


# ─── Open-ended shifts ──────────────────────────────────────────────────────

def test_open_ended_shift_only_claims_its_checkin_grace_window():
    """capture_check_out off: the shift owns 09:00–09:30 and nothing else,
    so an afternoon shift is free to exist."""
    open_ended = shift("Gate duty", "09:00", None, grace=30)
    afternoon = shift("Afternoon", "13:00", "18:00")
    assert ov.find_conflicts(afternoon, [open_ended]) == []


def test_open_ended_shift_conflicts_when_its_checkin_lands_inside_a_shift():
    open_ended = shift("Gate duty", "10:00", None, grace=30)
    assert ov.compare(open_ended, MORNING).severity == "conflict"


def test_two_open_ended_shifts_with_close_checkins_conflict():
    a = shift("A", "09:00", None, grace=30)
    b = shift("B", "09:15", None, grace=30)
    assert ov.compare(a, b).severity == "conflict"


# ─── Scoping ────────────────────────────────────────────────────────────────

def test_shifts_in_different_branches_never_conflict():
    other_branch = shift("Evening", "14:00", "22:00", branch="branch-2")
    assert ov.find_conflicts(other_branch, [MORNING]) == []


def test_shifts_for_different_people_types_never_conflict():
    students = shift("Evening", "14:00", "22:00", people="student")
    assert ov.find_conflicts(students, [MORNING]) == []


def test_inactive_shifts_are_ignored():
    retired = shift("Old morning", "09:00", "17:00", active=False)
    assert ov.find_conflicts(EVENING, [retired]) == []


def test_exclude_id_lets_a_shift_be_edited_without_self_conflict():
    edited = dict(MORNING, check_out_time="18:00")
    assert ov.find_conflicts(edited, [MORNING], exclude_id="s-morning") == []


# ─── Ordering and reporting ─────────────────────────────────────────────────

def test_hard_conflicts_are_reported_before_warnings():
    # Mid's duty (15:00–17:00) collides head-on with Morning, while only its
    # 15-minute grace tail touches Handover.
    warning_only = shift("Handover", "17:00", "20:00", shift_id="s-handover")
    candidate = shift("Mid", "15:00", "17:00", out_grace=15)
    conflicts = ov.find_conflicts(candidate, [warning_only, MORNING])
    assert [c.severity for c in conflicts] == ["conflict", "warning"]


def test_nothing_is_raised_by_default():
    """The default path never raises, whatever it finds."""
    assert ov.check_overlaps(EVENING, [MORNING])          # a duty overlap
    assert ov.check_overlaps(shift("E", "17:00", "01:00"), [MORNING])  # a tail


def test_malformed_times_do_not_raise():
    broken = shift("Broken", "not-a-time", None)
    assert ov.find_conflicts(broken, [MORNING]) == []
    assert ov.format_window(broken) == "not-a-time (open-ended)"