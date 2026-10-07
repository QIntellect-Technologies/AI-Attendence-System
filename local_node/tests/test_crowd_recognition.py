from __future__ import annotations

import numpy as np
import pytest

from local_node import camera_stream_manager, recognition_worker


def test_idle_detection_rechecks_at_imran_cadence():
    assert camera_stream_manager.IDLE_DETECT_INTERVAL_SECONDS == 0.05


def test_track_assignment_claims_each_existing_track_once():
    state = camera_stream_manager._CameraState(
        camera_id="camera-1",
        camera_name="Camera 1",
        camera_location="",
    )
    state.tracked_faces[1] = {
        "bbox": (100, 100, 150, 150),
        "last_seen": 10.0,
        "matched": True,
    }
    claimed_track_ids: set[int] = set()

    first_track_id, _ = camera_stream_manager.CameraStreamManager._assign_track(
        state, (101, 100, 151, 150), 10.1, claimed_track_ids,
    )
    second_track_id, _ = camera_stream_manager.CameraStreamManager._assign_track(
        state, (103, 101, 153, 151), 10.1, claimed_track_ids,
    )

    assert first_track_id == 1
    assert second_track_id != first_track_id


def test_track_assignment_inherits_recent_track_using_imran_lost_iou():
    state = camera_stream_manager._CameraState(
        camera_id="camera-1",
        camera_name="Camera 1",
        camera_location="",
    )
    state.tracked_faces[1] = {
        "bbox": (100, 100, 150, 150),
        "last_seen": 1.0,
        "matched": True,
    }

    track_id, track = camera_stream_manager.CameraStreamManager._assign_track(
        state, (137, 100, 187, 150), 1.5,
    )

    assert track_id == 1
    assert track["last_seen"] == 1.5


def test_webcam_capture_requests_full_hd_and_reports_negotiated_mode(monkeypatch):
    class FakeCapture:
        def __init__(self):
            self.properties = {
                camera_stream_manager.cv2.CAP_PROP_FRAME_WIDTH: 640,
                camera_stream_manager.cv2.CAP_PROP_FRAME_HEIGHT: 480,
                camera_stream_manager.cv2.CAP_PROP_FPS: 30,
                camera_stream_manager.cv2.CAP_PROP_HW_ACCELERATION: 0,
            }
            self.requested = []

        def isOpened(self):
            return True

        def set(self, prop, value):
            self.requested.append((prop, value))
            self.properties[prop] = value
            return True

        def get(self, prop):
            return self.properties.get(prop, 0)

    capture = FakeCapture()
    monkeypatch.setattr(
        camera_stream_manager.cv2,
        "VideoCapture",
        lambda *_args: capture,
    )
    state = camera_stream_manager._CameraState(
        camera_id="camera-webcam",
        camera_name="Webcam",
        camera_location="",
        camera_type="webcam",
        device_index=0,
    )

    opened = camera_stream_manager.CameraStreamManager._open_capture(state, "")

    assert opened is capture
    assert capture.requested[:2] == [
        (
            camera_stream_manager.cv2.CAP_PROP_FRAME_WIDTH,
            camera_stream_manager.WEBCAM_CAPTURE_WIDTH,
        ),
        (
            camera_stream_manager.cv2.CAP_PROP_FRAME_HEIGHT,
            camera_stream_manager.WEBCAM_CAPTURE_HEIGHT,
        ),
    ]


@pytest.mark.parametrize(
    ("configured_threshold", "expected_threshold"),
    [(None, 0.40), (0.53, 0.53)],
)
def test_best_match_uses_imran_default_and_keeps_explicit_override(
    monkeypatch,
    configured_threshold,
    expected_threshold,
):
    seen_thresholds = []
    monkeypatch.setattr(
        recognition_worker,
        "load_config",
        lambda: {
            "branch_id": "branch-1",
            "match_threshold": configured_threshold,
        },
    )
    monkeypatch.setattr(recognition_worker, "_cached_branch_id", "branch-1")
    monkeypatch.setattr(
        recognition_worker,
        "_cached_candidates",
        {"staff::001": [np.ones(2, dtype=np.float32)]},
    )
    monkeypatch.setattr(recognition_worker, "_cached_prepared", None)
    monkeypatch.setattr(
        recognition_worker,
        "_cached_meta",
        {
            "staff::001": {
                "people_type": "staff",
                "person_code": "001",
                "full_name": "Staff One",
                "department_id": "",
                "class_id": "",
                "section_id": "",
            }
        },
    )

    def match(_embedding, _prepared, *, threshold):
        seen_thresholds.append(threshold)
        return "staff::001", 0.5

    monkeypatch.setattr(recognition_worker, "_shared_best_match", match)

    result = recognition_worker.best_match(np.ones(2, dtype=np.float32))

    assert result is not None
    assert seen_thresholds == [expected_threshold]
