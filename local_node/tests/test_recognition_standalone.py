from __future__ import annotations

import numpy as np
import pytest

from local_node import recognition_standalone


def test_detect_faces_and_embeddings_uses_local_node_engine(monkeypatch):
    frame = np.zeros((12, 16, 3), dtype=np.uint8)
    expected = [{"bbox": (1, 2, 8, 10), "conf": 0.9, "embedding": np.ones(4)}]
    received = []
    monkeypatch.setattr(
        recognition_standalone,
        "detect_and_extract",
        lambda supplied_frame: received.append(supplied_frame) or expected,
    )

    result = recognition_standalone.detect_faces_and_embeddings(frame)

    assert result is expected
    assert received == [frame]


def test_detect_faces_and_embeddings_rejects_empty_frames():
    with pytest.raises(ValueError, match="non-empty NumPy image"):
        recognition_standalone.detect_faces_and_embeddings(np.array([]))


def test_analyze_image_reports_detection_metadata_and_saves_annotation(monkeypatch, tmp_path):
    frame = np.zeros((20, 30, 3), dtype=np.uint8)
    output_path = tmp_path / "annotated.jpg"
    monkeypatch.setattr(recognition_standalone.cv2, "imread", lambda _path: frame)
    monkeypatch.setattr(
        recognition_standalone,
        "detect_faces_and_embeddings",
        lambda _frame: [{
            "bbox": (2, 3, 12, 15),
            "conf": 0.91,
            "embedding": np.ones(512, dtype=np.float32),
        }],
    )
    monkeypatch.setattr(recognition_standalone.cv2, "imwrite", lambda *_args: True)

    result = recognition_standalone.analyze_image("person.jpg", output_path)

    assert result["face_count"] == 1
    assert result["faces"] == [{
        "bbox": [2, 3, 12, 15],
        "confidence": 0.91,
        "embedding_dimensions": 512,
    }]
    assert result["annotated_image"] == str(output_path)


def test_analyze_image_errors_on_unreadable_image(monkeypatch):
    monkeypatch.setattr(recognition_standalone.cv2, "imread", lambda _path: None)

    with pytest.raises(ValueError, match="Could not read image"):
        recognition_standalone.analyze_image("missing.jpg")


def test_analyze_image_can_match_detected_face_to_local_enrollment(monkeypatch):
    frame = np.zeros((20, 30, 3), dtype=np.uint8)
    embedding = np.ones(512, dtype=np.float32)
    monkeypatch.setattr(recognition_standalone.cv2, "imread", lambda _path: frame)
    monkeypatch.setattr(
        recognition_standalone,
        "detect_faces_and_embeddings",
        lambda _frame: [{
            "bbox": (2, 3, 12, 15),
            "conf": 0.91,
            "embedding": embedding,
        }],
    )
    received_embeddings = []

    def match_enrolled_identity(supplied_embedding):
        received_embeddings.append(supplied_embedding)
        return {
            "staff_name": "Enrolled Person",
            "people_type": "staff",
            "person_code": "001",
            "confidence": 0.82,
        }

    monkeypatch.setattr(
        recognition_standalone,
        "match_enrolled_identity",
        match_enrolled_identity,
    )

    result = recognition_standalone.analyze_image(
        "person.jpg",
        match_identities=True,
    )

    assert result["identity_matching_enabled"] is True
    assert result["faces"][0]["match"] == {
        "name": "Enrolled Person",
        "people_type": "staff",
        "person_code": "001",
        "similarity": 0.82,
    }
    assert received_embeddings == [embedding]


def test_analyze_image_does_not_match_identities_by_default(monkeypatch):
    frame = np.zeros((20, 30, 3), dtype=np.uint8)
    monkeypatch.setattr(recognition_standalone.cv2, "imread", lambda _path: frame)
    monkeypatch.setattr(
        recognition_standalone,
        "detect_faces_and_embeddings",
        lambda _frame: [{
            "bbox": (2, 3, 12, 15),
            "conf": 0.91,
            "embedding": np.ones(512, dtype=np.float32),
        }],
    )
    monkeypatch.setattr(
        recognition_standalone,
        "match_enrolled_identity",
        lambda _embedding: pytest.fail("Identity matching must be opt-in"),
    )

    result = recognition_standalone.analyze_image("person.jpg")

    assert result["identity_matching_enabled"] is False
    assert "match" not in result["faces"][0]
