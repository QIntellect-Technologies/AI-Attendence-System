from __future__ import annotations

from flask import Blueprint, jsonify, request

import database as legacy_db
import support_db as support_cp_db
from core.tenant_config import build_tenant_config_from_org


tenant_bp = Blueprint("tenant", __name__)


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

    try:
        numeric_org_id = _positive_int(org_id)

        # Support-created orgs are usually Supabase UUID/text ids.
        if org_id and not numeric_org_id:
            org = support_cp_db.get_organization(str(org_id))
        else:
            org = legacy_db.get_organization_by_id(int(numeric_org_id))

        if not org:
            return jsonify({
                "success": False,
                "message": "Organization not found.",
                "error": "Organization not found.",
            }), 404

        config = build_tenant_config_from_org(org)

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