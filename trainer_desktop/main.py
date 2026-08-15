from __future__ import annotations

import argparse
import logging
from pathlib import Path

from trainer_desktop.config import DEFAULT_CSV_NAME
from trainer_desktop.job_runner import process_enrollment_folder

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger(__name__)


def _default_csv_path(enrollment_folder: Path) -> Path:
    return enrollment_folder / DEFAULT_CSV_NAME


def main() -> None:
    parser = argparse.ArgumentParser(description="QIntellect offline enrollment trainer")
    parser.add_argument(
        "--input-folder",
        required=True,
        help="Enrollment folder downloaded from the client's Drive. Must contain People Enrollment.csv and Videos/.",
    )
    parser.add_argument(
        "--csv",
        "--csv-name",
        dest="csv",
        default=None,
        help="Optional CSV path or filename. Defaults to <input-folder>/People Enrollment.csv.",
    )
    parser.add_argument(
        "--branch-label",
        required=True,
        help="Human-readable branch name, e.g. 'Lahore - Main Campus'. Stamped into the "
        "package for operator verification at import time on the local node — has no "
        "effect on matching, which is always people_type + person_code.",
    )
    args = parser.parse_args()

    enrollment_folder = Path(args.input_folder).expanduser().resolve()

    if args.csv:
        csv_path = Path(args.csv).expanduser()
        if not csv_path.is_absolute():
            if not csv_path.exists():
                csv_path = enrollment_folder / csv_path
        csv_path = csv_path.resolve()
    else:
        csv_path = _default_csv_path(enrollment_folder).resolve()

    result = process_enrollment_folder(enrollment_folder, csv_path, branch_label=args.branch_label)

    logger.info("Rows: %s", result.total_rows)
    logger.info("Trained: %s", len(result.successes))
    logger.info("Failed: %s", len(result.failures))
    logger.info("Output folder: %s", result.output_dir)

    if result.package_path:
        logger.info("Import package created: %s", result.package_path)
        logger.info("Next step: upload this zip to the branch's Drive folder, then import it from that branch's local node UI.")
    else:
        raise SystemExit("No import_package.zip created because every row failed. Check Output/errors.csv.")


if __name__ == "__main__":
    main()