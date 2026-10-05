from __future__ import annotations

from pathlib import Path
from typing import Iterable

from trainer_desktop.config import (
    ALLOWED_IMAGE_EXTENSIONS,
    ALLOWED_VIDEO_EXTENSIONS,
    FAIL_ON_MISSING_IMAGE,
    VIDEO_MAX_BYTES,
    VIDEOS_DIR_NAME,
)
from trainer_desktop.models import EnrollmentPerson, ResolvedEnrollmentPerson


class EnrollmentAssetError(RuntimeError):
    pass


def _safe_relative_path(root: Path, relative_value: str) -> Path:
    """
    Safely resolves a user-provided relative path while preventing path traversal.
    """

    value = str(relative_value or "").strip().replace("\\", "/")

    if not value:
        raise EnrollmentAssetError("File path is empty.")

    candidate = (root / value).resolve()
    root = root.resolve()

    try:
        candidate.relative_to(root)
    except ValueError:
        raise EnrollmentAssetError(
            f"Unsafe file path outside enrollment folder: {relative_value}"
        )

    return candidate


def _build_filename_index(
    search_root: Path,
    allowed_extensions: set[str],
) -> dict[str, list[Path]]:
    """
    Creates a filename index so files can be located even if the CSV only
    contains the filename and not the relative path.
    """

    index: dict[str, list[Path]] = {}

    if not search_root.exists():
        return index

    for path in search_root.rglob("*"):
        if not path.is_file():
            continue

        if path.suffix.lower() not in allowed_extensions:
            continue

        index.setdefault(path.name.lower(), []).append(path.resolve())

    return index


def _resolve_named_file(
    *,
    folder_root: Path,
    search_root: Path,
    file_name: str,
    allowed_extensions: set[str],
    index: dict[str, list[Path]],
    label: str,
) -> Path:
    """
    Resolves either:

    - relative path from CSV
    - filename only

    while ensuring only one matching file exists.
    """

    raw = str(file_name or "").strip()

    if not raw:
        raise EnrollmentAssetError(f"{label} filename is empty.")

    # Relative path supplied
    if "/" in raw or "\\" in raw:
        candidate = _safe_relative_path(folder_root, raw)

        if not candidate.exists():
            raise EnrollmentAssetError(f"{label} file not found: {raw}")

        if candidate.suffix.lower() not in allowed_extensions:
            raise EnrollmentAssetError(
                f"Unsupported {label} file extension: {candidate.name}"
            )

        return candidate

    # Filename only
    matches = index.get(raw.lower(), [])

    if not matches:
        raise EnrollmentAssetError(f"{label} file not found: {raw}")

    if len(matches) > 1:
        locations = "\n".join(
            str(path.relative_to(search_root))
            for path in matches[:10]
        )

        raise EnrollmentAssetError(
            f"Multiple {label} files named '{raw}' were found.\n"
            f"Please rename one of them.\n\n"
            f"Locations:\n{locations}"
        )

    return matches[0]


def resolve_enrollment_assets(
    enrollment_folder: Path,
    people: Iterable[EnrollmentPerson],
) -> list[ResolvedEnrollmentPerson]:

    folder_root = enrollment_folder.resolve()
    videos_root = (folder_root / VIDEOS_DIR_NAME).resolve()

    video_index = _build_filename_index(
        videos_root,
        ALLOWED_VIDEO_EXTENSIONS,
    )

    image_index = _build_filename_index(
        folder_root,
        ALLOWED_IMAGE_EXTENSIONS,
    )

    resolved: list[ResolvedEnrollmentPerson] = []

    for person in people:

        video_path = _resolve_named_file(
            folder_root=folder_root,
            search_root=videos_root,
            file_name=person.video_file_name,
            allowed_extensions=ALLOWED_VIDEO_EXTENSIONS,
            index=video_index,
            label="Video",
        )

        size = video_path.stat().st_size

        if size <= 0:
            raise EnrollmentAssetError(
                f"Video file is empty: {video_path.name}"
            )

        if size > VIDEO_MAX_BYTES:
            max_mb = VIDEO_MAX_BYTES // (1024 * 1024)

            raise EnrollmentAssetError(
                f"Video '{video_path.name}' exceeds the maximum "
                f"allowed size of {max_mb} MB."
            )

        profile_image: Path | None = None

        if person.profile_image_file_name:

            try:
                profile_image = _resolve_named_file(
                    folder_root=folder_root,
                    search_root=folder_root,
                    file_name=person.profile_image_file_name,
                    allowed_extensions=ALLOWED_IMAGE_EXTENSIONS,
                    index=image_index,
                    label="Profile image",
                )

            except EnrollmentAssetError:

                if FAIL_ON_MISSING_IMAGE:
                    raise

                profile_image = None

        resolved.append(
            ResolvedEnrollmentPerson(
                person=person,
                video_path=video_path,
                profile_image_path=profile_image,
            )
        )

    return resolved