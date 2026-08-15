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

from typing import Sequence

import numpy as np

DEFAULT_MATCH_THRESHOLD = 0.60


def compute_aggregate_embedding(embeddings: Sequence[np.ndarray]) -> np.ndarray | None:
    """Mean-normalize multiple embedding vectors for the same person into one
    aggregate profile vector. Returns None for an empty input rather than
    raising, since callers (e.g. a user with zero enrolled embeddings) treat
    that as "skip this profile", not an error."""
    if not embeddings:
        return None

    stacked = np.asarray(embeddings, dtype=np.float32)
    aggregate = np.mean(stacked, axis=0)
    norm = np.linalg.norm(aggregate)
    return aggregate / (norm + 1e-6)


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


def _scan_candidates_multi(
    test_embedding: np.ndarray,
    candidates: dict[str, Sequence[np.ndarray]],
) -> tuple[str, float] | None:
    """Same role as _scan_candidates, but each candidate maps to ALL of
    that person's stored enrollment vectors instead of one aggregate."""
    best_id: str | None = None
    best_similarity = -1.0
    for candidate_id, vectors in candidates.items():
        similarity = _max_similarity_to_person(test_embedding, vectors)
        if similarity > best_similarity:
            best_similarity = similarity
            best_id = candidate_id

    if best_id is None:
        return None
    return best_id, best_similarity


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
    closest = _scan_candidates_multi(test_embedding, candidates)
    if closest is None or closest[1] < threshold:
        return None
    return closest


def closest_candidate_multi(
    test_embedding: np.ndarray,
    candidates: dict[str, Sequence[np.ndarray]],
) -> tuple[str, float] | None:
    """Diagnostic-only counterpart to best_match_multi — same role as
    closest_candidate() for the multi-vector candidate shape."""
    return _scan_candidates_multi(test_embedding, candidates)


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

