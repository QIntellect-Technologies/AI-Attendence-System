"""
client_staff_notifications_routes.py
──────────────────────────────────────────────────────────────────────────────
Notifications for the Staff Panel (managers like a branch admin logged in
via client_staff_auth — e.g. Imran Khalid). This is a DIFFERENT identity
space from the Client Dashboard's /api/notifications routes in app.py,
which only ever read client_users (the one-per-organization account that
purchased the system). A manager has no client_users row to read there —
see support_db_hierarchy.py::resolve_notification_target and
migration_add_recipient_type.sql for the full rationale.

org_id/staff_id come from the verified JWT (g.client_staff), never from a
query param — unlike the legacy Client Dashboard routes, which trust
user_id/organization_id straight off the querystring. A Staff Panel token
minted for one manager can't be used to read another manager's, or the
org owner's, notifications by editing a URL param, because there's no such
param to edit here.

Register this blueprint in app.py alongside client_staff_attendance_bp.
"""
from __future__ import annotations

from flask import Blueprint, request, g

from client_staff_auth import require_client_staff_auth
from client_routes_helpers import ok, handle
import support_db_notifications as notifications_db

client_staff_notifications_bp = Blueprint(
    "client_staff_notifications", __name__, url_prefix="/api/staff/notifications"
)

_RECIPIENT_TYPE = "client_staff"


@client_staff_notifications_bp.route("", methods=["GET"])
@require_client_staff_auth
def staff_notifications():
    def _run():
        unread_only = str(request.args.get("unread_only", "")).lower() in ("1", "true", "yes")
        limit = request.args.get("limit", 100, type=int)
        org_id = g.client_staff["org_id"]
        user_id = g.client_staff["id"]
        notifications = notifications_db.list_notifications(
            org_id, user_id, recipient_type=_RECIPIENT_TYPE, unread_only=unread_only, limit=limit,
        )
        return ok({
            "notifications": notifications,
            "unread_count": notifications_db.get_unread_count(org_id, user_id, recipient_type=_RECIPIENT_TYPE),
        })

    return handle(_run)


@client_staff_notifications_bp.route("/unread-count", methods=["GET"])
@require_client_staff_auth
def staff_notifications_unread_count():
    def _run():
        count = notifications_db.get_unread_count(
            g.client_staff["org_id"], g.client_staff["id"], recipient_type=_RECIPIENT_TYPE,
        )
        return ok({"unread_count": count})

    return handle(_run)


@client_staff_notifications_bp.route("/<int:notification_id>/read", methods=["POST", "PUT", "PATCH"])
@require_client_staff_auth
def mark_staff_notification_read(notification_id):
    def _run():
        updated = notifications_db.mark_read(
            g.client_staff["org_id"], notification_id, g.client_staff["id"], recipient_type=_RECIPIENT_TYPE,
        )
        return ok({"updated": updated})

    return handle(_run)


@client_staff_notifications_bp.route("/mark-all-read", methods=["POST", "PUT", "PATCH"])
@require_client_staff_auth
def mark_all_staff_notifications_read():
    def _run():
        updated_count = notifications_db.mark_all_read(
            g.client_staff["org_id"], g.client_staff["id"], recipient_type=_RECIPIENT_TYPE,
        )
        return ok({"updated_count": updated_count})

    return handle(_run)