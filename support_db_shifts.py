"""
support_db_shifts.py
──────────────────────────────────────────────────────────────────────────────
Shift management — branches create/edit shifts manually, per people_type.
Shifts are optional: whether a branch+people_type uses shift-based timing
at all is decided by attendance_capture_settings.mode ('shift' vs 'simple'),
not by anything in this module — a school can run 'simple' mode for
students while 'shift' mode for teachers, purely via that settings row.

Shifts are the SOLE owner of check-in/check-out TIME in this codebase.
Branch (attendance_capture_settings.default_shift_id), department
(departments.default_shift_id), and staff (client_staff.shift_id_ref) only
decide WHICH shift applies, plus an optional grace-minute delta stored
alongside each of those three tiers — see support_db_attendance_gate.py's
resolve_timing_source for the precedence chain and grace-delta resolution.

Kept in its own module rather than folded into support_db.py, matching the
existing split (support_db_fast.py, support_db_training_pipeline.py) so one
file doesn't keep growing without bound.

OVERLAPPING SHIFTS ARE ALLOWED. A branch may legitimately run Morning
09:00-17:00 alongside Evening 14:00-22:00 so two people cover the busy
middle together. Nothing resolves a shift by matching a punch time against
shift windows — every lookup is by id (shift_id_ref, default_shift_id, or an
.in_('id', ...) batch read) — so an overlap is never ambiguous to resolve.
create_shift/update_shift therefore REPORT overlaps (overlap_notes on the
response) rather than refusing them, via the shared comparison in
support_db_shift_overlap.py. What this module does enforce is that a person
holds exactly one shift, and that swapping it is never silent — see
assign_staff_shift.

list_branch_shifts is the one function here that reads across branches: pass
branch_id="all" (or None) to get every shift in the org, each row enriched
with branch_name. Every write function (create/update/delete/assign) still
requires one specific, real branch — see require_specific_branch.
"""
from __future__ import annotations

from typing import Any

from supabase_client import get_supabase
from support_db_time_utils import (
    now_iso as _now_iso,
    clean_text as _clean_text,
    normalize_people_type as _normalize_people_type,
    validate_time_string as _validate_time_string,
    validate_grace_minutes as _validate_grace_minutes,
    validate_sync_delay_minutes as _validate_sync_delay_minutes,
    get_branch_owned_by_org as _get_branch_owned_by_org,
    is_all_branches as _is_all_branches,
    require_specific_branch as _require_specific_branch,
    attach_branch_names as _attach_branch_names,
    is_missing_table_or_column as _is_missing_table_or_column,
)
from support_db_shift_overlap import (
    ShiftConflictError,
    format_window as _format_window,
    check_overlaps as _check_overlaps,
)


# ─── Shift CRUD ────────────────────────────────────────────────────────────

def list_branch_shifts(org_id: str, branch_id: str | None, people_type: str | None = None) -> list[dict]:
    """branch_id="all" (or None/""/"*") aggregates every shift across every
    branch in the org, each row annotated with branch_name. A real branch id
    is ownership-checked and filtered on as before."""
    sb = get_supabase()
    aggregate = _is_all_branches(branch_id)

    query = sb.table("shifts").select("*").eq("org_id", str(org_id))
    if aggregate:
        pass  # no branch filter — every shift in this org
    else:
        _get_branch_owned_by_org(org_id, branch_id)
        query = query.eq("branch_id", str(branch_id))

    if people_type:
        query = query.eq("people_type", _normalize_people_type(people_type))
    query = query.order("check_in_time")

    try:
        result = query.execute()
    except Exception as exc:
        if _is_missing_table_or_column(exc, "shifts"):
            return []
        raise

    rows = result.data or []
    return _attach_branch_names(org_id, rows) if aggregate else rows


def _get_shift_owned_by_org(org_id: str, shift_id: str) -> dict:
    """Shared existence/ownership check — used by assign_staff_shift and by
    support_db_attendance_settings.py's default-shift assignment functions
    (called directly against the shifts table there to avoid a circular
    import; this helper stays local to this module)."""
    sb = get_supabase()
    result = (
        sb.table("shifts")
        .select("*")
        .eq("id", str(shift_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError("Shift does not belong to this organization")
    return result.data[0]


# ─── Overlap guard ─────────────────────────────────────────────────────────

def _sibling_shifts(org_id: str, branch_id: str, people_type: str) -> list[dict]:
    """Every other shift competing for the same punches — same org, branch,
    and people_type. Deliberately not filtered on is_active in SQL: the
    guard decides what counts, so the "inactive shifts don't conflict" rule
    lives in exactly one place instead of being half-expressed as a query
    filter here and half as a flag there."""
    sb = get_supabase()
    try:
        result = (
            sb.table("shifts")
            .select("id, name, branch_id, people_type, check_in_time, "
                    "grace_minutes, check_out_time, checkout_grace_minutes, is_active")
            .eq("org_id", str(org_id))
            .eq("branch_id", str(branch_id))
            .eq("people_type", people_type)
            .execute()
        )
    except Exception as exc:
        if _is_missing_table_or_column(exc, "shifts"):
            return []
        raise
    return result.data or []


def _describe_overlaps(
    org_id: str,
    branch_id: str,
    candidate: dict,
    *,
    exclude_id: str | None = None,
) -> list[dict]:
    """How this shift relates to the ones already beside it, as plain dicts
    ready to ride back in the response.

    Does NOT block. Overlapping shifts are a normal roster — two people
    covering a lunch rush together — and every shift lookup in this codebase
    is by id, so an overlap is never ambiguous to resolve. See
    check_overlaps' own docstring for the full reasoning. The admin is told;
    the admin decides.

    Both create_shift and update_shift call exactly this, so the sibling
    read and the comparison are defined once. Adding a third write path
    later means one more call here, not another copy of the rule.
    """
    siblings = _sibling_shifts(org_id, branch_id, candidate["people_type"])
    overlaps = _check_overlaps(candidate, siblings, exclude_id=exclude_id)
    return [o.to_dict() for o in overlaps]


def create_shift(org_id: str, branch_id: str, payload: dict) -> dict:
    branch_key = _require_specific_branch(branch_id, "Creating a shift")
    _get_branch_owned_by_org(org_id, branch_key)
    name = _clean_text(payload.get("name"))
    if not name:
        raise ValueError("Shift name is required")

    people_type = _normalize_people_type(payload.get("people_type"))
    check_in_time = _validate_time_string(payload.get("check_in_time"), "check_in_time")
    grace_minutes = _validate_grace_minutes(payload.get("grace_minutes", 15))
    # Per-shift, not per-branch: how long AFTER this shift's own grace
    # window closes (check-in or check-out leg, whichever confirmed) before
    # it auto-syncs to the cloud. 0 = sync as soon as the window closes.
    sync_delay_minutes = _validate_sync_delay_minutes(payload.get("sync_delay_minutes", 0))
    # Checkout is optional at creation (capture_check_out defaults false),
    # matching the same optionality pattern used by capture settings and
    # half-day windows elsewhere in this codebase.
    capture_check_out = bool(payload.get("capture_check_out", False))
    check_out_time = (
        _validate_time_string(payload.get("check_out_time"), "check_out_time")
        if capture_check_out else None
    )
    checkout_grace_minutes = (
        _validate_grace_minutes(payload.get("checkout_grace_minutes", 15))
        if capture_check_out else None
    )

    row = {
        "org_id": str(org_id),
        "branch_id": branch_key,
        "people_type": people_type,
        "name": name,
        "check_in_time": check_in_time,
        "grace_minutes": grace_minutes,
        "check_out_time": check_out_time,
        "checkout_grace_minutes": checkout_grace_minutes,
        "sync_delay_minutes": sync_delay_minutes,
        "is_active": True,
    }

    overlaps = _describe_overlaps(org_id, branch_key, row)

    sb = get_supabase()
    result = sb.table("shifts").insert(row).execute()
    if not result.data:
        raise RuntimeError("Failed to create shift")

    created = result.data[0]
    if overlaps:
        created["overlap_notes"] = overlaps
    return created


def update_shift(org_id: str, branch_id: str, shift_id: str, payload: dict) -> dict:
    branch_key = _require_specific_branch(branch_id, "Updating a shift")
    _get_branch_owned_by_org(org_id, branch_key)
    sb = get_supabase()

    update_data: dict[str, Any] = {}
    if "name" in payload:
        name = _clean_text(payload.get("name"))
        if not name:
            raise ValueError("Shift name is required")
        update_data["name"] = name
    if "check_in_time" in payload:
        update_data["check_in_time"] = _validate_time_string(payload.get("check_in_time"), "check_in_time")
    if "grace_minutes" in payload:
        update_data["grace_minutes"] = _validate_grace_minutes(payload.get("grace_minutes"))
    if "sync_delay_minutes" in payload:
        update_data["sync_delay_minutes"] = _validate_sync_delay_minutes(payload.get("sync_delay_minutes"))

    # capture_check_out is the switch; check_out_time/checkout_grace_minutes
    # only get validated+written when checkout is being turned on. Turning
    # it off explicitly nulls both, same pattern as upsert_capture_settings
    # and upsert_timing_override used for their capture_check_out toggle.
    if "capture_check_out" in payload:
        capture_check_out = bool(payload.get("capture_check_out"))
        if capture_check_out:
            update_data["check_out_time"] = _validate_time_string(
                payload.get("check_out_time"), "check_out_time"
            )
            update_data["checkout_grace_minutes"] = _validate_grace_minutes(
                payload.get("checkout_grace_minutes", 15)
            )
        else:
            update_data["check_out_time"] = None
            update_data["checkout_grace_minutes"] = None
    elif "check_out_time" in payload or "checkout_grace_minutes" in payload:
        # Editing checkout fields on a shift that already captures checkout,
        # without re-sending the capture_check_out flag.
        if "check_out_time" in payload:
            update_data["check_out_time"] = _validate_time_string(
                payload.get("check_out_time"), "check_out_time"
            )
        if "checkout_grace_minutes" in payload:
            update_data["checkout_grace_minutes"] = _validate_grace_minutes(
                payload.get("checkout_grace_minutes")
            )

    if "is_active" in payload:
        update_data["is_active"] = bool(payload.get("is_active"))

    if not update_data:
        raise ValueError("No valid shift fields to update")

    # An update is a PATCH, so the candidate window is the STORED row with
    # this payload merged over it — checking update_data alone would read a
    # grace-only edit as a shift with no times at all and wave it through.
    # Fetching first also turns "no such shift" into a clean 404-ish error
    # before any write is attempted, instead of inferring it from an empty
    # update result afterwards.
    existing = (
        sb.table("shifts")
        .select("*")
        .eq("id", str(shift_id))
        .eq("org_id", str(org_id))
        .eq("branch_id", branch_key)
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise ValueError("Shift not found for this branch")

    candidate = {**existing.data[0], **update_data}
    overlaps = _describe_overlaps(
        org_id, branch_key, candidate, exclude_id=str(shift_id)
    )

    update_data["updated_at"] = _now_iso()
    result = (
        sb.table("shifts")
        .update(update_data)
        .eq("id", str(shift_id))
        .eq("org_id", str(org_id))
        .eq("branch_id", branch_key)
        .execute()
    )
    if not result.data:
        raise ValueError("Shift not found for this branch")

    updated = result.data[0]
    if overlaps:
        updated["overlap_notes"] = overlaps
    return updated


def delete_shift(org_id: str, branch_id: str, shift_id: str) -> bool:
    branch_key = _require_specific_branch(branch_id, "Deleting a shift")
    _get_branch_owned_by_org(org_id, branch_key)
    sb = get_supabase()

    # Unassign every tier pointing at this shift before deleting, so no
    # attendance write ever resolves a dangling shift reference. Previously
    # this only cleared client_staff.shift_id_ref; departments and
    # attendance_capture_settings can now also reference a shift as their
    # default_shift_id and need the same treatment.
    sb.table("client_staff").update({"shift_id_ref": None}).eq(
        "org_id", str(org_id)
    ).eq("shift_id_ref", str(shift_id)).execute()

    sb.table("departments").update({"default_shift_id": None}).eq(
        "org_id", str(org_id)
    ).eq("default_shift_id", str(shift_id)).execute()

    sb.table("attendance_capture_settings").update({"default_shift_id": None}).eq(
        "org_id", str(org_id)
    ).eq("default_shift_id", str(shift_id)).execute()

    result = (
        sb.table("shifts")
        .delete()
        .eq("id", str(shift_id))
        .eq("org_id", str(org_id))
        .eq("branch_id", branch_key)
        .execute()
    )
    if not result.data:
        raise ValueError("Shift not found for this branch")
    return True


# ─── Staff shift assignment (staff tier — most specific) ──────────────────

def assign_staff_shift(
    org_id: str,
    staff_id: str,
    shift_id: str | None,
    check_in_grace_override: int | None = None,
    check_out_grace_override: int | None = None,
) -> dict:
    """Assign (or clear, if shift_id is None) a person's shift, plus an
    optional per-staff grace delta. Grace overrides are only meaningful
    alongside a shift — clearing the shift (shift_id=None) also clears any
    grace overrides, so a staff row never carries a grace delta with nothing
    for it to modify.

    Not branch-scoped in its own URL — the shift itself carries a
    branch_id, and this only needs to confirm the shift belongs to the same
    org as the staff.

    A person holds exactly one shift (client_staff.shift_id_ref), so a second
    assignment REPLACES the first rather than adding to it. That replacement
    was previously silent: the UI reported "Shift applied successfully" for
    both, and nothing said which one had actually won. The returned row now
    carries `previous_shift` and `assigned_shift` so the caller can name the
    swap instead of leaving the admin to guess (Ticket #20)."""
    sb = get_supabase()

    # Read the staff row first: needed for the branch check below, and for
    # the before/after the response reports.
    staff_before = (
        sb.table("client_staff")
        .select("id, org_id, branch_id, shift_id_ref")
        .eq("id", str(staff_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    if not staff_before.data:
        raise ValueError("Staff member not found in this organization")
    previous_shift_id = staff_before.data[0].get("shift_id_ref")

    update: dict[str, Any] = {
        "shift_id_ref": str(shift_id) if shift_id else None,
        "updated_at": _now_iso(),
    }

    assigned_shift: dict | None = None
    if shift_id:
        assigned_shift = _get_shift_owned_by_org(org_id, shift_id)

        # Org ownership alone was letting a person in Branch A be put on a
        # shift belonging to Branch B, whose times are keyed to a different
        # timezone and whose branch default never applies to them.
        staff_branch = str(staff_before.data[0].get("branch_id") or "")
        shift_branch = str(assigned_shift.get("branch_id") or "")
        if staff_branch and shift_branch and staff_branch != shift_branch:
            raise ValueError(
                f'"{assigned_shift.get("name")}" belongs to a different branch '
                "than this staff member. Assign a shift from their own branch, "
                "or move them to that branch first."
            )

        if assigned_shift.get("is_active") is False:
            raise ValueError(
                f'"{assigned_shift.get("name")}" is deactivated and can\'t be '
                "assigned. Reactivate it under Shift Timings first."
            )

        update["check_in_grace_override"] = (
            _validate_grace_minutes(check_in_grace_override)
            if check_in_grace_override is not None else None
        )
        update["check_out_grace_override"] = (
            _validate_grace_minutes(check_out_grace_override)
            if check_out_grace_override is not None else None
        )
    else:
        update["check_in_grace_override"] = None
        update["check_out_grace_override"] = None

    result = (
        sb.table("client_staff")
        .update(update)
        .eq("id", str(staff_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not result.data:
        raise ValueError("Staff member not found in this organization")

    staff = result.data[0]
    staff["assigned_shift"] = _shift_summary(assigned_shift)
    staff["previous_shift"] = (
        _shift_summary(_load_shift_quietly(org_id, previous_shift_id))
        if previous_shift_id and str(previous_shift_id) != str(shift_id or "")
        else None
    )
    return staff


def _load_shift_quietly(org_id: str, shift_id: str) -> dict | None:
    """The shift a person is being moved OFF. Best-effort by design: it may
    have been deleted since it was assigned, and a stale reference must not
    turn a valid reassignment into an error."""
    try:
        return _get_shift_owned_by_org(org_id, shift_id)
    except ValueError:
        return None


def _shift_summary(shift: dict | None) -> dict | None:
    """The minimum a UI needs to name a shift: what it's called and when it
    runs. Built through the shared formatter so the window in a toast reads
    identically to the window in an overlap error."""
    if not shift:
        return None
    return {
        "id": str(shift.get("id")),
        "name": shift.get("name"),
        "window": _format_window(shift),
    }