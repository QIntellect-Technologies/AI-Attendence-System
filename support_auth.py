"""
support_auth.py
──────────────────────────────────────────────────────────────────────────────
JWT auth for the Support Dashboard.

Architecture ref: Section 7
  "Internal-only tool. Separate auth (internal_users table)."
  "internal_users: id, email, password_hash, role — no organization_id"

Flow:
  POST /v1/support/auth/login  → verify bcrypt → return signed JWT
  @require_support_auth        → decorator that validates JWT on every request

JWT is signed with SUPPORT_JWT_SECRET (Railway env var, never shared with
client machines or frontend). Token contains: user_id, email, role, exp.
"""

import os
import bcrypt
import jwt
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import request, jsonify, g
from supabase_client import get_supabase
from logger_config import get_logger

logger = get_logger(__name__)

_JWT_SECRET = None
_JWT_ALGORITHM = 'HS256'
_TOKEN_TTL_HOURS = 8  # support sessions expire after 8 hours


def _get_jwt_secret() -> str:
    global _JWT_SECRET
    if _JWT_SECRET is None:
        secret = os.environ.get('SUPPORT_JWT_SECRET', '').strip()
        if not secret or len(secret) < 32:
            raise RuntimeError(
                'SUPPORT_JWT_SECRET must be set in env and be at least 32 characters. '
                'Generate one with: python -c "import secrets; print(secrets.token_hex(32))"'
            )
        _JWT_SECRET = secret
    return _JWT_SECRET


# ─── Token helpers ────────────────────────────────────────────────────────────

def _mint_token(user: dict) -> str:
    """Sign a JWT for an authenticated internal user."""
    now = datetime.now(timezone.utc)
    payload = {
        'sub':   str(user['id']),
        'email': user['email'],
        'role':  user['role'],
        'iat':   now,
        'exp':   now + timedelta(hours=_TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm=_JWT_ALGORITHM)


def _decode_token(token: str) -> dict:
    """Decode and validate a JWT. Raises jwt.PyJWTError on failure."""
    return jwt.decode(token, _get_jwt_secret(), algorithms=[_JWT_ALGORITHM])


def _safe_user(row: dict) -> dict:
    """Strip password_hash before sending to client."""
    return {k: v for k, v in row.items() if k != 'password_hash'}


# ─── Login ────────────────────────────────────────────────────────────────────

def login_internal_user(email: str, password: str):
    """
    Verify credentials against internal_users table.
    Returns (user_dict, token) on success, raises ValueError on failure.
    Enforces: is_active check, bcrypt verify, last_login_at update.
    """
    sb = get_supabase()

    result = (
        sb.table('internal_users')
        .select('id, email, password_hash, full_name, role, is_active, last_login_at, created_at')
        .eq('email', email.strip().lower())
        .limit(1)
        .execute()
    )

    if not result.data:
        raise ValueError('Invalid credentials')

    user = result.data[0]

    if not user.get('is_active'):
        raise ValueError('Account is deactivated. Contact your administrator.')

    stored_hash = user['password_hash'].encode('utf-8')
    if not bcrypt.checkpw(password.encode('utf-8'), stored_hash):
        raise ValueError('Invalid credentials')

    # Update last_login_at — best-effort, never block login on failure
    try:
        sb.table('internal_users').update(
            {'last_login_at': datetime.now(timezone.utc).isoformat()}
        ).eq('id', user['id']).execute()
    except Exception as e:
        logger.warning(f'Failed to update last_login_at for {email}: {e}')

    token = _mint_token(user)
    return _safe_user(user), token


# ─── Auth decorator ───────────────────────────────────────────────────────────

def require_support_auth(f):
    """
    Decorator for all /v1/support/* routes (except /login).

    Reads Bearer token from Authorization header.
    Sets g.support_user = { id, email, role } for the request lifecycle.
    Returns 401 on any failure — never leaks JWT internals to the client.
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

        g.support_user = {
            'id':    payload['sub'],
            'email': payload['email'],
            'role':  payload['role'],
        }
        return f(*args, **kwargs)

    return decorated


def require_super_admin(f):
    """
    Layered on top of require_support_auth for destructive operations.
    Must be applied AFTER require_support_auth in the decorator stack.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if not hasattr(g, 'support_user') or g.support_user.get('role') != 'super_admin':
            return jsonify({'success': False, 'error': 'Super admin access required'}), 403
        return f(*args, **kwargs)
    return decorated


def require_capability(capability: str):
    """Gate a support route on a named capability.

    Composes require_support_auth so there is exactly one place that decodes
    this JWT (same pattern as require_client_dashboard_admin on the client
    side). The role is read from g.support_user, which require_support_auth
    populates from the verified token — never from a request parameter.

    Returns 403 with code=CAPABILITY_DENIED so the frontend can distinguish
    "your role can't do this" from "your session is invalid" (401) and from
    "your organization is inactive" (ORG_ACCESS_BLOCKED).
    """
    def decorator(f):
        @require_support_auth
        @wraps(f)
        def decorated(*args, **kwargs):
            from support_role_capabilities import role_has
            role = (g.support_user or {}).get('role')
            if not role_has(role, capability):
                return jsonify({
                    'success': False,
                    'error': f'Your role ({role}) does not permit this action.',
                    'code': 'CAPABILITY_DENIED',
                    'required_capability': capability,
                }), 403
            return f(*args, **kwargs)
        return decorated
    return decorator