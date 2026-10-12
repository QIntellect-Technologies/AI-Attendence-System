from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

import local_node.local_db as local_db
import local_node.shift_gate as shift_gate


CONFIG = {
    "branch": {"timezone": "UTC"},
    "shift_mode_enabled": True,
    "attendance_workflows": {"staff": "simple"},
    "shift_windows": {
        "staff": {
            "check_in_time": "12:38",
            "check_in_grace_minutes": 2,
            "check_out_time": "12:43",
            "check_out_grace_minutes": 2,
            "sync_delay_minutes": 0,
        }
    },
    "staff_shift_windows": {},
    "manual_instructions": [],
}


@pytest.fixture()
def temp_local_db(tmp_path, monkeypatch):
    monkeypatch.setattr(local_db, "LOCAL_DB_PATH", str(tmp_path / "attendance.db"))
    local_db.init_db()


def _record_at(hour: int, minute: int, second: int = 0) -> dict:
    event_time = datetime(2026, 10, 9, hour, minute, second, tzinfo=timezone.utc)
    with patch.object(shift_gate, "load_config", return_value=CONFIG):
        return local_db.record_attendance_local(
            branch_id="branch-1",
            people_type="staff",
            person_code="0001",
            staff_name="Test Person",
            confidence=0.99,
            event_dt_utc=event_time,
        )


def _saved_row() -> dict:
    with local_db._connect() as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM attendance_buffer WHERE person_code = ?",
            ("0001",),
        ).fetchone()
    assert row is not None
    return dict(row)


def test_simple_checkout_uses_last_detection_in_grace_but_keeps_checkin_time(temp_local_db):
    check_in = _record_at(12, 38)
    assert check_in["event_type"] == "check_in"

    # An additional detection during check-in grace must not change check-in.
    _record_at(12, 39)
    row = _saved_row()
    assert row["marked_at"] == "2026-10-09T12:38:00+00:00"

    first_checkout = _record_at(12, 43)
    assert first_checkout["event_type"] == "check_out"
    later_checkout = _record_at(12, 44)
    assert later_checkout["event_type"] == "check_out"
    final_checkout = _record_at(12, 45)
    assert final_checkout["event_type"] == "check_out"

    row = _saved_row()
    assert row["check_out_confirmed"] == 1
    assert row["check_out_marked_at"] == "2026-10-09T12:45:00+00:00"
    assert row["sync_status"] == "pending"
    assert json.loads(row["check_out_metadata"])["ready_at"] == "2026-10-09T12:45:00+00:00"


def test_simple_checkout_after_grace_does_not_replace_final_checkout(temp_local_db):
    _record_at(12, 38)
    _record_at(12, 43)
    late_sighting = _record_at(12, 45, 1)

    assert late_sighting["event_type"] == "stray_after_checkout"
    row = _saved_row()
    assert row["check_out_marked_at"] == "2026-10-09T12:43:00+00:00"
