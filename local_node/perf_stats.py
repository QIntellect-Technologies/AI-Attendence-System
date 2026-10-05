"""
local_node/perf_stats.py
──────────────────────────────────────────────────────────────────────────────
Per-stage timing and per-thread CPU attribution for the node process.

WHY THIS EXISTS
---------------
Task Manager reports a single system-wide CPU number. That number cannot
answer the question this codebase actually needs answered: of the CPU this
process burns, how much goes to RTSP decode, how much to JPEG encode, how
much to face detection, and how much to everything else? Without that
split, every optimization is a guess — and the previous round of guesses
(motion gating, viewer-gated encoding, allowed_modules, ORT thread caps)
all landed and the CPU did not move, which is itself evidence that the
real cost is somewhere nobody has measured yet.

Two independent measurements are collected, because either one alone is
misleading:

1. STAGE TIMERS (record/now below). Wall-clock time spent inside each
   named stage, aggregated per camera. Cheap: two perf_counter() reads
   and one dict update per sample. These tell you where wall time goes.

2. PER-THREAD CPU TIME (thread_cpu_breakdown). Kernel+user CPU actually
   charged to each OS thread, read straight from the Windows scheduler
   via GetThreadTimes. This is the ground truth that stage timers cannot
   give you: a stage that blocks on a socket accumulates wall time but
   almost no CPU, while a stage that spins accumulates both. Threads in
   this app are named per role (camera-reader-<id>, camera-processor-<id>,
   camera-detector-<id>), so this attributes CPU directly to a role
   without any instrumentation in the loops themselves.

Comparing the two is the point. If reader threads show high CPU but the
reader stage timers show most of their wall time inside cap.grab(), that
is software H.264 decode, and it is not fixable by tuning anything
downstream of it.

OVERHEAD
--------
Designed to be safe to leave on in production. A sample is two
perf_counter() calls (~50ns each) plus a short lock hold on a dict
update. At the rates this app runs (tens to low hundreds of samples per
second across all cameras) that is far below measurement noise. Set
QINTELLECT_NODE_PERF=0 to compile it out to no-ops anyway.

NOTHING HERE CHANGES BEHAVIOUR. Every function in this module is either
a timer or a reader. No frame is dropped, delayed, resized, or skipped as
a result of anything in this file.
"""
from __future__ import annotations

import ctypes
import logging
import os
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)


def _env_enabled() -> bool:
    return os.getenv("QINTELLECT_NODE_PERF", "1").strip().lower() not in {"0", "false", "no", "off"}


ENABLED = _env_enabled()

# now() is called on every sample in hot loops, so bind the fastest clock
# once at import rather than resolving the attribute on every call.
now = time.perf_counter

_lock = threading.Lock()

# (scope, stage) -> [count, total_seconds, max_seconds]
_samples: dict[tuple[str, str], list[float]] = {}

# (scope, stage) -> [count, total_value, min_value, max_value]
# Separate from _samples because these are unitless measurements, not
# durations, and rendering them as milliseconds would be nonsense.
_observations: dict[tuple[str, str], list[float]] = {}

# Static per-camera facts worth reporting alongside the timings — frame
# size and source FPS are the two numbers that most directly explain a
# decode-bound reader thread, and neither is visible anywhere else.
_camera_info: dict[str, dict[str, Any]] = {}

_window_started = time.monotonic()
_window_started_cpu = time.process_time()


# ── stage timing ────────────────────────────────────────────────────────

def record(scope: str, stage: str, started_at: float) -> None:
    """Record one sample. `started_at` must come from perf_stats.now().

    Takes the start time rather than a duration so the call site is a
    single line and the elapsed calculation can't drift between call
    sites. Deliberately not a context manager: generator-based context
    managers allocate per use, and some of these call sites run at
    camera frame rate on every camera simultaneously.
    """
    if not ENABLED:
        return
    elapsed = now() - started_at
    key = (scope, stage)
    with _lock:
        entry = _samples.get(key)
        if entry is None:
            _samples[key] = [1.0, elapsed, elapsed]
        else:
            entry[0] += 1.0
            entry[1] += elapsed
            if elapsed > entry[2]:
                entry[2] = elapsed


def count(scope: str, stage: str) -> None:
    """Record an occurrence with no duration — for counting events like
    'detection skipped, no motion' whose value is the rate, not the cost."""
    if not ENABLED:
        return
    key = (scope, stage)
    with _lock:
        entry = _samples.get(key)
        if entry is None:
            _samples[key] = [1.0, 0.0, 0.0]
        else:
            entry[0] += 1.0


def observe(scope: str, stage: str, value: float) -> None:
    """Record a raw VALUE rather than a duration — a motion-gate score, a
    queue depth, a dropped-frame count.

    Kept in a separate table from record()/count() because the units are
    not seconds and must not be rendered as milliseconds. Tracks min as
    well as max: for a threshold-driven gate, the minimum is the noise
    floor and the maximum is the strongest signal seen, and you need both
    to choose a threshold that separates them.
    """
    if not ENABLED:
        return
    key = (scope, stage)
    with _lock:
        entry = _observations.get(key)
        if entry is None:
            _observations[key] = [1.0, value, value, value]
        else:
            entry[0] += 1.0
            entry[1] += value
            if value < entry[2]:
                entry[2] = value
            if value > entry[3]:
                entry[3] = value


def set_camera_info(camera_id: str, **fields: Any) -> None:
    """Attach static facts about a camera's live capture (resolution,
    source FPS, whether hardware decode was actually negotiated) so the
    perf report can be read without cross-referencing the config."""
    if not ENABLED:
        return
    with _lock:
        _camera_info.setdefault(camera_id, {}).update(fields)


def clear_camera_info(camera_id: str) -> None:
    with _lock:
        _camera_info.pop(camera_id, None)


# ── per-thread CPU (Windows) ────────────────────────────────────────────

class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", ctypes.c_uint32), ("dwHighDateTime", ctypes.c_uint32)]


def _filetime_seconds(ft: _FILETIME) -> float:
    """FILETIME counts 100-nanosecond intervals."""
    return ((ft.dwHighDateTime << 32) | ft.dwLowDateTime) / 1e7


# GetThreadTimes accepts either of these access rights. QUERY_LIMITED works
# without elevation on Vista+; QUERY_INFORMATION is the older right. Try the
# stronger one first and fall back, so this works on both.
_THREAD_QUERY_INFORMATION = 0x0040
_THREAD_QUERY_LIMITED_INFORMATION = 0x0800

_IS_WINDOWS = os.name == "nt"

# Explicit prototypes are REQUIRED here, not cosmetic. ctypes defaults a
# function's restype to c_int (32-bit signed); on 64-bit Windows a HANDLE
# is 64-bit, so letting OpenThread default would silently truncate the
# handle and every subsequent GetThreadTimes/CloseHandle call would act on
# a garbage value — failing at best, closing an unrelated handle at worst.
_kernel32 = None
if _IS_WINDOWS:
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.OpenThread.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    _kernel32.OpenThread.restype = ctypes.c_void_p
    _kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    _kernel32.CloseHandle.restype = ctypes.c_int
    _kernel32.GetThreadTimes.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(_FILETIME), ctypes.POINTER(_FILETIME),
        ctypes.POINTER(_FILETIME), ctypes.POINTER(_FILETIME),
    ]
    _kernel32.GetThreadTimes.restype = ctypes.c_int

# native_thread_id -> cumulative cpu seconds at last snapshot, for deltas.
_thread_cpu_prev: dict[int, float] = {}
_thread_cpu_prev_at = time.monotonic()


def _thread_cpu_seconds(native_id: int) -> float | None:
    """Kernel+user CPU seconds charged to one OS thread since it started."""
    if _kernel32 is None:
        return None
    handle = _kernel32.OpenThread(_THREAD_QUERY_INFORMATION, 0, native_id)
    if not handle:
        handle = _kernel32.OpenThread(_THREAD_QUERY_LIMITED_INFORMATION, 0, native_id)
    if not handle:
        return None
    try:
        creation, exit_, kernel, user = _FILETIME(), _FILETIME(), _FILETIME(), _FILETIME()
        ok = _kernel32.GetThreadTimes(
            handle,
            ctypes.byref(creation), ctypes.byref(exit_),
            ctypes.byref(kernel), ctypes.byref(user),
        )
        if not ok:
            return None
        return _filetime_seconds(kernel) + _filetime_seconds(user)
    finally:
        _kernel32.CloseHandle(handle)


def thread_cpu_breakdown() -> list[dict[str, Any]]:
    """CPU consumed per named thread since the previous call to this
    function, expressed as a percentage of ONE core.

    Percent-of-one-core, not percent-of-machine, because that's the unit
    that answers the question directly: a reader thread at 95% is a
    saturated thread that has become the pipeline's bottleneck, whatever
    the machine's core count happens to be. Divide by the logical CPU
    count to compare against Task Manager's system-wide figure.

    Values are deltas between successive calls, so the first call after
    startup reports the average since the thread began and every later
    call reports the interval since the previous one. Poll /api/perf twice
    a few seconds apart and read the second result.
    """
    global _thread_cpu_prev_at
    if not _IS_WINDOWS:
        return []

    at = time.monotonic()
    window = max(1e-6, at - _thread_cpu_prev_at)
    rows: list[dict[str, Any]] = []
    seen: dict[int, float] = {}

    for thread in threading.enumerate():
        native_id = getattr(thread, "native_id", None)
        if native_id is None:
            continue
        total = _thread_cpu_seconds(native_id)
        if total is None:
            continue
        seen[native_id] = total
        previous = _thread_cpu_prev.get(native_id)
        delta = total - previous if previous is not None else total
        rows.append({
            "thread": thread.name,
            "native_id": native_id,
            "cpu_seconds_total": round(total, 3),
            "cpu_percent_of_one_core": round(100.0 * delta / window, 1),
        })

    _thread_cpu_prev.clear()
    _thread_cpu_prev.update(seen)
    _thread_cpu_prev_at = at

    rows.sort(key=lambda r: r["cpu_percent_of_one_core"], reverse=True)
    return rows


# ── reporting ───────────────────────────────────────────────────────────

def snapshot(reset: bool = False) -> dict[str, Any]:
    """Aggregate everything collected since the window started.

    `busy_percent_of_one_core` is the number to read first for each stage:
    total time spent in that stage divided by the wall-clock length of the
    window. A stage sitting near 100 is one thread fully occupied by that
    stage alone.
    """
    global _window_started, _window_started_cpu

    at = time.monotonic()
    cpu_at = time.process_time()
    window = max(1e-6, at - _window_started)
    process_cpu_seconds = cpu_at - _window_started_cpu
    logical_cpus = os.cpu_count() or 1

    with _lock:
        items = list(_samples.items())
        observed = list(_observations.items())
        cameras = {cid: dict(info) for cid, info in _camera_info.items()}
        if reset:
            _samples.clear()
            _observations.clear()

    stages: list[dict[str, Any]] = []
    for (scope, stage), (samples, total, worst) in items:
        stages.append({
            "scope": scope,
            "stage": stage,
            "count": int(samples),
            "per_second": round(samples / window, 2),
            "avg_ms": round(1000.0 * total / samples, 3) if samples else 0.0,
            "max_ms": round(1000.0 * worst, 3),
            "total_seconds": round(total, 3),
            "busy_percent_of_one_core": round(100.0 * total / window, 1),
        })
    stages.sort(key=lambda s: s["total_seconds"], reverse=True)

    measurements: list[dict[str, Any]] = []
    for (scope, stage), (samples, total, lowest, highest) in observed:
        measurements.append({
            "scope": scope,
            "stage": stage,
            "count": int(samples),
            "avg": round(total / samples, 4) if samples else 0.0,
            "min": round(lowest, 4),
            "max": round(highest, 4),
        })
    measurements.sort(key=lambda m: (m["stage"], m["scope"]))

    if reset:
        _window_started = at
        _window_started_cpu = cpu_at

    return {
        "enabled": ENABLED,
        "window_seconds": round(window, 2),
        "logical_cpus": logical_cpus,
        "process": {
            # Total CPU this process consumed over the window, as a share
            # of the whole machine. THIS is the number to compare against
            # Task Manager: if the machine reads 90% and this reads 25%,
            # the other 65% is not the node and no amount of optimizing
            # this codebase will move it.
            "cpu_seconds": round(process_cpu_seconds, 3),
            "cpu_percent_of_machine": round(100.0 * process_cpu_seconds / (window * logical_cpus), 1),
            "cpu_percent_of_one_core": round(100.0 * process_cpu_seconds / window, 1),
            "thread_count": threading.active_count(),
        },
        "cameras": cameras,
        "stages": stages,
        "measurements": measurements,
        "threads": thread_cpu_breakdown(),
    }


def log_summary(level: int = logging.INFO) -> None:
    """One-line-per-stage dump to node.log, for when reading /api/perf in
    a browser isn't practical (e.g. an unattended box left running
    overnight). Not called automatically — wire it to a timer only if you
    want it, since periodic logging is what flooded node.log before."""
    data = snapshot()
    logger.log(
        level, "perf: process=%.1f%% of machine over %.0fs (%d logical CPUs)",
        data["process"]["cpu_percent_of_machine"], data["window_seconds"], data["logical_cpus"],
    )
    for stage in data["stages"][:12]:
        logger.log(
            level, "perf:   %-22s %-22s %6.1f%% core  avg=%.1fms  max=%.1fms  %.1f/s",
            stage["scope"], stage["stage"], stage["busy_percent_of_one_core"],
            stage["avg_ms"], stage["max_ms"], stage["per_second"],
        )
    for row in data["threads"][:12]:
        logger.log(
            level, "perf:   thread %-28s %6.1f%% of one core",
            row["thread"], row["cpu_percent_of_one_core"],
        )