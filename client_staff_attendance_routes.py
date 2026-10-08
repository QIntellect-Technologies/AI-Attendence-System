"""
client_staff_attendance_routes.py
──────────────────────────────────────────────────────────────────────────────
Mobile self-service attendance for office staff (client_staff rows).

Writes into the same Supabase `attendance` table the Client Dashboard reads
via get_client_attendance_logs / _client_attendance_rows, so a mobile
check-in appears on the dashboard immediately -- tagged source='mobile_office'
(or 'mobile_fallback' for a delayed offline-cache sync), distinguishing it
from camera-detected rows with no dashboard-side change needed
(_attendance_row_for_dashboard already passes `source` straight through).

Previously the mobile app called /mark_attendance and
/api/office/wifi-attendance, neither of which existed as a route -- every
attempt failed and silently fell back to the app's local offline cache.
This blueprint is the actual fix; register it alongside client_staff_auth_bp.

Field-staff geofence/face-verify attendance (/api/field/*) is a separate,
still-missing surface -- intentionally out of scope here.
"""
from __future__ import annotations

from datetime import date

from flask import Blueprint, request, g

from client_staff_auth import require_client_staff_auth
from client_routes_helpers import ok, handle
import support_db as support_cp_db
import payroll_engine

client_staff_attendance_bp = Blueprint(
    "client_staff_attendance", __name__, url_prefix="/api/staff/attendance"
)


@client_staff_attendance_bp.route("/mark", methods=["POST"])
@require_client_staff_auth
def mark_attendance():
    """
    Self-service check-in/check-out for the logged-in office employee.

    org_id/branch_id/staff_id are read from g.client_staff (the verified
    JWT), never from the request body -- a mobile client cannot mark
    attendance for another org/branch/staff member by editing the payload.

    Body (all optional):
      { "ssid": str, "bssid": str, "wifi_verified": bool,
        "synced_after_offline": bool, "client_action_id": str }

    synced_after_offline=true is set by the app when this call is the
    delayed sync of a mark that was cached locally after a failed
    real-time attempt -- recorded as source='mobile_fallback' instead of
    'mobile_office' so the dashboard can tell the two apart.

    client_action_id is the offline queue's idempotency key (see
    OfflineQueueService.dart / mark_client_staff_attendance's docstring)
    -- optional on a live call, but always present on a queued retry, so a
    dropped response never gets replayed as the opposite of what it
    actually did server-side.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        result = support_cp_db.mark_client_staff_attendance(
            org_id=g.client_staff["org_id"],
            branch_id=g.client_staff.get("branch_id"),
            staff_id=g.client_staff["id"],
            ssid=payload.get("ssid"),
            bssid=payload.get("bssid"),
            wifi_verified=bool(payload.get("wifi_verified", False)),
            synced_after_offline=bool(payload.get("synced_after_offline", False)),
            client_action_id=payload.get("client_action_id"),
        )
        return ok(result)

    return handle(_run)


@client_staff_attendance_bp.route("/today", methods=["GET"])
@require_client_staff_auth
def attendance_today():
    """
    Today's status + whether a checkout is even possible for this shift --
    the piece /history can't answer on its own, since capture_check_out is
    a shift-level setting, not an attendance-row field. Called on app
    launch/refresh so the Check Out button can appear immediately after a
    check-in from an earlier session, not only right after this session's
    own mark call.
    """
    def _run():
        status = support_cp_db.get_client_staff_attendance_today(
            org_id=g.client_staff["org_id"],
            branch_id=g.client_staff.get("branch_id"),
            staff_id=g.client_staff["id"],
        )
        return ok(status)

    return handle(_run)


@client_staff_attendance_bp.route("/history", methods=["GET"])
@require_client_staff_auth
def attendance_history():
    """
    Own-attendance history for the mobile app's home/history screens —
    powers both the "already marked today?" check and the Attendance tab.

    Replaces the app's prior use of /get_attendance_by_name: that route
    read the legacy SQLite `db` module by user_name, a completely different
    store from the Supabase `attendance` table /mark (above) writes to, so
    a staff member's own just-marked attendance could never show up there.

    org_id/staff_id come from g.client_staff (verified JWT), same isolation
    guarantee as /mark — a token minted for one staff member can't be used
    to pull another's history by editing a query param, because there is
    no such param to edit.
    """
    def _run():
        limit = request.args.get("limit", type=int) or 100
        logs = support_cp_db.get_client_staff_attendance_history(
            org_id=g.client_staff["org_id"],
            staff_id=g.client_staff["id"],
            limit=limit,
        )
        return ok({"logs": logs})

    return handle(_run)


@client_staff_attendance_bp.route("/working-days", methods=["GET"])
@require_client_staff_auth
def attendance_working_days():
    """Configured payroll working dates for the logged-in staff member."""
    def _run():
        try:
            start = date.fromisoformat(str(request.args.get("start_date") or ""))
            end = date.fromisoformat(str(request.args.get("end_date") or ""))
        except ValueError as exc:
            raise ValueError("start_date and end_date must be YYYY-MM-DD") from exc

        if end < start:
            raise ValueError("end_date must not be before start_date")
        if (end.year - start.year) * 12 + end.month - start.month > 25:
            raise ValueError("Date range cannot exceed 25 calendar months")

        staff = support_cp_db.get_client_staff_member(g.client_staff["id"])
        join_date_value = str(staff.get("join_date") or "")[:10]
        join_date = date.fromisoformat(join_date_value) if join_date_value else None
        if join_date and start < join_date:
            effective_start = join_date
        else:
            effective_start = start

        working_dates = []
        if effective_start <= end:
            month_start = date(effective_start.year, effective_start.month, 1)
            while month_start <= end:
                month_key = month_start.strftime("%Y-%m")
                policy = support_cp_db.get_payroll_policy_for_period(
                    g.client_staff["org_id"],
                    month_start.isoformat(),
                    # The profile's branch_id is the dashboard UI-mapped
                    # value; payroll policy lookup requires the JWT's raw
                    # backend branch UUID.
                    branch_id=g.client_staff.get("branch_id"),
                )
                working_dates.extend(
                    day
                    for day in payroll_engine.scheduled_work_dates_for_month(
                        month_key,
                        policy,
                        people_type=staff.get("people_type") or "staff",
                    )
                    if effective_start.isoformat() <= day <= end.isoformat()
                )
                month_start = (
                    date(month_start.year + 1, 1, 1)
                    if month_start.month == 12
                    else date(month_start.year, month_start.month + 1, 1)
                )

        elapsed_end = min(end, date.today())
        elapsed_working_dates = [
            day for day in working_dates if day <= elapsed_end.isoformat()
        ]
        return ok({
            "working_dates": working_dates,
            "elapsed_working_dates": elapsed_working_dates,
            "join_date": join_date.isoformat() if join_date else None,
        })

    return handle(_run)