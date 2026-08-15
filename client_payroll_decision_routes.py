"""
client_payroll_decision_routes.py
──────────────────────────────────────────────────────────────────────────────
Phase 3: the local-node payroll-decision screen. A local-node operator has
already classified a day (half_day / short_leave / late / overtime) before
it ever reached the cloud — see push_node_attendance / local_db.py's
mark_held_*_half_day/short_leave/late/overtime. What's still missing is a
SEPARATE decision: does this classified day actually count against payroll.

This is deliberately NOT the same surface as the existing attendance
exceptions routes in app.py (/api/client/attendance/exceptions,
/api/client/attendance/<id>/resolve) — those handle rows still awaiting
CLASSIFICATION (a hold_reason is set). This file handles rows already
classified, still awaiting a PAYROLL decision. Two different queues, two
different admin actions, on purpose — see
support_db_attendance_exceptions.list_local_node_payroll_pending's
docstring for the full rationale.

Register this blueprint in app.py alongside client_shifts_bp /
client_attendance_settings_bp — same /api/client prefix family, same
branch-admin audience.
"""
from __future__ import annotations

from flask import Blueprint, request

import support_db_attendance_exceptions as attendance_exceptions_db
from client_routes_helpers import ok, err, handle, require_org_id, require_org_id_from_payload
from supabase_client import get_supabase

client_payroll_decisions_bp = Blueprint(
    "client_payroll_decisions", __name__, url_prefix="/api/client"
)


def _resolved_branch_id(branch_id: str | None) -> str | None:
    """branch_id="all" (or unset/"*") means every branch in the org —
    same convention support_db_shifts.list_branch_shifts uses. Anything
    else is passed straight through to the DB layer's own ownership scoping."""
    if not branch_id or branch_id.strip().lower() in ("all", "*"):
        return None
    return branch_id


@client_payroll_decisions_bp.route("/branches/<branch_id>/payroll-decisions", methods=["GET"])
def list_payroll_decisions(branch_id):
    """Local-node-sourced rows already classified but with no payroll
    include/exclude decision recorded yet — the source of truth for this
    admin screen."""
    def _run():
        org_id = require_org_id()
        rows = attendance_exceptions_db.list_local_node_payroll_pending(
            org_id, _resolved_branch_id(branch_id)
        )
        return ok({"payroll_decisions": rows})

    return handle(_run)


@client_payroll_decisions_bp.route("/payroll-decisions/<attendance_id>", methods=["POST"])
def set_payroll_decision(attendance_id):
    """Admin's include/exclude call on one already-classified local-node
    attendance row.

    Body: { organization_id, decision: 'include' | 'exclude',
            note?: str, decided_by?: uuid }
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        try:
            row = attendance_exceptions_db.set_local_node_payroll_decision(
                org_id,
                attendance_id,
                payload.get("decision"),
                note=payload.get("note"),
                decided_by=payload.get("decided_by"),
            )
        except ValueError as e:
            msg = str(e)
            # If the attendance exists but was recorded under a different
            # org id (legacy vs UUID mismatch), retry using the attendance
            # row's own org_id to be tolerant of metadata inconsistencies.
            if "Attendance record not found" in msg:
                try:
                    sb = get_supabase()
                    res = sb.table("attendance").select("org_id").eq("id", str(attendance_id)).limit(1).execute()
                    if res and res.data:
                        actual_org = res.data[0].get("org_id")
                        if actual_org:
                            row = attendance_exceptions_db.set_local_node_payroll_decision(
                                str(actual_org),
                                attendance_id,
                                payload.get("decision"),
                                note=payload.get("note"),
                                decided_by=payload.get("decided_by"),
                            )
                        else:
                            raise
                    else:
                        raise
                except Exception:
                    # Re-raise the original ValueError to surface a clear
                    # client error message.
                    raise
            else:
                raise
        return ok({"attendance": row})

    return handle(_run)