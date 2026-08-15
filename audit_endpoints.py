#!/usr/bin/env python3
"""
audit_endpoints.py — re-run the original vulnerability report against a
LIVE server and check every finding is actually closed.

This is the counterpart to test_security_fixes.py, and it answers a
different question. The unit tests read app.py and prove the source is
correct. This sends real unauthenticated HTTP at a running instance and
proves the DEPLOYED server behaves correctly — which can differ, because
of a stale build, a proxy in front, a blueprint registered twice, an old
container still serving traffic, or an env var that didn't take.

Run it against staging first, then production.

    python audit_endpoints.py https://your-app.up.railway.app

Every request is sent with NO credentials, exactly as the original audit
did. A finding passes when the server refuses: 401 (must log in), 403
(logged in but not allowed), 405 (wrong method), or 410 (endpoint retired).
A finding FAILS on 200 — that means the data came back to an anonymous
caller.

400 is also reported as a failure, deliberately. That was the whole point
of the report's "Bad Security Order" section: a 400 means the server
parsed your payload before checking who you were, so the auth check is
sitting behind the parsing instead of in front of it.

SAFETY
------
Nothing here is destructive under normal conditions, because a fixed
server rejects each request before it reaches any handler logic. But if a
fix has regressed, the probe itself would reach the handler — so every
write probe is additionally defanged: destructive routes target
deliberately non-existent IDs (999999999), and write bodies are empty or
invalid so they fail validation even if auth is missing.

The brute-force probe is the one exception and is OPT-IN via
--test-bruteforce. It intentionally trips the login throttle, which locks
the SOURCE IP out of logging in for the lockout window (15 min by
default). Don't run it from an office IP during business hours.

Exit code 0 = all findings closed. 1 = at least one still open.
"""

from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request
from typing import Iterable

# Windows consoles and pipes default to cp1252, which cannot encode the
# severity emoji below. Printing them then raises UnicodeEncodeError and the
# script dies mid-report with a misleading non-zero exit — it looks like an
# audit failure when it is only a console encoding problem. Force UTF-8; if
# that isn't possible, fall back to ASCII labels.
ASCII_ONLY = False
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    ASCII_ONLY = True


def sev_label(severity: str) -> str:
    plain = {'CRITICAL': 'CRITICAL', 'HIGH': 'HIGH', 'MEDIUM': 'MEDIUM',
             'REGRESS': 'PREVIOUSLY SECURE'}[severity]
    if ASCII_ONLY:
        return f'[{plain}]'
    return {'CRITICAL': '🔴 CRITICAL', 'HIGH': '🟠 HIGH', 'MEDIUM': '🟡 MEDIUM',
            'REGRESS': '✅ PREVIOUSLY SECURE'}[severity]


def head(text: str, emoji: str) -> str:
    return text if ASCII_ONLY else f'{emoji} {text}'

# Codes that mean "the server correctly refused an anonymous caller".
# 404 is included: if the route does not exist, nothing is exposed. That is
# the same outcome as a refusal from an attacker's point of view. It shows
# up as a distinct note rather than a plain PASS, because "route is gone"
# and "route is guarded" are different facts and you should be able to tell
# them apart when reading the report.
REFUSED = {401, 403, 404, 405, 410}

# ─── The findings, transcribed from the original report ───────────────────────
# (severity, method, path, description, expected_note)
CHECKS: list[tuple[str, str, str, str]] = [
    # 🔴 CRITICAL
    ('CRITICAL', 'GET',  '/api/users',                       'Full employee list dump'),
    ('CRITICAL', 'GET',  '/api/users/1',                     'Any employee private profile'),
    ('CRITICAL', 'GET',  '/api/salary',                      'All salaries (+ source leak via 500)'),
    ('CRITICAL', 'GET',  '/api/salary/1',                    'One employee salary'),
    ('CRITICAL', 'POST', '/api/users/999999999/delete',      'Delete any employee/admin account'),
    ('CRITICAL', 'POST', '/api/change-password',             'Reset any user password'),
    ('CRITICAL', 'POST', '/api/staff/999999999/restore',     'Restore deleted accounts'),
    ('CRITICAL', 'POST', '/api/attendance/mark-absent',      'Forge attendance records'),
    ('CRITICAL', 'GET',  '/api/attendance/today',            'Who is at work right now'),
    ('CRITICAL', 'POST', '/api/recognize/frame',             'Unauth face matching / CPU DoS'),
    ('CRITICAL', 'POST', '/api/enroll/upload-video',         'Unauth file upload'),
    ('CRITICAL', 'GET',  '/api/live-detections',             'Live AI camera feed'),

    # 🟠 HIGH
    ('HIGH',     'GET',  '/api/staff/archived',              'Past employee records'),
    ('HIGH',     'GET',  '/api/legal/privacy-policy',        'Read legal documents'),
    ('HIGH',     'POST', '/api/legal/privacy-policy',        'Rewrite legal documents'),
    ('HIGH',     'GET',  '/get_staff_list',                  'Legacy staff dump'),
    ('HIGH',     'GET',  '/get_attendance_today',            'Legacy attendance'),
    ('HIGH',     'GET',  '/get_detected_name/all',           'Legacy recognition log'),
    ('HIGH',     'GET',  '/get_pending_leaves',              'Legacy leave requests'),
    ('HIGH',     'POST', '/update_leave_status',             'Legacy approve/reject leave'),

    # 🟡 MEDIUM (auth was running after payload parsing)
    ('MEDIUM',   'POST', '/api/payroll/mark-paid',           'Mark payroll paid'),
    ('MEDIUM',   'POST', '/api/payroll/mark-pending',        'Mark payroll pending (unreported sibling)'),
    ('MEDIUM',   'POST', '/api/recognize/rtsp',              'Open arbitrary RTSP camera'),
    ('MEDIUM',   'POST', '/api/dashboard/embeddings/import', 'Import face embeddings'),
    ('MEDIUM',   'GET',  '/api/stream/local-camera-1',       'Camera MJPEG stream'),
    ('MEDIUM',   'GET',  '/video_feed/local-camera-1',       'Camera stream (legacy alias)'),
    ('MEDIUM',   'GET',  '/api/cctv/live-tracking',          'CCTV live tracking'),
    ('MEDIUM',   'POST', '/api/overtime',                    'File overtime'),
    ('MEDIUM',   'PUT',  '/api/overtime/999999999',          'Approve overtime (unreported sibling)'),
    ('MEDIUM',   'GET',  '/api/notifications',               'Read notifications'),
    ('MEDIUM',   'GET',  '/api/org/retention-policy',        'Read data-wipe rules'),
    ('MEDIUM',   'PUT',  '/api/org/retention-policy',        'Rewrite data-wipe rules'),

    # ✅ Previously secure — regression guard. These were already fine; the
    # point is to prove the fixes didn't loosen anything that was working.
    ('REGRESS',  'GET',  '/api/attendance',                  'Was 401'),
    ('REGRESS',  'GET',  '/api/leaves',                      'Was 401'),
    # The report listed "GET /api/leaves/1", but app.py exposes only PUT and
    # DELETE on /api/leaves/<id> — a GET there is a 404 that proves nothing.
    # Probe the mutating routes that actually exist instead, since those are
    # the ones worth confirming are guarded.
    ('REGRESS',  'PUT',  '/api/leaves/999999999',            'Approve/reject a leave'),
    ('REGRESS',  'DELETE','/api/leaves/999999999',           'Delete a leave'),
    ('REGRESS',  'GET',  '/api/overtime',                    'Was 401'),
    ('REGRESS',  'GET',  '/api/staff',                       'Was 401'),
    ('REGRESS',  'POST', '/api/staff',                       'Was 401'),
    ('REGRESS',  'POST', '/api/staff/1/training-video',      'Was 401, now retired 410'),
    ('REGRESS',  'GET',  '/api/payroll/policy',              'Was 401'),
    ('REGRESS',  'PATCH','/api/users/1/profile',             'Was 403'),
    ('REGRESS',  'POST', '/v1/node/heartbeat',               'Was 401 (node API key)'),
]

# Routes where an anonymous 200 would be correct, so we assert the opposite.
PUBLIC_SANITY = [
    ('GET', '/api/health', 'Health check should stay public'),
]


def request(base: str, method: str, path: str, *, headers=None, body=None,
            timeout=15, insecure=False):
    """Return (status, headers, snippet). Never raises for HTTP errors."""
    url = base.rstrip('/') + path
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('User-Agent', 'security-audit/1.0')
    for k, v in (headers or {}).items():
        req.add_header(k, v)

    ctx = None
    if insecure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.status, dict(resp.headers), resp.read(300).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(300).decode('utf-8', 'replace')
    except Exception as e:
        return None, {}, f'{type(e).__name__}: {e}'


def verdict(status) -> tuple[bool, str]:
    if status is None:
        return False, 'UNREACHABLE'
    if status == 404:
        return True, 'no such route (nothing exposed)'
    if status in REFUSED:
        return True, f'refused ({status})'
    if status == 200:
        return False, 'OPEN (200) — data returned to anonymous caller'
    if status == 400:
        return False, '400 — payload parsed before the auth check'
    if status == 429:
        return True, 'rate limited (429)'
    if status >= 500:
        return False, f'{status} — server error, may leak internals'
    return False, f'unexpected {status}'


def run_endpoint_checks(base: str, insecure: bool) -> list[tuple]:
    results = []
    for severity, method, path, desc in CHECKS:
        # Bodies are deliberately empty/invalid: even if a fix regressed and
        # the handler is reached, validation fails before anything is written.
        body = '{}' if method in ('POST', 'PUT', 'PATCH') else None
        headers = {'Content-Type': 'application/json'} if body else {}
        status, _, snippet = request(base, method, path, headers=headers,
                                     body=body, insecure=insecure)
        ok, note = verdict(status)
        results.append((severity, method, path, desc, status, ok, note, snippet))
    return results


def run_cors_check(base: str, insecure: bool) -> tuple:
    """The report's 'CORS Wildcard OPTIONS /api/users'.

    Sends a preflight from an origin that must never be trusted and looks at
    what comes back. A wildcard, or an echo of the evil origin, both mean any
    website on the internet can read this API's responses in a victim browser.
    """
    evil = 'https://evil-attacker-site.example'
    status, headers, _ = request(
        base, 'OPTIONS', '/api/users',
        headers={'Origin': evil,
                 'Access-Control-Request-Method': 'GET',
                 'Access-Control-Request-Headers': 'authorization'},
        insecure=insecure)
    acao = headers.get('Access-Control-Allow-Origin')
    if acao is None:
        return True, status, f'no Access-Control-Allow-Origin returned (correct)'
    if acao == '*':
        return False, status, 'WILDCARD — Access-Control-Allow-Origin: *'
    if acao.rstrip('/') == evil.rstrip('/'):
        return False, status, f'echoes attacker origin: {acao}'
    return True, status, f'allowlisted to {acao} (evil origin not trusted)'


def run_bruteforce_check(base: str, insecure: bool, attempts: int = 12) -> tuple:
    """Hammer /api/login with a bogus account and expect a 429 to appear."""
    email = 'audit-probe-nonexistent@example.invalid'
    seen = []
    for _ in range(attempts):
        status, _, _ = request(
            base, 'POST', '/api/login',
            headers={'Content-Type': 'application/json'},
            body=json.dumps({'email': email, 'password': 'deliberately-wrong'}),
            insecure=insecure)
        seen.append(status)
        if status == 429:
            return True, status, f'throttled after {len(seen)} attempts'
    return False, seen[-1], f'no 429 in {attempts} attempts — login is unthrottled'


COLORS = {'pass': '\033[32m', 'fail': '\033[31m', 'warn': '\033[33m', 'off': '\033[0m'}


def paint(text, kind, use_color):
    return f'{COLORS[kind]}{text}{COLORS["off"]}' if use_color else text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('base_url', help='e.g. https://your-app.up.railway.app')
    ap.add_argument('--test-bruteforce', action='store_true',
                    help='also probe login throttling — WILL lock this IP out for the '
                         'lockout window (default 15 min)')
    ap.add_argument('--insecure', action='store_true', help='skip TLS verification')
    ap.add_argument('--no-color', action='store_true')
    args = ap.parse_args()

    color = not args.no_color
    base = args.base_url

    print(f'\nAuditing {base}')
    print('All requests sent WITHOUT credentials.\n')

    # Is anything actually there?
    status, _, snippet = request(base, 'GET', '/api/health', insecure=args.insecure)
    if status is None:
        print(paint(f'Cannot reach {base} — {snippet}', 'fail', color))
        print('Check the URL, and that the server is running.')
        return 1
    print(f'Reachable: /api/health returned {status}\n')

    results = run_endpoint_checks(base, args.insecure)

    width = max(len(p) for _, _, p, _ in CHECKS) + 2
    current = None
    failures = []
    for severity, method, path, desc, status, ok, note, snippet in results:
        if severity != current:
            current = severity
            print(f'\n{sev_label(severity)}')
            print('-' * 78)
        mark = paint('PASS', 'pass', color) if ok else paint('FAIL', 'fail', color)
        print(f'  {mark}  {method:<5} {path:<{width}} {note}')
        if not ok:
            failures.append((severity, method, path, desc, status, note, snippet))

    # CORS
    print('\n' + head('CORS', '🟡'))
    print('-' * 78)
    cors_ok, cors_status, cors_note = run_cors_check(base, args.insecure)
    mark = paint('PASS', 'pass', color) if cors_ok else paint('FAIL', 'fail', color)
    print(f'  {mark}  OPTS  {"/api/users":<{width}} {cors_note}')
    if not cors_ok:
        failures.append(('MEDIUM', 'OPTIONS', '/api/users', 'CORS wildcard',
                         cors_status, cors_note, ''))

    # Public sanity — a server that refuses everything isn't secure, it's down.
    print('\n' + head('SANITY (these SHOULD be reachable)', '🔵'))
    print('-' * 78)
    for method, path, desc in PUBLIC_SANITY:
        status, _, _ = request(base, method, path, insecure=args.insecure)
        ok = status == 200
        mark = paint('PASS', 'pass', color) if ok else paint('WARN', 'warn', color)
        print(f'  {mark}  {method:<5} {path:<{width}} {desc} (got {status})')

    # Brute force (opt-in)
    if args.test_bruteforce:
        print('\n' + head('BRUTE FORCE', '🟡'))
        print('-' * 78)
        bf_ok, bf_status, bf_note = run_bruteforce_check(base, args.insecure)
        mark = paint('PASS', 'pass', color) if bf_ok else paint('FAIL', 'fail', color)
        print(f'  {mark}  POST  {"/api/login":<{width}} {bf_note}')
        if not bf_ok:
            failures.append(('MEDIUM', 'POST', '/api/login', 'Brute force',
                             bf_status, bf_note, ''))
        print('  Note: this IP is now locked out of login for the lockout window.')
    else:
        print('\n' + head('BRUTE FORCE - skipped (pass --test-bruteforce to include)', '🟡'))

    # Summary
    total = len(results) + 1 + (1 if args.test_bruteforce else 0)
    print('\n' + '=' * 78)
    if not failures:
        print(paint(f'ALL {total} CHECKS PASSED — every reported finding is closed.',
                    'pass', color))
        print('=' * 78 + '\n')
        return 0

    print(paint(f'{len(failures)} of {total} CHECKS FAILED', 'fail', color))
    print('=' * 78)
    for severity, method, path, desc, status, note, snippet in failures:
        print(f'\n  [{severity}] {method} {path}  →  {status}')
        print(f'    {desc}')
        print(f'    {note}')
        if snippet:
            print(f'    response: {snippet[:160].strip()}')
    print()
    return 1


if __name__ == '__main__':
    sys.exit(main())