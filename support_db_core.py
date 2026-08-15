"""
support_db_core.py
───────────────────────────────────────────────────────────────────────────────
Shared infrastructure: Supabase retry wrapper, tenant caches, org-status/access
computation, and small JSON coercion helpers used across every other
support_db_* module. This module MUST NOT import any other support_db_*
module at top level -- everything else imports from here, not vice versa.

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
from support_invite_message import build_client_invite_message
from zoneinfo import ZoneInfo, available_timezones
from core.vertical_templates import (
    list_vertical_templates as _list_vertical_templates,
    normalize_vertical_payload,
    build_vertical_config,
    get_vertical_template,
)

_VALID_TIMEZONES: frozenset[str] | None = None

logger = get_logger(__name__)

NODE_HEARTBEAT_INTERVAL_SECONDS = 15

NODE_OFFLINE_THRESHOLD_SAFETY_MULTIPLIER = 3

NODE_OFFLINE_THRESHOLD_MIN_SECONDS = NODE_HEARTBEAT_INTERVAL_SECONDS * NODE_OFFLINE_THRESHOLD_SAFETY_MULTIPLIER  # 45

NODE_OFFLINE_THRESHOLD_MAX_SECONDS = 300  # still meaningfully faster than the once-daily batch sync_time flush

NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS = NODE_OFFLINE_THRESHOLD_MIN_SECONDS  # 45

_VALID_STAFF_WORK_TYPES = ('office', 'field')

_SUPABASE_RETRYABLE_MARKERS = (
    'remoteprotocolerror',
    'server disconnected',
    'streamreset',
    'connectionterminated',
    'connection reset',
    'connection aborted',
    'connection not available',
    'readtimeout',
    'write timeout',
    'connect timeout',
    'timeout',
    'temporarily unavailable',
)

_TENANT_META_CACHE_TTL_SECONDS = 20.0

_STATUS_CACHE_TTL_SECONDS = 60.0

_ORG_CACHE: dict[str, tuple[float, dict]] = {}

_BRANCH_CACHE: dict[str, tuple[float, list[dict]]] = {}

_STATUS_CACHE: dict[str, tuple[float, str]] = {}

def _validate_branch_timezone(value: object) -> str:
    """Validate an IANA timezone name server-side.

    Client sends a name picked from Intl.supportedValuesOf('timeZone'), but
    the server must not trust that blindly — a stale frontend build, a
    direct API call, or a future browser deprecating a zone name could all
    submit a bad value. available_timezones() is the same tzdata the
    zoneinfo module itself uses at read time in support_db_attendance_gate.py,
    so validation and consumption can never disagree.
    """
    global _VALID_TIMEZONES
    text = str(value or '').strip()
    if not text:
        raise ValueError('timezone is required')
    if _VALID_TIMEZONES is None:
        _VALID_TIMEZONES = available_timezones()
    if text not in _VALID_TIMEZONES:
        raise ValueError(f'Invalid timezone: {text}')
    return text

def _is_retryable_supabase_error(exc: Exception) -> bool:
    text = f'{type(exc).__name__}: {exc}'.lower()
    return any(marker in text for marker in _SUPABASE_RETRYABLE_MARKERS)

def _execute_supabase(label: str, factory: Callable[[], Any], attempts: int = 2):
    """Execute a Supabase builder with one reconnect retry for network resets.

    factory must build a fresh query using get_supabase(), because a failed
    HTTP/2 connection may poison the existing client's connection pool.
    """
    last_exc: Exception | None = None
    max_attempts = max(1, int(attempts or 1))

    for attempt in range(max_attempts):
        try:
            return factory().execute()
        except Exception as exc:  # Supabase/httpx/postgrest exceptions vary by version.
            last_exc = exc
            if attempt >= max_attempts - 1 or not _is_retryable_supabase_error(exc):
                raise
            logger.warning(
                'Supabase request failed once during %s; reconnecting and retrying: %s',
                label,
                exc,
            )
            reset_supabase_client()
            time.sleep(0.12 * (attempt + 1))

    raise last_exc  # type: ignore[misc]

def _cache_get(cache: dict, key: str):
    item = cache.get(key)
    if not item:
        return None
    expires_at, value = item
    if expires_at <= time.monotonic():
        cache.pop(key, None)
        return None
    return value

def _cache_set(cache: dict, key: str, value):
    cache[key] = (time.monotonic() + _TENANT_META_CACHE_TTL_SECONDS, value)

def _cache_set_for(cache: dict, key: str, value, ttl_seconds: float):
    cache[key] = (time.monotonic() + ttl_seconds, value)

def _invalidate_tenant_meta_cache(org_id: str | None = None) -> None:
    if org_id:
        key = str(org_id)
        _ORG_CACHE.pop(key, None)
        _BRANCH_CACHE.pop(key, None)
        for branch_cache_key in list(_BRANCH_CACHE.keys()):
            if str(branch_cache_key).startswith(f'{key}:'):
                _BRANCH_CACHE.pop(branch_cache_key, None)
        _STATUS_CACHE.pop(key, None)
    else:
        _ORG_CACHE.clear()
        _BRANCH_CACHE.clear()
        _STATUS_CACHE.clear()

def get_internal_user_by_id(user_id: str) -> dict:
    sb = get_supabase()

    result = (
        sb.table('internal_users')
        .select('id, email, full_name, role, is_active, last_login_at, created_at')
        .eq('id', user_id)
        .limit(1)
        .execute()
    )

    if not result.data:
        raise ValueError('Internal user not found')

    user = result.data[0]

    if not user.get('is_active'):
        raise ValueError('Account is deactivated')

    return user

def _compute_org_status(org_id: str) -> str:
    """Derive org access status from lifecycle fields and latest invoice.

    Single source of truth:
      deleted   -> deleted
      archived  -> archived
      unpaid invoice within grace -> grace_period
      unpaid invoice after grace  -> suspended
      paid/no invoice             -> active

    The status is computed, not manually stored. This keeps billing access,
    archive state, local-node sync, and client dashboard gates consistent.
    """
    org_key = str(org_id)
    cached = _cache_get(_STATUS_CACHE, org_key)
    if cached is not None:
        return str(cached)

    lifecycle_result = _execute_supabase(
        'compute_org_lifecycle_status',
        lambda: (
            get_supabase()
            .table('organizations')
            .select('id, archived_at, deleted_at')
            .eq('id', org_key)
            .limit(1)
        ),
    )

    if not lifecycle_result.data:
        raise ValueError(f'Organization {org_id} not found')

    lifecycle = lifecycle_result.data[0]
    if lifecycle.get('deleted_at'):
        status = 'deleted'
    elif lifecycle.get('archived_at'):
        status = 'archived'
    else:
        result = _execute_supabase(
            'compute_org_invoice_status',
            lambda: (
                get_supabase()
                .table('invoices')
                .select('status, due_date, grace_period_days')
                .eq('org_id', org_key)
                .order('created_at', desc=True)
                .limit(1)
            ),
        )

        if not result.data:
            status = 'active'
        else:
            inv = result.data[0]
            if inv['status'] == 'paid':
                status = 'active'
            else:
                deadline = date.fromisoformat(inv['due_date']) + timedelta(
                    days=int(inv.get('grace_period_days') or 0)
                )
                status = 'grace_period' if date.today() <= deadline else 'suspended'

    _cache_set_for(_STATUS_CACHE, org_key, status, _STATUS_CACHE_TTL_SECONDS)
    return status

def _org_access_allows_client(status: str | None) -> bool:
    return str(status or '').strip().lower() in {'active', 'grace_period'}

def _ensure_org_client_access(org_id: str, action: str = 'This action') -> dict:
    from support_db_organizations import get_organization
    org = get_organization(str(org_id))
    status = str(org.get('status') or '').lower()
    if not _org_access_allows_client(status):
        raise ValueError(f'{action} is blocked because organization status is {status}.')
    return org

def _json_dict(value) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}

def _attach_status(org: dict) -> dict:
    """Attach computed billing/lifecycle status, terminology, and vertical defaults."""
    from support_db_client_users import _normalize_people_kind
    org = dict(org or {})
    org['status'] = _compute_org_status(org['id'])

    business_type = (
        org.get('business_type')
        or org.get('biz_type')
        or org.get('org_type')
        or 'company'
    )

    stored_vertical_config = _json_dict(org.get('vertical_config'))
    default_vertical_config = build_vertical_config(
        business_type,
        _json_list(org.get('attendance_people_types')),
    )
    vertical_config = {**default_vertical_config, **stored_vertical_config}

    enabled_people_types = (
        _json_list(org.get('enabled_people_types'))
        or _json_list(vertical_config.get('enabled_people_types'))
        or ['staff']
    )
    attendance_people_types = (
        _json_list(org.get('attendance_people_types'))
        or _json_list(vertical_config.get('attendance_people_types'))
        or enabled_people_types
    )
    attendance_people_types = [
        people_type for people_type in attendance_people_types
        if people_type in enabled_people_types
    ] or enabled_people_types

    vertical_config['enabled_people_types'] = enabled_people_types
    vertical_config['attendance_people_types'] = attendance_people_types

    org['business_type'] = str(business_type).strip().lower() or 'company'
    org['biz_type'] = org.get('biz_type') or org['business_type']
    org['primary_people_type'] = (
        org.get('primary_people_type')
        or vertical_config.get('primary_people_type')
        or enabled_people_types[0]
    )
    org['enabled_people_types'] = enabled_people_types
    org['attendance_people_types'] = attendance_people_types
    org['vertical_config'] = vertical_config

    org['people_kind'] = _normalize_people_kind(
        org.get('people_kind'),
        org.get('org_type') or org['business_type'],
    )
    org['terminology_overrides'] = org.get('terminology_overrides') or {}
    return org

def _json_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return []
        try:
            import json
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return [item.strip() for item in raw.split(',') if item.strip()]
    return []