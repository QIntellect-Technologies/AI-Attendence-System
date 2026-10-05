"""
support_db_hierarchy.py
──────────────────────────────────────────────────────────────────────────────
Manager-chain hierarchy for client_staff ("Option B" from the schema
discussion). Kept in its own module — same one-file-per-concern pattern as
support_db_shifts.py / support_db_attendance_settings.py — so nothing here
touches an existing, working file directly. Wiring into the notification
path is a separate, minimal, additive diff (see PATCH_NOTES.md).

Schema (see migrations/004_add_staff_manager_hierarchy.sql):
  client_staff.manager_id             -> self-referencing FK, nullable.
                                          NULL = no manager set. That's
                                          every existing row today — nothing
                                          changes until an admin explicitly
                                          assigns one.
  client_staff.linked_client_user_id  -> FK into client_users, nullable.
                                          A manager only becomes a
                                          notification TARGET once this is
                                          set. manager_id alone gives you an
                                          org chart, not a routable
                                          recipient — client_staff
                                          (employees) and client_users
                                          (dashboard accounts) are different
                                          tables/audiences (see
                                          client_staff_auth.py docstring).

Every function is org-scoped and UUID-validated the same way
support_db_time_utils.get_branch_owned_by_org already does elsewhere in
this codebase — a malformed id raises a clean ValueError (-> 400 via
client_routes_helpers.handle), never a raw Postgrest error.

All walks (cycle-check, manager-chain) are capped at _MAX_CHAIN_DEPTH so a
corrupt row can never hang a request with unbounded recursion/looping —
real org charts are nowhere near this deep.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from supabase_client import get_supabase
from support_db_time_utils import (
    now_iso as _now_iso,
    clean_text as _clean_text,
    normalize_people_type as _normalize_people_type,
    is_missing_table_or_column as _is_missing_table_or_column,
)

_MAX_CHAIN_DEPTH = 25

# people_type-aware label for "who is this person's manager" — matches the
# vertical-aware pattern already used for staff_type/people_type elsewhere
# (see client_staff_auth.py _mint_token docstring: student/staff/doctor/
# worker). Purely a display label; falls back to "Manager" for anything not
# listed rather than raising, since new people_types get added elsewhere
# without this module knowing about them.
_MANAGER_LABEL_BY_PEOPLE_TYPE = {
    "student": "Class Teacher",
    "doctor": "Department Head",
    "worker": "Supervisor",
    "staff": "Manager",
}


def manager_label_for(people_type: Optional[str]) -> str:
    return _MANAGER_LABEL_BY_PEOPLE_TYPE.get(_normalize_people_type(people_type), "Manager")


def _validate_uuid(value, field_name: str) -> str:
    text = _clean_text(value)
    if not text:
        raise ValueError(f"{field_name} is required")
    try:
        UUID(text)
    except ValueError:
        raise ValueError(f"'{text}' is not a valid {field_name}")
    return text


# ─── Ownership / lookup ─────────────────────────────────────────────────

def _get_staff_owned_by_org(org_id: str, staff_id) -> dict:
    """Single query, org-scoped — a staff id from another tenant can never
    be read or written via this module, same guarantee as every other
    org-scoped lookup in this codebase (get_branch_owned_by_org, etc.)."""
    sb = get_supabase()
    staff_key = _validate_uuid(staff_id, "staff_id")
    result = (
        sb.table("client_staff")
        .select("id, name, people_type, manager_id, linked_client_user_id, org_id")
        .eq("id", staff_key)
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError("Staff member not found in this organization")
    return result.data[0]


# ─── Cycle-safe manager assignment ──────────────────────────────────────

def _would_create_cycle(org_id: str, staff_id: str, proposed_manager_id: str) -> bool:
    """Walk UP from proposed_manager_id; if we ever hit staff_id, assigning
    it would create a loop (direct or indirect, e.g. A -> B -> C -> A).
    One query per hop, capped at _MAX_CHAIN_DEPTH — org charts are shallow
    in practice, so this stays fast; the cap exists purely so a corrupt or
    adversarial chain can never hang the request."""
    sb = get_supabase()
    current = str(proposed_manager_id)
    seen = set()
    for _ in range(_MAX_CHAIN_DEPTH):
        if current == str(staff_id):
            return True
        if current in seen:
            # Pre-existing corrupt chain (shouldn't happen post-migration,
            # but fail safe rather than looping forever).
            return True
        seen.add(current)
        result = (
            sb.table("client_staff")
            .select("manager_id")
            .eq("id", current)
            .eq("org_id", str(org_id))
            .limit(1)
            .execute()
        )
        if not result.data or not result.data[0].get("manager_id"):
            return False
        current = str(result.data[0]["manager_id"])
    return True  # hit the depth cap without resolving — treat as unsafe


def assign_manager(org_id: str, staff_id: str, manager_id: Optional[str]) -> dict:
    """Set (or clear, if manager_id is falsy) a staff member's manager.

    Deliberately does NOT touch linked_client_user_id — that's a property
    of the MANAGER's own row (their dashboard account), set once via
    set_linked_client_user regardless of how many people report to them.
    An earlier version of this function accepted linked_client_user_id here
    and wrote it onto staff_id's row instead of the manager's — that was a
    bug (resolve_notification_target reads it off the manager, not the
    report), caught by test_hierarchy_direct.py step 8. Splitting the two
    operations removes the mismatch entirely rather than papering over it.

    Raises ValueError for: bad/foreign-org uuids, self-assignment, or a
    cycle. Raises RuntimeError only if the Supabase write itself fails
    after all validation passes.
    """
    staff = _get_staff_owned_by_org(org_id, staff_id)
    sb = get_supabase()

    update: dict = {"updated_at": _now_iso()}

    if not manager_id:
        update["manager_id"] = None
    else:
        manager_key = _validate_uuid(manager_id, "manager_id")
        if manager_key == staff["id"]:
            raise ValueError("A staff member cannot be their own manager")

        # Confirms the manager row exists and belongs to this org — reuses
        # the same ownership check as the staff being assigned, so a
        # manager id from another tenant is rejected with a clean
        # ValueError, never a dangling cross-tenant FK write.
        _get_staff_owned_by_org(org_id, manager_key)

        if _would_create_cycle(org_id, staff["id"], manager_key):
            raise ValueError("This assignment would create a manager loop")

        update["manager_id"] = manager_key

    result = (
        sb.table("client_staff")
        .update(update)
        .eq("id", staff["id"])
        .eq("org_id", str(org_id))
        .execute()
    )
    if not result.data:
        raise RuntimeError("Failed to update manager assignment")
    return result.data[0]


def set_linked_client_user(org_id: str, staff_id: str, client_user_id: Optional[str]) -> dict:
    """Set (or clear, if client_user_id is falsy) staff_id's OWN linked
    dashboard account — i.e. "when this person is someone's manager, notify
    THIS client_users account". Set once on the manager's own profile, not
    repeated per direct report. This is the only function that writes
    linked_client_user_id.

    Raises ValueError if client_user_id isn't a real client_users row in
    this org, or if staff_id isn't a real client_staff row in this org.
    """
    staff = _get_staff_owned_by_org(org_id, staff_id)
    sb = get_supabase()

    update: dict = {"updated_at": _now_iso()}
    if not client_user_id:
        update["linked_client_user_id"] = None
    else:
        user_key = _validate_uuid(client_user_id, "client_user_id")
        user_result = (
            sb.table("client_users")
            .select("id")
            .eq("id", user_key)
            .eq("org_id", str(org_id))
            .limit(1)
            .execute()
        )
        if not user_result.data:
            raise ValueError("client_user_id does not belong to this organization")
        update["linked_client_user_id"] = user_key

    result = (
        sb.table("client_staff")
        .update(update)
        .eq("id", staff["id"])
        .eq("org_id", str(org_id))
        .execute()
    )
    if not result.data:
        raise RuntimeError("Failed to update linked account")
    return result.data[0]


# ─── Reads ───────────────────────────────────────────────────────────────

def get_manager_chain(org_id: str, staff_id: str) -> list[dict]:
    """Ordered list from immediate manager up to the top — [] if the staff
    member has no manager. Same bounded-walk shape as _would_create_cycle;
    each row includes people_type so a frontend can render manager_label_for
    per hop (e.g. "Class Teacher" vs "Manager") without a second lookup."""
    staff = _get_staff_owned_by_org(org_id, staff_id)
    sb = get_supabase()
    chain: list[dict] = []
    current = staff.get("manager_id")
    seen = set()
    for _ in range(_MAX_CHAIN_DEPTH):
        if not current or current in seen:
            break
        seen.add(current)
        result = (
            sb.table("client_staff")
            .select("id, name, people_type, manager_id, linked_client_user_id")
            .eq("id", str(current))
            .eq("org_id", str(org_id))
            .limit(1)
            .execute()
        )
        if not result.data:
            break
        row = result.data[0]
        row["manager_label"] = manager_label_for(row.get("people_type"))
        chain.append(row)
        current = row.get("manager_id")
    return chain


def list_org_client_users(org_id: str) -> list[dict]:
    """Read-only list of this org's client_users (dashboard admin accounts),
    for the "linked dashboard account" picker on a manager's profile. Kept
    minimal and additive — id/name/email only, no auth fields. Not paginated:
    same assumption as get_direct_reports, an org's admin-account list is
    small enough for a single flat query."""
    org_key = _validate_uuid(org_id, "org_id")
    sb = get_supabase()
    result = (
        sb.table("client_users")
        # client_users has no "name" column — it's "full_name" (see
        # support_db_client_users.py / client_dashboard_auth.py, the active
        # queries against this same table). Selecting "name" here throws a
        # generic (non-ValueError) exception that handle() maps to a bare
        # 500, which is what was happening on this endpoint.
        .select("id, full_name, email")
        .eq("org_id", org_key)
        .order("full_name")
        .execute()
    )
    rows = result.data or []
    return [
        {
            "id": row.get("id"),
            "name": row.get("full_name"),
            "full_name": row.get("full_name"),
            "email": row.get("email"),
        }
        for row in rows
    ]


def get_direct_reports(org_id: str, staff_id: str) -> list[dict]:
    """Single flat query — everyone whose manager_id is this staff member.
    Not recursive (that's get_manager_chain's job, in the other direction);
    a manager's full subtree can be built by calling this again per child
    if a screen ever needs it, but the common case (one admin screen: "who
    reports to this person") only needs this one level, one query."""
    staff = _get_staff_owned_by_org(org_id, staff_id)
    sb = get_supabase()
    result = (
        sb.table("client_staff")
        .select("id, name, people_type, department_id, branch_id")
        .eq("org_id", str(org_id))
        .eq("manager_id", staff["id"])
        .order("name")
        .execute()
    )
    return result.data or []


def get_subordinate_ids(org_id: str, staff_id: str) -> set[str]:
    """Every staff id under staff_id in the manager tree, at any depth —
    the inverse direction of _would_create_cycle (which walks UP from a
    proposed manager to check for loops; this walks DOWN from a manager to
    find their full team).
 
    Iterative level-by-level (BFS), not per-node recursion, so this stays
    ONE query per depth level rather than one query per person — a manager
    with 40 direct reports costs the same as a manager with 4, for a given
    tree depth. Depth is still capped at _MAX_CHAIN_DEPTH for the same
    corrupt-chain-can't-hang-a-request reason as every other walk in this
    module.
 
    Returns a set of string ids (never includes staff_id itself — callers
    that want "self + team" add staff_id explicitly, matching
    client_dashboard_auth.get_team_scope_ids's behavior). Returns an empty
    set for a staff member with zero reports, never raises for that case —
    only raises ValueError if staff_id itself doesn't belong to this org
    (via _get_staff_owned_by_org's existing ownership check).
 
    This is the ONLY function team-scoped routes should call to build a
    visibility set. Never reconstruct this walk at the route layer — a
    second, slightly-different implementation is how row-scope bugs get
    introduced later.
    """
    # Confirms staff_id is real and belongs to this org before walking —
    # same fail-fast contract as get_manager_chain/get_direct_reports.
    _get_staff_owned_by_org(org_id, staff_id)
 
    sb = get_supabase()
    org_key = str(org_id)
    root_key = str(staff_id)
 
    all_subordinates: set[str] = set()
    current_level = {root_key}
    seen = {root_key}
 
    for _ in range(_MAX_CHAIN_DEPTH):
        if not current_level:
            break
        result = (
            sb.table("client_staff")
            .select("id, manager_id")
            .eq("org_id", org_key)
            .in_("manager_id", list(current_level))
            .execute()
        )
        rows = result.data or []
        next_level: set[str] = set()
        for row in rows:
            child_id = str(row["id"])
            if child_id in seen:
                # Corrupt/cyclical data (shouldn't happen post cycle-check,
                # but never loop forever over it).
                continue
            seen.add(child_id)
            all_subordinates.add(child_id)
            next_level.add(child_id)
        current_level = next_level
 
    return all_subordinates

_VALID_DASHBOARD_SCOPES = {"branch", "team"}


def set_dashboard_scope(org_id: str, staff_id: str, scope: Optional[str]) -> dict:
    """Set staff_id's own dashboard_scope — 'team' means their Client
    Dashboard session (once client_dashboard_auth.mint_dashboard_token mints
    their NEXT token) is narrowed server-side to themself + everyone under
    them in the manager tree (get_subordinate_ids). 'branch' (or omitted)
    is today's default: unrestricted within their branch/org, unchanged
    from before this feature existed.

    Deliberately its own function/endpoint rather than a field folded into
    a general staff PATCH — same reasoning staffApi.ts's
    setStaffDashboardScope docstring gives: an explicit, individually
    auditable action, not a side effect of an unrelated profile edit.

    Does not touch manager_id, linked_client_user_id, or access_modules —
    one more independent knob on the same row. Payroll access is
    unaffected either way: module access and hierarchy scope are separate
    axes (see client_dashboard_auth.get_team_scope_ids's docstring).
    """
    staff = _get_staff_owned_by_org(org_id, staff_id)
    sb = get_supabase()

    normalized = (_clean_text(scope) or "branch").lower()
    if normalized not in _VALID_DASHBOARD_SCOPES:
        raise ValueError(
            f"dashboard_scope must be one of {sorted(_VALID_DASHBOARD_SCOPES)}"
        )

    result = (
        sb.table("client_staff")
        .update({"dashboard_scope": normalized, "updated_at": _now_iso()})
        .eq("id", staff["id"])
        .eq("org_id", str(org_id))
        .execute()
    )
    if not result.data:
        raise RuntimeError("Failed to update dashboard scope")
    return result.data[0]


def resolve_notification_target(org_id: str, staff_id: str) -> Optional[str]:
    """The client_staff id (the manager's OWN row — managers authenticate
    via the Staff Panel/client_staff_auth, they don't have a client_users
    account) to notify for an exception raised on this staff member, or
    None if there isn't one (no manager assigned).

    client_users is one row per organization (the account that purchased
    the system), not one per person — there is nothing for a manager to be
    "linked" to there, so this no longer indirects through
    linked_client_user_id the way it used to. The caller
    (support_db_attendance_exceptions.py) passes this straight to
    create_notification's recipient_staff_ids, not recipient_user_ids.

    Callers fall back to the existing org-wide client_users broadcast when
    this returns None (no manager assigned yet).

    Soft-fail like the rest of the notification path: a schema-drift or
    lookup issue here returns None (falls back to broadcast) rather than
    raising and blocking the attendance write.
    """
    try:
        staff = _get_staff_owned_by_org(org_id, staff_id)
    except ValueError:
        return None
    manager_id = staff.get("manager_id")
    if not manager_id:
        return None
    # Confirm the manager row still exists in this org (not deleted/moved
    # since it was assigned) rather than trusting the foreign key blindly —
    # same defensive posture the old lookup had.
    try:
        result = (
            get_supabase()
            .table("client_staff")
            .select("id")
            .eq("id", str(manager_id))
            .eq("org_id", str(org_id))
            .limit(1)
            .execute()
        )
    except Exception as exc:
        if _is_missing_table_or_column(exc, "client_staff"):
            return None
        raise
    if not result.data:
        return None
    return str(manager_id)