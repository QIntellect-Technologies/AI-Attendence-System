"""
face_challenge_token.py
──────────────────────────────────────────────────────────────────────────────
Short-lived, single-use, staff-scoped tokens carrying a liveness challenge
that the SERVER chose.

Why the challenge needs a token at all
───────────────────────────────────────
liveness.py's entire replay defence rests on the client not knowing which
head movement will be demanded until the moment it is demanded. If
/verify-face simply accepted a `challenge` field in the request body, the
client would be naming its own challenge, and an attacker holding a
single pre-recorded clip of the target turning right would just declare
"the challenge was turn_right" on every attempt. The randomisation would
be decorative.

So the challenge is minted here, signed, handed out by
/api/field/liveness-challenge, and presented back at /verify-face. The
server reads the challenge out of its own signature rather than out of
the request body. A client can choose *when* to ask for a challenge; it
cannot choose *which* one it gets, and it cannot edit one it has been
given without invalidating the signature.

Single-use matters for the same reason. Without it, an attacker could
request challenges in a loop, discard every one that did not match the
clip they have, and replay that clip against a matching token. Burning
the jti on first presentation means one challenge authorises one
verification attempt, so the attacker's expected cost scales with the
number of directions rather than collapsing to "keep asking until lucky".

Design (mirrors stream_token.py's conventions deliberately)
────────────────────────────────────────────────────────────
  - Own dedicated secret, FACE_CHALLENGE_SECRET, following
    client_dashboard_auth.py's documented rule: "Three separate secrets
    on purpose -- a leaked token from one surface must never be
    replayable against another." A stolen staff session token must not
    be forgeable into a challenge token, and vice versa.

  - 120s TTL. Long enough to read the prompt, position the phone, and
    record a ~3s burst on a slow device; short enough that a token
    captured off the wire is stale before anyone can build a clip to
    answer it. It is deliberately NOT long enough to collect a stock of
    challenges in advance.

  - Bound to (org_id, staff_id) from the verified JWT, never the body.
    A challenge issued to staff A is rejected when presented on staff
    B's verification, so two colleagues cannot cooperate by having one
    of them fetch challenges for the other.

Multi-worker caveat (read before scaling out)
──────────────────────────────────────────────
_CONSUMED is per-process. Under multiple gunicorn workers or replicas a
token could be spent once per worker inside its 120s life. Signature,
expiry and staff binding all still hold, so the residual exposure is "a
genuinely-issued challenge for THIS staff member could be answered a
couple of extra times in a two-minute window" -- not the "client picks
its own challenge" hole this module exists to close. To harden fully,
back _CONSUMED with the same Supabase/Redis the rest of the deployment
uses; consume_challenge_token is the single chokepoint to change, and is
written so that swap is a one-function edit.
"""
from __future__ import annotations

import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt

from logger_config import get_logger

logger = get_logger(__name__)

_JWT_SECRET: Optional[str] = None
_JWT_ALGORITHM = "HS256"

# Read prompt -> position phone -> record ~3s burst -> upload, on a slow
# device and a bad field connection. See module docstring for why this is
# two minutes and not an hour.
_TOKEN_TTL_SECONDS = 120

# jti -> expiry. Bounded by the TTL: entries are swept on every write, so
# this cannot outgrow the number of challenges issued in a 120s window.
_CONSUMED: dict[str, datetime] = {}
_CONSUMED_LOCK = threading.Lock()


def _get_jwt_secret() -> str:
    global _JWT_SECRET
    if _JWT_SECRET is None:
        secret = os.environ.get("FACE_CHALLENGE_SECRET", "").strip()
        if not secret or len(secret) < 32:
            raise RuntimeError(
                "FACE_CHALLENGE_SECRET must be set in env and be at least 32 "
                "characters, and must NOT equal CLIENT_STAFF_JWT_SECRET, "
                "CLIENT_DASHBOARD_JWT_SECRET, STREAM_TOKEN_SECRET or "
                "SUPPORT_JWT_SECRET. Generate one with: "
                'python -c "import secrets; print(secrets.token_hex(32))"'
            )
        _JWT_SECRET = secret
    return _JWT_SECRET


def mint_challenge_token(org_id, staff_id, challenge: str) -> tuple[str, datetime]:
    """Sign a ~120s single-use token naming the challenge this staff
    member must perform. Returns (token, expires_at).

    `challenge` must come from liveness.new_challenge() -- the point of
    this module is that the value is chosen server-side, so never pass
    through anything that originated in a request body.
    """
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=_TOKEN_TTL_SECONDS)
    payload = {
        "org_id": str(org_id),
        "staff_id": str(staff_id),
        "challenge": str(challenge),
        "jti": uuid.uuid4().hex,
        "iat": now,
        "exp": expires_at,
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm=_JWT_ALGORITHM), expires_at


def _sweep_consumed(now: datetime) -> None:
    """Drop already-expired jtis. Called under _CONSUMED_LOCK. An expired
    token is rejected by jwt.decode anyway, so remembering it buys
    nothing -- this only stops the dict growing without bound."""
    for jti in [j for j, exp in _CONSUMED.items() if exp <= now]:
        _CONSUMED.pop(jti, None)


def consume_challenge_token(token: Optional[str], org_id, staff_id) -> Optional[dict]:
    """Spend a challenge token on behalf of (org_id, staff_id).

    Returns the decoded payload (whose "challenge" field is the
    authoritative one) or None if the token is missing, malformed,
    expired, signed by anything else, issued to a different staff member
    or org, or already spent.

    Never raises, and never tells the caller which of those it was: a
    client learning precisely why its forgery failed is a client being
    told how to forge better. Callers surface one generic "start again"
    message and log the detail server-side.

    org_id/staff_id must come from the verified JWT at the call site
    (g.client_staff), never the request body -- passing body-supplied
    identifiers here would reintroduce exactly the trust problem this
    module exists to remove.
    """
    if not token or not isinstance(token, str):
        return None

    try:
        payload = jwt.decode(token, _get_jwt_secret(), algorithms=[_JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        logger.info("Rejected expired liveness challenge for staff=%s", staff_id)
        return None
    except jwt.PyJWTError:
        logger.warning("Rejected malformed/unsigned liveness challenge for staff=%s", staff_id)
        return None

    if str(payload.get("staff_id") or "") != str(staff_id or ""):
        logger.warning(
            "Rejected liveness challenge issued to staff=%s but presented on staff=%s",
            payload.get("staff_id"), staff_id,
        )
        return None
    if str(payload.get("org_id") or "") != str(org_id or ""):
        logger.warning("Rejected cross-org liveness challenge for staff=%s", staff_id)
        return None

    jti = payload.get("jti")
    if not jti:
        return None

    now = datetime.now(timezone.utc)
    with _CONSUMED_LOCK:
        _sweep_consumed(now)
        if jti in _CONSUMED:
            logger.warning("Rejected replayed liveness challenge for staff=%s", staff_id)
            return None
        exp = payload.get("exp")
        _CONSUMED[jti] = (
            datetime.fromtimestamp(exp, tz=timezone.utc)
            if isinstance(exp, (int, float))
            else now + timedelta(seconds=_TOKEN_TTL_SECONDS)
        )

    return payload
