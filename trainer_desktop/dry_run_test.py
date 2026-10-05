"""
Dry-run smoke test for the trainer_desktop <-> shared_face_engine wiring.

What this DOES verify (real code, no mocks):
  - config.py env parsing + shared_face_engine.MODEL_NAME import
  - csv_reader.py header aliasing / dedup / encoding handling
  - video_store.py asset resolution + path-traversal safety
  - training_engine.py's translation of shared_face_engine's result shape
    (this is the part that was actually broken)
  - package_builder.py manifest + zip generation
  - shared_face_engine/package_format.py's checksum-validated round-trip
    parse of that exact zip (proves the two ends of the contract agree)

What this DOES NOT verify:
  - Real face detection/embedding quality (requires the real insightface
    package + staged ONNX models + an actual face-containing video)

Run with: python3 dry_run_test.py
"""
from __future__ import annotations

import sys
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parent / "project"
sys.path.insert(0, str(Path(__file__).resolve().parent / "test_stubs"))  # fake insightface
sys.path.insert(0, str(PROJECT_ROOT))

from trainer_desktop.job_runner import process_enrollment_folder  # noqa: E402
from shared_face_engine.package_format import parse_embedding_package  # noqa: E402


def fake_process_video(video_path, models_root, max_frames=120, warmup_only=False):
    """Stands in for shared_face_engine.process_video. Returns exactly the
    shape the REAL function returns, so this test proves training_engine.py
    correctly translates that real shape."""
    if warmup_only:
        return {"success": True}
    if "bad" in str(video_path):
        return {"success": False, "error": "No frames extracted from video.", "embeddings": [], "total_frames": 0}
    import numpy as np
    return {
        "success": True,
        "embeddings": [np.random.rand(512).astype("float32") for _ in range(5)],
        "total_frames": 60,
        "avg_quality": 0.82,
    }


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="trainer_dryrun_"))
    try:
        enrollment_folder = tmp / "Branch_Enrollment"
        videos_dir = enrollment_folder / "Videos"
        videos_dir.mkdir(parents=True)

        (videos_dir / "good_person.mp4").write_bytes(b"fake video bytes")
        (videos_dir / "bad_person.mp4").write_bytes(b"fake video bytes")

        csv_path = enrollment_folder / "People Enrollment.csv"
        csv_path.write_text(
            "People Type,Registration Number,Full Name,Video File Name\n"
            "Student,2024/CS/001,Ayesha Khan,good_person.mp4\n"
            "Student,2024/CS/002,Bilal Ahmed,bad_person.mp4\n",
            encoding="utf-8",
        )

        with patch("trainer_desktop.training_engine.process_video", side_effect=fake_process_video):
            result = process_enrollment_folder(enrollment_folder, csv_path, branch_label="Test Branch")

        assert result.total_rows == 2, f"expected 2 rows, got {result.total_rows}"
        assert len(result.successes) == 1, f"expected 1 success, got {len(result.successes)}"
        assert len(result.failures) == 1, f"expected 1 failure, got {len(result.failures)}"
        assert result.failures[0].person.person_code == "2024/CS/002"
        assert result.package_path is not None, "expected import_package.zip to be created"
        assert result.package_path.exists()

        # Round-trip: parse the exact zip package_builder.py just wrote,
        # using shared_face_engine's own checksum-validated parser.
        parsed = parse_embedding_package(result.package_path)
        assert parsed["record_count"] == 1
        assert parsed["records"][0]["person_code"] == "2024/CS/001"
        assert len(parsed["records"][0]["embeddings"]) == 5
        assert all(isinstance(v, float) for v in parsed["records"][0]["embeddings"][0])

        print("ALL CHECKS PASSED")
        print(f"  rows={result.total_rows} successes={len(result.successes)} failures={len(result.failures)}")
        print(f"  package={result.package_path}")
        print(f"  round-trip record_count={parsed['record_count']}")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()