"""
internal_routes.py
──────────────────────────────────────────────────────────────────────────────
Internal, non-user-facing endpoints triggered by Railway Cron (or any
external scheduler). Never exposed to the Support/Client dashboards or the
local node — auth is a shared secret, not a JWT or node_api_key.
"""
from __future__ import annotations

import hmac
import os

from flask import Blueprint, jsonify, request

import support_db as db

internal_bp = Blueprint("internal", __name__, url_prefix="/v1/internal")


class InternalAuthError(RuntimeError):
    pass


def _require_internal_cron_secret() -> None:
    configured = os.getenv("INTERNAL_CRON_SECRET", "").strip()
    if not configured:
        raise InternalAuthError("INTERNAL_CRON_SECRET is not configured on this deployment.")

    supplied = request.headers.get("X-Internal-Cron-Secret", "").strip()
    if not supplied or not hmac.compare_digest(supplied, configured):
        raise InternalAuthError("Invalid or missing internal cron secret.")


@internal_bp.post("/scheduled/health-check")
def scheduled_health_check():
    """Railway Cron target. Recommended schedule: every 1 minute.

    A 1-minute cadence against a 5-300s configurable threshold means the
    worst-case detection delay is threshold + 60s, which is acceptable for
    an attendance system (this is not a real-time alerting SLA) and keeps
    cron invocation cost negligible.
    """
    try:
        _require_internal_cron_secret()
    except InternalAuthError as exc:
        return jsonify({"success": False, "message": str(exc)}), 401

    try:
        result = db.run_offline_detection_sweep()
        return jsonify({"success": True, **result}), 200
    except Exception as exc:
        return jsonify({"success": False, "message": str(exc)}), 500