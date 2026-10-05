"""
shared_face_engine/quality.py

Face quality assessment shared by:

- Trainer Desktop
- Local Node

Purpose
-------
Evaluate whether a detected face is suitable for:

1. Enrollment (high quality required)
2. Recognition (moderate quality acceptable)

The function returns both an overall score and detailed metrics.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List

import cv2
import numpy as np

# ---------------------------------------------------------
# Thresholds
# ---------------------------------------------------------

MIN_FACE_SIZE = 28

MIN_BLUR_SCORE = 60.0

MIN_BRIGHTNESS = 20

MAX_BRIGHTNESS = 235

MIN_ASPECT_RATIO = 0.50

MAX_ASPECT_RATIO = 1.60

DEFAULT_ENROLLMENT_QUALITY_FLOOR = 0.50


# ---------------------------------------------------------
# Models
# ---------------------------------------------------------

@dataclass(slots=True)
class FaceQualityResult:
    score: float
    blur_score: float
    brightness: float
    aspect_ratio: float
    face_width: int
    face_height: int
    issues: List[str] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return self.score >= 0.38


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------

def _laplacian_variance(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _brightness(gray: np.ndarray) -> float:
    return float(np.mean(gray))


# ---------------------------------------------------------
# Public API
# ---------------------------------------------------------

def assess_face_quality(
    frame: np.ndarray,
    bbox: tuple[int, int, int, int],
) -> FaceQualityResult:
    """
    Evaluate a detected face.

    Parameters
    ----------
    frame

        Original BGR frame.

    bbox

        (x1, y1, x2, y2)

    Returns
    -------
    FaceQualityResult
    """

    x1, y1, x2, y2 = map(int, bbox)

    frame_h, frame_w = frame.shape[:2]

    if (
        x1 < 0
        or y1 < 0
        or x2 > frame_w
        or y2 > frame_h
        or x2 <= x1
        or y2 <= y1
    ):
        return FaceQualityResult(
            score=0.0,
            blur_score=0.0,
            brightness=0.0,
            aspect_ratio=0.0,
            face_width=0,
            face_height=0,
            issues=["bbox_out_of_bounds"],
        )

    face = frame[y1:y2, x1:x2]

    if face.size == 0:
        return FaceQualityResult(
            score=0.0,
            blur_score=0.0,
            brightness=0.0,
            aspect_ratio=0.0,
            face_width=0,
            face_height=0,
            issues=["empty_crop"],
        )

    h, w = face.shape[:2]

    score = 1.0

    issues: list[str] = []

    # -----------------------------------------------------
    # Size
    # -----------------------------------------------------

    if h < 28 or w < 28:
        issues.append("face_too_small")
        score -= 0.35
    elif h < 45 or w < 45:
        issues.append("small_face")
        score -= 0.12

    # -----------------------------------------------------
    # Gray
    # -----------------------------------------------------

    gray = cv2.cvtColor(face, cv2.COLOR_BGR2GRAY)

    # -----------------------------------------------------
    # Blur
    # -----------------------------------------------------

    blur = _laplacian_variance(gray)

    if blur < 20.0:
        issues.append("blurry")
        score -= 0.35
    elif blur < 60.0:
        issues.append("slightly_blurry")
        score -= 0.15
    elif blur < 100.0:
        score -= 0.05


    # -----------------------------------------------------
    # Brightness
    # -----------------------------------------------------

    brightness = _brightness(gray)

    if (
        brightness < MIN_BRIGHTNESS
        or brightness > MAX_BRIGHTNESS
    ):

        issues.append("poor_lighting")

        score -= 0.10

    # -----------------------------------------------------
    # Aspect Ratio
    # -----------------------------------------------------

    aspect = w / h

    if (
        aspect < MIN_ASPECT_RATIO
        or aspect > MAX_ASPECT_RATIO
    ):

        issues.append("poor_aspect_ratio")

        score -= 0.15

    score = max(0.0, min(score, 1.0))

    return FaceQualityResult(
        score=score,
        blur_score=blur,
        brightness=brightness,
        aspect_ratio=aspect,
        face_width=w,
        face_height=h,
        issues=issues,
    )


def is_good_enrollment_face(
    result: FaceQualityResult,
    minimum_score: float = DEFAULT_ENROLLMENT_QUALITY_FLOOR,
) -> bool:
    """
    Trainer Desktop uses this before saving embeddings.

    `minimum_score` is a real parameter, not decoration — callers that care
    about a specific quality bar (e.g. Trainer Desktop's own
    FACE_QUALITY_THRESHOLD) must pass it explicitly. Leaving it unset
    silently falls back to DEFAULT_ENROLLMENT_QUALITY_FLOOR (0.50), which is
    deliberately more permissive than most consumers' real target and
    exists only so this function has a sane standalone default.
    """

    return result.score >= minimum_score


def is_good_recognition_face(
    result: FaceQualityResult,
    minimum_score: float = 0.35,
) -> bool:
    """
    Local Node uses this before matching.

    Recognition can tolerate slightly lower quality
    than enrollment.
    """

    return result.score >= minimum_score