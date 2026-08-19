"""
local_node/camera_stream_manager.py

Continuous, per-camera RTSP reader shared by:
  - the live MJPEG preview grid in the node UI (ui_server.py)
  - real-time face recognition / attendance marking

Replaces camera_worker.py's cycle-based approach (open RTSP, read N frames,
close, repeat every poll interval). That approach re-opened the RTSP/NVR
connection every cycle and left nothing for a live UI to render between
cycles. A single persistent reader thread per camera keeps one connection
open, runs detection continuously, and always has a fresh frame ready for
the MJPEG endpoint — one source of truth per camera, not two divergent
capture loops for "watch it" vs. "recognize on it".

Reader/processor split
-----------------------
Frame acquisition (this thread's _run_reader) and frame processing
(_run_processor: detection + JPEG encode) run on two SEPARATE threads per
camera, not one. Face detection is CPU-bound and takes real time (hundreds
of ms on CPU-only hardware) — if that work ran inline in the same loop
that calls cap.read(), the RTSP source keeps buffering new frames on the
network faster than the loop drains them while detection blocks it, so
cap.read() returns progressively staler frames and the stream falls
further behind live over time (it never catches up). The reader thread's
only job is to keep draining the capture as fast as possible into
`state.raw_frame`, so cv2's own buffer never has anywhere to accumulate a
backlog. The processor thread reads whatever frame is currently freshest,
at its own pace, without ever holding up the reader.

No on-video match overlay is drawn — the live feed always shows the plain
camera image. Attendance marking and the live-events snapshot/confidence
still fire normally on a match; only the green box is intentionally absent.
"""
from __future__ import annotations

import base64
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import cv2
from local_node.config_store import read_runtime_status, write_runtime_status
from local_node.recognition_engine import detect_and_extract, FaceEngineUnavailableError
from local_node import local_db
from local_node import shift_gate
from local_node.live_events import publish_event
from local_node.recognition_worker import best_match

logger = logging.getLogger(__name__)

DETECT_EVERY_N_FRAMES = 5
STREAM_FPS_LIMIT = 12
DUPLICATE_LOG_SECONDS = 30
RECONNECT_BACKOFF_SECONDS = 5
TRACK_IOU_MATCH_THRESHOLD = 0.2
TRACK_MAX_UNSEEN_SECONDS = 2.0

FAILURE_THRESHOLD_BEFORE_FALLBACK = 3     # consecutive open/read failures on the active URL
PRIMARY_RETRY_INTERVAL_SECONDS = 120       # how often to re-try the local URL while on fallback

def _select_url(state: _CameraState) -> str:
    """Automatic local→public failover — no manual toggle. Starts on the
    local (primary) URL every time a camera (re)starts, since that's the
    lower-latency path when it's reachable. Only moves to the public
    fallback after repeated real failures on whichever URL is currently
    active, and only if a fallback URL was actually supplied by the
    cloud config for this camera."""
    if not state.active_url:
        state.active_url = state.rtsp_url or state.rtsp_url_fallback
        state.using_fallback = state.active_url == state.rtsp_url_fallback and state.active_url != state.rtsp_url
    return state.active_url


def _handle_open_or_read_failure(state: _CameraState) -> None:
    state.consecutive_failures += 1
    if state.consecutive_failures < FAILURE_THRESHOLD_BEFORE_FALLBACK:
        return
    state.consecutive_failures = 0

    if not state.using_fallback and state.rtsp_url_fallback:
        logger.warning(
            "Camera %s: local URL failing repeatedly, switching to public-IP fallback",
            state.camera_id,
        )
        state.active_url = state.rtsp_url_fallback
        state.using_fallback = True
        state._last_primary_retry = time.time()
    elif state.using_fallback and state.rtsp_url:
        # Already on fallback and even that's failing repeatedly — try
        # primary again in case the real problem was on the public side
        # (e.g. router/port-forward down), not the LAN.
        logger.warning(
            "Camera %s: public-IP fallback also failing, retrying local URL",
            state.camera_id,
        )
        state.active_url = state.rtsp_url
        state.using_fallback = False


def _maybe_retry_primary(state: _CameraState) -> None:
    """While parked on the fallback URL, periodically attempt to move back
    to the local URL — cheaper/lower-latency once the LAN is reachable
    again. A failed attempt just falls back again via the normal
    open-failure path above, so this is safe to try opportunistically."""
    if not state.using_fallback or not state.rtsp_url:
        return
    last_try = getattr(state, "_last_primary_retry", 0.0)
    if time.time() - last_try < PRIMARY_RETRY_INTERVAL_SECONDS:
        return
    state._last_primary_retry = time.time()
    state.active_url = state.rtsp_url
    state.using_fallback = False
    state.consecutive_failures = 0
    logger.info("Camera %s: attempting to switch back to local URL", state.camera_id)

@dataclass
class _CameraState:
    camera_id: str
    camera_name: str
    camera_location: str
    camera_type: str = "nvr"
    device_index: int = 0
    rtsp_url: str = ""
    rtsp_url_fallback: str = ""
    active_url: str = ""             
    using_fallback: bool = False       
    consecutive_failures: int = 0      
    raw_frame: Any = None
    latest_jpeg: bytes | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    last_seen_by_person: dict[str, float] = field(default_factory=dict)
    tracked_faces: dict[int, dict[str, Any]] = field(default_factory=dict)
    next_track_id: int = 0
    stop_event: threading.Event = field(default_factory=threading.Event)
    reader_thread: threading.Thread | None = None
    processor_thread: threading.Thread | None = None
    detector_thread: threading.Thread | None = None
    pending_detect_frame: Any = None
    detect_lock: threading.Lock = field(default_factory=threading.Lock)


class CameraStreamManager:
    """Owns one background reader thread + one processor thread per enabled camera."""

    def __init__(self) -> None:
        self._cameras: dict[str, _CameraState] = {}
        self._lock = threading.Lock()

    # ── lifecycle ────────────────────────────────────────────────────────

    @staticmethod
    def _camera_signature(camera: dict[str, Any]) -> tuple:
        """Fields that require a reader/processor restart if changed."""
        return (
            str(camera.get("rtsp_url") or camera.get("rtspUrl") or ""),
            str(camera.get("camera_name") or camera.get("name") or ""),
            str(camera.get("location") or ""),
            str(camera.get("camera_type") or "nvr").lower(),
            int(camera.get("device_index") or camera.get("channel") or 0),
        )
    
    def sync_cameras(self, branch_id: str, cameras: list[dict[str, Any]]) -> list[dict[str, str]]:
        """Reconcile running workers with the current enabled-camera list.
        Idempotent — safe to call on every poll cycle. Restarts a camera's
        if nothing changed), so callers can surface a one-shot notification
        instead of the caller having to diff state itself."""
        wanted = {str(c.get("id") or c.get("camera_id")): c for c in cameras}
        changes: list[dict[str, str]] = []

        with self._lock:
            for camera_id in list(self._cameras.keys()):
                if camera_id not in wanted:
                    removed_name = self._cameras[camera_id].camera_name
                    self._stop_camera_locked(camera_id)
                    changes.append({"camera_id": camera_id, "camera_name": removed_name, "change_type": "removed"})

            for camera_id, camera in wanted.items():
                existing = self._cameras.get(camera_id)
                new_signature = self._camera_signature(camera)
                camera_name = new_signature[1] or camera_id

                if existing is not None:
                    existing_signature = (
                        existing.rtsp_url,
                        existing.camera_name,
                        existing.camera_location,
                        existing.camera_type,
                        existing.device_index,
                    )
                    if existing_signature == new_signature:
                        continue  # unchanged — leave the running threads alone
                    self._stop_camera_locked(camera_id)
                    change_type = "updated"
                else:
                    change_type = "added"

                rtsp_url, _, _, camera_type, device_index = new_signature
                # A webcam has no rtsp_url and is still a valid, startable
                # camera — only skip when there's truly no way to open a source.
                if not rtsp_url and camera_type != "webcam":
                    continue
                self._start_camera_locked(camera_id, camera, rtsp_url, camera_type, device_index, branch_id)
                changes.append({"camera_id": camera_id, "camera_name": camera_name, "change_type": change_type})

        return changes

    def _start_camera_locked(
        self,
        camera_id: str,
        camera: dict[str, Any],
        rtsp_url: str,
        camera_type: str,
        device_index: int,
        branch_id: str,
    ) -> None:
        rtsp_url_fallback = str(camera.get("rtsp_url_fallback") or "")
        logger.info(
            "Camera %s (%s): starting stream, rtsp_url=%r, fallback=%r, type=%s, device_index=%s",
            camera_id, camera.get("camera_name") or camera.get("name") or camera_id,
            rtsp_url, rtsp_url_fallback, camera_type, device_index,
        )
        state = _CameraState(
            camera_id=camera_id,
            camera_name=str(camera.get("camera_name") or camera.get("name") or camera_id),
            camera_location=str(camera.get("location") or ""),
            camera_type=camera_type,
            device_index=device_index,
            rtsp_url=rtsp_url,
            rtsp_url_fallback=rtsp_url_fallback,
        )
        state.reader_thread = threading.Thread(
            target=self._run_reader, args=(state,), name=f"camera-reader-{camera_id}", daemon=True,
        )
        state.processor_thread = threading.Thread(
            target=self._run_processor, args=(state, branch_id), name=f"camera-processor-{camera_id}", daemon=True,
        )
        state.detector_thread = threading.Thread(
            target=self._run_detector, args=(state, branch_id), name=f"camera-detector-{camera_id}", daemon=True,
        )
        self._cameras[camera_id] = state
        state.reader_thread.start()
        state.processor_thread.start()
        state.detector_thread.start()

    def stop_all(self) -> list[dict[str, str]]:
        changes: list[dict[str, str]] = []
        with self._lock:
            for camera_id in list(self._cameras.keys()):
                camera_name = self._cameras[camera_id].camera_name
                self._stop_camera_locked(camera_id)
                changes.append({"camera_id": camera_id, "camera_name": camera_name, "change_type": "removed"})
        return changes

    def _stop_camera_locked(self, camera_id: str) -> None:
        state = self._cameras.pop(camera_id, None)
        if state:
            state.stop_event.set()

    # ── read side (UI) ──────────────────────────────────────────────────

    def clear_person_throttles(self) -> None:
        """Reset the in-memory 30s dedupe throttle on every camera. Paired
        with local_db.clear_today_attendance() in the "Clear today's
        attendance" action — without this, a person cleared from the DB
        would still be silently skipped by should_log-equivalent throttling
        in _detect_and_record for up to DUPLICATE_LOG_SECONDS after the
        clear, since that throttle is independent of what's in SQLite."""
        with self._lock:
            for state in self._cameras.values():
                state.last_seen_by_person.clear()

    def clear_person_throttle(self, people_type: str, person_code: str) -> None:
        """Single-person variant of clear_person_throttles() — reset just
        one person's dedupe timer across every camera, instead of every
        person's. Used after deleting one held-for-review row (see
        local_db.delete_attendance_rows): clearing the whole throttle map
        for every camera on a single-person delete would also make every
        OTHER currently-throttled person eligible for an immediate
        duplicate re-log, which is unrelated to what the operator asked
        for."""
        person_key = f"{people_type}:{person_code}"
        with self._lock:
            for state in self._cameras.values():
                state.last_seen_by_person.pop(person_key, None)

    def list_cameras(self) -> list[dict[str, str]]:
        with self._lock:
            return [
                {"id": s.camera_id, "name": s.camera_name, "location": s.camera_location}
                for s in self._cameras.values()
            ]

    def mjpeg_frames(self, camera_id: str):
        """Generator yielding a multipart/x-mixed-replace stream for one camera."""
        min_interval = 1.0 / STREAM_FPS_LIMIT
        while True:
            with self._lock:
                state = self._cameras.get(camera_id)
            if state is None:
                break
            with state.lock:
                frame = state.latest_jpeg
            if frame is not None:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
            time.sleep(min_interval)

    # ── reader thread: keeps draining the RTSP source, never blocks ─────
    @staticmethod
    def _open_capture(state: _CameraState, url: str) -> cv2.VideoCapture | None:
        """The only place a cv2.VideoCapture is ever constructed for a camera.
        Returns an opened capture, or None on failure (never a half-open one
        left for the caller to detect and release itself — that split
        responsibility is what let a previous edit accidentally duplicate the
        open call and leak/double-lock a device handle). Centralizing it here
        makes that class of bug structurally impossible: there's exactly one
        call site to get wrong instead of several places that must all agree.
        """
        is_webcam = state.camera_type == "webcam"

        if is_webcam:
            # DirectShow is the reliable Windows backend for local capture
            # devices — CAP_FFMPEG (used below for RTSP) cannot open a device
            # index at all.
            cap = cv2.VideoCapture(state.device_index, cv2.CAP_DSHOW)
        else:
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG if hasattr(cv2, "CAP_FFMPEG") else 0)
            # Bound the connect/read timeout explicitly. Without this, an
            # unreachable NVR/DVR doesn't fail — cap.read() just blocks for
            # however long the underlying ffmpeg/TCP stack is willing to wait
            # (unbounded on some builds), which is exactly what makes a
            # genuinely-dead camera look identical to a UI/threading bug: the
            # reader thread is alive, just stuck inside a single read() call
            # instead of ever reaching the failure/retry path below. Available
            # since OpenCV 4.5.4; silently skipped on older builds.
            for prop_name, timeout_ms in (
                ("CAP_PROP_OPEN_TIMEOUT_MSEC", 5000),
                ("CAP_PROP_READ_TIMEOUT_MSEC", 5000),
            ):
                prop = getattr(cv2, prop_name, None)
                if prop is not None:
                    try:
                        cap.set(prop, timeout_ms)
                    except Exception:
                        pass

        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass

        if not cap.isOpened():
            cap.release()
            return None
        return cap


    def _run_reader(self, state: _CameraState) -> None:
        cap: cv2.VideoCapture | None = None
        try:
            while not state.stop_event.is_set():
                if cap is None:
                    _maybe_retry_primary(state)
                    url = _select_url(state)
                    is_webcam = state.camera_type == "webcam"

                    if not url and not is_webcam:
                        state.stop_event.wait(RECONNECT_BACKOFF_SECONDS)
                        continue

                    cap = self._open_capture(state, url)
                    if cap is None:
                        source_desc = (
                            f"webcam device {state.device_index}" if is_webcam
                            else ("fallback/public" if state.using_fallback else "primary/local")
                        )
                        logger.warning(
                            "Camera %s: failed to open %s stream (%s), retrying",
                            state.camera_id, source_desc, state.camera_type,
                        )
                        _handle_open_or_read_failure(state)
                        state.stop_event.wait(RECONNECT_BACKOFF_SECONDS)
                        continue
                    state.consecutive_failures = 0

                ok, frame = cap.read()
                if not ok:
                    logger.warning(
                        "Camera %s: %s stream opened but frame read failed — reconnecting",
                        state.camera_id,
                        "fallback/public" if state.using_fallback else "primary/local",
                    )
                    cap.release()
                    cap = None
                    _handle_open_or_read_failure(state)
                    state.stop_event.wait(RECONNECT_BACKOFF_SECONDS)
                    continue

                with state.lock:
                    state.raw_frame = frame
        finally:
            if cap is not None:
                cap.release()

    # ── processor thread: detection + encode, off the freshest frame ──
    
    def _run_processor(self, state: _CameraState, branch_id: str) -> None:
        frame_index = 0
        frame_interval = 1.0 / STREAM_FPS_LIMIT
        while not state.stop_event.is_set():
            loop_started = time.time()
            with state.lock:
                frame = state.raw_frame.copy() if state.raw_frame is not None else None

            if frame is None:
                state.stop_event.wait(frame_interval)
                continue

            frame_index += 1
            # Offer the freshest frame to the detector on EVERY tick, not
            # just every Nth one. The detector already self-throttles —
            # it holds at most one pending frame and overwrites it if
            # still busy on the previous pass — so gating the handoff
            # here too only adds a fixed extra delay on top of real
            # detection time, for no benefit. This lets a fast-moving or
            # running person be caught by whichever frame the detector is
            # actually free to pick up next, instead of waiting on an
            # arbitrary Nth tick that may land after they've already left.
            with state.detect_lock:
                state.pending_detect_frame = frame

            display_frame = frame
            ok, encoded = cv2.imencode(".jpg", display_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            if ok:
                with state.lock:
                    state.latest_jpeg = encoded.tobytes()

            elapsed = time.time() - loop_started
            state.stop_event.wait(max(0.0, frame_interval - elapsed))

    # ── detector thread: the CPU-heavy work, off the display path ───────

   
    def _run_detector(self, state: _CameraState, branch_id: str) -> None:
        while not state.stop_event.is_set():
            with state.detect_lock:
                frame = state.pending_detect_frame
                state.pending_detect_frame = None
            if frame is None:
                state.stop_event.wait(0.05)
                continue
            try:
                self._detect_and_record(state, frame, branch_id)
            except Exception as exc:
                # A single bad detection must never permanently kill this
                # thread's loop — an uncaught exception here previously ended
                # _run_detector silently, so this ONE camera stopped
                # recognizing anyone at all until the whole node process was
                # restarted, with no visible error except a dead thread. This
                # is exactly the failure mode the check_out_metadata_json bug
                # (see local_db.py) would have hit on this camera's very first
                # successful checkout, before that fix landed.
                logger.exception(
                    "Camera %s: detection pass raised unexpectedly, skipping this frame: %s",
                    state.camera_id, exc,
                )
                write_runtime_status({
                    **read_runtime_status(),
                    "cycle_status": "error",
                    "last_error": f"Detection error ({state.camera_id}): {exc}",
                })

    def _detect_and_record(self, state: _CameraState, frame, branch_id: str) -> None:
        try:
            faces = detect_and_extract(frame)
        except FaceEngineUnavailableError as exc:
            # Surface real engine failures to /api/status -> runtime.last_error,
            # which App.tsx already renders as a warning bar — this plumbing
            # existed but was never fed anything, since detect_and_extract used
            # to swallow this exact failure into an empty list. Also log it —
            # write_runtime_status alone left this invisible in node.log, so a
            # per-frame engine failure looked identical to "no face in frame".
            logger.warning(
                "Camera %s: face engine unavailable on this detection pass: %s",
                state.camera_id, exc,
            )
            write_runtime_status({
                **read_runtime_status(),
                "cycle_status": "error",
                "last_error": f"Face engine unavailable ({state.camera_id}): {exc}",
            })
            return

        embeddings_on_node = len(local_db.get_all_embeddings(branch_id))
        logger.info(
            "Camera %s: detection pass -> %d face(s) found (embeddings on node for this branch: %d)",
            state.camera_id, len(faces), embeddings_on_node,
        )

        now = time.time()

        # Drop tracks not seen recently — otherwise tracked_faces grows
        # forever and old bboxes could wrongly "claim" a new face via IoU.
        stale = [tid for tid, t in state.tracked_faces.items() if now - t["last_seen"] > TRACK_MAX_UNSEEN_SECONDS]
        for tid in stale:
            del state.tracked_faces[tid]

        for face in faces:
            embedding = face.get("embedding")
            if embedding is None:
                logger.info("Camera %s: face detected but no embedding extracted (bad crop/landmarks?)", state.camera_id)
                continue

            bbox = face.get("bbox")
            track_id, track = self._assign_track(state, bbox, now)

            # Only pay for best_match() the FIRST time a face is seen, or
            # if it's still unidentified — once a track has a confirmed
            # match, every subsequent frame of that same physical face
            # (same person standing in view) reuses the cached identity
            # instead of re-running the match against every enrolled
            # profile again. This is what actually stops the redundant
            # work that Fix 1's cache alone doesn't: Fix 1 makes each
            # match cheap; this stops it from running dozens of times per
            # second for the same person.
            if track.get("match") is None:
                match = best_match(embedding)
                track["match"] = match if match is not None else False   # False = "tried, no match"
            match = track["match"] or None
            if not match:
                continue

            person_key = f'{match["people_type"]}:{match["person_code"]}'
            if now - state.last_seen_by_person.get(person_key, 0) < DUPLICATE_LOG_SECONDS:
                continue
            state.last_seen_by_person[person_key] = now

            row = local_db.record_attendance_local(
                branch_id=branch_id,
                people_type=match["people_type"],
                person_code=match["person_code"],
                staff_name=match.get("staff_name") or match["person_code"],
                confidence=float(match.get("confidence") or 0),
                source="camera",
                camera_id=state.camera_id,
                metadata={"camera_name": state.camera_name},
                event_dt_utc=datetime.now(timezone.utc),
            )
            # Diagnostic for the "wrong window" class of bug (personal
            # shift override not reaching the node vs. a stale config poll
            # vs. a person_code mismatch between the embeddings package and
            # client_staff): log exactly which tier supplied the window
            # this decision was made against, not just the pass/fail
            # result. Cheap enough to run on every detection; remove once
            # the shift-window sync path is trusted.
            debug_window = shift_gate.resolve_window_for_debug(match["people_type"], match["person_code"])
            cfg = shift_gate.load_config()
            branch_shift_types_configured = sorted((cfg.get("shift_windows") or {}).keys())
            logger.info(
                "shift-gate check: name=%r person=%s:%s camera=%s confidence=%.2f "
                "event_type=%s outside_shift=%s window_source=%s resolved_window=%s "
                "shift_mode_enabled=%s | branch default shifts configured for people_types=%s "
                "| personal overrides synced on node=%d",
                match.get("staff_name") or "(unknown)",
                match["people_type"], match["person_code"], state.camera_name,
                float(match.get("confidence") or 0),
                row.get("event_type"), row.get("outside_shift"),
                debug_window["source"], debug_window["effective_window"],
                cfg.get("shift_mode_enabled", False), branch_shift_types_configured,
                debug_window["staff_shift_windows_count"],
            )

            bbox = face.get("bbox")

            # publish_event upserts by local_event_id, so it's safe to call
            # on every sighting (including repeat check_out updates) — a
            # repeat sighting updates that person's existing card in place
            # rather than spawning a duplicate. Suppressed in three cases:
            # held_for_review (outside-shift, awaiting manual review) stays
            # invisible until the operator flushes it; locked_by_manual_override
            # means record_attendance_local deliberately wrote nothing (a
            # manual instruction already owns this person's row for today —
            # see local_db.py); stray_ignored means a checkout was already
            # confirmed and this later sighting was correctly discarded —
            # in both of the latter cases nothing changed, so there's
            # nothing new to publish.
            if row.get("event_type") in (
                "locked_by_manual_override", "stray_ignored", "outside_checkout_window_ignored",
            ):
                continue
            if row.get("sync_status") != "held_for_review":
                event_type = row.get("event_type", "check_in")
                is_check_out = event_type == "check_out"
                snapshot_b64 = self._encode_snapshot(frame, bbox)
                effective_marked_at = row.get("check_out_marked_at") if is_check_out else row["marked_at"]
                message = "Checked out." if is_check_out else "Checked in."
                publish_event({
                    "id": row["local_event_id"],
                    "name": row.get("staff_name") or row["person_code"],
                    "staff_id": row["person_code"],
                    "status": "checked_out" if is_check_out else "checked_in",
                    "confidence": row["confidence"],
                    "message": message,
                    "marked_at": effective_marked_at,
                    "check_out_marked_at": row.get("check_out_marked_at"),
                    "sync_status": row.get("sync_status", "pending"),
                    "camera_id": state.camera_id,
                    "camera_name": state.camera_name,
                    "snapshot": snapshot_b64,
                    "notes": row.get("notes"),
                })
            elif row.get("check_in_just_confirmed"):
                # The checkout attempt this same call produced is held for
                # review (early/late), so the block above was skipped — but
                # the check-in leg was genuinely confirmed in this same
                # call (see local_db.py's auto_confirm_late fall-through),
                # not held. That's real news the live board must reflect;
                # only the checkout half stays invisible until an operator
                # resolves it.
                publish_event({
                    "id": row["local_event_id"],
                    "name": row.get("staff_name") or row["person_code"],
                    "staff_id": row["person_code"],
                    "status": "checked_in",
                    "confidence": row["confidence"],
                    "message": "Checked in — late arrival.",
                    "marked_at": row["marked_at"],
                    "check_out_marked_at": None,
                    "sync_status": "pending",
                    "camera_id": state.camera_id,
                    "camera_name": state.camera_name,
                    "snapshot": self._encode_snapshot(frame, bbox),
                    "notes": row.get("notes"),
                })

    @staticmethod
    def _assign_track(state: _CameraState, bbox, now: float) -> tuple[int, dict[str, Any]]:
        """Match this frame's bbox to an existing track by IoU, or start a
        new one. Only spatial continuity — no identity needed yet, which
        is why this can run before best_match()."""
        x1, y1, x2, y2 = bbox
        best_tid, best_iou = None, 0.0
        for tid, t in state.tracked_faces.items():
            tx1, ty1, tx2, ty2 = t["bbox"]
            ix1, iy1 = max(x1, tx1), max(y1, ty1)
            ix2, iy2 = min(x2, tx2), min(y2, ty2)
            inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
            union = (x2 - x1) * (y2 - y1) + (tx2 - tx1) * (ty2 - ty1) - inter
            iou = inter / union if union > 0 else 0.0
            if iou > TRACK_IOU_MATCH_THRESHOLD and iou > best_iou:
                best_iou, best_tid = iou, tid

        if best_tid is not None:
            state.tracked_faces[best_tid]["bbox"] = bbox
            state.tracked_faces[best_tid]["last_seen"] = now
            return best_tid, state.tracked_faces[best_tid]

        tid = state.next_track_id
        state.next_track_id += 1
        track = {"bbox": bbox, "last_seen": now, "match": None}
        state.tracked_faces[tid] = track
        return tid, track
    
    @staticmethod
    def _encode_snapshot(frame, bbox) -> str | None:
        if bbox is None:
            return None
        x1, y1, x2, y2 = (max(0, int(v)) for v in bbox)
        crop = frame[y1:y2, x1:x2]
        if crop.size == 0:
            return None
        ok, encoded = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if not ok:
            return None
        return base64.b64encode(encoded.tobytes()).decode("ascii")

_manager: CameraStreamManager | None = None
_manager_lock = threading.Lock()


def get_camera_stream_manager() -> CameraStreamManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = CameraStreamManager()
        return _manager