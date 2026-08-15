"""
shared_face_engine

Single face engine (model loading, detection, embedding, quality scoring,
and now matching) shared by Trainer Desktop, Local Node, and the backend
(app.py). All three consumers must import only from this public API —
never reach into submodules directly — so model version, detection
thresholds, quality scoring, and match-decision logic can never drift
between training and recognition, wherever recognition happens to run.
"""

from __future__ import annotations
from shared_face_engine.spoof import detect_spoofing
from shared_face_engine.model_loader import (
    MODEL_NAME,
    get_face_model,
    is_gpu_enabled,
    stage_models,
    unload_model,
)
from shared_face_engine.embedding import (
    detect_and_extract,
    process_video,
)
from shared_face_engine.quality import (
    FaceQualityResult,
    assess_face_quality,
    is_good_enrollment_face,
    is_good_recognition_face,
)
from shared_face_engine.matching import (
    DEFAULT_MATCH_THRESHOLD,
    best_match,
    best_match_multi,
    closest_candidate,
    closest_candidate_multi,
    compare_embeddings,
    compute_aggregate_embedding,
)

__all__ = [
    "MODEL_NAME",
    "get_face_model",
    "is_gpu_enabled",
    "stage_models",
    "unload_model",
    "detect_and_extract",
    "process_video",
    "FaceQualityResult",
    "assess_face_quality",
    "is_good_enrollment_face",
    "is_good_recognition_face",
    "DEFAULT_MATCH_THRESHOLD",
    "best_match",
    "best_match_multi",
    "closest_candidate",
    "closest_candidate_multi",
    "compare_embeddings",
    "compute_aggregate_embedding",
    "detect_spoofing"
]