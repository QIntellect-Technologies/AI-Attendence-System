from __future__ import annotations

from time import perf_counter

from flask import Blueprint, jsonify, request

import database as legacy_db
import support_db as support_cp_db
from core.tenant_config import build_tenant_config_from_org
from logger_config import get_logger


tenant_bp = Blueprint("tenant", __name__)
logger = get_logger(__name__)


def _positive_int(value):
    try:
        parsed = int(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def _resolve_org_id_from_request():
    """
    Temporary resolver for current project.

    Later this should come from authenticated client JWT/session.
    """
    return (
        request.args.get("organization_id")
        or request.args.get("organizationId")
        or request.args.get("org_id")
        or request.headers.get("X-Organization-Id")
        or request.headers.get("X-Org-Id")
    )


@tenant_bp.route("/api/tenant/config", methods=["GET"])
def get_tenant_config():
    org_id = _resolve_org_id_from_request()

    if not org_id:
        return jsonify({
            "success": False,
            "message": "organization_id is required.",
            "error": "organization_id is required.",
        }), 400

    request_started = perf_counter()
    organization_lookup_ms = None
    config_build_ms = None
    try:
        numeric_org_id = _positive_int(org_id)

        # Support-created orgs are usually Supabase UUID/text ids.
        organization_lookup_started = perf_counter()
        if org_id and not numeric_org_id:
            org = support_cp_db.get_organization(str(org_id))
        else:
            org = legacy_db.get_organization_by_id(int(numeric_org_id))
        organization_lookup_ms = (perf_counter() - organization_lookup_started) * 1000

        if not org:
            return jsonify({
                "success": False,
                "message": "Organization not found.",
                "error": "Organization not found.",
            }), 404

        config_build_started = perf_counter()
        config = build_tenant_config_from_org(org)
        config_build_ms = (perf_counter() - config_build_started) * 1000

        return jsonify({
            "success": True,
            "message": "Tenant config loaded successfully.",
            **config,
        }), 200

    except ValueError as exc:
        return jsonify({
            "success": False,
            "message": str(exc),
            "error": str(exc),
        }), 404

    except Exception as exc:
        return jsonify({
            "success": False,
            "message": "Failed to load tenant config.",
            "error": str(exc),
        }), 500
    finally:
        logger.info(
            "Tenant config request completed for org=%s "
            "organization_lookup_ms=%s config_build_ms=%s total_duration_ms=%.1f",
            org_id,
            f"{organization_lookup_ms:.1f}" if organization_lookup_ms is not None else "n/a",
            f"{config_build_ms:.1f}" if config_build_ms is not None else "n/a",
            (perf_counter() - request_started) * 1000,
        )