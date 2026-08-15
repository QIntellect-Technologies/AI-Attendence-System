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

logger = get_logger(__name__)

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
    now = datetime.now(timezone.utc)
    payload = {
        'sub':          str(staff['id']),
        'org_id':       str(staff['org_id']),
        'branch_id':    str(staff['branch_id']) if staff.get('branch_id') else None,
        'people_type':  staff.get('people_type'),
        'staff_type':   staff.get('staff_type') or 'office',
        'role':         staff.get('role') or 'staff',
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

        g.client_staff = {
            'id':          payload['sub'],
            'org_id':      payload['org_id'],
            'branch_id':   payload.get('branch_id'),
            'people_type': payload.get('people_type'),
            'staff_type':  payload.get('staff_type'),
            'role':        payload.get('role'),
        }
        return f(*args, **kwargs)

    return decorated