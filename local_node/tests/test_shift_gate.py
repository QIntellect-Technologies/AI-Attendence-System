from datetime import datetime, timezone

from local_node.shift_gate import (
    classify_check_out_timing,
    is_check_in_window_closed,
    is_event_within_shift,
)


def test_is_event_within_shift_normalizes_people_type():
    config = {
        "branch": {"timezone": "UTC"},
        "shift_windows": {
            "staff": {"check_in_time": "09:00", "check_in_grace_minutes": 10},
            "security_staff": {"check_in_time": "08:00", "check_in_grace_minutes": 15},
        },
    }

    event_dt = datetime(2026, 7, 11, 8, 5, tzinfo=timezone.utc)

    assert is_event_within_shift("security staff", event_dt, is_check_out=False, config=config)
    assert is_event_within_shift("security-staff", event_dt, is_check_out=False, config=config)
    assert is_event_within_shift("security_staff", event_dt, is_check_out=False, config=config)


def test_check_in_and_checkout_grace_start_at_their_shift_times():
    config = {
        "branch": {"timezone": "UTC"},
        "shift_windows": {
            "staff": {
                "check_in_time": "10:00",
                "check_in_grace_minutes": 5,
                "check_out_time": "17:00",
                "check_out_grace_minutes": 5,
            }
        },
    }

    def at(hour: int, minute: int, second: int = 0) -> datetime:
        return datetime(2026, 7, 11, hour, minute, second, tzinfo=timezone.utc)

    assert not is_event_within_shift("staff", at(9, 59), config=config)
    assert is_event_within_shift("staff", at(10, 0), config=config)
    assert is_event_within_shift("staff", at(10, 5), config=config)
    assert is_event_within_shift("staff", at(10, 5, 0), config=config)
    assert not is_event_within_shift("staff", at(10, 5, 1), config=config)
    assert not is_check_in_window_closed("staff", at(10, 5, 0), config=config)
    assert is_check_in_window_closed("staff", at(10, 5, 1), config=config)
    assert not is_event_within_shift("staff", at(10, 6), config=config)

    assert not is_event_within_shift("staff", at(16, 59), is_check_out=True, config=config)
    assert is_event_within_shift("staff", at(17, 0), is_check_out=True, config=config)
    assert is_event_within_shift("staff", at(17, 5), is_check_out=True, config=config)
    assert is_event_within_shift("staff", at(17, 5, 0), is_check_out=True, config=config)
    assert not is_event_within_shift("staff", at(17, 5, 1), is_check_out=True, config=config)
    assert not is_event_within_shift("staff", at(17, 6), is_check_out=True, config=config)
    assert classify_check_out_timing("staff", at(16, 59), config=config) == "early"
    assert classify_check_out_timing("staff", at(17, 0), config=config) == "within"
    assert classify_check_out_timing("staff", at(17, 5), config=config) == "within"
    assert classify_check_out_timing("staff", at(17, 5, 1), config=config) == "late"
    assert classify_check_out_timing("staff", at(17, 6), config=config) == "late"
