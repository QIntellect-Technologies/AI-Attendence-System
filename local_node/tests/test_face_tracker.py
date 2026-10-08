from copy import deepcopy
from dataclasses import replace

import numpy as np
import pytest

from local_node import camera_stream_manager
from local_node.face_tracker import (
    IMRAN_TRACKER_CONFIG,
    LEGACY_TRACKER_CONFIG,
    FaceTracker,
    _iou,
)


def _bbox(center_x: float, center_y: float = 100.0) -> tuple[float, float, float, float]:
    return (center_x - 25, center_y - 25, center_x + 25, center_y + 25)


def _small_bbox(center_x: float) -> tuple[float, float, float, float]:
    return (center_x - 10, 90, center_x + 10, 110)


class FakeClock:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def test_assignments_are_one_to_one_and_independent_of_detection_order():
    initial_tracks = {
        1: {"bbox": _bbox(100), "last_seen": 1.0, "matched": True},
        2: {"bbox": _bbox(200), "last_seen": 1.0, "matched": True},
    }
    first_tracker = FaceTracker(LEGACY_TRACKER_CONFIG, deepcopy(initial_tracks), 3)
    second_tracker = FaceTracker(LEGACY_TRACKER_CONFIG, deepcopy(initial_tracks), 3)

    first = first_tracker.assign_many([_bbox(198), _bbox(102)], 1.1, set())
    second = second_tracker.assign_many([_bbox(102), _bbox(198)], 1.1, set())

    assert [track_id for track_id, _ in first] == [2, 1]
    assert [track_id for track_id, _ in second] == [1, 2]

    tied_tracks = {
        1: {"bbox": _bbox(150), "last_seen": 1.0, "matched": True},
        2: {"bbox": _bbox(150), "last_seen": 1.0, "matched": True},
    }
    tie_first = FaceTracker(LEGACY_TRACKER_CONFIG, deepcopy(tied_tracks), 3)
    tie_second = FaceTracker(LEGACY_TRACKER_CONFIG, deepcopy(tied_tracks), 3)
    tied_boxes = [_bbox(149), _bbox(151)]
    tie_assignments = tie_first.assign_many(tied_boxes, 1.1, set())
    reversed_assignments = tie_second.assign_many(tied_boxes[::-1], 1.1, set())
    tie_map = {
        track["bbox"][0] + track["bbox"][2]: track_id
        for track_id, track in tie_assignments
    }
    reversed_map = {
        track["bbox"][0] + track["bbox"][2]: track_id
        for track_id, track in reversed_assignments
    }
    assert tie_map == reversed_map


def test_imran_profile_keeps_identity_through_crossing_paths():
    tracker = FaceTracker(IMRAN_TRACKER_CONFIG)
    left_id, left = tracker.assign(_bbox(100), 0.0, set())
    right_id, right = tracker.assign(_bbox(300), 0.0, set())
    left.update(matched=True, match={"person": "left"})
    right.update(matched=True, match={"person": "right"})

    for frame in range(1, 31):
        now = frame * 0.05
        left_x = 100 + frame * 5
        right_x = 300 - frame * 5
        assignments = tracker.assign_many(
            [_bbox(right_x), _bbox(left_x)], now, set()
        )
        centers_by_id = {
            track_id: (track["bbox"][0] + track["bbox"][2]) / 2
            for track_id, track in assignments
        }
        assert centers_by_id[left_id] == left_x
        assert centers_by_id[right_id] == right_x


def test_neighbor_at_point_six_face_height_is_new_for_imran_and_legacy_reuses():
    # With a tall crop, the center gap exceeds the distance gate and the
    # boxes do not overlap; legacy's wider distance gate still reuses it.
    original = (100.0, 50.0, 150.0, 150.0)
    neighbor = (160.0, 50.0, 210.0, 150.0)
    imran = FaceTracker(IMRAN_TRACKER_CONFIG, {1: {
        "bbox": original, "last_seen": 1.0, "matched": True,
    }}, 2)
    legacy = FaceTracker(LEGACY_TRACKER_CONFIG, {1: {
        "bbox": original, "last_seen": 1.0, "matched": True,
    }}, 2)

    imran_id, _ = imran.assign(neighbor, 1.1, set())
    legacy_id, _ = legacy.assign(neighbor, 1.1, set())

    assert imran_id != 1
    assert legacy_id == 1


def test_unmatched_active_distance_gate_differs_by_profile():
    legacy = FaceTracker(LEGACY_TRACKER_CONFIG, {
        1: {"bbox": _small_bbox(100), "last_seen": 1.0, "matched": False},
    }, 2)
    imran = FaceTracker(IMRAN_TRACKER_CONFIG, {
        1: {"bbox": _small_bbox(100), "last_seen": 1.0, "matched": False},
    }, 2)

    legacy_id, _ = legacy.assign(_small_bbox(130), 1.1, set())
    imran_id, _ = imran.assign(_small_bbox(130), 1.1, set())

    assert legacy_id != 1
    assert imran_id == 1


def test_lost_identity_inherits_by_distance_when_iou_is_zero():
    config = replace(IMRAN_TRACKER_CONFIG, lost_distance_factor=1.1)
    tracker = FaceTracker(
        config,
        {1: {
            "bbox": _bbox(100),
            "last_seen": 1.0,
            "matched": True,
            "match": {"person": "known"},
        }},
        2,
    )

    candidate = _bbox(153)
    assert _iou(candidate, _bbox(100)) == 0
    inherited_id, inherited = tracker.assign(candidate, 1.2, set())

    assert inherited_id != 1
    assert inherited["matched"] is True
    assert inherited["match"] == {"person": "known"}
    assert inherited["last_embedded_at"] is None


def test_lost_identity_inherits_from_iou_sliver_between_point_one_and_point_fifteen():
    original = _bbox(100)
    candidate = _bbox(139.5)
    overlap = _iou(candidate, original)
    assert 0.10 < overlap < 0.15

    tracker = FaceTracker(
        IMRAN_TRACKER_CONFIG,
        {1: {
            "bbox": original,
            "last_seen": 1.0,
            "matched": True,
            "match": {"person": "known"},
        }},
        2,
    )

    inherited_id, inherited = tracker.assign(candidate, 1.2, set())

    assert inherited_id != 1
    assert inherited["match"] == {"person": "known"}
    assert inherited["last_embedded_at"] is None


def test_lost_match_uses_raw_nearness_after_clamped_prediction_horizon():
    tracker = FaceTracker(
        replace(IMRAN_TRACKER_CONFIG, lost_min_distance=100.0),
        {
            1: {
                "bbox": _bbox(150),
                "last_seen": 1.0,
                "matched": True,
                "match": {"person": "raw-nearest"},
                "velocity": (100.0, 0.0),
            },
            2: {
                "bbox": _bbox(190),
                "last_seen": 1.0,
                "matched": True,
                "match": {"person": "predicted-nearest"},
                "velocity": (0.0, 0.0),
            },
        },
        3,
    )

    track_id, track = tracker.assign(_bbox(100), 4.0, set())

    assert track_id not in {1, 2}
    assert track["match"] == {"person": "raw-nearest"}


def test_legacy_lost_inheritance_keeps_the_existing_track_id():
    tracker = FaceTracker(
        LEGACY_TRACKER_CONFIG,
        {1: {
            "bbox": _bbox(100),
            "last_seen": 1.0,
            "matched": True,
            "match": {"person": "known"},
        }},
        2,
    )

    track_id, track = tracker.assign(_bbox(151), 1.2, set())

    assert track_id == 1
    assert track["match"] == {"person": "known"}
    assert track["last_embedded_at"] is None


def test_prune_uses_each_profile_max_age():
    legacy = FaceTracker(
        LEGACY_TRACKER_CONFIG,
        {1: {"bbox": _bbox(100), "last_seen": 1.0}},
    )
    imran = FaceTracker(
        IMRAN_TRACKER_CONFIG,
        {1: {"bbox": _bbox(100), "last_seen": 1.0}},
    )

    legacy.prune(4.0)
    imran.prune(4.0)

    assert not legacy.tracks
    assert 1 in imran.tracks


def test_tracker_config_rejects_idle_interval_at_or_above_max_age():
    with pytest.raises(ValueError, match="idle_recheck_seconds"):
        replace(LEGACY_TRACKER_CONFIG, idle_recheck_seconds=2.0)

    with pytest.raises(ValueError, match="velocity_max_gap_seconds"):
        replace(IMRAN_TRACKER_CONFIG, velocity_max_gap_seconds=-0.1)


def test_prediction_is_clamped_and_short_intervals_do_not_update_velocity():
    tracker = FaceTracker(IMRAN_TRACKER_CONFIG)
    _, track = tracker.assign(_bbox(100), 1.0, set())
    track["velocity"] = (100.0, 0.0)

    assert tracker._predicted_distance(_bbox(130), track, 3.0) == 0.0

    track["velocity"] = (0.0, 0.0)
    tracker._refresh_track(track, _bbox(200), 1.009)
    assert track["velocity"] == (0.0, 0.0)


def test_confirmed_track_survives_skipped_embeddings_without_matching(monkeypatch):
    clock = FakeClock(10.0)
    monkeypatch.setattr(
        camera_stream_manager,
        "ACTIVE_TRACKER_CONFIG",
        LEGACY_TRACKER_CONFIG,
    )
    state = camera_stream_manager._CameraState("cam", "Camera", "", clock=clock)
    state.tracked_faces[1] = {
        "bbox": _bbox(100),
        "last_seen": 9.0,
        "matched": True,
        "match": {"people_type": "staff", "person_code": "1"},
    }
    manager = camera_stream_manager.CameraStreamManager()

    def detect_without_embedding(frame, **kwargs):
        assert frame is None
        assert "skip_bboxes" in kwargs
        return [{"bbox": _bbox(100), "embedding": None}]

    monkeypatch.setattr(
        camera_stream_manager,
        "detect_and_extract",
        detect_without_embedding,
    )
    matches = []

    def unexpected_match(embedding):
        assert embedding is not None
        matches.append(embedding)

    monkeypatch.setattr(camera_stream_manager, "best_match", unexpected_match)
    for _ in range(100):
        manager._detect_and_record(state, None, "branch")

    assert matches == []
    assert len(state.tracked_faces) == 1
    assert state.tracked_faces[1]["last_seen"] == 10.0


def test_confirmed_person_reembeds_at_configured_cadence_for_ninety_seconds(monkeypatch):
    clock = FakeClock(1000.0)
    monkeypatch.setattr(
        camera_stream_manager,
        "ACTIVE_TRACKER_CONFIG",
        IMRAN_TRACKER_CONFIG,
    )
    state = camera_stream_manager._CameraState("cam", "Camera", "", clock=clock)
    manager = camera_stream_manager.CameraStreamManager()
    embedding_times = []
    match_times = []
    attendance_times = []

    def detect_person(_frame, *, skip_bboxes):
        embedding = None
        if not skip_bboxes:
            embedding_times.append(clock.now)
            embedding = np.ones(4, dtype=np.float32)
        return [{
            "bbox": _bbox(100),
            "embedding": embedding,
        }]

    monkeypatch.setattr(camera_stream_manager, "detect_and_extract", detect_person)
    def same_person(_embedding):
        match_times.append(clock.now)
        return {
            "people_type": "staff",
            "person_code": "001",
            "staff_name": "Staff One",
            "confidence": 0.9,
        }

    monkeypatch.setattr(camera_stream_manager, "best_match", same_person)
    monkeypatch.setattr(
        camera_stream_manager.CameraStreamManager,
        "_camera_allows_match",
        staticmethod(lambda _state, _match: True),
    )

    def record_attendance(**_kwargs):
        attendance_times.append(clock.now)
        return {
            "event_type": "locked_by_manual_override",
            "outside_shift": False,
            "sync_status": "pending",
        }

    monkeypatch.setattr(
        camera_stream_manager.local_db,
        "record_attendance_local",
        record_attendance,
    )
    monkeypatch.setattr(camera_stream_manager, "trigger_sync_now", lambda: None)
    monkeypatch.setattr(
        camera_stream_manager.shift_gate,
        "resolve_window_for_debug",
        lambda *_args: {
            "source": "test",
            "effective_window": None,
            "staff_shift_windows_count": 0,
        },
    )
    monkeypatch.setattr(
        camera_stream_manager.shift_gate,
        "load_config",
        lambda: {"shift_windows": {}, "shift_mode_enabled": False},
    )

    for tick in range(451):
        clock.now = 1000.0 + tick * 0.2
        manager._detect_and_record(state, None, "branch")

    embedding_intervals = np.diff(embedding_times)
    attendance_intervals = np.diff(attendance_times)
    cadence = state.face_tracker.config.confirmed_skip_seconds
    assert len(embedding_times) >= 90
    assert np.all(embedding_intervals >= cadence - 0.2 - 1e-6)
    assert np.all(embedding_intervals <= cadence + 0.2 + 1e-6)
    assert len(match_times) == 1
    assert np.all(np.diff(match_times) >= cadence - 0.2 - 1e-6)
    assert len(attendance_times) == 4
    assert np.all(attendance_intervals >= 30.0 - 1e-6)
    assert np.all(attendance_intervals <= 30.0 + cadence + 0.2 + 1e-6)
    assert attendance_times == pytest.approx(
        [1000.0, 1030.0, 1060.0, 1090.0],
        abs=0.2,
    )
    track = next(iter(state.tracked_faces.values()))
    assert track["last_seen"] == 1090.0
    assert track["last_embedded_at"] == embedding_times[-1]


def _mock_recording_path(monkeypatch, clock, attendance_times):
    monkeypatch.setattr(
        camera_stream_manager.CameraStreamManager,
        "_camera_allows_match",
        staticmethod(lambda _state, _match: True),
    )

    def record_attendance(**_kwargs):
        attendance_times.append(clock.now)
        return {
            "event_type": "locked_by_manual_override",
            "outside_shift": False,
            "sync_status": "pending",
        }

    monkeypatch.setattr(
        camera_stream_manager.local_db,
        "record_attendance_local",
        record_attendance,
    )
    monkeypatch.setattr(camera_stream_manager, "trigger_sync_now", lambda: None)
    monkeypatch.setattr(
        camera_stream_manager.shift_gate,
        "resolve_window_for_debug",
        lambda *_args: {
            "source": "test",
            "effective_window": None,
            "staff_shift_windows_count": 0,
        },
    )
    monkeypatch.setattr(
        camera_stream_manager.shift_gate,
        "load_config",
        lambda: {"shift_windows": {}, "shift_mode_enabled": False},
    )


def test_unknown_track_matching_respects_retry_interval(monkeypatch):
    clock = FakeClock(1.0)
    monkeypatch.setattr(
        camera_stream_manager,
        "ACTIVE_TRACKER_CONFIG",
        IMRAN_TRACKER_CONFIG,
    )
    state = camera_stream_manager._CameraState("cam", "Camera", "", clock=clock)
    state.face_tracker.config = replace(
        state.face_tracker.config,
        unknown_retry_interval_seconds=0.1,
    )
    manager = camera_stream_manager.CameraStreamManager()

    def detect_unknown(frame, **kwargs):
        assert frame is None
        assert "skip_bboxes" in kwargs
        return [{
            "bbox": _bbox(100),
            "embedding": np.ones(4, dtype=np.float32),
        }]

    monkeypatch.setattr(
        camera_stream_manager,
        "detect_and_extract",
        detect_unknown,
    )
    match_calls = []

    def no_match(embedding):
        assert embedding.shape == (4,)
        match_calls.append(embedding)

    monkeypatch.setattr(camera_stream_manager, "best_match", no_match)
    for now in (1.0, 1.01, 1.09, 1.11):
        clock.now = now
        manager._detect_and_record(state, None, "branch")

    assert len(match_calls) == 2


def test_quiet_camera_skip_counts_before_and_after_idle_interval(monkeypatch):
    skip_counts = []
    monkeypatch.setattr(
        camera_stream_manager.perf_stats,
        "count",
        lambda _camera_id, stage: skip_counts.append(stage),
    )
    monkeypatch.setattr(
        camera_stream_manager.perf_stats,
        "record",
        lambda *_args, **_kwargs: None,
    )

    def count_skips(interval):
        clock = FakeClock(0.0)
        state = camera_stream_manager._CameraState("quiet-cam", "Quiet", "", clock=clock)
        state.last_full_detect_at = -1.0
        manager = camera_stream_manager.CameraStreamManager()
        frame_count = 0

        def advance_quiet_camera(_state, _frame):
            nonlocal frame_count
            frame_count += 1
            clock.now = frame_count / 12.0
            state.pending_detect_frame = object()
            if frame_count == 120:
                state.stop_event.set()
            return False

        monkeypatch.setattr(camera_stream_manager, "_motion_detected", advance_quiet_camera)
        monkeypatch.setattr(
            camera_stream_manager,
            "IDLE_DETECT_INTERVAL_SECONDS",
            interval,
        )
        monkeypatch.setattr(
            manager,
            "_detect_and_record",
            lambda *_args: None,
        )
        state.pending_detect_frame = object()
        before = len(skip_counts)
        manager._run_detector(state, "branch")
        return len(skip_counts) - before

    before = count_skips(0.05)
    after = count_skips(1.5)

    assert before == 0
    assert after == 113
