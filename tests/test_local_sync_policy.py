from __future__ import annotations

from datetime import datetime, timedelta, timezone

from local_node.attendance_sync_worker import should_sync_attendance_event


def test_waits_for_configured_delay_before_syncing() -> None:
    now = datetime(2026, 7, 7, 10, 0, 0, tzinfo=timezone.utc)
    marked_at = now - timedelta(minutes=4)

    assert should_sync_attendance_event(
        marked_at=marked_at,
        now=now,
        configured_delay_minutes=5,
        grace_minutes=0,
    ) is False

    assert should_sync_attendance_event(
        marked_at=marked_at,
        now=now + timedelta(minutes=2),
        configured_delay_minutes=5,
        grace_minutes=0,
    ) is True

    assert should_sync_attendance_event(
        marked_at=marked_at,
        now=now + timedelta(minutes=5),
        configured_delay_minutes=5,
        grace_minutes=0,
    ) is True


def test_uses_grace_window_when_it_is_longer_than_delay() -> None:
    now = datetime(2026, 7, 7, 10, 0, 0, tzinfo=timezone.utc)
    marked_at = now - timedelta(minutes=4)

    assert should_sync_attendance_event(
        marked_at=marked_at,
        now=now,
        configured_delay_minutes=0,
        grace_minutes=10,
    ) is False

    assert should_sync_attendance_event(
        marked_at=marked_at,
        now=now + timedelta(minutes=10),
        configured_delay_minutes=0,
        grace_minutes=10,
    ) is True
