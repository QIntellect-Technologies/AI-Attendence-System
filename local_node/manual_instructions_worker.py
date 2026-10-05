from __future__ import annotations

import logging
import threading
from typing import Any
from datetime import datetime, timezone

from local_node.api_client import poll_manual_instructions, ack_manual_instruction, NodeApiError
from local_node.config_store import load_config, save_config
from local_node import local_db
from local_node import shift_gate
from local_node.live_events import publish_event

logger = logging.getLogger(__name__)


def _select_effective_time(instructed_iso: str | None, actual_iso: str | None, grace_minutes: int | None) -> str | None:
    """Prefer a real captured timestamp over the admin-typed instructed
    time — but only when it falls within the instruction's own grace
    window. Outside that window (or with no real capture at all, e.g. the
    person was never physically seen that day) the instructed time stays
    authoritative. This is the one place grace actually branches behavior;
    resolve_manual_instruction_window's cloud-side classification then
    measures whichever time this function picked against the instructed
    check_in_time/check_out_time + the same grace, so a sighting that's
    honored here can still classify as 'late' if it's right at the edge."""
    if not actual_iso:
        return instructed_iso
    if not instructed_iso:
        return actual_iso
    try:
        instructed_dt = datetime.fromisoformat(instructed_iso)
        actual_dt = datetime.fromisoformat(actual_iso)
    except Exception:
        return instructed_iso
    grace = int(grace_minutes or 0)
    delta_minutes = abs((actual_dt - instructed_dt).total_seconds()) / 60
    return actual_iso if delta_minutes <= grace else instructed_iso


class ManualInstructionsWorker:
    def __init__(self, interval_seconds: int = 20) -> None:
        self.interval_seconds = max(5, int(interval_seconds or 20))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="manual-instructions-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _iso_for(self, date_str: str, time_str: str | None, cfg: dict[str, Any]) -> str | None:
        """Admin types check_in_time/check_out_time in the BRANCH's local
        time (same convention as shifts.check_in_time and shift_gate's own
        window resolution) — not UTC. This used to attach tzinfo=utc
        directly to the naive HH:MM, which is only correct for a UTC
        branch; on any other branch.timezone the instructed instant was
        off by the branch's UTC offset, throwing off the grace-window
        comparison in _select_effective_time and, when the instructed time
        wins, the absolute instant written to attendance_buffer.marked_at.
        Mirrors shift_gate._branch_zone's conversion so this worker and
        the real-time gate agree on what "01:07" means for this branch.
        """
        if not time_str:
            return None
        # Expect date_str like YYYY-MM-DD and time_str like HH:MM
        try:
            naive = datetime.fromisoformat(f"{date_str}T{time_str}")
            localized = naive.replace(tzinfo=shift_gate._branch_zone(cfg))
            return localized.astimezone(timezone.utc).isoformat()
        except Exception:
            logger.warning(
                "manual-instructions: failed to parse instructed time %r on %r for branch-local conversion",
                time_str, date_str, exc_info=True,
            )
            return None

    def _local_fmt(self, iso: str | None, cfg: dict[str, Any]) -> str | None:
        """Format an ISO instant into the branch-local timezone for logs."""
        if not iso:
            return None
        try:
            zone = shift_gate._branch_zone(cfg)
            return datetime.fromisoformat(iso).astimezone(zone).isoformat()
        except Exception:
            return iso
    def run_once(self) -> int:
        cfg = load_config()
        try:
            body = poll_manual_instructions()
        except NodeApiError as exc:
            logger.warning("manual-instructions: poll FAILED (backend/network): %s", exc)
            return 0
        except Exception:
            logger.warning("manual-instructions: poll FAILED (unexpected)", exc_info=True)
            return 0

        rows = body.get("manual_instructions") if isinstance(body.get("manual_instructions"), list) else []
        if not rows:
            logger.debug("manual-instructions: nothing pending for this branch")
            return 0

        logger.info("manual-instructions: %d instruction(s) pending, applying", len(rows))
        applied = 0
        for inst in rows:
            inst_id = inst.get("id")
            try:
                people_type = inst.get("people_type") or "staff"
                person_code = inst.get("person_code") or ""
                staff_id = inst.get("staff_id") or None
                if not person_code and staff_id:
                    # Try to resolve staff_id -> person_code from local embeddings
                    try:
                        resolved = local_db.find_person_code_for_staff(str(cfg.get("branch_id") or ""), str(staff_id), people_type)
                        if resolved:
                            person_code = resolved
                    except Exception:
                        person_code = person_code or ""

                # Reconcile whatever person_code we ended up with (backend-
                # supplied or locally-resolved) against this node's own
                # convention — client_staff.person_code (e.g. "0003") and
                # the trainer-enrolled embedding person_code (e.g. "3") are
                # the same identity in two representations. Without this,
                # record_attendance_manual below writes to a brand-new,
                # disconnected attendance_buffer row instead of the
                # person's real one — the override "applies" and acks, but
                # the person's actual attendance never changes.
                if person_code:
                    try:
                        person_code = local_db.resolve_local_person_code(
                            str(cfg.get("branch_id") or ""), people_type, str(person_code),
                        )
                    except Exception:
                        pass
                logger.debug(
                    "manual-instructions: processing inst=%s branch=%s staff_id=%s resolved_person_code=%s",
                    inst_id, str(cfg.get("branch_id") or ""), str(staff_id), str(person_code),
                )
                attendance_date = inst.get("attendance_date") or datetime.now(timezone.utc).date().isoformat()
                check_in_time = inst.get("check_in_time")
                check_out_time = inst.get("check_out_time")
                check_in_grace_minutes = inst.get("check_in_grace_minutes")
                check_out_grace_minutes = inst.get("check_out_grace_minutes")

                check_in_instructed_iso = self._iso_for(attendance_date, check_in_time, cfg)
                check_out_instructed_iso = self._iso_for(attendance_date, check_out_time, cfg)

                # A real camera sighting may already exist for this person+date
                # (e.g. they walked in before this override was even created, or
                # before this poll cycle picked it up). Never treat a prior
                # manual_override row as a "real" sighting — that would just be
                # honoring a different instruction's own typed time.
                existing_row = local_db.get_attendance_row(str(cfg.get("branch_id") or ""), people_type, str(person_code), attendance_date)
                logger.debug("manual-instructions: existing_row=%r", existing_row)
                existing_is_real_capture = bool(
                    existing_row and existing_row.get("source") not in (None, "manual_override")
                )
                actual_check_in_iso = existing_row.get("marked_at") if existing_is_real_capture else None
                actual_check_out_iso = existing_row.get("check_out_marked_at") if existing_is_real_capture else None

                check_in_iso = _select_effective_time(check_in_instructed_iso, actual_check_in_iso, check_in_grace_minutes)
                check_out_iso = _select_effective_time(check_out_instructed_iso, actual_check_out_iso, check_out_grace_minutes)

                # Use a moderate confidence for manual overrides
                confidence = float(inst.get("confidence") or 0.99)

                # Log the UTC and branch-local representations for debug
                local_check_in_log = self._local_fmt(check_in_iso, cfg)
                local_check_out_log = self._local_fmt(check_out_iso, cfg)

                result = local_db.record_attendance_manual(
                    branch_id=str(cfg.get("branch_id") or ""),
                    people_type=people_type,
                    person_code=str(person_code),
                    staff_name=str(inst.get("staff_name") or ""),
                    confidence=confidence,
                    attendance_date=attendance_date,
                    check_in_marked_at=check_in_iso,
                    check_out_marked_at=check_out_iso,
                    source="manual_override",
                    camera_id=None,
                    metadata={"instruction_id": inst_id},
                )

                # Verify the attendance_buffer row was written as an authoritative
                # manual_override before acking the backend. This prevents a
                # false-positive ack when a subsequent camera write or a
                # branch_id mismatch meant the authoritative row wasn't created.
                verified = False
                try:
                    written = local_db.get_attendance_row(str(cfg.get("branch_id") or ""), people_type, str(person_code), attendance_date)
                    if written and written.get("source") == "manual_override":
                        meta = (written.get("metadata") or {})
                        if isinstance(meta, dict) and meta.get("instruction_id") == inst_id:
                            verified = True
                except Exception:
                    logger.warning("manual-instructions: verification read failed for %s", inst_id, exc_info=True)

                if not verified:
                    # If verification failed, inject the instruction into the
                    # node runtime config so the real-time shift gate will
                    # evaluate live detections against it immediately. Do not
                    # ack the backend so the instruction remains pending and
                    # will be retried until the DB write succeeds.
                    logger.warning(
                        "manual-instructions: verification FAILED for %s; written_row=%r; existing_row=%r",
                        inst_id, written, existing_row,
                    )
                    try:
                        cfg_local = load_config()
                        pending = cfg_local.get("manual_instructions") or []
                        # Avoid duplicating the same instruction
                        if not any(i.get("id") == inst_id for i in pending):
                            pending.append(inst)
                            save_config({"manual_instructions": pending})
                            logger.info("manual-instructions: injected %s into runtime config for gating", inst_id)
                    except Exception:
                        logger.warning("manual-instructions: failed to inject instruction %s into runtime config", inst_id, exc_info=True)
                else:
                    publish_event({
                        "id": result.get("local_event_id"),
                        "name": result.get("staff_name") or result.get("person_code"),
                        "staff_id": result.get("person_code"),
                        "status": "created",
                        "message": "Applied manual attendance instruction",
                        "marked_at": result.get("marked_at"),
                    })

                    logger.info(
                        "manual-instructions: applied instruction %s -> %s:%s (check_in=%s local=%s, check_out=%s local=%s)",
                        inst_id, people_type, person_code, check_in_iso, local_check_in_log, check_out_iso, local_check_out_log,
                    )

                    try:
                        ack_manual_instruction(str(inst_id), "applied", "Applied by node")
                    except Exception:
                        logger.warning(
                            "manual-instructions: applied %s locally but ack FAILED "
                            "(will be re-applied as a no-op next poll)", inst_id, exc_info=True,
                        )

                    applied += 1
            except Exception as exc:
                logger.warning(
                    "manual-instructions: FAILED to apply instruction %s: %s", inst_id, exc, exc_info=True,
                )
                try:
                    if inst.get("id"):
                        ack_manual_instruction(str(inst.get("id")), "failed", str(exc))
                except Exception:
                    logger.warning(
                        "manual-instructions: also failed to ack failure for %s", inst_id, exc_info=True,
                    )

        return applied

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                logger.warning("manual-instructions: run_once() raised, will retry next cycle", exc_info=True)
            self._stop.wait(self.interval_seconds)