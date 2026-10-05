"""
local_node/attendance_marking_scenario.py
──────────────────────────────────────────────────────────────────────────────
Scenario-based (hold-for-review) local attendance marking — moved verbatim
out of local_db.record_attendance_local. No logic changes from that function;
see local_db.record_attendance_local (now a thin delegator) for the workflow
dispatch this is one branch of.
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


def record_scenario_attendance(
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
    """Capture a raw presence detection for today, deciding INTERNALLY
    whether it's a check-in or check-out attempt and whether it lands
    inside that leg's shift window — see local_node.shift_gate. This used
    to be the caller's job (camera_stream_manager pre-computed a leg via
    attendance_leg_for_today, purely from "does a row exist yet", then
    passed in a precomputed outside_shift bool). That was wrong: it let
    whichever detection happened to arrive FIRST claim the check-in slot,
    even if it was outside the shift window — so a legitimate, in-window
    arrival that showed up after an early false/loitering detection got
    filed as a check-OUT attempt instead, and the real check-in was lost.
    Folding the decision in here, atomically with the write, fixes that:
    a slot is only ever CONFIRMED by a detection that actually falls
    inside its own window.

    Per-leg state machine (check_in_confirmed / check_out_confirmed):

    · No row yet, or check-in was never confirmed and no checkout has
      happened yet -> this is a check-in ATTEMPT.
        - inside check-in window  -> confirms the check-in. marked_at is
          this detection's time, check_in_confirmed=1, sync_status=pending.
          This is "the first detection IN the shift timing".
        - outside the window, window NOT YET OPEN (early stray) -> held
          candidate. marked_at tracks the most recent such sighting
          (informative for review) but check_in_confirmed stays 0, so a
          later in-window detection can still claim the slot instead of
          being misfiled as a checkout.
        - outside the window, window ALREADY CLOSED (genuinely late) ->
          two different outcomes depending on whether this person was
          ALSO seen earlier that day, before the window even opened:
            · no earlier stray -> HOLDS for an operator decision (mark
              short leave, or mark half-day) rather than auto-confirming.
              This is the first (and possibly only) sighting this person
              gets today, and it's genuinely ambiguous whether it should
              count — see mark_held_check_ins_short_leave / mark_held_check_ins_half_day.
            · an earlier too-early stray WAS already seen (this is the
              row's second sighting today) -> auto-CONFIRMS on this
              detection instead of holding. The early stray is already
              proof the person was on site before the shift even started,
              so there's no real decision left for an operator to make —
              confirming immediately also lets the row transition to
              checkout tracking right away instead of sitting in
              held-for-review purgatory. marked_at becomes this (late)
              detection's time, and notes records the earlier early
              sighting for context (see _format_late_check_in_note's
              held=False wording). Either way, leaving a genuinely-first
              late sighting unconfirmed would strand the person in
              check-in-attempt purgatory for the rest of the day, never
              transitioning to checkout tracking at all. See
              shift_gate.is_check_in_window_closed.

    · Check-in already confirmed -> this is a check-out ATTEMPT.
        - inside check-out window -> check_out_marked_at = this detection's
          time, check_out_confirmed=1, check_out_hold_reason cleared,
          sync_status=pending. Every in-window sighting keeps overwriting
          it, so the LAST detection inside the checkout window is what
          ends up stored, per spec.
        - outside the window, and a checkout is ALREADY confirmed -> the
          row is left completely untouched (event_type=stray_ignored, no
          write at all). Without this, a person re-appearing on camera
          hours after a valid checkout (hallway walk-through, camera
          glitch) would silently overwrite their real checkout with a
          bogus one just for being the most recent sighting.
        - outside the window, no confirmed checkout yet -> HELD for
          review rather than silently discarded. check_out_marked_at
          tracks the most recent such sighting (informative only —
          check_out_confirmed stays 0, so this never syncs as a real
          checkout on its own), check_out_hold_reason records which side
          of the window it missed ('early' — seen before the window
          opened, likely left early; or 'late' — seen after it closed,
          likely stayed late/forgot to check out), and notes captures a
          human-readable timestamp via _format_checkout_hold_note.
          sync_status=held_for_review, so — same as a held check-in — it
          is invisible to the live feed and the normal auto-sync loop
          until an operator resolves it via one of:
            · mark_held_checkouts_late    — late reason only: accept the
              sighted time as the real checkout, flag status='late'.
            · mark_held_checkouts_overtime — late reason only: accept the
              sighted time as the real checkout, flag status='overtime'.
            · mark_held_checkouts_half_day — early reason only: clear the
              checkout, keep the note, flag the day status='half_day'.
            · mark_held_checkouts_short_leave — early reason only: clear
              the checkout, keep the note, flag the day status='short_leave'.
          There is deliberately no "just accept it, no decision needed"
          option, and no defer/leave-open option either — every held
          checkout must resolve immediately to one of the two decisions
          for its hold_reason.
          Held rows carry no date-based expiry (same invariant as held
          check-ins) — they persist across days, unresolved, until an
          operator acts or explicitly syncs them as-is.

    A manual_override row is always authoritative and short-circuits all
    of the above, unchanged from before.
    """
    cfg = shift_gate.load_config()
    event_dt = event_dt_utc or datetime.now(timezone.utc)
    now = event_dt.isoformat()
    today = shift_gate.resolve_attendance_bucket_date(
        people_type, person_code, event_dt, config=cfg,
    )

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

            # A half_day check-in resolution deliberately leaves
            # check_in_confirmed=0 (see mark_held_check_ins_half_day), so
            # without this it would look identical to an unresolved early
            # stray to the check-in-attempt branch below and get silently
            # re-confirmed by the next sighting. Route straight to the
            # checkout evaluator instead — same treatment check_in_confirmed=1
            # already gets a few lines down.
            if existing_dict is not None and existing_dict.get("check_in_resolution"):
                return _apply_checkout_attempt(existing_dict)

            check_in_already_confirmed = bool(existing_dict["check_in_confirmed"]) if existing_dict else False
            has_checkout_value = bool(existing_dict.get("check_out_marked_at")) if existing_dict else False

            def _apply_checkout_attempt(row: dict[str, Any]) -> dict[str, Any]:
                """Evaluate THIS call's event_dt/now as a checkout-leg sighting
                against an already-checked-in row. Factored out so the exact
                same event can reach here two ways: check-in was already
                confirmed before this call started (the ordinary case), or
                check-in was JUST auto-confirmed a few lines below — from an
                earlier stray sighting, using THAT stray's own timestamp — and
                this event still needs to be evaluated fresh, on its own merits,
                as a checkout attempt (see the auto_confirm_late branch below).
                Without this fall-through, a person's actual checkout, arriving
                any time after their check-in window closed, was being silently
                swallowed as "the late check-in" instead — see this function's
                module-level bug report for the reproduction."""
                within_co = shift_gate.is_event_within_shift(
                    people_type, event_dt, is_check_out=True, person_code=person_code, config=cfg,
                )
                check_out_ready_at = shift_gate.resolve_leg_ready_at_utc(
                    people_type, person_code, event_dt, is_check_out=True, config=cfg,
                )
                check_out_metadata_json = json.dumps(
                    {**(metadata or {}), "ready_at": check_out_ready_at}, separators=(",", ":"),
                )

                if within_co:
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
                        "sync_status": "pending", "already_marked": False,
                        "outside_shift": False, "event_type": "check_out",
                        "notes": notes,
                    }

                has_checkout_confirmed = bool(row.get("check_out_confirmed"))
                if has_checkout_confirmed:
                    return {**row, "already_marked": True, "event_type": "stray_ignored"}

                hold_reason = shift_gate.classify_check_out_timing(
                    people_type, event_dt, person_code=person_code, config=cfg,
                )
                if hold_reason not in ("early", "late"):
                    return {**row, "already_marked": True, "event_type": "outside_checkout_window_ignored"}

                note = _format_checkout_hold_note(people_type, person_code, now, hold_reason)
                notes = _merge_note(row.get("notes"), "check_out", note)
                cur.execute(
                    """
                    UPDATE attendance_buffer
                    SET check_out_marked_at = ?, check_out_confidence = ?, check_out_camera_id = ?,
                        check_out_metadata = ?, check_out_confirmed = 0, check_out_hold_reason = ?,
                        sync_status = 'held_for_review', sync_error = NULL, notes = ?
                    WHERE id = ?
                    """,
                    (now, float(confidence), camera_id, check_out_metadata_json, hold_reason, notes, row["id"]),
                )
                conn.commit()
                return {
                    **row, "check_out_marked_at": now, "check_out_confidence": float(confidence),
                    "check_out_camera_id": camera_id, "check_out_confirmed": 0, "check_out_hold_reason": hold_reason,
                    "sync_status": "held_for_review", "already_marked": False,
                    "outside_shift": True, "event_type": "check_out_pending_review",
                    "notes": notes,
                }

            # A half_day check-in resolution deliberately leaves
            # check_in_confirmed=0 (see mark_held_check_ins_half_day), so
            # without this it looks identical to an unresolved early stray
            # below and gets silently re-confirmed by the next sighting.
            # Route straight to the checkout evaluator instead — the same
            # treatment check_in_confirmed=1 already gets just below.
            if existing_dict is not None and existing_dict.get("check_in_resolution"):
                return _apply_checkout_attempt(existing_dict)

            if existing_dict is None or (not check_in_already_confirmed and not has_checkout_value):
                within = shift_gate.is_event_within_shift(
                    people_type, event_dt, is_check_out=False, person_code=person_code, config=cfg,
                )
                window_closed = (
                    not within
                    and shift_gate.is_check_in_window_closed(
                        people_type, event_dt, person_code=person_code, config=cfg,
                    )
                )
                early_stray_already_seen = bool(
                    existing_dict is not None
                    and not check_in_already_confirmed
                    and existing_dict.get("check_in_hold_reason") is None
                )
                auto_confirm_late = window_closed and early_stray_already_seen

                if existing_dict is None:
                    confirm = within
                    check_in_hold_reason = "late" if window_closed else None
                    sync_status = "pending" if confirm else "held_for_review"
                    event_type = (
                        "check_in" if within
                        else "check_in_late_pending_review" if window_closed
                        else "check_in_pending_review"
                    )
                    check_in_ready_at = shift_gate.resolve_leg_ready_at_utc(
                        people_type, person_code, event_dt, is_check_out=False, config=cfg,
                    )
                    check_in_metadata_json = json.dumps(
                        {**(metadata or {}), "ready_at": check_in_ready_at}, separators=(",", ":"),
                    )
                    local_event_id = f"{branch_id}:{people_type}:{person_code}:{today}"
                    raw_note = (
                        _format_late_check_in_note(people_type, person_code, now)
                        if window_closed else None
                    )
                    notes = _merge_note(None, "check_in", raw_note)
                    cur.execute(
                        """
                        INSERT INTO attendance_buffer (
                            local_event_id, branch_id, people_type, person_code, staff_name, attendance_date,
                            status, confidence, source, camera_id, metadata, marked_at,
                            check_in_confirmed, check_out_confirmed, sync_status, check_in_hold_reason, notes
                        ) VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
                        ON CONFLICT(branch_id, people_type, person_code, attendance_date) DO UPDATE SET
                            staff_name=excluded.staff_name, status='present', confidence=excluded.confidence,
                            source=excluded.source, camera_id=excluded.camera_id, metadata=excluded.metadata,
                            marked_at=excluded.marked_at, check_in_confirmed=excluded.check_in_confirmed,
                            sync_status=excluded.sync_status, check_in_hold_reason=excluded.check_in_hold_reason,
                            notes=excluded.notes
                        """,
                        (local_event_id, branch_id, people_type, person_code, staff_name, today,
                        float(confidence), source, camera_id, check_in_metadata_json, now,
                        1 if confirm else 0, sync_status, check_in_hold_reason, notes),
                    )
                    conn.commit()
                    return {
                        "local_event_id": local_event_id, "branch_id": branch_id,
                        "people_type": people_type, "person_code": person_code,
                        "staff_name": staff_name, "confidence": float(confidence), "camera_id": camera_id,
                        "marked_at": now, "check_out_marked_at": None, "sync_status": sync_status,
                        "already_marked": False, "outside_shift": not within, "event_type": event_type,
                        "check_in_hold_reason": check_in_hold_reason, "notes": notes,
                    }

                if auto_confirm_late:
                    raw_note = _format_late_check_in_note(
                        people_type, person_code, now, existing_dict.get("marked_at"), held=False,
                    )
                    notes = _merge_note(existing_dict.get("notes"), "check_in", raw_note)
                    cur.execute(
                        """
                        UPDATE attendance_buffer
                        SET check_in_confirmed = 1, check_in_hold_reason = NULL,
                            sync_status = 'pending', sync_error = NULL, notes = ?
                        WHERE id = ?
                        """,
                        (notes, existing_dict["id"]),
                    )
                    conn.commit()
                    confirmed_row = {
                        **existing_dict, "check_in_confirmed": 1, "check_in_hold_reason": None,
                        "sync_status": "pending", "notes": notes,
                    }
                    return _apply_checkout_attempt(confirmed_row)

                confirm = within
                check_in_hold_reason = "late" if window_closed else None
                sync_status = "pending" if confirm else "held_for_review"
                event_type = "check_in" if within else "check_in_late_pending_review"
                check_in_ready_at = shift_gate.resolve_leg_ready_at_utc(
                    people_type, person_code, event_dt, is_check_out=False, config=cfg,
                )
                check_in_metadata_json = json.dumps(
                    {**(metadata or {}), "ready_at": check_in_ready_at}, separators=(",", ":"),
                )
                raw_note = (
                    _format_late_check_in_note(
                        people_type, person_code, now, existing_dict.get("marked_at"), held=True,
                    )
                    if window_closed else None
                )
                notes = _merge_note(existing_dict.get("notes"), "check_in", raw_note)
                cur.execute(
                    """
                    UPDATE attendance_buffer
                    SET staff_name = ?, confidence = ?, source = ?, camera_id = ?, metadata = ?,
                        marked_at = ?, check_in_confirmed = ?, sync_status = ?, sync_error = NULL,
                        check_in_hold_reason = ?, notes = ?
                    WHERE id = ?
                    """,
                    (staff_name, float(confidence), source, camera_id, check_in_metadata_json,
                    now, 1 if confirm else 0, sync_status, check_in_hold_reason, notes, existing_dict["id"]),
                )
                conn.commit()
                return {
                    **existing_dict, "staff_name": staff_name, "confidence": float(confidence),
                    "camera_id": camera_id, "marked_at": now, "check_in_confirmed": 1 if confirm else 0,
                    "sync_status": sync_status, "already_marked": False,
                    "outside_shift": not within, "event_type": event_type,
                    "check_in_hold_reason": check_in_hold_reason, "notes": notes,
                }

            return _apply_checkout_attempt(existing_dict)