"""
client_attendance_settings_routes.py
──────────────────────────────────────────────────────────────────────────────
Client Dashboard routes for dynamic attendance timing configuration:
departments, branch/people_type capture baselines (shift vs simple mode),
half-day leave windows, and staff/department timing overrides.

Register this blueprint in app.py alongside client_shifts_bp — same
/api/client prefix family, same branch-admin audience.
"""
from __future__ import annotations

from flask import Blueprint, request

import support_db_attendance_settings as settings_db
from client_routes_helpers import ok, err, handle, require_org_id, require_org_id_from_payload

client_attendance_settings_bp = Blueprint(
    "client_attendance_settings", __name__, url_prefix="/api/client"
)


# ─── Departments ────────────────────────────────────────────────────────────

@client_attendance_settings_bp.route("/branches/<branch_id>/departments", methods=["GET"])
def list_departments(branch_id):
    def _run():
        org_id = require_org_id()
        include_inactive = request.args.get("include_inactive", "").lower() in ("1", "true", "yes")
        departments = settings_db.list_departments(org_id, branch_id, include_inactive=include_inactive)
        return ok({"departments": departments})

    return handle(_run)


@client_attendance_settings_bp.route("/branches/<branch_id>/departments", methods=["POST"])
def create_department(branch_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        department = settings_db.create_department(org_id, branch_id, payload)
        return ok({"department": department}, 201)

    return handle(_run)


@client_attendance_settings_bp.route("/departments/<department_id>", methods=["PATCH"])
def update_department(department_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        department = settings_db.update_department(org_id, department_id, payload)
        return ok({"department": department})

    return handle(_run)


@client_attendance_settings_bp.route("/departments/<department_id>", methods=["DELETE"])
def delete_department(department_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = str(payload.get("organization_id") or request.args.get("organization_id") or "").strip()
        if not org_id:
            raise ValueError("organization_id is required")
        settings_db.delete_department(org_id, department_id)
        return ok({"deleted": True})

    return handle(_run)


@client_attendance_settings_bp.route("/staff/<staff_id>/department", methods=["PATCH"])
def assign_staff_department(staff_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        staff = settings_db.assign_staff_department(org_id, staff_id, payload.get("department_id"))
        return ok({"staff": staff})

    return handle(_run)


# ─── Capture settings (branch + people_type baseline) ──────────────────────


@client_attendance_settings_bp.route("/branches/<branch_id>/capture-settings", methods=["GET"])
def list_capture_settings(branch_id):
    """Overview across every people_type for one branch, or branch_id="all"
    for every branch+people_type combination in the org (Global view). Added
    alongside the "all branches" aggregate work — settings_db.list_capture_settings
    already supported this, it just had no route calling it yet."""
    def _run():
        org_id = require_org_id()
        settings = settings_db.list_capture_settings(org_id, branch_id)
        return ok({"capture_settings": settings})

    return handle(_run)


@client_attendance_settings_bp.route(
    "/branches/<branch_id>/capture-settings/<people_type>", methods=["GET"]
)
def get_capture_settings(branch_id, people_type):
    def _run():
        org_id = require_org_id()
        settings = settings_db.get_capture_settings(org_id, branch_id, people_type)
        return ok({"capture_settings": settings})

    return handle(_run)


@client_attendance_settings_bp.route(
    "/branches/<branch_id>/capture-settings/<people_type>", methods=["PATCH"]
)
def upsert_capture_settings(branch_id, people_type):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        settings = settings_db.upsert_capture_settings(org_id, branch_id, people_type, payload)
        return ok({"capture_settings": settings})

    return handle(_run)


@client_attendance_settings_bp.route(
    "/branches/<branch_id>/default-shift/<people_type>", methods=["PATCH"]
)
def set_branch_default_shift(branch_id, people_type):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        # Allow clearing shift_id by passing null; commonly callers will send shift_id=None
        shift_id = payload.get("shift_id")
        check_in_grace_override = payload.get("check_in_grace_override")
        check_out_grace_override = payload.get("check_out_grace_override")
        result = settings_db.set_branch_default_shift(
            org_id,
            branch_id,
            people_type,
            shift_id if shift_id is not None else None,
            check_in_grace_override,
            check_out_grace_override,
        )
        return ok({"default_shift": result})

    return handle(_run)


# ─── Manual attendance instructions (admin-created overrides) ──────────────

@client_attendance_settings_bp.route("/branches/<branch_id>/manual-instructions", methods=["GET"])
def list_manual_instructions(branch_id):
    def _run():
        org_id = require_org_id()
        people_type = request.args.get("people_type")
        staff_id = request.args.get("staff_id")
        instructions = settings_db.list_manual_instructions(
            org_id, branch_id, people_type=people_type, staff_id=staff_id
        )
        return ok({"manual_instructions": instructions})

    return handle(_run)


@client_attendance_settings_bp.route("/branches/<branch_id>/manual-instructions", methods=["POST"])
def create_manual_instruction(branch_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        created_by = payload.get("created_by") or None
        instruction = settings_db.create_manual_instruction(org_id, branch_id, payload, created_by)
        return ok({"manual_instruction": instruction}, 201)

    return handle(_run)


@client_attendance_settings_bp.route("/manual-instructions/<instruction_id>", methods=["DELETE"])
def delete_manual_instruction(instruction_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = str(payload.get("organization_id") or request.args.get("organization_id") or "").strip()
        if not org_id:
            raise ValueError("organization_id is required")
        # Hard delete: the row is removed outright, not soft-marked, so it
        # never reappears in list_manual_instructions.
        settings_db.delete_manual_instruction(org_id, instruction_id)
        return ok({"deleted": True})

    return handle(_run)