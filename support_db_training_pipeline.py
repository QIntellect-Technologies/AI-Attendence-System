from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from supabase_client import get_supabase

TRAINING_JOB_TABLE = os.getenv("TRAINING_JOB_TABLE", "face_training_jobs")
CLOUD_EMBEDDING_TABLE = os.getenv("CLOUD_EMBEDDING_TABLE", "face_embeddings_cloud")
BRANCH_EMBEDDING_VERSION_TABLE = os.getenv("BRANCH_EMBEDDING_VERSION_TABLE", "branch_embedding_versions")
CLIENT_STAFF_TABLE = os.getenv("CLIENT_STAFF_TABLE", "client_staff")
NODE_API_KEYS_TABLE = os.getenv("NODE_API_KEYS_TABLE", "node_api_keys")
TRAINER_HEARTBEAT_TABLE = os.getenv("TRAINER_HEARTBEAT_TABLE", "trainer_heartbeats")
TRAINER_AUDIT_TABLE = os.getenv("TRAINER_AUDIT_TABLE", "trainer_audit_events")
ORGANIZATION_TABLE = os.getenv("ORGANIZATION_TABLE", "organizations")
BRANCH_TABLE = os.getenv("BRANCH_TABLE", "branches")

PROJECT_ROOT = Path(__file__).resolve().parent
TRAINING_UPLOAD_ROOT = Path(os.getenv("TRAINING_UPLOAD_ROOT", "static/training_uploads"))
if not TRAINING_UPLOAD_ROOT.is_absolute():
    TRAINING_UPLOAD_ROOT = PROJECT_ROOT / TRAINING_UPLOAD_ROOT

MAX_TRAINER_JOBS_PER_POLL = max(1, min(int(os.getenv("MAX_TRAINER_JOBS_PER_POLL", "10")), 50))
MAX_EMBEDDINGS_PER_JOB = max(1, int(os.getenv("MAX_EMBEDDINGS_PER_JOB", "256")))
MAX_EMBEDDING_DIM = max(128, int(os.getenv("MAX_EMBEDDING_DIM", "4096")))


class TrainingPipelineError(RuntimeError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_uuid(value: Any, field: str) -> str:
    text = str(value or "").strip()
    try:
        return str(UUID(text))
    except Exception as exc:
        raise TrainingPipelineError(f"Invalid {field}.", 400) from exc


def clean_text(value: Any, *, max_len: int = 120, fallback: str = "") -> str:
    text = str(value or "").strip()
    if len(text) > max_len:
        text = text[:max_len]
    return text or fallback


def _execute(query: Any) -> list[dict[str, Any]]:
    result = query.execute()
    data = result.data or []
    return [dict(row) for row in data if isinstance(row, dict)]


def _single(query: Any) -> dict[str, Any] | None:
    rows = _execute(query.limit(1))
    return rows[0] if rows else None


def log_trainer_event(
    *,
    action: str,
    trainer_id: str | None = None,
    job: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    payload = {
        "trainer_id": clean_text(trainer_id, max_len=160) if trainer_id else None,
        "action": clean_text(action, max_len=80, fallback="unknown"),
        "job_id": job.get("id") if job else None,
        "org_id": job.get("org_id") if job else None,
        "branch_id": job.get("branch_id") if job else None,
        "staff_id": job.get("staff_id") if job else None,
        "metadata": metadata or {},
    }
    try:
        get_supabase().table(TRAINER_AUDIT_TABLE).insert(payload).execute()
    except Exception:
        return


def record_trainer_heartbeat(trainer_id: str, hostname: str | None, status: str, metadata: dict[str, Any]) -> dict[str, Any]:
    safe_trainer_id = clean_text(trainer_id, max_len=160)
    if not safe_trainer_id:
        raise TrainingPipelineError("Trainer id is required.", 400)

    payload = {
        "trainer_id": safe_trainer_id,
        "hostname": clean_text(hostname, max_len=160) if hostname else None,
        "status": clean_text(status, max_len=40, fallback="online"),
        "last_seen_at": utc_now(),
        "metadata": metadata or {},
    }
    rows = _execute(
        get_supabase()
        .table(TRAINER_HEARTBEAT_TABLE)
        .upsert(payload, on_conflict="trainer_id")
    )
    return rows[0] if rows else payload


def get_training_job(job_id: str) -> dict[str, Any]:
    safe_job_id = validate_uuid(job_id, "job_id")
    row = _single(
        get_supabase()
        .table(TRAINING_JOB_TABLE)
        .select("*")
        .eq("id", safe_job_id)
    )
    if not row:
        raise TrainingPipelineError("Training job not found.", 404)
    return row


def list_pending_training_jobs(limit: int) -> list[dict[str, Any]]:
    safe_limit = max(1, min(int(limit or MAX_TRAINER_JOBS_PER_POLL), MAX_TRAINER_JOBS_PER_POLL))
    rows = _execute(
        get_supabase()
        .table(TRAINING_JOB_TABLE)
        .select("id, org_id, branch_id, staff_id, status, storage_path, video_name, created_at, updated_at")
        .eq("status", "pending_training")
        .not_.is_("storage_path", "null")
        .order("created_at", desc=False)
        .limit(safe_limit)
    )

    enriched: list[dict[str, Any]] = []
    for row in rows:
        staff = _single(
            get_supabase()
            .table(CLIENT_STAFF_TABLE)
            .select("id, name, full_name, staff_name, email, branch_id, org_id, organization_id")
            .eq("id", row.get("staff_id"))
        )
        org = _single(
            get_supabase()
            .table(ORGANIZATION_TABLE)
            .select("id, name, attendance_mode")
            .eq("id", row.get("org_id"))
        )
        enriched.append(
            {
                **row,
                "staff_name": (staff or {}).get("name") or (staff or {}).get("full_name") or (staff or {}).get("staff_name"),
                "staff_email": (staff or {}).get("email"),
                "organization_name": (org or {}).get("name"),
                "attendance_mode": (org or {}).get("attendance_mode"),
            }
        )
    return enriched


def claim_training_job(job_id: str, trainer_id: str) -> dict[str, Any]:
    safe_job_id = validate_uuid(job_id, "job_id")
    safe_trainer_id = clean_text(trainer_id, max_len=160)
    if not safe_trainer_id:
        raise TrainingPipelineError("Trainer id is required.", 400)

    rows = _execute(
        get_supabase()
        .table(TRAINING_JOB_TABLE)
        .update(
            {
                "status": "claimed",
                "claimed_by": safe_trainer_id,
                "claimed_at": utc_now(),
                "training_started_at": utc_now(),
                "updated_at": utc_now(),
            }
        )
        .eq("id", safe_job_id)
        .eq("status", "pending_training")
    )
    if not rows:
        job = get_training_job(safe_job_id)
        claimed_by = clean_text(job.get("claimed_by"), max_len=160)
        if job.get("status") in {"claimed", "training"} and hmac.compare_digest(claimed_by, safe_trainer_id):
            return job
        raise TrainingPipelineError("Training job is not claimable.", 409)

    job = rows[0]
    log_trainer_event(action="job_claimed", trainer_id=safe_trainer_id, job=job)
    return job


def mark_job_training(job_id: str, trainer_id: str) -> dict[str, Any]:
    job = ensure_job_claimed_by_trainer(job_id, trainer_id)
    rows = _execute(
        get_supabase()
        .table(TRAINING_JOB_TABLE)
        .update({"status": "training", "updated_at": utc_now()})
        .eq("id", job["id"])
        .eq("claimed_by", trainer_id)
    )
    return rows[0] if rows else job


def ensure_job_claimed_by_trainer(job_id: str, trainer_id: str) -> dict[str, Any]:
    job = get_training_job(job_id)
    safe_trainer_id = clean_text(trainer_id, max_len=160)
    if job.get("status") not in {"claimed", "downloading", "training", "uploading_embeddings"}:
        raise TrainingPipelineError("Training job is not active for completion.", 409)
    if not hmac.compare_digest(clean_text(job.get("claimed_by"), max_len=160), safe_trainer_id):
        raise TrainingPipelineError("Training job is claimed by another trainer.", 403)
    return job


def resolve_training_video_path(job: dict[str, Any]) -> Path:
    raw_path = clean_text(job.get("storage_path"), max_len=500)
    if not raw_path:
        raise TrainingPipelineError("Training job has no storage path.", 409)

    path = Path(raw_path.replace("\\", "/"))
    if path.is_absolute():
        candidate = path.resolve()
    else:
        normalized = raw_path.replace("\\", "/").lstrip("/")
        candidate = (PROJECT_ROOT / normalized).resolve()
        if not candidate.exists():
            candidate = (TRAINING_UPLOAD_ROOT / Path(normalized).name).resolve()

    project = PROJECT_ROOT.resolve()
    upload_root = TRAINING_UPLOAD_ROOT.resolve()
    if project not in candidate.parents and upload_root not in candidate.parents:
        raise TrainingPipelineError("Training video path is outside allowed storage.", 403)
    if not candidate.exists() or not candidate.is_file():
        raise TrainingPipelineError("Training video file was not found.", 404)
    return candidate


def _get_org_attendance_mode(org_id: str) -> str:
    org = _single(
        get_supabase()
        .table(ORGANIZATION_TABLE)
        .select("id, attendance_mode")
        .eq("id", org_id)
    )
    mode = clean_text((org or {}).get("attendance_mode"), max_len=20, fallback="cloud").lower()
    return mode if mode in {"cloud", "local"} else "cloud"


def _validate_embedding_matrix(embeddings: Any) -> list[list[float]]:
    if not isinstance(embeddings, list) or not embeddings:
        raise TrainingPipelineError("Embeddings payload must be a non-empty list.", 400)
    if len(embeddings) > MAX_EMBEDDINGS_PER_JOB:
        raise TrainingPipelineError("Embeddings payload exceeds configured limit.", 413)

    normalized: list[list[float]] = []
    expected_dim: int | None = None
    for row in embeddings:
        if not isinstance(row, list) or not row:
            raise TrainingPipelineError("Each embedding must be a non-empty numeric list.", 400)
        if len(row) > MAX_EMBEDDING_DIM:
            raise TrainingPipelineError("Embedding dimension exceeds configured limit.", 413)
        vector: list[float] = []
        for value in row:
            number = float(value)
            if not (-1000 <= number <= 1000):
                raise TrainingPipelineError("Embedding value is outside allowed numeric range.", 400)
            vector.append(number)
        if expected_dim is None:
            expected_dim = len(vector)
        if len(vector) != expected_dim:
            raise TrainingPipelineError("All embeddings must have the same dimension.", 400)
        normalized.append(vector)
    return normalized


def _branch_embedding_records(org_id: str, branch_id: str) -> list[dict[str, Any]]:
    return _execute(
        get_supabase()
        .table(CLOUD_EMBEDDING_TABLE)
        .select("staff_id, embedding_index, embedding, embedding_dim, model_version, updated_at")
        .eq("org_id", org_id)
        .eq("branch_id", branch_id)
        .order("staff_id")
        .order("embedding_index")
    )


def recompute_branch_embedding_version(org_id: str, branch_id: str, model_version: str | None = None) -> dict[str, Any]:
    rows = _branch_embedding_records(org_id, branch_id)
    staff_ids = sorted({str(row.get("staff_id")) for row in rows if row.get("staff_id")})
    checksum_payload = json.dumps(
        [
            {
                "staff_id": row.get("staff_id"),
                "embedding_index": row.get("embedding_index"),
                "embedding": row.get("embedding"),
                "model_version": row.get("model_version"),
            }
            for row in rows
        ],
        sort_keys=True,
        separators=(",", ":"),
    )
    checksum = hashlib.sha256(checksum_payload.encode("utf-8")).hexdigest()

    existing = _single(
        get_supabase()
        .table(BRANCH_EMBEDDING_VERSION_TABLE)
        .select("*")
        .eq("org_id", org_id)
        .eq("branch_id", branch_id)
    )
    next_version = int((existing or {}).get("version") or 0) + 1
    payload = {
        "org_id": org_id,
        "branch_id": branch_id,
        "version": next_version,
        "checksum": checksum,
        "staff_count": len(staff_ids),
        "embedding_count": len(rows),
        "model_version": model_version or (rows[0].get("model_version") if rows else None),
        "updated_at": utc_now(),
    }
    saved = _execute(
        get_supabase()
        .table(BRANCH_EMBEDDING_VERSION_TABLE)
        .upsert(payload, on_conflict="org_id,branch_id")
    )
    return saved[0] if saved else payload


def complete_training_job(job_id: str, trainer_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    job = ensure_job_claimed_by_trainer(job_id, trainer_id)
    embeddings = _validate_embedding_matrix(payload.get("embeddings"))
    org_id = validate_uuid(job.get("org_id"), "job.org_id")
    branch_id = validate_uuid(job.get("branch_id"), "job.branch_id")
    staff_id = validate_uuid(job.get("staff_id"), "job.staff_id")
    model_version = clean_text(payload.get("model_version"), max_len=120, fallback="unknown")
    attendance_mode = _get_org_attendance_mode(org_id)
    is_fallback_copy = attendance_mode == "local"

    staff = _single(
        get_supabase()
        .table(CLIENT_STAFF_TABLE)
        .select("id, org_id, organization_id, branch_id")
        .eq("id", staff_id)
    )
    if not staff:
        raise TrainingPipelineError("Staff record for training job was not found.", 409)
    staff_org = str(staff.get("org_id") or staff.get("organization_id") or "")
    if staff_org and staff_org != org_id:
        raise TrainingPipelineError("Training job staff does not belong to the job organization.", 409)
    if str(staff.get("branch_id") or "") and str(staff.get("branch_id")) != branch_id:
        raise TrainingPipelineError("Training job staff does not belong to the job branch.", 409)

    get_supabase().table(CLOUD_EMBEDDING_TABLE).delete().eq("org_id", org_id).eq("branch_id", branch_id).eq("staff_id", staff_id).execute()

    rows_to_insert = [
        {
            "org_id": org_id,
            "branch_id": branch_id,
            "staff_id": staff_id,
            "training_job_id": job["id"],
            "embedding_index": index,
            "embedding": vector,
            "embedding_dim": len(vector),
            "model_version": model_version,
            "is_fallback_copy": is_fallback_copy,
            "created_at": utc_now(),
            "updated_at": utc_now(),
        }
        for index, vector in enumerate(embeddings)
    ]
    get_supabase().table(CLOUD_EMBEDDING_TABLE).insert(rows_to_insert).execute()

    try:
        get_supabase().table(CLIENT_STAFF_TABLE).update(
            {
                "face_training_status": "trained",
                "face_trained_at": utc_now(),
                "face_embedding_count": len(embeddings),
                "face_training_job_id": job["id"],
                "updated_at": utc_now(),
            }
        ).eq("id", staff_id).execute()
    except Exception:
        get_supabase().table(CLIENT_STAFF_TABLE).update({"updated_at": utc_now()}).eq("id", staff_id).execute()

    version = recompute_branch_embedding_version(org_id, branch_id, model_version)

    video_deleted_at: str | None = None
    try:
        video_path = resolve_training_video_path(job)
        video_path.unlink(missing_ok=True)
        video_deleted_at = utc_now()
    except Exception:
        video_deleted_at = None

    metrics = {
        "status": "trained",
        "trained_at": utc_now(),
        "embedding_count": len(embeddings),
        "total_frames_processed": int(payload.get("total_frames_processed") or 0),
        "avg_quality": float(payload.get("avg_quality") or 0),
        "training_duration_seconds": float(payload.get("training_duration_seconds") or 0),
        "model_version": model_version,
        "video_deleted_at": video_deleted_at,
        "updated_at": utc_now(),
        "error_message": None,
    }
    updated = _execute(
        get_supabase()
        .table(TRAINING_JOB_TABLE)
        .update(metrics)
        .eq("id", job["id"])
    )
    final_job = updated[0] if updated else {**job, **metrics}
    log_trainer_event(
        action="job_completed",
        trainer_id=trainer_id,
        job=final_job,
        metadata={"embedding_count": len(embeddings), "branch_embedding_version": version.get("version")},
    )
    return {"job": final_job, "branch_embedding_version": version}


def fail_training_job(job_id: str, trainer_id: str, error_message: str) -> dict[str, Any]:
    job = ensure_job_claimed_by_trainer(job_id, trainer_id)
    message = clean_text(error_message, max_len=1000, fallback="Training failed.")
    updated = _execute(
        get_supabase()
        .table(TRAINING_JOB_TABLE)
        .update(
            {
                "status": "failed",
                "failed_at": utc_now(),
                "error_message": message,
                "updated_at": utc_now(),
            }
        )
        .eq("id", job["id"])
    )
    final_job = updated[0] if updated else {**job, "status": "failed", "error_message": message}
    try:
        get_supabase().table(CLIENT_STAFF_TABLE).update(
            {
                "face_training_status": "failed",
                "face_training_error": message,
                "updated_at": utc_now(),
            }
        ).eq("id", job.get("staff_id")).execute()
    except Exception:
        pass
    log_trainer_event(action="job_failed", trainer_id=trainer_id, job=final_job, metadata={"error": message})
    return final_job


def _derive_package_key(node_id: str, node_key_hash: str) -> bytes:
    secret = os.getenv("EMBEDDING_PACKAGE_SECRET", "").strip()
    if len(secret) < 32:
        raise TrainingPipelineError("EMBEDDING_PACKAGE_SECRET must be configured with at least 32 characters.", 500)
    material = f"{secret}:{node_id}:{node_key_hash}".encode("utf-8")
    return hashlib.sha256(material).digest()


def _node_key_hash(raw_key: str) -> str:
    return hashlib.sha256(str(raw_key or "").strip().encode("utf-8")).hexdigest()


def authenticate_node_api_key(raw_key: str) -> dict[str, Any]:
    token = str(raw_key or "").strip()
    if not token:
        raise TrainingPipelineError("Node API key is required.", 401)
    hashed = _node_key_hash(token)
    row = _single(
        get_supabase()
        .table(NODE_API_KEYS_TABLE)
        .select("id, key_hash, org_id, branch_id, node_id, status, revoked_at")
        .eq("key_hash", hashed)
        .eq("status", "active")
    )
    if not row or row.get("revoked_at"):
        raise TrainingPipelineError("Invalid node API key.", 401)
    if not row.get("org_id") or not row.get("branch_id"):
        raise TrainingPipelineError("Node API key is missing scope.", 403)
    return row


def get_branch_embedding_manifest(org_id: str, branch_id: str) -> dict[str, Any]:
    row = _single(
        get_supabase()
        .table(BRANCH_EMBEDDING_VERSION_TABLE)
        .select("*")
        .eq("org_id", org_id)
        .eq("branch_id", branch_id)
    )
    if row:
        return row
    return {
        "org_id": org_id,
        "branch_id": branch_id,
        "version": 0,
        "checksum": "",
        "staff_count": 0,
        "embedding_count": 0,
        "model_version": None,
        "updated_at": None,
    }


def build_encrypted_embedding_package(node: dict[str, Any]) -> dict[str, Any]:
    org_id = validate_uuid(node.get("org_id"), "node.org_id")
    branch_id = validate_uuid(node.get("branch_id"), "node.branch_id")
    manifest = get_branch_embedding_manifest(org_id, branch_id)
    rows = _execute(
        get_supabase()
        .table(CLOUD_EMBEDDING_TABLE)
        .select("staff_id, embedding_index, embedding, embedding_dim, model_version, updated_at")
        .eq("org_id", org_id)
        .eq("branch_id", branch_id)
        .order("staff_id")
        .order("embedding_index")
    )
    staff_rows = _execute(
        get_supabase()
        .table(CLIENT_STAFF_TABLE)
        .select("id, name, full_name, staff_name, email")
        .eq("branch_id", branch_id)
    )
    staff_by_id = {str(row.get("id")): row for row in staff_rows}
    payload = {
        "org_id": org_id,
        "branch_id": branch_id,
        "version": manifest.get("version") or 0,
        "checksum": manifest.get("checksum") or "",
        "generated_at": utc_now(),
        "records": [
            {
                "staff_id": row.get("staff_id"),
                "staff_name": staff_by_id.get(str(row.get("staff_id")), {}).get("name")
                or staff_by_id.get(str(row.get("staff_id")), {}).get("full_name")
                or staff_by_id.get(str(row.get("staff_id")), {}).get("staff_name")
                or str(row.get("staff_id")),
                "embedding_index": row.get("embedding_index"),
                "embedding": row.get("embedding"),
                "embedding_dim": row.get("embedding_dim"),
                "model_version": row.get("model_version"),
            }
            for row in rows
        ],
    }
    plaintext = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    key = _derive_package_key(str(node.get("node_id") or node.get("id")), str(node.get("key_hash")))
    nonce = secrets.token_bytes(12)
    associated_data = f"{org_id}:{branch_id}:{manifest.get('version') or 0}".encode("utf-8")
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, associated_data)
    return {
        "manifest": manifest,
        "encryption": {
            "algorithm": "AES-256-GCM",
            "nonce": base64.b64encode(nonce).decode("ascii"),
            "associated_data": base64.b64encode(associated_data).decode("ascii"),
        },
        "payload": base64.b64encode(ciphertext).decode("ascii"),
    }
