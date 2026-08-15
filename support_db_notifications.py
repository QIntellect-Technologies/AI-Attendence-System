"""
support_db_notifications.py
──────────────────────────────────────────────────────────────────────────────
Supabase-backed admin notifications — the Client Dashboard replacement for
the legacy SQLite `db.get_notifications_for_user` family, which only ever
understood integer user_id/organization_id and silently no-ops for every
UUID (Supabase) tenant (see app.py's api_get_notifications and friends).

Schema (see migrations/xxx_create_notifications.sql):

  notifications          — one row per event. org_id/branch_id scope it,
                            never a user — a broadcast to 5 admins is ONE
                            notifications row, not five.
  notification_recipients — one row per (notification, user). Read state
                            (is_read/read_at) lives HERE, per-recipient, so
                            one admin reading a broadcast never marks it read
                            for the other four. org_id is denormalized onto
                            this table too, purely so every query below can
                            filter/scope directly on it without relying on
                            PostgREST embedded-resource filter syntax.

Recipient selection contract (create_notification):
  recipient_user_ids=[...]  -> exactly those users
  target_user_id=X          -> that one user
  neither                   -> every active admin/hr in the org (optionally
                                minus exclude_user_id) — the broadcast case
                                the late/early-checkout exception workflow
                                needs, since client_users has no branch_id
                                or manager/reports-to column to narrow by.

Every function is schema-drift-safe: if the migration hasn't been run yet,
reads return an empty/zero result instead of a raw PostgREST 404, and writes
raise a clear RuntimeError instead of leaking a Postgrest exception.
"""
from __future__ import annotations

from typing import Any, Optional

from supabase_client import get_supabase
from support_db_core import _execute_supabase
from support_db_time_utils import now_iso as _now_iso, is_missing_table_or_column as _table_missing


def _clean_id(value: Any) -> str:
    return str(value or "").strip()


def _active_admin_recipient_ids(org_id: str, exclude_user_id: Optional[str] = None) -> list[str]:
    """Every active admin client_user in this org — the broadcast target
    for exception notifications. No branch_id on client_users (confirmed
    against the actual schema), so this is intentionally org-wide, not
    narrowed to the branch the event happened at."""
    sb = get_supabase()
    query = (
        sb.table("client_users")
        .select("id")
        .eq("org_id", str(org_id))
        .eq("is_active", True)
        .eq("role", "admin")
    )
    result = query.execute()
    ids = [str(row["id"]) for row in (result.data or []) if row.get("id")]
    if exclude_user_id:
        exclude_key = str(exclude_user_id)
        ids = [i for i in ids if i != exclude_key]
    return ids


def _dedupe_ids(ids: Optional[list[str]]) -> list[str]:
    return sorted({_clean_id(i) for i in (ids or []) if _clean_id(i)})


def create_notification(
    org_id: str,
    *,
    module_key: str,
    event_type: str,
    title: str,
    body: str,
    branch_id: Optional[str] = None,
    actor_user_id: Optional[str] = None,
    actor_name: Optional[str] = None,
    target_entity_id: Optional[str] = None,
    target_entity_type: Optional[str] = None,
    target_route: Optional[str] = None,
    metadata: Optional[dict] = None,
    recipient_user_ids: Optional[list[str]] = None,
    recipient_staff_ids: Optional[list[str]] = None,
    target_user_id: Optional[str] = None,
    target_staff_id: Optional[str] = None,
    exclude_user_id: Optional[str] = None,
    also_broadcast: bool = False,
) -> Optional[dict]:
    """Create one notification and fan it out to its recipients.

    Recipients live in one of two disjoint identity spaces — client_users
    (the org-owner account that purchased the system; one per org) or
    client_staff (a manager logged into the Staff Panel). A caller picks
    the right *_ids/target_*_id kwarg for who it means; this function never
    guesses. recipient_rows below tags each row with its own recipient_type
    so reads can never cross the streams.

    recipient_user_ids / target_user_id -> client_users.id
    recipient_staff_ids / target_staff_id -> client_staff.id
    none of the above -> broadcast to every active admin/hr client_users
                          row in the org (client_user type), same default
                          as before this was made polymorphic.
    also_broadcast=True -> ADD the org-wide admin/hr broadcast on top of
                          whatever explicit recipients were given, instead
                          of the two being mutually exclusive. Use this when
                          both the assigned manager AND the org owner should
                          see the same event (e.g. attendance exceptions).

    Returns the created notification row (with recipient_count attached), or
    None if the migration hasn't been run yet — callers on the attendance
    write path must never fail the attendance mark itself just because a
    notification couldn't be recorded, so this is a soft-fail by design,
    unlike every other write in this codebase.
    """
    org_key = str(org_id)

    recipient_pairs: list[tuple[str, str]] = []
    recipient_pairs += [("client_user", i) for i in _dedupe_ids(recipient_user_ids)]
    recipient_pairs += [("client_staff", i) for i in _dedupe_ids(recipient_staff_ids)]
    if target_user_id and _clean_id(target_user_id):
        recipient_pairs.append(("client_user", _clean_id(target_user_id)))
    if target_staff_id and _clean_id(target_staff_id):
        recipient_pairs.append(("client_staff", _clean_id(target_staff_id)))

    # Broadcast fires when nothing explicit was given (the original default
    # behavior), OR when the caller explicitly asked for it on top of
    # explicit recipients via also_broadcast.
    if also_broadcast or not recipient_pairs:
        recipient_pairs += [
            ("client_user", i) for i in _active_admin_recipient_ids(org_key, exclude_user_id)
        ]

    recipient_pairs = sorted(set(recipient_pairs))
    if not recipient_pairs:
        return None

    sb = get_supabase()
    try:
        result = (
            sb.table("notifications")
            .insert({
                "org_id": org_key,
                "branch_id": str(branch_id) if branch_id else None,
                "module_key": module_key,
                "event_type": event_type,
                "title": title,
                "body": body,
                "actor_user_id": str(actor_user_id) if actor_user_id else None,
                "actor_name": actor_name,
                "target_entity_id": str(target_entity_id) if target_entity_id else None,
                "target_entity_type": target_entity_type,
                "target_route": target_route,
                "metadata": metadata or {},
            })
            .execute()
        )
    except Exception as exc:
        if _table_missing(exc, "notifications"):
            return None
        raise

    if not result.data:
        raise RuntimeError("Failed to create notification")
    notification = result.data[0]

    recipient_rows = [
        {
            "notification_id": notification["id"],
            "org_id": org_key,
            "user_id": recipient_id,
            "recipient_type": recipient_type,
            "is_read": False,
        }
        for recipient_type, recipient_id in recipient_pairs
    ]
    try:
        sb.table("notification_recipients").insert(recipient_rows).execute()
    except Exception as exc:
        # migration_add_recipient_type.sql not run yet on this org's DB —
        # fall back to the pre-migration row shape so client_user recipients
        # (the only kind that existed before) still get delivered. Any
        # client_staff recipients in this batch are silently dropped rather
        # than raising, matching this function's existing soft-fail contract.
        if _table_missing(exc, "recipient_type"):
            legacy_rows = [
                {k: v for k, v in row.items() if k != "recipient_type"}
                for row in recipient_rows
                if row["recipient_type"] == "client_user"
            ]
            if legacy_rows:
                sb.table("notification_recipients").insert(legacy_rows).execute()
            recipient_pairs = [p for p in recipient_pairs if p[0] == "client_user"]
        else:
            raise

    notification["recipient_count"] = len(recipient_pairs)
    return notification


def _map_recipient_row(row: dict) -> dict:
    """Flatten one notification_recipients row (with embedded notifications
    row) into the DashboardNotification shape notificationApi.ts expects."""
    note = row.get("notifications") or {}
    return {
        "id": note.get("id"),
        "organization_id": note.get("org_id"),
        "branch_id": note.get("branch_id"),
        "module_key": note.get("module_key"),
        "event_type": note.get("event_type"),
        "title": note.get("title"),
        "body": note.get("body"),
        "actor_user_id": note.get("actor_user_id"),
        "actor_name": note.get("actor_name"),
        "target_user_id": row.get("user_id"),
        "target_entity_id": note.get("target_entity_id"),
        "target_entity_type": note.get("target_entity_type"),
        "target_route": note.get("target_route"),
        "is_read": bool(row.get("is_read")),
        "read_at": row.get("read_at"),
        "created_at": note.get("created_at"),
        "metadata": note.get("metadata") or {},
    }


def _run_recipient_scoped(build_query, *, recipient_type: str, not_found_default, label: str):
    """Run a notification_recipients query scoped to (org, user, recipient_type),
    falling back to the pre-migration query (no recipient_type column) so
    every read function keeps working before migration_add_recipient_type.sql
    has been applied. build_query(include_recipient_type: bool) must return
    a not-yet-executed Supabase query builder.

    Centralizes the exact same try/except shape list_notifications,
    get_unread_count, mark_read, and mark_all_read each needed, instead of
    repeating it four times.

    Routed through support_db_core._execute_supabase so a transient
    connection reset (HTTP/2 ConnectionTerminated, server disconnected,
    etc.) gets one reconnect-and-retry here too, same as every other
    support_db_* module. Previously this called build_query(True).execute()
    directly, so on a cold-start connection drop every other tenant-meta
    call recovered via _execute_supabase's retry while this one raised
    straight into a 500 (see /api/notifications/unread-count).
    """
    try:
        return _execute_supabase(label, lambda: build_query(True))
    except Exception as exc:
        if _table_missing(exc, "recipient_type"):
            return _execute_supabase(f'{label}_legacy', lambda: build_query(False))
        if _table_missing(exc, "notification"):
            return not_found_default
        raise


def list_notifications(
    org_id: str,
    user_id: str,
    *,
    recipient_type: str = "client_user",
    unread_only: bool = False,
    limit: int = 100,
) -> list[dict]:
    org_key = str(org_id)
    user_key = str(user_id)
    safe_limit = max(1, min(int(limit or 100), 500))
    sb = get_supabase()

    def build(include_recipient_type: bool):
        q = (
            sb.table("notification_recipients")
            .select("is_read, read_at, user_id, notifications(*)")
            .eq("org_id", org_key)
            .eq("user_id", user_key)
        )
        if include_recipient_type:
            q = q.eq("recipient_type", recipient_type)
        if unread_only:
            q = q.eq("is_read", False)
        return q.order("id", desc=True).limit(safe_limit)

    result = _run_recipient_scoped(build, recipient_type=recipient_type, not_found_default=None, label='list_notifications')
    if result is None:
        return []

    rows = [r for r in (result.data or []) if r.get("notifications")]
    mapped = [_map_recipient_row(r) for r in rows]
    mapped.sort(key=lambda n: n.get("created_at") or "", reverse=True)
    return mapped


def get_unread_count(org_id: str, user_id: str, *, recipient_type: str = "client_user") -> int:
    sb = get_supabase()

    def build(include_recipient_type: bool):
        q = (
            sb.table("notification_recipients")
            .select("id", count="exact")
            .eq("org_id", str(org_id))
            .eq("user_id", str(user_id))
            .eq("is_read", False)
        )
        return q.eq("recipient_type", recipient_type) if include_recipient_type else q

    result = _run_recipient_scoped(build, recipient_type=recipient_type, not_found_default=None, label='get_unread_count')
    return int(result.count or 0) if result is not None else 0


def mark_read(org_id: str, notification_id: int, user_id: str, *, recipient_type: str = "client_user") -> bool:
    sb = get_supabase()

    def build(include_recipient_type: bool):
        q = (
            sb.table("notification_recipients")
            .update({"is_read": True, "read_at": _now_iso()})
            .eq("org_id", str(org_id))
            .eq("notification_id", int(notification_id))
            .eq("user_id", str(user_id))
        )
        return q.eq("recipient_type", recipient_type) if include_recipient_type else q

    result = _run_recipient_scoped(build, recipient_type=recipient_type, not_found_default=None, label='mark_notification_read')
    return bool(result.data) if result is not None else False


def mark_all_read(org_id: str, user_id: str, *, recipient_type: str = "client_user") -> int:
    sb = get_supabase()

    def build(include_recipient_type: bool):
        q = (
            sb.table("notification_recipients")
            .update({"is_read": True, "read_at": _now_iso()})
            .eq("org_id", str(org_id))
            .eq("user_id", str(user_id))
            .eq("is_read", False)
        )
        return q.eq("recipient_type", recipient_type) if include_recipient_type else q

    result = _run_recipient_scoped(build, recipient_type=recipient_type, not_found_default=None, label='mark_all_notifications_read')
    return len(result.data or []) if result is not None else 0


def delete_notification(
    org_id: str,
    notification_id: int,
    user_id: str,
    *,
    recipient_type: str = "client_user",
) -> bool:
    """Remove this user's own copy of a notification.

    Deletes only the caller's `notification_recipients` row, never the
    shared `notifications` row — a broadcast to 5 admins must not vanish
    for the other 4 just because one of them dismissed it. Same isolation
    principle as `is_read` in this table.
    """
    sb = get_supabase()

    def build(include_recipient_type: bool):
        q = (
            sb.table("notification_recipients")
            .delete()
            .eq("org_id", str(org_id))
            .eq("notification_id", int(notification_id))
            .eq("user_id", str(user_id))
        )
        return q.eq("recipient_type", recipient_type) if include_recipient_type else q

    result = _run_recipient_scoped(build, recipient_type=recipient_type, not_found_default=None, label='delete_notification')
    return bool(result.data) if result is not None else False


def bulk_delete_notifications(
    org_id: str,
    notification_ids: list[int],
    user_id: str,
    *,
    recipient_type: str = "client_user",
) -> int:
    """Remove this user's own copies of multiple notifications in one round-trip.

    Same per-recipient-only deletion contract as delete_notification — this
    is the batched form for a "select several, delete" UI action, not a
    delete-everyone's-copy operation.
    """
    ids = sorted({int(i) for i in (notification_ids or []) if i is not None})
    if not ids:
        return 0

    sb = get_supabase()

    def build(include_recipient_type: bool):
        q = (
            sb.table("notification_recipients")
            .delete()
            .eq("org_id", str(org_id))
            .eq("user_id", str(user_id))
            .in_("notification_id", ids)
        )
        return q.eq("recipient_type", recipient_type) if include_recipient_type else q

    result = _run_recipient_scoped(build, recipient_type=recipient_type, not_found_default=None, label='bulk_delete_notifications')
    return len(result.data or []) if result is not None else 0