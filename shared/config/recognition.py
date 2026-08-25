"""Face detection, embedding, and recognition-matching constants."""

import os

__all__ = [
    "YOLO_MODEL", "INSIGHTFACE_MODEL", "FACE_DETECTION_CONFIDENCE",
    "FACE_MATCHING_THRESHOLD", "FACE_QUALITY_THRESHOLD",
    "MIN_EMBEDDINGS_PER_USER", "RECOGNITION_CONFIDENCE_THRESHOLD",
    "ANTI_SPOOFING_ENABLED", "DUPLICATE_LOG_TIMEOUT",
]

YOLO_MODEL = "yolov8n.pt"  # Legacy reference; no longer used for face detection
INSIGHTFACE_MODEL = "buffalo_l"
FACE_DETECTION_CONFIDENCE = 0.5
FACE_MATCHING_THRESHOLD = 0.45  # ArcFace cosine similarity threshold
FACE_QUALITY_THRESHOLD = 0.7
MIN_EMBEDDINGS_PER_USER = 5

RECOGNITION_CONFIDENCE_THRESHOLD = 0.6

# shared_face_engine/spoof.py's check is a frequency-domain heuristic
# (high-frequency skin-texture energy vs. threshold), not a trained
# liveness model -- it can't distinguish "printed photo/screen replay"
# from "genuine but low-texture capture" (medium camera resolution,
# on-device noise reduction, flat/backlit lighting, JPEG compression
# all reduce the same signal it relies on). Left ANTI_SPOOFING_ENABLED
# an env-var (default on, matching prior hardcoded behavior) rather
# than only a code constant, so a false-reject spike in the field can
# be turned off operationally without a redeploy while a proper
# liveness model replaces this -- mark-attendance's real defense
# against one person clocking in for another is the 1:1 embedding
# match in verify_face, not this.
ANTI_SPOOFING_ENABLED = os.environ.get("ANTI_SPOOFING_ENABLED", "true").strip().lower() not in (
    "0", "false", "no", "off",
)
DUPLICATE_LOG_TIMEOUT = 30  # Seconds - suppress duplicate logs for same person