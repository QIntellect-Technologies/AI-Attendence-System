"""
shared_face_engine/spoof.py

Presentation-attack (photo/video/mask) detection via texture + frequency-domain
analysis on a single detected face crop. Lives here rather than as a
backend-only module because Local Node's live recognition path carries the
same spoofing exposure as the backend's camera streams — a printed photo held
up to a laptop webcam is exactly as valid an attack against Local Node as
against a Railway-hosted camera stream. One shared implementation means both
consumers see identical spoof-detection behavior instead of it drifting the
way the two separate InsightFace singletons (shared_face_engine vs. the old
face_processor.py) already did once.

Design note: `enabled` is passed in explicitly by the caller (mirroring
embedding.py/model_loader.py's models_root pattern) rather than imported from
either consumer's config module, since Local Node will not have the backend's
config package installed.
"""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np

DEFAULT_SPOOF_RATIO_THRESHOLD = 0.5


def detect_spoofing(
    frame: np.ndarray,
    bbox: tuple[int, int, int, int],
    enabled: bool = True,
) -> dict[str, Any]:
    """Frequency-domain liveness check on one detected face crop.

    Real faces carry more high-frequency detail (skin texture, micro-shadows)
    than a printed photo or a screen replay of one, so the ratio of
    high-frequency to low-frequency FFT energy is used as the signal.

    Returns {"is_spoof": bool, "confidence": float, "method": str, ...}.
    """
    if not enabled:
        return {"is_spoof": False, "confidence": 1.0, "method": "disabled"}

    try:
        x1, y1, x2, y2 = map(int, bbox)
        cropped = frame[y1:y2, x1:x2]
        gray = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)

        h, w = gray.shape
        if h < 20 or w < 20:
            return {"is_spoof": False, "confidence": 0.5, "method": "skip_too_small"}

        edges = cv2.Canny(gray, 100, 200)
        edge_density = float(np.sum(edges > 0) / (h * w))

        fft = np.fft.fft2(gray)
        fft_shift = np.fft.fftshift(fft)
        magnitude = np.abs(fft_shift)

        center = (h // 2, w // 2)
        region_size = min(h, w) // 4

        low_freq = magnitude[
            center[0] - region_size:center[0] + region_size,
            center[1] - region_size:center[1] + region_size,
        ].sum()
        high_freq = magnitude.sum() - low_freq
        spectrum_ratio = float(high_freq / (low_freq + 1e-6))

        is_spoof = spectrum_ratio < DEFAULT_SPOOF_RATIO_THRESHOLD
        confidence = float(
            min(1.0, abs(spectrum_ratio - DEFAULT_SPOOF_RATIO_THRESHOLD) / DEFAULT_SPOOF_RATIO_THRESHOLD)
        )

        return {
            "is_spoof": is_spoof,
            "confidence": confidence,
            "method": "frequency_domain",
            "spectrum_ratio": spectrum_ratio,
            "edge_density": edge_density,
        }
    except Exception:
        return {"is_spoof": False, "confidence": 0.5, "method": "error"}