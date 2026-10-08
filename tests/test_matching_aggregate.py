import numpy as np
import pytest

from shared_face_engine import compute_aggregate_embedding


def _reference_impl(embeddings):
    if not embeddings:
        return None
    norm_embeddings = []
    for emb in embeddings:
        a = np.array(emb, dtype=np.float32)
        n = np.linalg.norm(a)
        if n > 1e-6:
            norm_embeddings.append(a / n)
    if not norm_embeddings:
        return None
    if len(norm_embeddings) == 1:
        return norm_embeddings[0]
    centroid = np.mean(norm_embeddings, axis=0)
    centroid = centroid / (np.linalg.norm(centroid) + 1e-6)
    if len(norm_embeddings) >= 5:
        sims = [float(np.dot(e, centroid)) for e in norm_embeddings]
        filtered = [e for e, s in zip(norm_embeddings, sims) if s >= 0.4]
        if len(filtered) >= 3:
            norm_embeddings = filtered
            centroid = np.mean(norm_embeddings, axis=0)
            centroid = centroid / (np.linalg.norm(centroid) + 1e-6)
    return centroid


def _normalized_mean(embeddings: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(embeddings, axis=1)
    normalized = embeddings / norms[:, np.newaxis]
    centroid = np.mean(normalized, axis=0)
    return centroid / (np.linalg.norm(centroid) + 1e-6)


def test_empty_and_all_zero_inputs_return_none() -> None:
    assert compute_aggregate_embedding([]) is None
    assert compute_aggregate_embedding(np.zeros((4, 512), dtype=np.float32)) is None


def test_zero_vectors_are_skipped() -> None:
    vector = np.arange(1, 513, dtype=np.float32)
    result = compute_aggregate_embedding([np.zeros(512), vector])

    assert result is not None
    np.testing.assert_allclose(result, vector / np.linalg.norm(vector), atol=1e-6)


def test_single_vector_returns_a_float32_unit_norm_copy() -> None:
    vector = np.arange(1, 513, dtype=np.float64)
    result = compute_aggregate_embedding([vector])

    assert result is not None
    assert result.dtype == np.float32
    assert result.shape == (512,)
    assert np.linalg.norm(result) == pytest.approx(1.0, abs=1e-5)
    np.testing.assert_allclose(result, vector / np.linalg.norm(vector), atol=1e-6)
    assert not np.shares_memory(result, vector)


def test_input_forms_are_equivalent() -> None:
    vectors = np.arange(1, 5 * 512 + 1, dtype=np.float32).reshape(5, 512)

    as_lists = compute_aggregate_embedding(vectors.tolist())
    as_tuple = compute_aggregate_embedding(tuple(vectors))
    as_array = compute_aggregate_embedding(vectors)

    assert as_lists is not None and as_tuple is not None and as_array is not None
    np.testing.assert_allclose(as_lists, as_tuple, atol=1e-6)
    np.testing.assert_allclose(as_lists, as_array, atol=1e-6)


def test_output_is_float32_512_dimensions_and_unit_norm() -> None:
    rng = np.random.default_rng(7)
    result = compute_aggregate_embedding(rng.normal(size=(8, 512)))

    assert result is not None
    assert result.dtype == np.float32
    assert result.shape == (512,)
    assert np.linalg.norm(result) == pytest.approx(1.0, abs=1e-5)


def test_four_vectors_use_unfiltered_normalized_mean() -> None:
    vectors = np.eye(4, 512, dtype=np.float32)

    result = compute_aggregate_embedding(vectors)

    assert result is not None
    np.testing.assert_allclose(result, _normalized_mean(vectors), atol=1e-6)


def test_outlier_is_removed_from_six_consistent_vectors_and_one_orthogonal() -> None:
    v = np.zeros(512, dtype=np.float32)
    v[0] = 1
    orthogonal = np.zeros(512, dtype=np.float32)
    orthogonal[1] = 1
    vectors = np.stack([v] * 6 + [orthogonal])

    result = compute_aggregate_embedding(vectors)
    unfiltered = _normalized_mean(vectors)

    assert result is not None
    assert float(np.dot(result, v)) > float(np.dot(unfiltered, v))
    np.testing.assert_allclose(result, v, atol=1e-6)


def test_outlier_filter_falls_back_when_fewer_than_three_vectors_remain() -> None:
    x = np.zeros(512, dtype=np.float32)
    x[0] = 1
    directions = []
    for angle in (0, 2 * np.pi / 3, 4 * np.pi / 3):
        direction = np.zeros(512, dtype=np.float32)
        direction[1] = np.cos(angle)
        direction[2] = np.sin(angle)
        directions.append(-0.3 * x + np.sqrt(1 - 0.3**2) * direction)
    vectors = np.stack([x, x, *directions])
    normalized = vectors / np.linalg.norm(vectors, axis=1)[:, np.newaxis]
    initial_centroid = _normalized_mean(vectors)
    assert np.count_nonzero(normalized @ initial_centroid >= 0.4) == 2

    result = compute_aggregate_embedding(vectors)

    assert result is not None
    np.testing.assert_allclose(result, _normalized_mean(vectors), atol=1e-6)


def test_call_does_not_mutate_input_arrays() -> None:
    rng = np.random.default_rng(19)
    vectors = rng.normal(size=(7, 512)).astype(np.float64)
    vectors[2] = 0
    original = vectors.copy()

    compute_aggregate_embedding(vectors)

    np.testing.assert_array_equal(vectors, original)


def test_matches_reference_for_200_seeded_inputs() -> None:
    rng = np.random.default_rng(2026)
    for case in range(200):
        size = case % 30 + 1
        base = rng.normal(size=512)
        base /= np.linalg.norm(base)
        vectors = rng.normal(size=(size, 512))
        if size >= 5:
            inlier_count = max(3, size * 3 // 4)
            vectors[:inlier_count] = base + rng.normal(
                scale=0.03, size=(inlier_count, 512)
            )
            vectors[-2] = -base + rng.normal(scale=0.03, size=512)
            vectors[-1] = 0
        elif size > 1 and case % 2 == 0:
            vectors[-1] = 0
        inputs = vectors.astype(np.float32 if case % 2 == 0 else np.float64)

        actual = compute_aggregate_embedding(inputs)
        expected = _reference_impl(list(inputs))
        if actual is None or expected is None:
            assert actual is None and expected is None
        else:
            np.testing.assert_allclose(actual, expected, atol=1e-6)
