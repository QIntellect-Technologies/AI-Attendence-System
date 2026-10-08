import importlib
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Thread

import numpy as np
import pytest

from shared_face_engine import (
    CentroidIndex,
    build_centroid_index,
    closest_centroid,
    match_centroid,
)


def test_index_rows_are_unit_norm_and_preserve_owner_order() -> None:
    rng = np.random.default_rng(10)
    vectors = {
        "second": [rng.normal(size=512) for _ in range(3)],
        "first": [rng.normal(size=512) for _ in range(2)],
    }

    index, skipped = build_centroid_index(vectors)

    assert index is not None
    assert skipped == []
    assert isinstance(index, CentroidIndex)
    assert index.matrix.shape == (2, 512)
    assert index.matrix.dtype == np.float32
    assert index.owner_ids == ("second", "first")
    np.testing.assert_allclose(np.linalg.norm(index.matrix, axis=1), 1.0, atol=1e-6)


def test_empty_input_builds_no_index() -> None:
    assert build_centroid_index({}) == (None, [])
    assert build_centroid_index({"empty": []}) == (None, ["empty"])


def test_bad_owner_data_is_skipped_without_failing_other_owners() -> None:
    valid = np.ones(512, dtype=np.float32)
    index, skipped = build_centroid_index(
        {
            "good": [valid, valid.copy()],
            "wrong-dimension": [np.ones(511, dtype=np.float32)],
            "ragged": [valid, np.ones(10, dtype=np.float32)],
            "non-finite": [np.full(512, np.nan, dtype=np.float32)],
        }
    )

    assert index is not None
    assert index.owner_ids == ("good",)
    assert skipped == ["wrong-dimension", "ragged", "non-finite"]


def test_centroid_match_agrees_with_brute_force_for_200_queries() -> None:
    rng = np.random.default_rng(11)
    vectors = {
        f"owner-{owner}": [rng.normal(size=512) for _ in range(owner % 7 + 1)]
        for owner in range(20)
    }
    index, skipped = build_centroid_index(vectors)
    assert index is not None
    assert skipped == []

    for query in rng.normal(size=(200, 512)).astype(np.float32):
        normalized_query = query / np.linalg.norm(query)
        scores = [
            (owner_id, float(np.dot(row, normalized_query)))
            for owner_id, row in zip(index.owner_ids, index.matrix)
        ]
        expected = max(scores, key=lambda score: score[1])
        actual = closest_centroid(query, index)
        assert actual is not None
        assert actual[0] == expected[0]
        assert actual[1] == pytest.approx(expected[1], abs=1e-6)


def test_threshold_boundary_is_inclusive() -> None:
    vector = np.zeros(512, dtype=np.float32)
    vector[0] = 1
    index, _ = build_centroid_index({"person": [vector]})
    query = vector.copy()
    assert index is not None
    similarity = closest_centroid(query, index)
    assert similarity is not None

    assert match_centroid(query, index, similarity[1]) == similarity
    assert match_centroid(query, index, np.nextafter(similarity[1], np.inf)) is None


@pytest.mark.parametrize(
    "query",
    [
        np.zeros(512, dtype=np.float32),
        np.full(512, np.nan, dtype=np.float32),
    ],
)
def test_zero_or_nan_query_returns_no_match(query: np.ndarray) -> None:
    index, _ = build_centroid_index({"person": [np.ones(512, dtype=np.float32)]})

    assert closest_centroid(query, index) is None
    assert match_centroid(query, index, 0.4) is None


def test_aggregate_filters_outlier_that_per_vector_matching_would_accept() -> None:
    inlier = np.zeros(512, dtype=np.float32)
    inlier[0] = 1
    outlier = np.zeros(512, dtype=np.float32)
    outlier[1] = 1
    owner_vectors = [inlier.copy() for _ in range(6)] + [outlier]
    index, _ = build_centroid_index({"person": owner_vectors})

    assert index is not None
    centroid_similarity = closest_centroid(outlier, index)
    per_vector_similarity = max(
        float(np.dot(vector, outlier) / (np.linalg.norm(vector) + 1e-6))
        for vector in owner_vectors
    )
    assert centroid_similarity is not None
    assert centroid_similarity[1] < per_vector_similarity
    assert centroid_similarity[1] < 0.1
    assert per_vector_similarity > 0.99


def test_worker_strategy_from_environment_keeps_result_shape_and_rebuilds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from local_node import recognition_worker

    vectors = [np.eye(1, 512, dtype=np.float32)[0] for _ in range(6)]
    rows = [
        {
            "people_type": "staff",
            "person_code": "001",
            "embedding": vector.tolist(),
            "full_name": "Staff One",
        }
        for vector in vectors
    ]
    expected_keys = {
        "people_type",
        "person_code",
        "staff_name",
        "confidence",
        "department_id",
        "class_id",
        "section_id",
    }
    monkeypatch.setattr(
        recognition_worker.local_db,
        "get_all_embeddings",
        lambda _branch_id: rows,
    )
    monkeypatch.setattr(
        recognition_worker,
        "_runtime_config",
        lambda: {"branch_id": "branch-1", "match_threshold": 0.4},
    )

    try:
        for strategy in ("per_vector", "centroid"):
            monkeypatch.setenv("QINTELLECT_MATCH_STRATEGY", strategy)
            monkeypatch.setattr(recognition_worker, "MATCH_STRATEGY", strategy)
            recognition_worker.invalidate_cache()

            result = recognition_worker.best_match(vectors[0])
            assert result is not None
            assert set(result) == expected_keys
            if strategy == "centroid":
                assert recognition_worker._cached_prepared is None
                assert recognition_worker._cached_centroid_index is not None
            else:
                assert recognition_worker._cached_prepared is not None
                assert recognition_worker._cached_centroid_index is None

            alternate = "per_vector" if strategy == "centroid" else "centroid"
            monkeypatch.setattr(recognition_worker, "MATCH_STRATEGY", alternate)
            assert recognition_worker.best_match(vectors[0]) is not None
            assert alternate in recognition_worker._cached_strategies
            assert recognition_worker._cached_prepared is not None
            assert recognition_worker._cached_centroid_index is not None
            monkeypatch.setattr(recognition_worker, "MATCH_STRATEGY", strategy)

            recognition_worker.invalidate_cache()
            assert recognition_worker._cached_prepared is None
            assert recognition_worker._cached_centroid_index is None
            rebuilt = recognition_worker.best_match(vectors[0])
            assert rebuilt is not None
            assert set(rebuilt) == expected_keys
            assert strategy in recognition_worker._cached_strategies
    finally:
        recognition_worker.invalidate_cache()


def test_invalid_environment_strategy_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from local_node import config

    original_env_value = os.environ.get("QINTELLECT_MATCH_STRATEGY")
    try:
        monkeypatch.setenv("QINTELLECT_MATCH_STRATEGY", "unknown")
        with pytest.raises(ValueError, match="QINTELLECT_MATCH_STRATEGY"):
            importlib.reload(config)
    finally:
        if original_env_value is None:
            monkeypatch.delenv("QINTELLECT_MATCH_STRATEGY", raising=False)
        else:
            monkeypatch.setenv("QINTELLECT_MATCH_STRATEGY", original_env_value)
        importlib.reload(config)


def test_environment_strategy_is_trimmed_and_lowercased(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from local_node import config

    original_env_value = os.environ.get("QINTELLECT_MATCH_STRATEGY")
    try:
        monkeypatch.setenv("QINTELLECT_MATCH_STRATEGY", "  CENTROID  ")
        importlib.reload(config)
        assert config.MATCH_STRATEGY == "centroid"
    finally:
        if original_env_value is None:
            monkeypatch.delenv("QINTELLECT_MATCH_STRATEGY", raising=False)
        else:
            monkeypatch.setenv("QINTELLECT_MATCH_STRATEGY", original_env_value)
        importlib.reload(config)


@pytest.mark.parametrize("strategy", ["per_vector", "centroid"])
def test_worker_skips_corrupt_owner_and_matches_others(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    strategy: str,
) -> None:
    from local_node import recognition_worker

    valid = np.zeros(512, dtype=np.float32)
    valid[0] = 1
    rows = [
            {
                "people_type": "staff",
                "person_code": "good",
                "embedding": valid.tolist(),
                "full_name": "Good",
            },
            {
                "people_type": "staff",
                "person_code": "bad",
                "embedding": np.ones(511, dtype=np.float32).tolist(),
                "full_name": "Bad",
            },
    ]
    monkeypatch.setattr(recognition_worker, "MATCH_STRATEGY", strategy)
    monkeypatch.setattr(
            recognition_worker, "_runtime_config",
            lambda: {"branch_id": f"bad-data-{strategy}", "match_threshold": 0.4},
    )
    monkeypatch.setattr(
            recognition_worker.local_db, "get_all_embeddings", lambda _branch: rows,
    )
    recognition_worker.invalidate_cache()

    with caplog.at_level("WARNING", logger="local_node.recognition_worker"):
            result = recognition_worker.best_match(valid)

    assert result is not None
    assert result["person_code"] == "good"
    assert any("staff::bad" in record.message for record in caplog.records)
    if strategy == "centroid":
            assert recognition_worker._cached_centroid_index is not None
            assert recognition_worker._cached_prepared is None
    else:
            assert recognition_worker._cached_prepared is not None
            assert recognition_worker._cached_centroid_index is None
    recognition_worker.invalidate_cache()


@pytest.mark.parametrize("strategy", ["per_vector", "centroid"])
def test_miss_performs_exactly_one_scan(
    monkeypatch: pytest.MonkeyPatch,
    strategy: str,
) -> None:
    from local_node import recognition_worker

    scans = 0
    meta = {
            "staff::001": {
                "people_type": "staff",
                "person_code": "001",
                "full_name": "Staff One",
                "department_id": "",
                "class_id": "",
                "section_id": "",
            }
    }

    def closest(_query, _prepared):
            nonlocal scans
            scans += 1
            return "staff::001", 0.2

    monkeypatch.setattr(recognition_worker, "MATCH_STRATEGY", strategy)
    monkeypatch.setattr(
            recognition_worker,
            "_runtime_config",
            lambda: {"branch_id": "one-scan", "match_threshold": 0.4},
    )
    monkeypatch.setattr(
            recognition_worker,
            "_ensure_cache",
            lambda _branch: (
                {"staff::001": [np.ones(512, dtype=np.float32)]},
                object(),
                object(),
                meta,
            ),
    )
    closest_fn = (
            "_shared_closest_centroid"
            if strategy == "centroid"
            else "_shared_closest_candidate"
    )
    monkeypatch.setattr(recognition_worker, closest_fn, closest)

    assert recognition_worker.best_match(np.ones(512, dtype=np.float32)) is None
    assert scans == 1


def test_concurrent_match_and_invalidation_does_not_raise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from local_node import recognition_worker

    vector = np.zeros(512, dtype=np.float32)
    vector[0] = 1
    rows = [
            {
                "people_type": "staff",
                "person_code": str(index),
                "embedding": vector.tolist(),
                "full_name": f"Staff {index}",
            }
            for index in range(4)
    ]
    monkeypatch.setattr(recognition_worker, "MATCH_STRATEGY", "centroid")
    monkeypatch.setattr(
            recognition_worker, "_runtime_config",
            lambda: {"branch_id": "concurrent", "match_threshold": 0.4},
    )
    monkeypatch.setattr(
            recognition_worker.local_db, "get_all_embeddings", lambda _branch: rows,
    )
    recognition_worker.invalidate_cache()

    def run_matches() -> list[dict | None]:
            return [
                recognition_worker.best_match(vector)
                for _ in range(20)
            ]

    def invalidate_repeatedly() -> None:
            for _ in range(8):
                recognition_worker.invalidate_cache()

    with ThreadPoolExecutor(max_workers=8) as pool:
            match_futures = [pool.submit(run_matches) for _ in range(8)]
            invalidator = Thread(target=invalidate_repeatedly)
            invalidator.start()
            results = [future.result() for future in match_futures]
            invalidator.join()

    assert all(len(result) == 20 for result in results)
    assert all(match is not None for result in results for match in result    )
    recognition_worker.invalidate_cache()


def test_runtime_config_reads_disk_only_when_file_changes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    from local_node import config_store, recognition_worker

    config_path = tmp_path / "node_config.json"
    config_path.write_text('{"branch_id":"one"}', encoding="utf-8")
    monkeypatch.setattr(config_store, "CONFIG_PATH", config_path)
    original_load = recognition_worker.load_config
    load_count = 0

    def count_loads():
        nonlocal load_count
        load_count += 1
        return original_load()

    monkeypatch.setattr(recognition_worker, "load_config", count_loads)
    monkeypatch.setattr(recognition_worker, "_config_cache_initialized", False)

    first = recognition_worker._runtime_config()
    second = recognition_worker._runtime_config()
    assert first == second
    assert load_count == 1

    config_path.write_text('{"branch_id":"two","changed":true}', encoding="utf-8")
    assert recognition_worker._runtime_config()["branch_id"] == "two"
    assert load_count == 2
