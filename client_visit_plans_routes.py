"""
client_visit_plans_routes.py
──────────────────────────────────────────────────────────────────────────────
Client Dashboard (admin) routes for creating and reviewing field staff Visit
Plans -- the admin-side counterpart to client_field_visits_routes.py's
mobile self-service endpoints. Same underlying support_db_visits.py module,
same visit_plans/visit_plan_stops/visits tables -- an admin-created stop and
an employee-created stop are indistinguishable in storage except for
created_by_role.

Register this blueprint in app.py alongside client_attendance_settings_bp
(same /api/client prefix family, same branch-admin audience, same
require_org_id / require_org_id_from_payload pattern -- no per-route auth
decorator here because that's handled the same way the rest of this file
family handles it).
"""
from __future__ import annotations

from datetime import date

from flask import Blueprint, request

import support_db_visits as visits_db
from client_routes_helpers import ok, handle, require_org_id, require_org_id_from_payload

client_visit_plans_bp = Blueprint(
    "client_visit_plans", __name__, url_prefix="/api/client"
)


# ─── Plans ──────────────────────────────────────────────────────────────

@client_visit_plans_bp.route("/staff/<staff_id>/visit-plan", methods=["GET"])
def get_staff_plan(staff_id):
    """Query: ?date=YYYY-MM-DD (optional, defaults to today). Same raw
    shape the mobile app's /api/field/visits/today returns -- plan + stops
    + visits, no server-computed status/summary (see get_plan_raw's
    docstring) -- so the admin dashboard computes compliance the same way
    the app does, via visitPlanCompliance.ts's mirror of
    visit_plan_service.dart's logic, instead of the backend doing it
    twice for two different frontends."""
    def _run():
        org_id = require_org_id()
        plan_date = request.args.get("date") or date.today().isoformat()
        data = visits_db.get_plan_raw(org_id, staff_id, plan_date)
        return ok(data)

    return handle(_run)


@client_visit_plans_bp.route("/staff/<staff_id>/visit-plan", methods=["POST"])
def create_staff_plan(staff_id):
    """
    Body: { "organization_id": ..., "branch_id": str (optional),
            "date": "YYYY-MM-DD" (optional, defaults to today),
            "created_by": str (optional -- the admin user's id) }

    Idempotent like the mobile self-plan route -- if this staff member
    already has a plan for that date (whichever side created it), this
    just returns the existing one rather than erroring, so an admin
    opening the plan editor doesn't need to check existence first.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        plan_date = (payload.get("date") or date.today().isoformat()).strip()
        plan = visits_db.get_or_create_plan(
            org_id=org_id,
            branch_id=payload.get("branch_id"),
            staff_id=staff_id,
            plan_date=plan_date,
            created_by=payload.get("created_by"),
            created_by_role="admin",
        )
        return ok({"plan": plan}, 201)

    return handle(_run)


@client_visit_plans_bp.route("/branches/<branch_id>/visit-plans", methods=["GET"])
def list_branch_plans(branch_id):
    """Roster-style overview: every staff member's plan for one day on one
    branch. Query: ?date=YYYY-MM-DD (optional, defaults to today).
    branch_id="all" is not supported here (unlike capture-settings) --
    a compliance overview needs per-branch context to be readable; the
    frontend should loop branches if a global view is ever needed."""
    def _run():
        org_id = require_org_id()
        plan_date = request.args.get("date") or date.today().isoformat()
        plans = visits_db.list_plans_for_branch(org_id, branch_id, plan_date)
        return ok({"plans": plans})

    return handle(_run)


# ─── Stops ──────────────────────────────────────────────────────────────

@client_visit_plans_bp.route("/visit-plans/<plan_id>/stops", methods=["POST"])
def add_stop(plan_id):
    """
    Body: { "organization_id": ..., "created_by": str (optional),
            "location_label": str, "lat"|"latitude": float,
            "lng"|"longitude": float, "radius_meters": int (optional),
            "purpose": str (optional),
            "window_start"|"window_end": "HH:MM" (optional) }
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        stop = visits_db.add_stop(
            org_id=org_id,
            plan_id=plan_id,
            payload=payload,
            created_by=payload.get("created_by"),
            created_by_role="admin",
        )
        return ok({"stop": stop}, 201)

    return handle(_run)


@client_visit_plans_bp.route("/visit-plan-stops/<stop_id>", methods=["PATCH"])
def update_stop(stop_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = require_org_id_from_payload(payload)
        stop = visits_db.update_stop(org_id, stop_id, payload)
        return ok({"stop": stop})

    return handle(_run)


@client_visit_plans_bp.route("/visit-plan-stops/<stop_id>", methods=["DELETE"])
def delete_stop(stop_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = str(payload.get("organization_id") or request.args.get("organization_id") or "").strip()
        if not org_id:
            raise ValueError("organization_id is required")
        visits_db.remove_stop(org_id, stop_id)
        return ok({"deleted": True})

    return handle(_run)

@client_visit_plans_bp.route("/staff/<staff_id>/visit-plans-history", methods=["GET"])
def get_staff_plans_history(staff_id):
    """Admin dashboard History view. Query: ?month=YYYY-MM (convenience,
    defaults to current month) or ?start_date=&end_date=. Same
    get_staff_visit_plans_range used by the mobile app's History tab --
    one { date, plan, stops, visits } entry per day, newest first. See
    that function's docstring."""
    def _run():
        org_id = require_org_id()
        month = request.args.get("month")
        if month:
            try:
                year_s, month_s = month.split("-")
                year, mon = int(year_s), int(month_s)
            except (ValueError, AttributeError):
                raise ValueError("month must be in YYYY-MM format")
            start_date = date(year, mon, 1).isoformat()
            next_month = date(year + (mon // 12), (mon % 12) + 1, 1)
            from datetime import timedelta
            end_date = (next_month - timedelta(days=1)).isoformat()
        else:
            start_date = request.args.get("start_date")
            end_date = request.args.get("end_date")
            if not start_date or not end_date:
                today = date.today()
                start_date = today.replace(day=1).isoformat()
                end_date = today.isoformat()

        days = visits_db.get_staff_visit_plans_range(
            org_id=org_id,
            staff_id=staff_id,
            start_date=start_date.strip(),
            end_date=end_date.strip(),
        )
        return ok({"days": days})

    return handle(_run)


# ─── Evidence settings ──────────────────────────────────────────────────
#
# No routes here on purpose -- visit_evidence_mode is set through the
# EXISTING PATCH /api/client/branches/<branch_id>/capture-settings/<people_type>
# route in client_attendance_settings_routes.py. Just include
# "visit_evidence_mode": "gps_only"|"gps_photo"|"gps_photo_note" in that
# request's payload alongside mode/capture_check_out -- see
# support_db_attendance_settings.py's upsert_capture_settings.