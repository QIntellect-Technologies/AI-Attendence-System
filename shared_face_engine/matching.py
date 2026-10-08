"""
shared_face_engine/matching.py

Embedding aggregation and comparison, shared by every consumer that needs
to turn one-or-more stored embeddings into a match decision:

- Trainer Desktop        (aggregates embeddings after enrollment, optionally)
- Local Node              (recognition_worker.best_match against SQLite embeddings)
- Backend / app.py        (CameraStreamReader, /api/recognize/*, against
                            legacy SQLite embeddings AND Supabase embeddings)

This existed as three near-identical re-implementations before
(face_processor.compute_aggregate_embedding/compare_embeddings, whatever
local_node/recognition_worker.py does internally, and the cosine-similarity
helper in an earlier cloud worker draft). Centralizing it here means a
future change to the matching algorithm (threshold, distance metric,
per-vector weighting) only has to happen once, and training/recognition can
never silently drift apart the way the two separate InsightFace singletons
in shared_face_engine vs. face_processor.py did.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np
from numpy.typing import ArrayLike

DEFAULT_MATCH_THRESHOLD = 0.60
EMBEDDING_DIM = 512
# Ignore embeddings whose norm is effectively zero before normalization.
AGGREGATE_VECTOR_MIN_NORM = 1e-6
# Stabilize normalization of a centroid, matching the existing reference.
AGGREGATE_CENTROID_NORM_EPSILON = 1e-6
# Outlier filtering starts only when there are at least five valid samples.
AGGREGATE_OUTLIER_MIN_SAMPLES = 5
# Samples below this cosine similarity to the initial centroid are outliers.
AGGREGATE_OUTLIER_MIN_SIMILARITY = 0.4
# Keep the unfiltered centroid unless filtering retains at least three samples.
AGGREGATE_OUTLIER_MIN_KEEP = 3


@dataclass(frozen=True)
class PreparedMultiCandidates:
    """Normalized enrollment matrix and owner key for multi-vector matching."""

    matrix: np.ndarray
    owner_ids: tuple[str, ...]


@dataclass(frozen=True)
class CentroidIndex:
    """One normalized aggregate embedding row per owner."""

    matrix: np.ndarray
    owner_ids: tuple[str, ...]


def compute_aggregate_embedding(
    embeddings: Sequence[ArrayLike] | np.ndarray,
) -> np.ndarray | None:
    """Normalize individual embeddings and aggregate them into one profile vector."""
    if len(embeddings) == 0:
        return None

    stacked = np.stack(
        [np.asarray(embedding, dtype=np.float32) for embedding in embeddings],
        axis=0,
    )
    norms = np.linalg.norm(stacked, axis=1)
    valid = norms > AGGREGATE_VECTOR_MIN_NORM
    if not np.any(valid):
        return None

    normalized = stacked[valid] / norms[valid, np.newaxis]
    if len(normalized) == 1:
        return normalized[0]

    centroid = np.mean(normalized, axis=0)
    centroid = centroid / (
        np.linalg.norm(centroid) + AGGREGATE_CENTROID_NORM_EPSILON
    )
    if len(normalized) >= AGGREGATE_OUTLIER_MIN_SAMPLES:
        similarities = normalized @ centroid
        filtered = normalized[similarities >= AGGREGATE_OUTLIER_MIN_SIMILARITY]
        if len(filtered) >= AGGREGATE_OUTLIER_MIN_KEEP:
            centroid = np.mean(filtered, axis=0)
            centroid = centroid / (
                np.linalg.norm(centroid) + AGGREGATE_CENTROID_NORM_EPSILON
            )

    return centroid


def build_centroid_index(
    vectors_by_owner: Mapping[str, Sequence[ArrayLike] | np.ndarray],
) -> tuple[CentroidIndex | None, list[str]]:
    """Build an ordered centroid matrix and return owners with unusable data."""
    matrix_rows: list[np.ndarray] = []
    owner_ids: list[str] = []
    skipped_owner_ids: list[str] = []

    for owner_id, vectors in vectors_by_owner.items():
        try:
            vector_rows = [np.asarray(vector, dtype=np.float32) for vector in vectors]
            if not vector_rows:
                skipped_owner_ids.append(owner_id)
                continue
            if any(vector.shape != (EMBEDDING_DIM,) for vector in vector_rows):
                skipped_owner_ids.append(owner_id)
                continue
            stacked = np.stack(vector_rows, axis=0)
            if not np.isfinite(stacked).all():
                skipped_owner_ids.append(owner_id)
                continue
            centroid = compute_aggregate_embedding(stacked)
        except (TypeError, ValueError, OverflowError):
            skipped_owner_ids.append(owner_id)
            continue

        if centroid is None:
            skipped_owner_ids.append(owner_id)
            continue

        norm = np.linalg.norm(centroid)
        if not np.isfinite(norm) or norm <= AGGREGATE_VECTOR_MIN_NORM:
            skipped_owner_ids.append(owner_id)
            continue
        matrix_rows.append(np.asarray(centroid / norm, dtype=np.float32))
        owner_ids.append(owner_id)

    index = (
        CentroidIndex(
            np.stack(matrix_rows).astype(np.float32, copy=False),
            tuple(owner_ids),
        )
        if matrix_rows
        else None
    )
    return index, skipped_owner_ids


def _centroid_similarities(
    query: ArrayLike,
    index: CentroidIndex | None,
) -> np.ndarray | None:
    if index is None or not index.owner_ids:
        return None

    normalized_query = np.asarray(query, dtype=np.float32)
    if normalized_query.shape != (index.matrix.shape[1],):
        return None
    if not np.isfinite(normalized_query).all():
        return None

    norm = np.linalg.norm(normalized_query)
    if not np.isfinite(norm) or norm <= AGGREGATE_VECTOR_MIN_NORM:
        return None
    normalized_query = normalized_query / norm
    return index.matrix @ normalized_query


def closest_centroid(
    query: ArrayLike,
    index: CentroidIndex | None,
) -> tuple[str, float] | None:
    """Return the highest-scoring indexed owner without applying a threshold."""
    similarities = _centroid_similarities(query, index)
    if similarities is None:
        return None
    best_row = int(np.argmax(similarities))
    return index.owner_ids[best_row], float(similarities[best_row])


def match_centroid(
    query: ArrayLike,
    index: CentroidIndex | None,
    threshold: float,
) -> tuple[str, float] | None:
    """Return the highest-scoring centroid owner when its score meets threshold."""
    closest = closest_centroid(query, index)
    if closest is None or closest[1] < threshold:
        return None
    return closest


def compare_embeddings(
    reference_embedding: np.ndarray,
    test_embedding: np.ndarray,
    threshold: float = DEFAULT_MATCH_THRESHOLD,
) -> tuple[float, bool]:
    """Cosine similarity between a stored (aggregate) embedding and one
    freshly-detected embedding. Returns (similarity, is_match)."""
    ref = np.asarray(reference_embedding, dtype=np.float32)
    test = np.asarray(test_embedding, dtype=np.float32)

    ref_norm = ref / (np.linalg.norm(ref) + 1e-6)
    test_norm = test / (np.linalg.norm(test) + 1e-6)

    similarity = float(np.dot(ref_norm, test_norm))
    return similarity, similarity >= threshold


def _scan_candidates(
    test_embedding: np.ndarray,
    candidates: dict[str, np.ndarray],
) -> tuple[str, float] | None:
    """One pass over every candidate, tracking the globally closest one by
    raw cosine similarity — no threshold applied here. Shared by
    best_match() (threshold-gated) and closest_candidate() (diagnostic,
    no gate) so the comparison loop exists exactly once. Mathematically
    equivalent to the old best_match loop when a threshold IS applied
    afterward: the global max similarity is >= threshold iff at least one
    candidate cleared it, and it's the same value either way — so
    best_match()'s behavior below is unchanged, just derived correctly."""
    best_id: str | None = None
    best_similarity = -1.0

    for candidate_id, aggregate_embedding in candidates.items():
        similarity, _ = compare_embeddings(aggregate_embedding, test_embedding, threshold=0.0)
        if similarity > best_similarity:
            best_similarity = similarity
            best_id = candidate_id

    if best_id is None:
        return None
    return best_id, best_similarity


def best_match(
    test_embedding: np.ndarray,
    candidates: dict[str, np.ndarray],
    threshold: float = DEFAULT_MATCH_THRESHOLD,
) -> tuple[str, float] | None:
    """Compare one detected embedding against every candidate's aggregate
    embedding (candidate_id -> aggregate_embedding) and return the closest
    match above threshold, or None. Centralizes the "loop over all
    candidates, track the best" pattern that otherwise gets rewritten at
    every call site (app.py's recognition endpoints, CameraStreamReader,
    and any future consumer)."""
    closest = _scan_candidates(test_embedding, candidates)
    if closest is None or closest[1] < threshold:
        return None
    return closest


def _max_similarity_to_person(test_embedding: np.ndarray, person_vectors: Sequence[np.ndarray]) -> float:
    """Max cosine similarity between test_embedding and ANY single stored
    vector for one person, rather than one mean-pooled aggregate. Mean
    pooling collapses multi-modal appearance variation (glasses on/off,
    facial hair, pose, lighting) into a single centroid that can sit
    meaningfully further from any one real appearance than the real
    appearance is from a genuine same-person match — a false negative
    against a correctly-enrolled person whenever their live appearance
    diverges from whichever mode dominated their enrollment video.
    Comparing against every stored vector individually and keeping the
    best preserves that variation instead of averaging it away."""
    best = -1.0
    for vector in person_vectors:
        similarity, _ = compare_embeddings(vector, test_embedding, threshold=0.0)
        if similarity > best:
            best = similarity
    return best


def verify_against_vectors(
    test_embedding: np.ndarray,
    person_vectors: Sequence[np.ndarray],
    threshold: float = DEFAULT_MATCH_THRESHOLD,
) -> tuple[float, bool]:
    """Public 1:1 counterpart to best_match_multi(), for callers that
    already know which single person they're checking against (mobile
    self-verify) rather than scanning a candidate pool. Returns
    (best_similarity, is_match) using the same per-vector max-similarity
    approach as best_match_multi/_max_similarity_to_person, instead of
    compare_embeddings() against a compute_aggregate_embedding() mean —
    see _max_similarity_to_person's docstring for why the aggregate is
    the wrong comparison for a live 1:1 check against multi-frame
    enrollment vectors. Returns (-1.0, False) for no stored vectors,
    same "treat as no match, don't raise" contract as the rest of this
    module."""
    best = _max_similarity_to_person(test_embedding, person_vectors)
    return best, best >= threshold


def _scan_candidates_multi(
    test_embedding: np.ndarray,
    candidates: dict[str, Sequence[np.ndarray]],
) -> tuple[str, float] | None:
    """Same role as _scan_candidates, but each candidate maps to ALL of
    that person's stored enrollment vectors instead of one aggregate."""
    return _scan_prepared_multi(test_embedding, prepare_multi_candidates(candidates))


def prepare_multi_candidates(
    candidates: dict[str, Sequence[np.ndarray]],
) -> PreparedMultiCandidates | None:
    """Prepare multi-vector candidates once for repeated live matching."""
    vector_rows: list[np.ndarray] = []
    owner_ids: list[str] = []
    for candidate_id, vectors in candidates.items():
        for vector in vectors:
            vector_rows.append(np.asarray(vector, dtype=np.float32))
            owner_ids.append(candidate_id)

    if not vector_rows:
        return None

    stored_matrix = np.asarray(vector_rows, dtype=np.float32)
    stored_matrix = stored_matrix / (np.linalg.norm(stored_matrix, axis=1, keepdims=True) + 1e-6)
    return PreparedMultiCandidates(stored_matrix, tuple(owner_ids))


def _scan_prepared_multi(
    test_embedding: np.ndarray,
    prepared: PreparedMultiCandidates | None,
) -> tuple[str, float] | None:
    if prepared is None or not prepared.owner_ids:
        return None

    query = np.asarray(test_embedding, dtype=np.float32)
    query = query / (np.linalg.norm(query) + 1e-6)
    similarities = prepared.matrix @ query

    # np.argmax returns the first maximum, preserving the previous
    # dict/list traversal tie behavior.
    best_row = int(np.argmax(similarities))
    return prepared.owner_ids[best_row], float(similarities[best_row])


def best_match_multi_prepared(
    test_embedding: np.ndarray,
    prepared: PreparedMultiCandidates | None,
    threshold: float = DEFAULT_MATCH_THRESHOLD,
) -> tuple[str, float] | None:
    closest = _scan_prepared_multi(test_embedding, prepared)
    if closest is None or closest[1] < threshold:
        return None
    return closest


def closest_candidate_multi_prepared(
    test_embedding: np.ndarray,
    prepared: PreparedMultiCandidates | None,
) -> tuple[str, float] | None:
    return _scan_prepared_multi(test_embedding, prepared)


def best_match_multi(
    test_embedding: np.ndarray,
    candidates: dict[str, Sequence[np.ndarray]],
    threshold: float = DEFAULT_MATCH_THRESHOLD,
) -> tuple[str, float] | None:
    """Like best_match(), but candidates maps candidate_id -> ALL of that
    person's stored enrollment vectors, not one pre-averaged mean. Costs
    O(total stored vectors) per call instead of O(candidates) — negligible
    at hundreds of vectors, which is why recognition_worker still caches
    this per branch and only rebuilds on enrollment changes, same as the
    old aggregate cache did. If a branch's enrollment ever grows into the
    tens of thousands of vectors, this scan should move to an ANN index
    (e.g. faiss) instead of brute force — not a concern at current scale."""
    return best_match_multi_prepared(
        test_embedding,
        prepare_multi_candidates(candidates),
        threshold=threshold,
    )


def closest_candidate_multi(
    test_embedding: np.ndarray,
    candidates: dict[str, Sequence[np.ndarray]],
) -> tuple[str, float] | None:
    """Diagnostic-only counterpart to best_match_multi — same role as
    closest_candidate() for the multi-vector candidate shape."""
    return closest_candidate_multi_prepared(
        test_embedding,
        prepare_multi_candidates(candidates),
    )


def closest_candidate(
    test_embedding: np.ndarray,
    candidates: dict[str, np.ndarray],
) -> tuple[str, float] | None:
    """Diagnostic-only: the single closest candidate by similarity,
    regardless of threshold. best_match() alone can't distinguish "0
    candidates enrolled" from "compared against N, closest scored 0.38"
    when it returns None, because it only tracks candidates that already
    cleared the threshold. Callers that need to explain a non-match (not
    just detect one) use this after best_match() returns None."""
    return _scan_candidates(test_embedding, candidates)