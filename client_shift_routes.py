"""
client_shift_routes.py
──────────────────────────────────────────────────────────────────────────────
Client Dashboard routes for branch-managed shifts. A branch admin creates/
edits shifts and turns them on/off per people_type. Register this blueprint
in the main Flask app alongside support_bp/tenant_bp.
"""
from __future__ import annotations

from flask import Blueprint, jsonify, request

import support_db_shifts as shifts_db

client_shifts_bp = Blueprint("client_shifts", __name__, url_prefix="/api/client")

from client_routes_helpers import ok as _ok, err as _err, handle as _handle, require_org_id as _require_org_id

@client_shifts_bp.route("/branches/<branch_id>/shifts", methods=["GET"])
def list_shifts(branch_id):
    def _run():
        org_id = _require_org_id()
        people_type = request.args.get("people_type")
        shifts = shifts_db.list_branch_shifts(org_id, branch_id, people_type)
        return _ok({"shifts": shifts})

    return _handle(_run)


@client_shifts_bp.route("/branches/<branch_id>/shifts", methods=["POST"])
def create_shift(branch_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = str(payload.get("organization_id") or payload.get("org_id") or "").strip()
        if not org_id:
            raise ValueError("organization_id is required")
        shift = shifts_db.create_shift(org_id, branch_id, payload)
        return _ok({"shift": shift}, 201)

    return _handle(_run)


@client_shifts_bp.route("/branches/<branch_id>/shifts/<shift_id>", methods=["PATCH"])
def update_shift(branch_id, shift_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = str(payload.get("organization_id") or payload.get("org_id") or "").strip()
        if not org_id:
            raise ValueError("organization_id is required")
        shift = shifts_db.update_shift(org_id, branch_id, shift_id, payload)
        return _ok({"shift": shift})

    return _handle(_run)


@client_shifts_bp.route("/branches/<branch_id>/shifts/<shift_id>", methods=["DELETE"])
def delete_shift(branch_id, shift_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = str(
            payload.get("organization_id")
            or request.args.get("organization_id")
            or ""
        ).strip()
        if not org_id:
            raise ValueError("organization_id is required")
        shifts_db.delete_shift(org_id, branch_id, shift_id)
        return _ok({"deleted": True})

    return _handle(_run)


@client_shifts_bp.route("/staff/<staff_id>/shift", methods=["PATCH"])
def assign_staff_shift(staff_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = str(payload.get("organization_id") or payload.get("org_id") or "").strip()
        if not org_id:
            raise ValueError("organization_id is required")
        staff = shifts_db.assign_staff_shift(org_id, staff_id, payload.get("shift_id"))
        return _ok({"staff": staff})

    return _handle(_run)