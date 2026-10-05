"""
stream_token.py
──────────────────────────────────────────────────────────────────────────────
Short-lived, single-purpose token for GET /api/stream/<camera_id>.

Why this exists (and isn't just @require_client_dashboard_auth):
An <img src="/api/stream/<camera_id>"> tag opens the MJPEG connection as a
plain browser navigation — it cannot attach an Authorization: Bearer header.
Every other Client Dashboard route enforces tenancy via
client_dashboard_auth.py's JWT; this is the one route that structurally
can't. Rather than trust organization_id off the query string again (the
original bug — any request could open ANY org's camera feed just by naming
a different id), the caller mints a token through an authenticated call
(POST /api/stream/token, wearing @require_client_dashboard_auth like every
other route) and hands the *token* to the <img> tag instead of a Bearer
header. The token is the only thing this route trusts for org_id/camera_id.

Own dedicated secret (STREAM_TOKEN_SECRET), matching client_dashboard_auth's
documented convention: "Three separate secrets on purpose — a leaked token
from one surface must never be replayable against another." A leaked
stream_token — e.g. sitting in browser history, a proxy log, or a shared
screenshot of a camera tile's network request — must never be replayable as
a dashboard session token, and vice versa.

Deliberately NOT a general-purpose JWT like client_dashboard_auth's:
  - ~60s TTL. This only needs to survive the moment between the frontend's
    token fetch and the browser opening the MJPEG connection; the
    connection itself, once open, keeps streaming past token expiry (the
    token only gates *opening* the stream, not the ongoing frames). A long
    TTL here would turn every camera tile's page source into a
    long-lived, unauthenticated bearer credential for that camera.
  - Payload is exactly {camera_id, org_id} — nothing else. No user
    identity, no role, no other claim. There is nothing in this token
    worth stealing beyond "can open this one camera's feed for under a
    minute," by design.
  - No refresh/rotation endpoint of its own — the frontend just calls
    POST /api/stream/token again (a normal authenticated request) to mint
    a fresh one periodically.

Verification is intentionally "dumb": verify_stream_token only checks the
signature, expiry, and that the token's camera_id matches the one in the
URL path. It does NOT re-check that the camera belongs to the org in the
token — that check happened once, at mint time, in
api_mint_stream_token (app.py), which is the one and only place a
caller-supplied camera_id is cross-referenced against the caller's own
org before anything is signed. By the time a token exists, org_id is
already a verified fact about it, not a claim to re-litigate on every
frame request.
"""

import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

from logger_config import get_logger

logger = get_logger(__name__)

_JWT_SECRET = None
_JWT_ALGORITHM = 'HS256'

# Deliberately short — see module docstring. This is a "can you open the
# connection right now" credential, not a session.
_TOKEN_TTL_SECONDS = 60


def _get_jwt_secret() -> str:
    global _JWT_SECRET
    if _JWT_SECRET is None:
        secret = os.environ.get('STREAM_TOKEN_SECRET', '').strip()
        if not secret or len(secret) < 32:
            raise RuntimeError(
                'STREAM_TOKEN_SECRET must be set in env and be at least 32 '
                'characters, and must NOT equal CLIENT_DASHBOARD_JWT_SECRET, '
                'CLIENT_STAFF_JWT_SECRET, or SUPPORT_JWT_SECRET. Generate one '
                'with: python -c "import secrets; print(secrets.token_hex(32))"'
            )
        _JWT_SECRET = secret
    return _JWT_SECRET


def mint_stream_token(org_id, camera_id) -> str:
    """Sign a ~60s token scoped to exactly this (org_id, camera_id) pair.

    Callers must have ALREADY verified camera_id belongs to org_id before
    calling this — this function performs no lookup of its own and trusts
    both arguments completely. See api_mint_stream_token in app.py, the
    only caller, for that check.
    """
    now = datetime.now(timezone.utc)
    payload = {
        'org_id': str(org_id),
        'camera_id': str(camera_id),
        'iat': now,
        'exp': now + timedelta(seconds=_TOKEN_TTL_SECONDS),
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm=_JWT_ALGORITHM)


def verify_stream_token(token: str, camera_id: str) -> Optional[dict]:
    """Returns the decoded payload if `token` is a valid, unexpired
    stream_token minted for exactly this camera_id, else None.

    Never raises — every failure mode (missing token, bad signature,
    expired, wrong camera_id) collapses to None so the route can respond
    with a single generic 401 rather than leaking which check failed.
    """
    if not token:
        return None

    try:
        payload = jwt.decode(token, _get_jwt_secret(), algorithms=[_JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        return None
    except jwt.PyJWTError:
        logger.warning('Rejected stream_token with invalid signature/format')
        return None

    # The path's camera_id must match the token's exactly — a token minted
    # for camera A can never be replayed against camera B's URL, even
    # within the same org and even though both checks ultimately gate on
    # the same secret.
    if str(payload.get('camera_id') or '') != str(camera_id or ''):
        return None

    return payload
