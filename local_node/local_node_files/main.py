from __future__ import annotations

import argparse
import ctypes
import socket
import sys
import time
import webbrowser
from threading import Timer

try:
    from waitress import serve
except ImportError:  # pragma: no cover - exercised only when waitress is unavailable in the build env
    serve = None

from local_node.config_store import load_config
from local_node.logging_config import setup_logging
from local_node.ui_server import create_app

# Identifies "an instance of this app is already running" across launches —
# the Scheduled Task (background, --no-browser) and every later shortcut
# double-click (--open, i.e. no --no-browser) both run this same exe.
# Without this, a second launch tries to bind the same port the first
# instance already holds and crashes instead of just reopening the UI.
_SINGLE_INSTANCE_MUTEX_NAME = "Global\\QIntellectAttendanceNode_SingleInstance"
_ERROR_ALREADY_EXISTS = 183


def _acquire_single_instance_lock() -> bool:
    """Returns True if this is the only running instance (lock acquired).
    Returns False if another instance already holds it. The mutex handle
    is intentionally never released — it's freed automatically by Windows
    when this process exits, which is what makes the check work at all.
    """
    ctypes.windll.kernel32.CreateMutexW(None, False, _SINGLE_INSTANCE_MUTEX_NAME)
    return ctypes.windll.kernel32.GetLastError() != _ERROR_ALREADY_EXISTS


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
    args = parser.parse_args()

    cfg = load_config()
    port = int(args.port or cfg.get("ui_port") or 8765)
    url = f"http://{args.host}:{port}"

    if not _acquire_single_instance_lock():
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
        serve(app, host=args.host, port=port, threads=8)
        return

    app.run(host=args.host, port=port, threaded=True)


if __name__ == "__main__":
    main()