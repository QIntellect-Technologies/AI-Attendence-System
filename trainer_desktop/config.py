from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent

MODELS_DIR = PROJECT_ROOT / "models"

load_dotenv(BASE_DIR / ".env")


def _env_text(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _env_int(name: str, default: int, minimum: int, maximum: int | None = None) -> int:
    raw = _env_text(name, str(default))

    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer.") from exc

    value = max(value, minimum)

    if maximum is not None:
        value = min(value, maximum)

    return value


def _env_float(name: str, default: float) -> float:
    raw = _env_text(name, str(default))

    try:
        return float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a float.") from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = _env_text(name, "true" if default else "false").lower()
    return raw in {"1", "true", "yes", "on"}


# ---------------------------------------------------
# Shared Engine
# ---------------------------------------------------

# Single source of truth lives in shared_face_engine — re-exported here so
# existing imports (job_runner, package_builder, training_engine) don't need
# to change. Imported from the package's public API, not the submodule
# directly: shared_face_engine/__init__.py requires every consumer to go
# through it so model version/thresholds/logic can never drift per-consumer.
from shared_face_engine import MODEL_NAME

MAX_FRAMES = _env_int(
    "TRAINER_MAX_FRAMES",
    120,
    minimum=10,
)

MIN_EMBEDDINGS = _env_int(
    "TRAINER_MIN_EMBEDDINGS",
    1,
    minimum=1,
)

MIN_AVG_QUALITY = _env_float(
    "TRAINER_MIN_AVG_QUALITY",
    0.0,
)

VIDEO_MAX_BYTES = (
    _env_int(
        "TRAINER_VIDEO_MAX_MB",
        250,
        minimum=1,
    )
    * 1024
    * 1024
)

COPY_PROFILE_IMAGES = _env_bool(
    "TRAINER_COPY_PROFILE_IMAGES",
    True,
)

FAIL_ON_MISSING_IMAGE = _env_bool(
    "TRAINER_FAIL_ON_MISSING_IMAGE",
    False,
)

DEFAULT_CSV_NAME = _env_text(
    "TRAINER_DEFAULT_CSV_NAME",
    "People Enrollment.csv",
)

VIDEOS_DIR_NAME = _env_text(
    "TRAINER_VIDEOS_DIR_NAME",
    "Videos",
)

OUTPUT_DIR_NAME = _env_text(
    "TRAINER_OUTPUT_DIR_NAME",
    "Output",
)

EMBEDDINGS_DIR_NAME = _env_text(
    "TRAINER_EMBEDDINGS_DIR_NAME",
    "embeddings",
)

PEOPLE_ASSETS_DIR_NAME = _env_text(
    "TRAINER_PEOPLE_ASSETS_DIR_NAME",
    "people_assets",
)

ALLOWED_VIDEO_EXTENSIONS = {
    ".mp4",
    ".avi",
    ".mov",
    ".mkv",
    ".webm",
}

ALLOWED_IMAGE_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
}