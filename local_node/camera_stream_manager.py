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
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import cv2
import numpy as np
from local_node.config_store import read_runtime_status, write_runtime_status
from local_node.logging_config import log_on_change
from local_node import perf_stats
from local_node.recognition_engine import detect_and_extract, FaceEngineUnavailableError
from local_node import local_db
from local_node import shift_gate
from local_node.live_events import publish_event
from local_node.recognition_worker import best_match

logger = logging.getLogger(__name__)

STREAM_FPS_LIMIT = 12
DUPLICATE_LOG_SECONDS = 30
RECONNECT_BACKOFF_SECONDS = 5
TRACK_IOU_MATCH_THRESHOLD = 0.2
TRACK_MAX_UNSEEN_SECONDS = 2.0

FAILURE_THRESHOLD_BEFORE_FALLBACK = 3     # consecutive open/read failures on the active URL
PRIMARY_RETRY_INTERVAL_SECONDS = 120       # how often to re-try the local URL while on fallback

# ── streaming/display tuning ────────────────────────────────────────────
# Frames handed to the detector are always full resolution (accuracy
# matters there); only the copy encoded for the browser is shrunk.
STREAM_DISPLAY_MAX_WIDTH = 1280
STREAM_JPEG_QUALITY = 90

# Interpolation for the browser-preview downscale. INTER_AREA is the
# textbook choice for shrinking an image and was what this used, but it is
# an exact area average and therefore reads every source pixel: measured
# at 5.1ms for 2560x1440 -> 640x360 and 11.6ms for 1440x1620 -> 640x720,
# against 0.6-1.2ms for INTER_LINEAR. For reference, the JPEG encode that
# follows it costs under 2ms — the resize was several times more expensive
# than the thing it was preparing for.
#
# INTER_LINEAR aliases slightly more on fine high-contrast detail. This is
# a preview thumbnail in a browser grid, and NOTHING downstream reads it:
# the detector is handed the untouched full-resolution frame on a separate
# path (see _run_processor), so recognition accuracy and range are
# unaffected by this choice. Set back to cv2.INTER_AREA if the preview
# quality is ever judged more valuable than the milliseconds.
STREAM_DISPLAY_INTERPOLATION = cv2.INTER_LINEAR

# How long a browser tab can wait for the next encoded frame before the
# generator wakes up anyway to re-check whether the camera is still
# running. Keeps a viewer from hanging forever if the processor stalls.
MJPEG_WAIT_TIMEOUT_SECONDS = 1.0

# RTSP/FFMPEG-backend frames arrive over a socket that keeps buffering
# while nothing reads it. cv2's CAP_PROP_BUFFERSIZE is a no-op on the
# FFMPEG backend, so the only real way to stop the stream drifting behind
# live is (a) tell ffmpeg itself not to buffer, and (b) drain any frames
# it queued up before trusting the next one as "now".
RTSP_LOW_LATENCY_ENV_OPTIONS = "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay|max_delay;0"

# How many frames the reader grabs per iteration, retrieving only the last.
#
# On the FFMPEG backend grab() runs the full H.264 decode (av_read_frame +
# avcodec_receive_frame); only the YUV->BGR sws_scale is deferred to
# retrieve(). So this is NOT a free skip — it decodes three frames and
# converts one.
#
# It is nevertheless left at 3, against first instinct, because /perf
# showed all four cameras here consuming only 10-22 of the 25 fps their
# streams offer. The loop is already pulling FEWER frames than arrive, so
# lowering this would make the loop spin faster and decode MORE, while
# also tripling the sws_scale count. Raising it discards more decoded
# frames for nothing. Both directions cost CPU.
#
# The real lever on decode cost is the number of frames the CAMERA sends
# (an NVR setting) and whether NVDEC/QuickSync is doing the decoding —
# not this constant. Env-tunable so it can be tested against /perf on a
# specific install without a rebuild, but do not change the default
# without reading reader.frames_not_consumed first.
try:
    RTSP_BUFFER_FLUSH_GRABS = max(1, int(os.getenv("QINTELLECT_NODE_FLUSH_GRABS", "3")))
except ValueError:
    RTSP_BUFFER_FLUSH_GRABS = 3

# Fallback source frame interval, used only when the camera reports a
# nonsense FPS. Two of the four cameras here report 90000 — that is the
# MPEG 90kHz timebase leaking through CAP_PROP_FPS, not a frame rate — so
# a sanity range is mandatory, not defensive padding.
RTSP_FPS_SANE_RANGE = (1.0, 120.0)
RTSP_DEFAULT_SOURCE_FPS = 25.0

# ── motion gating: don't pay for detect_and_extract() on frames that
# haven't changed ───────────────────────────────────────────────────────
# Face detection is the single most expensive thing this app does per
# frame on EITHER resource: on a CPU-only install it's the whole cost;
# on a GPU install the matrix math itself is cheap, but every call still
# pays CPU-side pre/post-processing (resize to det_size, anchor decode,
# NMS, alignment warp) that InsightFace does in numpy, and that work is
# serialized across every camera by embedding.py's _inference_lock —
# meaning an idle camera calling detect_and_extract as fast as it's
# offered frames isn't just wasting its own resources, it's queueing
# behind (and stealing turns from) every other camera on the box. Most
# camera views are empty most of the time — an entrance overnight, a
# side door used twice a shift — so a near-free grayscale-diff check
# ahead of the real detector lets those frames skip it almost entirely,
# on both GPU and CPU-only boxes, without any accuracy cost when
# something is actually happening.
MOTION_CHECK_SIZE = (64, 64)
MOTION_DIFF_THRESHOLD = 12.0          # cv2.mean() abs diff (0-255 scale) to count as "motion"

# Longest edge the frame is decimated to BEFORE the area-averaged resize
# down to MOTION_CHECK_SIZE. This is the whole fix for what /perf measured
# as the single most expensive line in this file.
#
# The old code went straight from the full frame to 64x64 with INTER_AREA.
# INTER_AREA is an exact area average, so it must READ EVERY SOURCE PIXEL:
# 3.7 million of them for a 2560x1440 camera, 6-8 times a second, per
# camera. Measured at 9.2ms per call on that resolution — which made the
# "near-free" gate cost roughly 1.2 cores across four cameras, about twice
# what the face model itself was using.
#
# Slicing with a stride first costs nothing per skipped pixel (numpy just
# changes the step), and area-averaging the already-small result is
# cheap. Measured on the four cameras actually deployed here, this cuts
# the gate from 9.2ms to 0.42ms — ~22x — while the diff scores it produces
# stay within ~1% of the old ones for every person size tested, from a
# 400x900px figure down to 24x54px. The gate reaches the same verdict; it
# just stops reading 3.7 million pixels to get there.
MOTION_DECIMATE_TARGET_EDGE = 192
# Deliberately shorter than TRACK_MAX_UNSEEN_SECONDS (2.0s) — this is the
# longest a fully idle (zero-motion) camera ever goes without a real
# detection pass, so a person who has stopped moving in frame still gets
# re-detected before their track would otherwise go stale and drop.
IDLE_DETECT_INTERVAL_SECONDS = 1.5


def _frames_missed(state: _CameraState, at: float) -> float:
    """How many frames this camera sent that the reader never asked for,
    since the previous grab finished. Pure measurement — nothing branches
    on it.

    This exists because the obvious "fix" for the flush loop is wrong in a
    way that is invisible without it. Reducing RTSP_BUFFER_FLUSH_GRABS
    looks like it must cut decode work, since fewer frames are grabbed per
    iteration. It does the opposite when the reader is already running
    BEHIND the source: the loop simply iterates more often and pulls the
    frames it was previously missing, decoding more in total. This number
    is what distinguishes the two regimes, so the decision can be made
    from data instead of from intuition.

    Consistently above zero: the reader is behind the camera, and lowering
    the flush count will increase decode load. Consistently zero: the
    reader is keeping up, and the flush count is discarding freshly
    decoded frames that could have been used instead.
    """
    if not state.last_grab_finished_at or state.source_frame_interval <= 0:
        return 0.0
    offered = (at - state.last_grab_finished_at) / state.source_frame_interval
    return max(0.0, round(offered - RTSP_BUFFER_FLUSH_GRABS, 2))


def _motion_thumbnail(frame):
    """Frame -> the small grayscale image the motion diff runs on.

    Two stages on purpose. Stride-slicing first is free per skipped pixel
    (numpy only changes the step, it reads nothing), which is what avoids
    INTER_AREA's mandatory full-frame read. The second stage still uses
    INTER_AREA, so the values that come out are area averages just as
    before — the averaging window is simply built from a decimated sample
    of the frame rather than every pixel in it.

    Converting to grayscale on the DECIMATED image rather than the full
    one matters as much as the resize: cvtColor on 3.7M pixels is itself
    several milliseconds, and nothing downstream needs colour.
    """
    height, width = frame.shape[:2]
    step = max(1, min(height, width) // MOTION_DECIMATE_TARGET_EDGE)
    if step > 1:
        # ascontiguousarray because a strided view is not a valid Mat —
        # cv2 would have to copy it internally anyway, and doing it here
        # keeps the cost visible instead of hidden inside OpenCV.
        frame = np.ascontiguousarray(frame[::step, ::step])
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    return cv2.resize(gray, MOTION_CHECK_SIZE, interpolation=cv2.INTER_AREA)


def _motion_detected(state: _CameraState, frame) -> bool:
    """True if this frame differs enough from the previous one to be worth
    a real detection pass. First frame after (re)connect always returns
    True — nothing to diff against yet, and a fresh connection is exactly
    when someone might already be standing in frame.

    The score is published to /perf (measurement 'detector.motion_score')
    on every call. That is not decoration: MOTION_DIFF_THRESHOLD has never
    been calibrated against real footage from these cameras, and the
    perf data strongly suggests it is set far too high to ever fire (see
    the note on the threshold constant). Recording the actual distribution
    — noise floor as the minimum, real activity as the maximum — is what
    makes choosing a correct threshold a measurement rather than another
    guess. Cost is one float and a dict update per call.
    """
    gray = _motion_thumbnail(frame)
    prev = state.motion_prev_gray
    state.motion_prev_gray = gray
    if prev is None:
        return True
    score = cv2.mean(cv2.absdiff(gray, prev))[0]
    perf_stats.observe(state.camera_id, "detector.motion_score", score)
    return score >= MOTION_DIFF_THRESHOLD

# Hardware-decode candidates, most capable first.
#
# OpenCV's FFMPEG backend rejects VIDEO_ACCELERATION_ANY when it's paired
# with an explicit CAP_PROP_HW_DEVICE index — that is the documented
# "Invalid usage of CAP_PROP_HW_DEVICE with 'ANY' H/W acceleration.
# Bailout" error. ANY means "let ffmpeg probe every backend on its own";
# pinning a device index is a contradiction, not a stricter version of
# the same request. This was the actual bug: every camera hit that
# invalid combination, ffmpeg refused to open with any acceleration
# request at all, and OpenCV silently re-opened in pure software decode
# — which /perf then correctly showed as the dominant CPU cost
# (camera-reader-* + camera-processor-* dwarfing detection and matching).
#
# D3D11VA is the correct, device-pinnable backend on Windows: opencv-
# python's bundled ffmpeg has supported it since OpenCV 4.5.4, and it
# transparently rides whatever GPU driver exposes a D3D11 video-decode
# device — NVDEC on an NVIDIA GPU, Quick Sync on an Intel iGPU. This
# module already commits to Windows-only (CAP_DSHOW is the webcam
# backend below, and DSHOW does not exist on other platforms), so D3D11
# is listed unconditionally rather than behind a platform check.
#
# Each entry is (VIDEO_ACCELERATION_* attribute name, device index or
# None). None means "omit CAP_PROP_HW_DEVICE entirely" — required for
# ANY, kept here only as a last-resort hardware attempt before the plain
# software open in _open_capture.
_HW_ACCEL_CANDIDATES: tuple[tuple[str, int | None], ...] = (
    ("VIDEO_ACCELERATION_D3D11", 0),
    ("VIDEO_ACCELERATION_ANY", None),
)


def _open_capture_with_hw_accel(url: str, backend: int) -> cv2.VideoCapture | None:
    """Try each candidate in `_HW_ACCEL_CANDIDATES` in order, returning the
    first capture that both opens AND reports the acceleration actually
    engaged. Returns None if every candidate fails or silently falls back
    to software — the caller (`_open_capture`) then does a plain,
    unaccelerated open, which always succeeds if the stream is reachable.

    isOpened() alone is not sufficient to confirm success: OpenCV can open
    the stream and decode in software while still returning an opened
    capture (see `_report_capture_properties`'s docstring — this is the
    same failure mode that diagnostic exists to catch). Reading back
    CAP_PROP_HW_ACCELERATION after open is what actually confirms the
    request was honored, so a candidate that silently downgraded is
    rejected here instead of being mistaken for a working GPU path.
    """
    if not hasattr(cv2, "CAP_PROP_HW_ACCELERATION"):
        return None

    for accel_attr, device_index in _HW_ACCEL_CANDIDATES:
        accel_value = getattr(cv2, accel_attr, None)
        if accel_value is None:
            continue  # this OpenCV build doesn't expose this backend

        params = [cv2.CAP_PROP_HW_ACCELERATION, accel_value]
        if device_index is not None:
            params += [cv2.CAP_PROP_HW_DEVICE, device_index]

        try:
            cap = cv2.VideoCapture(url, backend, params)
        except Exception:
            continue

        if cap is None:
            continue
        if not cap.isOpened():
            cap.release()
            continue

        try:
            negotiated = cap.get(cv2.CAP_PROP_HW_ACCELERATION)
        except Exception:
            negotiated = None

        if negotiated and int(negotiated) != 0:
            return cap  # confirmed: hardware decode actually engaged

        cap.release()  # opened, but silently fell back to software — try the next candidate

    return None


def _report_capture_properties(state: _CameraState, cap) -> None:
    """Record what this capture ACTUALLY negotiated, as opposed to what
    was requested. Three facts, none of which are visible anywhere else:

      * frame width/height — decode cost scales with pixel count, so a
        single 4MP camera can cost more than four 720p ones. The config
        does not say what resolution the NVR really serves.
      * source FPS — the reader decodes every frame the camera sends,
        regardless of STREAM_FPS_LIMIT, which only throttles the display
        and detection side. A 30fps source is 2.5x the decode work of a
        12fps one for identical output.
      * hardware acceleration — _open_capture asks for
        VIDEO_ACCELERATION_ANY, but OpenCV silently falls back to software
        decode and still returns an opened capture, so the request
        succeeding tells you nothing. This reads back what was actually
        selected. 0 (VIDEO_ACCELERATION_NONE) means the CPU is doing every
        frame of H.264 decode for this camera.

    Wrapped in try/except throughout: property support varies by backend
    and OpenCV build, and a diagnostic must never be able to stop a camera
    from starting.
    """
    def _get(prop_name: str):
        prop = getattr(cv2, prop_name, None)
        if prop is None:
            return None
        try:
            value = cap.get(prop)
        except Exception:
            return None
        return value if value else None

    width = _get("CAP_PROP_FRAME_WIDTH")
    height = _get("CAP_PROP_FRAME_HEIGHT")
    fps = _get("CAP_PROP_FPS")
    hw = _get("CAP_PROP_HW_ACCELERATION")

    megapixels = round((width * height) / 1e6, 2) if width and height else None

    # Two of the four cameras on this deployment report 90000 fps. That is
    # the MPEG 90kHz timebase surfacing through CAP_PROP_FPS, not a frame
    # rate, and feeding it into the catch-up arithmetic would compute a
    # frame interval of 11 microseconds and make the reader believe it is
    # permanently thousands of frames behind. Range-check before trusting.
    low, high = RTSP_FPS_SANE_RANGE
    if fps is not None and low <= fps <= high:
        sane_fps = float(fps)
        fps_source = "reported"
    else:
        sane_fps = RTSP_DEFAULT_SOURCE_FPS
        fps_source = f"assumed (camera reported {fps!r})" if fps else "assumed (not reported)"
    state.source_frame_interval = 1.0 / sane_fps
    state.last_grab_finished_at = 0.0

    # cv2.VideoAccelerationType: NONE=0, ANY=1, D3D11=2, VAAPI=3, MFX=4.
    # Resolved from the cv2 module where possible rather than hardcoded,
    # so a future OpenCV that adds or renumbers a backend reports the
    # right name instead of a confidently wrong one.
    hw_names = {}
    for attr in ("VIDEO_ACCELERATION_NONE", "VIDEO_ACCELERATION_ANY",
                 "VIDEO_ACCELERATION_D3D11", "VIDEO_ACCELERATION_VAAPI",
                 "VIDEO_ACCELERATION_MFX"):
        value = getattr(cv2, attr, None)
        if value is not None:
            hw_names[int(value)] = attr.replace("VIDEO_ACCELERATION_", "").lower()
    hw_names.setdefault(0, "none")

    if hw is None:
        # _get() collapses a 0 return to None, and 0 IS the meaningful
        # "software decode" value here — but it is indistinguishable from
        # "this build cannot report the property". Either way the safe
        # reading is the pessimistic one: assume the CPU is decoding until
        # proven otherwise by the GPU's Video Decode graph.
        hw_label = "none/unreported (software)"
    else:
        resolved = hw_names.get(int(hw), f"code {int(hw)}")
        hw_label = f"{resolved} (software)" if int(hw) == 0 else resolved

    perf_stats.set_camera_info(
        state.camera_id,
        name=state.camera_name,
        source="webcam" if state.camera_type == "webcam" else ("fallback/public" if state.using_fallback else "primary/local"),
        width=int(width) if width else None,
        height=int(height) if height else None,
        megapixels=megapixels,
        source_fps=f"{sane_fps:g} ({fps_source})",
        hw_acceleration=hw_label,
    )

    # WARNING level so this lands in node.log at the default log level —
    # it prints once per (re)connect, not per frame, and it is the single
    # most useful line for diagnosing a decode-bound node.
    logger.warning(
        "Camera %s (%s): capture opened %sx%s @ %g fps [%s], hw_decode=%s",
        state.camera_id, state.camera_name,
        int(width) if width else "?", int(height) if height else "?",
        sane_fps, fps_source, hw_label,
    )


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
    raw_lock: threading.Lock = field(default_factory=threading.Lock)

    # latest_jpeg has two very different readers/writers: the processor
    # thread (one writer, ~12x/sec) and every browser tab watching this
    # camera (N readers, each blocking until a new frame lands). Giving
    # this its own lock — instead of sharing state.raw_lock the way a
    # single "lock" field used to — means a viewer's HTTP thread never
    # contends with the RTSP reader thread for the same lock. The
    # Condition lets viewers block-until-new-frame instead of polling on
    # a fixed timer, so nobody sleeps past a frame that's already ready
    # and nobody re-sends a frame that hasn't changed.
    latest_jpeg: bytes | None = None
    jpeg_version: int = 0
    jpeg_lock: threading.Lock = field(default_factory=threading.Lock)
    jpeg_ready: threading.Condition = field(init=False)
    viewer_count: int = 0

    last_seen_by_person: dict[str, float] = field(default_factory=dict)
    tracked_faces: dict[int, dict[str, Any]] = field(default_factory=dict)
    next_track_id: int = 0
    stop_event: threading.Event = field(default_factory=threading.Event)
    reader_thread: threading.Thread | None = None
    processor_thread: threading.Thread | None = None
    detector_thread: threading.Thread | None = None
    pending_detect_frame: Any = None
    detect_lock: threading.Lock = field(default_factory=threading.Lock)

    # Motion gate state (see _motion_detected / _run_detector below) —
    # per-camera so one busy entrance and one quiet back door don't share
    # a "last seen motion" clock.
    motion_prev_gray: Any = None
    last_full_detect_at: float = 0.0

    # Live-catch-up state (see _run_reader). source_frame_interval is what
    # one frame from THIS camera is worth in seconds, used to work out how
    # many frames piled up while the reader was busy elsewhere.
    source_frame_interval: float = 1.0 / RTSP_DEFAULT_SOURCE_FPS
    last_grab_finished_at: float = 0.0

    def __post_init__(self) -> None:
        self.jpeg_ready = threading.Condition(self.jpeg_lock)


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
            perf_stats.clear_camera_info(camera_id)

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
        """Generator yielding a multipart/x-mixed-replace stream for one camera.

        Registers itself as a viewer on the camera's current _CameraState
        (see _register_viewer/_release_viewer below) — this is what lets the
        processor thread skip encoding entirely while no browser tab is open
        on this camera. Blocks on that state's jpeg_ready condition instead
        of polling on a timer, so a frame is sent the moment it's encoded
        rather than up to one poll-interval late, and the same frame is
        never re-sent twice.

        Re-fetches the camera's state every iteration (matching the previous
        behaviour) rather than capturing it once, so a viewer already
        watching this camera keeps streaming transparently across a
        sync_cameras()-triggered restart (e.g. an updated RTSP URL swaps in
        a brand new _CameraState under the same camera_id) instead of the
        connection dying and forcing the browser to reconnect.
        """
        registered_state: _CameraState | None = None
        last_sent_version = -1
        try:
            while True:
                with self._lock:
                    state = self._cameras.get(camera_id)

                if state is not registered_state:
                    self._release_viewer(registered_state)
                    registered_state = state
                    self._register_viewer(registered_state)
                    last_sent_version = -1  # new state's frames start unsent

                if state is None:
                    break

                with state.jpeg_ready:
                    state.jpeg_ready.wait_for(
                        lambda: state.jpeg_version != last_sent_version,
                        timeout=MJPEG_WAIT_TIMEOUT_SECONDS,
                    )
                    frame = state.latest_jpeg
                    last_sent_version = state.jpeg_version

                if frame is not None:
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
        finally:
            self._release_viewer(registered_state)

    @staticmethod
    def _register_viewer(state: _CameraState | None) -> None:
        if state is None:
            return
        with state.jpeg_ready:
            state.viewer_count += 1

    @staticmethod
    def _release_viewer(state: _CameraState | None) -> None:
        if state is None:
            return
        with state.jpeg_ready:
            state.viewer_count = max(0, state.viewer_count - 1)

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
            # Must be set before VideoCapture opens the stream — ffmpeg reads
            # these at open time, not per-frame. This is what actually stops
            # ffmpeg's own socket buffer from accumulating a backlog;
            # CAP_PROP_BUFFERSIZE below does nothing on this backend.
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = RTSP_LOW_LATENCY_ENV_OPTIONS
            backend = cv2.CAP_FFMPEG if hasattr(cv2, "CAP_FFMPEG") else 0

            # Software H.264/H.265 decode of every RTSP stream is the
            # single biggest CPU cost left on a multi-camera box — bigger
            # than face detection, which is already on CUDA (see
            # model_loader.py). It runs continuously at the camera's
            # native frame rate in THIS thread's grab()/retrieve() loop,
            # completely independent of STREAM_FPS_LIMIT or whether
            # anyone's watching — decode has to happen before any frame
            # can be dropped. Meanwhile Task Manager's GPU "Video Decode"
            # engine sits at 0%: real hardware decode capacity going
            # unused on the exact box paying for software decode on the
            # CPU instead. Windows' opencv-python wheels bundle an ffmpeg
            # build with D3D11VA hw-accel support (since OpenCV 4.5.4),
            # which transparently rides whatever GPU driver exposes a
            # D3D11 video decode device — NVDEC on the RTX 2060 here, or
            # Quick Sync on the Intel iGPU for a camera opened against
            # that adapter. Passed as open-time params (not a later
            # .set() call) because the FFmpeg backend wires hw-accel into
            # the demuxer/decoder at construction, same as
            # CAP_PROP_BUFFERSIZE already has to be set before open
            # elsewhere in this function.
            #
            # Not guaranteed to engage for every stream (codec/driver
            # combination dependent) — _open_capture_with_hw_accel tries
            # each candidate in turn and confirms via readback (not just
            # isOpened()) that acceleration actually engaged, falling
            # through to a plain software open if none of them do.
            cap = _open_capture_with_hw_accel(url, backend)
            if cap is None:
                cap = cv2.VideoCapture(url, backend)
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

        _report_capture_properties(state, cap)
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

                if state.camera_type == "webcam":
                    read_started = perf_stats.now()
                    ok, frame = cap.read()
                    perf_stats.record(state.camera_id, "reader.read", read_started)
                else:
                    # Drain to the newest available frame, then convert it.
                    #
                    # The original comment here said grab() "decodes nothing
                    # (it's cheap)". That is true of the V4L2/DShow backends
                    # but NOT of FFMPEG, where grabFrame() runs av_read_frame
                    # + avcodec_receive_frame — the full H.264 decode — and
                    # retrieveFrame() only does the YUV->BGR sws_scale. So
                    # this loop decodes RTSP_BUFFER_FLUSH_GRABS frames and
                    # colour-converts one.
                    #
                    # That reads like obvious waste, and the obvious fix is
                    # to grab fewer. /perf says otherwise: every camera here
                    # is consuming FEWER frames than its stream offers
                    # (reader.frames_not_consumed > 0), so grabbing fewer per
                    # iteration just makes this loop spin faster and decode
                    # more in total, while tripling the sws_scale count.
                    # Left as-is deliberately. See RTSP_BUFFER_FLUSH_GRABS.
                    grab_started = perf_stats.now()
                    ok = True
                    for _ in range(RTSP_BUFFER_FLUSH_GRABS):
                        if not cap.grab():
                            ok = False
                            break
                    state.last_grab_finished_at = perf_stats.now()
                    perf_stats.record(state.camera_id, "reader.grab", grab_started)

                    # Frames this camera's stream offered but this loop never
                    # asked for. Derived from elapsed time against the source
                    # frame interval, so it shows whether the reader is
                    # keeping up with the camera or silently running behind
                    # it — the number that decides whether RTSP_BUFFER_FLUSH_GRABS
                    # is helping or hurting. See the constant's comment.
                    missed = _frames_missed(state, grab_started)
                    if missed > 0:
                        perf_stats.observe(state.camera_id, "reader.frames_not_consumed", missed)

                    if ok:
                        retrieve_started = perf_stats.now()
                        ok, frame = cap.retrieve()
                        perf_stats.record(state.camera_id, "reader.retrieve", retrieve_started)
                    else:
                        frame = None

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

                with state.raw_lock:
                    state.raw_frame = frame
        finally:
            if cap is not None:
                cap.release()

    # ── processor thread: detection + encode, off the freshest frame ──
    
    def _run_processor(self, state: _CameraState, branch_id: str) -> None:
        frame_interval = 1.0 / STREAM_FPS_LIMIT
        while not state.stop_event.is_set():
            loop_started = time.time()
            copy_started = perf_stats.now()
            with state.raw_lock:
                frame = state.raw_frame.copy() if state.raw_frame is not None else None
            if frame is not None:
                perf_stats.record(state.camera_id, "processor.frame_copy", copy_started)

            if frame is None:
                state.stop_event.wait(frame_interval)
                continue

            # Offer the freshest frame to the detector on EVERY tick, not
            # just every Nth one. The detector already self-throttles —
            # it holds at most one pending frame and overwrites it if
            # still busy on the previous pass — so gating the handoff
            # here too only adds a fixed extra delay on top of real
            # detection time, for no benefit. This lets a fast-moving or
            # running person be caught by whichever frame the detector is
            # actually free to pick up next, instead of waiting on an
            # arbitrary Nth tick that may land after they've already left.
            # Always runs, regardless of viewers — attendance marking does
            # not depend on anyone watching the live grid.
            with state.detect_lock:
                state.pending_detect_frame = frame

            # Encoding for display is the one part of this loop that exists
            # purely to serve browser tabs — skip it entirely when nobody's
            # looking at this camera. Cheap check, real CPU savings on a
            # multi-camera grid where most tiles aren't visible at once.
            with state.jpeg_lock:
                has_viewers = state.viewer_count > 0
            if has_viewers:
                encode_started = perf_stats.now()
                self._encode_and_publish(state, frame)
                perf_stats.record(state.camera_id, "processor.encode", encode_started)
            else:
                perf_stats.count(state.camera_id, "processor.encode_skipped_no_viewer")

            elapsed = time.time() - loop_started
            state.stop_event.wait(max(0.0, frame_interval - elapsed))

    @staticmethod
    def _encode_and_publish(state: _CameraState, frame) -> None:
        """Downscale to display size and encode, then wake any browser tabs
        blocked waiting for the next frame. The detector always gets the
        full-resolution frame (handed off separately, above) — only this
        display copy is shrunk, so recognition range/accuracy is unaffected."""
        display_frame = frame
        h, w = display_frame.shape[:2]
        if w > STREAM_DISPLAY_MAX_WIDTH:
            scale = STREAM_DISPLAY_MAX_WIDTH / w
            display_frame = cv2.resize(
                display_frame, (STREAM_DISPLAY_MAX_WIDTH, max(1, int(h * scale))),
                interpolation=STREAM_DISPLAY_INTERPOLATION,
            )

        ok, encoded = cv2.imencode(".jpg", display_frame, [int(cv2.IMWRITE_JPEG_QUALITY), STREAM_JPEG_QUALITY])
        if not ok:
            return

        with state.jpeg_ready:
            state.latest_jpeg = encoded.tobytes()
            state.jpeg_version += 1
            state.jpeg_ready.notify_all()

    # ── detector thread: the CPU-heavy work, off the display path ───────

   
    def _run_detector(self, state: _CameraState, branch_id: str) -> None:
        while not state.stop_event.is_set():
            with state.detect_lock:
                frame = state.pending_detect_frame
                state.pending_detect_frame = None
            if frame is None:
                state.stop_event.wait(0.05)
                continue

            now = time.time()
            motion_started = perf_stats.now()
            motion = _motion_detected(state, frame)
            perf_stats.record(state.camera_id, "detector.motion_gate", motion_started)
            idle_recheck_due = (now - state.last_full_detect_at) >= IDLE_DETECT_INTERVAL_SECONDS
            if not motion and not idle_recheck_due:
                # Nothing changed in this frame and we already ran a real
                # pass recently enough to catch anyone standing still —
                # skip the model entirely. Cheaper than a detection pass
                # by roughly two orders of magnitude, and frees this
                # camera's turn on _inference_lock for whichever OTHER
                # camera actually has something happening.
                #
                # Counted so the perf report shows the gate's real hit
                # rate. A gate that almost never fires on a busy camera is
                # not saving anything, and one that fires constantly on a
                # camera that should be seeing people is a sign the
                # threshold is too high.
                perf_stats.count(state.camera_id, "detector.skipped_no_motion")
                continue
            state.last_full_detect_at = now

            try:
                pass_started = perf_stats.now()
                self._detect_and_record(state, frame, branch_id)
                perf_stats.record(state.camera_id, "detector.full_pass", pass_started)
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
            # Wall time here includes waiting for embedding.py's
            # _inference_lock, which every camera shares. Compare against
            # detector.full_pass across cameras: if this dominates and
            # scales with camera count rather than with faces seen, the
            # cost is lock contention, not the model itself.
            model_started = perf_stats.now()
            faces = detect_and_extract(frame)
            perf_stats.record(state.camera_id, "detect.model", model_started)
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

        # This used to also call local_db.get_all_embeddings(branch_id) just
        # to report a count in the log line below — a full SQLite query of
        # every enrolled embedding, on every detection pass, for every
        # camera, purely for a diagnostic number nothing else used. Deleted:
        # recognition_worker's own cache (_cached_candidates) already tracks
        # this count and logs it once when the cache is (re)built, not on
        # every frame.
        #
        # log_on_change instead of a plain logger.info: this line used to
        # print every detection pass (several times a second per camera),
        # repeating the same face count over and over — that repetition,
        # not the line itself, is what flooded node.log. log_on_change
        # collapses exact repeats, but with several cameras actively
        # detecting, the face count genuinely changes almost every pass
        # (0 -> 1 -> 2 -> 0 as people move) — that's real change, not
        # repetition, so log_on_change can't and shouldn't hide it. This
        # is a per-frame diagnostic, not an operational event, so it goes
        # to DEBUG (default root level is WARNING; set
        # QINTELLECT_NODE_LOG_LEVEL=DEBUG to see it while troubleshooting
        # one camera — see logging_config.py).
        log_on_change(
            logger, f"detect_pass:{state.camera_id}",
            "Camera %s: detection pass -> %d face(s) found",
            state.camera_id, len(faces),
            level=logging.DEBUG,
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
                # This message has no varying content (just the camera id),
                # so log_on_change logs it once per camera and then stays
                # silent for good — exactly "show it once, then stop"
                # rather than "once every embedding" cycle after cycle.
                log_on_change(
                    logger, f"no_embedding:{state.camera_id}",
                    "Camera %s: face detected but no embedding extracted (bad crop/landmarks?)",
                    state.camera_id,
                )
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
                match_started = perf_stats.now()
                match = best_match(embedding)
                perf_stats.record(state.camera_id, "detect.best_match", match_started)
                track["match"] = match if match is not None else False   # False = "tried, no match"
            else:
                perf_stats.count(state.camera_id, "detect.match_served_from_track")
            match = track["match"] or None
            if not match:
                continue

            person_key = f'{match["people_type"]}:{match["person_code"]}'
            if now - state.last_seen_by_person.get(person_key, 0) < DUPLICATE_LOG_SECONDS:
                continue
            state.last_seen_by_person[person_key] = now

            record_started = perf_stats.now()
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
            perf_stats.record(state.camera_id, "detect.db_write", record_started)
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