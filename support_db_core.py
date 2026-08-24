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
import re
from math import radians, sin, cos, atan2, sqrt
from typing import Optional, Any, Callable, Sequence
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

try:
    # postgrest-py's own exception type. Checking `isinstance(exc, APIError)`
    # plus its structured `.code` (which postgrest sets to the raw HTTP
    # status whenever the response body couldn't be parsed as JSON -- see
    # generate_default_error_message in postgrest/exceptions.py) is a far
    # more reliable signal than pattern-matching the exception's stringified
    # text, which varies across postgrest-py versions and across whatever
    # an upstream proxy happened to put in the response body.
    from postgrest.exceptions import APIError as _PostgrestAPIError
except Exception:  # pragma: no cover - defensive; supabase always pulls postgrest
    _PostgrestAPIError = None
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
    # Supabase sits behind Cloudflare. When the edge can't reach the
    # origin it answers with an HTML error page, which postgrest reports
    # as a generic 'JSON could not be generated' / code 400 — the same
    # shape a genuinely malformed query produces. These are transient
    # infrastructure failures, not client errors, so they belong here:
    # without them a 15-second edge blip fails every request on its first
    # attempt with no reconnect.
    'json could not be generated',
    'cloudflare',
    '<html>',
    'bad gateway',
    '502',
    '504',
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

# HTTP status codes that mean "the origin/edge is having a bad time" —
# genuinely transient infrastructure failures worth retrying.
_ORIGIN_UNREACHABLE_STATUS_CODES = frozenset({502, 503, 504, 520, 521, 522, 523, 524})

def _postgrest_status_code(exc: Exception) -> int | None:
    """Best-effort extraction of the upstream HTTP status code from a
    postgrest APIError.

    `APIError.code` is documented as the Postgres/PostgREST error code, but
    postgrest's own generate_default_error_message() (used whenever the
    response body isn't valid JSON at all — e.g. Cloudflare's HTML WAF
    block page) sets it to the raw HTTP status code instead. That makes it
    a reliable, structured way to tell "the edge rejected/blocked this
    request" (4xx) apart from "the origin is unreachable" (5xx/52x),
    without depending on what text happens to be embedded in the body.
    """
    if _PostgrestAPIError is not None and isinstance(exc, _PostgrestAPIError):
        try:
            return int(getattr(exc, 'code', None))
        except (TypeError, ValueError):
            return None
    return None

def _is_retryable_supabase_error(exc: Exception) -> bool:
    status = _postgrest_status_code(exc)
    if status is not None:
        return status in _ORIGIN_UNREACHABLE_STATUS_CODES
    text = f'{type(exc).__name__}: {exc}'.lower()
    return any(marker in text for marker in _SUPABASE_RETRYABLE_MARKERS)

def _readable_supabase_error(exc: Exception, label: str) -> Exception:
    """Normalize any Supabase/postgrest failure into a clean ValueError
    (bad/rejected request -> 400) or RuntimeError (infra outage -> 500).

    This is the single place that decides what an operator-facing error
    message says, and it MUST NOT ever let a raw postgrest/pydantic/JSON
    exception escape unclassified — that gap is exactly what turned a
    Cloudflare WAF block of a SQL-injection probe into an unhandled 500
    (see bug: "SQL Injection Payload Causes Unhandled WAF Crash"). A
    request that the edge blocked or that PostgREST rejected is a bad
    *request*, not a database outage, so it is surfaced as a ValueError
    (400) rather than the old blanket "temporarily unreachable" message,
    which was both misleading and told a client to retry a query that will
    never succeed.

    Returns the exception to raise, so the caller keeps control of the
    raise site and the original stays chained for the logs.
    """
    status = _postgrest_status_code(exc)
    if status in _ORIGIN_UNREACHABLE_STATUS_CODES:
        logger.error('Supabase unreachable during %s (status %s): %s', label, status, exc)
        return RuntimeError(
            'The database is temporarily unreachable. Please retry in a moment.'
        )
    if status is not None:
        # Any other non-2xx from postgrest that didn't parse as a normal
        # JSON error body (403 WAF block, 400 malformed filter, etc).
        logger.warning('Supabase rejected request during %s (status %s): %s', label, status, exc)
        return ValueError('Your request could not be processed. Please adjust it and try again.')

    text = f'{type(exc).__name__}: {exc}'.lower()
    if 'cloudflare' in text or '<html>' in text or 'json could not be generated' in text:
        logger.error('Supabase unreachable during %s: %s', label, exc)
        return RuntimeError(
            'The database is temporarily unreachable. Please retry in a moment.'
        )
    # json.JSONDecodeError subclasses ValueError, so it must be excluded
    # here explicitly -- otherwise it would look like an intentional
    # application-level ValueError (e.g. 'branch_id is required') and pass
    # through unwrapped, which is exactly the original crash: a raw
    # "Expecting value: line 1 column 1" from trying to json-decode an
    # HTML WAF page, reaching the route layer unclassified.
    if isinstance(exc, (ValueError, RuntimeError)) and not isinstance(exc, json.JSONDecodeError):
        return exc
    # Last-resort net: whatever this is (JSONDecodeError, pydantic
    # ValidationError, a future postgrest-py internal type we haven't seen
    # yet), never let it leave this function as an unclassified exception.
    logger.exception('Unclassified Supabase failure during %s', label)
    return RuntimeError('The database is temporarily unreachable. Please retry in a moment.')


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
                raise _readable_supabase_error(exc, label)
            logger.warning(
                'Supabase request failed once during %s; reconnecting and retrying: %s',
                label,
                exc,
            )
            reset_supabase_client()
            time.sleep(0.12 * (attempt + 1))

    raise _readable_supabase_error(last_exc, label)  # type: ignore[arg-type]

def _quote_postgrest_filter_value(value: str) -> str:
    """Quote a value for safe embedding in a hand-built PostgREST filter
    string (`.or_()`, `.filter()`), per PostgREST's own escaping rule:
    https://postgrest.org/en/stable/references/api/tables_views.html
    ("If the filter value has a reserved character, wrap it in double
    quotes"). Backslash and embedded double-quotes are backslash-escaped
    first, matching PostgREST's `in.()` escaping convention.

    This is the actual fix for the class of bug in the old
    support_db_fast._or_search / support_db_payroll staff query /
    support_db_client_users login lookup: each hand-built its own `.or_()`
    string and only *stripped* a couple of characters (or nothing at all),
    which silently changes user intent (a real name/email can legitimately
    contain those characters) without reliably preventing the value's
    commas/parens from redefining the filter's structure. Quoting, per the
    protocol's own escape mechanism, is correct for arbitrary input instead
    of a best-effort blacklist.
    """
    escaped = str(value).replace('\\', '\\\\').replace('"', '\\"')
    return f'"{escaped}"'

def build_or_ilike_filter(search: Optional[str], columns: Sequence[str], max_length: int = 100) -> Optional[str]:
    """Build a safe PostgREST `.or_()` clause: `search` matched against
    every column in `columns` via case-insensitive substring match.

    Single, shared choke point for every "search box" query in the app
    (Staff, Payroll, Leaves, ...) so they all get identical, correct
    escaping instead of each reimplementing (and under-implementing) it.
    Returns None when there's nothing to search for, so callers can do
    `if clause: query = query.or_(clause)` uniformly.
    """
    text = str(search or '').strip()[:max_length]
    if not text:
        return None
    # Escape ILIKE's own wildcard characters (independent of, and applied
    # before, the PostgREST-level quoting above) so a literal '%' or '_'
    # typed into a search box matches itself instead of expanding into a
    # SQL wildcard the user never intended to use.
    like_safe = text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    quoted = _quote_postgrest_filter_value(f'%{like_safe}%')
    return ",".join(f'{col}.ilike.{quoted}' for col in columns)

def build_or_eq_filter(value: Optional[str], columns: Sequence[str], max_length: int = 320) -> Optional[str]:
    """Build a safe PostgREST `.or_()` clause: `value` matched exactly
    against every column in `columns`. Used for identifier lookups (e.g.
    login-by-email-or-phone) where the same raw value is checked against
    more than one column with `.eq.`. Deliberately does NOT trim/alter the
    value beyond length-capping — exact-match lookups must compare what
    was actually stored, so safety comes entirely from quoting, never from
    stripping characters.
    """
    text = str(value or '')[:max_length]
    if not text.strip():
        return None
    quoted = _quote_postgrest_filter_value(text)
    return ",".join(f'{col}.eq.{quoted}' for col in columns)

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

# Support-user display names for deletion_requested_by. Cached because
# _attach_status runs once per organization row in list_organizations, and
# the same handful of support users request most deletions -- without this
# a list of 200 orgs would issue 200 internal_users lookups.
_INTERNAL_USER_NAME_CACHE: dict = {}
_INTERNAL_USER_NAME_TTL_SECONDS = 300


def _internal_user_display_name(user_id) -> str | None:
    """Resolve an internal_users id to a human-readable name.

    Returns None when the id is missing. Falls back to the raw id (never
    blank) when the user row is gone, so an audit trail never silently
    loses who requested a destructive action.
    """
    if not user_id:
        return None
    key = str(user_id)

    cached = _cache_get(_INTERNAL_USER_NAME_CACHE, key)
    if cached is not None:
        return cached

    try:
        user = get_internal_user_by_id(key)
        name = (
            str(user.get('full_name') or '').strip()
            or str(user.get('email') or '').strip()
            or key
        )
    except Exception:
        # Deactivated/removed support account, or a transient lookup
        # failure -- degrade to the id rather than dropping attribution.
        name = key

    _cache_set_for(_INTERNAL_USER_NAME_CACHE, key, name, _INTERNAL_USER_NAME_TTL_SECONDS)
    return name


def _attach_status(org: dict) -> dict:
    """Attach computed billing/lifecycle status, terminology, and vertical defaults."""
    from support_db_client_users import _normalize_people_kind
    org = dict(org or {})
    org['status'] = _compute_org_status(org['id'])

    # Only resolved when a request actually exists, so the common path
    # (no pending deletion) costs nothing.
    if org.get('deletion_requested_by'):
        org['deletion_requested_by_name'] = _internal_user_display_name(
            org.get('deletion_requested_by')
        )

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