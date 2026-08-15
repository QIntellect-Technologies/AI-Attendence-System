from datetime import datetime, timezone

from local_node.shift_gate import is_event_within_shift, resolve_event_shift_phase


def test_is_event_within_shift_normalizes_people_type():
    config = {
        "branch": {"timezone": "UTC"},
        "shift_windows": {
            "staff": {"check_in_time": "09:00", "check_in_grace_minutes": 10},
            "security_staff": {"check_in_time": "08:00", "check_in_grace_minutes": 15},
        },
    }

    event_dt = datetime(2026, 7, 11, 8, 55, tzinfo=timezone.utc)

    assert is_event_within_shift("security staff", event_dt, is_check_out=False, config=config)
    assert is_event_within_shift("security-staff", event_dt, is_check_out=False, config=config)
    assert is_event_within_shift("security_staff", event_dt, is_check_out=False, config=config)


def test_resolve_event_shift_phase_before_within_after_for_check_in_and_checkout():
    config = {
        "branch": {"timezone": "UTC"},
        "shift_windows": {
            "staff": {
                "check_in_time": "09:00",
                "check_in_grace_minutes": 10,
                "check_out_time": "17:00",
                "check_out_grace_minutes": 15,
            }
        },
    }

    before_check_in = datetime(2026, 7, 11, 8, 40, tzinfo=timezone.utc)
    within_check_in = datetime(2026, 7, 11, 9, 5, tzinfo=timezone.utc)
    after_check_in = datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc)

    assert resolve_event_shift_phase("staff", before_check_in, is_check_out=False, config=config) == "before"
    assert resolve_event_shift_phase("staff", within_check_in, is_check_out=False, config=config) == "within"
    assert resolve_event_shift_phase("staff", after_check_in, is_check_out=False, config=config) == "after"

    before_check_out = datetime(2026, 7, 11, 16, 30, tzinfo=timezone.utc)
    within_check_out = datetime(2026, 7, 11, 17, 10, tzinfo=timezone.utc)
    after_check_out = datetime(2026, 7, 11, 17, 30, tzinfo=timezone.utc)

    assert resolve_event_shift_phase("staff", before_check_out, is_check_out=True, config=config) == "before"
    assert resolve_event_shift_phase("staff", within_check_out, is_check_out=True, config=config) == "within"
    assert resolve_event_shift_phase("staff", after_check_out, is_check_out=True, config=config) == "after"

    assert is_event_within_shift("staff", within_check_in, is_check_out=False, config=config)
    assert not is_event_within_shift("staff", before_check_in, is_check_out=False, config=config)
    assert not is_event_within_shift("staff", after_check_in, is_check_out=False, config=config)
