from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from threading import Lock
from typing import Any

_events: deque[dict[str, Any]] = deque(maxlen=200)
_lock = Lock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def publish_event(event: dict[str, Any]) -> dict[str, Any]:
    row = {
        "id": str(event.get("id") or event.get("local_event_id") or utc_now()),
        "type": str(event.get("type") or "attendance"),
        "name": str(event.get("name") or event.get("staff_name") or "Unknown"),
        "staff_id": str(event.get("staff_id") or ""),
        "status": str(event.get("status") or "marked_local"),
        "confidence": float(event.get("confidence") or 0),
        "message": str(event.get("message") or "Attendance marked locally."),
        "marked_at": str(event.get("marked_at") or utc_now()),
        "check_out_marked_at": event.get("check_out_marked_at"),
        "sync_status": str(event.get("sync_status") or "pending"),
        "camera_id": event.get("camera_id"),
        "camera_name": event.get("camera_name"),
        "snapshot": event.get("snapshot"),
        # Operator-facing context (e.g. "Detected early at 11:46, before the
        # 11:50 shift start" — see local_db._format_late_check_in_note /
        # _format_checkout_hold_note). Previously missing from this dict
        # entirely, so every caller that passed "notes" into publish_event
        # (attendance_sync_worker, manual_instructions_worker) had it
        # silently dropped — /api/live-events never surfaced it and
        # LiveAttendancePanel's `event.notes &&` check was always falsy.
        "notes": event.get("notes"),
    }
    with _lock:
        # Upsert by id (== local_event_id, stable per person/day): a repeat
        # sighting updates that same person's existing card in place (e.g.
        # check_in -> check_out) instead of appending a duplicate. Remove-
        # then-appendleft also promotes it back to the front of the feed,
        # same "most recent activity first" behavior a plain append gave us.
        existing_index = next((i for i, e in enumerate(_events) if e["id"] == row["id"]), None)
        if existing_index is not None:
            del _events[existing_index]
        _events.appendleft(row)
    return row


def list_events(limit: int = 100) -> list[dict[str, Any]]:
    with _lock:
        return list(_events)[: int(limit or 100)]


def clear_events() -> None:
    with _lock:
        _events.clear()