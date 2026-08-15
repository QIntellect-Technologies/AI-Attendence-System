from __future__ import annotations

import logging
import threading
from typing import Any

import numpy as np

from local_node import local_db
from local_node.config_store import load_config
from shared_face_engine import (
    best_match_multi as _shared_best_match,
    closest_candidate_multi as _shared_closest_candidate,
)

logger = logging.getLogger(__name__)

_cache_lock = threading.Lock()
_cached_branch_id: str | None = None
_cached_candidates: dict[str, np.ndarray] = {}
_cached_meta: dict[str, dict[str, Any]] = {}


def _build_cache(branch_id: str) -> None:
    """Group per-vector SQLite rows into one candidate list per person,
    ONCE — not on every best_match() call. Kept as the full per-vector
    list rather than a single mean-pooled aggregate (see matching.py's
    best_match_multi) so live matching can compare against the closest
    INDIVIDUAL enrollment sample instead of the person's averaged
    appearance — a single mean vector can sit further from a real but
    atypical appearance (glasses, different lighting, a beard grown
    since enrollment) than that appearance is from a genuine match."""
    global _cached_branch_id, _cached_candidates, _cached_meta

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in local_db.get_all_embeddings(branch_id):
        key = (row["people_type"], row["person_code"])
        entry = grouped.setdefault(key, {"vectors": [], "full_name": row.get("full_name")})
        entry["vectors"].append(np.asarray(row["embedding"], dtype=np.float32))

    candidates: dict[str, list[np.ndarray]] = {}
    meta: dict[str, dict[str, Any]] = {}
    for (people_type, person_code), entry in grouped.items():
        if not entry["vectors"]:
            continue
        key = f"{people_type}::{person_code}"
        candidates[key] = entry["vectors"]
        meta[key] = {"people_type": people_type, "person_code": person_code, "full_name": entry["full_name"]}

    _cached_branch_id = branch_id
    _cached_candidates = candidates
    _cached_meta = meta


def invalidate_cache() -> None:
    """Call after anything that changes local staff_embeddings (currently
    just local_db.import_embedding_package — see ui_server.py). Forces the
    next best_match() to rebuild from SQLite once, instead of serving
    stale aggregate embeddings until the node process restarts."""
    global _cached_branch_id
    with _cache_lock:
        _cached_branch_id = None


def best_match(test_embedding: Any, threshold: float | None = None) -> dict[str, Any] | None:
    cfg = load_config()
    branch_id = str(cfg.get("branch_id") or "")
    if not branch_id:
        return None
    min_score = float(threshold if threshold is not None else cfg.get("match_threshold") or 0.45)
    candidate = np.asarray(test_embedding, dtype=float)

    with _cache_lock:
        if _cached_branch_id != branch_id:
            _build_cache(branch_id)
        candidates = _cached_candidates
        meta = _cached_meta

    logger.debug(
        "recognition_worker.best_match branch_id=%s threshold=%.2f candidate_persons=%d",
        branch_id,
        min_score,
        len(candidates),
    )
    result = _shared_best_match(candidate, candidates, threshold=min_score)
    if result is None:
        closest = _shared_closest_candidate(candidate, candidates)
        if closest is None:
            logger.info(
                "recognition_worker.best_match: NO MATCH — branch_id=%s has 0 enrolled "
                "candidate(s) cached, nothing to compare this face against",
                branch_id,
            )
        else:
            closest_key, closest_similarity = closest
            closest_info = meta[closest_key]
            logger.info(
                "recognition_worker.best_match: NO MATCH — closest candidate was %s:%s (%s) "
                "similarity=%.4f, below threshold=%.2f (branch_id=%s, %d candidate(s) compared)",
                closest_info["people_type"], closest_info["person_code"],
                closest_info.get("full_name") or "?",
                closest_similarity, min_score, branch_id, len(candidates),
            )
        return None

    matched_key, similarity = result
    info = meta[matched_key]
    logger.info(
        "recognition_worker.best_match: MATCH %s:%s (%s) similarity=%.4f threshold=%.2f",
        info["people_type"], info["person_code"], info.get("full_name") or "?", similarity, min_score,
    )
    return {
        "people_type": info["people_type"],
        "person_code": info["person_code"],
        "staff_name": info["full_name"],
        "confidence": float(similarity),
    }