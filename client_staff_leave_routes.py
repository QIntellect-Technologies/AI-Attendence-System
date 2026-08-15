"""
client_staff_leave_routes.py
──────────────────────────────────────────────────────────────────────────────
Mobile self-service leave requests for office/field staff (client_staff rows).

Writes into the same Supabase `leave_requests` table the Client Dashboard's
Leave Management screen reads via support_db.list_client_leave_requests /
create_client_leave_request -- so a leave applied for on mobile appears on
the dashboard immediately (and manager/admin get the same notification a
dashboard-created leave would), with no separate mobile-only leave store.

Previously the mobile app called /apply_leave and /get_my_leaves. Neither
exists anywhere in app.py (grepped) -- every mobile leave request was
posting into a 404 and silently vanishing, the same class of bug
client_staff_attendance_routes.py fixed for attendance. This blueprint is
the fix for leave; register it alongside client_staff_attendance_bp.

Half-day model: half-day is a modifier that can apply to any leave category,
not a category of its own. A half-day submission keeps leave_type as the
category the user actually picked (Annual/Sick/...) and carries
half_day_period (first_half/second_half, derived from the picked time
window) plus the exact half_day_start_time/half_day_end_time as their own
fields on the row -- create_client_leave_request accepts these
independently of leave_type. This replaced an earlier scheme that
overwrote leave_type to the literal string 'half_day' and smuggled the
real category + time range through the free-text `reason` field; that
meant leave_type could never be trusted as "the category" for any
half-day row, and the attendance gate's half-day lookup
(support_db_attendance_gate._find_approved_half_day_leave) now matches on
half_day_period being set rather than leave_type=='half_day'.

org_id/branch_id/staff_id come from g.client_staff (verified JWT), never
from the request body -- same isolation guarantee /mark and /history
already give: a token minted for one staff member can't file or read leave
for anyone else by editing the payload or a query param, because there is
no such field to edit for those three values.

Visibility contract this route exists to preserve:
  - This mobile portal ALWAYS returns only the caller's own leave rows
    (list_client_leave_requests is called with user_id=g.client_staff['id']
    every time) -- even if the caller happens to also be someone's manager.
    A manager's team-wide view lives on the Client Dashboard
    (/api/leaves, team-scoped via client_dashboard_auth.get_team_scope_ids),
    a completely separate surface with its own token. This portal never
    exposes a teammate's leave, on purpose.
"""
from __future__ import annotations

from flask import Blueprint, request, g

from client_staff_auth import require_client_staff_auth
from client_routes_helpers import ok, handle
import support_db as support_cp_db

client_staff_leave_bp = Blueprint(
    "client_staff_leave", __name__, url_prefix="/api/staff/leaves"
)

# Accepts whatever bucket word the app's UI has used across iterations
# (morning/afternoon, am/pm) plus the backend's own vocabulary, so a stale
# app build and a fresh one both normalize the same way.
_HALF_DAY_PERIOD_MAP = {
    "morning": "first_half",
    "first_half": "first_half",
    "firsthalf": "first_half",
    "am": "first_half",
    "afternoon": "second_half",
    "second_half": "second_half",
    "secondhalf": "second_half",
    "pm": "second_half",
}


def _resolve_half_day_period(raw) -> str:
    key = str(raw or "").strip().lower().replace("_", "").replace(" ", "")
    return _HALF_DAY_PERIOD_MAP.get(key, "first_half")


@client_staff_leave_bp.route("", methods=["POST"])
@require_client_staff_auth
def apply_leave():
    """
    Self-service leave application.

    Body:
      {
        "leave_type": "Sick Leave" | "Annual Leave" | ... ,  # category picked in the app
        "start_date": "YYYY-MM-DD",
        "end_date": "YYYY-MM-DD",
        "reason": str,
        "half_day": bool,                          # half-day toggle state
        "half_day_period": "morning" | "afternoon" | null,
        "half_day_start_time": "HH:mm" | null,
        "half_day_end_time": "HH:mm" | null
      }

    staff_id/org_id/branch_id are always g.client_staff's -- never read from
    this body -- so a mobile caller can never file leave against another
    org, branch, or staff member by editing the payload.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = g.client_staff["org_id"]

        category = str(payload.get("leave_type") or payload.get("type") or "annual").strip()
        reason = str(payload.get("reason") or "").strip()
        is_half_day = bool(payload.get("half_day") or payload.get("halfDay"))
        start_time = payload.get("half_day_start_time") or payload.get("halfDayStartTime")
        end_time = payload.get("half_day_end_time") or payload.get("halfDayEndTime")

        # Half-day is passed through as its own set of fields now -- category
        # (leave_type) is never overwritten, and the exact time range is
        # stored as first-class columns instead of being folded into the
        # free-text reason. create_client_leave_request accepts half_day_period
        # (and now half_day_start_time/half_day_end_time) independently of
        # leave_type, so nothing here needs to smuggle data through `reason`
        # anymore.
        half_day_period = (
            _resolve_half_day_period(payload.get("half_day_period") or payload.get("halfDayPeriod"))
            if is_half_day else None
        )

        create_payload = {
            "staff_id": g.client_staff["id"],
            "branch_id": g.client_staff.get("branch_id"),
            "leave_type": category,
            "half_day": is_half_day,
            "half_day_period": half_day_period,
            "half_day_start_time": start_time if is_half_day else None,
            "half_day_end_time": end_time if is_half_day else None,
            "start_date": payload.get("start_date") or payload.get("startDate"),
            "end_date": payload.get("end_date") or payload.get("endDate"),
            "reason": reason,
        }
        leave = support_cp_db.create_client_leave_request(org_id, create_payload)
        return ok({"id": leave.get("id"), "leave": leave}, 201)

    return handle(_run)


@client_staff_leave_bp.route("", methods=["GET"])
@require_client_staff_auth
def my_leaves():
    """
    Own leave history only. user_id is hard-pinned to g.client_staff['id']
    -- there is no path through this route to another staff member's
    leave, by construction, regardless of the caller's manager/admin
    status elsewhere in the system.
    """
    def _run():
        status = request.args.get("status")
        rows = support_cp_db.list_client_leave_requests(
            org_id=g.client_staff["org_id"],
            user_id=g.client_staff["id"],
            status=status,
        )
        return ok({"leaves": rows})

    return handle(_run)


@client_staff_leave_bp.route("/types", methods=["GET"])
@require_client_staff_auth
def leave_types():
    """
    Effective leave-type paid/unpaid map for the caller's own org + branch,
    so the mobile "Apply for Leave" form offers exactly the categories this
    tenant has configured (support_db_payroll's PayrollPolicy.leaveTypeRules,
    same source the dashboard's Leave Management filter reads) instead of a
    fixed list baked into the app.

    org_id/branch_id come from g.client_staff (verified JWT), never from
    the request -- same isolation guarantee every other route in this file
    gives: a token minted for one staff member can only ever see their own
    org/branch's configured leave types, never another tenant's.
    """
    def _run():
        rules = support_cp_db.get_leave_type_rules(
            g.client_staff["org_id"],
            branch_id=g.client_staff.get("branch_id"),
        )
        return ok({"leaveTypeRules": rules})

    return handle(_run)


@client_staff_leave_bp.route("/<leave_id>", methods=["DELETE"])
@require_client_staff_auth
def cancel_leave(leave_id):
    """
    Self-service cancellation of the caller's own PENDING leave request.

    Deliberately narrower than the dashboard's DELETE /api/leaves/<id>
    (api_delete_leave in app.py), which a manager/admin can use on a leave
    in any status. This route reuses the same
    support_db.delete_client_leave_request the dashboard route calls --
    same hard-delete, no separate delete path to keep in sync -- but only
    after two checks the dashboard route doesn't need:

      1. Ownership: the leave must belong to g.client_staff['id']. A leave
         that exists but belongs to a different staff member is treated
         identically to one that doesn't exist at all -- this route never
         distinguishes "not yours" from "not found" in its response, the
         same "don't leak existence across a boundary" pattern
         get_client_leave_owned_by_org already uses for cross-org lookups.
      2. Status: only 'pending' requests can be self-cancelled. Once a
         manager has approved or rejected it the record reflects a
         decision (and an approved leave may already be feeding
         attendance/payroll), so changing it from there is a dashboard
         action, not a mobile self-service one.
    """
    def _run():
        org_id = g.client_staff["org_id"]
        staff_id = str(g.client_staff["id"])

        leave = support_cp_db.get_client_leave_owned_by_org(str(leave_id), org_id)
        owner_id = str(leave.get("staff_id") or leave.get("user_id") or "")
        if owner_id != staff_id:
            raise ValueError("Leave request not found")

        status = str(leave.get("status") or "").strip().lower()
        if status != "pending":
            raise ValueError(
                f"Only pending leave requests can be cancelled (current status: {status or 'unknown'})"
            )

        support_cp_db.delete_client_leave_request(str(leave_id), org_id)
        return ok({"id": leave_id, "cancelled": True})

    return handle(_run)