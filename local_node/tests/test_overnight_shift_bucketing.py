"""
tests/test_overnight_shift_bucketing.py
─────────────────────────────────────────────────────────────────────────────
Regression coverage for the midnight-crossing shift bug (Ticket #18):

  An overnight shift (e.g. 23:00 check-in -> 01:00 check-out) had its
  checkout leg silently lost. record_attendance_local bucketed every
  detection under `_today()` — the branch-local calendar date at the
  moment of the call — so the checkout, arriving after midnight, landed
  under a DIFFERENT attendance_date than the check-in it belonged to. The
  lookup found no existing row, so the checkout was misfiled as a brand
  new (bogus) check-in for the next day instead of completing the shift
  that started the night before.

  Fixed by shift_gate.resolve_attendance_bucket_date: a detection in the
  early-morning tail of an overnight shift's checkout window now buckets
  to the PREVIOUS calendar day, matching the check-in row. Ordinary
  same-day shifts are unaffected (see test_same_day_shift_unaffected).
"""
from __future__ import annotations

import datetime as real_dt_mod
from unittest.mock import patch

import pytest

import local_node.local_db as local_db
import local_node.shift_gate as shift_gate

OVERNIGHT_CONFIG = {
    "branch": {"timezone": "UTC"},
    "shift_mode_enabled": True,
    "shift_windows": {
        "staff": {
            "check_in_time": "23:00",
            "check_in_grace_minutes": 15,
            "check_out_time": "01:00",
            "check_out_grace_minutes": 15,
        }
    },
    "staff_shift_windows": {},
    "manual_instructions": [],
}

SAME_DAY_CONFIG = {
    "branch": {"timezone": "UTC"},
    "shift_mode_enabled": True,
    "shift_windows": {
        "staff": {
            "check_in_time": "09:00",
            "check_in_grace_minutes": 15,
            "check_out_time": "17:00",
            "check_out_grace_minutes": 15,
        }
    },
    "staff_shift_windows": {},
    "manual_instructions": [],
}


class _FakeDateTime(real_dt_mod.datetime):
    """Lets a test pin datetime.now() to an arbitrary instant, so the
    wall-clock advance across midnight — the actual trigger for this bug —
    can be simulated deterministically instead of depending on when the
    test suite happens to run."""

    _now: real_dt_mod.datetime | None = None

    @classmethod
    def now(cls, tz=None):
        return cls._now.astimezone(tz) if tz else cls._now


def _record_at(wall_clock_and_event: real_dt_mod.datetime, **kwargs):
    """Records one detection with both the event timestamp AND the
    simulated real 'now' pinned to the same instant — matching a live
    camera detection, where the event is effectively 'right now'."""
    _FakeDateTime._now = wall_clock_and_event
    with patch.object(local_db, "datetime", _FakeDateTime):
        return local_db.record_attendance_local(
            event_dt_utc=wall_clock_and_event, **kwargs
        )


@pytest.fixture()
def temp_local_db(tmp_path, monkeypatch):
    db_path = str(tmp_path / "attendance.db")
    monkeypatch.setattr(local_db, "LOCAL_DB_PATH", db_path)
    local_db.init_db()
    return db_path


def _rows_for(db_path: str, person_code: str) -> list[dict]:
    import sqlite3

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT attendance_date, check_in_confirmed, check_out_confirmed "
                "FROM attendance_buffer WHERE person_code = ? ORDER BY attendance_date",
                (person_code,),
            ).fetchall()
        ]
    finally:
        conn.close()


def test_overnight_checkout_completes_the_prior_nights_check_in(temp_local_db):
    with patch.object(shift_gate, "load_config", return_value=OVERNIGHT_CONFIG):
        check_in_evt = real_dt_mod.datetime(2026, 8, 24, 23, 5, tzinfo=real_dt_mod.timezone.utc)
        check_out_evt = real_dt_mod.datetime(2026, 8, 25, 0, 45, tzinfo=real_dt_mod.timezone.utc)

        check_in_result = _record_at(
            check_in_evt,
            branch_id="b1", people_type="staff", person_code="0001",
            staff_name="Night Guy", confidence=0.9,
        )
        check_out_result = _record_at(
            check_out_evt,
            branch_id="b1", people_type="staff", person_code="0001",
            staff_name="Night Guy", confidence=0.9,
        )

    assert check_in_result["event_type"] == "check_in"
    # This is the assertion that fails pre-fix: without shift-aware
    # bucketing the checkout is misfiled as "check_in_pending_review" —
    # a brand new, unrelated check-in attempt — instead of "check_out".
    assert check_out_result["event_type"] == "check_out"

    rows = _rows_for(temp_local_db, "0001")
    assert len(rows) == 1, (
        "overnight check-in and check-out must land on the SAME "
        f"attendance_date row; got {len(rows)} row(s): {rows}"
    )
    assert rows[0]["check_in_confirmed"] == 1
    assert rows[0]["check_out_confirmed"] == 1


def test_same_day_shift_unaffected(temp_local_db):
    """Ordinary (non-overnight) shifts must bucket exactly as before —
    this fix is strictly additive for the overnight case."""
    with patch.object(shift_gate, "load_config", return_value=SAME_DAY_CONFIG):
        check_in_evt = real_dt_mod.datetime(2026, 8, 24, 9, 2, tzinfo=real_dt_mod.timezone.utc)
        check_out_evt = real_dt_mod.datetime(2026, 8, 24, 17, 5, tzinfo=real_dt_mod.timezone.utc)

        check_in_result = _record_at(
            check_in_evt,
            branch_id="b1", people_type="staff", person_code="0002",
            staff_name="Day Gal", confidence=0.9,
        )
        check_out_result = _record_at(
            check_out_evt,
            branch_id="b1", people_type="staff", person_code="0002",
            staff_name="Day Gal", confidence=0.9,
        )

    assert check_in_result["event_type"] == "check_in"
    assert check_out_result["event_type"] == "check_out"

    rows = _rows_for(temp_local_db, "0002")
    assert len(rows) == 1
    assert rows[0]["check_in_confirmed"] == 1
    assert rows[0]["check_out_confirmed"] == 1


def test_late_morning_detection_after_overnight_window_starts_a_new_day(temp_local_db):
    """A sighting well after the checkout window has closed (e.g. 6am,
    hours past the 01:00+15min boundary) must NOT be backdated — it's a
    genuinely new, unrelated detection and belongs to its own calendar
    day, not indefinitely attached to last night's shift."""
    with patch.object(shift_gate, "load_config", return_value=OVERNIGHT_CONFIG):
        late_evt = real_dt_mod.datetime(2026, 8, 25, 6, 0, tzinfo=real_dt_mod.timezone.utc)
        bucket = shift_gate.resolve_attendance_bucket_date(
            "staff", "0001", late_evt, config=OVERNIGHT_CONFIG
        )
    assert bucket == "2026-08-25"
