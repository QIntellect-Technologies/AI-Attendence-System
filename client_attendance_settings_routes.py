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
from client_dashboard_auth import require_client_dashboard_auth
from client_routes_helpers import ok, err, handle, dashboard_org_id

client_attendance_settings_bp = Blueprint(
    "client_attendance_settings", __name__, url_prefix="/api/client"
)


# ─── Designations (owned by a department) ──────────────────────────────────

@client_attendance_settings_bp.route("/departments/<department_id>/designations", methods=["GET"])
@require_client_dashboard_auth
def list_designations(department_id):
    def _run():
        include_inactive = request.args.get("include_inactive", "").lower() in ("1", "true", "yes")
        return ok({"designations": settings_db.list_designations(
            dashboard_org_id(), department_id, include_inactive=include_inactive
        )})
    return handle(_run)


@client_attendance_settings_bp.route("/departments/<department_id>/designations", methods=["POST"])
@require_client_dashboard_auth
def create_designation(department_id):
    def _run():
        return ok({"designation": settings_db.create_designation(
            dashboard_org_id(), department_id, request.get_json(silent=True) or {}
        )}, 201)
    return handle(_run)


@client_attendance_settings_bp.route("/designations/<designation_id>", methods=["PATCH"])
@require_client_dashboard_auth
def update_designation(designation_id):
    def _run():
        return ok({"designation": settings_db.update_designation(
            dashboard_org_id(), designation_id, request.get_json(silent=True) or {}
        )})
    return handle(_run)


@client_attendance_settings_bp.route("/designations/<designation_id>", methods=["DELETE"])
@require_client_dashboard_auth
def deactivate_designation(designation_id):
    def _run():
        settings_db.delete_designation(dashboard_org_id(), designation_id)
        return ok({"status": "inactive"})
    return handle(_run)




# ─── Departments ────────────────────────────────────────────────────────────


@client_attendance_settings_bp.route("/branches/<branch_id>/departments", methods=["GET"])
@require_client_dashboard_auth
def list_departments(branch_id):
    def _run():
        org_id = dashboard_org_id()
        include_inactive = request.args.get("include_inactive", "").lower() in ("1", "true", "yes")
        departments = settings_db.list_departments(org_id, branch_id, include_inactive=include_inactive)
        return ok({"departments": departments})
    return handle(_run)


@client_attendance_settings_bp.route("/branches/<branch_id>/departments", methods=["POST"])
@require_client_dashboard_auth
def create_department(branch_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = dashboard_org_id()
        department = settings_db.create_department(org_id, branch_id, payload)
        return ok({"department": department}, 201)

    return handle(_run)


@client_attendance_settings_bp.route("/departments/<department_id>", methods=["PATCH"])
@require_client_dashboard_auth
def update_department(department_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = dashboard_org_id()
        department = settings_db.update_department(org_id, department_id, payload)
        return ok({"department": department})

    return handle(_run)


@client_attendance_settings_bp.route("/departments/<department_id>", methods=["DELETE"])
@require_client_dashboard_auth
def delete_department(department_id):
    def _run():
        org_id = dashboard_org_id()
        settings_db.delete_department(org_id, department_id)
        return ok({"deleted": True})

    return handle(_run)


@client_attendance_settings_bp.route("/staff/<staff_id>/department", methods=["PATCH"])
@require_client_dashboard_auth
def assign_staff_department(staff_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = dashboard_org_id()
        staff = settings_db.assign_staff_department(org_id, staff_id, payload.get("department_id"))
        return ok({"staff": staff})

    return handle(_run)



# ─── Classes ────────────────────────────────────────────────────────────────

@client_attendance_settings_bp.route("/branches/<branch_id>/classes", methods=["GET"])
@require_client_dashboard_auth
def list_classes(branch_id):
    def _run():
        org_id = dashboard_org_id()
        include_inactive = request.args.get("include_inactive", "").lower() in ("1", "true", "yes")
        return ok({"classes": settings_db.list_classes(org_id, branch_id, include_inactive=include_inactive)})
    return handle(_run)


@client_attendance_settings_bp.route("/branches/<branch_id>/classes", methods=["POST"])
@require_client_dashboard_auth
def create_class(branch_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        return ok({"class": settings_db.create_class(dashboard_org_id(), branch_id, payload)}, 201)
    return handle(_run)


@client_attendance_settings_bp.route("/classes/<class_id>", methods=["PATCH"])
@require_client_dashboard_auth
def update_class(class_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        return ok({"class": settings_db.update_class(dashboard_org_id(), class_id, payload)})
    return handle(_run)


@client_attendance_settings_bp.route("/classes/<class_id>", methods=["DELETE"])
@require_client_dashboard_auth
def delete_class(class_id):
    def _run():
        settings_db.delete_class(dashboard_org_id(), class_id)
        return ok({"deleted": True})
    return handle(_run)


# ─── Sections (owned by a class) ────────────────────────────────────────────

@client_attendance_settings_bp.route("/classes/<class_id>/sections", methods=["GET"])
@require_client_dashboard_auth
def list_sections(class_id):
    def _run():
        include_inactive = request.args.get("include_inactive", "").lower() in ("1", "true", "yes")
        return ok({"sections": settings_db.list_sections(dashboard_org_id(), class_id, include_inactive=include_inactive)})
    return handle(_run)


@client_attendance_settings_bp.route("/classes/<class_id>/sections", methods=["POST"])
@require_client_dashboard_auth
def create_section(class_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        return ok({"section": settings_db.create_section(dashboard_org_id(), class_id, payload)}, 201)
    return handle(_run)


@client_attendance_settings_bp.route("/sections/<section_id>", methods=["PATCH"])
@require_client_dashboard_auth
def update_section(section_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        return ok({"section": settings_db.update_section(dashboard_org_id(), section_id, payload)})
    return handle(_run)


@client_attendance_settings_bp.route("/sections/<section_id>", methods=["DELETE"])
@require_client_dashboard_auth
def deactivate_section(section_id):
    def _run():
        settings_db.delete_section(dashboard_org_id(), section_id)
        return ok({"status": "inactive"})
    return handle(_run)


@client_attendance_settings_bp.route("/students/<student_id>/class", methods=["PATCH"])
@require_client_dashboard_auth
def assign_student_class(student_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = dashboard_org_id()
        student = settings_db.assign_student_class(
            org_id, student_id, payload.get("class_id"), payload.get("section_id")
        )
        return ok({"student": student})
    return handle(_run)


# ─── Capture settings (branch + people_type baseline) ──────────────────────


@client_attendance_settings_bp.route("/branches/<branch_id>/capture-settings", methods=["GET"])
@require_client_dashboard_auth
def list_capture_settings(branch_id):
    """Overview across every people_type for one branch, or branch_id="all"
    for every branch+people_type combination in the org (Global view). Added
    alongside the "all branches" aggregate work — settings_db.list_capture_settings
    already supported this, it just had no route calling it yet."""
    def _run():
        org_id = dashboard_org_id()
        settings = settings_db.list_capture_settings(org_id, branch_id)
        return ok({"capture_settings": settings})

    return handle(_run)


@client_attendance_settings_bp.route(
    "/branches/<branch_id>/capture-settings/<people_type>", methods=["GET"]
)
@require_client_dashboard_auth
def get_capture_settings(branch_id, people_type):
    def _run():
        org_id = dashboard_org_id()
        settings = settings_db.get_capture_settings(org_id, branch_id, people_type)
        return ok({"capture_settings": settings})

    return handle(_run)


@client_attendance_settings_bp.route(
    "/branches/<branch_id>/capture-settings/<people_type>", methods=["PATCH"]
)
@require_client_dashboard_auth
def upsert_capture_settings(branch_id, people_type):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = dashboard_org_id()
        settings = settings_db.upsert_capture_settings(org_id, branch_id, people_type, payload)
        return ok({"capture_settings": settings})

    return handle(_run)


@client_attendance_settings_bp.route(
    "/branches/<branch_id>/default-shift/<people_type>", methods=["PATCH"]
)
@require_client_dashboard_auth
def set_branch_default_shift(branch_id, people_type):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = dashboard_org_id()
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
@require_client_dashboard_auth
def list_manual_instructions(branch_id):
    def _run():
        org_id = dashboard_org_id()
        people_type = request.args.get("people_type")
        staff_id = request.args.get("staff_id")
        instructions = settings_db.list_manual_instructions(
            org_id, branch_id, people_type=people_type, staff_id=staff_id
        )
        return ok({"manual_instructions": instructions})

    return handle(_run)


@client_attendance_settings_bp.route("/branches/<branch_id>/manual-instructions", methods=["POST"])
@require_client_dashboard_auth
def create_manual_instruction(branch_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = dashboard_org_id()
        created_by = payload.get("created_by") or None
        instruction = settings_db.create_manual_instruction(org_id, branch_id, payload, created_by)
        return ok({"manual_instruction": instruction}, 201)

    return handle(_run)


@client_attendance_settings_bp.route("/manual-instructions/<instruction_id>", methods=["DELETE"])
@require_client_dashboard_auth
def delete_manual_instruction(instruction_id):
    def _run():
        org_id = dashboard_org_id()
        # Hard delete: the row is removed outright, not soft-marked, so it
        # never reappears in list_manual_instructions.
        settings_db.delete_manual_instruction(org_id, instruction_id)
        return ok({"deleted": True})

    return handle(_run)