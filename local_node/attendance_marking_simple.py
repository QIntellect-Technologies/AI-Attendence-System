"""
local_node/attendance_marking_simple.py
──────────────────────────────────────────────────────────────────────────────
Simple (no hold-for-review) local attendance marking. Still classifies
early/on_time/late via shift_gate, same as scenario mode — the difference is
every detection confirms immediately; nothing ever waits on an operator
decision. See local_node.attendance_marking_scenario for the workflow this
sits alongside, and local_db.record_attendance_local for the dispatch point.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from local_node import shift_gate
from local_node.local_db import (
    _connect,
    _write_lock,
    _format_late_check_in_note,
    _format_checkout_hold_note,
    _merge_note,
)


def _format_stray_after_checkout_note(sighted_at: str, cfg: dict[str, Any]) -> str:
    """A detection arriving after checkout is already confirmed changes
    nothing about the row — just record that the person was seen again,
    for context, without touching check_out_marked_at/confirmed/status."""
    dt = datetime.fromisoformat(str(sighted_at).replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(shift_gate._branch_zone(cfg)).strftime("%H:%M")
    return f"Also seen at {local}, after checkout was already confirmed."


def record_simple_attendance(
    branch_id: str,
    people_type: str,
    person_code: str,
    staff_name: str,
    confidence: float,
    source: str = "camera",
    camera_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    event_dt_utc: datetime | None = None,
) -> dict[str, Any]:
    """Per-leg behavior (no held_for_review at any point):

    · No confirmed check-in yet -> check-in ATTEMPT.
        - before the window opens -> ignored entirely, no row written (the
          later in-window or late sighting is what actually claims today).
        - inside the window -> confirm: status='present'.
        - after the grace period (late) -> confirm immediately, same as
          in-window, just status='late'. Never held, no hold_reason — the
          status column alone carries the fact.

    · Check-in already confirmed -> checkout ATTEMPT.
        - inside the checkout window -> confirm, overwriting any earlier
          sighting, even an already-confirmed one (last one wins, same as
          scenario mode).
        - after the checkout window closes (late) -> if no checkout is
          confirmed yet, confirm this sighting as the checkout. If one is
          already confirmed, never overwrite it: only append a note that
          the person was seen again (see _format_stray_after_checkout_note).
        - before the checkout window opens (early), not yet confirmed ->
          never auto-confirms. check_out_hold_reason records the missed
          side and the note captures the timestamp, but sync_status stays
          'pending' throughout — there is no local resolution step to
          unstick a 'held_for_review' row in this workflow, so this must
          never be set to anything but 'pending'.
    """
    cfg = shift_gate.load_config()
    event_dt = event_dt_utc or datetime.now(timezone.utc)
    now = event_dt.isoformat()
    today = shift_gate.resolve_attendance_bucket_date(
        people_type, person_code, event_dt, config=cfg,
    )

    def _metadata_json(ready_at: str | None) -> str:
        return json.dumps({**(metadata or {}), "ready_at": ready_at}, separators=(",", ":"))

    with _write_lock:
        with _connect() as conn:
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            cur.execute(
                "SELECT * FROM attendance_buffer WHERE branch_id = ? AND people_type = ? AND person_code = ? AND attendance_date = ?",
                (branch_id, people_type, person_code, today),
            )
            existing = cur.fetchone()
            existing_dict = dict(existing) if existing else None

            if existing_dict is not None and existing_dict.get("source") == "manual_override":
                return {**existing_dict, "already_marked": True, "event_type": "locked_by_manual_override"}

            if existing_dict is None or not bool(existing_dict.get("check_in_confirmed")):
                within = shift_gate.is_event_within_shift(
                    people_type, event_dt, is_check_out=False, person_code=person_code, config=cfg,
                )
                window_closed = (
                    not within
                    and shift_gate.is_check_in_window_closed(
                        people_type, event_dt, person_code=person_code, config=cfg,
                    )
                )

                if not within and not window_closed:
                    return {
                        "branch_id": branch_id, "people_type": people_type, "person_code": person_code,
                        "staff_name": staff_name, "already_marked": False,
                        "event_type": "check_in_pre_shift_ignored",
                    }

                status = "present" if within else "late"
                raw_note = (
                    _format_late_check_in_note(people_type, person_code, now, held=False)
                    if window_closed else None
                )
                notes = _merge_note(existing_dict.get("notes") if existing_dict else None, "check_in", raw_note)
                check_in_ready_at = shift_gate.resolve_leg_ready_at_utc(
                    people_type, person_code, event_dt, is_check_out=False, config=cfg,
                )
                local_event_id = f"{branch_id}:{people_type}:{person_code}:{today}"
                cur.execute(
                    """
                    INSERT INTO attendance_buffer (
                        local_event_id, branch_id, people_type, person_code, staff_name, attendance_date,
                        status, confidence, source, camera_id, metadata, marked_at,
                        check_in_confirmed, check_out_confirmed, sync_status, check_in_hold_reason, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'pending', NULL, ?)
                    ON CONFLICT(branch_id, people_type, person_code, attendance_date) DO UPDATE SET
                        staff_name=excluded.staff_name, status=excluded.status, confidence=excluded.confidence,
                        source=excluded.source, camera_id=excluded.camera_id, metadata=excluded.metadata,
                        marked_at=excluded.marked_at, check_in_confirmed=1, sync_status=excluded.sync_status,
                        check_in_hold_reason=NULL, notes=excluded.notes
                    """,
                    (
                        local_event_id, branch_id, people_type, person_code, staff_name, today,
                        status, float(confidence), source, camera_id, _metadata_json(check_in_ready_at), now,
                        notes,
                    ),
                )
                conn.commit()
                return {
                    "local_event_id": local_event_id, "branch_id": branch_id,
                    "people_type": people_type, "person_code": person_code,
                    "staff_name": staff_name, "confidence": float(confidence), "camera_id": camera_id,
                    "marked_at": now, "check_out_marked_at": None, "sync_status": "pending",
                    "check_in_confirmed": 1, "check_out_confirmed": 0, "already_marked": False,
                    "event_type": "check_in" if within else "check_in_late",
                    "status": status, "check_in_hold_reason": None, "notes": notes,
                }

            row = existing_dict

            if not shift_gate.capture_check_out_enabled(people_type, person_code, config=cfg):
                return {**row, "already_marked": True, "event_type": "check_out_capture_disabled"}

            if bool(row.get("check_out_confirmed")):
                note = _format_stray_after_checkout_note(now, cfg)
                notes = _merge_note(row.get("notes"), "check_out", note)
                cur.execute(
                    "UPDATE attendance_buffer SET notes = ?, check_out_last_late_seen_at = ? WHERE id = ?",
                    (notes, now, row["id"]),
                )
                conn.commit()
                return {
                    **row, "notes": notes, "check_out_last_late_seen_at": now,
                    "already_marked": True, "event_type": "stray_after_checkout",
                }

            hold_reason = shift_gate.classify_check_out_timing(
                people_type, event_dt, person_code=person_code, config=cfg,
            )

            if hold_reason == "within":
                check_out_ready_at = shift_gate.resolve_leg_ready_at_utc(
                    people_type, person_code, event_dt, is_check_out=True, config=cfg,
                )
                check_out_metadata_json = _metadata_json(check_out_ready_at)
                notes = _merge_note(row.get("notes"), "check_out", "")
                cur.execute(
                    """
                    UPDATE attendance_buffer
                    SET check_out_marked_at = ?, check_out_confidence = ?, check_out_camera_id = ?,
                        check_out_metadata = ?, check_out_confirmed = 1, check_out_hold_reason = NULL,
                        sync_status = 'pending', sync_error = NULL, notes = ?
                    WHERE id = ?
                    """,
                    (now, float(confidence), camera_id, check_out_metadata_json, notes, row["id"]),
                )
                conn.commit()
                return {
                    **row, "check_out_marked_at": now, "check_out_confidence": float(confidence),
                    "check_out_camera_id": camera_id, "check_out_confirmed": 1, "check_out_hold_reason": None,
                    "sync_status": "pending", "already_marked": False, "event_type": "check_out", "notes": notes,
                }

            if hold_reason == "early":
                note = _format_checkout_hold_note(people_type, person_code, now, hold_reason)
                notes = _merge_note(row.get("notes"), "check_out", note)
                cur.execute(
                    "UPDATE attendance_buffer SET check_out_hold_reason = ?, notes = ? WHERE id = ?",
                    (hold_reason, notes, row["id"]),
                )
                conn.commit()
                return {
                    **row, "check_out_hold_reason": hold_reason, "notes": notes,
                    "already_marked": True, "event_type": "check_out_unconfirmed",
                }

            note = _format_checkout_hold_note(people_type, person_code, now, hold_reason)
            notes = _merge_note(row.get("notes"), "check_out", note)
            cur.execute(
                "UPDATE attendance_buffer SET check_out_hold_reason = ?, notes = ?, "
                "check_out_last_late_seen_at = ? WHERE id = ?",
                (hold_reason, notes, now, row["id"]),
            )
            conn.commit()
            return {
                **row, "check_out_hold_reason": hold_reason, "notes": notes,
                "check_out_last_late_seen_at": now,
                "already_marked": True, "event_type": "check_out_unconfirmed",
            }