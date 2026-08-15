"""
support_db_attendance_settings.py
──────────────────────────────────────────────────────────────────────────────
Dynamic attendance timing configuration — departments, branch/people_type
capture baselines, half-day leave windows, and branch/department default
shift assignment.

Time itself is owned exclusively by support_db_shifts.py's `shifts` table.
This module never stores an independent check_in_time/check_out_time for a
branch or department tier — it only stores WHICH shift a tier defaults to
(default_shift_id) plus an optional grace-minute delta. See
support_db_attendance_gate.py's resolve_timing_source for how branch,
department, and staff (client_staff.shift_id_ref, in support_db_shifts.py)
tiers are resolved in precedence order.

(Previously this module also owned attendance_timing_overrides, a
freeform-time table duplicating what shifts already represented at
staff/department scope. It's been removed — see migration
001_unify_shift_resolution.sql — in favor of default_shift_id +
grace-override columns living directly on departments and
attendance_capture_settings.)

Kept separate from support_db.py (7,300+ lines) and from support_db_shifts.py
(shift CRUD only), matching this codebase's existing module-per-concern split
(support_db_fast.py, support_db_training_pipeline.py, support_db_shifts.py).

Depends only on support_db_time_utils.py — NOT on support_db_shifts.py — so
neither module depends on the other (same "shared package, no circular
import" pattern as shared_face_engine). Where this module needs to validate
a shift_id (branch/department default-shift assignment), it queries the
`shifts` table directly through the shared Supabase client rather than
importing support_db_shifts.py's functions.

Design rules (same as the rest of this codebase):
  1. Every function returns plain dicts — never raw Supabase response objects.
  2. Every write is org_id + branch_id scoped; ownership is checked before
     any insert/update/delete via get_branch_owned_by_org, never assumed
     from the payload alone.
  3. Validation errors raise ValueError with a field name in the message, so
     route handlers can turn them into clean 400s (see _handle() in
     client_shift_routes.py / client_attendance_settings_routes.py).
  4. Every list_* function accepts branch_id="all" (or None/"") to aggregate
     across every branch in the org — see is_all_branches in
     support_db_time_utils.py, the single place that sentinel is defined.
     Write functions (create/upsert/delete) never accept it — see
     require_specific_branch.
"""
from __future__ import annotations

from typing import Any, Optional

from supabase_client import get_supabase
from support_db_time_utils import (
    now_iso,
    clean_text,
    normalize_people_type,
    validate_time_string,
    validate_grace_minutes,
    get_branch_owned_by_org,
    is_all_branches,
    require_specific_branch,
    attach_branch_names,
    is_missing_table_or_column,
)


# ──────────────────────────────────────────────────────────────────────────
# Shared shift-ownership check (local copy, not imported from
# support_db_shifts.py — see module docstring on the no-circular-import rule)
# ──────────────────────────────────────────────────────────────────────────

def _get_shift_owned_by_org(sb, org_id: str, shift_id: str) -> dict:
    result = (
        sb.table("shifts")
        .select("*")
        .eq("id", str(shift_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError(f"shift_id {shift_id!r} not found in this organization")
    return result.data[0]


# ──────────────────────────────────────────────────────────────────────────
# Departments
# ──────────────────────────────────────────────────────────────────────────

def list_departments(org_id: str, branch_id: str | None = None, *, include_inactive: bool = False) -> list[dict]:
    """branch_id="all" (or None/""): every department in the org, including
    org-wide ones (branch_id IS NULL), annotated with branch_name.
    A real branch_id: that branch's own departments plus org-wide ones —
    unchanged from before."""
    sb = get_supabase()
    aggregate = is_all_branches(branch_id)

    query = sb.table("departments").select("*").eq("org_id", str(org_id))
    if not aggregate:
        # branch_id is nullable on this table (org-wide departments) — an
        # explicit branch filter must still surface those org-wide rows,
        # since an org-wide department applies to every branch.
        query = query.or_(f"branch_id.eq.{branch_id},branch_id.is.null")
    if not include_inactive:
        query = query.eq("status", "active")

    try:
        result = query.order("name").execute()
    except Exception as exc:
        if is_missing_table_or_column(exc, "departments"):
            return []
        raise

    rows = result.data or []
    return attach_branch_names(org_id, rows) if aggregate else rows


def create_department(org_id: str, branch_id: str | None, payload: dict) -> dict:
    """branch_id=None (or omitted) creates an org-wide department, visible
    from every branch — this is a deliberate, distinct feature, not the same
    thing as the "all branches" aggregate read above. branch_id="all" is
    rejected here: an aggregate-read sentinel is not a valid write target,
    even though its *effect* (org-wide) looks similar — the two must be
    requested explicitly and separately so a client typo (sending "all"
    when meaning a real branch) never silently becomes "visible everywhere"."""
    if is_all_branches(branch_id) and branch_id is not None:
        raise ValueError("branch_id 'all' is not valid here — omit branch_id for an org-wide department, or pass one real branch_id")

    sb = get_supabase()
    if branch_id:
        get_branch_owned_by_org(org_id, branch_id)  # raises ValueError if not owned

    name = clean_text(payload.get("name"))
    if not name:
        raise ValueError("name is required")
    code = clean_text(payload.get("code")) or None

    # UNIQUE (branch_id, name) — surface a clean conflict instead of a raw
    # Postgres 23505 bubbling up to the route handler.
    existing_query = (
        sb.table("departments")
        .select("id")
        .eq("org_id", str(org_id))
        .eq("name", name)
    )
    existing_query = (
        existing_query.eq("branch_id", str(branch_id)) if branch_id
        else existing_query.is_("branch_id", "null")
    )
    if existing_query.execute().data:
        raise ValueError(f"Department {name!r} already exists for this branch")

    row = {
        "org_id": str(org_id),
        "branch_id": str(branch_id) if branch_id else None,
        "name": name,
        "code": code,
        "status": "active",
    }
    result = sb.table("departments").insert(row).execute()
    if not result.data:
        raise RuntimeError("Failed to create department")
    return result.data[0]


def update_department(org_id: str, department_id: str, payload: dict) -> dict:
    sb = get_supabase()
    updates: dict[str, Any] = {}

    if "name" in payload:
        name = clean_text(payload.get("name"))
        if not name:
            raise ValueError("name cannot be empty")
        updates["name"] = name
    if "code" in payload:
        updates["code"] = clean_text(payload.get("code")) or None
    if "status" in payload:
        status = clean_text(payload.get("status"))
        if status not in ("active", "inactive"):
            raise ValueError("status must be 'active' or 'inactive'")
        updates["status"] = status

    if not updates:
        raise ValueError("No updatable fields provided")

    result = (
        sb.table("departments")
        .update(updates)
        .eq("id", str(department_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not result.data:
        raise ValueError(f"Department {department_id!r} not found for this org")
    return result.data[0]


def delete_department(org_id: str, department_id: str) -> bool:
    """
    Soft-delete only (status='inactive') — client_staff.department_id
    references this row. A hard delete would either orphan those rows or
    require an ON DELETE CASCADE that silently wipes staff department
    history — neither is acceptable for an admin-driven table like this.
    """
    sb = get_supabase()
    result = (
        sb.table("departments")
        .update({"status": "inactive"})
        .eq("id", str(department_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not result.data:
        raise ValueError(f"Department {department_id!r} not found for this org")
    return True


def set_department_default_shift(
    org_id: str,
    department_id: str,
    shift_id: str | None,
    check_in_grace_override: int | None = None,
    check_out_grace_override: int | None = None,
) -> dict:
    """Department tier of shift resolution — see resolve_timing_source in
    support_db_attendance_gate.py. Decision: only a branch-scoped department
    (branch_id IS NOT NULL) may carry a default_shift_id, because a shift
    always belongs to exactly one branch (support_db_shifts.py never allows
    an org-wide shift) — an org-wide department spanning several branches
    has no single branch whose shift catalog it could correctly point at.
    An org-wide department therefore always falls through to the branch
    tier for each staff member in it, per branch.

    Clearing the shift (shift_id=None) also clears any grace overrides, for
    the same reason as assign_staff_shift — a grace delta with nothing to
    modify is a state this function refuses to create."""
    sb = get_supabase()

    dept_result = (
        sb.table("departments")
        .select("*")
        .eq("id", str(department_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    if not dept_result.data:
        raise ValueError(f"department_id {department_id!r} not found for this org")
    department = dept_result.data[0]

    update: dict[str, Any] = {"updated_at": now_iso()}

    if shift_id:
        if not department.get("branch_id"):
            raise ValueError(
                "Org-wide departments cannot have a default shift — a shift "
                "belongs to one branch, but this department spans every "
                "branch. Assign the shift at the branch level instead, or "
                "scope this department to one branch."
            )
        shift = _get_shift_owned_by_org(sb, org_id, shift_id)
        if str(shift.get("branch_id")) != str(department["branch_id"]):
            raise ValueError("shift_id does not belong to this department's branch")

        update["default_shift_id"] = str(shift_id)
        update["check_in_grace_override"] = (
            validate_grace_minutes(check_in_grace_override)
            if check_in_grace_override is not None else None
        )
        update["check_out_grace_override"] = (
            validate_grace_minutes(check_out_grace_override)
            if check_out_grace_override is not None else None
        )
    else:
        update["default_shift_id"] = None
        update["check_in_grace_override"] = None
        update["check_out_grace_override"] = None

    result = (
        sb.table("departments")
        .update(update)
        .eq("id", str(department_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not result.data:
        raise RuntimeError("Failed to update department default shift")
    return result.data[0]


# ──────────────────────────────────────────────────────────────────────────
# Capture settings (branch + people_type baseline, 'shift' vs 'simple' mode)
# ──────────────────────────────────────────────────────────────────────────

def _mirror_shift_mode_grace(row: Optional[dict]) -> Optional[dict]:
    """In shift mode, upsert_capture_settings persists admin-entered grace
    under default_check_in_grace_override/default_check_out_grace_override
    (see there for why) rather than check_in_grace_minutes/
    check_out_grace_minutes, which are simple-mode-only columns. Mirror the
    values back onto the generic keys on read so the same capture-settings
    form field populates correctly regardless of mode, without needing a
    frontend change to look at a different field name per mode."""
    if not row:
        return row
    if row.get("mode") == "shift":
        row = {
            **row,
            "check_in_grace_minutes": row.get("default_check_in_grace_override"),
            "check_out_grace_minutes": row.get("default_check_out_grace_override"),
        }
    return row


def get_capture_settings(org_id: str, branch_id: str, people_type: str) -> Optional[dict]:
    """Single-branch, single-people_type lookup — used by the edit form and
    internally. Always a real branch; use list_capture_settings for an
    overview across people_types or branches."""
    branch_key = require_specific_branch(branch_id, "Reading capture settings")
    sb = get_supabase()
    normalized = normalize_people_type(people_type)
    try:
        result = (
            sb.table("attendance_capture_settings")
            .select("*")
            .eq("org_id", str(org_id))
            .eq("branch_id", branch_key)
            .eq("people_type", normalized)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        if is_missing_table_or_column(exc, "attendance_capture_settings"):
            return None
        raise
    row = result.data[0] if result.data else None
    return _mirror_shift_mode_grace(row)


def list_capture_settings(org_id: str, branch_id: str | None = None) -> list[dict]:
    """Overview across every people_type for one branch, or branch_id="all"
    (or None/"") for every branch + people_type combination in the org —
    each row annotated with branch_name in the aggregate case. Read-only:
    editing still goes through upsert_capture_settings for one specific
    branch + people_type at a time."""
    sb = get_supabase()
    aggregate = is_all_branches(branch_id)

    query = sb.table("attendance_capture_settings").select("*").eq("org_id", str(org_id))
    if not aggregate:
        query = query.eq("branch_id", str(branch_id))

    try:
        result = query.order("people_type").execute()
    except Exception as exc:
        if is_missing_table_or_column(exc, "attendance_capture_settings"):
            return []
        raise

    rows = result.data or []
    rows = [_mirror_shift_mode_grace(row) for row in rows]
    return attach_branch_names(org_id, rows) if aggregate else rows


def _parse_sync_delay_minutes(value: Any) -> int:
    if value is None:
        return 0
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("sync_delay_minutes must be an integer") from exc
    if parsed < 0:
        raise ValueError("sync_delay_minutes cannot be negative")
    return parsed


def upsert_capture_settings(org_id: str, branch_id: str, people_type: str, payload: dict) -> dict:
    """Save or update capture settings (timing mode + grace overrides) for a
    branch+people_type combination. This function persists to capture_settings
    but does NOT set default_shift_id (which is managed separately by
    set_branch_default_shift if branch-level shift defaults are needed).

    In shift mode, grace_minutes are persisted as default_check_in_grace_override
    and default_check_out_grace_override (see _mirror_shift_mode_grace for why).
    These apply as branch-level fallback grace when staff have no personal grace
    override set.

    Recommended usage: (1) Assign shifts to staff in Staff Management,
    (2) Set sync_delay_minutes and grace overrides here, (3) Use manual
    instructions below to override specific people on specific dates."""
    branch_key = require_specific_branch(branch_id, "Saving capture settings")
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_key)
    normalized = normalize_people_type(people_type)

    mode = clean_text(payload.get("mode")) or "shift"
    if mode not in ("shift", "simple"):
        raise ValueError("mode must be 'shift' or 'simple'")

    capture_check_out = bool(payload.get("capture_check_out", False))

    row: dict[str, Any] = {
        "org_id": str(org_id),
        "branch_id": branch_key,
        "people_type": normalized,
        "mode": mode,
        "capture_check_out": capture_check_out,
        "updated_at": now_iso(),
    }
    if "sync_delay_minutes" in payload:
        row["sync_delay_minutes"] = _parse_sync_delay_minutes(payload.get("sync_delay_minutes"))

    # Scenario 2 (Visit Plan) evidence requirement for this branch+people_type
    # — what a field employee's stop check-in must include before the mobile
    # app's "Log Visit" button is enabled. Lives here rather than a separate
    # table since this is already the exact branch+people_type baseline
    # every other field-staff capture rule lives on; get_capture_settings'
    # select("*") already returns it once the column exists, no read-side
    # change needed. Independent of `mode`/capture_check_out — evidence mode
    # applies the same way whether this branch is in shift or simple mode.
    if "visit_evidence_mode" in payload:
        evidence_mode = clean_text(payload.get("visit_evidence_mode"))
        if evidence_mode not in ("gps_only", "gps_photo", "gps_photo_note"):
            raise ValueError("visit_evidence_mode must be one of gps_only/gps_photo/gps_photo_note")
        row["visit_evidence_mode"] = evidence_mode

    if mode == "simple":
        row["check_in_time"] = validate_time_string(payload.get("check_in_time"), "check_in_time")
        row["check_in_grace_minutes"] = validate_grace_minutes(payload.get("check_in_grace_minutes"))
        if capture_check_out:
            row["check_out_time"] = validate_time_string(payload.get("check_out_time"), "check_out_time")
            row["check_out_grace_minutes"] = validate_grace_minutes(payload.get("check_out_grace_minutes"))
        else:
            row["check_out_time"] = None
            row["check_out_grace_minutes"] = None
        # 'simple' mode is the deliberate non-shift baseline — it never
        # carries a default_shift_id, so clear any that was set while this
        # branch+people_type was previously in 'shift' mode.
        row["default_shift_id"] = None
        row["default_check_in_grace_override"] = None
        row["default_check_out_grace_override"] = None
    else:
        # mode='shift' → raw time is owned entirely by the resolved shift,
        # so check_in_time/check_out_time (the simple-mode fields) are
        # nulled rather than left stale.
        #
        # Grace is different: it has a real meaning in shift mode too — the
        # branch-default-shift's own grace override (tier 4/5, the same
        # columns set_branch_default_shift writes). Previously this branch
        # unconditionally nulled check_in_grace_minutes/check_out_grace_minutes
        # on every save regardless of what the admin entered, because those
        # two columns are simple-mode-only. That silently discarded the
        # value on every "Save Capture Settings" click — it never persisted
        # in shift mode, appearing to "reset to 0" on refresh when in fact
        # it was never written. Route the same form fields to
        # default_check_in_grace_override/default_check_out_grace_override
        # instead, so the existing form keeps working unchanged.
        row["check_in_time"] = None
        row["check_in_grace_minutes"] = None
        row["check_out_time"] = None
        row["check_out_grace_minutes"] = None
        if "check_in_grace_minutes" in payload:
            row["default_check_in_grace_override"] = (
                validate_grace_minutes(payload.get("check_in_grace_minutes"))
                if payload.get("check_in_grace_minutes") is not None else None
            )
        if "check_out_grace_minutes" in payload:
            row["default_check_out_grace_override"] = (
                validate_grace_minutes(payload.get("check_out_grace_minutes"))
                if payload.get("check_out_grace_minutes") is not None else None
            )

    try:
        result = (
            sb.table("attendance_capture_settings")
            .upsert(row, on_conflict="branch_id,people_type")
            .execute()
        )
    except Exception as exc:
        if "sync_delay_minutes" in row and is_missing_table_or_column(exc, "attendance_capture_settings"):
            row.pop("sync_delay_minutes", None)
            result = (
                sb.table("attendance_capture_settings")
                .upsert(row, on_conflict="branch_id,people_type")
                .execute()
            )
        else:
            raise
    if not result.data:
        raise RuntimeError("Failed to save capture settings")
    return result.data[0]


def set_branch_default_shift(
    org_id: str,
    branch_id: str,
    people_type: str,
    shift_id: str | None,
    check_in_grace_override: int | None = None,
    check_out_grace_override: int | None = None,
) -> dict:
    """Branch tier of shift resolution — the least-specific fallback, used
    when a staff member has no shift_id_ref and their department (if any)
    has no default_shift_id. Only meaningful when this branch+people_type's
    capture-settings mode is 'shift'; calling this while mode='simple' is
    rejected rather than silently storing a value resolve_timing_source will
    never read (upsert_capture_settings already nulls this same field when
    switching to 'simple' — this guard covers the other write order, setting
    a default shift before a capture-settings row exists yet, or while it's
    still in 'simple' mode)."""
    branch_key = require_specific_branch(branch_id, "Setting branch default shift")
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_key)
    normalized = normalize_people_type(people_type)

    existing = get_capture_settings(org_id, branch_key, normalized)
    if existing and existing.get("mode") == "simple":
        raise ValueError(
            "This branch+people_type is in 'simple' capture mode — switch it "
            "to 'shift' mode before assigning a default shift"
        )

    update: dict[str, Any] = {
        "org_id": str(org_id),
        "branch_id": branch_key,
        "people_type": normalized,
        "mode": "shift",
        "updated_at": now_iso(),
    }

    if shift_id:
        shift = _get_shift_owned_by_org(sb, org_id, shift_id)
        if str(shift.get("branch_id")) != branch_key:
            raise ValueError("shift_id does not belong to this branch")
        update["default_shift_id"] = str(shift_id)
    else:
        # No shift assigned — grace overrides are still meaningful here
        # (they apply once a shift IS assigned, or stand as the branch's
        # baseline grace preference for this people_type either way), so
        # clearing shift_id must not silently discard whatever grace values
        # were sent alongside it. See the unconditional grace block below —
        # only an explicit clear (both grace args omitted/None) resets them.
        update["default_shift_id"] = None

    update["default_check_in_grace_override"] = (
        validate_grace_minutes(check_in_grace_override)
        if check_in_grace_override is not None else None
    )
    update["default_check_out_grace_override"] = (
        validate_grace_minutes(check_out_grace_override)
        if check_out_grace_override is not None else None
    )

    try:
        result = (
            sb.table("attendance_capture_settings")
            .upsert(update, on_conflict="branch_id,people_type")
            .execute()
        )
    except Exception as exc:
        if is_missing_table_or_column(exc, "attendance_capture_settings"):
            raise RuntimeError(
                "attendance_capture_settings is missing a column this save "
                "needs (default_shift_id / default_check_in_grace_override / "
                "default_check_out_grace_override) — run the pending migration."
            ) from exc
        raise
    if not result.data:
        raise RuntimeError("Failed to set branch default shift")
    return result.data[0]


# ──────────────────────────────────────────────────────────────────────────
# Manual attendance instructions
# ──────────────────────────────────────────────────────────────────────────

def list_manual_instructions(
    org_id: str,
    branch_id: str | None = None,
    people_type: str | None = None,
    staff_id: str | None = None,
) -> list[dict]:
    """List manual attendance instructions. branch_id="all" (or None/"")
    returns every instruction in the org annotated with branch_name.
    people_type, when given, scopes the query to just that people_type using
    the same normalize_people_type every other tier in this codebase uses —
    so "Students"/"students "/"STUDENTS" all resolve to the same row set.
    Previously this had no people_type filter at all; callers (the Timing
    Overrides screen) filtered client-side after fetching the branch's full
    list, which meant every people_type's instructions were always fetched
    and the scoping only existed in the UI, not the API.

    staff_id, when given, scopes to one person's overrides — used by the
    People Management profile panel, which already knows exactly which
    staff member it's showing and has no reason to pull (and briefly hold
    in frontend state) every other staff member's override rows just to
    filter them out client-side."""
    sb = get_supabase()
    aggregate = is_all_branches(branch_id)

    query = sb.table("manual_attendance_instructions").select("*").eq("org_id", str(org_id))
    if not aggregate:
        query = query.eq("branch_id", str(branch_id))
    if staff_id:
        query = query.eq("staff_id", str(staff_id))
    if people_type:
        query = query.eq("people_type", normalize_people_type(people_type))

    try:
        result = query.order("attendance_date", desc=False).execute()
    except Exception as exc:
        if is_missing_table_or_column(exc, "manual_attendance_instructions"):
            return []
        raise

    rows = result.data or []
    return attach_branch_names(org_id, rows) if aggregate else rows


def create_manual_instruction(org_id: str, branch_id: str, payload: dict, created_by: str | None = None) -> dict:
    """Create a manual attendance instruction. Minimal validation only.
    Fields accepted: staff_id, person_code, people_type, attendance_date,
    check_in_time, check_out_time, reason, notes."""
    branch_key = require_specific_branch(branch_id, "Creating manual instruction")
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_key)

    attendance_date_raw = payload.get("attendance_date")
    if not attendance_date_raw:
        raise ValueError("attendance_date is required")

    # Keep times optional and validated by existing helpers where applicable
    # Keep times optional and validated by existing helpers where applicable
    check_in_time = None
    check_out_time = None
    if payload.get("check_in_time") is not None:
        check_in_time = validate_time_string(payload.get("check_in_time"), "check_in_time")
    if payload.get("check_out_time") is not None:
        check_out_time = validate_time_string(payload.get("check_out_time"), "check_out_time")

    # Grace minutes were accepted by the form and read back out by
    # resolve_manual_instruction_window, but never actually written here —
    # both columns were always NULL regardless of what the operator typed.
    check_in_grace_minutes = None
    if payload.get("check_in_grace_minutes") is not None:
        check_in_grace_minutes = validate_grace_minutes(payload.get("check_in_grace_minutes"))
    check_out_grace_minutes = None
    if payload.get("check_out_grace_minutes") is not None:
        check_out_grace_minutes = validate_grace_minutes(payload.get("check_out_grace_minutes"))

    row = {
        "org_id": str(org_id),
        "branch_id": branch_key,
        "staff_id": str(payload.get("staff_id")) if payload.get("staff_id") else None,
        "person_code": clean_text(payload.get("person_code")) or None,
        "people_type": normalize_people_type(payload.get("people_type") or payload.get("person_type") or ""),
        "attendance_date": str(attendance_date_raw),
        "check_in_time": check_in_time,
        "check_in_grace_minutes": check_in_grace_minutes,
        "check_out_time": check_out_time,
        "check_out_grace_minutes": check_out_grace_minutes,
        "reason": clean_text(payload.get("reason")) or None,
        "notes": clean_text(payload.get("notes")) or None,
        "status": "pending",
        "created_by": str(created_by) if created_by else None,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }

    result = sb.table("manual_attendance_instructions").insert(row).execute()
    if not result.data:
        raise RuntimeError("Failed to create manual attendance instruction")
    return result.data[0]


def list_pending_manual_instructions_for_branch(org_id: str, branch_id: str) -> list[dict]:
    """Return pending instructions for a specific branch (node poll target).

    Enriches each row with staff_name (and backfills person_code when the
    instruction only has staff_id) by joining client_staff — the
    manual_attendance_instructions table itself has no name column, only
    staff_id/person_code, so without this join the node has nothing to show
    but the raw id, which is what it was displaying ("0004" instead of the
    person's name) before this fix."""
    branch_key = require_specific_branch(branch_id, "Polling manual instructions")
    sb = get_supabase()
    try:
        result = (
            sb.table("manual_attendance_instructions")
            .select("*")
            .eq("org_id", str(org_id))
            .eq("branch_id", branch_key)
            .eq("status", "pending")
            .order("created_at")
            .execute()
        )
    except Exception as exc:
        if is_missing_table_or_column(exc, "manual_attendance_instructions"):
            return []
        raise

    rows = result.data or []
    staff_ids = {str(row["staff_id"]) for row in rows if row.get("staff_id")}
    staff_by_id: dict = {}
    if staff_ids:
        staff_result = (
            sb.table("client_staff")
            .select("id, name, person_code, people_type")
            .eq("org_id", str(org_id))
            .in_("id", list(staff_ids))
            .execute()
        )
        staff_by_id = {str(row["id"]): row for row in (staff_result.data or [])}

    for row in rows:
        staff = staff_by_id.get(str(row.get("staff_id") or ""))
        if staff:
            row["staff_name"] = staff.get("name") or ""
            if not row.get("person_code"):
                row["person_code"] = staff.get("person_code")
            if not row.get("people_type"):
                row["people_type"] = staff.get("people_type")
        else:
            row.setdefault("staff_name", "")

    return rows


def update_manual_instruction_status(org_id: str, instruction_id: str, status: str, note: str | None = None) -> dict:
    """Update status of a manual instruction (applied/failed/synced) — this
    is the node-sync ack path (manual_instructions_worker.py's
    ack_manual_instruction), NOT the admin-delete path. 'status' tracks
    where an instruction is in the pending -> applied/failed lifecycle;
    it is a different axis from an admin deleting the instruction outright,
    which is delete_manual_instruction below."""
    sb = get_supabase()
    updates = {"status": clean_text(status), "updated_at": now_iso()}
    if note is not None:
        updates["notes"] = clean_text(note)

    result = (
        sb.table("manual_attendance_instructions")
        .update(updates)
        .eq("id", str(instruction_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not result.data:
        raise ValueError(f"Instruction {instruction_id!r} not found for this org")
    return result.data[0]


def delete_manual_instruction(org_id: str, instruction_id: str) -> bool:
    """Hard delete — the row is removed outright, not soft-marked. Previously
    the DELETE route called update_manual_instruction_status(..., "deleted"),
    which only overwrote the status column; since list_manual_instructions
    never filtered status='deleted' out, the row kept coming back in every
    subsequent list call. This removes it for good.

    Scoped by org_id in the same .eq() as the delete itself (not a separate
    pre-check query) — Supabase only deletes and returns rows matching both
    id and org_id, so a request for another org's instruction deletes
    nothing and result.data comes back empty, which we surface as a clean
    'not found' rather than a silent no-op.

    Note: a local node that already polled this instruction (via
    list_pending_manual_instructions_for_branch) before it was deleted may
    still attempt to ack it after the fact; that ack will 404 against a
    missing row. This is a pre-existing race between node polling and
    admin action, not something this change introduces — the previous
    soft-delete had the same window, just with a row that lingered forever
    instead of disappearing correctly."""
    sb = get_supabase()
    result = (
        sb.table("manual_attendance_instructions")
        .delete()
        .eq("id", str(instruction_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not result.data:
        raise ValueError(f"Instruction {instruction_id!r} not found for this org")
    return True