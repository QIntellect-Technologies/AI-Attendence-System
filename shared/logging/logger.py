"""
shared/logging/logger.py

Canonical logging setup for the attendance system.

This completes a migration that was left half-done: the constants
(LOG_LEVEL, LOG_FORMAT, LOG_MAX_SIZE, LOG_BACKUP_COUNT) already live in
shared/config/logging.py, and the root logger_config.py already expects to
import get_logger/configure_logging from here — this module just needed
to actually exist.

LOG_DIR stays in the top-level config.py (it's project-root-relative, a
different concern from the logging *policy* constants that shared/config
owns).

configure_logging() is idempotent: safe to call more than once (e.g. from
multiple entry points, or every time get_logger() is called) without
installing duplicate handlers — the original module-level version had no
such guard.
"""
from __future__ import annotations

import logging
import logging.handlers

from config import LOG_DIR
from shared.config.logging import LOG_BACKUP_COUNT, LOG_FORMAT, LOG_LEVEL, LOG_MAX_SIZE
import sys
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
_configured = False


def configure_logging() -> None:
    """Configure the root logger with rotating-file + console handlers.
    Safe to call multiple times, and safe even if something else (a
    library, or an earlier basicConfig() call) already attached handlers
    to the root logger before this ran — those are removed rather than
    left to coexist, since a coexisting handler bound to a non-UTF-8
    stream will independently fail on every non-ASCII log record."""
    global _configured
    if _configured:
        return

    LOG_DIR.mkdir(exist_ok=True)

    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, LOG_LEVEL))

    # Remove any handlers installed before we got control (e.g. an
    # implicit logging.basicConfig() from a third-party import, or a
    # stray StreamHandler elsewhere). We are the single source of truth
    # for handler configuration — coexisting handlers is exactly what
    # produces "logged twice, one succeeds one throws" bugs.
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)
        handler.close()

    formatter = logging.Formatter(LOG_FORMAT)

    file_handler = logging.handlers.RotatingFileHandler(
        LOG_DIR / "attendance.log",
        maxBytes=LOG_MAX_SIZE,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",  # explicit — do not rely on locale.getpreferredencoding()
    )
    file_handler.setFormatter(formatter)
    root_logger.addHandler(file_handler)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    root_logger.addHandler(console_handler)

    _configured = True

def get_logger(name: str) -> logging.Logger:
    """Get a logger instance for a module, ensuring root logging is configured first."""
    configure_logging()
    return logging.getLogger(name)


# Configure immediately on import, matching the historical behavior of the
# original monolithic logger_config.py: logging was always ready as soon as
# anything imported it, with no separate setup call required.
configure_logging()