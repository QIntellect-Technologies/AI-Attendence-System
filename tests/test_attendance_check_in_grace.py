from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from support_db_attendance_gate import (
    resolve_check_in_status,
    resolve_check_out_status,
)


def test_check_in_grace_starts_at_shift_time():
    window = {
        "check_in_time": "10:00",
        "check_in_grace_minutes": 5,
    }
    branch_zone = ZoneInfo("UTC")

    def at(hour: int, minute: int, second: int = 0) -> datetime:
        return datetime(2026, 7, 11, hour, minute, second, tzinfo=timezone.utc)

    assert resolve_check_in_status(window, at(9, 59), branch_zone) == "early"
    assert resolve_check_in_status(window, at(10, 0), branch_zone) == "on_time"
    assert resolve_check_in_status(window, at(10, 5), branch_zone) == "on_time"
    assert resolve_check_in_status(window, at(10, 5, 1), branch_zone) == "late"
    assert resolve_check_in_status(window, at(10, 6), branch_zone) == "late"


def test_check_out_grace_starts_at_shift_time():
    window = {
        "capture_check_out": True,
        "check_out_time": "17:00",
        "check_out_grace_minutes": 5,
    }
    branch_zone = ZoneInfo("UTC")

    def at(hour: int, minute: int, second: int = 0) -> datetime:
        return datetime(2026, 7, 11, hour, minute, second, tzinfo=timezone.utc)

    assert resolve_check_out_status(window, at(16, 59), branch_zone) == "early"
    assert resolve_check_out_status(window, at(17, 0), branch_zone) == "on_time"
    assert resolve_check_out_status(window, at(17, 5), branch_zone) == "on_time"
    assert resolve_check_out_status(window, at(17, 5, 1), branch_zone) == "late"
    assert resolve_check_out_status(window, at(17, 6), branch_zone) == "late"
    assert resolve_check_out_status(
        window, at(17, 6), branch_zone, overtime_hours=1
    ) == "overtime"
