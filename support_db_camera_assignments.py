"""
support_db_camera_assignments.py
──────────────────────────────────────────────────────────────────────────────
Two deliberately separate assignment concerns for a branch's cameras:

  1. Camera -> NODE  (branch_cameras.assigned_node_id)
     Which physical machine is responsible for pulling this camera's RTSP
     stream and running recognition against it. get_node_config()
     (support_db_nodes.py) only ever returns a camera to the node it is
     assigned to — an unassigned camera is processed by nobody, never by
     everybody, so two machines can never double-process the same stream.
     See migration 2026-09-18_camera_node_and_context_assignment.sql.

  2. Camera -> CONTEXT  (camera_context_assignments)
     What a recognition on this camera *means*: which department/class/
     section it should be attributed to. Many-to-many — a camera may carry
     zero, one, or several tags at once (e.g. a hallway camera relevant to
     two sections). This has nothing to do with (1): a camera's processing
     node can change without touching its business-context tags, and vice
     versa.

Neither of these tables is read by any pre-existing code path except the
node_config change above, so every function here is purely additive.

Design rules (matching support_db_attendance_settings.py):
  1. Every function returns plain dicts — never raw Supabase response objects.
  2. Every write is org_id (+ branch_id) scoped; ownership is checked before
     any insert/update/delete via get_branch_owned_by_org, never assumed
     from the payload alone.
  3. Validation errors raise ValueError with a field name in the message, so
     route handlers can turn them into clean 400s.
"""
from __future__ import annotations

from typing import Any, Optional

from supabase_client import get_supabase
from support_db_time_utils import (
    now_iso,
    clean_text,
    get_branch_owned_by_org,
)
from support_db_attendance_settings import (
    list_departments as _list_departments,
    list_classes as _list_classes,
    list_sections as _list_sections,
)

_CONTEXT_TYPES = ("department", "class", "section")
_ASSIGNMENT_TYPES = ("permanent", "temporary")


def _get_camera_owned_by_branch(sb, org_id: str, branch_id: str, camera_id: str) -> dict:
    result = (
        sb.table("branch_cameras")
        .select("*")
        .eq("id", str(camera_id))
        .eq("organization_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError(f"camera_id {camera_id!r} not found on this branch")
    return result.data[0]


def _get_active_node_owned_by_branch(sb, org_id: str, branch_id: str, node_id: str) -> dict:
    result = (
        sb.table("node_api_keys")
        .select("node_id,node_label,status")
        .eq("node_id", str(node_id))
        .eq("org_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError(f"node_id {node_id!r} not found on this branch")
    node = result.data[0]
    if node.get("status") != "active":
        raise ValueError(f"node_id {node_id!r} is not active — reassign to an active node")
    return node


def _get_department_owned_by_branch(sb, org_id: str, branch_id: str, department_id: str) -> dict:
    result = (
        sb.table("departments")
        .select("id,org_id,branch_id")
        .eq("id", str(department_id))
        .eq("org_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError(f"department_id {department_id!r} not found on this branch")
    return result.data[0]


def _get_class_owned_by_branch(sb, org_id: str, branch_id: str, class_id: str) -> dict:
    result = (
        sb.table("classes")
        .select("id,org_id,branch_id")
        .eq("id", str(class_id))
        .eq("org_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError(f"class_id {class_id!r} not found on this branch")
    return result.data[0]


def _get_section_owned_by_branch(sb, org_id: str, branch_id: str, section_id: str) -> dict:
    """Sections don't carry branch_id directly (see support_db_attendance_settings.py:
    a section belongs to a class, a class belongs to a branch) — so ownership is
    checked one hop up, through the section's class."""
    result = (
        sb.table("sections")
        .select("id,org_id,class_id")
        .eq("id", str(section_id))
        .eq("org_id", str(org_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError(f"section_id {section_id!r} not found for this organization")
    section = result.data[0]
    _get_class_owned_by_branch(sb, org_id, branch_id, section["class_id"])
    return section


# Dispatch table so create_camera_context_assignment can validate whichever
# target type it received with one lookup instead of an if/elif chain — one
# place to extend if a fourth context_type is ever added.
_CONTEXT_OWNERSHIP_CHECKS = {
    "department": _get_department_owned_by_branch,
    "class": _get_class_owned_by_branch,
    "section": _get_section_owned_by_branch,
}


# ──────────────────────────────────────────────────────────────────────────
# Camera -> node assignment
# ──────────────────────────────────────────────────────────────────────────

def list_branch_active_nodes(org_id: str, branch_id: str) -> list[dict]:
    """Active nodes on this branch, for the assignment picker. A branch can
    have more than one concurrently-active node (see
    activate_node_with_install_token), so this is a list, not a single row.
    """
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_id)
    result = (
        sb.table("node_api_keys")
        .select("node_id,node_label,last_seen_at,status")
        .eq("org_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .eq("status", "active")
        .order("node_label")
        .execute()
    )
    return result.data or []


def list_branch_cameras_with_assignment(org_id: str, branch_id: str) -> list[dict]:
    """Every camera on the branch, each carrying its current
    assigned_node_id (None = unassigned, excluded from every node's
    config) — the shape a camera-assignment admin screen needs in one call.
    """
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_id)
    result = (
        sb.table("branch_cameras")
        .select("id,camera_name,camera_type,channel,location,enabled,assigned_node_id")
        .eq("organization_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .order("channel")
        .execute()
    )
    return result.data or []


def assign_camera_to_node(org_id: str, branch_id: str, camera_id: str, node_id: str) -> dict:
    """Assign one camera to one active node on the same branch. A camera
    can only ever be assigned to a single node at a time (re-assigning
    simply overwrites the previous value) — that exclusivity is what
    prevents two machines from both pulling the same RTSP stream.
    """
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_id)
    _get_camera_owned_by_branch(sb, org_id, branch_id, camera_id)
    node = _get_active_node_owned_by_branch(sb, org_id, branch_id, node_id)

    result = (
        sb.table("branch_cameras")
        .update({"assigned_node_id": node["node_id"], "updated_at": now_iso()})
        .eq("id", str(camera_id))
        .eq("organization_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .execute()
    )
    if not result.data:
        raise RuntimeError("Failed to assign camera to node")
    return result.data[0]


def unassign_camera_from_node(org_id: str, branch_id: str, camera_id: str) -> dict:
    """Clear a camera's node assignment. The camera is then excluded from
    every node's config until reassigned — it does NOT fall back to being
    processed by whichever node happens to be active (see get_node_config's
    single-node backward-compatibility fallback for the one narrow
    exception, which does not apply once any camera has ever been
    assigned)."""
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_id)
    _get_camera_owned_by_branch(sb, org_id, branch_id, camera_id)

    result = (
        sb.table("branch_cameras")
        .update({"assigned_node_id": None, "updated_at": now_iso()})
        .eq("id", str(camera_id))
        .eq("organization_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .execute()
    )
    if not result.data:
        raise RuntimeError("Failed to unassign camera")
    return result.data[0]


# ──────────────────────────────────────────────────────────────────────────
# Camera -> business-context assignment (department / class / section)
# ──────────────────────────────────────────────────────────────────────────

def list_camera_context_assignments(
    org_id: str, branch_id: str, *, camera_id: Optional[str] = None, include_inactive: bool = False
) -> list[dict]:
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_id)
    query = (
        sb.table("camera_context_assignments")
        .select("*")
        .eq("org_id", str(org_id))
        .eq("branch_id", str(branch_id))
    )
    if camera_id:
        query = query.eq("camera_id", str(camera_id))
    if not include_inactive:
        query = query.eq("status", "active")
    return query.order("created_at").execute().data or []


def create_camera_context_assignment(org_id: str, branch_id: str, camera_id: str, payload: dict) -> dict:
    """payload requires context_type ('department'|'class'|'section') and
    exactly the matching *_id field (department_id / class_id / section_id).
    Extra target fields are rejected rather than silently ignored, so a
    caller can never end up with a row whose context_type disagrees with
    which FK is actually set (the DB CHECK constraint enforces this too;
    this is the friendlier pre-check).
    """
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_id)
    _get_camera_owned_by_branch(sb, org_id, branch_id, camera_id)

    context_type = clean_text(payload.get("context_type"))
    if context_type not in _CONTEXT_TYPES:
        raise ValueError(f"context_type must be one of {_CONTEXT_TYPES}")

    target_field = f"{context_type}_id"
    other_fields = [f"{t}_id" for t in _CONTEXT_TYPES if t != context_type]
    for field in other_fields:
        if payload.get(field):
            raise ValueError(f"{field} must not be set when context_type is {context_type!r}")

    target_id = clean_text(payload.get(target_field))
    if not target_id:
        raise ValueError(f"{target_field} is required when context_type is {context_type!r}")

    # Confirm the department/class/section actually belongs to this org AND
    # this branch before ever inserting the row. The DB FK (see the 2026-09-18
    # migration) only guarantees the org matches for department/class, and
    # doesn't check branch or org at all for section — this is the app-level
    # check that catches a camera in one branch being tagged to another
    # branch's (or another org's) department/class/section.
    _CONTEXT_OWNERSHIP_CHECKS[context_type](sb, org_id, branch_id, target_id)

    assignment_type = clean_text(payload.get("assignment_type")) or "permanent"
    if assignment_type not in _ASSIGNMENT_TYPES:
        raise ValueError(f"assignment_type must be one of {_ASSIGNMENT_TYPES}")

    row = {
        "org_id": str(org_id),
        "branch_id": str(branch_id),
        "camera_id": str(camera_id),
        "context_type": context_type,
        "department_id": str(target_id) if context_type == "department" else None,
        "class_id": str(target_id) if context_type == "class" else None,
        "section_id": str(target_id) if context_type == "section" else None,
        "assignment_type": assignment_type,
        "effective_from": clean_text(payload.get("effective_from")) or None,
        "effective_to": clean_text(payload.get("effective_to")) or None,
        "status": "active",
    }

    result = sb.table("camera_context_assignments").insert(row).execute()
    if not result.data:
        raise RuntimeError("Failed to create camera context assignment")
    return result.data[0]


# ──────────────────────────────────────────────────────────────────────────
# Picker data for the context-assignment UI. These delegate the actual query
# to support_db_attendance_settings.py (single source of truth for
# departments/classes/sections — same functions the Client Dashboard uses)
# and add the branch-ownership check that module doesn't do on its own,
# since it's normally only ever called with a branch_id the caller already
# owns via session context. A support-dashboard caller supplies org_id and
# branch_id explicitly, so that assumption doesn't hold here.
# ──────────────────────────────────────────────────────────────────────────

def list_branch_departments(org_id: str, branch_id: str) -> list[dict]:
    get_branch_owned_by_org(org_id, branch_id)
    return _list_departments(org_id, branch_id)


def list_branch_classes(org_id: str, branch_id: str) -> list[dict]:
    get_branch_owned_by_org(org_id, branch_id)
    return _list_classes(org_id, branch_id)


def list_class_sections(org_id: str, branch_id: str, class_id: str) -> list[dict]:
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_id)
    _get_class_owned_by_branch(sb, org_id, branch_id, class_id)
    return _list_sections(org_id, class_id)


def list_branch_sections(org_id: str, branch_id: str) -> list[dict]:
    """Every section across every class in this branch, flattened — each row
    keeps its class_id so the UI can group/filter client-side. Fetched as one
    flat list (rather than one call per class) so the picker can load
    departments, classes and sections together in a single parallel batch."""
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_id)
    classes = _list_classes(org_id, branch_id)
    class_ids = [c["id"] for c in classes]
    if not class_ids:
        return []
    result = (
        sb.table("sections")
        .select("*")
        .eq("org_id", str(org_id))
        .in_("class_id", class_ids)
        .eq("status", "active")
        .order("name")
        .execute()
    )
    return result.data or []


def deactivate_camera_context_assignment(org_id: str, branch_id: str, assignment_id: str) -> dict:
    """Soft-delete only — mirrors delete_class/delete_department's
    convention of never hard-deleting a row other tables (or, here,
    reporting joins) may still reference."""
    sb = get_supabase()
    get_branch_owned_by_org(org_id, branch_id)
    result = (
        get_supabase()
        .table("camera_context_assignments")
        .update({"status": "inactive", "updated_at": now_iso()})
        .eq("id", str(assignment_id))
        .eq("org_id", str(org_id))
        .eq("branch_id", str(branch_id))
        .execute()
    )
    if not result.data:
        raise ValueError(f"assignment_id {assignment_id!r} not found for this branch")
    return result.data[0]