"""Logging configuration constants. Named log_settings (not logging) to avoid
ever shadowing the stdlib logging module for anyone reading this package."""

__all__ = ["LOG_LEVEL", "LOG_FORMAT", "LOG_MAX_SIZE", "LOG_BACKUP_COUNT"]

LOG_LEVEL = "INFO"
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
LOG_MAX_SIZE = 10 * 1024 * 1024  # 10 MB
LOG_BACKUP_COUNT = 5
