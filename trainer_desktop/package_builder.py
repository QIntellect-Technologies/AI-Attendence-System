from __future__ import annotations

import csv
import hashlib
import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import zipfile
from trainer_desktop.identity import normalize_identity_component
from trainer_desktop.config import (
    COPY_PROFILE_IMAGES,
    EMBEDDINGS_DIR_NAME,
    OUTPUT_DIR_NAME,
    PEOPLE_ASSETS_DIR_NAME,
)

from trainer_desktop.models import (
    EnrollmentPerson,
    TrainingFailure,
    TrainingSuccess,
)


class PackageBuilderError(RuntimeError):
    """Raised when package creation fails."""


# ============================================================
# Utility Functions
# ============================================================


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
    )


def safe_filename(value: str) -> str:
    value = str(value or "").strip()

    cleaned = "".join(
        c if c.isalnum() or c in {"-", "_", "."}
        else "_"
        for c in value
    )

    cleaned = cleaned.strip("._")

    if cleaned:
        return cleaned

    return uuid.uuid4().hex


def sha256_file(path: Path) -> str:

    digest = hashlib.sha256()

    with path.open("rb") as f:

        while True:

            chunk = f.read(1024 * 1024)

            if not chunk:
                break

            digest.update(chunk)

    return digest.hexdigest()


def sha256_json(data: Any) -> str:

    payload = json.dumps(
        data,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    return hashlib.sha256(payload).hexdigest()


def write_json(
    path: Path,
    payload: Any,
) -> None:

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    path.write_text(
        json.dumps(
            payload,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


# ============================================================
# Assets
# ============================================================


def copy_profile_image(
    profile_image: Path | None,
    assets_dir: Path,
    person: EnrollmentPerson,
) -> str | None:

    if (
        not COPY_PROFILE_IMAGES
        or profile_image is None
        or not profile_image.exists()
    ):
        return None

    extension = profile_image.suffix.lower()

    if not extension:
        extension = ".jpg"

    filename = (
        f"{safe_filename(person.people_type)}"
        "__"
        f"{safe_filename(person.person_code)}"
        f"{extension}"
    )

    destination = assets_dir / filename

    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    shutil.copy2(
        profile_image,
        destination,
    )

    return (
        f"{PEOPLE_ASSETS_DIR_NAME}/{filename}"
    )


# ============================================================
# Output Folder
# ============================================================


def prepare_output_dir(
    enrollment_folder: Path,
) -> Path:

    output_dir = (
        enrollment_folder
        / OUTPUT_DIR_NAME
    )

    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    #
    # Remove stale package files
    #

    stale_files = [

        "import_manifest.json",

        "import_package.zip",

        "training_result.csv",

        "errors.csv",

    ]

    for filename in stale_files:

        file = output_dir / filename

        if file.exists():

            file.unlink()

    #
    # Clean generated folders
    #

    generated_dirs = [

        output_dir / EMBEDDINGS_DIR_NAME,

        output_dir / PEOPLE_ASSETS_DIR_NAME,

    ]

    for folder in generated_dirs:

        if folder.exists():

            shutil.rmtree(folder)

        folder.mkdir(
            parents=True,
            exist_ok=True,
        )

    return output_dir


# ============================================================
# Embedding Writer
# ============================================================


def write_embedding_record(
    output_dir: Path,
    person: EnrollmentPerson,
    result: dict[str, Any],
    profile_image_path: Path | None,
) -> tuple[str, str | None, str]:

    embeddings_dir = (
        output_dir
        / EMBEDDINGS_DIR_NAME
    )

    assets_dir = (
        output_dir
        / PEOPLE_ASSETS_DIR_NAME
    )

    embedding_filename = (
        f"{normalize_identity_component(person.people_type)}"
        "__"
        f"{normalize_identity_component(person.person_code)}"
        ".embedding.json"
    )

    embedding_relative_path = (
        f"{EMBEDDINGS_DIR_NAME}/{embedding_filename}"
    )

    asset_relative_path = copy_profile_image(
        profile_image_path,
        assets_dir,
        person,
    )

    embedding_payload = {

        "people_type": person.people_type,

        "person_code": person.person_code,

        "full_name": person.full_name,

        "group": person.group,

        "subgroup": person.subgroup,

        "branch": person.branch,

        "embedding_model": result["model_version"],

        "embedding_count": result["embedding_count"],

        "total_frames_processed":
            result["total_frames_processed"],

        "avg_quality":
            result["avg_quality"],

        "training_duration_seconds":
            result["training_duration_seconds"],

        #
        # Actual embeddings
        #

        "embeddings":
            result["embeddings"],

    }

    checksum = sha256_json(
        embedding_payload
    )

    embedding_payload["checksum"] = checksum

    write_json(
        embeddings_dir / embedding_filename,
        embedding_payload,
    )

    return (
        embedding_relative_path,
        asset_relative_path,
        checksum,
    )

# ============================================================
# Training Report
# ============================================================

def write_training_result_csv(
    output_dir: Path,
    successes: list[TrainingSuccess],
    failures: list[TrainingFailure],
) -> Path:

    csv_path = output_dir / "training_result.csv"

    fieldnames = [
        "status",
        "people_type",
        "person_code",
        "full_name",
        "embedding_count",
        "total_frames_processed",
        "avg_quality",
        "training_duration_seconds",
        "error",
    ]

    with csv_path.open(
        "w",
        encoding="utf-8-sig",
        newline="",
    ) as file:

        writer = csv.DictWriter(
            file,
            fieldnames=fieldnames,
        )

        writer.writeheader()

        #
        # Successful training rows
        #

        for item in successes:

            writer.writerow(
                {
                    "status": "trained",
                    "people_type": item.person.people_type,
                    "person_code": item.person.person_code,
                    "full_name": item.person.full_name,
                    "embedding_count": item.embedding_count,
                    "total_frames_processed": item.total_frames_processed,
                    "avg_quality": round(item.avg_quality, 4),
                    "training_duration_seconds": round(
                        item.training_duration_seconds,
                        3,
                    ),
                    "error": "",
                }
            )

        #
        # Failed rows
        #

        for item in failures:

            writer.writerow(
                {
                    "status": "failed",
                    "people_type": item.person.people_type,
                    "person_code": item.person.person_code,
                    "full_name": item.person.full_name,
                    "embedding_count": "",
                    "total_frames_processed": "",
                    "avg_quality": "",
                    "training_duration_seconds": "",
                    "error": item.error,
                }
            )

    return csv_path


# ============================================================
# Error Report
# ============================================================


def write_errors_csv(
    output_dir: Path,
    failures: list[TrainingFailure],
) -> Path:

    csv_path = output_dir / "errors.csv"

    with csv_path.open(
        "w",
        encoding="utf-8-sig",
        newline="",
    ) as file:

        writer = csv.DictWriter(
            file,
            fieldnames=[
                "row_number",
                "people_type",
                "person_code",
                "full_name",
                "error",
            ],
        )

        writer.writeheader()

        for item in failures:

            writer.writerow(
                {
                    "row_number": item.person.row_number,
                    "people_type": item.person.people_type,
                    "person_code": item.person.person_code,
                    "full_name": item.person.full_name,
                    "error": item.error,
                }
            )

    return csv_path

def write_manifest_and_zip(
    output_dir: Path,
    successes: list[TrainingSuccess],
    failures: list[TrainingFailure],
    csv_path: Path,
    branch_label: str,
) -> Path | None:
    """
    Creates the final package that will be transferred to the Local Node.

    Package contents:
        import_manifest.json
        training_result.csv
        errors.csv
        embeddings/
            *.embedding.json

    NOTE:
    Profile images are intentionally NOT included because they are only used
    by the trainer for operator reference and are unnecessary for recognition.
    """

    # Always generate reports
    write_training_result_csv(output_dir, successes, failures)
    write_errors_csv(output_dir, failures)

    # Nothing to package
    if not successes:
        return None

    package_id = str(uuid.uuid4())

    manifest = {
        "package_version": 1,
        "package_id": package_id,
        "generated_at": utc_now_iso(),

        # Display only
        "branch_label": branch_label,

        # Source information
        "source_csv_name": csv_path.name,
        "source_csv_sha256": sha256_file(csv_path),

        # Import rules
        "identity_key": "people_type + person_code",
        "matching_rule": (
            "Records are matched only using normalized people_type "
            "and person_code. Full name is informational only."
        ),

        "record_count": len(successes),
        "failed_count": len(failures),

        "records": [],
    }

    for item in successes:
        manifest["records"].append(
            {
                "people_type": item.person.people_type,
                "person_code": item.person.person_code,
                "full_name": item.person.full_name,
                "group": item.person.group,
                "subgroup": item.person.subgroup,
                "embedding_file": item.embedding_file,
                "embedding_count": item.embedding_count,
                "avg_quality": item.avg_quality,
                "model_version": item.model_version,
                "checksum": item.checksum,
            }
        )

    # Manifest checksum
    manifest["manifest_sha256"] = sha256_json(manifest)

    manifest_path = output_dir / "import_manifest.json"
    write_json(manifest_path, manifest)

    package_path = output_dir / "import_package.zip"

    if package_path.exists():
        package_path.unlink()

    with zipfile.ZipFile(
        package_path,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
    ) as archive:

        # Manifest
        archive.write(
            manifest_path,
            arcname="import_manifest.json",
        )

        # Reports
        archive.write(
            output_dir / "training_result.csv",
            arcname="training_result.csv",
        )

        archive.write(
            output_dir / "errors.csv",
            arcname="errors.csv",
        )

        # Embeddings
        embeddings_dir = output_dir / EMBEDDINGS_DIR_NAME

        if embeddings_dir.exists():
            for embedding_file in embeddings_dir.rglob("*.json"):
                archive.write(
                    embedding_file,
                    arcname=str(
                        embedding_file.relative_to(output_dir)
                    ).replace("\\", "/"),
                )

    return package_path