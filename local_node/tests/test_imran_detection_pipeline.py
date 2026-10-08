from __future__ import annotations

import sys
from types import SimpleNamespace

import numpy as np

from shared_face_engine import embedding


class _FakeFace:
    def __init__(self, *, bbox, kps, det_score):
        self.bbox = bbox
        self.kps = kps
        self.det_score = det_score
        self.embedding = None


class _FakeDetector:
    def __init__(self, bboxes, keypoints):
        self.bboxes = bboxes
        self.keypoints = keypoints
        self.called = False

    def detect(self, frame, *, max_num, metric):
        self.called = True
        assert max_num == 0
        assert metric == "default"
        return self.bboxes, self.keypoints


class _FakeRecognition:
    def __init__(self):
        self.face_boxes = []

    def get(self, _frame, face):
        self.face_boxes.append(tuple(int(value) for value in face.bbox))
        face.embedding = np.ones(4, dtype=np.float32)


def _fake_model():
    bboxes = np.array([
        [10, 10, 40, 40, 0.95],
        [70, 10, 100, 40, 0.90],
    ], dtype=np.float32)
    keypoints = [
        np.ones((5, 2), dtype=np.float32),
        np.ones((5, 2), dtype=np.float32),
    ]
    detector = _FakeDetector(bboxes, keypoints)
    recognition = _FakeRecognition()
    model = SimpleNamespace(
        det_model=detector,
        models={"recognition": recognition},
        get=lambda _frame: (_ for _ in ()).throw(
            AssertionError("Imran-compatible path should not call FaceAnalysis.get")
        ),
    )
    return model, detector, recognition


def _patch_face_class(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "insightface.app.common",
        SimpleNamespace(Face=_FakeFace),
    )


def test_detection_always_uses_scrfd_then_arcface_per_face(monkeypatch, tmp_path):
    model, detector, recognition = _fake_model()
    monkeypatch.setattr(embedding, "get_face_model", lambda _root: model)
    _patch_face_class(monkeypatch)
    frame = np.zeros((120, 120, 3), dtype=np.uint8)

    results = embedding.detect_and_extract_live(frame, tmp_path)

    assert detector.called
    assert recognition.face_boxes == [(10, 10, 40, 40), (70, 10, 100, 40)]
    assert [result["bbox"] for result in results] == [
        (10, 10, 40, 40),
        (70, 10, 100, 40),
    ]
    assert all(result["embedding"].shape == (4,) for result in results)


def test_confirmed_bbox_skips_arcface_but_keeps_detection(monkeypatch, tmp_path):
    model, detector, recognition = _fake_model()
    monkeypatch.setattr(embedding, "get_face_model", lambda _root: model)
    _patch_face_class(monkeypatch)
    frame = np.zeros((120, 120, 3), dtype=np.uint8)

    results = embedding.detect_and_extract_live(
        frame,
        tmp_path,
        skip_bboxes=[(10, 10, 40, 40)],
    )

    assert detector.called
    assert recognition.face_boxes == [(70, 10, 100, 40)]
    assert results[0]["embedding"] is None
    assert results[1]["embedding"].shape == (4,)


def test_low_confidence_and_missing_landmark_faces_are_ignored(monkeypatch, tmp_path):
    model, detector, recognition = _fake_model()
    model.det_model.bboxes[0, 4] = 0.1
    model.det_model.keypoints[1] = None
    monkeypatch.setattr(embedding, "get_face_model", lambda _root: model)
    _patch_face_class(monkeypatch)

    results = embedding.detect_and_extract_live(
        np.zeros((120, 120, 3), dtype=np.uint8),
        tmp_path,
    )

    assert detector.called
    assert recognition.face_boxes == []
    assert results == []


def test_existing_shared_detection_api_keeps_faceanalysis_get_default(
    monkeypatch,
    tmp_path,
):
    model, detector, _recognition = _fake_model()
    expected_face = SimpleNamespace(
        bbox=np.array([1, 2, 30, 40], dtype=np.float32),
        det_score=0.88,
        embedding=np.ones(4, dtype=np.float32),
        kps=np.ones((5, 2), dtype=np.float32),
    )
    get_calls = []

    def get(frame):
        get_calls.append(frame)
        return [expected_face]

    model.get = get
    monkeypatch.setattr(embedding, "get_face_model", lambda _root: model)
    frame = np.zeros((120, 120, 3), dtype=np.uint8)

    results = embedding.detect_and_extract(frame, tmp_path)

    assert len(get_calls) == 1
    assert detector.called is False
    assert results[0]["bbox"] == (1, 2, 30, 40)
    assert results[0]["embedding"] is expected_face.embedding
