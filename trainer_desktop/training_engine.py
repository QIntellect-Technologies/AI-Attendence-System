"""
trainer_desktop/training_engine.py

Enrollment video processing for Trainer Desktop. Thin wrapper around
shared_face_engine.process_video (the package's public API) — must NOT
reimplement frame sampling, detection, or quality-gating, since
shared_face_engine already does all three and is the one Local Node also
relies on for recognition. Duplicating it here would let Trainer Desktop's
enrollment quality bar silently drift from what Local Node considers a
"good enough" recognition face.

shared_face_engine.process_video deliberately returns a minimal,
consumer-agnostic shape: {success, embeddings, total_frames, avg_quality,
[error]}. This module's only job is to:

  1. Translate that into the richer per-video contract job_runner.py and
     package_builder.py need (embedding_count, total_frames_processed,
     training_duration_seconds, model_version, error_message).
  2. Enforce Trainer Desktop's own enrollment-acceptance thresholds
     (MIN_EMBEDDINGS, MIN_AVG_QUALITY) on top of shared_face_engine's
     per-frame quality gate — a video can come back "success" from the
     engine (>=1 usable frame) yet still be too thin/too low-quality for
     Trainer Desktop's enrollment bar.
  3. Convert embeddings from numpy arrays to plain JSON-serializable
     lists, since package_builder.write_json will otherwise raise
     TypeError on the first successful person.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from shared_face_engine import MODEL_NAME, process_video

from trainer_desktop.config import (
    MAX_FRAMES,
    MIN_AVG_QUALITY,
    MIN_EMBEDDINGS,
    MODELS_DIR,
)

logger = logging.getLogger(__name__)


class EngineNotConfiguredError(RuntimeError):
    """Raised when the shared face model cannot be staged/loaded."""


def validate_engine_configured() -> None:
    """
    Warms up the shared InsightFace model once, before the training loop
    starts. Fails fast with one clear error if the model bundle is
    missing/corrupt, instead of surfacing the same failure as a confusing
    per-person error on row 1.
    """
    try:
        process_video(None, MODELS_DIR, warmup_only=True)
    except Exception as exc:
        raise EngineNotConfiguredError(
            f"Face recognition engine could not be loaded from '{MODELS_DIR}': {exc}"
        ) from exc


def _failure(message: str) -> dict[str, Any]:
    return {
        "success": False,
        "error_message": message,
        "embeddings": [],
        "embedding_count": 0,
        "total_frames_processed": 0,
        "avg_quality": 0.0,
        "training_duration_seconds": 0.0,
        "model_version": MODEL_NAME,
    }


def extract_embeddings(video_path: str | Path) -> dict[str, Any]:
    """
    Runs the shared enrollment pipeline against one video and returns the
    training-run contract consumed by job_runner.py / package_builder.py.
    """
    started = time.perf_counter()

    try:
        result = process_video(str(video_path), MODELS_DIR, max_frames=MAX_FRAMES, min_quality_score=0.7)
    except Exception as exc:
        logger.exception("Enrollment processing raised for %s", video_path)
        return _failure(str(exc))

    training_duration_seconds = time.perf_counter() - started

    if not result.get("success"):
        return _failure(result.get("error") or "Video processing failed.")

    # Convert numpy embeddings -> plain lists now, at the one place both
    # package_builder.write_json (JSON output) and package_format.py
    # (round-trip parser) need them to already be lists.
    embeddings = [
        embedding.tolist() if hasattr(embedding, "tolist") else list(embedding)
        for embedding in (result.get("embeddings") or [])
    ]
    avg_quality = float(result.get("avg_quality", 0.0))

    if len(embeddings) < MIN_EMBEDDINGS:
        return _failure(
            f"Only {len(embeddings)} usable embedding(s) extracted; "
            f"at least {MIN_EMBEDDINGS} required."
        )

    if avg_quality < MIN_AVG_QUALITY:
        return _failure(
            f"Average face quality {avg_quality:.2f} is below the "
            f"minimum required {MIN_AVG_QUALITY:.2f}."
        )

    return {
        "success": True,
        "error_message": "",
        "embeddings": embeddings,
        "embedding_count": len(embeddings),
        "total_frames_processed": int(result.get("total_frames", 0)),
        "avg_quality": avg_quality,
        "training_duration_seconds": training_duration_seconds,
        "model_version": MODEL_NAME,
    }