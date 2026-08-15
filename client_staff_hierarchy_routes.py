"""
client_staff_hierarchy_routes.py
──────────────────────────────────────────────────────────────────────────────
Client Dashboard routes for the staff manager hierarchy. Same /api/client
prefix family and branch/org-admin audience as client_shift_routes.py and
client_attendance_settings_routes.py — register this blueprint in app.py
alongside those two (see PATCH_NOTES.md for the exact two lines to add).
"""
from __future__ import annotations

from flask import Blueprint, request

import support_db_hierarchy as hierarchy_db
from client_routes_helpers import ok, handle, require_org_id, require_org_id_from_payload

client_staff_hierarchy_bp = Blueprint(
    "client_staff_hierarchy", __name__, url_prefix="/api/client"
)


@client_staff_hierarchy_bp.route("/staff/<staff_id>/manager", methods=["PATCH"])
def assign_staff_manager(staff_id):
    """
    Body: { "organization_id": "...", "manager_id": "<uuid>|null" }

    manager_id=null clears the manager. Rejects self-assignment and
    manager loops with a 400, same error-envelope contract as every other
    client route. Does NOT touch linked_client_user_id — see
    /staff/<id>/linked-account below, set once on the MANAGER's own
    profile rather than repeated per report.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        staff = hierarchy_db.assign_manager(org_id, staff_id, payload.get("manager_id"))
        return ok({"staff": staff})

    return handle(_run)


@client_staff_hierarchy_bp.route("/staff/<staff_id>/linked-account", methods=["PATCH"])
def set_staff_linked_account(staff_id):
    """
    Sets staff_id's OWN linked dashboard account — call this on a
    manager's profile once, so every report who has this person as their
    manager routes notifications correctly, without re-sending it per
    assignment.

    Body: { "organization_id": "...", "client_user_id": "<uuid>|null" }
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        staff = hierarchy_db.set_linked_client_user(org_id, staff_id, payload.get("client_user_id"))
        return ok({"staff": staff})

    return handle(_run)


@client_staff_hierarchy_bp.route("/staff/<staff_id>/manager-chain", methods=["GET"])
def staff_manager_chain(staff_id):
    """Ordered list from this staff member's immediate manager up to the
    top of the chain — [] if none is assigned."""
    def _run():
        org_id = require_org_id()
        chain = hierarchy_db.get_manager_chain(org_id, staff_id)
        return ok({"manager_chain": chain})

    return handle(_run)


@client_staff_hierarchy_bp.route("/org-users", methods=["GET"])
def list_org_users():
    """Read-only list of this org's client_users (dashboard admin accounts) —
    populates the "linked dashboard account" picker on a manager's profile.
    Query: ?organization_id=..."""
    def _run():
        org_id = require_org_id()
        users = hierarchy_db.list_org_client_users(org_id)
        return ok({"users": users})

    return handle(_run)


@client_staff_hierarchy_bp.route("/staff/<staff_id>/reports", methods=["GET"])
def staff_direct_reports(staff_id):
    """Everyone whose manager_id points at this staff member — one level,
    not the full subtree."""
    def _run():
        org_id = require_org_id()
        reports = hierarchy_db.get_direct_reports(org_id, staff_id)
        return ok({"reports": reports})

    return handle(_run)