"""
support_db_internal.py
───────────────────────────────────────────────────────────────────────────────
Support-dashboard-global paginated read models (branches/invoices/module
entitlements/node health/internal users), the offline-detection sweep job,
camera recognition status, and cloud-mode embeddings import.

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
from support_db_core import _attach_status, _ensure_org_client_access, _execute_supabase
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

def _support_page_int(value, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))

def _support_page_window(page=None, page_size=None, default_size: int = 25) -> tuple[int, int, int, int]:
    page_number = _support_page_int(page, 1, 1, 1_000_000)
    size = _support_page_int(page_size, default_size, 1, 100)
    start = (page_number - 1) * size
    end = start + size - 1
    return page_number, size, start, end

def _support_paginated(rows: list[dict], total: int, page: int, page_size: int) -> dict:
    total_value = int(total or 0)
    page_count = max(1, (total_value + page_size - 1) // page_size) if total_value else 1
    return {
        'rows': rows,
        'items': rows,
        'data': rows,
        'total': total_value,
        'count': total_value,
        'page': int(page),
        'page_size': int(page_size),
        'pageSize': int(page_size),
        'total_pages': page_count,
        'totalPages': page_count,
        'has_more': int(page) < page_count,
        'hasMore': int(page) < page_count,
    }

def _support_text(value: object) -> str:
    return str(value or '').strip()

def _support_lower(value: object) -> str:
    return _support_text(value).lower()

def _support_org_lookup(org_ids: list[str]) -> dict[str, dict]:
    keys = sorted({str(item) for item in org_ids if str(item or '').strip()})
    if not keys:
        return {}
    result = _execute_supabase(
        'support_org_lookup',
        lambda: (
            get_supabase()
            .table('organizations')
            .select('id,name,contact_email,contact_phone,business_type,attendance_mode,max_branches,archived_at,deleted_at')
            .in_('id', keys)
        ),
    )
    lookup = {}
    for row in result.data or []:
        try:
            org = _attach_status(row)
        except Exception:
            org = dict(row or {})
        lookup[str(org.get('id'))] = org
    return lookup

def _support_search_match(row: dict, search: str, fields: tuple[str, ...]) -> bool:
    if not search:
        return True
    haystack = ' '.join(_support_lower(row.get(field)) for field in fields)
    return search in haystack

def _support_filter_page_rows(rows: list[dict], page=None, page_size=None, default_size: int = 25) -> dict:
    page_number, size, start, end = _support_page_window(page, page_size, default_size)
    total = len(rows)
    return _support_paginated(rows[start:end + 1], total, page_number, size)

def list_support_branches_page(page=1, page_size=25, search: str | None = None, status: str | None = None) -> dict:
    """Global Branches page.

    Tenant-safe: every row is scoped by its own org_id and enriched only with
    organization metadata for that same org. Deleted organizations are hidden.
    """
    clean_search = _support_lower(search)
    clean_status = _support_lower(status)
    page_number, size, start, end = _support_page_window(page, page_size)

    # Search across org name/email needs org metadata, so use a bounded read and
    # paginate after filtering. Normal unfiltered reads stay server-side paged.
    # Default support branch listing shows active/visible branches only. Dropped
    # branches are available explicitly via status=dropped or status=all.
    search_mode = bool(clean_search)
    include_dropped_rows = clean_status in {'all', 'dropped'}
    dropped_only = clean_status == 'dropped'
    limit_end = 999 if search_mode else end

    def _branches_query():
        query = get_supabase().table('branches').select('*', count='exact')
        if dropped_only:
            query = query.not_.is_('dropped_at', 'null')
        elif not include_dropped_rows:
            query = query.is_('dropped_at', 'null')
        return query.order('created_at', desc=True).range(0 if search_mode else start, limit_end)

    result = _execute_supabase('support_global_branches', _branches_query)
    rows = [dict(row or {}) for row in (result.data or [])]
    orgs = _support_org_lookup([str(row.get('org_id')) for row in rows])

    enriched = []
    for row in rows:
        org = orgs.get(str(row.get('org_id'))) or {}
        org_status = _support_lower(org.get('status'))
        if org_status == 'deleted' or org.get('deleted_at'):
            continue
        is_dropped = bool(row.get('dropped_at'))
        branch_status = 'dropped' if is_dropped else ('archived' if org_status == 'archived' else 'active')
        item = {
            **row,
            'id': str(row.get('id')),
            'branch_id': str(row.get('id')),
            'org_id': str(row.get('org_id') or ''),
            'organization_id': str(row.get('org_id') or ''),
            'organization_name': org.get('name') or 'Unknown organization',
            'organization_email': org.get('contact_email'),
            'organization_status': org.get('status'),
            'attendance_mode': org.get('attendance_mode'),
            'status': branch_status,
            'dropped_at': row.get('dropped_at'),
            'drop_reason': row.get('drop_reason'),
        }
        if clean_status and clean_status not in {'all', 'visible'} and _support_lower(item.get('status')) != clean_status:
            continue
        if search_mode and not _support_search_match(item, clean_search, ('name', 'location', 'id', 'organization_name', 'organization_email')):
            continue
        enriched.append(item)

    if search_mode or clean_status:
        return _support_filter_page_rows(enriched, page_number, size)
    return _support_paginated(enriched, int(result.count or len(enriched)), page_number, size)

def list_support_invoices_page(page=1, page_size=25, search: str | None = None, status: str | None = None) -> dict:
    """Global Invoices page with org metadata and computed org access status."""
    clean_search = _support_lower(search)
    clean_status = _support_lower(status)
    page_number, size, start, end = _support_page_window(page, page_size)
    search_mode = bool(clean_search)
    limit_end = 999 if search_mode else end

    def _invoice_query():
        query = get_supabase().table('invoices').select('*', count='exact')
        if clean_status and clean_status not in {'all', 'visible'}:
            query = query.eq('status', clean_status)
        return query.order('created_at', desc=True).range(0 if search_mode else start, limit_end)

    result = _execute_supabase('support_global_invoices', _invoice_query)
    rows = [dict(row or {}) for row in (result.data or [])]
    orgs = _support_org_lookup([str(row.get('org_id') or row.get('organization_id')) for row in rows])

    enriched = []
    for row in rows:
        org_id = str(row.get('org_id') or row.get('organization_id') or '')
        org = orgs.get(org_id) or {}
        if _support_lower(org.get('status')) == 'deleted' or org.get('deleted_at'):
            continue
        item = {
            **row,
            'id': str(row.get('id')),
            'org_id': org_id,
            'organization_id': org_id,
            'organization_name': org.get('name') or 'Unknown organization',
            'organization_email': org.get('contact_email'),
            'organization_status': org.get('status'),
        }
        if search_mode and not _support_search_match(item, clean_search, ('id', 'status', 'notes', 'organization_name', 'organization_email')):
            continue
        enriched.append(item)

    if search_mode:
        return _support_filter_page_rows(enriched, page_number, size)
    return _support_paginated(enriched, int(result.count or len(enriched)), page_number, size)

def list_support_module_entitlements_page(page=1, page_size=25, search: str | None = None, module: str | None = None, status: str | None = None) -> dict:
    """Global Module Entitlements page. One row per org/module entitlement."""
    clean_search = _support_lower(search)
    clean_module = _support_lower(module)
    clean_status = _support_lower(status)
    page_number, size, start, end = _support_page_window(page, page_size)
    search_mode = bool(clean_search)
    limit_end = 1999 if search_mode else end

    def _modules_query():
        query = get_supabase().table('organization_modules').select('*', count='exact')
        if clean_module and clean_module not in {'all', 'any'}:
            query = query.eq('module_name', clean_module)
        if clean_status and clean_status not in {'all', 'visible'}:
            query = query.eq('status', clean_status)
        return query.order('purchased_at', desc=True).range(0 if search_mode else start, limit_end)

    result = _execute_supabase('support_global_module_entitlements', _modules_query)
    rows = [dict(row or {}) for row in (result.data or [])]
    orgs = _support_org_lookup([str(row.get('org_id') or row.get('organization_id')) for row in rows])

    enriched = []
    for row in rows:
        org_id = str(row.get('org_id') or row.get('organization_id') or '')
        org = orgs.get(org_id) or {}
        if _support_lower(org.get('status')) == 'deleted' or org.get('deleted_at'):
            continue
        item = {
            **row,
            'id': str(row.get('id') or f"{org_id}:{row.get('module_name')}"),
            'org_id': org_id,
            'organization_id': org_id,
            'organization_name': org.get('name') or 'Unknown organization',
            'organization_email': org.get('contact_email'),
            'organization_status': org.get('status'),
        }
        if search_mode and not _support_search_match(item, clean_search, ('module_name', 'status', 'organization_name', 'organization_email')):
            continue
        enriched.append(item)

    if search_mode:
        return _support_filter_page_rows(enriched, page_number, size)
    return _support_paginated(enriched, int(result.count or len(enriched)), page_number, size)

def list_support_node_health_page(page=1, page_size=25, search: str | None = None, status: str | None = None) -> dict:
    from support_db_nodes import _compute_node_status, _resolve_node_offline_threshold_seconds
    from support_db_organizations import _delete_error_is_schema_mismatch
    clean_search = _support_lower(search)
    clean_status = _support_lower(status)
    page_number, size, start, end = _support_page_window(page, page_size)
    search_mode = bool(clean_search)
    limit_end = 999 if search_mode else end

    branches_result = _execute_supabase(
        'support_node_health.branches',
        lambda: (
            get_supabase()
            .table('branches')
            .select('*', count='exact')
            .order('created_at', desc=True)
            .range(0 if search_mode else start, limit_end)
        ),
    )
    branches = [dict(row or {}) for row in (branches_result.data or [])]
    branch_ids = [str(row.get('id')) for row in branches if row.get('id')]
    orgs = _support_org_lookup([str(row.get('org_id')) for row in branches])

    node_by_branch: dict[str, dict] = {}
    if branch_ids:
        try:
            keys_result = _execute_supabase(
                'support_node_health.node_api_keys',
                lambda: (
                    get_supabase()
                    .table('node_api_keys')
                    .select('id,org_id,branch_id,node_id,node_label,last_seen_at,status,created_at,last_heartbeat_payload')
                    .in_('branch_id', branch_ids)
                    .eq('status', 'active')
                ),
            )
            for key in keys_result.data or []:
                node_by_branch[str(key.get('branch_id'))] = dict(key or {})
        except Exception as exc:
            if not _delete_error_is_schema_mismatch(exc, 'node_api_keys'):
                raise

    enriched = []
    for branch in branches:
        org = orgs.get(str(branch.get('org_id'))) or {}
        if _support_lower(org.get('status')) == 'deleted' or org.get('deleted_at'):
            continue
        node = node_by_branch.get(str(branch.get('id'))) or {}
        threshold_seconds = _resolve_node_offline_threshold_seconds(org)
        last_seen = node.get('last_seen_at')
        node_status, minutes_since_seen = _compute_node_status(last_seen, threshold_seconds)
        payload = node.get('last_heartbeat_payload') if isinstance(node.get('last_heartbeat_payload'), dict) else {}

        item = {
            'id': str(branch.get('id')),
            'branch_id': str(branch.get('id')),
            'branch_name': branch.get('name') or 'Branch',
            'org_id': str(branch.get('org_id') or ''),
            'organization_id': str(branch.get('org_id') or ''),
            'organization_name': org.get('name') or 'Unknown organization',
            'organization_status': org.get('status'),
            'attendance_mode': org.get('attendance_mode'),
            'fallback_active': bool(branch.get('fallback_active')),
            'node_api_key_id': node.get('id'),
            'node_id': node.get('node_id'),
            'node_label': node.get('node_label'),
            'status': node_status,
            'last_seen_at': last_seen,
            'minutes_since_seen': minutes_since_seen,
            'offline_threshold_seconds': threshold_seconds,
            'configured_cameras': payload.get('configured_cameras'),
            'cycle_status': payload.get('cycle_status'),
            'last_cycle_at': payload.get('last_cycle_at'),
            'last_error': payload.get('last_error'),
            'agent_version': payload.get('agent_version'),
            'hostname': payload.get('hostname'),
        }
        if clean_status and clean_status not in {'all', 'visible'} and _support_lower(item.get('status')) != clean_status:
            continue
        if search_mode and not _support_search_match(item, clean_search, ('branch_name', 'organization_name', 'node_id', 'node_label', 'hostname', 'last_error')):
            continue
        enriched.append(item)

    if search_mode or clean_status:
        return _support_filter_page_rows(enriched, page_number, size)
    return _support_paginated(enriched, int(branches_result.count or len(enriched)), page_number, size)

def run_offline_detection_sweep() -> dict:
    """Flip branches.fallback_active=True for any local-mode branch whose
    node has gone silent past its org's configured threshold.

    Called by Railway Cron via /v1/internal/scheduled/health-check, never
    by request-time code — this must run on a timer independent of any
    incoming HTTP request, which is exactly what request-scoped Flask
    handlers cannot provide on their own.
    """
    from support_db_nodes import _compute_node_status, _iso_now, _resolve_node_offline_threshold_seconds
    sb = get_supabase()
    orgs_result = (
        sb.table('organizations')
        .select('id, node_offline_threshold_seconds, attendance_mode')
        .eq('attendance_mode', 'local')
        .is_('deleted_at', 'null')
        .execute()
    )
    orgs = orgs_result.data or []
    flipped_branch_ids: list[str] = []
    checked_branch_count = 0

    for org in orgs:
        org_id = str(org['id'])
        threshold_seconds = _resolve_node_offline_threshold_seconds(org)

        branches_result = (
            sb.table('branches')
            .select('id, fallback_active')
            .eq('org_id', org_id)
            .is_('dropped_at', 'null')
            .execute()
        )
        branches = branches_result.data or []
        if not branches:
            continue

        branch_ids = [b['id'] for b in branches]
        keys_result = (
            sb.table('node_api_keys')
            .select('branch_id, last_seen_at')
            .eq('org_id', org_id)
            .eq('status', 'active')
            .in_('branch_id', branch_ids)
            .execute()
        )
        key_by_branch = {k['branch_id']: k for k in (keys_result.data or [])}

        for branch in branches:
            checked_branch_count += 1
            if branch.get('fallback_active'):
                continue  # already failed over; heartbeat clears this on recovery

            key = key_by_branch.get(branch['id'])
            if not key or not key.get('last_seen_at'):
                # Never activated / never heartbeated. Not the same condition
                # as "went offline" — a node that was never turned on should
                # not trigger cloud fallback, since there's no local
                # embedding set for it to have fallen back from.
                continue

            status, _minutes = _compute_node_status(key['last_seen_at'], threshold_seconds)
            if status == 'offline':
                sb.table('branches').update({
                    'fallback_active': True,
                    'updated_at': _iso_now(),
                }).eq('id', branch['id']).execute()
                flipped_branch_ids.append(str(branch['id']))

    return {
        'checked_at': _iso_now(),
        'organizations_checked': len(orgs),
        'branches_checked': checked_branch_count,
        'branches_flipped_to_fallback': flipped_branch_ids,
    }

def _safe_internal_user(row: dict) -> dict:
    return {k: v for k, v in dict(row or {}).items() if k != 'password_hash'}

def list_internal_users_page(page=1, page_size=25, search: str | None = None, role: str | None = None, active: str | None = None) -> dict:
    """Paginated internal support users. Not tenant scoped by design."""
    clean_search = _support_lower(search)
    clean_role = _support_lower(role)
    clean_active = _support_lower(active)
    page_number, size, start, end = _support_page_window(page, page_size)
    search_mode = bool(clean_search)
    limit_end = 999 if search_mode else end

    def _users_query():
        query = get_supabase().table('internal_users').select('id,email,full_name,role,is_active,last_login_at,created_at', count='exact')
        if clean_role and clean_role not in {'all', 'any'}:
            query = query.eq('role', clean_role)
        if clean_active in {'true', 'active', '1', 'yes'}:
            query = query.eq('is_active', True)
        elif clean_active in {'false', 'inactive', '0', 'no'}:
            query = query.eq('is_active', False)
        return query.order('created_at', desc=True).range(0 if search_mode else start, limit_end)

    result = _execute_supabase('support_internal_users_page', _users_query)
    rows = [_safe_internal_user(row) for row in (result.data or [])]
    if search_mode:
        rows = [row for row in rows if _support_search_match(row, clean_search, ('email', 'full_name', 'role'))]
        return _support_filter_page_rows(rows, page_number, size)
    return _support_paginated(rows, int(result.count or len(rows)), page_number, size)

_INTERNAL_USER_ROLES = {'super_admin', 'admin', 'support', 'billing', 'operations'}

_INTERNAL_USER_ROLE_ALIASES = {
    'support_agent': 'support',
    'support_admin': 'support',
    'billing_admin': 'billing',
    'billing_agent': 'billing',
    'ops': 'operations',
    'operation': 'operations',
}

def _normalize_internal_user_role(value) -> str:
    role = _support_lower(value or 'support')
    role = _INTERNAL_USER_ROLE_ALIASES.get(role, role)
    if role not in _INTERNAL_USER_ROLES:
        raise ValueError('Invalid internal user role')
    return role

def create_internal_user(payload: dict, created_by: str | None = None) -> dict:
    from support_db_client_users import _hash_password
    email = _support_lower(payload.get('email'))
    full_name = _support_text(payload.get('full_name') or payload.get('name'))
    role = _support_lower(payload.get('role') or 'support')
    password = str(payload.get('password') or '').strip()
    if not email or '@' not in email:
        raise ValueError('Valid email is required')
    if not full_name:
        raise ValueError('Full name is required')
    if role not in {'super_admin', 'admin', 'support', 'support_agent', 'billing', 'billing_admin', 'operations'}:
        raise ValueError('Invalid internal user role')
    if len(password) < 8:
        raise ValueError('Password must be at least 8 characters')
    row = {
        'email': email,
        'full_name': full_name,
        'role': role,
        'password_hash': _hash_password(password),
        'is_active': bool(payload.get('is_active', True)),
    }
    result = get_supabase().table('internal_users').insert(row).execute()
    if not result.data:
        raise RuntimeError('Failed to create internal user')
    return _safe_internal_user(result.data[0])

def update_internal_user(user_id: str, payload: dict) -> dict:
    allowed = {'full_name', 'role', 'is_active'}
    update_data = {k: payload.get(k) for k in allowed if k in payload}
    if 'role' in update_data:
        role = _support_lower(update_data.get('role'))
        if role not in {'super_admin', 'admin', 'support', 'support_agent', 'billing', 'billing_admin', 'operations'}:
            raise ValueError('Invalid internal user role')
        update_data['role'] = role
    if 'full_name' in update_data:
        update_data['full_name'] = _support_text(update_data.get('full_name'))
    if 'is_active' in update_data:
        update_data['is_active'] = bool(update_data.get('is_active'))
    if not update_data:
        raise ValueError('No valid internal user fields to update')
    result = get_supabase().table('internal_users').update(update_data).eq('id', str(user_id)).execute()
    if not result.data:
        raise ValueError('Internal user not found')
    return _safe_internal_user(result.data[0])

def reset_internal_user_password(user_id: str, password: str) -> dict:
    from support_db_client_users import _hash_password
    clean = str(password or '').strip()
    if len(clean) < 8:
        raise ValueError('Password must be at least 8 characters')
    result = get_supabase().table('internal_users').update({'password_hash': _hash_password(clean)}).eq('id', str(user_id)).execute()
    if not result.data:
        raise ValueError('Internal user not found')
    return _safe_internal_user(result.data[0])

def get_camera_recognition_status(org_id: str, branch_id: str | None) -> dict:
    """Whether cloud-side recognition must run continuously for this org/branch,
    independent of whether a dashboard viewer has the Live CCTV page open.

    - attendance_mode == 'cloud'  -> cloud is the ONLY recognition path, so it
      must always run.
    - attendance_mode == 'local' and branches.fallback_active is True -> the
      local node is down; cloud is standing in.
    - Otherwise (local mode, node healthy) cloud recognition must stay OFF
      even if someone opens Live CCTV — local_node already owns attendance
      for that branch, and running both would double-mark people.
    """
    sb = get_supabase()
    org_key = str(org_id)

    org_result = _execute_supabase(
        'get_camera_recognition_status.org',
        lambda: sb.table('organizations').select('attendance_mode').eq('id', org_key).limit(1),
    )
    org_rows = org_result.data or []
    attendance_mode = str((org_rows[0].get('attendance_mode') if org_rows else None) or 'cloud').lower()

    fallback_active = False
    if branch_id and attendance_mode == 'local':
        branch_result = _execute_supabase(
            'get_camera_recognition_status.branch',
            lambda: sb.table('branches').select('fallback_active').eq('id', str(branch_id)).limit(1),
        )
        branch_rows = branch_result.data or []
        fallback_active = bool(branch_rows[0].get('fallback_active')) if branch_rows else False

    return {
        'attendance_mode': attendance_mode,
        'fallback_active': fallback_active,
        'always_on': attendance_mode == 'cloud' or fallback_active,
    }

def import_embeddings_cloud_mode(org_id: str, branch_id: str | None, records: list[dict]) -> dict:
    """Apply a trainer-produced embedding package directly to Supabase for a
    cloud-mode organization. `records` is package_format.parse_embedding_
    package()'s ['records'] list: [{people_type, person_code, full_name,
    embeddings, model_version}, ...]."""
    from support_db_nodes import _replace_face_embeddings_cloud, _valid_embedding_list
    from support_db_staff import _normalize_people_type, update_client_staff
    sb = get_supabase()
    _ensure_org_client_access(str(org_id), 'Cloud-mode embeddings import')
 
    results: list[dict] = []
    for record in records:
        people_type = _normalize_people_type(record.get('people_type'), 'staff')
        person_code = _support_text(record.get('person_code'))
        if not person_code:
            results.append({'people_type': people_type, 'person_code': None, 'status': 'rejected', 'reason': 'person_code is required'})
            continue
 
        staff_query = (
            sb.table('client_staff')
            .select('id, name, is_archived, status')
            .eq('org_id', str(org_id))
            .eq('people_type', people_type)
            .ilike('person_code', person_code)
        )
        if branch_id:
            staff_query = staff_query.eq('branch_id', str(branch_id))
        staff_result = staff_query.limit(1).execute()
 
        if not staff_result.data:
            results.append({'people_type': people_type, 'person_code': person_code, 'status': 'skipped', 'reason': 'No matching person found'})
            continue
 
        staff = staff_result.data[0]
        if staff.get('is_archived') or str(staff.get('status') or 'active') == 'inactive':
            results.append({'people_type': people_type, 'person_code': person_code, 'status': 'skipped', 'reason': 'Person is archived or inactive'})
            continue
 
        valid_embeddings = _valid_embedding_list(record.get('embeddings') or [])
        if not valid_embeddings:
            results.append({'people_type': people_type, 'person_code': person_code, 'status': 'rejected', 'reason': 'No valid embedding vectors were submitted'})
            continue
 
        staff_id = str(staff['id'])
        written = _replace_face_embeddings_cloud(
            org_id=str(org_id),
            staff_id=staff_id,
            embeddings=valid_embeddings,
            is_fallback_copy=False,
            source_job_id=None,
        )
        update_client_staff(staff_id, {'face_training_status': 'trained', 'is_face_verified': True})
        results.append({'people_type': people_type, 'person_code': person_code, 'staff_id': staff_id, 'status': 'synced', 'embedding_count': written})
 
    return {'synced_count': sum(1 for r in results if r['status'] == 'synced'), 'results': results}