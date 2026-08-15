"""Face detection, embedding, and recognition-matching constants."""

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
ANTI_SPOOFING_ENABLED = True
DUPLICATE_LOG_TIMEOUT = 30  # Seconds - suppress duplicate logs for same person
