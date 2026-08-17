"""
support_db_organizations.py
───────────────────────────────────────────────────────────────────────────────
Organizations: CRUD, lifecycle (archive/restore/delete), retention policy,
vertical template + module-people-type wiring for a tenant.

Split out of the original monolithic support_db.py. See support_db.py for
the backward-compatible facade that re-exports everything below.
"""

from datetime import date, timedelta, datetime, timezone
import json
from math import radians, sin, cos, atan2, sqrt
from typing import Optional, Any, Callable
import time
import bcrypt
import secrets
import string
import hashlib
import uuid
import os
from supabase_client import get_supabase, reset_supabase_client
from logger_config import get_logger

logger = get_logger(__name__)
from support_db_core import _ORG_CACHE, _VALID_STAFF_WORK_TYPES, NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS, NODE_OFFLINE_THRESHOLD_MAX_SECONDS, NODE_OFFLINE_THRESHOLD_MIN_SECONDS, _attach_status, _cache_get, _cache_set, _execute_supabase, _invalidate_tenant_meta_cache, get_internal_user_by_id
from support_invite_message import build_client_invite_message
from support_db_attendance_gate import (
    resolve_timing_source,
    resolve_manual_instruction_window,
    resolve_branch_default_window,
    resolve_staff_shift_windows,
    resolve_check_in_status,
    resolve_check_out_status,
    _get_branch_timezone,
    _find_approved_overtime,
)
from support_db_attendance_settings import list_pending_manual_instructions_for_branch
from support_db_time_utils import is_missing_table_or_column as _table_missing
import support_db_attendance_exceptions as _attendance_exceptions
from zoneinfo import ZoneInfo, available_timezones
from core.vertical_templates import (
    list_vertical_templates as _list_vertical_templates,
    normalize_vertical_payload,
    build_vertical_config,
    get_vertical_template,
)

def list_vertical_templates():
    """
    Support Dashboard template dropdown options.
    """
    return _list_vertical_templates()

def _with_vertical_defaults(payload: dict) -> dict:
    """
    Add business_type, primary_people_type, enabled_people_types,
    and vertical_config without disturbing existing payload keys.
    """
    return normalize_vertical_payload(payload or {})

def list_organizations(
    status: str | None = None,
    search: str | None = None,
    business_type: str | None = None,
    include_archived: bool = True,
    include_deleted: bool = False,
) -> list[dict]:
    """Return support organizations with lifecycle-safe filtering.

    Permanent-delete rule:
      Rows with deleted_at/status=deleted are never returned by default.
      A partially-deleted row from a failed cleanup is therefore hidden from the
      Support Dashboard list until the final delete succeeds.

    Archive/suspend rule:
      Archived rows are still returned so the frontend can show them in the
      Archived filter. Suspended/grace/active are computed by _attach_status().
    """
    clean_status = str(status or '').strip().lower()
    clean_search = str(search or '').strip().lower()
    clean_business_type = str(business_type or '').strip().lower()

    def _base_query(filter_deleted_at: bool = True):
        query = get_supabase().table('organizations').select('*')
        if filter_deleted_at and not include_deleted:
            query = query.is_('deleted_at', 'null')
        if clean_business_type:
            query = query.eq('business_type', clean_business_type)
        return query.order('created_at', desc=True)

    try:
        result = _execute_supabase('list_organizations', lambda: _base_query(True))
    except Exception as exc:
        text = str(exc).lower()
        # Older dev schemas may not have lifecycle columns yet. Fall back to a
        # read without deleted_at filter, then remove deleted rows after
        # _attach_status() computes the status where possible.
        if 'deleted_at' not in text and 'schema cache' not in text and 'could not find' not in text:
            raise
        result = _execute_supabase('list_organizations_without_deleted_at_filter', lambda: _base_query(False))

    organizations: list[dict] = []
    for row in (result.data or []):
        org = _attach_status(row)
        org_status = str(org.get('status') or '').strip().lower()

        if not include_deleted and (org_status == 'deleted' or org.get('deleted_at')):
            continue

        if not include_archived and org_status == 'archived':
            continue

        if clean_status and clean_status not in {'all', 'all_visible', 'visible'}:
            if clean_status == 'deleted' and not include_deleted:
                continue
            if org_status != clean_status:
                continue

        if clean_search:
            haystack = ' '.join([
                str(org.get('name') or ''),
                str(org.get('contact_email') or ''),
                str(org.get('contact_phone') or ''),
                str(org.get('id') or ''),
            ]).lower()
            if clean_search not in haystack:
                continue

        organizations.append(org)

    return organizations

def get_organization(org_id: str) -> dict:
    org_key = str(org_id)
    cached = _cache_get(_ORG_CACHE, org_key)
    if cached is not None:
        return dict(cached)

    result = _execute_supabase(
        'get_organization',
        lambda: (
            get_supabase()
            .table('organizations')
            .select('*')
            .eq('id', org_key)
            .limit(1)
        ),
    )
    if not result.data:
        raise ValueError(f'Organization {org_id} not found')

    org = _attach_status(result.data[0])
    _cache_set(_ORG_CACHE, org_key, dict(org))
    return dict(org)

def create_organization(payload: dict, created_by: str) -> dict:
    """
    Phase 2, Step 1-3 (Architecture Section 3).
    Creates the org row. Branches, modules, billing are separate steps.
    """
    from support_db_client_users import _normalize_people_kind
    payload = _with_vertical_defaults(payload)
    sb = get_supabase()

    attendance_mode = payload.get('attendance_mode', 'cloud')
    threshold = payload.get('node_offline_threshold_seconds')

    if attendance_mode == 'local' and not threshold:
        raise ValueError('node_offline_threshold_seconds is required for local mode')

    if attendance_mode == 'local' and threshold is not None:
        try:
            threshold = int(threshold)
        except (TypeError, ValueError):
            raise ValueError('node_offline_threshold_seconds must be a valid number')
        if threshold < NODE_OFFLINE_THRESHOLD_MIN_SECONDS or threshold > NODE_OFFLINE_THRESHOLD_MAX_SECONDS:
            raise ValueError(
                f'node_offline_threshold_seconds must be between '
                f'{NODE_OFFLINE_THRESHOLD_MIN_SECONDS} and {NODE_OFFLINE_THRESHOLD_MAX_SECONDS}'
            )

    if attendance_mode == 'cloud':
        threshold = None  # never store threshold for cloud orgs

    insert_data = {
        'name':                         payload['name'].strip(),
        'contact_email':                payload['contact_email'].strip().lower(),
        'contact_phone':                payload.get('contact_phone'),
        'org_type':                     payload.get('org_type'),
        "biz_type": payload.get("biz_type") or payload["business_type"],
        "business_type": payload["business_type"],
        "primary_people_type": payload["primary_people_type"],
        "enabled_people_types": payload["enabled_people_types"],
        "attendance_people_types": payload["attendance_people_types"],
        "vertical_config": payload["vertical_config"],
        'people_kind':                  _normalize_people_kind(payload.get('people_kind'), payload.get('org_type')),
        'terminology_overrides':        payload.get('terminology_overrides') or {},
        'attendance_mode':              attendance_mode,
        'node_offline_threshold_seconds': threshold,
        'max_branches':                 int(payload.get('max_branches', 1)),
        'created_by':                   created_by,
    }

    result = sb.table('organizations').insert(insert_data).execute()

    if not result.data:
        raise RuntimeError('Failed to create organization')

    org = result.data[0]
    _invalidate_tenant_meta_cache(str(org.get('id') or ''))
    return _attach_status(org)

def update_organization(org_id: str, payload: dict) -> dict:
    """
    Update support-owned organization details.

    This endpoint is intentionally Support-only. It can update the visible
    organization profile fields, commercial limits, terminology, and attendance
    mode. Access status remains computed from invoices and is not stored here.

    node_offline_threshold_seconds is the local-node offline -> cloud failover
    SLA, owned by Support (same tier as max_branches). sync_time is client-owned
    and lives in client_onboarding_configs, not here — it must never appear in
    the allowed set below.
    """
    from support_db_branches import _validate_branch_limit_decrease
    from support_db_client_users import _normalize_people_kind
    payload = dict(payload or {})

    if payload.get("business_type") or payload.get("biz_type"):
        payload = _with_vertical_defaults(payload)
    sb = get_supabase()
    current_org = get_organization(org_id)

    allowed = {
        'name',
        'contact_email',
        'contact_phone',
        'org_type',
        'business_type',
        'biz_type',
        'primary_people_type',
        'enabled_people_types',
        'vertical_config',
        'attendance_people_types',
        'people_kind',
        'terminology_overrides',
        'attendance_mode',
        'node_offline_threshold_seconds',
        'max_branches',
    }
    update_data = {k: v for k, v in payload.items() if k in allowed}

    if not update_data:
        raise ValueError('No valid fields to update')

    if 'name' in update_data:
        name = str(update_data.get('name') or '').strip()
        if not name:
            raise ValueError('Organization name is required')
        update_data['name'] = name

    if 'contact_email' in update_data:
        email = str(update_data.get('contact_email') or '').strip().lower()
        if not email:
            raise ValueError('Contact email is required')
        if '@' not in email or '.' not in email.split('@')[-1]:
            raise ValueError('Contact email must be valid')
        update_data['contact_email'] = email

    if 'contact_phone' in update_data:
        phone = str(update_data.get('contact_phone') or '').strip()
        update_data['contact_phone'] = phone or None

    if 'org_type' in update_data:
        org_type = str(update_data.get('org_type') or '').strip()
        update_data['org_type'] = org_type or None

    if 'attendance_mode' in update_data:
        mode = str(update_data.get('attendance_mode') or '').strip().lower()
        if mode not in {'cloud', 'local'}:
            raise ValueError('attendance_mode must be cloud or local')
        update_data['attendance_mode'] = mode

    effective_org_type = update_data.get('org_type') if 'org_type' in update_data else current_org.get('org_type')
    if 'people_kind' in update_data:
        update_data['people_kind'] = _normalize_people_kind(
            update_data.get('people_kind'),
            effective_org_type,
        )

    if 'terminology_overrides' in update_data:
        if not isinstance(update_data.get('terminology_overrides'), dict):
            update_data['terminology_overrides'] = {}

    if 'max_branches' in update_data:
        try:
            max_branches = int(update_data['max_branches'])
        except (TypeError, ValueError):
            raise ValueError('max_branches must be a valid number')

        if max_branches < 1:
            raise ValueError('max_branches must be at least 1')

        _validate_branch_limit_decrease(
            org_id=str(org_id),
            new_max_branches=max_branches,
            drop_branch_ids=(
                payload.get('drop_branch_ids')
                or payload.get('branches_to_drop')
                or payload.get('dropped_branch_ids')
            ),
            updated_by=str(payload.get('updated_by') or payload.get('support_user_id') or '') or None,
            reason=payload.get('branch_limit_drop_reason') or payload.get('drop_reason'),
        )
        update_data['max_branches'] = max_branches

    # Threshold semantics depend on the *effective* attendance_mode, i.e. the
    # incoming value if present, else whatever the org already has. A cloud org
    # has no local node, so the failover threshold is meaningless and must be
    # nulled rather than left stale from a prior local-mode configuration.
    effective_mode = update_data.get('attendance_mode') or current_org.get('attendance_mode') or 'cloud'
    if effective_mode == 'cloud':
        update_data['node_offline_threshold_seconds'] = None
    elif 'node_offline_threshold_seconds' in update_data or 'attendance_mode' in update_data:
        # Only re-validate the threshold if the caller actually touched it, or
        # if the org is transitioning into local mode and therefore needs one.
        raw_threshold = update_data.get(
            'node_offline_threshold_seconds',
            current_org.get('node_offline_threshold_seconds') or NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS,
        )
        if raw_threshold in (None, ''):
            raise ValueError('node_offline_threshold_seconds is required for local mode')
        try:
            threshold = int(raw_threshold)
        except (TypeError, ValueError):
            raise ValueError('node_offline_threshold_seconds must be a valid number')
        # Seconds-scale failover SLA, bounded relative to the local node's
        # actual heartbeat cadence (NODE_HEARTBEAT_INTERVAL_SECONDS) — see
        # the constants block above _resolve_node_offline_threshold_seconds.
        # A threshold below the floor flips a healthy node to 'offline'
        # during the normal gap between heartbeats.
        if threshold < NODE_OFFLINE_THRESHOLD_MIN_SECONDS or threshold > NODE_OFFLINE_THRESHOLD_MAX_SECONDS:
            raise ValueError(
                f'node_offline_threshold_seconds must be between '
                f'{NODE_OFFLINE_THRESHOLD_MIN_SECONDS} and {NODE_OFFLINE_THRESHOLD_MAX_SECONDS}'
            )
        update_data['node_offline_threshold_seconds'] = threshold

    result = (
        sb.table('organizations')
        .update(update_data)
        .eq('id', org_id)
        .execute()
    )

    if not result.data:
        raise ValueError(f'Organization {org_id} not found')

    org = _attach_status(result.data[0])
    _invalidate_tenant_meta_cache(str(org_id))
    return org

def update_organization_template(
    org_id,
    business_type: str,
    attendance_people_types=None,
    updated_by=None,
):
    """
    Support-only template update.

    Updates support-owned vertical/template fields plus biometric attendance
    scope. It does not touch modules, billing, attendance_mode, branches, or
    client operational data.
    """
    normalized = normalize_vertical_payload({
        "business_type": business_type,
        "attendance_people_types": attendance_people_types,
    })

    payload = {
        "business_type": normalized["business_type"],
        "biz_type": normalized["business_type"],
        "primary_people_type": normalized["primary_people_type"],
        "enabled_people_types": normalized["enabled_people_types"],
        "attendance_people_types": normalized["attendance_people_types"],
        "vertical_config": normalized["vertical_config"],
    }

    client = get_supabase()
    result = (
        client
        .table("organizations")
        .update(payload)
        .eq("id", str(org_id))
        .execute()
    )

    rows = getattr(result, "data", None) or []
    if not rows:
        raise ValueError("Organization not found.")

    _invalidate_tenant_meta_cache(str(org_id))
    return _attach_status(rows[0])

def _normalize_staff_type_scope(values) -> list[str]:
    """Validate + de-duplicate a staff-type scope list, preserving order.

    Raises ValueError on anything outside ('office', 'field') so a support
    agent gets an immediate 400 instead of silently saving a scope no client
    UI knows how to render. An empty list is rejected too — an organization
    with zero staff types enabled couldn't add anyone in Staff Management.
    """
    if not isinstance(values, list) or not values:
        raise ValueError("enabled_staff_types must be a non-empty array of 'office'/'field'")

    seen: set[str] = set()
    normalized: list[str] = []
    for raw in values:
        key = str(raw or '').strip().lower()
        if key not in _VALID_STAFF_WORK_TYPES:
            raise ValueError(f"Invalid staff type '{raw}'. Must be 'office' or 'field'.")
        if key not in seen:
            seen.add(key)
            normalized.append(key)
    return normalized

def update_organization_staff_type_scope(
    org_id,
    enabled_staff_types,
    updated_by=None,
) -> dict:
    """
    Support-only: sets which staff work types (office/field) a client is
    commercially entitled to add via the Client Dashboard's Staff Management
    Add/Edit modal. Purely a Support-owned scope — the client dashboard
    reads this value, it never writes it (same contract as
    update_organization_template's attendance_people_types).
    """
    normalized = _normalize_staff_type_scope(enabled_staff_types)

    client = get_supabase()
    result = (
        client
        .table("organizations")
        .update({"enabled_staff_types": normalized})
        .eq("id", str(org_id))
        .execute()
    )

    rows = getattr(result, "data", None) or []
    if not rows:
        raise ValueError("Organization not found.")

    _invalidate_tenant_meta_cache(str(org_id))
    return _attach_status(rows[0])

_VALID_RETENTION_YEARS = {1, 3, 5, 7, 10}

def _normalize_org_retention_years(value, default: int = 5) -> int:
    try:
        years = int(value)
    except (TypeError, ValueError):
        years = default
    if years not in _VALID_RETENTION_YEARS:
        raise ValueError('retention_years must be one of 1, 3, 5, 7, or 10')
    return years

def _retention_until_from_years(years: int) -> str:
    return (date.today() + timedelta(days=365 * int(years))).isoformat()

def archive_organization(
    org_id: str,
    archived_by: str | None,
    reason: str | None = None,
    retention_years: int = 5,
) -> dict:
    """Archive an organization without deleting tenant data.

    Archive blocks client dashboard readiness and node sync through computed
    org status, while keeping support access and historical data available.
    """
    org_key = str(org_id)
    get_organization(org_key)
    years = _normalize_org_retention_years(retention_years)
    now = datetime.now(timezone.utc).isoformat()
    retention_until = _retention_until_from_years(years)
    clean_reason = str(reason or '').strip() or 'Archived by QIntellect Support'

    result = (
        get_supabase()
        .table('organizations')
        .update({
            'archived_at': now,
            'archived_by': str(archived_by) if archived_by else None,
            'archive_reason': clean_reason,
            'organization_retention_years': years,
            'retention_until': retention_until,
            'updated_at': now,
        })
        .eq('id', org_key)
        .is_('deleted_at', 'null')
        .execute()
    )

    if not result.data:
        raise ValueError('Organization not found or already deleted')

    _invalidate_tenant_meta_cache(org_key)
    return get_organization(org_key)

def restore_organization(org_id: str, restored_by: str | None = None) -> dict:
    """Restore an archived organization. Billing status is still invoice-based."""
    org_key = str(org_id)
    now = datetime.now(timezone.utc).isoformat()
    result = (
        get_supabase()
        .table('organizations')
        .update({
            'archived_at': None,
            'archived_by': None,
            'archive_reason': None,
            'deletion_requested_at': None,
            'deletion_requested_by': None,
            'delete_reason': None,
            'updated_at': now,
        })
        .eq('id', org_key)
        .is_('deleted_at', 'null')
        .execute()
    )

    if not result.data:
        raise ValueError('Organization not found or already deleted')

    _invalidate_tenant_meta_cache(org_key)
    return get_organization(org_key)

def update_organization_retention_policy(
    org_id: str,
    retention_years: int,
    updated_by: str | None = None,
) -> dict:
    """Update organization-level data retention policy."""
    org_key = str(org_id)
    get_organization(org_key)
    years = _normalize_org_retention_years(retention_years)
    now = datetime.now(timezone.utc).isoformat()
    retention_until = _retention_until_from_years(years)

    result = (
        get_supabase()
        .table('organizations')
        .update({
            'organization_retention_years': years,
            'retention_until': retention_until,
            'retention_policy_updated_at': now,
            'retention_policy_updated_by': str(updated_by) if updated_by else None,
            'updated_at': now,
        })
        .eq('id', org_key)
        .is_('deleted_at', 'null')
        .execute()
    )

    if not result.data:
        raise ValueError('Organization not found or already deleted')

    _invalidate_tenant_meta_cache(org_key)
    return get_organization(org_key)

def request_organization_delete(
    org_id: str,
    requested_by: str | None,
    reason: str | None = None,
) -> dict:
    """Record a deletion request. This does not delete data."""
    org_key = str(org_id)
    get_organization(org_key)
    now = datetime.now(timezone.utc).isoformat()
    clean_reason = str(reason or '').strip() or 'Permanent deletion requested by Support'

    # Snapshot the requester's name alongside their id, matching the
    # actor_user_id/actor_name pair the notifications table already uses.
    # An audit record must answer "who requested this, as they were known
    # at the time" -- resolving the id on read would rewrite history when
    # a name changes, and would lose attribution entirely once a support
    # account is deactivated.
    requested_by_name = None
    if requested_by:
        try:
            actor = get_internal_user_by_id(str(requested_by))
            requested_by_name = (
                str(actor.get('full_name') or '').strip()
                or str(actor.get('email') or '').strip()
                or None
            )
        except Exception:
            logger.warning(
                'Could not resolve requester name for internal user %s', requested_by
            )

    result = (
        get_supabase()
        .table('organizations')
        .update({
            'deletion_requested_at': now,
            'deletion_requested_by': str(requested_by) if requested_by else None,
            'deletion_requested_by_name': requested_by_name,
            'delete_reason': clean_reason,
            'updated_at': now,
        })
        .eq('id', org_key)
        .is_('deleted_at', 'null')
        .execute()
    )

    if not result.data:
        raise ValueError('Organization not found or already deleted')

    _invalidate_tenant_meta_cache(org_key)
    return get_organization(org_key)

def _postgrest_error_payload(exc: Exception) -> dict:
    """Return a normalized PostgREST/Supabase error payload."""
    # postgrest.exceptions.APIError exposes the JSON payload inconsistently
    # across versions. Keep this defensive and dependency-free.
    for attr in ("json", "details", "args"):
        try:
            value = getattr(exc, attr, None)
            if isinstance(value, dict):
                return value
            if isinstance(value, (list, tuple)) and value and isinstance(value[0], dict):
                return value[0]
        except Exception:
            pass

    text = str(exc)
    # Some versions stringify the dict payload. Do not eval it; only return text.
    return {"message": text, "code": getattr(exc, "code", None)}

def _delete_error_is_schema_mismatch(exc: Exception, table_name: str = "") -> bool:
    """True when this table/column cannot accept the UUID org id.

    This project has mixed legacy tables and new Supabase UUID tenant tables.
    Some legacy columns named org_id are BIGINT. Passing a UUID to those columns
    raises Postgres 22P02. That should not stop deleting the UUID tenant; it only
    means this particular column is not the UUID tenant column for this table.
    """
    payload = _postgrest_error_payload(exc)
    code = str(payload.get("code") or "").strip().upper()
    message = str(payload.get("message") or payload.get("details") or exc).lower()
    table_key = str(table_name or "").lower()

    return (
        code in {"22P02", "42703", "PGRST204", "PGRST205"}
        or "invalid input syntax for type bigint" in message
        or "invalid input syntax for type integer" in message
        or "could not find" in message
        or "schema cache" in message
        or "does not exist" in message
        or (table_key and table_key in message and "not found" in message)
    )

def _delete_rows_for_org(sb, table_name: str, org_id: str, org_columns: tuple[str, ...]) -> dict:
    """Delete rows from one optional tenant table using safe org-scoped columns.

    The function is intentionally forgiving for schema mismatch/missing optional
    tables, because support-created organizations use UUID ids while several
    legacy/demo tables may still have BIGINT org_id columns. A BIGINT parse error
    means "wrong column for UUID tenant cleanup", not "delete failed".
    """
    table_result = {
        'table': table_name,
        'deleted': False,
        'column': None,
        'skipped': False,
        'error': None,
    }

    last_error = None
    for column in org_columns:
        try:
            sb.table(table_name).delete().eq(column, str(org_id)).execute()
            table_result['deleted'] = True
            table_result['column'] = column
            table_result['error'] = None
            return table_result
        except Exception as exc:
            last_error = str(exc)
            if _delete_error_is_schema_mismatch(exc, table_name):
                table_result['error'] = last_error
                continue
            raise

    table_result['skipped'] = True
    table_result['error'] = last_error
    return table_result

def _delete_rows_for_branch_ids(sb, table_name: str, branch_ids: list[str], branch_column: str = 'branch_id') -> dict:
    """Delete branch-scoped rows for known branches owned by the organization."""
    table_result = {
        'table': table_name,
        'deleted': False,
        'column': branch_column,
        'skipped': False,
        'error': None,
    }

    if not branch_ids:
        table_result['skipped'] = True
        table_result['error'] = 'No branch ids for organization'
        return table_result

    try:
        sb.table(table_name).delete().in_(branch_column, branch_ids).execute()
        table_result['deleted'] = True
        return table_result
    except Exception as exc:
        if _delete_error_is_schema_mismatch(exc, table_name):
            table_result['skipped'] = True
            table_result['error'] = str(exc)
            return table_result
        raise

def _load_org_branch_ids_for_delete(org_id: str) -> list[str]:
    """Load branch UUIDs before deleting branch-scoped child rows."""
    try:
        result = (
            get_supabase()
            .table('branches')
            .select('id')
            .eq('org_id', str(org_id))
            .execute()
        )
        return [str(row.get('id')) for row in (result.data or []) if row.get('id')]
    except Exception as exc:
        if _delete_error_is_schema_mismatch(exc, 'branches'):
            return []
        raise

def permanently_delete_organization(
    org_id: str,
    deleted_by: str | None,
    confirm_name: str,
    reason: str | None = None,
) -> dict:
    """Permanently delete tenant-owned data for one support-created organization.

    Guardrails:
      - exact organization-name confirmation
      - organization id is treated as an opaque UUID/text value
      - legacy BIGINT org_id tables are skipped instead of crashing
      - branch-scoped child rows are deleted before branches
      - organization row is deleted last
    """
    org_key = str(org_id)
    org = get_organization(org_key)
    expected = str(org.get('name') or '').strip()
    provided = str(confirm_name or '').strip()
    if not expected or provided != expected:
        raise ValueError('Confirmation name does not match organization name')

    sb = get_supabase()
    now = datetime.now(timezone.utc).isoformat()
    clean_reason = str(reason or '').strip() or 'Permanently deleted by QIntellect Support'

    branch_ids = _load_org_branch_ids_for_delete(org_key)

    # Mark first for audit/visibility. The organization row is deleted last.
    try:
        sb.table('organizations').update({
            'deleted_at': now,
            'deleted_by': str(deleted_by) if deleted_by else None,
            'delete_reason': clean_reason,
            'updated_at': now,
        }).eq('id', org_key).execute()
    except Exception as exc:
        if _delete_error_is_schema_mismatch(exc, 'organizations'):
            raise RuntimeError('Organization lifecycle columns are missing. Run the lifecycle SQL migration first.') from exc
        raise

    results: list[dict] = []

    # Delete branch-owned rows first where tables commonly use branch_id more
    # reliably than org_id/organization_id.
    branch_scoped_tables = [
        'branch_cameras',
        'branch_network_configs',
        'node_api_keys',
        'install_tokens',
        'face_training_jobs',
        'face_embeddings_cloud',
        'attendance',
        'attendance_default',
        'attendance_p2024',
        'attendance_p2025',
        'attendance_p2026',
        'attendance_p2027',
        'attendance_records',
        'leave_requests',
        'overtime_requests',
        'salary_configs',
        'client_staff',
        'departments',
        'client_departments',
        'client_roles',
    ]
    for table in branch_scoped_tables:
        results.append(_delete_rows_for_branch_ids(sb, table, branch_ids, 'branch_id'))

    # Delete org-scoped tables. Columns are tried in safest order. If a legacy
    # table has BIGINT org_id, the 22P02 error is skipped and the next column is
    # tried. Optional missing tables/columns are recorded but do not abort.
    delete_plan: list[tuple[str, tuple[str, ...]]] = [
        ('attendance', ('organization_id', 'org_id')),
        ('attendance_default', ('organization_id', 'org_id')),
        ('attendance_p2024', ('organization_id', 'org_id')),
        ('attendance_p2025', ('organization_id', 'org_id')),
        ('attendance_p2026', ('organization_id', 'org_id')),
        ('attendance_p2027', ('organization_id', 'org_id')),
        ('attendance_records', ('organization_id', 'org_id')),
        ('face_embeddings_cloud', ('organization_id', 'org_id')),
        ('face_training_jobs', ('organization_id', 'org_id')),
        ('leave_requests', ('organization_id', 'org_id')),
        ('overtime_requests', ('organization_id', 'org_id')),
        ('salary_configs', ('organization_id', 'org_id')),
        ('branch_cameras', ('organization_id', 'org_id')),
        ('branch_network_configs', ('organization_id', 'org_id')),
        ('departments', ('organization_id', 'org_id')),
        ('client_departments', ('organization_id', 'org_id')),
        ('client_roles', ('organization_id', 'org_id')),
        ('client_onboarding_configs', ('organization_id', 'org_id')),
        ('client_staff', ('organization_id', 'org_id')),
        ('client_users', ('organization_id', 'org_id')),
        ('install_tokens', ('organization_id', 'org_id')),
        ('node_api_keys', ('organization_id', 'org_id')),
        ('module_incidents', ('organization_id', 'org_id')),
        ('organization_modules', ('organization_id', 'org_id')),
        ('subscriptions', ('organization_id', 'org_id')),
        # Keep invoices in the same tenant purge because you asked for permanent
        # delete from database. If later you want financial retention, remove it
        # from this list and anonymize instead.
        ('invoices', ('organization_id', 'org_id')),
        ('branches', ('organization_id', 'org_id')),
    ]

    for table, columns in delete_plan:
        results.append(_delete_rows_for_org(sb, table, org_key, columns))

    final = sb.table('organizations').delete().eq('id', org_key).execute()
    if not final.data:
        raise RuntimeError('Tenant data cleanup finished, but organization row could not be removed')

    _invalidate_tenant_meta_cache(org_key)
    return {
        'organization_id': org_key,
        'organization_name': expected,
        'deleted_at': now,
        'deleted_by': str(deleted_by) if deleted_by else None,
        'delete_reason': clean_reason,
        'branch_ids': branch_ids,
        'tables': results,
    }