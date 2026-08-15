"""
client_staff_hr_assistant_routes.py
──────────────────────────────────────────────────────────────────────────────
Mobile HR Assistant chatbot — server-side counterpart of
hr_chatbot_widget.dart.

Previously this feature had NO backend route at all: the Flutter widget
called api.anthropic.com directly, with the API key hardcoded in the app
and whatever employee data the calling screen (office_home_screen.dart /
field_home_screen.dart) happened to construct — most fields silently
defaulted to 0/placeholder, so questions about salary, real leave usage,
etc. were answered with fabricated numbers.

This route follows the exact same isolation guarantee every other
client_staff_*_routes.py file already gives: org_id/branch_id/staff_id come
from g.client_staff (verified JWT) — never from the request body — so a
mobile caller can never ask the assistant about another org/branch/staff
member's data by editing the payload.

Register this blueprint in app.py alongside client_staff_attendance_bp /
client_staff_leave_bp.
"""
from __future__ import annotations

from flask import Blueprint, request, g

from client_staff_auth import require_client_staff_auth
from client_routes_helpers import ok, handle
import support_db_hr_assistant as hr_assistant_db
import hr_assistant_service

client_staff_hr_assistant_bp = Blueprint(
    "client_staff_hr_assistant", __name__, url_prefix="/api/staff/hr-assistant"
)


@client_staff_hr_assistant_bp.route("/message", methods=["POST"])
@require_client_staff_auth
def hr_assistant_message():
    """
    Body: { "message": str }

    Assembles the caller's own real salary/attendance/leave/overtime
    snapshot (support_db_hr_assistant.build_hr_assistant_context, scoped
    to g.client_staff), then asks the model to answer using ONLY that
    data (hr_assistant_service._build_system_prompt's strict rules) — the
    model is never shown another staff member's information and is
    instructed not to invent figures for things this system doesn't
    track (leave quota, performance rating).

    Returns { reply: str, info_card: list[[str,str]] | None }. info_card
    is built server-side from the same verified context, keyed off simple
    intent detection on the message — this replaces
    hr_chatbot_widget.dart's old client-side _makeInfoCard, so there is
    exactly one place that decides what the card shows, not two that
    could drift apart.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        message = str(payload.get("message") or "").strip()
        if not message:
            raise ValueError("message is required")
        if len(message) > 2000:
            raise ValueError("message is too long")

        context = hr_assistant_db.build_hr_assistant_context(
            org_id=g.client_staff["org_id"],
            branch_id=g.client_staff.get("branch_id"),
            staff_id=g.client_staff["id"],
        )
        result = hr_assistant_service.get_hr_assistant_reply(context, message)
        return ok(result)

    return handle(_run)