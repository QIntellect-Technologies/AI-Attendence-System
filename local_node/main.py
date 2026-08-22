from __future__ import annotations

import argparse
import ctypes
import os
import socket
import sys
import time
import webbrowser
from threading import Timer

import cv2

try:
    from waitress import serve
except ImportError:  # pragma: no cover - exercised only when waitress is unavailable in the build env
    serve = None

from local_node.config_store import load_config
from local_node.logging_config import setup_logging
from local_node.ui_server import create_app

# OpenCV parallelizes individual calls (resize, cvtColor, imencode, ...)
# across its own internal thread pool, sized to the machine's full core
# count by default. That's the right default for a single-threaded script
# calling cv2 once at a time — it is actively harmful here, where 5+
# camera reader/processor/detector threads are ALREADY the source of
# concurrency and are each calling cv2 functions independently. Left at
# its default, every one of those calls spawns its own wave of internal
# worker threads on top of the app's own threads, and all of them then
# fight over the same physical cores — this is a large, easy-to-miss
# contributor to a multi-camera box pinning near 100% CPU well before the
# GPU (which does the actual face detection/recognition math) is even
# close to saturated. Setting this to 1 tells OpenCV "don't parallelize
# yourself, the caller already handles concurrency" — each cv2 call now
# just runs on the thread that called it, which is exactly what we want
# when that thread is one of several already doing useful work in
# parallel. Must run before any camera/detector threads start.
cv2.setNumThreads(1)

# Identifies "an instance of this app is already running" across launches —
# the Scheduled Task (background, --no-browser) and every later shortcut
# double-click (--open, i.e. no --no-browser) both run this same exe.
# Without this, a second launch tries to bind the same port the first
# instance already holds and crashes instead of just reopening the UI.
_SINGLE_INSTANCE_MUTEX_NAME = "Global\\QIntellectAttendanceNode_SingleInstance"
_ERROR_ALREADY_EXISTS = 183

# Waitress hands one worker thread to every in-flight request for its whole
# lifetime — including each open MJPEG camera stream, which stays "in
# flight" for as long as a browser tab has that camera open (minutes to
# hours). With the previous default of 8, a branch with 5-6 enabled cameras
# in Grid view left only 2-3 threads for every other request on the node —
# /api/status, /api/live-events, activation, config changes — which then
# queued behind the streams instead of answering promptly. 32 comfortably
# covers a full camera grid (cameras are realistically capped well below
# that per branch) plus normal API traffic; QINTELLECT_NODE_WAITRESS_THREADS
# lets a specific install raise it further without a code change if a branch
# ever runs more cameras than that.
DEFAULT_WAITRESS_THREADS = 32


def _waitress_thread_count() -> int:
    raw = os.getenv("QINTELLECT_NODE_WAITRESS_THREADS", "").strip()
    if not raw:
        return DEFAULT_WAITRESS_THREADS
    try:
        threads = int(raw)
    except ValueError:
        return DEFAULT_WAITRESS_THREADS
    return threads if threads > 0 else DEFAULT_WAITRESS_THREADS


def _acquire_single_instance_lock() -> bool:
    """Returns True if this is the only running instance (lock acquired).
    Returns False if another instance already holds it. The mutex handle
    is intentionally never released — it's freed automatically by Windows
    when this process exits, which is what makes the check work at all.
    """
    ctypes.windll.kernel32.CreateMutexW(None, False, _SINGLE_INSTANCE_MUTEX_NAME)
    return ctypes.windll.kernel32.GetLastError() != _ERROR_ALREADY_EXISTS


def _try_acquire_single_instance_lock(retry_seconds: float = 0.0) -> bool:
    """Same as _acquire_single_instance_lock(), but retries for a bit.
    Used for --relaunch: the UI's Restart Node button hard-kills the old
    instance and starts this one right after, so the old process may
    still be a few hundred ms from actually exiting (and releasing the
    named mutex) when we get here."""
    if _acquire_single_instance_lock():
        return True
    deadline = time.time() + retry_seconds
    while time.time() < deadline:
        time.sleep(0.2)
        if _acquire_single_instance_lock():
            return True
    return False


def _wait_for_port(host: str, port: int, timeout: float = 15.0) -> bool:
    """Polls until something is listening on host:port, or times out.
    Used when another instance is already running, so we know when its
    server is actually ready to answer the browser instead of guessing.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex((host, port)) == 0:
                return True
        time.sleep(0.3)
    return False


def main() -> None:
    setup_logging()

    parser = argparse.ArgumentParser(description="QIntellect Attendance Node")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument(
        "--relaunch",
        action="store_true",
        help="Internal: set on the replacement instance launched by the UI's "
             "Restart Node button, so it retries claiming the single-instance "
             "lock instead of giving up the moment it still sees the "
             "(still-dying) old instance holding it.",
    )
    args = parser.parse_args()

    cfg = load_config()
    port = int(args.port or cfg.get("ui_port") or 8765)
    url = f"http://{args.host}:{port}"

    if not _try_acquire_single_instance_lock(retry_seconds=10.0 if args.relaunch else 0.0):
        # Another instance already owns the engine (started by the Scheduled
        # Task at logon, or an earlier shortcut click). Don't start a second
        # engine or try to rebind the port — just surface the existing UI
        # if this launch wanted one, then exit.
        if not args.no_browser and _wait_for_port(args.host, port):
            webbrowser.open(url)
        sys.exit(0)

    if not args.no_browser:
        Timer(1.0, lambda: webbrowser.open(url)).start()

    app = create_app()
    if serve is not None:
        serve(app, host=args.host, port=port, threads=_waitress_thread_count())
        return

    app.run(host=args.host, port=port, threaded=True)


if __name__ == "__main__":
    main()