"""Flask request/upload constants."""

__all__ = ["MAX_CONTENT_LENGTH", "ALLOWED_EXTENSIONS", "IMAGE_EXTENSIONS"]

MAX_CONTENT_LENGTH = 500 * 1024 * 1024  # 500 MB
ALLOWED_EXTENSIONS = {"mp4", "avi", "mov", "mkv", "flv", "wmv"}
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "bmp", "webp"}
