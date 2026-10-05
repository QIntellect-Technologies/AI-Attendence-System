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
from client_dashboard_auth import require_client_dashboard_auth
from client_routes_helpers import ok, err, handle, dashboard_org_id

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
@require_client_dashboard_auth
def list_payroll_decisions(branch_id):
    """Local-node-sourced rows already classified but with no payroll
    include/exclude decision recorded yet — the source of truth for this
    admin screen."""
    def _run():
        org_id = dashboard_org_id()
        rows = attendance_exceptions_db.list_local_node_payroll_pending(
            org_id, _resolved_branch_id(branch_id)
        )
        return ok({"payroll_decisions": rows})

    return handle(_run)


@client_payroll_decisions_bp.route("/payroll-decisions/<attendance_id>", methods=["POST"])
@require_client_dashboard_auth
def set_payroll_decision(attendance_id):
    """Admin's include/exclude call on one already-classified local-node
    attendance row.

    Body: { decision: 'include' | 'exclude', note?: str, decided_by?: uuid }
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = dashboard_org_id()
        # org_id is always the verified caller's own org (dashboard_org_id) —
        # no fallback to the attendance row's own org_id. That fallback used
        # to retry the write under whatever org_id the row itself carried,
        # which meant a caller could get their decision applied to another
        # org's attendance record just by knowing/guessing its attendance_id.
        # A genuine legacy-id/UUID metadata mismatch should be a data-cleanup
        # job, not a route that silently switches which org it's writing to.
        row = attendance_exceptions_db.set_local_node_payroll_decision(
            org_id,
            attendance_id,
            payload.get("decision"),
            note=payload.get("note"),
            decided_by=payload.get("decided_by"),
        )
        return ok({"attendance": row})

    return handle(_run)