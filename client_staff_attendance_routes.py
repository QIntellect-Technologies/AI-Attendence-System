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

from flask import Blueprint, request, g

from client_staff_auth import require_client_staff_auth
from client_routes_helpers import ok, handle
import support_db as support_cp_db

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