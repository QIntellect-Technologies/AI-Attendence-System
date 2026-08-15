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
"""
from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler

from local_node.config_store import LOG_DIR, ensure_app_dirs

_LOG_FILE_NAME = "node.log"
_MAX_BYTES = 5 * 1024 * 1024  # 5 MB per file
_BACKUP_COUNT = 5             # node.log, node.log.1 ... node.log.5 (~30MB total)

_configured = False


def setup_logging(level: int = logging.INFO) -> None:
    """Idempotent — safe to call more than once (e.g. from both main.py and
    a future test entrypoint); only the first call attaches handlers."""
    global _configured
    if _configured:
        return

    ensure_app_dirs()
    log_path = LOG_DIR / _LOG_FILE_NAME

    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = RotatingFileHandler(
        log_path, maxBytes=_MAX_BYTES, backupCount=_BACKUP_COUNT, encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    file_handler.setLevel(level)

    # Also mirror to stderr when a console IS attached (e.g. `python main.py`
    # during development) — costs nothing when there's no console to see it.
    console_handler = logging.StreamHandler(sys.stderr)
    console_handler.setFormatter(formatter)
    console_handler.setLevel(level)

    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(file_handler)
    root.addHandler(console_handler)

    # Quiet noisy third-party loggers we don't need at INFO (e.g. waitress
    # per-request access logs, urllib3 connection pool chatter) without
    # suppressing our own modules, which all log under "local_node.*".
    logging.getLogger("waitress").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    _configured = True
    logging.getLogger(__name__).info("Logging initialized -> %s", log_path)
