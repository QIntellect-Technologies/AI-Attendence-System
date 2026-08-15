"""
client_staff_overtime_routes.py
──────────────────────────────────────────────────────────────────────────────
Mobile self-service overtime requests for office/field staff (client_staff rows).

Mirrors client_staff_leave_routes.py exactly:

  - Writes into the same Supabase `overtime_requests` table the Client
    Dashboard's Overtime Management screen reads via
    support_db.list_client_overtime_requests / create_client_overtime_request
    (app.py's /api/overtime GET/POST), so a request submitted on mobile
    appears on the dashboard immediately, under the same manager/admin
    scoping (get_team_scope_ids + filter_rows_by_scope) the dashboard
    already applies to that endpoint -- nothing new to build there.

  - The mobile app previously called /api/overtime/request and
    /api/overtime/my. Neither exists anywhere in app.py (grepped) -- every
    mobile overtime request was posting into a 404 and silently vanishing,
    the same class of bug client_staff_leave_routes.py fixed for leave.
    This blueprint is that fix for overtime.

  - org_id/branch_id/staff_id come from g.client_staff (verified JWT),
    never from the request body/query string -- same isolation guarantee
    /leaves and /mark|/history already give: a token minted for one staff
    member can't file or read overtime for anyone else by editing the
    payload or a query param, because there is no such field to edit for
    those three values.

Visibility contract this route exists to preserve (per product decision):
  - This mobile portal ALWAYS returns only the caller's own overtime rows
    (list_client_overtime_requests is called with
    user_id=g.client_staff['id'] every time) -- even if the caller happens
    to also be someone's manager. A manager's team-wide view, and the
    admin's org-wide view, both live on the Client Dashboard's Overtime
    Management screen (/api/overtime, team-scoped via
    client_dashboard_auth.get_team_scope_ids for managers, unscoped for
    admins) -- a completely separate surface with its own token. This
    portal never exposes a teammate's overtime, on purpose. In short:
    one person's overtime IS visible to the admin dashboard and to their
    reporting manager's dashboard view, but never inside another
    individual staff member's mobile "My Overtime" list.

staff_id/org_id/branch_id are all UUID strings end-to-end (Supabase ids),
never coerced to int -- create_client_overtime_request/
list_client_overtime_requests in support_db.py already treat them as
opaque text, so this route just passes the JWT's string values straight
through without any int() cast that would break on a UUID.
"""
from __future__ import annotations

from flask import Blueprint, request, g

from client_staff_auth import require_client_staff_auth
from client_routes_helpers import ok, handle
import support_db as support_cp_db

client_staff_overtime_bp = Blueprint(
    "client_staff_overtime", __name__, url_prefix="/api/staff/overtime"
)


@client_staff_overtime_bp.route("", methods=["POST"])
@require_client_staff_auth
def request_overtime():
    """
    Self-service overtime request.

    Body:
      {
        "date": "YYYY-MM-DD",     # also accepts "ot_date"
        "hours": number,
        "reason": str
      }

    staff_id/org_id/branch_id are always g.client_staff's -- never read
    from this body -- so a mobile caller can never file overtime against
    another org, branch, or staff member by editing the payload.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = g.client_staff["org_id"]

        hours_raw = payload.get("hours")
        try:
            hours = float(hours_raw) if hours_raw not in (None, "") else 0.0
        except (TypeError, ValueError):
            hours = 0.0
        if hours <= 0:
            return ok({"success": False, "message": "hours must be greater than 0"}, 400)

        create_payload = {
            "staff_id": g.client_staff["id"],
            "branch_id": g.client_staff.get("branch_id"),
            "user_name": g.client_staff.get("name"),
            "ot_date": payload.get("date") or payload.get("ot_date"),
            "hours": hours,
            "reason": str(payload.get("reason") or "").strip(),
        }
        overtime = support_cp_db.create_client_overtime_request(org_id, create_payload)
        return ok({"id": overtime.get("id"), "overtime": overtime}, 201)

    return handle(_run)


@client_staff_overtime_bp.route("", methods=["GET"])
@require_client_staff_auth
def my_overtime():
    """
    Own overtime history only. user_id is hard-pinned to
    g.client_staff['id'] -- there is no path through this route to another
    staff member's overtime, by construction, regardless of the caller's
    manager/admin status elsewhere in the system. Team-wide / org-wide
    visibility is the Client Dashboard's job (/api/overtime), not this
    mobile portal's.
    """
    def _run():
        status = request.args.get("status")
        rows = support_cp_db.list_client_overtime_requests(
            org_id=g.client_staff["org_id"],
            user_id=g.client_staff["id"],
            status=status,
        )
        return ok({"overtime": rows})

    return handle(_run)