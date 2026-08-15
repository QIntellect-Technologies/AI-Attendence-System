"""
client_field_visits_routes.py
──────────────────────────────────────────────────────────────────────────────
Mobile self-service Visit Plan / Visit endpoints for field staff -- the
"activity layer" counterpart to client_field_attendance_routes.py's "duty
layer" (check-in/check-out). Register this blueprint in app.py alongside
client_field_attendance_bp.

None of these routes ever touch the `attendance` table -- see
support_db_visits.py's module docstring for why that separation is
deliberate. A staff member can have zero visits logged and still be marked
Present for the day off their normal check-in/check-out.

Auth/isolation follows the exact same pattern as client_field_attendance_routes.py:
org_id/staff_id/branch_id come from g.client_staff (verified JWT), never
from the request body.
"""
from __future__ import annotations

from datetime import date

from flask import Blueprint, request, g

from client_staff_auth import require_client_staff_auth
from client_routes_helpers import ok, handle
import support_db_visits as visits_db

client_field_visits_bp = Blueprint(
    "client_field_visits", __name__, url_prefix="/api/field/visits"
)


def _plan_date_from_query() -> str:
    """Defaults to today (server UTC date) when the app doesn't pass one --
    the mobile Visits tab's normal case is always "today."""
    raw = request.args.get("date")
    return raw.strip() if raw else date.today().isoformat()


@client_field_visits_bp.route("/today", methods=["GET"])
@require_client_staff_auth
def get_today_plan():
    """
    Query: ?date=YYYY-MM-DD (optional, defaults to today)

    Returns { plan, stops, visits } RAW -- no computed status/summary, see
    support_db_visits.get_plan_raw's docstring. The app computes per-stop
    status and the completed/skipped/unplanned counts itself
    (visit_plan_service.dart's computeStopStatuses/computeSummary) --
    that's pure arithmetic over data already in this response, no reason
    to pay a server round trip's worth of compute for it, especially on a
    screen that's likely to poll/refresh.

    evidence_mode is NOT returned here -- it no longer needs a live lookup
    on every call. It's pushed to the app once at login/GET /api/staff/me
    (UserModel.visitEvidenceMode), the same caching pattern already used
    for geofenceLat/officeSsid, and refreshed on the same cadence. If that
    session value is ever missing (e.g. an old cached session from before
    this field existed), the app should fall back to 'gps_only' client-side
    rather than this route fetching it as a safety net -- see
    visit_plan_service.dart.
    """
    def _run():
        plan_date = _plan_date_from_query()
        data = visits_db.get_plan_raw(
            org_id=g.client_staff["org_id"],
            staff_id=g.client_staff["id"],
            plan_date=plan_date,
        )
        return ok(data)

    return handle(_run)


@client_field_visits_bp.route("/plan", methods=["POST"])
@require_client_staff_auth
def create_own_plan():
    """
    Body: { "date": "YYYY-MM-DD" (optional, defaults to today) }

    Employee self-planning path -- get_or_create_plan is idempotent, so
    calling this on a date that already has an admin-created plan just
    returns that plan (an employee never overwrites an admin's plan by
    calling this).
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        plan_date = (payload.get("date") or date.today().isoformat()).strip()
        plan = visits_db.get_or_create_plan(
            org_id=g.client_staff["org_id"],
            branch_id=g.client_staff.get("branch_id"),
            staff_id=g.client_staff["id"],
            plan_date=plan_date,
            created_by=g.client_staff["id"],
            created_by_role="self",
        )
        return ok({"plan": plan}, 201)

    return handle(_run)


@client_field_visits_bp.route("/plan/<plan_id>/stops", methods=["POST"])
@require_client_staff_auth
def add_own_stop(plan_id):
    """
    Body: { "location_label": str, "lat"|"latitude": float,
            "lng"|"longitude": float, "radius_meters": int (optional),
            "purpose": str (optional),
            "window_start"|"window_end": "HH:MM" (optional) }
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        stop = visits_db.add_stop(
            org_id=g.client_staff["org_id"],
            plan_id=plan_id,
            payload=payload,
            created_by=g.client_staff["id"],
            created_by_role="self",
        )
        return ok({"stop": stop}, 201)

    return handle(_run)


@client_field_visits_bp.route("/stops/<stop_id>", methods=["PATCH"])
@require_client_staff_auth
def edit_own_stop(stop_id):
    def _run():
        payload = request.get_json(silent=True) or {}
        stop = visits_db.update_stop(g.client_staff["org_id"], stop_id, payload)
        return ok({"stop": stop})

    return handle(_run)


@client_field_visits_bp.route("/stops/<stop_id>", methods=["DELETE"])
@require_client_staff_auth
def delete_own_stop(stop_id):
    def _run():
        visits_db.remove_stop(g.client_staff["org_id"], stop_id)
        return ok({"deleted": True})

    return handle(_run)


@client_field_visits_bp.route("/log", methods=["POST"])
@require_client_staff_auth
def log_visit():
    """
    Body: { "latitude"|"lat": float, "longitude"|"lng": float,
            "plan_stop_id": str (optional -- omit for an unplanned/ad-hoc
              visit),
            "distance_from_stop_meters": float (optional -- on-device
              geofence evaluation against the stop, same trust boundary as
              shift attendance's geofence),
            "photo_url": str (optional -- app uploads the photo separately
              and passes the resulting URL here),
            "note": str (optional),
            "evidence_mode": str (optional -- what the app enforced
              client-side before allowing this call; stored for audit) }

    Always 200/201 -- a visit is never rejected server-side for missing
    evidence, distance, or anything else. See log_visit's docstring in
    support_db_visits.py for why.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        lat = payload.get("latitude", payload.get("lat"))
        lng = payload.get("longitude", payload.get("lng"))
        if lat is None or lng is None:
            raise ValueError("latitude/longitude are required")

        visit = visits_db.log_visit(
            org_id=g.client_staff["org_id"],
            branch_id=g.client_staff.get("branch_id"),
            staff_id=g.client_staff["id"],
            latitude=float(lat),
            longitude=float(lng),
            plan_stop_id=payload.get("plan_stop_id"),
            distance_from_stop_meters=payload.get("distance_from_stop_meters"),
            photo_url=payload.get("photo_url"),
            note=payload.get("note"),
            evidence_mode_recorded=payload.get("evidence_mode") or "gps_only",
            source="mobile_field",
        )
        return ok({"visit": visit}, 201)

    return handle(_run)


@client_field_visits_bp.route("/plans-history", methods=["GET"])
@require_client_staff_auth
def get_plans_history():
    """
    Query: either
      ?month=YYYY-MM               (convenience -- whole calendar month), or
      ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
    Defaults to the current calendar month if nothing is passed.

    Returns { days: [ { date, plan, stops, visits }, ... ] }, newest first.
    This is the History tab's source -- one call covering a whole range,
    each entry shaped like GET /visits/today's single-day response so the
    app can run VisitPlanService.computeSummary/computeStopStatuses on
    each day unmodified (see get_staff_visit_plans_range's docstring).
    Status/date/month filtering (Completed/Unplanned/Incomplete, which
    month is showing) is done on-device against this raw list, the same
    "backend returns raw, app computes" contract as the Today tab.
    """
    def _run():
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
            org_id=g.client_staff["org_id"],
            staff_id=g.client_staff["id"],
            start_date=start_date.strip(),
            end_date=end_date.strip(),
        )
        return ok({"days": days})

    return handle(_run)


@client_field_visits_bp.route("/history", methods=["GET"])
@require_client_staff_auth
def visit_history():
    """Own visit history -- for a simple "past visits" list screen."""
    def _run():
        limit = request.args.get("limit", type=int) or 100
        visits = visits_db.get_staff_visit_history(
            org_id=g.client_staff["org_id"],
            staff_id=g.client_staff["id"],
            limit=limit,
        )
        return ok({"visits": visits})

    return handle(_run)