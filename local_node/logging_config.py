"""
local_node/logging_config.py
──────────────────────────────────────────────────────────────────────────────
Process-wide logging setup for the local node.

Every module in this codebase already does `logger = logging.getLogger(__name__)`
and calls logger.info/.warning correctly (camera_stream_manager.py's shift-gate
check line, node_service.py's cycle errors, etc.) — but nothing ever attached a
handler to the root logger, so:
  - INFO-level calls were silently dropped (root logger defaults to WARNING)
  - WARNING+ calls only reached stderr via logging.lastResort, which is
    invisible once this runs as a windowless Nuitka .exe with no console

Call setup_logging() exactly once, as the very first thing main.py does —
before importing/creating anything else — so every subsequently-created
logger inherits a working root configuration. No other module needs to
change; they already log correctly.

Two things were actually wrong, not one:

1) DUPLICATE HANDLERS. shared_face_engine's import chain transitively
   pulls in backend/shared/logging/logger.py, which calls its own
   configure_logging() unconditionally AT IMPORT TIME (module-level call
   at the bottom of that file). Because main.py imports local_node.ui_server
   (-> recognition_engine -> shared_face_engine -> that module) before
   main() ever calls setup_logging() below, the shared module's handlers
   land on the root logger FIRST. setup_logging() then added its own two
   handlers on top without ever clearing what was already there — so
   every record got formatted and printed twice, through four handlers
   total (two files, two consoles), in two different formats. That's
   exactly what produced the doubled lines in node's console output.
   Fix: clear whatever handlers are already on the root logger before
   attaching ours, so we're always the single source of truth for this
   process's root logging, regardless of import order.

2) LEVEL WAS STILL INFO. log_on_change() (below) only suppresses a line
   that repeats VERBATIM. With several cameras detecting concurrently,
   face count and match similarity genuinely change on nearly every pass
   — that's not repetition, so log_on_change can't and shouldn't hide it.
   Those per-frame diagnostics belong at DEBUG, not INFO, and DEBUG only
   ever needs to be turned on while actively troubleshooting one camera.
   Default root level is now WARNING; set QINTELLECT_NODE_LOG_LEVEL=INFO
   or DEBUG to raise it without a code change.
"""
from __future__ import annotations

import logging
import os
import sys
import threading
from logging.handlers import RotatingFileHandler

from local_node.config_store import LOG_DIR, ensure_app_dirs

_LOG_FILE_NAME = "node.log"
_MAX_BYTES = 5 * 1024 * 1024  # 5 MB per file
_BACKUP_COUNT = 5             # node.log, node.log.1 ... node.log.5 (~30MB total)

_configured = False


def _resolve_level(level: int | None) -> int:
    """Env var wins if set and valid, so a specific install/support session
    can turn on DEBUG (QINTELLECT_NODE_LOG_LEVEL=DEBUG) without a rebuild.
    Falls back to the level argument, then WARNING."""
    raw = os.getenv("QINTELLECT_NODE_LOG_LEVEL", "").strip().upper()
    if raw:
        resolved = logging.getLevelName(raw)
        if isinstance(resolved, int):
            return resolved
    return level if level is not None else logging.WARNING


def setup_logging(level: int | None = None) -> None:
    """Idempotent — safe to call more than once (e.g. from both main.py and
    a future test entrypoint); only the first call attaches handlers."""
    global _configured
    if _configured:
        return

    ensure_app_dirs()
    log_path = LOG_DIR / _LOG_FILE_NAME
    resolved_level = _resolve_level(level)

    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = RotatingFileHandler(
        log_path, maxBytes=_MAX_BYTES, backupCount=_BACKUP_COUNT, encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    file_handler.setLevel(resolved_level)

    # Also mirror to stderr when a console IS attached (e.g. `python main.py`
    # during development) — costs nothing when there's no console to see it.
    console_handler = logging.StreamHandler(sys.stderr)
    console_handler.setFormatter(formatter)
    console_handler.setLevel(resolved_level)

    root = logging.getLogger()

    # We are the single source of truth for this process's root logging.
    # Something earlier in the import chain (backend/shared/logging/logger.py
    # configures itself at import time — see module docstring above) may
    # already have attached handlers before this ever runs. Leaving those in
    # place is what caused every line to print twice. Close and drop them so
    # only our handlers remain, no matter what already ran.
    for handler in root.handlers[:]:
        root.removeHandler(handler)
        handler.close()

    root.setLevel(resolved_level)
    root.addHandler(file_handler)
    root.addHandler(console_handler)

    # Quiet noisy third-party loggers we don't need (e.g. waitress
    # per-request access logs, urllib3 connection pool chatter) without
    # suppressing our own modules, which all log under "local_node.*".
    logging.getLogger("waitress").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    _configured = True
    logging.getLogger(__name__).warning(
        "Logging initialized -> %s (level=%s)", log_path, logging.getLevelName(resolved_level),
    )


# ── loop-spam dedup ─────────────────────────────────────────────────────
# Keyed by an arbitrary caller-chosen string (e.g. "detect_pass:camera-1"),
# so two different cameras hitting the same call site are tracked
# independently — one camera's activity never silences another's.
_state_lock = threading.Lock()
_last_logged_text: dict[str, str] = {}


def log_on_change(
    logger_: logging.Logger,
    key: str,
    msg: str,
    *args: object,
    level: int = logging.INFO,
) -> None:
    """Log a line, then suppress it from repeating verbatim — print again
    only once the formatted text actually differs from what was last
    logged for this `key`. A condition that holds steady (same face count,
    same closest candidate) logs exactly once and stays silent for as long
    as nothing changes; the moment it does change, the new value prints
    right away, with no minimum wait. Compare against `msg % args` so
    callers control exactly how coarse "changed" is — e.g. rounding a
    similarity score before passing it in avoids re-printing on
    insignificant floating-point jitter while still catching real change.
    """
    text = msg % args if args else msg
    with _state_lock:
        if _last_logged_text.get(key) == text:
            return
        _last_logged_text[key] = text
    logger_.log(level, text)