from __future__ import annotations

import threading
from datetime import datetime, timezone

from local_node import local_db
from local_node.attendance_sync_worker import AttendanceSyncWorker
from local_node.api_client import fetch_node_config
from local_node.camera_config import get_enabled_cameras
from local_node.camera_stream_manager import get_camera_stream_manager
from local_node.config_store import get_branch_id, is_activated, load_config, save_config, write_runtime_status
from local_node.heartbeat_worker import HeartbeatWorker
from local_node.manual_instructions_worker import ManualInstructionsWorker
from logger_config import get_logger


logger = get_logger(__name__)

def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class NodeService:
    def __init__(self) -> None:
        cfg = load_config()
        self.interval_seconds = max(10, min(int(cfg.get("poll_interval_seconds") or 30), 300))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.heartbeat_worker = HeartbeatWorker(15)
        self.attendance_sync_worker = AttendanceSyncWorker()
        self.manual_instructions_worker = ManualInstructionsWorker(20)
        self.camera_manager = get_camera_stream_manager()

    def start(self) -> None:
        local_db.init_db()
        from local_node import recognition_engine
        recognition_engine.warmup()   # blocks briefly, once, before any camera thread exists
        self.heartbeat_worker.start()
        self.attendance_sync_worker.start()
        self.manual_instructions_worker.start()
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="node-service", daemon=True)
        self._thread.start()


    def stop(self) -> None:
        self._stop.set()
        self.heartbeat_worker.stop()
        self.attendance_sync_worker.stop()
        self.manual_instructions_worker.stop()
        self.camera_manager.stop_all()

    def run_cycle(self) -> dict:
        if not is_activated():
            status = {"cycle_status": "waiting_for_activation", "last_cycle_at": utc_now()}
            write_runtime_status(status)
            self.camera_manager.stop_all()
            return status

        cfg = load_config()
        branch_id = get_branch_id(cfg)

        # Network can be down for extended periods — this must never prevent
        # cameras from running on the LAST KNOWN GOOD config. Only apply
        # updates when the fetch actually succeeds; on failure, fall through
        # using whatever is already saved in node_config.json from the
        # previous successful poll.
        offline = False
        try:
            runtime = fetch_node_config()
        except Exception as exc:
            offline = True
            runtime = {}
            logger.warning("run_cycle: cloud config fetch failed (%s) — continuing offline on last-known config", exc)

        if isinstance(runtime, dict) and runtime:
            sync_updates = {}
            if "sync_delay_minutes" in runtime:
                sync_updates["sync_delay_minutes"] = int(runtime.get("sync_delay_minutes") or 0)
            if "shift_mode_enabled" in runtime:
                sync_updates["shift_mode_enabled"] = bool(runtime.get("shift_mode_enabled", False))
            if "shift_windows" in runtime:
                sync_updates["shift_windows"] = runtime.get("shift_windows") or {}
            if "staff_shift_windows" in runtime:
                sync_updates["staff_shift_windows"] = runtime.get("staff_shift_windows") or {}
            # Persist the camera list too — this is what run_cycle falls back to
            # via get_enabled_cameras(cfg) when offline. Without this, cfg never
            # carries cameras at all, so the very first failed fetch makes the
            # offline branch see an empty camera list and sync_cameras() tears
            # down every running camera (including local webcams that need no
            # internet at all) instead of leaving them on the last-known set.
            if "cameras" in runtime:
                sync_updates["cameras"] = runtime.get("cameras") or []
            branch_info = runtime.get("branch") if isinstance(runtime.get("branch"), dict) else {}
            if branch_info.get("timezone"):
                sync_updates["branch"] = {"timezone": branch_info["timezone"]}
            if sync_updates:
                save_config(sync_updates)
                cfg = load_config()

        mode = str((runtime.get("attendance_mode") if runtime else None) or cfg.get("attendance_mode") or "local").lower()
        cameras = get_enabled_cameras(cfg if offline else (runtime if runtime else cfg))

        if mode == "local" and branch_id:
            camera_changes = self.camera_manager.sync_cameras(branch_id, cameras)
        else:
            camera_changes = self.camera_manager.stop_all()

        status = {
            "attendance_mode": mode,
            "cycle_status": "ok" if not offline else "ok_offline",
            "configured_cameras": len(cameras),
            "streaming_cameras": len(self.camera_manager.list_cameras()),
            "last_cycle_at": utc_now(),
            "last_error": None,
            "camera_changes": camera_changes,
            "camera_changes_at": utc_now() if camera_changes else None,
            "offline": offline,
        }
        write_runtime_status(status)
        return status



    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_cycle()
            except Exception as exc:
                write_runtime_status({"cycle_status": "error", "last_cycle_at": utc_now(), "last_error": str(exc)})
            self._stop.wait(self.interval_seconds)

    def sync_all_attendance(self) -> int:
        """Manual "Sync attendance" flush — pushes every pending AND
        held_for_review row now, bypassing sync_delay_minutes and the
        outside-shift hold. See AttendanceSyncWorker.run_once(force_all=True)."""
        return self.attendance_sync_worker.run_once(force_all=True)

    def sync_selected_attendance(self, local_event_ids: list[str]) -> int:
        """"Sync selected" from the held-review screen — pushes only the
        rows the operator explicitly ticked. See
        AttendanceSyncWorker.run_once(local_event_ids=...)."""
        return self.attendance_sync_worker.run_once(local_event_ids=local_event_ids)

    def mark_held_checkouts_late(self, local_event_ids: list[str]) -> dict:
        """"Mark late" from the held-review screen — late-sighting rows
        only; one of exactly two decisions for a late-checkout hold (the
        other is mark_held_checkouts_overtime). Accepts the sighted time
        as the real checkout and flags status='late', so the admin
        dashboard has something to decide on. See
        local_db.mark_held_checkouts_late."""
        return local_db.mark_held_checkouts_late(local_event_ids)

    def mark_held_checkouts_half_day(self, local_event_ids: list[str]) -> dict:
        """"Mark half-day" from the held-review screen — early-departure
        rows only. See local_db.mark_held_checkouts_half_day."""
        return local_db.mark_held_checkouts_half_day(local_event_ids)

    def mark_held_checkouts_short_leave(self, local_event_ids: list[str]) -> dict:
        """"Mark short leave" from the held-review screen — early-departure
        rows only, same detection as mark_held_checkouts_half_day, operator
        picks which of the two outcomes applies. See
        local_db.mark_held_checkouts_short_leave."""
        return local_db.mark_held_checkouts_short_leave(local_event_ids)

    def mark_held_checkouts_overtime(self, local_event_ids: list[str]) -> dict:
        """"Mark overtime" from the held-review screen — late-sighting
        rows only. See local_db.mark_held_checkouts_overtime."""
        return local_db.mark_held_checkouts_overtime(local_event_ids)

    def mark_held_checkouts_early_left(self, local_event_ids: list[str]) -> dict:
        """"Mark early left" from the held-review screen — early-departure
        rows only; third option alongside mark_held_checkouts_half_day and
        mark_held_checkouts_short_leave. Accepts the sighted time as the
        real checkout but does NOT touch status — only records "Early
        left" in notes, since status is this table's arrival-side
        classification. See local_db.mark_held_checkouts_early_left."""
        return local_db.mark_held_checkouts_early_left(local_event_ids)

    def mark_held_check_ins_late(self, local_event_ids: list[str]) -> dict:
        """"Mark late" from the held-review screen — late check-in rows
        only; one of three decisions for a late check-in hold (the others
        are short_leave and half_day). Accepts the sighted time as the
        real check-in and flags status='late'. See
        local_db.mark_held_check_ins_late."""
        return local_db.mark_held_check_ins_late(local_event_ids)

    def mark_held_check_ins_short_leave(self, local_event_ids: list[str]) -> dict:
        """"Mark short leave" from the held-review screen — late check-in
        rows only. Accepts the sighted time as the real check-in and flags
        status='short_leave'. See
        local_db.mark_held_check_ins_short_leave."""
        return local_db.mark_held_check_ins_short_leave(local_event_ids)

    def mark_held_check_ins_half_day(self, local_event_ids: list[str]) -> dict:
        """"Mark half-day" from the held-review screen — late check-in rows
        only. See local_db.mark_held_check_ins_half_day."""
        return local_db.mark_held_check_ins_half_day(local_event_ids)

    def delete_held_attendance(self, local_event_ids: list[str]) -> list[dict]:
        """"Delete" from the held-review screen — removes specific
        held_for_review rows from this node entirely (never synced, so
        there is nothing on the cloud to reconcile) and re-arms each
        deleted person's per-camera dedupe throttle so they're eligible to
        be re-detected on the very next frame instead of waiting out
        DUPLICATE_LOG_SECONDS."""
        deleted_rows = local_db.delete_attendance_rows(local_event_ids)
        for row in deleted_rows:
            self.camera_manager.clear_person_throttle(row["people_type"], row["person_code"])
        return deleted_rows