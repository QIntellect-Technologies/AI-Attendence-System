"""
support_db_time_utils.py
──────────────────────────────────────────────────────────────────────────────
Shared validation/ownership helpers for anything that manages branch-scoped
time-based config (shifts, capture settings, half-day windows, overrides).
Extracted so support_db_shifts.py and support_db_attendance_settings.py don't
duplicate the same HH:MM validation and branch-ownership check — same
"shared package, no circular import" pattern as shared_face_engine.

This module also owns the single definition of the "aggregate across all
branches" sentinel. Any route/table that is normally scoped to one branch
(shifts, capture settings, half-day windows, timing overrides) can be asked
for a cross-branch read using this sentinel in the branch_id slot. There is
exactly one place that recognizes it (is_all_branches below) so every call
site — routes and db-layer functions alike — agrees on what "all" means.
Write operations (create/update/delete) must never accept it; only list/read
functions do.
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from supabase_client import get_supabase

# ─── Aggregate ("all branches") sentinel ───────────────────────────────────

_ALL_BRANCHES_TOKENS = {"all", "*", "global", ""}


def is_all_branches(branch_id: Any) -> bool:
    """True when branch_id means 'don't filter by branch — aggregate across
    every branch in this org'. Recognizes an explicit sentinel string, an
    empty string, and None (Global-view callers that never had a branch to
    begin with). A real, malformed, or unowned branch id is NOT this — those
    fall through to get_branch_owned_by_org, which raises a clean ValueError
    instead of a raw Postgrest error."""
    if branch_id is None:
        return True
    return str(branch_id).strip().lower() in _ALL_BRANCHES_TOKENS


def require_specific_branch(branch_id: Any, action: str) -> str:
    """For write operations that can never target 'all branches'. Returns the
    cleaned branch id, or raises a clear ValueError naming the action, so the
    400 tells you exactly what was rejected and why."""
    if is_all_branches(branch_id):
        raise ValueError(f"{action} requires one specific branch_id, not 'all'")
    cleaned = clean_text(branch_id)
    if not cleaned:
        raise ValueError("branch_id is required")
    return cleaned


# ─── Basic scalar helpers ───────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def normalize_people_type(value: Any) -> str:
    return clean_text(value).lower().replace(" ", "_").replace("-", "_") or "staff"


def validate_time_string(value: Any, field_name: str = "time") -> str:
    text = clean_text(value)
    parts = text.split(":")
    if len(parts) < 2:
        raise ValueError(f"{field_name} must be in HH:MM format")
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        raise ValueError(f"{field_name} must be in HH:MM format")
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"{field_name} must be a valid 24-hour time")
    return f"{hour:02d}:{minute:02d}:00"


def validate_grace_minutes(value: Any, max_minutes: int = 240) -> int:
    grace = int(value or 0)
    if not (0 <= grace <= max_minutes):
        raise ValueError(f"grace_minutes must be between 0 and {max_minutes}")
    return grace


# ─── Branch ownership ───────────────────────────────────────────────────────

def get_branch_owned_by_org(org_id: str, branch_id: str) -> dict:
    """Raises ValueError (→ clean 400) for every bad-input case, including a
    branch_id that isn't even UUID-shaped. Without the UUID pre-check,
    PostgREST rejects a non-UUID string with a raw 'invalid input syntax for
    type uuid' error that isn't a ValueError — it was falling through to the
    generic 500 in client_routes_helpers.handle() instead of a clean 400
    naming the bad value. This is what a Global-view caller passing a
    placeholder like '1' or 'all' by mistake (instead of going through
    is_all_branches()) used to hit."""
    branch_key = clean_text(branch_id)
    if not branch_key:
        raise ValueError("branch_id is required")
    try:
        UUID(branch_key)
    except ValueError:
        raise ValueError(f"'{branch_key}' is not a valid branch id")

    sb = get_supabase()
    result = (
        sb.table("branches")
        .select("*")
        .eq("id", branch_key)
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError("Branch does not belong to this organization")
    return result.data[0]


def list_org_branch_ids(org_id: str) -> list[dict]:
    """All branches for this org — used to scope aggregate ('all branches')
    queries and to attach a readable branch_name to aggregate rows."""
    sb = get_supabase()
    result = (
        sb.table("branches")
        .select("id, name")
        .eq("org_id", str(org_id))
        .order("name")
        .execute()
    )
    return result.data or []


def attach_branch_names(org_id: str, rows: list[dict]) -> list[dict]:
    """Enriches aggregate ('all branches') rows with branch_name, batched as
    a single extra query rather than N+1 per row. A row with no branch_id
    (org-wide departments) gets 'All Branches' rather than being left blank,
    since that's a distinct, meaningful state in the UI, not missing data."""
    if not rows:
        return rows

    branch_ids = sorted({str(r["branch_id"]) for r in rows if r.get("branch_id")})
    name_by_id: dict[str, str] = {}
    if branch_ids:
        sb = get_supabase()
        result = (
            sb.table("branches")
            .select("id, name")
            .eq("org_id", str(org_id))
            .in_("id", branch_ids)
            .execute()
        )
        name_by_id = {str(b["id"]): b.get("name") for b in (result.data or [])}

    for row in rows:
        bid = str(row.get("branch_id") or "")
        row["branch_name"] = name_by_id.get(bid) if bid else "All Branches"
    return rows


# ─── Schema-drift guard ─────────────────────────────────────────────────────

def is_missing_table_or_column(exc: Exception, name: str) -> bool:
    """Shared with support_db.py's identically-behaved _table_missing (kept
    here, not there, since support_db_shifts.py / support_db_attendance_
    settings.py deliberately don't import support_db.py — see that module's
    own docstring on the no-circular-import rule). support_db.py should
    import this rather than keep its own copy."""
    text = str(exc).lower()
    return str(name).lower() in text and (
        "could not find" in text or "does not exist" in text
        or "schema cache" in text or "pgrst204" in text or "pgrst205" in text
    )

def validate_sync_delay_minutes(value: Any, max_minutes: int = 1440) -> int:
    """Unlike grace (capped at 240 — a shift's grace window has no business
    being 4+ hours), a sync delay can reasonably span up to a full day for
    branches batching once-daily. Same 'raise ValueError, no silent clamp'
    contract as validate_grace_minutes."""
    delay = int(value or 0)
    if not (0 <= delay <= max_minutes):
        raise ValueError(f"sync_delay_minutes must be between 0 and {max_minutes}")
    return delay