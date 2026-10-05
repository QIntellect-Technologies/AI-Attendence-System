"""Brute-force throttling for the three login endpoints.

Covers /api/login (dashboard), /api/staff/login (mobile portal) and
/v1/support/auth/login (internal support). Before this, none of the three
had any attempt limiting at all — the audit flagged /api/login as "secure
against unauthorized access, but vulnerable to password guessing", and the
other two are the same code shape.

WHY IN-PROCESS AND NOT flask-limiter/redis
------------------------------------------
The Dockerfile runs `gunicorn --workers 1 --threads 4`, deliberately (one
worker keeps the face-model warm-up cache in a single process — see the
comment in the Dockerfile). One worker means one process, which means a
plain in-memory dict IS the whole picture: there is no second worker whose
counters would disagree. A lock makes it safe across the 4 threads.

This assumption is load-bearing. If --workers is ever raised above 1, an
attacker gets N times the budget, because each worker keeps its own
counters. If that day comes, swap _ATTEMPTS for Redis (or add
flask-limiter with a Redis backend) — the call sites below don't change,
only this module's storage does. There is a startup assertion for exactly
this in app.py.

DESIGN
------
Two independent counters per attempt, and either can trip:

  * per-IP     — stops one host spraying many accounts
  * per-identifier — stops a distributed/rotating-IP attack on one account

Sliding window: failures older than WINDOW_SECONDS fall out, so a user who
mistypes their password twice a week is never affected. On the Nth failure
the key is locked for LOCKOUT_SECONDS and the caller gets 429 with a
Retry-After header. A successful login clears that identity's counters
immediately, so a legitimate user who remembers their password on attempt
4 of 8 is back to a clean slate.

The identifier counter is keyed on a SHA-256 of the lowercased identifier,
not the raw value — these counters live in memory that ends up in tracebacks
and heap dumps, and there is no reason for a plaintext list of who has been
failing to log in to be sitting in there.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from typing import Iterable

from flask import jsonify, request

# ─── Tunables (env-overridable) ───────────────────────────────────────────────
# Defaults: 3 failures in 15 minutes → locked out for 15 minutes. That is
# ~32 guesses/hour against one account sustained, versus the thousands/second
# an unthrottled endpoint allows, while still leaving room for a human who
# genuinely can't remember which of their two passwords it was.
MAX_FAILURES = int(os.environ.get('LOGIN_MAX_FAILURES', '3'))
WINDOW_SECONDS = int(os.environ.get('LOGIN_FAILURE_WINDOW_SECONDS', '30'))
LOCKOUT_SECONDS = int(os.environ.get('LOGIN_LOCKOUT_SECONDS', '10'))

_LOCK = threading.Lock()
# key -> {'failures': [timestamp, ...], 'locked_until': float}
_ATTEMPTS: dict[str, dict] = {}
_last_gc = 0.0
_GC_INTERVAL_SECONDS = 300


def _now() -> float:
    return time.monotonic()


def _hash_identifier(identifier: str) -> str:
    return hashlib.sha256(str(identifier or '').strip().lower().encode('utf-8')).hexdigest()[:32]


def client_ip() -> str:
    """Best-effort client IP.

    Railway/most PaaS front the app with a proxy, so remote_addr is the
    proxy. X-Forwarded-For's LEFTMOST entry is the original client, but it
    is also fully attacker-controlled — anyone can send a random one and get
    a fresh bucket. That is why the per-identifier counter exists and is not
    optional: IP-keyed throttling alone is defeatable by header spoofing,
    identifier-keyed throttling is not.

    If you put this behind a proxy you control, set TRUSTED_PROXY_COUNT and
    prefer werkzeug's ProxyFix so remote_addr becomes trustworthy.
    """
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        first = forwarded.split(',')[0].strip()
        if first:
            return first
    return request.remote_addr or 'unknown'


def _gc_locked() -> None:
    """Drop keys with no recent activity. Caller must hold _LOCK."""
    global _last_gc
    now = _now()
    if now - _last_gc < _GC_INTERVAL_SECONDS:
        return
    _last_gc = now
    cutoff = now - max(WINDOW_SECONDS, LOCKOUT_SECONDS)
    for key in [
        k for k, v in _ATTEMPTS.items()
        if not v['failures'] and v.get('locked_until', 0) < now
        or (v['failures'] and v['failures'][-1] < cutoff and v.get('locked_until', 0) < now)
    ]:
        _ATTEMPTS.pop(key, None)


def _keys_for(identifier: str) -> list[str]:
    return [f'ip:{client_ip()}', f'id:{_hash_identifier(identifier)}']


def retry_after_seconds(identifier: str) -> int:
    """Seconds until the caller may try again, or 0 if not locked out."""
    now = _now()
    with _LOCK:
        worst = 0.0
        for key in _keys_for(identifier):
            entry = _ATTEMPTS.get(key)
            if entry:
                worst = max(worst, entry.get('locked_until', 0) - now)
    return int(worst) + 1 if worst > 0 else 0


def is_locked_out(identifier: str) -> bool:
    return retry_after_seconds(identifier) > 0


def register_failure(identifier: str) -> None:
    """Record one failed attempt against both the IP and the identifier."""
    now = _now()
    cutoff = now - WINDOW_SECONDS
    with _LOCK:
        for key in _keys_for(identifier):
            entry = _ATTEMPTS.setdefault(key, {'failures': [], 'locked_until': 0.0})
            entry['failures'] = [t for t in entry['failures'] if t > cutoff]
            entry['failures'].append(now)
            if len(entry['failures']) >= MAX_FAILURES:
                entry['locked_until'] = now + LOCKOUT_SECONDS
                # Reset the window so the lockout is a clean N-more-tries
                # budget when it expires, not an instant re-lock on the
                # first subsequent typo.
                entry['failures'] = []
        _gc_locked()


def register_success(identifier: str) -> None:
    """Clear counters after a genuine login."""
    with _LOCK:
        for key in _keys_for(identifier):
            _ATTEMPTS.pop(key, None)


def lockout_response(identifier: str):
    """The 429 to return when locked out.

    Deliberately says nothing about whether the account exists, or whether
    it was the IP or the identifier that tripped — that would turn the
    throttle itself into a user-enumeration oracle.
    """
    retry_after = retry_after_seconds(identifier)
    response = jsonify({
        'success': False,
        'message': 'Too many failed login attempts. Please try again later.',
        'error': 'Too many failed login attempts. Please try again later.',
        'retry_after_seconds': retry_after,
    })
    response.status_code = 429
    response.headers['Retry-After'] = str(retry_after)
    return response


def reset_all() -> None:
    """Test helper — wipe all counters."""
    with _LOCK:
        _ATTEMPTS.clear()
