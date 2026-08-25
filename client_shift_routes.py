"""
client_shift_routes.py
──────────────────────────────────────────────────────────────────────────────
Client Dashboard routes for branch-managed shifts. A branch admin creates/
edits shifts and turns them on/off per people_type. Register this blueprint
in the main Flask app alongside support_bp/tenant_bp.

Every route here is a thin translation layer: pull org_id, hand the payload
to support_db_shifts, wrap the result. All validation — including the
no-overlapping-shifts invariant (support_db_shift_overlap.py) — lives in the
db layer, so the HTTP surface never becomes a second place where the rules
are half-expressed.

Every route here carries @require_client_dashboard_auth and reads org_id
via dashboard_org_id() (client_routes_helpers.py) — resolved from the
verified Client Dashboard token, never from the request itself. This
replaced an earlier require_org_id()/require_org_id_from_payload() pattern
that trusted a client-supplied organization_id with no auth decorator at
all, so an anonymous caller could reach shift-assignment/overlap logic
(including the ShiftConflictError -> 409 path) for any org it named.
"""
from __future__ import annotations

from flask import Blueprint, request

import support_db_shifts as shifts_db
from client_dashboard_auth import require_client_dashboard_auth
from client_routes_helpers import (
    dashboard_org_id as _dashboard_org_id,
    handle as _handle,
    ok as _ok,
)

client_shifts_bp = Blueprint("client_shifts", __name__, url_prefix="/api/client")


def _payload() -> dict:
    return request.get_json(silent=True) or {}


@client_shifts_bp.route("/branches/<branch_id>/shifts", methods=["GET"])
@require_client_dashboard_auth
def list_shifts(branch_id):
    def _run():
        org_id = _dashboard_org_id()
        people_type = request.args.get("people_type")
        shifts = shifts_db.list_branch_shifts(org_id, branch_id, people_type)
        return _ok({"shifts": shifts})

    return _handle(_run)


@client_shifts_bp.route("/branches/<branch_id>/shifts", methods=["POST"])
@require_client_dashboard_auth
def create_shift(branch_id):
    def _run():
        payload = _payload()
        org_id = _dashboard_org_id()
        shift = shifts_db.create_shift(org_id, branch_id, payload)
        # A duty overlap raises and never reaches here (409 via handle()).
        # Grace-tail warnings are non-blocking and ride along with the 201 so
        # the admin sees them without the write being refused.
        return _ok(
            {"shift": shift, "warnings": shift.pop("overlap_warnings", [])}, 201
        )

    return _handle(_run)


@client_shifts_bp.route("/branches/<branch_id>/shifts/<shift_id>", methods=["PATCH"])
@require_client_dashboard_auth
def update_shift(branch_id, shift_id):
    def _run():
        payload = _payload()
        org_id = _dashboard_org_id()
        shift = shifts_db.update_shift(org_id, branch_id, shift_id, payload)
        return _ok({"shift": shift, "warnings": shift.pop("overlap_warnings", [])})

    return _handle(_run)


@client_shifts_bp.route("/branches/<branch_id>/shifts/<shift_id>", methods=["DELETE"])
@require_client_dashboard_auth
def delete_shift(branch_id, shift_id):
    def _run():
        org_id = _dashboard_org_id()
        shifts_db.delete_shift(org_id, branch_id, shift_id)
        return _ok({"deleted": True})

    return _handle(_run)


@client_shifts_bp.route("/staff/<staff_id>/shift", methods=["PATCH"])
@require_client_dashboard_auth
def assign_staff_shift(staff_id):
    def _run():
        payload = _payload()
        org_id = _dashboard_org_id()
        # Grace overrides were already part of assign_staff_shift's signature
        # but no caller ever passed them, so a per-person grace delta sent by
        # the UI was silently dropped. Forwarded explicitly now.
        staff = shifts_db.assign_staff_shift(
            org_id,
            staff_id,
            payload.get("shift_id"),
            check_in_grace_override=payload.get("check_in_grace_override"),
            check_out_grace_override=payload.get("check_out_grace_override"),
        )
        return _ok({
            "staff": staff,
            # Named explicitly so the UI can report the swap ("Evening
            # replaced Morning") instead of a bare success toast that hides
            # which shift the person actually ended up on.
            "assigned_shift": staff.get("assigned_shift"),
            "previous_shift": staff.get("previous_shift"),
        })

    return _handle(_run)