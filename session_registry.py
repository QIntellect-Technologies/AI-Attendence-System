"""
session_registry.py
────────────────────────────────────────────────────────────────────────────
Shared single source of truth for concurrent-session enforcement across
every JWT auth surface in this codebase:

    account_type            Minted/validated by
    ──────────────────────  ─────────────────────────────────────────
    'internal_user'         support_auth.py           (Support Dashboard)
    'client_user'           client_dashboard_auth.py  (desktop, admin/HR)
    'client_staff'          client_dashboard_auth.py  (desktop, manager)
    'client_staff_mobile'   client_staff_auth.py      (mobile field portal)

Audit finding this closes: "No Session Invalidation — Unlimited Concurrent
Sessions" (Medium). Every JWT module above was otherwise fully stateless —
a validly signed, unexpired token was accepted forever, from as many
devices as someone logged in from, with no server-side way to end it early
(logout only cleared localStorage; the token itself stayed live until
natural expiry — 8h/12h/30d depending on surface).

Mechanism
---------
One row per (account_type, user_id) in `active_sessions` holds the single
session_id currently considered valid for that account. rotate_session()
overwrites that row with a fresh UUID at mint time and the caller embeds it
in the JWT as the 'sid' claim. validate_session() re-checks the token's
'sid' against that row on every authenticated request — a token whose
'sid' no longer matches is dead even though its signature/exp are fine.

This deliberately gives ONE valid session per account, not a per-device
session list with individual revocation — a full "view/revoke any active
session" UI was scoped and rejected as disproportionate for a Medium
finding whose reported behavior is "unlimited concurrent sessions with no
invalidation" (see the accompanying design discussion). If that changes,
this table's (account_type, user_id) primary key becomes the thing to widen
to a real session id, not a redesign of the call sites below.

'client_staff' and 'client_staff_mobile' are deliberately different
account_types even though they can both belong to the same underlying
client_staff row: a manager who is also a field worker must be able to stay
logged into the mobile app while their desktop dashboard session gets
superseded by a new desktop login, and vice versa. See
client_staff_auth.py's _mint_token docstring and end_all_client_staff_sessions()
below for the one place that deliberately kills both together.

Two distinct "you're logged out" reasons reach the client, because they
need different copy:
    SESSION_SUPERSEDED — someone (possibly you) logged in elsewhere, or you
                          logged out, or the row predates this rollout.
    PASSWORD_CHANGED   — your password was changed (by you or an admin);
                          your token is dead even though no one "logged in
                          elsewhere" in the ordinary sense.

Perf
----
Same shape as support_db_core.py's _compute_org_status: a short in-process
TTL cache in front of the Supabase read, safe ONLY because the Dockerfile
runs a single gunicorn worker (`--workers 1 --threads 4` — see the comment
in login_throttle.py for the same load-bearing assumption; a plain
in-memory dict would silently under-enforce with >1 worker). 5s here, not
_compute_org_status's 60s, because this is a security check, not a billing
check — a revoked session should stop working within single digits of
seconds, not up to a minute.

Deliberately does NOT import support_db_core, even though the caching
pattern mirrors it: support_db_core is intentionally not imported at
module top by client_dashboard_auth.py because it pulls in the full
Supabase/config chain before app.py is ready for it (see that module's
_org_access_blocked_response comment). session_registry is imported at
module top by all three auth modules, so importing support_db_core here
would reintroduce exactly the circular-import problem that comment warns
about. The ~15 lines of cache/retry logic below are duplicated on purpose
to avoid that coupling — if support_db_core's retry helper changes, this
module has no reason to change in lockstep with it anyway, since it talks
to a different table for a different purpose.

Fail-open posture: validate_session() fails OPEN on a transient Supabase
read error (a lookup blip must not lock every legitimate session out,
same posture as _compute_org_status). rotate_session/end_session/
invalidate_session are writes on the login/logout/admin-action path and
fail CLOSED (raise) — a login must never silently issue a token whose
session can never be validated, and a password-reset's session kill must
never silently no-op.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone
from typing import Optional

from supabase_client import get_supabase, reset_supabase_client
from logger_config import get_logger

logger = get_logger(__name__)

_TABLE = 'active_sessions'

SESSION_SUPERSEDED = 'SESSION_SUPERSEDED'
PASSWORD_CHANGED = 'PASSWORD_CHANGED'

_CACHE_TTL_SECONDS = 5.0
# key -> (expires_at_monotonic, session_id_or_None, reason_or_None)
_CACHE: dict[str, tuple[float, Optional[str], Optional[str]]] = {}


def _key(account_type: str, user_id: str) -> str:
    return f'{account_type}:{user_id}'


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cache_get(key: str):
    item = _CACHE.get(key)
    if not item:
        return None
    expires_at, session_id, reason = item
    if expires_at <= time.monotonic():
        _CACHE.pop(key, None)
        return None
    return session_id, reason


def _cache_set(key: str, session_id: Optional[str], reason: Optional[str]) -> None:
    _CACHE[key] = (time.monotonic() + _CACHE_TTL_SECONDS, session_id, reason)


def _cache_invalidate(key: str) -> None:
    _CACHE.pop(key, None)


def _supabase_call(label: str, factory, *, attempts: int = 2):
    """One-reconnect-retry wrapper, minimal counterpart to
    support_db_core._execute_supabase (see module docstring for why this
    isn't a direct import). factory must build a fresh query each call --
    a poisoned HTTP/2 connection can't be safely reused across a retry.
    """
    last_exc: Exception | None = None
    for attempt in range(max(1, attempts)):
        try:
            return factory().execute()
        except Exception as exc:
            last_exc = exc
            if attempt >= attempts - 1:
                raise
            logger.warning('Supabase request failed during %s, retrying: %s', label, exc)
            reset_supabase_client()
            time.sleep(0.12 * (attempt + 1))
    raise last_exc  # pragma: no cover — unreachable, satisfies type checkers


def _upsert_row(account_type: str, user_id: str, *, session_id: Optional[str], reason: str) -> None:
    row = {
        'account_type': account_type,
        'user_id': str(user_id),
        'session_id': session_id,
        'reason': reason,
        'updated_at': _now_iso(),
    }
    _supabase_call(
        'session_registry_upsert',
        lambda: get_supabase().table(_TABLE).upsert(row, on_conflict='account_type,user_id'),
    )


def _select_row(account_type: str, user_id: str) -> Optional[dict]:
    result = _supabase_call(
        'session_registry_select',
        lambda: (
            get_supabase()
            .table(_TABLE)
            .select('session_id, reason')
            .eq('account_type', account_type)
            .eq('user_id', str(user_id))
            .limit(1)
        ),
    )
    return result.data[0] if result.data else None


# ─── Public API ─────────────────────────────────────────────────────────────

def rotate_session(account_type: str, user_id: str, *, reason: str = 'login') -> str:
    """Mint a fresh session_id for (account_type, user_id) and persist it as
    the CURRENT valid session, superseding whatever was there before.

    Called by every mint-token function at login, and by any self-service
    flow (e.g. a caller changing their own password) that needs its own
    freshly-returned token to keep working — pass reason='password_changed'
    in that case so the row's audit trail is accurate, even though the
    caller's own new sid is what makes their new token valid, not the
    reason string (validate_session only reads `reason` off a row when
    session_id is None; see invalidate_session).

    Raises on a persistent Supabase failure: a login must never silently
    hand out a token whose session can never be validated.
    """
    session_id = str(uuid.uuid4())
    _upsert_row(account_type, user_id, session_id=session_id, reason=reason)
    _cache_set(_key(account_type, user_id), session_id, None)
    return session_id


def validate_session(account_type: str, user_id: str, sid: str) -> tuple[bool, Optional[str]]:
    """True if `sid` is still the current session for (account_type, user_id).

    Checked on every authenticated request. Returns (ok, reason) — reason is
    None when ok, else PASSWORD_CHANGED or SESSION_SUPERSEDED (the caller's
    decorator maps these to distinct user-facing 401 copy).

    Fails OPEN (returns True, None) on a transient Supabase read error —
    see module docstring.
    """
    if not sid:
        # No 'sid' claim at all: token predates this rollout. Treated as
        # superseded, not silently trusted, per the agreed forced-relogin
        # rollout trade-off.
        return False, SESSION_SUPERSEDED

    key = _key(account_type, user_id)
    cached = _cache_get(key)
    if cached is not None:
        current_sid, reason = cached
        return (current_sid == sid), (None if current_sid == sid else (reason or SESSION_SUPERSEDED))

    try:
        row = _select_row(account_type, user_id)
    except Exception:
        logger.exception('Session lookup failed for %s; failing open', key)
        return True, None

    if row is None:
        # No row ever written for this account: never logged in under this
        # scheme. Same treatment as a missing 'sid' claim above.
        _cache_set(key, None, SESSION_SUPERSEDED)
        return False, SESSION_SUPERSEDED

    current_sid = row.get('session_id')
    reason = PASSWORD_CHANGED if row.get('reason') == 'password_changed' else SESSION_SUPERSEDED
    _cache_set(key, current_sid, reason)
    return (current_sid == sid), (None if current_sid == sid else reason)


def end_session(account_type: str, user_id: str) -> None:
    """Explicit self-service logout: the CURRENT holder of this session is
    deliberately ending it. Row is kept (session_id=None, reason='logged_out')
    rather than deleted, so validate_session has a definite negative to
    read instead of racing a delete against a concurrent request.
    """
    _upsert_row(account_type, user_id, session_id=None, reason='logged_out')
    _cache_invalidate(_key(account_type, user_id))


def invalidate_session(account_type: str, user_id: str, *, reason: str = 'password_changed') -> None:
    """Admin/system-driven kill of whatever session is currently active for
    this account — used after a password reset/change so an
    already-authenticated attacker's token dies immediately instead of
    staying valid until natural expiry. Distinct from end_session only in
    who's acting and in the reason recorded, which is what lets
    validate_session report PASSWORD_CHANGED instead of the generic
    "logged in elsewhere" message.
    """
    _upsert_row(account_type, user_id, session_id=None, reason=reason)
    _cache_invalidate(_key(account_type, user_id))


def end_all_client_staff_sessions(staff_id: str, *, reason: str = 'password_changed') -> None:
    """A client_staff row can hold a desktop dashboard session
    ('client_staff') and a mobile portal session ('client_staff_mobile')
    at once (see module docstring). A password reset/change for that
    person must kill both, not just whichever surface triggered it —
    otherwise a stolen mobile token (30-day TTL) survives a desktop-side
    password reset undisturbed, or vice versa.
    """
    invalidate_session('client_staff', staff_id, reason=reason)
    invalidate_session('client_staff_mobile', staff_id, reason=reason)
