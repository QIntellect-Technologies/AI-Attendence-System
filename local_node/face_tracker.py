from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, MutableMapping, Sequence, TypedDict

from local_node.config import (
    TRACK_ACTIVE_DIST_FACTOR,
    TRACK_ACTIVE_IOU_THRESHOLD,
    TRACK_ACTIVE_MIN_DIST,
    TRACK_LOST_DIST_FACTOR,
    TRACK_LOST_IOU_THRESHOLD,
    TRACK_LOST_MIN_DIST,
    TRACK_MAX_AGE_SECONDS,
    TRACK_UNKNOWN_RETRY_INTERVAL,
)

BoundingBox = tuple[float, float, float, float]


class FaceTrack(TypedDict, total=False):
    id: int
    bbox: BoundingBox
    first_seen: float
    last_seen: float
    matched: bool
    match: dict[str, Any] | None
    last_match_attempt_at: float | None
    last_embedded_at: float | None
    velocity: tuple[float, float]


@dataclass(frozen=True)
class TrackerConfig:
    max_age_seconds: float
    idle_recheck_seconds: float
    prediction_horizon_seconds: float
    prioritize_matched_tracks: bool
    prioritize_iou_for_unmatched: bool
    prioritize_iou_for_lost_tracks: bool
    unmatched_distance_gate: bool
    use_motion_prediction: bool
    reuse_lost_track_id: bool
    matched_iou_threshold: float
    active_iou_threshold: float
    active_distance_factor: float
    active_min_distance: float
    lost_iou_threshold: float | None
    lost_distance_factor: float
    lost_min_distance: float
    lost_min_seconds: float
    lost_distance_multiplier: float
    unknown_retry_interval_seconds: float
    confirmed_skip_seconds: float
    velocity_smoothing_factor: float
    velocity_max_gap_seconds: float

    def __post_init__(self) -> None:
        if not 0 < self.idle_recheck_seconds < self.max_age_seconds:
            raise ValueError(
                "idle_recheck_seconds must be positive and less than max_age_seconds"
            )
        if self.prediction_horizon_seconds < 0:
            raise ValueError("prediction_horizon_seconds must not be negative")
        if not self.velocity_max_gap_seconds >= 0:
            raise ValueError("velocity_max_gap_seconds must not be negative")


LEGACY_TRACKER_CONFIG = TrackerConfig(
    max_age_seconds=2.0,
    idle_recheck_seconds=1.5,
    prediction_horizon_seconds=0.3,
    prioritize_matched_tracks=True,
    prioritize_iou_for_unmatched=True,
    prioritize_iou_for_lost_tracks=False,
    unmatched_distance_gate=False,
    use_motion_prediction=False,
    reuse_lost_track_id=True,
    matched_iou_threshold=0.1,
    active_iou_threshold=0.2,
    active_distance_factor=0.8,
    active_min_distance=35.0,
    lost_iou_threshold=None,
    lost_distance_factor=0.8,
    lost_min_distance=35.0,
    lost_min_seconds=0.15,
    lost_distance_multiplier=1.5,
    unknown_retry_interval_seconds=0.0,
    confirmed_skip_seconds=1.0,
    velocity_smoothing_factor=0.5,
    velocity_max_gap_seconds=1.0,
)

IMRAN_TRACKER_CONFIG = TrackerConfig(
    max_age_seconds=TRACK_MAX_AGE_SECONDS,
    idle_recheck_seconds=1.5,
    prediction_horizon_seconds=0.3,
    prioritize_matched_tracks=False,
    prioritize_iou_for_unmatched=False,
    prioritize_iou_for_lost_tracks=True,
    unmatched_distance_gate=True,
    use_motion_prediction=True,
    reuse_lost_track_id=False,
    matched_iou_threshold=TRACK_ACTIVE_IOU_THRESHOLD,
    active_iou_threshold=TRACK_ACTIVE_IOU_THRESHOLD,
    active_distance_factor=TRACK_ACTIVE_DIST_FACTOR,
    active_min_distance=TRACK_ACTIVE_MIN_DIST,
    lost_iou_threshold=TRACK_LOST_IOU_THRESHOLD,
    lost_distance_factor=TRACK_LOST_DIST_FACTOR,
    lost_min_distance=TRACK_LOST_MIN_DIST,
    lost_min_seconds=0.15,
    lost_distance_multiplier=1.0,
    unknown_retry_interval_seconds=TRACK_UNKNOWN_RETRY_INTERVAL,
    confirmed_skip_seconds=0.6,
    velocity_smoothing_factor=0.5,
    velocity_max_gap_seconds=1.0,
)

TRACK_PROFILE = os.getenv("QINTELLECT_TRACK_PROFILE", "legacy").strip().lower()
if TRACK_PROFILE not in {"legacy", "imran"}:
    raise ValueError(
        "QINTELLECT_TRACK_PROFILE must be 'legacy' or 'imran'; "
        f"got {TRACK_PROFILE!r}"
    )

TRACKER_CONFIGS = {
    "legacy": LEGACY_TRACKER_CONFIG,
    "imran": IMRAN_TRACKER_CONFIG,
}
ACTIVE_TRACKER_CONFIG = TRACKER_CONFIGS[TRACK_PROFILE]


def _center(bbox: BoundingBox) -> tuple[float, float]:
    x1, y1, x2, y2 = bbox
    return (x1 + x2) / 2.0, (y1 + y2) / 2.0


def _iou(first: BoundingBox, second: BoundingBox) -> float:
    ax1, ay1, ax2, ay2 = first
    bx1, by1, bx2, by2 = second
    intersection = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(
        0.0, min(ay2, by2) - max(ay1, by1)
    )
    first_area = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    second_area = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = first_area + second_area - intersection
    return intersection / union if union > 0.0 else 0.0


class FaceTracker:
    """One-to-one face association. Call prune(now) before assign/assign_many.

    Assignment methods do not prune tracks; callers own the pruning cadence.
    """

    def __init__(
        self,
        config: TrackerConfig = ACTIVE_TRACKER_CONFIG,
        tracks: MutableMapping[int, FaceTrack] | None = None,
        next_track_id: int = 0,
    ) -> None:
        self.config = config
        self.tracks: MutableMapping[int, FaceTrack] = tracks if tracks is not None else {}
        self.next_track_id = max(next_track_id, max(self.tracks, default=-1) + 1)

    def prune(self, now: float) -> None:
        stale = [
            track_id
            for track_id, track in self.tracks.items()
            if now - track.get("last_seen", now) > self.config.max_age_seconds
        ]
        for track_id in stale:
            del self.tracks[track_id]

    def assign(
        self,
        bbox: Sequence[float],
        now: float,
        claimed_ids: set[int],
    ) -> tuple[int, FaceTrack]:
        """Assign one box without pruning; call prune(now) before assignment."""
        assignments = self.assign_many([bbox], now, claimed_ids)
        return assignments[0]

    def assign_many(
        self,
        bboxes: Sequence[Sequence[float]],
        now: float,
        claimed_ids: set[int],
    ) -> list[tuple[int, FaceTrack]]:
        """Assign frame boxes best-score-first, without pruning; call prune(now) first."""
        normalized_bboxes = [tuple(float(value) for value in box) for box in bboxes]
        if any(len(box) != 4 for box in normalized_bboxes):
            raise ValueError("Each face bounding box must contain four coordinates")

        assignments: dict[int, tuple[int, FaceTrack]] = {}
        remaining_boxes = set(range(len(normalized_bboxes)))
        available_tracks = {
            track_id: track
            for track_id, track in self.tracks.items()
            if track_id not in claimed_ids
        }

        active_pairs: list[
            tuple[tuple[bool, float, float], BoundingBox, int, int]
        ] = []
        for box_index, bbox in enumerate(normalized_bboxes):
            for track_id, track in available_tracks.items():
                elapsed = now - track.get("last_seen", now)
                if elapsed > self.config.max_age_seconds:
                    continue
                score = self._active_score(bbox, track, elapsed)
                if score is not None:
                    active_pairs.append((score, bbox, box_index, track_id))

        for _, _, box_index, track_id in sorted(active_pairs, reverse=True):
            if box_index not in remaining_boxes or track_id in claimed_ids:
                continue
            track = self.tracks[track_id]
            self._refresh_track(track, normalized_bboxes[box_index], now)
            assignments[box_index] = (track_id, track)
            remaining_boxes.remove(box_index)
            claimed_ids.add(track_id)

        lost_pairs: list[tuple[tuple[float, ...], BoundingBox, int, int]] = []
        for box_index in remaining_boxes:
            bbox = normalized_bboxes[box_index]
            for track_id, track in self.tracks.items():
                if track_id in claimed_ids:
                    continue
                elapsed = now - track.get("last_seen", now)
                if not self._can_inherit(track, elapsed):
                    continue
                score = self._lost_score(bbox, track, elapsed)
                if score is not None:
                    lost_pairs.append((score, bbox, box_index, track_id))

        for _, _, box_index, old_track_id in sorted(lost_pairs, reverse=True):
            if box_index not in remaining_boxes or old_track_id in claimed_ids:
                continue
            old_track = self.tracks[old_track_id]
            if self.config.reuse_lost_track_id:
                self._refresh_track(old_track, normalized_bboxes[box_index], now)
                old_track["last_embedded_at"] = None
                track_id, track = old_track_id, old_track
            else:
                track_id, track = self._new_track(
                    normalized_bboxes[box_index],
                    now,
                    inherited_match=old_track.get("match"),
                    inherited_matched=old_track.get("matched", False),
                )
                del self.tracks[old_track_id]
            assignments[box_index] = (track_id, track)
            remaining_boxes.remove(box_index)
            claimed_ids.add(old_track_id)
            claimed_ids.add(track_id)

        for box_index in sorted(remaining_boxes):
            track_id, track = self._new_track(normalized_bboxes[box_index], now)
            assignments[box_index] = (track_id, track)
            claimed_ids.add(track_id)

        return [assignments[index] for index in range(len(normalized_bboxes))]

    def _active_score(
        self,
        bbox: BoundingBox,
        track: FaceTrack,
        elapsed: float,
    ) -> tuple[bool, float, float] | None:
        track_bbox = track.get("bbox")
        if track_bbox is None:
            return None
        distance = self._distance(bbox, track_bbox)
        score_distance = self._score_distance(bbox, track, elapsed, distance)
        iou = _iou(bbox, track_bbox)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        max_distance = max(
            self.config.active_min_distance,
            max(width, height) * self.config.active_distance_factor,
        )
        matched = self.config.prioritize_matched_tracks and bool(track.get("matched"))
        if matched and (
            iou > self.config.matched_iou_threshold or distance < max_distance
        ):
            return (True, -score_distance, iou)
        distance_gate = self.config.unmatched_distance_gate and distance < max_distance
        if iou > self.config.active_iou_threshold or distance_gate:
            if self.config.prioritize_iou_for_unmatched:
                return (False, iou, -score_distance)
            return (False, -score_distance, iou)
        return None

    def _can_inherit(self, track: FaceTrack, elapsed: float) -> bool:
        return (
            elapsed > self.config.lost_min_seconds
            and elapsed < self.config.max_age_seconds
            and (track.get("matched", False) or track.get("match") is not None)
        )

    def _lost_score(
        self,
        bbox: BoundingBox,
        track: FaceTrack,
        elapsed: float,
    ) -> tuple[float, ...] | None:
        track_bbox = track.get("bbox")
        if track_bbox is None:
            return None
        distance = self._distance(bbox, track_bbox)
        score_distance = self._score_distance(bbox, track, elapsed, distance)
        iou = _iou(bbox, track_bbox)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        max_distance = max(
            self.config.lost_min_distance,
            max(width, height) * self.config.lost_distance_factor,
        ) * self.config.lost_distance_multiplier
        if (
            (
                self.config.lost_iou_threshold is not None
                and iou > self.config.lost_iou_threshold
            )
            or distance < max_distance
        ):
            if self.config.prioritize_iou_for_lost_tracks:
                return (iou, -score_distance, -elapsed)
            return (-distance, -elapsed, iou)
        return None

    def _score_distance(
        self,
        bbox: BoundingBox,
        track: FaceTrack,
        elapsed: float,
        distance: float,
    ) -> float:
        if not self.config.use_motion_prediction:
            return distance
        return self._predicted_distance(bbox, track, elapsed)

    @staticmethod
    def _distance(first: BoundingBox, second: BoundingBox) -> float:
        first_center = _center(first)
        second_center = _center(second)
        return (
            (first_center[0] - second_center[0]) ** 2
            + (first_center[1] - second_center[1]) ** 2
        ) ** 0.5

    def _predicted_distance(
        self,
        bbox: BoundingBox,
        track: FaceTrack,
        elapsed: float,
    ) -> float:
        current_center = _center(track.get("bbox", bbox))
        velocity = track.get("velocity", (0.0, 0.0))
        prediction_seconds = min(
            max(0.0, elapsed),
            self.config.prediction_horizon_seconds,
        )
        predicted = (
            current_center[0] + velocity[0] * prediction_seconds,
            current_center[1] + velocity[1] * prediction_seconds,
        )
        box_center = _center(bbox)
        return ((box_center[0] - predicted[0]) ** 2 + (box_center[1] - predicted[1]) ** 2) ** 0.5

    def _refresh_track(self, track: FaceTrack, bbox: BoundingBox, now: float) -> None:
        previous_bbox = track.get("bbox", bbox)
        previous_center = _center(previous_bbox)
        next_center = _center(bbox)
        elapsed = now - track.get("last_seen", now)
        if 0.01 <= elapsed <= self.config.velocity_max_gap_seconds:
            previous_velocity = track.get("velocity", (0.0, 0.0))
            instantaneous = (
                (next_center[0] - previous_center[0]) / elapsed,
                (next_center[1] - previous_center[1]) / elapsed,
            )
            track["velocity"] = (
                (1 - self.config.velocity_smoothing_factor) * previous_velocity[0]
                + self.config.velocity_smoothing_factor * instantaneous[0],
                (1 - self.config.velocity_smoothing_factor) * previous_velocity[1]
                + self.config.velocity_smoothing_factor * instantaneous[1],
            )
        track["bbox"] = bbox
        track["last_seen"] = now

    def _new_track(
        self,
        bbox: BoundingBox,
        now: float,
        inherited_match: dict[str, Any] | None = None,
        inherited_matched: bool = False,
    ) -> tuple[int, FaceTrack]:
        track_id = self.next_track_id
        self.next_track_id += 1
        track: FaceTrack = {
            "id": track_id,
            "bbox": bbox,
            "first_seen": now,
            "last_seen": now,
            "matched": inherited_matched,
            "match": inherited_match,
            "last_match_attempt_at": None,
            "last_embedded_at": None,
            "velocity": (0.0, 0.0),
        }
        self.tracks[track_id] = track
        return track_id, track
