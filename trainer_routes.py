from __future__ import annotations

import hashlib
import hmac
import os
from pathlib import Path
from typing import Any

from flask import Blueprint, jsonify, request, send_file

from support_db_training_pipeline import (
    TrainingPipelineError,
    claim_training_job,
    complete_training_job,
    fail_training_job,
    list_pending_training_jobs,
    mark_job_training,
    record_trainer_heartbeat,
    resolve_training_video_path,
)

trainer_bp = Blueprint("trainer_bp", __name__, url_prefix="/v1/trainer")


def _json_error(message: str, status: int):
    return jsonify({"success": False, "message": message}), status


def _configured_trainer_secret() -> tuple[str, bool]:
    hashed = os.getenv("TRAINER_API_KEY_HASH", "").strip()
    if hashed:
        return hashed, True
    plain = os.getenv("TRAINER_API_KEY", "").strip()
    return plain, False


def require_trainer() -> str:
    supplied_key = request.headers.get("X-Trainer-Api-Key", "").strip()
    trainer_id = request.headers.get("X-Trainer-Id", "").strip()
    configured, is_hash = _configured_trainer_secret()

    if not configured:
        raise TrainingPipelineError("Trainer API authentication is not configured.", 500)
    if not supplied_key:
        raise TrainingPipelineError("Trainer API key is required.", 401)

    if is_hash:
        supplied_hash = hashlib.sha256(supplied_key.encode("utf-8")).hexdigest()
        valid = hmac.compare_digest(supplied_hash, configured)
    else:
        valid = hmac.compare_digest(supplied_key, configured)

    if not valid:
        raise TrainingPipelineError("Invalid trainer API key.", 401)
    if not trainer_id:
        raise TrainingPipelineError("X-Trainer-Id is required.", 400)
    return trainer_id


@trainer_bp.errorhandler(TrainingPipelineError)
def handle_training_pipeline_error(error: TrainingPipelineError):
    return _json_error(str(error), error.status_code)


@trainer_bp.errorhandler(Exception)
def handle_unexpected_error(error: Exception):
    return _json_error("Trainer API request failed.", 500)


@trainer_bp.post("/heartbeat")
def trainer_heartbeat():
    trainer_id = require_trainer()
    payload: dict[str, Any] = request.get_json(silent=True) or {}
    heartbeat = record_trainer_heartbeat(
        trainer_id=trainer_id,
        hostname=payload.get("hostname"),
        status=str(payload.get("status") or "online"),
        metadata={
            "version": payload.get("version"),
            "platform": payload.get("platform"),
            "queue_status": payload.get("queue_status"),
        },
    )
    return jsonify({"success": True, "trainer": heartbeat})


@trainer_bp.get("/jobs/pending")
def pending_jobs():
    require_trainer()
    limit = request.args.get("limit", "10")
    jobs = list_pending_training_jobs(int(limit))
    return jsonify({"success": True, "jobs": jobs})


@trainer_bp.post("/jobs/<job_id>/claim")
def claim_job(job_id: str):
    trainer_id = require_trainer()
    job = claim_training_job(job_id, trainer_id)
    return jsonify({"success": True, "job": job})


@trainer_bp.post("/jobs/<job_id>/training")
def training_job(job_id: str):
    trainer_id = require_trainer()
    job = mark_job_training(job_id, trainer_id)
    return jsonify({"success": True, "job": job})


@trainer_bp.get("/jobs/<job_id>/video")
def job_video(job_id: str):
    trainer_id = require_trainer()
    job = claim_training_job(job_id, trainer_id)
    path = resolve_training_video_path(job)
    download_name = Path(str(job.get("video_name") or path.name)).name
    return send_file(
        path,
        as_attachment=True,
        download_name=download_name,
        mimetype="application/octet-stream",
        max_age=0,
        conditional=True,
    )


@trainer_bp.post("/jobs/<job_id>/complete")
def complete_job(job_id: str):
    trainer_id = require_trainer()
    payload = request.get_json(silent=True) or {}
    result = complete_training_job(job_id, trainer_id, payload)
    return jsonify({"success": True, **result})


@trainer_bp.post("/jobs/<job_id>/fail")
def fail_job(job_id: str):
    trainer_id = require_trainer()
    payload = request.get_json(silent=True) or {}
    job = fail_training_job(job_id, trainer_id, str(payload.get("error_message") or "Training failed."))
    return jsonify({"success": True, "job": job})
