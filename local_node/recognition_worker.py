from __future__ import annotations

import logging
import threading
from typing import Any

import numpy as np

from local_node import local_db
from local_node.config_store import load_config
from local_node.logging_config import log_on_change
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
    logger.info(
        "recognition_worker: cache rebuilt for branch_id=%s -> %d enrolled candidate(s)",
        branch_id, len(candidates),
    )


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
            # This message has no varying content (just branch_id), so
            # log_on_change logs it once and stays silent for good — until
            # someone actually gets enrolled and the cache rebuilds, at
            # which point this branch stops being hit at all. DEBUG: a
            # diagnostic, not an operational event (nothing to act on here
            # unless you're actively troubleshooting enrollment).
            log_on_change(
                logger, f"no_match_empty:{branch_id}",
                "recognition_worker.best_match: NO MATCH — branch_id=%s has 0 enrolled "
                "candidate(s) cached, nothing to compare this face against",
                branch_id,
                level=logging.DEBUG,
            )
        else:
            closest_key, closest_similarity = closest
            closest_info = meta[closest_key]
            # Round similarity to 2 decimals — not just for display, but
            # because it's what log_on_change compares against. Raw
            # 4-decimal precision drifts by tiny fractions almost every
            # frame (lighting, micro-movement) even for the same person
            # standing still, which would defeat the dedup entirely (every
            # call would look "changed"). Rounded to 2 decimals, this line
            # logs once per person/similarity-bucket and prints again the
            # moment either a meaningfully different similarity or a
            # different closest candidate shows up.
            log_on_change(
                logger, f"no_match:{branch_id}",
                "recognition_worker.best_match: NO MATCH — closest candidate was %s:%s (%s) "
                "similarity=%.2f, below threshold=%.2f (branch_id=%s, %d candidate(s) compared)",
                closest_info["people_type"], closest_info["person_code"],
                closest_info.get("full_name") or "?",
                round(closest_similarity, 2), min_score, branch_id, len(candidates),
                level=logging.DEBUG,
            )
        return None

    matched_key, similarity = result
    info = meta[matched_key]
    # Not throttled: a track only ever calls best_match() once (see
    # camera_stream_manager._detect_and_record — the match result, found
    # or not, is cached on the track and reused every subsequent frame),
    # so this naturally fires once per newly-recognized face rather than
    # every frame of that face staying in view.
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