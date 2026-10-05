from __future__ import annotations

import json
import tempfile
from pathlib import Path
import zipfile
from datetime import datetime, timezone

from local_node.package_import import parse_embedding_package
from local_node import local_db


def _sha256_json(data):
    import hashlib

    payload = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def make_test_package(zip_path: Path, people_type: str = "staff", person_code: str = "TEST001"):
    manifest = {
        "package_id": "test-package-001",
        "branch_label": "test-branch",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "record_count": 1,
        "records": [
            {
                "people_type": people_type,
                "person_code": person_code,
                "full_name": "Test Person",
                "embedding_file": "embeddings/TEST001.json",
                "model_version": "v1",
            }
        ],
    }

    # compute manifest checksum after removing manifest_sha256
    manifest_checksum = _sha256_json(manifest)
    manifest["manifest_sha256"] = manifest_checksum

    embedding_payload = {
        "people_type": people_type,
        "person_code": person_code,
        "full_name": "Test Person",
        "embedding_model": "v1",
        "embeddings": [[0.1 * i for i in range(1, 129)]],
    }
    embedding_checksum = _sha256_json(embedding_payload)
    embedding_payload_with_checksum = {**embedding_payload, "checksum": embedding_checksum}

    with zipfile.ZipFile(zip_path, "w") as z:
        z.writestr("import_manifest.json", json.dumps(manifest, ensure_ascii=False))
        z.writestr("embeddings/TEST001.json", json.dumps(embedding_payload_with_checksum, ensure_ascii=False))


def main():
    tmp = Path(tempfile.gettempdir()) / "test_import_package.zip"
    make_test_package(tmp)
    print("Created test package:", tmp)

    package = parse_embedding_package(tmp)
    print("Parsed package:", package.get("package_id"))

    # import into local DB under branch_id='test-branch'
    result = local_db.import_embedding_package(
        branch_id="test-branch",
        package_id=package["package_id"],
        branch_label=package["branch_label"],
        generated_at=package["generated_at"],
        records=package["records"],
    )
    print("Import result:", result)

    # verify stored embeddings
    rows = local_db.get_all_embeddings("test-branch")
    print(f"Stored embedding rows: {len(rows)}")

    # mark manual attendance for today
    now = datetime.now(timezone.utc).isoformat()
    att = local_db.record_attendance_manual(
        branch_id="test-branch",
        people_type="staff",
        person_code="TEST001",
        staff_name="Test Person",
        confidence=0.99,
        attendance_date=datetime.now().date().isoformat(),
        check_in_marked_at=now,
        check_out_marked_at=None,
    )
    print("Recorded attendance:", att)

    print("Recent attendance:")
    for row in local_db.recent_attendance(10):
        print(row)


if __name__ == "__main__":
    main()
