"""
client_staff_auth.py
──────────────────────────────────────────────────────────────────────────────
JWT auth for the mobile employee/field-staff portal (client_staff rows).

Deliberately separate from support_auth.py (internal_users / Support
Dashboard). Same shape, different audience and different secret:

  Token           Signed with              Identifies
  --------------  ------------------------  ------------------------------
  Support token   SUPPORT_JWT_SECRET        internal_users (QIntellect team)
  Client staff    CLIENT_STAFF_JWT_SECRET   client_staff (org_id + branch_id
  token                                     + staff_id scoped)

Using one shared secret for both would mean a leaked mobile-app token and a
leaked Support Dashboard token are forgeable against each other's endpoints.
They must never be the same key.

Flow:
  POST /api/staff/login        → verify email/phone + password → signed JWT
  @require_client_staff_auth   → decorator validating JWT on every subsequent
                                  mobile-portal request, sets g.client_staff
"""

import os
from datetime import datetime, timedelta, timezone
from functools import wraps

import jwt
from flask import request, jsonify, g

from support_db import authenticate_client_staff
from logger_config import get_logger
import session_registry

logger = get_logger(__name__)

_ACCOUNT_TYPE = 'client_staff_mobile'

_JWT_SECRET = None
_JWT_ALGORITHM = 'HS256'

# Mobile sessions are long-lived on purpose — a field worker checking in via
# geofence at a job site shouldn't be forced to re-login every few hours the
# way a Support Dashboard admin session does. This does mean deactivating a
# client_staff row (status/is_archived) does NOT immediately invalidate a
# token already issued to them — require_client_staff_auth only validates
# the JWT signature/expiry, it does not re-query client_staff per request.
# If immediate revocation on deactivation matters, add a DB check in
# require_client_staff_auth (one extra query per request) or shorten the
# TTL — flagging this now rather than silently deciding it doesn't matter.
_TOKEN_TTL_DAYS = 30


def _get_jwt_secret() -> str:
    global _JWT_SECRET
    if _JWT_SECRET is None:
        secret = os.environ.get('CLIENT_STAFF_JWT_SECRET', '').strip()
        if not secret or len(secret) < 32:
            raise RuntimeError(
                'CLIENT_STAFF_JWT_SECRET must be set in env and be at least 32 '
                'characters, and must NOT equal SUPPORT_JWT_SECRET. Generate one with: '
                'python -c "import secrets; print(secrets.token_hex(32))"'
            )
        _JWT_SECRET = secret
    return _JWT_SECRET


def _mint_token(staff: dict) -> str:
    """Sign a JWT for an authenticated client_staff member.

    Carries every claim a mobile-portal route needs to scope its query
    without a second DB round-trip: org_id + branch_id (tenant scoping,
    same as every Client Dashboard route), people_type (student/staff/
    doctor/worker — vertical-aware labeling), staff_type (office/field —
    decides whether the app shows WiFi or geofence check-in).
    """
    # A separate account_type ('client_staff_mobile') from the desktop
    # dashboard's 'client_staff' rows on purpose -- see session_registry.py's
    # module docstring for why a normal re-login on one surface must not
    # silently kill the other.
    session_id = session_registry.rotate_session(_ACCOUNT_TYPE, str(staff['id']))

    now = datetime.now(timezone.utc)
    payload = {
        'sub':          str(staff['id']),
        'org_id':       str(staff['org_id']),
        'branch_id':    str(staff['branch_id']) if staff.get('branch_id') else None,
        'people_type':  staff.get('people_type'),
        'staff_type':   staff.get('staff_type') or 'office',
        'role':         staff.get('role') or 'staff',
        'sid':          session_id,
        'iat':          now,
        'exp':          now + timedelta(days=_TOKEN_TTL_DAYS),
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm=_JWT_ALGORITHM)


def _decode_token(token: str) -> dict:
    return jwt.decode(token, _get_jwt_secret(), algorithms=[_JWT_ALGORITHM])


# ─── Login ────────────────────────────────────────────────────────────────────

def login_client_staff(identifier: str, password: str) -> tuple[dict, str]:
    """
    Verify credentials against client_staff (email OR phone, raw match).
    Returns (staff_dict, token) on success, raises ValueError on failure —
    same error-handling contract client_routes_helpers.handle() already
    expects from every other client-facing db function in this codebase.
    """
    staff = authenticate_client_staff(identifier, password)
    if not staff:
        raise ValueError('Invalid username/number or password')

    token = _mint_token(staff)
    return staff, token


def _org_access_blocked_response():
    """Return a 403 tuple if the caller's org may not use the mobile portal.

    Mobile tokens live 30 days (see _TOKEN_TTL_DAYS), so without this an
    archived or suspended org's field staff would keep checking in for a
    month. Function-local import for the same circular-import reason as
    the Client Dashboard decorator.
    """
    from support_db_core import _compute_org_status, _org_access_allows_client

    org_id = (g.client_staff or {}).get('org_id')
    if not org_id:
        return None

    try:
        status = _compute_org_status(str(org_id))
    except Exception:
        logger.exception('Org status lookup failed for org_id=%s', org_id)
        return None

    if _org_access_allows_client(status):
        return None

    messages = {
        'archived': 'This organization has been archived. Contact your administrator.',
        'deleted': 'This organization no longer exists. Contact your administrator.',
        'suspended': 'Access is suspended due to an unpaid invoice. Contact your administrator.',
    }
    return jsonify({
        'success': False,
        'error': messages.get(status, 'This organization is not active.'),
        'code': 'ORG_ACCESS_BLOCKED',
        'organization_status': status,
    }), 403


# ─── Auth decorator ───────────────────────────────────────────────────────────

def require_client_staff_auth(f):
    """
    Decorator for every mobile-portal route except /api/staff/login.

    Reads Bearer token from Authorization header. Sets g.client_staff =
    { id, org_id, branch_id, people_type, staff_type, role } for the
    request lifecycle — every mobile route reads tenant scope from here,
    never from a client-supplied organization_id/branch_id query param, so
    a token minted for one org can never be used to read or write another
    org's data by changing a query string.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            return jsonify({'success': False, 'error': 'Authorization header required'}), 401

        token = auth_header[7:]
        try:
            payload = _decode_token(token)
        except jwt.ExpiredSignatureError:
            return jsonify({'success': False, 'error': 'Session expired. Please log in again.'}), 401
        except jwt.PyJWTError:
            return jsonify({'success': False, 'error': 'Invalid session token.'}), 401

        # See session_registry.py -- signature+expiry alone is no longer
        # enough; the token must also still be the CURRENT session. This
        # matters especially here: mobile tokens live 30 days, so without
        # this check a stolen/forgotten mobile session would stay valid a
        # full month even after the owner changed their password elsewhere.
        ok, reason = session_registry.validate_session(
            _ACCOUNT_TYPE, str(payload['sub']), str(payload.get('sid') or '')
        )
        if not ok:
            message = (
                "Your password was changed. If this wasn't you, contact your administrator."
                if reason == session_registry.PASSWORD_CHANGED
                else 'You were logged in elsewhere. That session has been ended.'
            )
            return jsonify({'success': False, 'error': message, 'code': reason}), 401

        g.client_staff = {
            'id':          payload['sub'],
            'org_id':      payload['org_id'],
            'branch_id':   payload.get('branch_id'),
            'people_type': payload.get('people_type'),
            'staff_type':  payload.get('staff_type'),
            'role':        payload.get('role'),
        }

        blocked = _org_access_blocked_response()
        if blocked is not None:
            return blocked

        return f(*args, **kwargs)

    return decorated


def logout_client_staff(staff_id: str) -> None:
    """Explicit server-side revocation for /api/staff/logout -- makes the
    current token unusable immediately rather than leaving it valid until
    natural expiry (up to 30 days)."""
    session_registry.end_session(_ACCOUNT_TYPE, str(staff_id))