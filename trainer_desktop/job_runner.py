from __future__ import annotations

import logging
from pathlib import Path

from trainer_desktop.csv_reader import read_enrollment_csv
from trainer_desktop.models import (
    TrainingFailure,
    TrainingRunResult,
    TrainingSuccess,
)
from trainer_desktop.package_builder import (
    prepare_output_dir,
    write_embedding_record,
    write_manifest_and_zip,
)
from trainer_desktop.training_engine import (
    extract_embeddings,
    validate_engine_configured,
)
from trainer_desktop.video_store import resolve_enrollment_assets

logger = logging.getLogger(__name__)


class EnrollmentTrainingError(RuntimeError):
    """Raised when the enrollment package is invalid."""


def process_enrollment_folder(
    enrollment_folder: Path,
    csv_path: Path,
    branch_label: str,
) -> TrainingRunResult:
    """
    Complete trainer workflow.

    1. Validate enrollment package.
    2. Load CSV.
    3. Resolve videos.
    4. Train every person.
    5. Generate import package.
    """

    enrollment_folder = enrollment_folder.resolve()
    csv_path = csv_path.resolve()

    if not enrollment_folder.exists():
        raise EnrollmentTrainingError(
            f"Enrollment folder not found:\n{enrollment_folder}"
        )

    if not enrollment_folder.is_dir():
        raise EnrollmentTrainingError(
            f"Enrollment folder is not a directory:\n{enrollment_folder}"
        )

    if not csv_path.exists():
        raise EnrollmentTrainingError(
            f"Enrollment CSV not found:\n{csv_path}"
        )

    if not csv_path.is_file():
        raise EnrollmentTrainingError(
            f"CSV path is not a file:\n{csv_path}"
        )

    if not branch_label.strip():
        raise EnrollmentTrainingError(
            "Branch label cannot be empty."
        )

    logger.info("------------------------------------------------")
    logger.info("Starting Training")
    logger.info("Enrollment Folder : %s", enrollment_folder)
    logger.info("CSV               : %s", csv_path.name)
    logger.info("Branch            : %s", branch_label)
    logger.info("------------------------------------------------")

    #
    # Load shared engine once
    #
    validate_engine_configured()

    #
    # Read CSV
    #
    people = read_enrollment_csv(csv_path)

    logger.info(
        "Loaded %d enrollment record(s).",
        len(people),
    )

    #
    # Resolve all videos before training starts.
    #
    resolved_people = resolve_enrollment_assets(
        enrollment_folder,
        people,
    )

    #
    # Prepare Output/
    #
    output_dir = prepare_output_dir(
        enrollment_folder,
    )

    successes: list[TrainingSuccess] = []
    failures: list[TrainingFailure] = []

    #
    # Training loop
    #
    for index, item in enumerate(resolved_people, start=1):

        person = item.person

        logger.info(
            "[%d/%d] %s | %s | %s",
            index,
            len(resolved_people),
            person.people_type,
            person.person_code,
            person.full_name,
        )

        try:

            result = extract_embeddings(
                item.video_path,
            )

            if not result["success"]:

                failures.append(
                    TrainingFailure(
                        person=person,
                        error=result["error_message"],
                    )
                )

                logger.warning(
                    "Training failed: %s",
                    result["error_message"],
                )

                continue

            embedding_file, asset_file, checksum = (
                write_embedding_record(
                    output_dir=output_dir,
                    person=person,
                    result=result,
                    profile_image_path=item.profile_image_path,
                )
            )

            successes.append(
                TrainingSuccess(
                    person=person,
                    embedding_file=embedding_file,
                    asset_file=asset_file,
                    embedding_count=result["embedding_count"],
                    total_frames_processed=result[
                        "total_frames_processed"
                    ],
                    avg_quality=result["avg_quality"],
                    training_duration_seconds=result[
                        "training_duration_seconds"
                    ],
                    model_version=result["model_version"],
                    checksum=checksum,
                )
            )

            logger.info(
                "✓ %s trained successfully (%d embeddings)",
                person.person_code,
                result["embedding_count"],
            )

        except Exception as exc:

            logger.exception(
                "Unexpected training error for %s",
                person.person_code,
            )

            failures.append(
                TrainingFailure(
                    person=person,
                    error=str(exc),
                )
            )

    #
    # Build import package
    #
    package_path = write_manifest_and_zip(
        output_dir=output_dir,
        successes=successes,
        failures=failures,
        csv_path=csv_path,
        branch_label=branch_label,
    )

    logger.info("------------------------------------------------")
    logger.info("Training Finished")
    logger.info("Success : %d", len(successes))
    logger.info("Failed  : %d", len(failures))
    logger.info("Output  : %s", output_dir)

    if package_path:
        logger.info(
            "Package : %s",
            package_path,
        )
    else:
        logger.warning(
            "No import package generated."
        )

    logger.info("------------------------------------------------")

    return TrainingRunResult(
        package_path=package_path,
        output_dir=output_dir,
        successes=successes,
        failures=failures,
        total_rows=len(people),
    )