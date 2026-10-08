from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

import numpy as np

from local_node import config_store, local_db
from local_node.config import FACE_MATCHING_THRESHOLD, MATCH_STRATEGY
from local_node.config_store import load_config
from local_node.logging_config import log_on_change
from shared_face_engine import (
    CentroidIndex,
    PreparedMultiCandidates,
    build_centroid_index,
    closest_centroid as _shared_closest_centroid,
    closest_candidate_multi_prepared as _shared_closest_candidate,
    prepare_multi_candidates,
)
from shared_face_engine.matching import EMBEDDING_DIM

logger = logging.getLogger(__name__)

_cache_lock = threading.Lock()
_cache_generation = 0
_cached_branch_id: str | None = None
_cached_candidates: dict[str, list[np.ndarray]] = {}
_cached_prepared: PreparedMultiCandidates | None = None
_cached_centroid_index: CentroidIndex | None = None
_cached_meta: dict[str, dict[str, Any]] = {}
_cached_strategies: set[str] = set()

_config_lock = threading.Lock()
_cached_config: dict[str, Any] = {}
_cached_config_key: tuple[int, int] | None = None
_config_cache_initialized = False


def _runtime_config() -> dict[str, Any]:
    """Reload runtime config only when its file metadata changes."""
    global _cached_config, _cached_config_key, _config_cache_initialized
    path: Path = config_store.CONFIG_PATH
    try:
        stat = path.stat()
        config_key = (stat.st_mtime_ns, stat.st_size)
    except FileNotFoundError:
        config_key = None

    with _config_lock:
        if _config_cache_initialized and config_key == _cached_config_key:
            return _cached_config

    config = load_config()
    with _config_lock:
        _cached_config = config
        _cached_config_key = config_key
        _config_cache_initialized = True
        return _cached_config


def _load_candidates(
    branch_id: str,
) -> tuple[dict[str, list[np.ndarray]], dict[str, dict[str, Any]], tuple[str, ...]]:
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in local_db.get_all_embeddings(branch_id):
        key = (row["people_type"], row["person_code"])
        entry = grouped.setdefault(key, {
            "vectors": [],
            "full_name": row.get("full_name"),
            "department_id": row.get("department_id") or "",
            "class_id": row.get("class_id") or "",
            "section_id": row.get("section_id") or "",
        })
        entry["vectors"].append(row["embedding"])

    candidates: dict[str, list[np.ndarray]] = {}
    meta: dict[str, dict[str, Any]] = {}
    skipped_owner_ids: list[str] = []
    for (people_type, person_code), entry in grouped.items():
        key = f"{people_type}::{person_code}"
        try:
            vectors = [
                np.asarray(vector, dtype=np.float32)
                for vector in entry["vectors"]
            ]
            if not vectors or any(vector.shape != (EMBEDDING_DIM,) for vector in vectors):
                skipped_owner_ids.append(key)
                continue
            matrix = np.stack(vectors, axis=0)
            if not np.isfinite(matrix).all():
                skipped_owner_ids.append(key)
                continue
        except (TypeError, ValueError, OverflowError):
            skipped_owner_ids.append(key)
            continue

        candidates[key] = [row for row in matrix]
        meta[key] = {
            "people_type": people_type,
            "person_code": person_code,
            "full_name": entry["full_name"],
            "department_id": entry["department_id"],
            "class_id": entry["class_id"],
            "section_id": entry["section_id"],
        }

    return candidates, meta, tuple(skipped_owner_ids)


def _log_skipped_owners(branch_id: str, owner_ids: tuple[str, ...]) -> None:
    if owner_ids:
        log_on_change(
            logger,
            f"invalid_embeddings:{branch_id}",
            "recognition_worker: skipping unusable embeddings for owner(s): %s",
            ", ".join(owner_ids),
            level=logging.WARNING,
        )


def _ensure_cache(
    branch_id: str,
) -> tuple[
    dict[str, list[np.ndarray]],
    PreparedMultiCandidates | None,
    CentroidIndex | None,
    dict[str, dict[str, Any]],
]:
    """Ensure the selected index exists, building outside the lock then swapping atomically."""
    global _cached_branch_id, _cached_candidates, _cached_prepared
    global _cached_centroid_index, _cached_meta, _cached_strategies

    while True:
        with _cache_lock:
            generation = _cache_generation
            branch_is_cached = _cached_branch_id == branch_id
            if branch_is_cached and MATCH_STRATEGY in _cached_strategies:
                return (
                    _cached_candidates,
                    _cached_prepared,
                    _cached_centroid_index,
                    _cached_meta,
                )
            existing_candidates = _cached_candidates if branch_is_cached else None
            existing_meta = _cached_meta if branch_is_cached else None

        if existing_candidates is None or existing_meta is None:
            candidates, meta, skipped_owner_ids = _load_candidates(branch_id)
            skipped_owner_ids = list(skipped_owner_ids)
            is_new_branch_cache = True
        else:
            candidates, meta = existing_candidates, existing_meta
            skipped_owner_ids = []
            is_new_branch_cache = False

        prepared: PreparedMultiCandidates | None = None
        centroid_index: CentroidIndex | None = None
        if MATCH_STRATEGY == "centroid":
            centroid_index, centroid_skipped = build_centroid_index(candidates)
            skipped_owner_ids += centroid_skipped
        else:
            prepared = prepare_multi_candidates(candidates)

        with _cache_lock:
            if generation != _cache_generation:
                continue
            if _cached_branch_id == branch_id and MATCH_STRATEGY in _cached_strategies:
                return (
                    _cached_candidates,
                    _cached_prepared,
                    _cached_centroid_index,
                    _cached_meta,
                )

            if _cached_branch_id != branch_id:
                _cached_branch_id = branch_id
                _cached_candidates = candidates
                _cached_meta = meta
                _cached_prepared = None
                _cached_centroid_index = None
                _cached_strategies = set()
            if MATCH_STRATEGY == "centroid":
                _cached_centroid_index = centroid_index
            else:
                _cached_prepared = prepared
            _cached_strategies.add(MATCH_STRATEGY)

            cache_result = (
                _cached_candidates,
                _cached_prepared,
                _cached_centroid_index,
                _cached_meta,
            )

        _log_skipped_owners(branch_id, tuple(dict.fromkeys(skipped_owner_ids)))
        if is_new_branch_cache:
            logger.info(
                "recognition_worker: cache rebuilt for branch_id=%s -> "
                "%d enrolled candidate(s), match_strategy=%s",
                branch_id, len(candidates), MATCH_STRATEGY,
            )
        return cache_result


def invalidate_cache() -> None:
    """Invalidate grouped candidates and prepared indexes after enrollment changes."""
    global _cache_generation, _cached_branch_id, _cached_candidates
    global _cached_prepared, _cached_centroid_index, _cached_meta, _cached_strategies
    with _cache_lock:
        _cache_generation += 1
        _cached_branch_id = None
        _cached_candidates = {}
        _cached_prepared = None
        _cached_centroid_index = None
        _cached_meta = {}
        _cached_strategies = set()


def best_match(test_embedding: Any, threshold: float | None = None) -> dict[str, Any] | None:
    cfg = _runtime_config()
    branch_id = str(cfg.get("branch_id") or "")
    if not branch_id:
        return None
    min_score = float(
        threshold
        if threshold is not None
        else cfg.get("match_threshold") or FACE_MATCHING_THRESHOLD
    )
    candidate = np.asarray(test_embedding, dtype=np.float32)

    candidates, prepared, centroid_index, meta = _ensure_cache(branch_id)
    logger.debug(
        "recognition_worker.best_match branch_id=%s threshold=%.2f candidate_persons=%d",
        branch_id,
        min_score,
        len(candidates),
    )

    closest = (
        _shared_closest_centroid(candidate, centroid_index)
        if MATCH_STRATEGY == "centroid"
        else _shared_closest_candidate(candidate, prepared)
    )
    result = closest if closest is not None and closest[1] >= min_score else None
    if result is None:
        if closest is None:
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
    logger.debug(
        "recognition_worker.best_match: MATCH %s:%s (%s) similarity=%.4f threshold=%.2f",
        info["people_type"], info["person_code"], info.get("full_name") or "?", similarity, min_score,
    )
    return {
        "people_type": info["people_type"],
        "person_code": info["person_code"],
        "staff_name": info["full_name"],
        "confidence": float(similarity),
        "department_id": info["department_id"],
        "class_id": info["class_id"],
        "section_id": info["section_id"],
    }
