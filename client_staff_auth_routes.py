"""
client_staff_auth_routes.py
──────────────────────────────────────────────────────────────────────────────
Mobile employee/field-staff portal — login + own-profile routes.

Separate from the Client Dashboard's /api/client/* routes (admin/HR
audience, client_users table) and from the Support Dashboard's /v1/support/*
routes (internal_users table). This blueprint's audience is client_staff:
the actual employees/students/doctors/workers the mobile app was built for.

Register this blueprint in app.py alongside client_shifts_bp /
client_attendance_settings_bp.
"""
from __future__ import annotations

from flask import Blueprint, request, g

import support_db as support_cp_db
from client_staff_auth import login_client_staff, require_client_staff_auth
from client_routes_helpers import ok, err, handle
import login_throttle

client_staff_auth_bp = Blueprint(
    "client_staff_auth", __name__, url_prefix="/api/staff"
)


@client_staff_auth_bp.route("/login", methods=["POST"])
def staff_login():
    """
    Mobile portal login. Accepts EITHER the email OR the phone number the
    employee was registered with — whichever Staff Management showed the
    admin as "Username / Number" at creation time, entered back verbatim.

    Body: { "identifier": "<email-or-phone>", "password": "<password>" }
    'username' is also accepted as an alias since that's the label shown
    to the admin/employee, so the mobile app's field name can match the UI
    copy exactly without a client-side rename.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        identifier = str(
            payload.get("identifier")
            or payload.get("username")
            or payload.get("email")
            or payload.get("phone")
            or ""
        ).strip()
        password = str(payload.get("password") or "")

        if not identifier or not password:
            raise ValueError("identifier (email or phone) and password are required")

        # Same brute-force throttle as /api/login — this endpoint accepts a
        # phone number as the identifier, which is a materially smaller
        # guessing space than an email address, so if anything it needs the
        # limit more. See login_throttle.py.
        if login_throttle.is_locked_out(identifier):
            return login_throttle.lockout_response(identifier)

        try:
            staff, token = login_client_staff(identifier, password)
        except Exception:
            login_throttle.register_failure(identifier)
            raise
        login_throttle.register_success(identifier)

        # Mobile tokens live 30 days, so an archived/suspended org must be
        # refused at login rather than only on the next request.
        from support_db import _compute_org_status, _org_access_allows_client
        staff_org_id = staff.get("org_id") or staff.get("organization_id")
        if staff_org_id:
            org_status = _compute_org_status(str(staff_org_id))
            if not _org_access_allows_client(org_status):
                return err(
                    "This organization is no longer active. "
                    "Contact your administrator.",
                    403,
                )

        # Keyed as "user" (not "staff") to match the response shape of
        # /api/login (client_users/client_staff dashboard login) — one
        # parsing path on the client regardless of which endpoint it hit.
        return ok({"user": staff, "token": token})

    return handle(_run)


@client_staff_auth_bp.route("/me", methods=["GET"])
@require_client_staff_auth
def staff_me():
    """
    Refresh the logged-in employee's own profile — the mobile app calls this
    on launch/resume instead of trusting the JWT claims to still be current
    (a shift/department/profile edit made from the Client Dashboard since
    the last login shows up here immediately, without needing a new token).
    """
    def _run():
        staff_id = g.client_staff["id"]
        staff = support_cp_db.get_client_staff_member(staff_id)
        return ok({"user": staff})

    return handle(_run)