import sys
import logging
import logging.handlers
from pathlib import Path
from config import LOG_DIR, LOG_LEVEL, LOG_FORMAT, LOG_MAX_SIZE, LOG_BACKUP_COUNT

# Prevent UnicodeEncodeError on Windows command line
if sys.platform == 'win32':
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(errors='replace')
        except Exception:
            pass
    if hasattr(sys.stderr, 'reconfigure'):
        try:
            sys.stderr.reconfigure(errors='replace')
        except Exception:
            pass

# Create logs directory
LOG_DIR.mkdir(exist_ok=True)

class SafeFormatter(logging.Formatter):
    """A logging formatter that safely replaces unicode characters like tick/cross to avoid Windows encoding errors."""
    def format(self, record):
        try:
            formatted = super().format(record)
            replacements = {
                '✓': '[OK]',
                '✗': '[FAIL]',
                '✔': '[OK]',
                '✘': '[FAIL]'
            }
            for char, replacement in replacements.items():
                formatted = formatted.replace(char, replacement)
            return formatted
        except Exception:
            return super().format(record)

# Configure root logger
root_logger = logging.getLogger()
root_logger.setLevel(getattr(logging, LOG_LEVEL))

# File handler with rotation
file_handler = logging.handlers.RotatingFileHandler(
    LOG_DIR / 'attendance.log',
    maxBytes=LOG_MAX_SIZE,
    backupCount=LOG_BACKUP_COUNT
)
file_handler.setFormatter(SafeFormatter(LOG_FORMAT))
root_logger.addHandler(file_handler)

# Console handler
console_handler = logging.StreamHandler()
console_handler.setFormatter(SafeFormatter(LOG_FORMAT))
root_logger.addHandler(console_handler)


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance for a module."""
    return logging.getLogger(name)
