"""Flask request/upload constants."""

__all__ = ["MAX_CONTENT_LENGTH", "IMAGE_EXTENSIONS"]

# Ceiling for the largest legitimate upload: the Local Node embeddings
# import package (import_package.zip). Per-route limits are enforced at
# the route; this is the hard backstop. Video upload was retired
# 2026-08-14 — enrollment videos are now processed offline by
# trainer_desktop and never traverse this API.
MAX_CONTENT_LENGTH = 64 * 1024 * 1024  # 64 MB
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "bmp", "webp"}
