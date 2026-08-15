from __future__ import annotations

import json
import hashlib
import zipfile
from pathlib import Path
from typing import Any


class PackageImportError(RuntimeError):
    pass


REQUIRED_RECORD_FIELDS = ("people_type", "person_code", "embedding_file")


def _sha256_json(data: Any) -> str:
    payload = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _validate_embedding_vector(vector: Any, record_label: str) -> list[float]:
    if not isinstance(vector, list) or not vector:
        raise PackageImportError(f"Embedding vector is invalid for {record_label}.")

    cleaned: list[float] = []
    for value in vector:
        try:
            cleaned.append(float(value))
        except (TypeError, ValueError) as exc:
            raise PackageImportError(f"Embedding vector contains a non-numeric value for {record_label}.") from exc
    return cleaned


def parse_embedding_package(zip_path: Path) -> dict[str, Any]:
    """Read a trainer_desktop import_package.zip into memory. Validates shape
    but does not touch the database — callers decide whether/how to apply it."""
    if not zipfile.is_zipfile(zip_path):
        raise PackageImportError("File is not a valid zip archive.")

    with zipfile.ZipFile(zip_path, "r") as archive:
        names = set(archive.namelist())
        if "import_manifest.json" not in names:
            raise PackageImportError("Package is missing import_manifest.json — not a trainer_desktop package.")

        manifest = json.loads(archive.read("import_manifest.json"))
        manifest_checksum = str(manifest.pop("manifest_sha256", "") or "")
        if not manifest_checksum:
            raise PackageImportError("Package manifest is missing manifest_sha256.")
        if _sha256_json(manifest) != manifest_checksum:
            raise PackageImportError("Package manifest checksum does not match its contents.")

        package_id = str(manifest.get("package_id") or "").strip()
        if not package_id:
            raise PackageImportError("Package manifest is missing package_id.")

        records_meta = manifest.get("records") or []
        if not isinstance(records_meta, list) or not records_meta:
            raise PackageImportError("Package manifest has no records.")
        if int(manifest.get("record_count") or 0) != len(records_meta):
            raise PackageImportError("Package record_count does not match the embedded record list.")

        records: list[dict[str, Any]] = []
        for meta in records_meta:
            missing = [field for field in REQUIRED_RECORD_FIELDS if not meta.get(field)]
            if missing:
                raise PackageImportError(f"Record missing required field(s): {', '.join(missing)}")

            embedding_file = str(meta["embedding_file"])
            if embedding_file not in names:
                raise PackageImportError(f"Embedding file referenced in manifest not found in zip: {embedding_file}")

            embedding_payload = json.loads(archive.read(embedding_file))
            payload_checksum = str(embedding_payload.pop("checksum", "") or "")
            if not payload_checksum:
                raise PackageImportError(f"Embedding file is missing checksum: {embedding_file}")
            if _sha256_json(embedding_payload) != payload_checksum:
                raise PackageImportError(f"Embedding file checksum does not match contents: {embedding_file}")

            if str(embedding_payload.get("people_type") or "") != str(meta["people_type"]):
                raise PackageImportError(f"people_type mismatch for embedding file: {embedding_file}")
            if str(embedding_payload.get("person_code") or "") != str(meta["person_code"]):
                raise PackageImportError(f"person_code mismatch for embedding file: {embedding_file}")
            if str(embedding_payload.get("full_name") or "") != str(meta.get("full_name") or ""):
                raise PackageImportError(f"full_name mismatch for embedding file: {embedding_file}")
            if str(embedding_payload.get("embedding_model") or "") != str(meta.get("model_version") or ""):
                raise PackageImportError(f"model_version mismatch for embedding file: {embedding_file}")

            embeddings = embedding_payload.get("embeddings")
            if not isinstance(embeddings, list) or not embeddings:
                raise PackageImportError(f"No embeddings found for {meta.get('person_code')}")

            normalized_embeddings = [
                _validate_embedding_vector(embedding, f"{meta.get('people_type')}:{meta.get('person_code')}")
                for embedding in embeddings
            ]

            records.append({
                "people_type": str(meta["people_type"]),
                "person_code": str(meta["person_code"]),
                "full_name": str(meta.get("full_name") or ""),
                "embeddings": normalized_embeddings,
                "model_version": str(meta.get("model_version") or ""),
            })

        return {
            "package_id": package_id,
            "branch_label": str(manifest.get("branch_label") or ""),
            "generated_at": str(manifest.get("generated_at") or ""),
            "record_count": int(manifest.get("record_count") or len(records)),
            "records": records,
            "source_csv_name": str(manifest.get("source_csv_name") or ""),
            "source_csv_sha256": str(manifest.get("source_csv_sha256") or ""),
            "identity_key": str(manifest.get("identity_key") or ""),
            "matching_rule": str(manifest.get("matching_rule") or ""),
            "manifest_sha256": manifest_checksum,
        }