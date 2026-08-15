"""
support_db_attendance_gate.py — precedence-based, timezone-correct, check-in/out aware
──────────────────────────────────────────────────────────────────────────────
Resolution precedence (most → least specific):
  1. Manual attendance instruction for this staff member on this exact
     local date (manual_attendance_instructions — full window override,
     date-scoped, admin-typed; see resolve_manual_instruction_window)
  2. Approved half-day leave for the event's local date (full window
     override, date-scoped, not part of the shift hierarchy below)
  3. Staff's assigned shift (client_staff.shift_id_ref) + staff grace
     override — the SOLE shift-assignment surface (Shift Allocation tab).
     Department no longer participates in timing resolution at all.
  4. Branch + people_type default shift
     (attendance_capture_settings.default_shift_id, mode='shift') + branch
     grace override — fallback for staff with no personal shift assigned
  5. Branch + people_type simple-mode baseline
     (attendance_capture_settings, mode='simple' — its own raw check_in/out
     time, the one place outside `shifts` allowed to define a time, for
     branches with no shift concept at all)
  6. No config anywhere → 'unscheduled' (unchanged historical behavior)

TIME always comes from exactly one place at each tier: the `shifts` table
(tiers 2-4) or the capture-settings baseline itself (tier 5). GRACE is
resolved independently — whichever tier supplies the winning shift, that
tier's own grace-override columns win if set, otherwise the shift's own
grace_minutes / checkout_grace_minutes apply. This is what lets a shift be
assigned once and have its grace tuned per department or per staff member
without re-entering a check-in/check-out time anywhere.

Approved overtime is unchanged: it never replaces a time, it only extends
the checkout cutoff computed from whatever window resolved above.
"""
from __future__ import annotations
import logging
from datetime import datetime, date, time as dt_time, timezone
from typing import Optional, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from supabase_client import get_supabase
logger = logging.getLogger(__name__)

_DEFAULT_TZ = "UTC"

TimingWindow = dict  # {check_in_time, check_in_grace_minutes, capture_check_out, check_out_time, check_out_grace_minutes}


def _normalize_people_type(value: object) -> str:
    return str(value or "staff").strip().lower().replace(" ", "_").replace("-", "_")


def _parse_time(value: object) -> Optional[dt_time]:
    if not value:
        return None
    parts = str(value).split(":")
    if len(parts) < 2:
        return None
    return dt_time(hour=int(parts[0]), minute=int(parts[1]))


def _resolve_zone(tz_name: Optional[str]) -> ZoneInfo:
    name = (tz_name or "").strip() or _DEFAULT_TZ
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo(_DEFAULT_TZ)


def _get_branch_timezone(sb, org_id: str, branch_id: str) -> ZoneInfo:
    result = (
        sb.table("branches")
        .select("timezone")
        .eq("id", str(branch_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    row = result.data[0] if result.data else {}
    return _resolve_zone(row.get("timezone"))


def _find_approved_overtime(sb, org_id: str, staff_id: str, local_date: date) -> Optional[dict]:
    """Mirrors _find_approved_half_day_leave's shape/pattern intentionally —
    same precedence idea (an approved request for this date changes the
    normal check-out cutoff), different table. Only 'hours' is needed by
    resolve_check_out_status; the row's other columns aren't read here."""
    result = (
        sb.table("overtime_requests")
        .select("hours")
        .eq("org_id", str(org_id))
        .eq("staff_id", str(staff_id))
        .eq("status", "approved")
        .eq("ot_date", local_date.isoformat())
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def _find_approved_half_day_leave(sb, org_id: str, staff_id: str, local_date: date) -> Optional[dict]:
    # Half-day is signaled by half_day_period being set, not by leave_type --
    # leave_type carries the real category (annual/sick/...) and is never
    # overwritten to the literal string 'half_day' anymore. Filtering on
    # half_day_period directly (rather than re-deriving an is_half_day flag
    # after the fetch) keeps this a single indexed-column query, same shape
    # as before.
    result = (
        sb.table("leave_requests")
        .select("half_day_period, leave_type")
        .eq("org_id", str(org_id))
        .eq("staff_id", str(staff_id))
        .eq("status", "approved")
        .not_.is_("half_day_period", "null")
        .lte("start_date", local_date.isoformat())
        .gte("end_date", local_date.isoformat())
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def _half_day_window(sb, org_id: str, branch_id: str, people_type: str, period: str) -> Optional[TimingWindow]:
    result = (
        sb.table("half_day_leave_windows")
        .select("*")
        .eq("org_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .eq("people_type", people_type)
        .eq("period", period)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    row = result.data[0]
    return {
        "check_in_time": row["check_in_time"],
        "check_in_grace_minutes": row.get("check_in_grace_minutes") or 0,
        "capture_check_out": True,
        "check_out_time": row["check_out_time"],
        "check_out_grace_minutes": row.get("check_out_grace_minutes") or 0,
    }


def _get_shift(sb, org_id: str, shift_id: str) -> Optional[dict]:
    result = (
        sb.table("shifts")
        .select("check_in_time, grace_minutes, check_out_time, checkout_grace_minutes, sync_delay_minutes, is_active")
        .eq("id", str(shift_id))
        .eq("org_id", str(org_id))
        .eq("is_active", True)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None



def _capture_settings(sb, org_id: str, branch_id: str, people_type: str) -> Optional[dict]:
    result = (
        sb.table("attendance_capture_settings")
        .select("*")
        .eq("org_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .eq("people_type", people_type)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def _window_from_shift(shift: dict, check_in_grace: Optional[int], check_out_grace: Optional[int]) -> TimingWindow:
    return {
        "name": shift.get("name"),
        "check_in_time": shift["check_in_time"],
        "check_in_grace_minutes": (
            check_in_grace if check_in_grace is not None else (shift.get("grace_minutes") or 0)
        ),
        "capture_check_out": bool(shift.get("check_out_time")),
        "check_out_time": shift.get("check_out_time"),
        "check_out_grace_minutes": (
            check_out_grace if check_out_grace is not None else (shift.get("checkout_grace_minutes") or 0)
        ),
        "sync_delay_minutes": shift.get("sync_delay_minutes") or 0,
    }

def _resolve_shift_window(sb, org_id: str, branch_id: str, staff: dict, people_type: str) -> Optional[TimingWindow]:
    """Tiers 3-4: staff's assigned shift (the sole shift-assignment surface,
    set via the Shift Allocation tab / support_db_shifts.assign_staff_shift)
    → branch default. Department is NOT a timing source — a department is
    changed by reassigning the staff member's shift directly, not by a
    separate department-level default. staff must include: shift_id_ref,
    check_in_grace_override, check_out_grace_override."""

    # Tier 3 — staff's assigned shift
    if staff.get("shift_id_ref"):
        shift = _get_shift(sb, org_id, staff["shift_id_ref"])
        if shift:
            return _window_from_shift(
                shift, staff.get("check_in_grace_override"), staff.get("check_out_grace_override")
            )

    # Tier 4 — branch default (staff with no personal shift assigned)
    branch_default = _branch_default_shift_window(sb, org_id, branch_id, people_type)
    if branch_default:
        return branch_default

    return None


def _branch_default_shift_window(sb, org_id: str, branch_id: str, people_type: str) -> Optional[TimingWindow]:
    """Tier 4 — the branch's own default shift for a people_type
    (attendance_capture_settings.mode='shift' + default_shift_id),
    independent of any staff/department override. Extracted so both the
    full precedence chain (_resolve_shift_window) and the coarse,
    Local-Node-facing resolve_branch_default_window share one
    implementation instead of two copies of the same three lines."""
    settings = _capture_settings(sb, org_id, branch_id, people_type)
    if settings and settings.get("mode") == "shift" and settings.get("default_shift_id"):
        shift = _get_shift(sb, org_id, settings["default_shift_id"])
        if shift:
            return _window_from_shift(
                shift,
                settings.get("default_check_in_grace_override"),
                settings.get("default_check_out_grace_override"),
            )
    return None


def _simple_mode_window(sb, org_id: str, branch_id: str, people_type: str) -> Optional[TimingWindow]:
    settings = _capture_settings(sb, org_id, branch_id, people_type)
    if settings and settings.get("mode") == "simple" and settings.get("check_in_time"):
        return {
            "name": "Simple Mode",
            "check_in_time": settings["check_in_time"],
            "check_in_grace_minutes": settings.get("check_in_grace_minutes") or 0,
            "capture_check_out": bool(settings.get("capture_check_out")),
            "check_out_time": settings.get("check_out_time"),
            "check_out_grace_minutes": settings.get("check_out_grace_minutes") or 0,
            "sync_delay_minutes": settings.get("sync_delay_minutes") or 0,
        }
    return None


def resolve_branch_default_window(org_id: str, branch_id: str, people_type: str) -> Optional[TimingWindow]:
    """Coarse, staff-agnostic window (tiers 4+5 only) for a branch+people_type.
    Used by get_node_config to hand Local Node enough data to gate face-
    recognition detections against the branch's normal hours in real time,
    WITHOUT syncing individual staff shift assignments to the node (per the
    branch-default-only decision — staff/department overrides are only
    resolved precisely by the backend at actual sync time via
    resolve_timing_source, which is unaffected by this addition)."""
    sb = get_supabase()
    normalized = _normalize_people_type(people_type)
    return (
        _branch_default_shift_window(sb, org_id, branch_id, normalized)
        or _simple_mode_window(sb, org_id, branch_id, normalized)
    )


def resolve_staff_shift_windows(org_id: str, branch_id: str) -> dict:
    """Personal shift overrides (tier 2, client_staff.shift_id_ref) for every
    active, enrolled staff member in this branch who has one — the
    per-person counterpart to resolve_branch_default_window above. Used by
    get_node_config to populate config["staff_shift_windows"], keyed
    "people_type:person_code" exactly the way Local Node's own
    shift_gate._resolve_window looks them up (see local_node/shift_gate.py).

    Department overrides (tier 3) are deliberately NOT included here — the
    node still only ever sees tiers 2, 4, and 5; tier 3 remains
    backend-only, same limitation resolve_timing_source's docstring already
    calls out for the node in general. A staff row needs both a real
    shift_id_ref AND a person_code (i.e. actually enrolled for local face
    recognition, not just present in client_staff) to produce an entry —
    nothing here overrides who the node can already recognize."""
    sb = get_supabase()
    result = (
        sb.table("client_staff")
        .select(
            "person_code, people_type, shift_id_ref, is_archived, status, "
            "check_in_grace_override, check_out_grace_override"
        )
        .eq("org_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .not_.is_("shift_id_ref", "null")
        .not_.is_("person_code", "null")
        .execute()
    )

    windows: dict = {}
    for row in (result.data or []):
        # One malformed row (dangling shift_id_ref, transient lookup error)
        # must never blank out every other staff member's window — that was
        # the actual production bug: a single bad _get_shift() call used to
        # raise straight out of this loop, aborting resolve_staff_shift_windows
        # entirely and — because get_node_config calls this with no try/except
        # of its own — 500ing the WHOLE /v1/node/config response. The node
        # then kept whatever shift_windows/staff_shift_windows it last had
        # (often {} from before activation finished), silently and
        # indefinitely, since nothing here ever surfaced the failure.
        try:
            if row.get("is_archived") or str(row.get("status") or "active") == "inactive":
                continue
            person_code = str(row.get("person_code") or "").strip()
            if not person_code:
                continue
            shift = _get_shift(sb, org_id, row["shift_id_ref"])
            if not shift:
                continue
            window = _window_from_shift(
                shift, row.get("check_in_grace_override"), row.get("check_out_grace_override")
            )
            people_type = _normalize_people_type(row.get("people_type"))

            # Local Node's person_code (from the trainer-enrolled embedding
            # package) is not guaranteed to carry the same zero-padding as
            # client_staff.person_code (Staff ID convention, e.g. "0003" vs
            # "3") — identical identity, two string representations. Same
            # mismatch push_node_attendance() already works around with a
            # digit-aware fallback lookup; this dict needs the same
            # tolerance on the write side, since the node does an exact key
            # lookup with no fallback of its own (shift_gate._resolve_window).
            # Storing both the raw and the zero-stripped numeric key means
            # the node's own person_code — whichever convention it happens
            # to use — resolves to the same window.
            windows[f"{people_type}:{person_code}"] = window
            if person_code.isdigit():
                windows[f"{people_type}:{str(int(person_code))}"] = window
        except Exception:
            logger.warning(
                "resolve_staff_shift_windows: skipping unresolvable staff row "
                "(org=%s branch=%s person_code=%s shift_id_ref=%s) — "
                "not letting one bad row blank every other staff member's window",
                org_id, branch_id, row.get("person_code"), row.get("shift_id_ref"),
                exc_info=True,
            )
            continue
    return windows

def _window_from_manual_instruction(instruction: dict) -> TimingWindow:
    """Tier 0 — a manual attendance instruction for this exact staff member
    and date is the most specific timing source in the system: an admin
    explicitly typed this person's check-in/check-out for this one day.
    Time comes straight off the instruction row (never a shift); grace comes
    from the instruction's own check_in_grace_minutes/check_out_grace_minutes.
    Same TimingWindow shape as every other tier, so resolve_check_in_status/
    resolve_check_out_status classify it with zero special-casing."""
    return {
        "check_in_time": instruction.get("check_in_time"),
        "check_in_grace_minutes": instruction.get("check_in_grace_minutes") or 0,
        "capture_check_out": bool(instruction.get("check_out_time")),
        "check_out_time": instruction.get("check_out_time"),
        "check_out_grace_minutes": instruction.get("check_out_grace_minutes") or 0,
    }


def resolve_manual_instruction_window(org_id: str, instruction_id: Optional[str]) -> Optional[TimingWindow]:
    """Looks up one manual_attendance_instructions row by id, scoped to
    org_id. Returns None (not an error) if instruction_id is falsy or the
    row no longer exists — e.g. deleted between the node applying it and
    this cloud sync — so push_node_attendance can cleanly fall back to the
    normal staff/department/branch chain in that edge case."""
    if not instruction_id:
        return None
    sb = get_supabase()
    result = (
        sb.table("manual_attendance_instructions")
        .select("check_in_time, check_in_grace_minutes, check_out_time, check_out_grace_minutes")
        .eq("id", str(instruction_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return _window_from_manual_instruction(result.data[0])

def _find_manual_instruction(sb, org_id: str, staff_id: Optional[str], person_code: Optional[str], local_date: date) -> Optional[dict]:
    """Robust lookup: staff_id first, then person_code fallback. Uses branch timezone."""
    if not staff_id and not person_code:
        return None

    query = (
        sb.table("manual_attendance_instructions")
        .select("check_in_time, check_in_grace_minutes, check_out_time, check_out_grace_minutes")
        .eq("org_id", str(org_id))
        .eq("attendance_date", local_date.isoformat())
        .limit(1)
    )

    if staff_id:
        query = query.eq("staff_id", str(staff_id))
    else:
        query = query.eq("person_code", str(person_code))

    result = query.execute()
    return result.data[0] if result.data else None


def resolve_timing_source(
    *,
    org_id: str,
    branch_id: Optional[str],
    staff: dict,
    people_type: str,
    event_time_utc: datetime,
) -> Optional[TimingWindow]:
    """Single dispatch point. staff must include: id, shift_id_ref,
    check_in_grace_override, check_out_grace_override."""

    if not branch_id:
        return None

    sb = get_supabase()
    normalized_people_type = _normalize_people_type(people_type)
    branch_zone = _get_branch_timezone(sb, org_id, branch_id)
    local_date = event_time_utc.astimezone(branch_zone).date()

    # Tier 1 — Manual override (now robust)
    manual = _find_manual_instruction(sb, org_id, staff.get("id"), staff.get("person_code"), local_date)
    logger.info(f"[DEBUG] Manual lookup for {staff.get('id')} / {staff.get('person_code')} on {local_date}: found={bool(manual)}")
    if manual:
        logger.info(f"[DEBUG] Manual window: check_in={manual.get('check_in_time')}, grace={manual.get('check_in_grace_minutes')}")

    if manual and (manual.get("check_in_time") or manual.get("check_out_time")):
        window = _window_from_manual_instruction(manual)
        logger.info(f"[DEBUG] Using MANUAL override window for {people_type}")
        return window

    logger.info(f"[DEBUG] No manual override, falling back to shift/branch for {people_type}")

    # Tier 2 — half-day leave
    half_day = _find_approved_half_day_leave(sb, org_id, staff.get("id"), local_date)
    if half_day and half_day.get("half_day_period"):
        window = _half_day_window(sb, org_id, branch_id, normalized_people_type, half_day["half_day_period"])
        if window:
            return window

    # Tiers 3-4 — staff's assigned shift → branch default
    shift_window = _resolve_shift_window(sb, org_id, branch_id, staff, normalized_people_type)
    if shift_window:
        return shift_window

    # Tier 5 — simple-mode branch baseline (no shift concept at all)
    simple_window = _simple_mode_window(sb, org_id, branch_id, normalized_people_type)
    if simple_window:
        return simple_window

    return None


def _classify(event_local_minutes: int, target_time: Optional[dt_time], grace_minutes: int, *, allow_early: bool) -> str:
    if not target_time:
        return "unscheduled"
    target_minutes = target_time.hour * 60 + target_time.minute
    if allow_early and event_local_minutes < target_minutes - grace_minutes:
        return "early"
    cutoff = target_minutes + grace_minutes
    return "late" if event_local_minutes > cutoff else "on_time"


def _local_minutes(event_time_utc: datetime, branch_zone: ZoneInfo) -> int:
    dt = event_time_utc if event_time_utc.tzinfo else event_time_utc.replace(tzinfo=timezone.utc)
    local = dt.astimezone(branch_zone)
    return local.hour * 60 + local.minute


def resolve_check_in_status(window: Optional[TimingWindow], event_time_utc: datetime, branch_zone: ZoneInfo) -> str:
    if not window:
        return "unscheduled"
    minutes = _local_minutes(event_time_utc, branch_zone)
    # allow_early=True: an arrival before (shift_start - grace) is 'early',
    # not 'on_time'. This was False, which made 'early' structurally
    # unreachable here even though check_in_write_fields() in
    # support_db_attendance_exceptions.py already fully implements what
    # happens when this returns 'early' (note text, check_in_confirmed=True,
    # no admin hold) — that branch was simply dead code until now.
    return _classify(minutes, _parse_time(window.get("check_in_time")), int(window.get("check_in_grace_minutes") or 0), allow_early=True)


def resolve_check_out_status(
    window: Optional[TimingWindow],
    event_time_utc: datetime,
    branch_zone: ZoneInfo,
    overtime_hours: float = 0,
) -> str:
    """overtime_hours: approved overtime for this staff member on this local
    date (0 if none/not approved — see _find_approved_overtime). When > 0,
    a check-out that falls after the normal grace cutoff but within the
    extended overtime window is classified 'overtime' instead of 'late'.
    A check-out on time, or one beyond even the extended window, falls
    through to the normal classification unchanged. Unmodified by this
    change — overtime never touches time resolution, only the checkout
    cutoff computed from whatever window resolved above."""
    if not window or not window.get("capture_check_out"):
        return "unscheduled"

    minutes = _local_minutes(event_time_utc, branch_zone)
    target_time = _parse_time(window.get("check_out_time"))
    grace = int(window.get("check_out_grace_minutes") or 0)

    if overtime_hours > 0 and target_time:
        normal_cutoff = target_time.hour * 60 + target_time.minute + grace
        extended_cutoff = normal_cutoff + int(round(overtime_hours * 60))
        if normal_cutoff < minutes <= extended_cutoff:
            return "overtime"

    return _classify(minutes, target_time, grace, allow_early=True)


# ─── Backward-compatible shim so existing call sites keep working during rollout ───
def resolve_attendance_status(
    *,
    org_id: str,
    branch_id: Optional[str],
    people_type: str,
    shift_id_ref: Optional[str],
    event_time_utc: Optional[datetime] = None,
) -> str:
    """Deprecated shim — kept only until push_node_attendance/record_cloud_camera_attendance
    are migrated to resolve_timing_source directly. Do not call this from
    new code. Only passes shift_id_ref through (no grace overrides), so it
    necessarily skips per-tier grace deltas — a reason to finish the
    migration off this shim, not something this change needs to fix."""
    sb = get_supabase()
    event_dt = event_time_utc or datetime.now(timezone.utc)
    staff = {
        "id": None,
        "shift_id_ref": shift_id_ref,
        "department_id": None,
        "check_in_grace_override": None,
        "check_out_grace_override": None,
    }
    window = resolve_timing_source(
        org_id=org_id, branch_id=branch_id, staff=staff,
        people_type=people_type, event_time_utc=event_dt,
    )
    branch_zone = _get_branch_timezone(sb, org_id, branch_id) if branch_id else ZoneInfo(_DEFAULT_TZ)
    return resolve_check_in_status(window, event_dt, branch_zone)