from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class EnrollmentPerson:
    row_number: int
    people_type: str
    person_code: str
    full_name: str
    video_file_name: str
    group: str = ""
    subgroup: str = ""
    branch: str = ""
    profile_image_file_name: str = ""
    extra: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ResolvedEnrollmentPerson:
    person: EnrollmentPerson
    video_path: Path
    profile_image_path: Path | None = None


@dataclass(frozen=True)
class TrainingSuccess:
    person: EnrollmentPerson
    embedding_file: str
    asset_file: str | None
    embedding_count: int
    total_frames_processed: int
    avg_quality: float
    training_duration_seconds: float
    model_version: str
    checksum: str


@dataclass(frozen=True)
class TrainingFailure:
    person: EnrollmentPerson
    error: str


@dataclass(frozen=True)
class TrainingRunResult:
    package_path: Path | None
    output_dir: Path
    successes: list[TrainingSuccess]
    failures: list[TrainingFailure]
    total_rows: int


JsonDict = dict[str, Any]
