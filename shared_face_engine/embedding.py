"""
shared_face_engine/embedding.py

Frame- and video-level face detection + embedding extraction, shared by:
- Trainer Desktop (video-level: process_video)
- Local Node       (frame-level: detect_and_extract)

InsightFace's FaceAnalysis.get() performs detection and embedding
extraction in a single forward pass, so this module never calls the
model twice for the same frame/detection — that would double
GPU/CPU cost for no benefit.

Design note: this module takes `models_root` as an explicit argument
everywhere rather than importing it from trainer_desktop.config. Local
Node will not have the trainer_desktop package installed, so shared_face_engine
must not depend on either consumer's config module.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from shared_face_engine.model_loader import get_face_model
from shared_face_engine.quality import (
    DEFAULT_ENROLLMENT_QUALITY_FLOOR,
    assess_face_quality,
    is_good_enrollment_face,
)

logger = logging.getLogger(__name__)

DEFAULT_DET_CONFIDENCE = 0.5

# InsightFace's FaceAnalysis.get() is not safe to call concurrently — it
# does non-thread-safe numpy pre/post-processing around the ONNX session,
# and unsynchronized concurrent submissions to one CUDA context serialize
# and stall each other rather than running in parallel. Every
# CameraStreamReader thread shares one singleton model (see
# model_loader._face_model), so this lock is required, not optional, the
# moment more than one camera is running.
_inference_lock = threading.Lock()


def detect_and_extract(
    frame: np.ndarray,
    models_root: Path,
    min_confidence: float = DEFAULT_DET_CONFIDENCE,
) -> list[dict[str, Any]]:
    model = get_face_model(models_root)

    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB) if frame.ndim == 3 else frame
    with _inference_lock:
        faces = model.get(frame_rgb)

    results: list[dict[str, Any]] = []
    for face in faces:
        conf = float(face.det_score)
        if conf < min_confidence:
            continue
        x1, y1, x2, y2 = face.bbox.astype(int)
        results.append({
            "bbox": (int(x1), int(y1), int(x2), int(y2)),
            "conf": conf,
            "embedding": face.embedding,
        })
    return results


def _extract_frames(video_path: str, max_frames: int) -> list[np.ndarray]:
    cap = cv2.VideoCapture(video_path)
    try:
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total <= 0:
            return []

        interval = max(1, total // max_frames)
        frames: list[np.ndarray] = []
        idx = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break
            if idx % interval == 0:
                frames.append(frame)
            idx += 1

        return frames
    finally:
        cap.release()


def process_video(
    video_path: str | None,
    models_root: Path,
    max_frames: int = 120,
    min_quality_score: float | None = None,
    warmup_only: bool = False,
) -> dict[str, Any]:
    """
    Enrollment-video pipeline used by Trainer Desktop's training_engine.

    warmup_only=True loads the model with no video — call this once at
    process start so the first real file isn't billed for model-load time.

    min_quality_score: the real per-frame quality floor a kept embedding
    must clear, e.g. the caller's own FACE_QUALITY_THRESHOLD config
    constant. Pass it explicitly — shared_face_engine deliberately never
    imports a consumer's config module (same reason this function takes
    `models_root` as an explicit argument rather than importing it), so
    leaving this unset falls back to quality.py's own permissive default
    (DEFAULT_ENROLLMENT_QUALITY_FLOOR = 0.50) instead of whatever your
    config module actually says. That silent fallback is what let
    low-quality enrollments (e.g. avg_quality ~0.53) through in the first
    place — always pass this explicitly from the caller's config.
    """
    if warmup_only:
        get_face_model(models_root)
        return {"success": True}

    if not video_path:
        return {
            "success": False,
            "error": "video_path is required.",
            "embeddings": [],
            "total_frames": 0,
        }

    frames = _extract_frames(video_path, max_frames)
    if not frames:
        return {
            "success": False,
            "error": "No frames extracted from video.",
            "embeddings": [],
            "total_frames": 0,
        }

    embeddings: list[np.ndarray] = []
    quality_scores: list[float] = []

    for frame in frames:
        detections = detect_and_extract(frame, models_root)
        if not detections:
            continue

        # Largest face = primary enrollment subject in frame.
        largest = max(
            detections,
            key=lambda d: (d["bbox"][2] - d["bbox"][0]) * (d["bbox"][3] - d["bbox"][1]),
        )

        quality = assess_face_quality(frame, largest["bbox"])
        quality_scores.append(quality.score)

        effective_floor = (
            min_quality_score if min_quality_score is not None else DEFAULT_ENROLLMENT_QUALITY_FLOOR
        )
        if not is_good_enrollment_face(quality, minimum_score=effective_floor):
            continue

        embeddings.append(largest["embedding"])

    return {
        "success": len(embeddings) > 0,
        "embeddings": embeddings,
        "total_frames": len(frames),
        "avg_quality": float(np.mean(quality_scores)) if quality_scores else 0.0,
    }