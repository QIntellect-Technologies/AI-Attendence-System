"""
support_db_attendance_exceptions.py
──────────────────────────────────────────────────────────────────────────────
Turns a raw timing classification (early / on_time / late / overtime /
unscheduled — from support_db_attendance_gate.resolve_check_in_status /
resolve_check_out_status) into what actually gets WRITTEN to the attendance
row, plus the admin-notification side effect, for both write paths that
share this logic: mark_client_staff_attendance (mobile) and
record_cloud_camera_attendance (cloud camera).

Scenario contract (exactly as specified):
  Check-in
    early    -> checked in; notes say so; status = 'early' (informational,
                no admin action needed)
    on_time  -> checked in; status = 'on_time'
    late     -> checked in (attendance row DOES exist), but check_in_confirmed
                is left False and check_in_hold_reason='late' until an admin
                resolves it (present-but-late vs half_day vs short_leave) via
                resolve_attendance_exception. Admin notified.

  Check-out
    on_time  -> checked out; status = 'on_time'
    early    -> checked out, but check_out_hold_reason='early' until an
                admin decides early_leave vs half_day vs short_leave.
                Admin notified.
    late     -> checked out, but check_out_hold_reason='late' until an admin
                decides late vs overtime. Admin notified.
    overtime -> already-approved overtime covers this checkout — recorded
                normally, no hold, no notification (nothing for an admin to
                decide; the overtime request was already approved).

short_leave vs early_leave/half_day: early_leave means the person simply
left early with no prior arrangement; half_day means enough of the shift
was missed that it reads as a half-day absence. short_leave is neither —
it's a manager-sanctioned shorter attendance (arranged in advance, at the
manager's discretion), so it's tracked as its own distinct decision/status
rather than folded into either of the other two. Like half_day and
overtime, resolving to short_leave is only a CLASSIFICATION here — whether
it actually affects payroll is a separate, later decision (see the
payroll-decision columns/Phase 3 admin screen), not decided by this module.

Notifications are broadcast to every active admin/hr in the org (see
support_db_notifications._active_admin_recipient_ids) and are soft-fail: a
notification failure never blocks the attendance write itself.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from supabase_client import get_supabase
import support_db_hierarchy as hierarchy_db  
import support_db_notifications as notifications_db
from support_db_time_utils import (
    now_iso as _now_iso,
    clean_text as _clean_text,
    is_missing_table_or_column as _is_missing_column,
)

logger = logging.getLogger(__name__)


# ─── Notes text ─────────────────────────────────────────────────────────

_CHECK_IN_NOTES = {
    "early": "Checked in earlier than the shift start time.",
    "late": "Checked in after the grace period — awaiting admin review.",
}
_CHECK_OUT_NOTES = {
    "early": "Checked out earlier than the shift end time — awaiting admin review.",
    "late": "Checked out after the grace period — awaiting admin review.",
    "overtime": "Checked out within approved overtime window.",
}


def _append_note(existing: Optional[str], addition: Optional[str]) -> Optional[str]:
    existing = _clean_text(existing)
    addition = _clean_text(addition)
    if not addition:
        return existing or None
    if not existing:
        return addition
    return f"{existing} | {addition}"


# ─── Branch name (exception-path only, kept off the hot per-mark path) ───

def get_branch_name_for_notification(org_id: str, branch_id: Optional[str]) -> str:
    if not branch_id:
        return ""
    sb = get_supabase()
    result = (
        sb.table("branches")
        .select("name")
        .eq("id", str(branch_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    return (result.data[0].get("name") or "") if result.data else ""


# ─── Check-in classification ───────────────────────────────────────────

def check_in_write_fields(status: str) -> dict:
    """Extra fields to merge into the attendance INSERT for a check-in,
    on top of {status, timestamp, ...}. Pure — no DB/notification calls."""
    status = (status or "unscheduled").lower()
    if status == "late":
        return {
            "notes": _CHECK_IN_NOTES["late"],
            "check_in_hold_reason": "late",
            "check_in_confirmed": False,
        }
    if status == "early":
        return {
            "notes": _CHECK_IN_NOTES["early"],
            "check_in_hold_reason": None,
            "check_in_confirmed": True,
        }
    return {"notes": None, "check_in_hold_reason": None, "check_in_confirmed": True}


def notify_check_in_exception(
    *, org_id: str, branch_id: Optional[str], staff_id: str, staff_name: str,
    attendance_id, event_local_str: str,
) -> None:
    branch_name = get_branch_name_for_notification(org_id, branch_id)
    where = f" at {branch_name}" if branch_name else ""
    try:
        # resolve_notification_target returns a client_staff.id (the
        # manager's own Staff Panel row) -- NOT a client_users.id. It must
        # go through recipient_staff_ids, not recipient_user_ids, or the
        # resulting notification_recipients row is tagged recipient_type=
        # 'client_user' while pointing at a client_staff id: it matches no
        # one's query and the notification is silently unreachable by
        # anyone, even though it was "created" successfully. Moved inside
        # this try (previously called before it) so a lookup failure here
        # degrades to the org-wide broadcast instead of raising past this
        # function, matching this module's soft-fail contract.
        manager_recipient = hierarchy_db.resolve_notification_target(org_id, staff_id)
        notifications_db.create_notification(
            org_id,
            branch_id=branch_id,
            module_key="attendance",
            event_type="attendance.check_in.late",
            title=f"Late check-in — {staff_name}",
            body=f"{staff_name} checked in late{where} ({event_local_str}). Decide late vs half-day.",
            actor_name=staff_name,
            target_entity_id=str(attendance_id),
            target_entity_type="attendance",
            target_route="/admin/attendance/exceptions",
            metadata={"staff_id": str(staff_id), "leg": "check_in", "status": "late"},
            recipient_staff_ids=[manager_recipient] if manager_recipient else None,
            # Always reach org admins too, not just the assigned manager (if
            # any) -- same reasoning as the leave-request notification in
            # support_db_payroll.py, and consistent with target_route above
            # pointing at the admin dashboard's own exceptions screen. Also
            # means an org with no manager assigned still notifies admins,
            # since create_notification's own "empty recipient_pairs ->
            # broadcast" fallback only covers that case implicitly; this
            # makes the broadcast unconditional instead of accidental.
            also_broadcast=True,
        )
    except Exception:
        # Never fail the attendance mark because a notification couldn't
        # be recorded (e.g. migration not yet applied).
        pass


# ─── Check-out classification ──────────────────────────────────────────

def check_out_write_fields(status: str, existing_notes: Optional[str]) -> dict:
    """Extra fields to merge into the attendance UPDATE for a check-out."""
    status = (status or "unscheduled").lower()
    if status in ("early", "late", "overtime"):
        merged_notes = _append_note(existing_notes, _CHECK_OUT_NOTES[status])
    else:
        merged_notes = existing_notes

    if status in ("early", "late"):
        return {"notes": merged_notes, "check_out_hold_reason": status}
    # 'overtime' (pre-approved) and 'on_time'/'unscheduled' need no hold.
    return {"notes": merged_notes, "check_out_hold_reason": None}


def notify_check_out_exception(
    *, org_id: str, branch_id: Optional[str], staff_id: str, staff_name: str,
    attendance_id, status: str, event_local_str: str,
) -> None:
    branch_name = get_branch_name_for_notification(org_id, branch_id)
    where = f" at {branch_name}" if branch_name else ""
    verb = "earlier than scheduled" if status == "early" else "later than scheduled"
    decide = "Decide early-leave vs half-day." if status == "early" else "Decide late vs overtime vs early-leave."
    # Same manager-plus-admins routing as notify_check_in_exception — a
    # checkout exception is no less this staff member's manager's concern
    # than a late check-in is, but org admins always see it too (also_broadcast
    # below), not just when no manager happens to be assigned.
    try:
        # See notify_check_in_exception's comment: resolve_notification_target
        # returns a client_staff.id, so this must go through
        # recipient_staff_ids, not recipient_user_ids -- passing it as the
        # latter tags the recipient row with the wrong identity space and
        # the notification becomes unreachable by anyone. Also moved inside
        # this try, same defense-in-depth reasoning.
        manager_recipient = hierarchy_db.resolve_notification_target(org_id, staff_id)
        notifications_db.create_notification(
            org_id,
            branch_id=branch_id,
            module_key="attendance",
            event_type=f"attendance.check_out.{status}",
            title=f"Checkout exception — {staff_name}",
            body=f"{staff_name} checked out {verb}{where} ({event_local_str}). {decide}",
            actor_name=staff_name,
            target_entity_id=str(attendance_id),
            target_entity_type="attendance",
            target_route="/admin/attendance/exceptions",
            metadata={"staff_id": str(staff_id), "leg": "check_out", "status": status},
            recipient_staff_ids=[manager_recipient] if manager_recipient else None,
            # See notify_check_in_exception's comment -- same reasoning,
            # same fix.
            also_broadcast=True,
        )
    except Exception:
        pass


def local_time_str(event_dt: datetime, branch_zone: ZoneInfo) -> str:
    dt = event_dt if event_dt.tzinfo else event_dt.replace(tzinfo=timezone.utc)
    # 12-hour clock with AM/PM (e.g. "3:29 PM"), not 24-hour -- %I gives a
    # zero-padded "03", so the leading zero is stripped for the single-digit
    # hours (1-9); doesn't touch "10"/"11"/"12" since those have no leading
    # zero to strip.
    formatted = dt.astimezone(branch_zone).strftime("%I:%M %p")
    return formatted.lstrip("0") or formatted


def _parse_iso_dt(value) -> Optional[datetime]:
    """Best-effort ISO-string -> datetime, tolerant of a trailing 'Z' and of
    already being a datetime. Returns None (never raises) so callers can
    fall back cleanly instead of the field blowing up the whole response."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def local_time_str_iso(value, branch_zone: ZoneInfo) -> str:
    """ISO-string-safe counterpart to local_time_str -- every raw Supabase
    'timestamp'/'check_out_timestamp' column value is a string, not a
    datetime, so every read path that wants a local HH:MM needs this rather
    than slicing the raw (UTC) string directly. Reuses local_time_str's
    tz-fallback logic rather than duplicating it; falls back to the old
    naive UTC slice only if the value genuinely doesn't parse, so a
    malformed timestamp degrades to the previous behavior instead of
    throwing."""
    dt = _parse_iso_dt(value)
    if dt is None:
        text = str(value or "")
        return text[11:16] if len(text) >= 16 else ""
    return local_time_str(dt, branch_zone)


def local_date_str_iso(value, branch_zone: ZoneInfo) -> str:
    """ISO-string-safe local calendar date (YYYY-MM-DD), same fallback
    contract as local_time_str_iso. Needed alongside local_time_str_iso so
    a mark made near local midnight in a non-UTC branch shows the date the
    person actually experienced, not the UTC date the raw string happens to
    start with."""
    dt = _parse_iso_dt(value)
    if dt is None:
        text = str(value or "")
        return text[:10] if text else ""
    dt = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(branch_zone).strftime("%Y-%m-%d")


# ─── Branch timezone (payroll-linking helpers only) ────────────────────
#
# Deliberately a small local copy of support_db_attendance_gate._get_branch_
# timezone rather than importing that module's private helper -- this file
# only needs the timezone, not the rest of the gate module's resolution
# machinery, for the half-day/overtime date math below.

_DEFAULT_TZ = "UTC"


def _get_branch_zone(org_id: str, branch_id: Optional[str]) -> ZoneInfo:
    if not branch_id:
        return ZoneInfo(_DEFAULT_TZ)
    sb = get_supabase()
    result = (
        sb.table("branches")
        .select("timezone")
        .eq("id", str(branch_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    tz_name = ((result.data[0].get("timezone") if result.data else None) or _DEFAULT_TZ)
    try:
        return ZoneInfo(tz_name)
    except ZoneInfoNotFoundError:
        return ZoneInfo(_DEFAULT_TZ)


# ─── Duration ───────────────────────────────────────────────────────────

def compute_duration(start_iso: Optional[str], end_iso: Optional[str]) -> tuple[Optional[int], str]:
    """Returns (minutes:int|None, label:str). label is 'In Progress' with
    no end time, 'h m' formatted once both timestamps parse."""
    if not start_iso or not end_iso:
        return None, "In Progress"
    try:
        start = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
        end = datetime.fromisoformat(str(end_iso).replace("Z", "+00:00"))
        minutes = max(0, int((end - start).total_seconds() // 60))
        return minutes, f"{minutes // 60}h {minutes % 60}m"
    except (ValueError, TypeError):
        return None, "In Progress"


# ─── Admin resolve ──────────────────────────────────────────────────────

_CHECK_IN_DECISIONS = {"late", "half_day", "short_leave"}
_CHECK_OUT_DECISIONS = {"early_leave", "half_day", "overtime", "late", "short_leave"}
_CHECK_OUT_STATUS_BY_DECISION = {
    "early_leave": "early", "late": "late", "overtime": "overtime", "short_leave": "short_leave",
}

# half_day and short_leave are both day-level outcomes (like the local
# node's own day_status vocabulary) rather than a checkout sub-classification,
# so both take the same short-circuit path in resolve_attendance_exception
# below -- see _DAY_LEVEL_DECISIONS.
_DAY_LEVEL_DECISIONS = {"half_day", "short_leave"}

# Which decisions actually make sense for a given check_out_hold_reason.
# The flat _CHECK_OUT_DECISIONS set above only validates "is this decision
# a real one at all" -- it never checked it against WHY the checkout was
# held, so 'half_day' (meant for someone who left hours early) was being
# offered for a plain late-departure hold too. A hold_reason not listed
# here (None, or a future value) falls back to the full set -- permissive
# by default rather than silently blocking a legitimate resolve.
#
# short_leave only ever applies to an 'early' hold (a manager-sanctioned
# shorter day shows up as an early checkout, same as half_day/early_leave
# do) -- a 'late' checkout hold (stayed too long / left later than
# scheduled) has no short_leave reading, so it's deliberately left out of
# that set.
_CHECK_OUT_DECISIONS_BY_HOLD_REASON = {
    "late": {"late", "overtime"},
    "early": {"early_leave", "half_day", "short_leave"},
}

# The fixed "awaiting admin review" fragments written at check-in/check-out
# time (see _CHECK_IN_NOTES / _CHECK_OUT_NOTES above). Held as a set of exact
# strings, not a pattern, because they're written verbatim by this same
# module -- resolve_attendance_exception needs to recognize and remove
# precisely these, not guess at a substring match against admin-typed text.
_PENDING_NOTE_FRAGMENTS = {
    _CHECK_IN_NOTES["late"],
    _CHECK_OUT_NOTES["early"],
    _CHECK_OUT_NOTES["late"],
}

_CHECK_IN_RESOLUTION_TEXT = {
    "late": "Admin resolved: present (late arrival confirmed).",
    "half_day": "Admin resolved: marked as half day.",
    "short_leave": "Admin resolved: marked as short leave (manager-approved).",
}
_CHECK_OUT_RESOLUTION_TEXT = {
    "early_leave": "Admin resolved: early leave confirmed.",
    "late": "Admin resolved: late departure confirmed.",
    "overtime": "Admin resolved: overtime confirmed.",
    "half_day": "Admin resolved: marked as half day.",
    "short_leave": "Admin resolved: marked as short leave (manager-approved).",
}


def _strip_pending_fragments(existing: Optional[str]) -> Optional[str]:
    """Removes the fixed pending fragment(s) from a notes string built by
    _append_note (segments joined with ' | '), so resolve_attendance_exception
    can replace stale 'awaiting admin review' text with an actual decision
    instead of only ever appending on top of it. Any other segment (an
    earlier admin note, an 'early check-in' informational note, etc.) is
    left untouched and in its original order."""
    existing = _clean_text(existing)
    if not existing:
        return None
    segments = [s.strip() for s in existing.split(" | ") if s.strip()]
    kept = [s for s in segments if s not in _PENDING_NOTE_FRAGMENTS]
    return " | ".join(kept) if kept else None


def _resolution_note_text(leg: str, decision: str) -> Optional[str]:
    """The concrete decision statement that replaces the pending fragment --
    notes should say what actually happened, not just have the 'awaiting
    review' text silently vanish."""
    if leg == "check_in":
        return _CHECK_IN_RESOLUTION_TEXT.get(decision)
    return _CHECK_OUT_RESOLUTION_TEXT.get(decision)


# leave_type used for every attendance-exception-derived half day. Kept
# distinct from the employee-picked categories (Annual/Sick/...) so it
# never touches a person's real leave balance/history -- it's an
# operational adjustment, not a leave they applied for. Org admins give it
# its own paid/unpaid/deduction rate via payroll's leaveTypeRules, same as
# any other leave_type.
_ATTENDANCE_ADJUSTMENT_LEAVE_TYPE = "attendance_adjustment"


def _staff_timing_fields(org_id: str, staff_id: str) -> Optional[dict]:
    """Narrow client_staff read carrying exactly what
    support_db_attendance_gate.resolve_timing_source needs (id,
    shift_id_ref, check_in_grace_override, check_out_grace_override,
    person_code) -- mirrors the narrow selects support_db.py itself uses
    at mark-time, rather than routing through get_client_staff_member's
    heavier, dashboard-shaped serialization (which doesn't even carry the
    grace-override columns through)."""
    sb = get_supabase()
    result = (
        sb.table("client_staff")
        .select("id, people_type, shift_id_ref, person_code, check_in_grace_override, check_out_grace_override")
        .eq("id", str(staff_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def compute_overtime_hours(
    *, org_id: str, branch_id: Optional[str], staff_id: str,
    check_out_timestamp: str, branch_zone: ZoneInfo,
) -> float:
    """Hours the actual checkout landed past the scheduled cutoff (shift's
    check_out_time + check_out_grace_minutes) -- the same cutoff
    resolve_check_out_status compared against when it first classified this
    checkout as 'late' and put it on hold. Reuses resolve_timing_source so
    this respects the full precedence chain (manual override > half-day
    window > staff shift > branch default) rather than re-guessing which
    shift applies. Returns 0.0 (never negative, never raises) if the window
    or timestamp can't be resolved -- callers treat 0 as "nothing to
    credit" rather than writing a zero-hour overtime row."""
    if not branch_id:
        return 0.0
    try:
        import support_db_attendance_gate as _gate_db

        staff = _staff_timing_fields(org_id, staff_id)
        if not staff:
            return 0.0
        checkout_dt = _parse_iso_dt(check_out_timestamp)
        if checkout_dt is None:
            return 0.0

        window = _gate_db.resolve_timing_source(
            org_id=org_id,
            branch_id=branch_id,
            staff=staff,
            people_type=staff.get("people_type") or "staff",
            event_time_utc=checkout_dt,
        )
        if not window or not window.get("check_out_time"):
            return 0.0

        parts = str(window["check_out_time"]).split(":")
        if len(parts) < 2:
            return 0.0
        target_minutes = int(parts[0]) * 60 + int(parts[1])
        grace = int(window.get("check_out_grace_minutes") or 0)
        cutoff_minutes = target_minutes + grace

        local_dt = checkout_dt if checkout_dt.tzinfo else checkout_dt.replace(tzinfo=timezone.utc)
        local = local_dt.astimezone(branch_zone)
        actual_minutes = local.hour * 60 + local.minute

        excess_minutes = actual_minutes - cutoff_minutes
        if excess_minutes <= 0:
            return 0.0
        return round(excess_minutes / 60.0, 2)
    except Exception:
        logger.exception("Failed to compute overtime hours for staff=%s", staff_id)
        return 0.0


def compute_short_leave_hours(
    *, org_id: str, branch_id: Optional[str], staff_id: str,
    check_out_timestamp: str, branch_zone: ZoneInfo,
) -> tuple[float, float]:
    """Hours the actual checkout landed BEFORE the shift's scheduled
    check_out_time -- the counterpart to compute_overtime_hours above, same
    resolve_timing_source precedence chain, same "0.0 and never raise" degrade
    contract. Unlike overtime, this deliberately does NOT subtract a grace
    period first: a short-leave row only exists because check_out_hold_reason
    was already 'early' (i.e., outside grace), so re-applying grace here
    would double-discount the same window resolve_check_out_status already
    accounted for once.

    Returns (hours_short, shift_scheduled_hours) -- the second value is the
    shift's full check_in_time-to-check_out_time span, which payroll_engine.py
    uses to derive a per-hour deduction rate from the per-day rate (a hard-
    coded "8 hour day" would be wrong for any shift configured differently).
    (0.0, 0.0) if the window, either time, or the timestamp can't be
    resolved -- payroll_engine.py falls back to the flat shortLeavePolicy
    fraction for any row where shift_scheduled_hours is 0.0, so an
    unresolvable window degrades to a less-precise deduction rather than a
    silently missing one.
    """
    if not branch_id:
        return 0.0, 0.0
    try:
        import support_db_attendance_gate as _gate_db

        staff = _staff_timing_fields(org_id, staff_id)
        if not staff:
            return 0.0, 0.0
        checkout_dt = _parse_iso_dt(check_out_timestamp)
        if checkout_dt is None:
            return 0.0, 0.0

        window = _gate_db.resolve_timing_source(
            org_id=org_id,
            branch_id=branch_id,
            staff=staff,
            people_type=staff.get("people_type") or "staff",
            event_time_utc=checkout_dt,
        )
        if not window or not window.get("check_out_time") or not window.get("check_in_time"):
            return 0.0, 0.0

        out_parts = str(window["check_out_time"]).split(":")
        in_parts = str(window["check_in_time"]).split(":")
        if len(out_parts) < 2 or len(in_parts) < 2:
            return 0.0, 0.0
        target_minutes = int(out_parts[0]) * 60 + int(out_parts[1])
        check_in_minutes = int(in_parts[0]) * 60 + int(in_parts[1])
        # Overnight shifts (check_out_time earlier in the clock than
        # check_in_time, e.g. 22:00 -> 06:00) would otherwise compute a
        # negative span.
        shift_minutes = target_minutes - check_in_minutes
        if shift_minutes <= 0:
            shift_minutes += 24 * 60
        shift_hours = round(shift_minutes / 60.0, 2)

        local_dt = checkout_dt if checkout_dt.tzinfo else checkout_dt.replace(tzinfo=timezone.utc)
        local = local_dt.astimezone(branch_zone)
        actual_minutes = local.hour * 60 + local.minute

        short_minutes = target_minutes - actual_minutes
        if short_minutes <= 0:
            return 0.0, shift_hours
        return round(short_minutes / 60.0, 2), shift_hours
    except Exception:
        logger.exception("Failed to compute short-leave hours for staff=%s", staff_id)
        return 0.0, 0.0


def notify_payroll_decision_pending(
    *, org_id: str, branch_id: Optional[str], staff_id: str, staff_name: str,
    attendance_id, day_status: str, event_local_str: str,
) -> None:
    """Fired once, the moment a local-node row's day_status FIRST lands as
    one of the classified values (half_day/short_leave/late/overtime) --
    i.e. classification just happened on-device and this row now needs an
    admin's include/exclude payroll call (see
    list_local_node_payroll_pending/set_local_node_payroll_decision).

    Callers MUST only invoke this on the transition INTO a classified
    state (previous day_status != new day_status) -- push_node_attendance
    recomputes and rewrites day_status on every re-sync of the same row
    (self-healing against stale classifications -- see that function's own
    comment), so calling this unconditionally would re-notify on every
    heartbeat sync of an already-classified, still-undecided row.

    Mirrors notify_check_in_exception/notify_check_out_exception's
    manager+broadcast routing and soft-fail contract exactly, but routes to
    the payroll-decision queue instead of the classification screen -- this
    row is already classified; only the payroll effect is still undecided.
    """
    branch_name = get_branch_name_for_notification(org_id, branch_id)
    where = f" at {branch_name}" if branch_name else ""
    label = day_status.replace("_", " ")
    try:
        # See notify_check_in_exception's comment: resolve_notification_target
        # returns a client_staff.id, so this must go through
        # recipient_staff_ids, not recipient_user_ids.
        manager_recipient = hierarchy_db.resolve_notification_target(org_id, staff_id)
        notifications_db.create_notification(
            org_id,
            branch_id=branch_id,
            module_key="attendance",
            event_type="attendance.payroll_decision.pending",
            title=f"Payroll decision needed — {staff_name}",
            body=f"{staff_name}'s {label} day{where} ({event_local_str}) needs an include/exclude call for payroll.",
            actor_name=staff_name,
            target_entity_id=str(attendance_id),
            target_entity_type="attendance",
            target_route="/admin/attendance/payroll-decisions",
            metadata={
                "staff_id": str(staff_id),
                "attendance_id": str(attendance_id),
                "day_status": day_status,
            },
            recipient_staff_ids=[manager_recipient] if manager_recipient else None,
            also_broadcast=True,
        )
    except Exception:
        # Never fail the attendance sync because a notification couldn't
        # be recorded -- same soft-fail contract as the other two triggers.
        pass


def create_half_day_adjustment(
    *, org_id: str, staff_id: Optional[str], attendance_id: str,
    half_day_period: str, resolved_by: Optional[str] = None,
    branch_id: Optional[str] = None, event_timestamp: Optional[str],
) -> None:
    """Links an attendance exception (or local-node classification)
    resolved as half_day to Leave Management, so it deducts from payroll
    the same way a pre-planned half-day leave request does
    (get_approved_leaves_for_payroll_period only reads approved
    leave_requests rows).

    half_day_period is the caller's job to determine ('first_half' /
    'second_half') -- this function is leg-agnostic on purpose so both the
    mobile/cloud exceptions flow (which has an explicit check_in/check_out
    leg) and the local-node sync path (which has no such leg, only a
    day-level classification) can call it. See _on_half_day_decided below
    for the leg-based derivation the mobile flow uses.

    Soft-fail by design, matching notify_check_in_exception/
    notify_check_out_exception in this same module: the attendance row
    write that triggered this has already committed by the time this
    runs, so a leave-creation problem here must never look like that write
    itself failed. It's logged loudly instead so it's visible in ops, not
    silently dropped."""
    if not staff_id or not event_timestamp:
        logger.warning(
            "Skipping half-day leave creation for attendance=%s: missing staff_id or event timestamp",
            attendance_id,
        )
        return
    if half_day_period not in ("first_half", "second_half"):
        logger.warning(
            "Skipping half-day leave creation for attendance=%s: invalid half_day_period=%r",
            attendance_id, half_day_period,
        )
        return

    branch_zone = _get_branch_zone(org_id, branch_id)
    local_date = local_date_str_iso(event_timestamp, branch_zone)
    if not local_date:
        logger.warning(
            "Skipping half-day leave creation for attendance=%s: could not derive local date",
            attendance_id,
        )
        return

    try:
        import support_db as _support_db  # deferred: support_db imports this module at load time

        leave = _support_db.create_client_leave_request(str(org_id), {
            "staff_id": staff_id,
            "branch_id": branch_id,
            "leave_type": _ATTENDANCE_ADJUSTMENT_LEAVE_TYPE,
            "half_day": True,
            "half_day_period": half_day_period,
            "start_date": local_date,
            "end_date": local_date,
            "reason": f"Auto-recorded from attendance exception resolution (attendance_id={attendance_id}).",
        })
        # Auto-approved: the resolve action IS the approval here -- this
        # isn't a request sitting in anyone's pending queue the way a
        # self-service leave application is. get_approved_leaves_for_
        # payroll_period only ever reads status='approved' rows, so payroll
        # would silently ignore this otherwise.
        _support_db.update_client_leave_status(
            str(leave.get("id")), str(org_id), "approved",
            approved_by=str(resolved_by) if resolved_by else "Attendance Exception",
        )
    except Exception:
        logger.exception(
            "Failed to create/approve half-day leave for attendance=%s staff=%s",
            attendance_id, staff_id,
        )


def create_short_leave_adjustment(
    *, org_id: str, staff_id: Optional[str], attendance_id: str,
    resolved_by: Optional[str] = None, branch_id: Optional[str] = None,
    event_timestamp: Optional[str],
) -> None:
    """Links an attendance exception (or local-node classification)
    resolved as short_leave to Leave Management -- the same visibility
    half_day already gets, but left PENDING rather than auto-approved:
    whether a short_leave counts against payroll is exactly the per-record
    admin decision the payroll-decision columns exist for (see
    set_local_node_payroll_decision), so the linked leave row's status
    tracks that decision (approved on 'include', rejected on 'exclude')
    instead of being pre-approved the way half_day's is.

    Leg-agnostic, same as create_half_day_adjustment -- callable from both
    the mobile/cloud exceptions flow and the local-node sync path.

    Soft-fail by design, same rationale as create_half_day_adjustment."""
    if not staff_id or not event_timestamp:
        logger.warning(
            "Skipping short-leave creation for attendance=%s: missing staff_id or event timestamp",
            attendance_id,
        )
        return

    branch_zone = _get_branch_zone(org_id, branch_id)
    local_date = local_date_str_iso(event_timestamp, branch_zone)
    if not local_date:
        logger.warning(
            "Skipping short-leave creation for attendance=%s: could not derive local date",
            attendance_id,
        )
        return

    try:
        import support_db as _support_db  # deferred: support_db imports this module at load time

        # Left pending on purpose -- see docstring. set_local_node_payroll_
        # decision is what approves/rejects it once the admin makes the
        # include/exclude call.
        _support_db.create_client_leave_request(str(org_id), {
            "staff_id": staff_id,
            "branch_id": branch_id,
            "leave_type": _ATTENDANCE_ADJUSTMENT_LEAVE_TYPE,
            "half_day": False,
            "start_date": local_date,
            "end_date": local_date,
            "reason": f"Auto-recorded from attendance exception resolution (attendance_id={attendance_id}).",
        })
    except Exception:
        logger.exception(
            "Failed to create short-leave request for attendance=%s staff=%s",
            attendance_id, staff_id,
        )


def _on_half_day_decided(
    *, org_id: str, staff_id: Optional[str], attendance_id: str,
    leg: str, resolved_by: Optional[str], branch_id: Optional[str],
    event_timestamp: Optional[str],
) -> None:
    """Mobile/cloud exceptions-flow wrapper around create_half_day_adjustment.

    The half (first_half/second_half) is derived from the leg, not asked
    of the admin or computed from the shift midpoint: a late check-in
    means the missing time was the morning (first_half); an early
    check-out means it was the afternoon (second_half). Direct and
    deterministic -- half_day is only reachable via one of those two holds
    (never both at once for the same attendance row), so there's no
    conflicting-pair case to guard against."""
    half_day_period = "first_half" if leg == "check_in" else "second_half"
    create_half_day_adjustment(
        org_id=org_id, staff_id=staff_id, attendance_id=attendance_id,
        half_day_period=half_day_period, resolved_by=resolved_by,
        branch_id=branch_id, event_timestamp=event_timestamp,
    )


def _on_short_leave_decided(
    *, org_id: str, staff_id: Optional[str], attendance_id: str,
    resolved_by: Optional[str], branch_id: Optional[str],
    event_timestamp: Optional[str],
) -> None:
    """Mobile/cloud exceptions-flow wrapper around
    create_short_leave_adjustment -- kept as its own named function to
    mirror _on_half_day_decided/_on_overtime_decided's naming pattern at
    the resolve_attendance_exception call site."""
    create_short_leave_adjustment(
        org_id=org_id, staff_id=staff_id, attendance_id=attendance_id,
        resolved_by=resolved_by, branch_id=branch_id,
        event_timestamp=event_timestamp,
    )


def create_overtime_adjustment(
    *, org_id: str, staff_id: Optional[str], attendance_id: str,
    resolved_by: Optional[str] = None, branch_id: Optional[str] = None,
    check_out_timestamp: Optional[str],
) -> None:
    """Links an attendance exception (or local-node classification)
    resolved as overtime to Overtime Management, so it's visible there the
    same way a self-service overtime request is. For the mobile/cloud
    exceptions flow this is only reachable for the check_out leg with
    hold_reason='late' -- see _CHECK_OUT_DECISIONS_BY_HOLD_REASON. Also
    callable directly from the local-node sync path, which has no
    equivalent leg concept.

    Deliberately does NOT auto-approve the created row (unlike
    create_half_day_adjustment's linked leave). Confirming 'overtime' here
    is only the CLASSIFICATION decision -- whether it actually counts
    against payroll is a separate include/exclude call the admin makes
    afterward on the Payroll Decisions screen (see
    _notify_payroll_decision_needed below and
    set_local_node_payroll_decision, which is what flips this row's status
    to approved/rejected once that second decision is made).
    get_approved_overtime_hours_for_payroll_period only sums
    status='approved' rows, so leaving this pending means it correctly
    doesn't count until the admin explicitly includes it.

    Soft-fail by design, same rationale as create_half_day_adjustment: the
    attendance write itself has already committed."""
    if not staff_id or not check_out_timestamp:
        logger.warning(
            "Skipping overtime request creation for attendance=%s: missing staff_id or check-out timestamp",
            attendance_id,
        )
        return

    branch_zone = _get_branch_zone(org_id, branch_id)
    local_date = local_date_str_iso(check_out_timestamp, branch_zone)
    if not local_date:
        logger.warning(
            "Skipping overtime request creation for attendance=%s: could not derive local date",
            attendance_id,
        )
        return

    hours = compute_overtime_hours(
        org_id=org_id, branch_id=branch_id, staff_id=staff_id,
        check_out_timestamp=check_out_timestamp, branch_zone=branch_zone,
    )
    if hours <= 0:
        # Nothing to credit -- e.g. the shift window couldn't be resolved,
        # or the actual checkout landed at/before the scheduled cutoff
        # after all. Don't write a zero-hour overtime row.
        logger.info(
            "No overtime hours computed for attendance=%s staff=%s; skipping overtime request",
            attendance_id, staff_id,
        )
        return

    try:
        import support_db as _support_db  # deferred: support_db imports this module at load time

        # Left in create_client_overtime_request's default status='pending'
        # on purpose -- see this function's docstring. The payroll
        # include/exclude call (set_local_node_payroll_decision) is what
        # approves or rejects it.
        _support_db.create_client_overtime_request(str(org_id), {
            "staff_id": staff_id,
            "branch_id": branch_id,
            "ot_date": local_date,
            "hours": hours,
            "reason": f"Auto-recorded from attendance exception resolution (attendance_id={attendance_id}).",
        })
    except Exception:
        logger.exception(
            "Failed to create/approve overtime request for attendance=%s staff=%s",
            attendance_id, staff_id,
        )


def _on_overtime_decided(
    *, org_id: str, staff_id: Optional[str], attendance_id: str,
    resolved_by: Optional[str], branch_id: Optional[str],
    check_out_timestamp: Optional[str],
) -> None:
    """Mobile/cloud exceptions-flow wrapper around
    create_overtime_adjustment -- kept as its own named function so the
    resolve_attendance_exception call site below doesn't change."""
    create_overtime_adjustment(
        org_id=org_id, staff_id=staff_id, attendance_id=attendance_id,
        resolved_by=resolved_by, branch_id=branch_id,
        check_out_timestamp=check_out_timestamp,
    )


def _notify_payroll_decision_needed(
    *, org_id: str, branch_id: Optional[str], staff_id: Optional[str],
    attendance_id: str, day_status: str, event_timestamp: Optional[str],
) -> None:
    """Looks up the staff name and formats the local event time, then
    delegates to notify_payroll_decision_pending -- split out from
    resolve_attendance_exception because, unlike the local-node sync path
    (which already has staff/branch context in hand), the resolve flow
    only has staff_id/branch_id and needs a small lookup first. Soft-fail
    matches notify_payroll_decision_pending's own contract: never raises,
    so a lookup or notification failure can't undo the resolve that
    already committed.

    Called for BOTH half_day and short_leave resolutions -- see the two
    call sites in resolve_attendance_exception. overtime is deliberately
    NOT included here: it's credited via a dedicated approved
    overtime_requests row that payroll_engine sums independently (ot_hours
    is a separate top-level input, not read from attendance_rows), so
    there's no parallel attendance-row decision to surface for it."""
    if not staff_id or not event_timestamp:
        return
    try:
        sb = get_supabase()
        staff_row = (
            sb.table("client_staff").select("name").eq("id", str(staff_id)).limit(1).execute()
        )
        staff_name = (staff_row.data[0].get("name") if staff_row.data else None) or "Staff member"

        branch_zone = _get_branch_zone(org_id, branch_id)
        event_dt = _parse_iso_dt(event_timestamp)
        event_local_str = (
            event_dt.astimezone(branch_zone).strftime("%b %d, %I:%M %p") if event_dt else ""
        )

        notify_payroll_decision_pending(
            org_id=org_id,
            branch_id=str(branch_id) if branch_id else None,
            staff_id=str(staff_id),
            staff_name=staff_name,
            attendance_id=attendance_id,
            day_status=day_status,
            event_local_str=event_local_str,
        )
    except Exception:
        logger.exception(
            "Failed to notify payroll decision pending for attendance=%s", attendance_id,
        )

def resolve_attendance_exception(
    org_id: str,
    attendance_id: str,
    leg: str,
    decision: str,
    *,
    note: Optional[str] = None,
    resolved_by: Optional[str] = None,
) -> dict:
    """Admin picks the final outcome for a held check-in or check-out.

    leg: 'check_in' | 'check_out'
    decision:
      check_in  -> 'late' (present, just late) | 'half_day' | 'short_leave'
      check_out -> hold_reason 'late'  -> 'late' | 'overtime'
                   hold_reason 'early' -> 'early_leave' | 'half_day' | 'short_leave'
                   (an unrecognized/missing hold_reason falls back to
                   accepting any of 'early_leave' | 'late' | 'overtime' |
                   'half_day' | 'short_leave', see
                   _CHECK_OUT_DECISIONS_BY_HOLD_REASON)

    Clears the relevant hold_reason, sets day_status, appends the admin's
    note (if any) to the notes column, and records resolved_by/resolved_at.
    Raises ValueError for bad input, a decision that doesn't fit the
    actual hold_reason, or a row not owned by this org.
    """
    leg = (leg or "").strip()
    decision = (decision or "").strip()
    org_key = str(org_id)

    if leg == "check_in":
        if decision not in _CHECK_IN_DECISIONS:
            raise ValueError(f"decision must be one of {sorted(_CHECK_IN_DECISIONS)} for check_in")
    elif leg == "check_out":
        if decision not in _CHECK_OUT_DECISIONS:
            raise ValueError(f"decision must be one of {sorted(_CHECK_OUT_DECISIONS)} for check_out")
    else:
        raise ValueError("leg must be 'check_in' or 'check_out'")

    sb = get_supabase()
    existing_result = (
        sb.table("attendance")
        .select("id, notes, day_status, staff_id, branch_id, timestamp, check_out_timestamp, check_out_hold_reason")
        .eq("id", str(attendance_id))
        .eq("org_id", org_key)
        .limit(1)
        .execute()
    )
    if not existing_result.data:
        raise ValueError("Attendance record not found for this organization")
    existing = existing_result.data[0]

    if leg == "check_out":
        hold_reason = (existing.get("check_out_hold_reason") or "").strip().lower()
        allowed_for_reason = _CHECK_OUT_DECISIONS_BY_HOLD_REASON.get(hold_reason)
        if allowed_for_reason and decision not in allowed_for_reason:
            raise ValueError(
                f"decision must be one of {sorted(allowed_for_reason)} "
                f"for a '{hold_reason}' checkout"
            )

    # Replace the stale "awaiting admin review" pending fragment with an
    # actual resolution statement rather than only ever appending an
    # [Admin] note on top of it -- otherwise a resolve with no typed note
    # left the pending phrasing sitting there forever even though the hold
    # itself was correctly cleared underneath it.
    notes_without_pending = _strip_pending_fragments(existing.get("notes"))
    resolved_notes = _append_note(notes_without_pending, _resolution_note_text(leg, decision))
    resolved_notes = _append_note(resolved_notes, f"[Admin] {note}" if note else None)

    update: dict = {
        "notes": resolved_notes,
        "resolved_at": _now_iso(),
    }
    if resolved_by:
        update["resolved_by"] = str(resolved_by)

    if leg == "check_in":
        update["check_in_hold_reason"] = None
        update["check_in_confirmed"] = True
        # half_day, short_leave, AND late are all day-level outcomes now --
        # 'late' used to collapse into a plain 'present' day here, which
        # meant a confirmed-late check-in was indistinguishable from an
        # on-time one downstream (stats, payroll's lateComingPolicy
        # occurrence counting, etc). _CHECK_IN_DECISIONS only ever contains
        # these three values, so this is just "trust the decision" rather
        # than a lookup against _DAY_LEVEL_DECISIONS.
        update["day_status"] = decision
    else:
        update["check_out_hold_reason"] = None
        if decision in _DAY_LEVEL_DECISIONS:
            update["day_status"] = decision
        else:
            update["check_out_status"] = _CHECK_OUT_STATUS_BY_DECISION[decision]
            # Don't clobber a half_day/short_leave already set on the
            # check-in side.
            if existing.get("day_status") not in _DAY_LEVEL_DECISIONS:
                update["day_status"] = "overtime" if decision == "overtime" else "present"

    try:
        result = sb.table("attendance").update(update).eq("id", str(attendance_id)).eq("org_id", org_key).execute()
    except Exception as exc:
        # resolved_by/resolved_at may not exist yet if the migration hasn't
        # been run — retry once without them rather than failing the
        # admin's resolve action outright.
        if "resolved_by" in str(exc).lower() or "resolved_at" in str(exc).lower():
            update.pop("resolved_by", None)
            update.pop("resolved_at", None)
            result = sb.table("attendance").update(update).eq("id", str(attendance_id)).eq("org_id", org_key).execute()
        else:
            raise
    if not result.data:
        raise RuntimeError("Failed to resolve attendance exception")

    if decision == "half_day":
        event_timestamp = (
            existing.get("check_out_timestamp") if leg == "check_out" else existing.get("timestamp")
        ) or existing.get("timestamp")
        _on_half_day_decided(
            org_id=org_key,
            staff_id=existing.get("staff_id"),
            attendance_id=str(attendance_id),
            leg=leg,
            resolved_by=resolved_by,
            branch_id=existing.get("branch_id"),
            event_timestamp=event_timestamp,
        )
        # Auto-approving the linked half-day leave above accounts for the
        # deduction by default, but the admin may still want to override
        # it (e.g. a goodwill half-day that shouldn't dock pay). Surface
        # the same include/exclude decision short_leave gets below --
        # payroll_engine's attendance/leave reconciliation always zeroes
        # the auto-created leave's contribution whenever attendance exists
        # for the same date (see _reconcile_leave_against_attendance), so
        # this attendance row's own check_out_payroll_decision is what
        # actually governs the deduction; the leave record is untouched.
        _notify_payroll_decision_needed(
            org_id=org_key,
            branch_id=existing.get("branch_id"),
            staff_id=existing.get("staff_id"),
            attendance_id=str(attendance_id),
            day_status="half_day",
            event_timestamp=event_timestamp,
        )
    elif decision == "overtime":
        # Only reachable for leg == 'check_out' with hold_reason == 'late'
        # (see _CHECK_OUT_DECISIONS_BY_HOLD_REASON), so check_out_timestamp
        # is always the relevant event time here.
        _on_overtime_decided(
            org_id=org_key,
            staff_id=existing.get("staff_id"),
            attendance_id=str(attendance_id),
            resolved_by=resolved_by,
            branch_id=existing.get("branch_id"),
            check_out_timestamp=existing.get("check_out_timestamp"),
        )
        # Confirming overtime is only the classification -- _on_overtime_
        # decided deliberately leaves the linked overtime_requests row
        # pending. Surface the same include/exclude call half_day/
        # short_leave get, so payroll inclusion is always its own explicit
        # admin decision (never an automatic side effect of resolving the
        # exception).
        _notify_payroll_decision_needed(
            org_id=org_key,
            branch_id=existing.get("branch_id"),
            staff_id=existing.get("staff_id"),
            attendance_id=str(attendance_id),
            day_status="overtime",
            event_timestamp=existing.get("check_out_timestamp"),
        )
    elif decision == "short_leave":
        event_timestamp = (
            existing.get("check_out_timestamp") if leg == "check_out" else existing.get("timestamp")
        ) or existing.get("timestamp")
        # Unlike half_day, the linked leave is left PENDING (see
        # create_short_leave_adjustment) -- whether a short_leave counts
        # against payroll is exactly the per-record admin decision the
        # payroll-decision columns exist for, so the leave's own
        # approved/rejected status tracks that decision instead of being
        # pre-approved. set_local_node_payroll_decision is what flips it.
        _on_short_leave_decided(
            org_id=org_key,
            staff_id=existing.get("staff_id"),
            attendance_id=str(attendance_id),
            resolved_by=resolved_by,
            branch_id=existing.get("branch_id"),
            event_timestamp=event_timestamp,
        )
        _notify_payroll_decision_needed(
            org_id=org_key,
            branch_id=existing.get("branch_id"),
            staff_id=existing.get("staff_id"),
            attendance_id=str(attendance_id),
            day_status="short_leave",
            event_timestamp=event_timestamp,
        )
    elif decision == "late" and leg == "check_in":
        # Deliberately no linked leave/overtime row -- a confirmed-late
        # check-in isn't a leave or an overtime event, it's a count. The
        # org's lateComingPolicy (payroll policy) decides how N late
        # arrivals in a period convert into a half/full day deduction, so
        # what this needs is a payroll decision on THIS row (tracked via
        # check_in_payroll_decision -- see set_local_node_payroll_decision)
        # rather than a separate record elsewhere.
        _notify_payroll_decision_needed(
            org_id=org_key,
            branch_id=existing.get("branch_id"),
            staff_id=existing.get("staff_id"),
            attendance_id=str(attendance_id),
            day_status="late",
            event_timestamp=existing.get("timestamp"),
        )

    return result.data[0]


def list_pending_exceptions(org_id: str, branch_id: Optional[str] = None, limit: int = 200) -> list[dict]:
    """Every attendance row still awaiting admin resolution, for the
    Attendance Exceptions admin screen — not just the notification feed,
    so a dismissed/lost notification never hides a still-pending row.

    Filters check_in_hold_reason/check_out_hold_reason IS NOT NULL directly
    in the query (via or_()), not in Python after the fact -- pending rows
    are a small minority of all attendance rows, so filtering client-side
    after a plain "most recent 200 of any status" fetch would silently drop
    older pending exceptions once an org has more than `limit` more-recent
    non-pending rows. Pushing the filter down means limit/order apply to
    the pending set itself, which is what "200 most recent exceptions"
    should actually mean.
    """
    sb = get_supabase()
    safe_limit = max(1, min(int(limit or 200), 1000))
    query = (
        sb.table("attendance")
        .select("*")
        .eq("org_id", str(org_id))
        .or_("check_in_hold_reason.not.is.null,check_out_hold_reason.not.is.null")
        .order("timestamp", desc=True)
        .limit(safe_limit)
    )
    if branch_id:
        query = query.eq("branch_id", str(branch_id))
    result = query.execute()
    return result.data or []


# ─── Phase 3: local-node payroll decision ──────────────────────────────
#
# A DIFFERENT query/action pair from list_pending_exceptions/
# resolve_attendance_exception above, on purpose. Those two handle rows
# still AWAITING classification (a hold_reason is set, day_status isn't
# decided yet). The functions below handle the opposite case: the local
# node already classified the row (an operator resolved it on-device
# before syncing — see push_node_attendance / local_db.py's
# mark_held_*_half_day/short_leave/late/overtime), so there's nothing left
# to classify. What's still missing is the SEPARATE payroll question: does
# this classified day actually count against payroll or not.
#
# A local-node day_status is one value for the whole day — the node has no
# independent check-in-leg/check-out-leg decision the way the cloud
# exceptions flow does (see resolve_attendance_exception's leg param) — so
# there's only ever one decision to make per row, and it's always written
# to check_out_payroll_decision, the column get_staff_attendance_for_
# payroll_period/payroll_engine already read. check_in_payroll_decision is
# reserved for the cloud/mobile exceptions flow, where check-in and
# check-out can each independently need a decision, and is left untouched
# for local-node rows.

_LOCAL_NODE_RESOLVED_STATUSES = {"half_day", "short_leave", "late", "overtime"}
_PAYROLL_DECISIONS = {"include", "exclude"}

_PAYROLL_DECISION_NOTE_TEXT = {
    "include": "Included in payroll.",
    "exclude": "Excluded from payroll.",
}


def list_local_node_payroll_pending(
    org_id: str, branch_id: Optional[str] = None, limit: int = 200,
) -> list[dict]:
    """Attendance rows already classified but with no payroll include/
    exclude decision recorded yet, across BOTH capture channels -- the
    source of truth for the Phase 3 admin screen.

    half_day/short_leave/overtime now behave identically on both channels
    (local-node classification and mobile/cloud exception resolution both
    call create_half_day_adjustment / create_short_leave_adjustment /
    create_overtime_adjustment), so both channels are scoped the same way
    here too:
      - half_day: linked leave is auto-approved on creation, but the
        deduction is still gated by this row's own payroll decision (see
        set_local_node_payroll_decision's half_day comment) -- included
        here so that decision always gets made.
      - short_leave: linked leave is created PENDING -- this decision is
        what approves/rejects it.
      - overtime: linked overtime_requests row is created PENDING -- same,
        this decision approves/rejects it.
      - late (check-in leg only -- see resolve_attendance_exception /
        push_node_attendance): no linked leave/overtime row at all,
        deliberately -- a late arrival is a COUNT the org's
        lateComingPolicy converts into a half/full-day deduction once a
        threshold is crossed, not an individual adjustment record. This
        decision (recorded on check_in_payroll_decision, not
        check_out_payroll_decision -- see below) is what marks a given
        late day as counted/excluded for that threshold.

    Returns [] (rather than raising) if the payroll-decision columns
    haven't been migrated in for this org yet -- same "not yet migrated,
    nothing to show" behavior as get_staff_attendance_for_payroll_period's
    fallback, since there's genuinely nothing decidable without those
    columns.
    """
    sb = get_supabase()
    safe_limit = max(1, min(int(limit or 200), 1000))
    local_node_statuses = ",".join(sorted(_LOCAL_NODE_RESOLVED_STATUSES))
    query = (
        sb.table("attendance")
        .select("*")
        .eq("org_id", str(org_id))
        .or_(
            # Local node: one decision per day, always on check_out_payroll_
            # decision (see set_local_node_payroll_decision's module-level
            # comment) -- covers half_day/short_leave/late/overtime alike.
            f"and(capture_channel.eq.local_node,day_status.in.({local_node_statuses}),"
            "check_out_payroll_decision.is.null),"
            # Mobile/cloud: half_day/short_leave/overtime each still need
            # their own check_out_payroll_decision call...
            "and(capture_channel.eq.mobile_app,day_status.in.(half_day,short_leave,overtime),"
            "check_out_payroll_decision.is.null),"
            # ...while a confirmed-late CHECK-IN is tracked on its own,
            # separate column -- a row can independently have a pending
            # check-out-side decision (half_day/short_leave/overtime) AND a
            # pending check-in-side 'late' decision at once, so these can't
            # share one null-check.
            "and(capture_channel.eq.mobile_app,day_status.eq.late,"
            "check_in_payroll_decision.is.null)"
        )
        .order("timestamp", desc=True)
        .limit(safe_limit)
    )
    if branch_id:
        query = query.eq("branch_id", str(branch_id))

    try:
        result = query.execute()
    except Exception as exc:
        if _is_missing_column(exc, "check_out_payroll_decision") or _is_missing_column(exc, "check_in_payroll_decision"):
            logger.warning(
                "list_local_node_payroll_pending: payroll-decision columns not found "
                "(migration_add_payroll_decision_fields.sql not yet applied?) for org=%s",
                org_id,
            )
            return []
        raise
    return result.data or []

def _find_overtime_request_for_attendance(sb, org_id: str, attendance_id: str) -> Optional[dict]:
    """Locates the overtime_requests row _on_overtime_decided created for a
    given attendance row. overtime_requests has no attendance_id column, so
    the link is the reason text it's written with -- 'Auto-recorded from
    attendance exception resolution (attendance_id={attendance_id}).' --
    the same identifier set_local_node_payroll_decision already has in
    hand. Returns None (not raise) if the table is missing or no match is
    found, same degrade-not-break contract the rest of this module uses."""
    try:
        result = (
            sb.table("overtime_requests")
            .select("id, status")
            .eq("org_id", str(org_id))
            .ilike("reason", f"%attendance_id={attendance_id})%")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        if _is_missing_column(exc, "overtime_requests"):
            return None
        raise
    return result.data[0] if result.data else None


def _find_leave_request_for_attendance(sb, org_id: str, attendance_id: str) -> Optional[dict]:
    """Locates the leave_requests row create_short_leave_adjustment created
    for a given attendance row -- same reason-text linking strategy as
    _find_overtime_request_for_attendance above (leave_requests has no
    attendance_id column either). Scoped to leave_type=attendance_adjustment
    so this never matches an unrelated, genuinely-requested leave that
    happens to share wording. half_day rows are auto-approved at creation
    and don't need this lookup (their deduction is governed by the
    attendance row's own payroll decision, not the leave's status -- see
    set_local_node_payroll_decision's half_day handling), so this is only
    ever called for short_leave."""
    try:
        result = (
            sb.table("leave_requests")
            .select("id, status")
            .eq("org_id", str(org_id))
            .eq("leave_type", _ATTENDANCE_ADJUSTMENT_LEAVE_TYPE)
            .ilike("reason", f"%attendance_id={attendance_id})%")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        if _is_missing_column(exc, "leave_requests"):
            return None
        raise
    return result.data[0] if result.data else None


def set_local_node_payroll_decision(
    org_id: str,
    attendance_id: str,
    decision: str,
    *,
    note: Optional[str] = None,
    decided_by: Optional[str] = None,
) -> dict:
    """Admin's include/exclude call on an already-classified attendance
    row, from either capture channel. The lighter Phase 3 counterpart to
    resolve_attendance_exception: the day_status classification already
    happened (on-device for local-node, or via resolve_attendance_exception
    for mobile/cloud), so this only ever sets a payroll-decision field
    (+ appends a note) — it never touches day_status, check_out_status, or
    either hold_reason column.

    decision: 'include' | 'exclude'. Raises ValueError for an invalid
    decision, a row not owned by this org, a row whose capture channel
    doesn't support a payroll decision, or a row with no resolved
    classification yet (nothing to decide on).

    Which column the decision is written to depends on WHICH leg the
    classification came from, not the capture channel:
      - local_node: always check_out_payroll_decision -- the node has one
        day_status for the whole day, so there's only ever one decision to
        make per row (see the module-level comment near
        _LOCAL_NODE_RESOLVED_STATUSES).
      - mobile_app, day_status='late': check_in_payroll_decision -- this
        is a check-IN-side classification (a confirmed-late arrival),
        independent of any check-out-side outcome the same row might also
        carry.
      - mobile_app, everything else (half_day/short_leave/overtime):
        check_out_payroll_decision, same as before.

    For a 'short_leave' or 'overtime' row (either channel now -- see
    create_short_leave_adjustment/create_overtime_adjustment), this also
    approves (decision='include') or rejects (decision='exclude') the
    linked leave_requests/overtime_requests row those functions created --
    that linked row's own status is what get_approved_leaves_for_payroll_
    period / get_approved_overtime_hours_for_payroll_period actually read,
    so the include/exclude call has to reach it, not just this attendance
    row's own payroll-decision column. 'late' has no linked row by design
    (see create_short_leave_adjustment's module-level rationale) -- the
    column write alone is the full effect for that case, feeding the org's
    lateComingPolicy occurrence count. 'half_day' also has no linked-row
    sync here: its leave is auto-approved at creation time and the
    deduction is governed entirely by this attendance row's own decision
    (see create_half_day_adjustment's docstring).
    """
    decision = (decision or "").strip().lower()
    if decision not in _PAYROLL_DECISIONS:
        raise ValueError(f"decision must be one of {sorted(_PAYROLL_DECISIONS)}")

    sb = get_supabase()
    org_key = str(org_id)
    existing_result = (
        sb.table("attendance")
        .select("id, notes, day_status, capture_channel")
        .eq("id", str(attendance_id))
        .eq("org_id", org_key)
        .limit(1)
        .execute()
    )
    if not existing_result.data:
        raise ValueError("Attendance record not found for this organization")
    existing = existing_result.data[0]

    capture_channel = existing.get("capture_channel")
    day_status = existing.get("day_status")
    if capture_channel not in ("local_node", "mobile_app"):
        raise ValueError("This attendance row's capture channel doesn't support a payroll decision")
    if capture_channel == "mobile_app" and day_status not in ("half_day", "short_leave", "overtime", "late"):
        # Mirrors list_local_node_payroll_pending's mobile scoping above.
        raise ValueError(
            "Mobile-sourced rows only need a payroll decision for "
            "half_day, short_leave, overtime, or late"
        )
    if day_status not in _LOCAL_NODE_RESOLVED_STATUSES:
        raise ValueError("This attendance row has no resolved classification to decide on yet")

    # See docstring: a mobile-sourced 'late' is a check-in-side decision
    # and gets its own column so it never collides with a separate
    # check-out-side decision on the same row.
    target_column = (
        "check_in_payroll_decision"
        if (capture_channel == "mobile_app" and day_status == "late")
        else "check_out_payroll_decision"
    )

    resolved_notes = _append_note(
        existing.get("notes"), f"[Payroll] {_PAYROLL_DECISION_NOTE_TEXT[decision]}"
    )
    resolved_notes = _append_note(resolved_notes, f"[Admin] {note}" if note else None)

    update: dict = {
        target_column: decision,
        "notes": resolved_notes,
        "payroll_decided_at": _now_iso(),
    }
    if decided_by:
        update["payroll_decided_by"] = str(decided_by)

    try:
        result = (
            sb.table("attendance").update(update).eq("id", str(attendance_id)).eq("org_id", org_key).execute()
        )
    except Exception as exc:
        # payroll_decided_by/payroll_decided_at may not exist yet if only
        # the decision columns (not the audit-trail columns) have been
        # migrated -- retry once without them, same degrade-not-break
        # pattern resolve_attendance_exception uses for resolved_by/
        # resolved_at.
        if "payroll_decided_by" in str(exc).lower() or "payroll_decided_at" in str(exc).lower():
            update.pop("payroll_decided_by", None)
            update.pop("payroll_decided_at", None)
            result = (
                sb.table("attendance").update(update).eq("id", str(attendance_id)).eq("org_id", org_key).execute()
            )
        else:
            raise
    if not result.data:
        raise RuntimeError("Failed to set payroll decision")

    if day_status == "overtime":
        # This is the call that actually gates payroll for an overtime day
        # -- the attendance-row column above is just this row's own record
        # of the call; get_approved_overtime_hours_for_payroll_period sums
        # overtime_requests.status directly, so that linked row has to
        # move too, or 'exclude' would silently do nothing and 'include'
        # would silently never count. Now applies to BOTH channels --
        # local-node overtime classifications create the same linked
        # overtime_requests row mobile ones do (see push_node_attendance).
        linked = _find_overtime_request_for_attendance(sb, org_key, str(attendance_id))
        if linked:
            try:
                overtime_status = "approved" if decision == "include" else "rejected"
                from support_db_payroll import update_client_overtime_status
                update_client_overtime_status(
                    str(linked["id"]), org_key, overtime_status,
                    approved_by=str(decided_by) if decided_by else "Attendance Exception",
                )
            except Exception:
                logger.exception(
                    "Failed to sync linked overtime request status for attendance=%s decision=%s",
                    attendance_id, decision,
                )
        else:
            logger.warning(
                "No linked overtime_requests row found for attendance=%s while setting payroll decision=%s",
                attendance_id, decision,
            )
    elif day_status == "short_leave":
        # Same idea as overtime above, but for the linked leave_requests
        # row create_short_leave_adjustment created -- get_approved_leaves_
        # for_payroll_period only sums status='approved' rows, so this has
        # to move for the include/exclude call to actually take effect.
        linked = _find_leave_request_for_attendance(sb, org_key, str(attendance_id))
        if linked:
            try:
                leave_status = "approved" if decision == "include" else "rejected"
                from support_db_payroll import update_client_leave_status
                update_client_leave_status(
                    str(linked["id"]), org_key, leave_status,
                    approved_by=str(decided_by) if decided_by else "Attendance Exception",
                )
            except Exception:
                logger.exception(
                    "Failed to sync linked leave request status for attendance=%s decision=%s",
                    attendance_id, decision,
                )
        else:
            logger.warning(
                "No linked leave_requests row found for attendance=%s while setting payroll decision=%s",
                attendance_id, decision,
            )
    # Also update any pending payroll-decision notifications that reference
    # this attendance row so the client UI can read the recorded decision
    # directly from the notification metadata on refresh. This is a
    # best-effort non-fatal step: notification write failures must not
    # fail the admin's decision action.
    try:
        try:
            notif_q = (
                sb.table("notifications")
                .select("id, metadata")
                .eq("org_id", org_key)
                .eq("target_entity_id", str(attendance_id))
                .eq("event_type", "attendance.payroll_decision.pending")
                .limit(10)
            )
            notif_res = notif_q.execute()
        except Exception:
            notif_res = None

        if notif_res and notif_res.data:
            for note in notif_res.data:
                nid = note.get("id")
                meta = note.get("metadata") or {}
                # merge decision into metadata keys the frontend checks
                meta.update({
                    "check_out_payroll_decision": decision,
                    "checkOutPayrollDecision": decision,
                })
                try:
                    sb.table("notifications").update({"metadata": meta}).eq("id", nid).execute()
                except Exception:
                    # ignore per-note failures
                    pass
    except Exception:
        # never bubble notification update failures to the caller
        pass

    return result.data[0]