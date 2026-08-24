"""Regression tests for the five findings fixed in this pass.

Two layers, because neither alone is enough:

  STATIC  — app.py can't be imported in a test process (it pulls in
            insightface/cv2/numpy/supabase and warms a face model at import
            time), so route-level invariants are asserted against its AST.
            This is not a weaker test than calling the route: "does this
            function object have require_client_dashboard_admin in its
            decorator list" and "does its body read org_id from
            request.args" are exactly the two properties that were wrong,
            and the AST sees them directly.

  LIVE    — the decorators themselves, and login_throttle, are imported for
            real and exercised over HTTP through a Flask test client. These
            are the pieces that have actual runtime behaviour to get wrong.

Run: python test_security_fixes.py
"""

from __future__ import annotations

import ast
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

APP_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app.py')
with open(APP_PY, encoding='utf-8', errors='replace') as fh:
    APP_SOURCE = fh.read()
APP_TREE = ast.parse(APP_SOURCE)


# ─── AST helpers ──────────────────────────────────────────────────────────────

def _decorator_names(node: ast.FunctionDef) -> list[str]:
    names = []
    for dec in node.decorator_list:
        target = dec.func if isinstance(dec, ast.Call) else dec
        if isinstance(target, ast.Name):
            names.append(target.id)
        elif isinstance(target, ast.Attribute):
            names.append(target.attr)
    return names


def _routes(node: ast.FunctionDef) -> list[tuple[str, list[str]]]:
    """[(path, methods)] for every @app.route on this function."""
    out = []
    for dec in node.decorator_list:
        if not isinstance(dec, ast.Call):
            continue
        target = dec.func
        if not (isinstance(target, ast.Attribute) and target.attr == 'route'):
            continue
        if not dec.args or not isinstance(dec.args[0], ast.Constant):
            continue
        methods = ['GET']
        for kw in dec.keywords:
            if kw.arg == 'methods' and isinstance(kw.value, ast.List):
                methods = [e.value for e in kw.value.elts if isinstance(e, ast.Constant)]
        out.append((dec.args[0].value, methods))
    return out


ROUTE_FUNCS = [n for n in ast.walk(APP_TREE) if isinstance(n, ast.FunctionDef) and _routes(n)]


def find_route(path: str, method: str) -> ast.FunctionDef:
    for fn in ROUTE_FUNCS:
        for route_path, methods in _routes(fn):
            if route_path == path and method in methods:
                return fn
    raise AssertionError(f'No route handler found for {method} {path}')


ORG_KEYS = {'organization_id', 'organizationId', 'org_id'}


def _request_bound_locals(node: ast.FunctionDef) -> set[str]:
    """Locals in this function that hold client-controlled request data.

    Needed because almost every handler does `data = request.get_json()`
    first and then reads `data.get(...)` — so a naive check on the
    receiver name misses the real source. Conversely `dashboard_user =
    g.dashboard_user` then `dashboard_user.get('org_id')` is SAFE, and a
    naive check flags it. Resolving the assignment is what separates them.
    """
    bound = set()
    for sub in ast.walk(node):
        if not isinstance(sub, ast.Assign) or not isinstance(sub.targets[0], ast.Name):
            continue
        name = sub.targets[0].id
        src = ast.dump(sub.value)
        # BoolOp covers the ubiquitous `request.get_json() or {}`.
        if "Name(id='request'" in src and 'g.dashboard_user' not in src:
            if any(tok in src for tok in ("attr='get_json'", "attr='args'",
                                          "attr='form'", "attr='json'",
                                          "attr='values'")):
                bound.add(name)
    return bound


def reads_client_org_id(node: ast.FunctionDef) -> list[str]:
    """Client-supplied org_id reads in this function body.

    Flags request.args.get('organization_id') and data.get('org_id') where
    `data` came off the request. Does NOT flag g.dashboard_user.get('org_id')
    or a local aliased from it — that is the fix, not the bug.
    An empty list is the property we want.
    """
    client_locals = _request_bound_locals(node)
    hits = []
    for sub in ast.walk(node):
        if not (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute)):
            continue
        if sub.func.attr != 'get' or not sub.args:
            continue
        if not (isinstance(sub.args[0], ast.Constant) and sub.args[0].value in ORG_KEYS):
            continue
        root = sub.func.value
        while isinstance(root, ast.Attribute):
            root = root.value
        if isinstance(root, ast.Name) and (root.id == 'request' or root.id in client_locals):
            hits.append(f'{root.id}...get({sub.args[0].value!r})')
    return hits


# ─── Layer 1: static route invariants ─────────────────────────────────────────

class TestPayrollFixes(unittest.TestCase):
    """Finding 1: POST /api/payroll/mark-paid (+ its unreported sibling)."""

    def test_mark_paid_requires_admin(self):
        fn = find_route('/api/payroll/mark-paid', 'POST')
        self.assertIn('require_client_dashboard_admin', _decorator_names(fn))

    def test_mark_pending_requires_admin(self):
        fn = find_route('/api/payroll/mark-pending', 'POST')
        self.assertIn('require_client_dashboard_admin', _decorator_names(fn))

    def test_mark_paid_ignores_body_org_id(self):
        fn = find_route('/api/payroll/mark-paid', 'POST')
        self.assertEqual([], reads_client_org_id(fn),
                         'org_id must come from g.dashboard_user, not the request body')

    def test_mark_pending_ignores_body_org_id(self):
        fn = find_route('/api/payroll/mark-pending', 'POST')
        self.assertEqual([], reads_client_org_id(fn))


class TestOvertimeFixes(unittest.TestCase):
    """Finding 2: POST /api/overtime (+ the unreported PUT)."""

    def test_post_overtime_requires_auth(self):
        fn = find_route('/api/overtime', 'POST')
        self.assertIn('require_client_dashboard_auth', _decorator_names(fn))

    def test_put_overtime_requires_auth(self):
        fn = find_route('/api/overtime/<ot_id>', 'PUT')
        self.assertIn('require_client_dashboard_auth', _decorator_names(fn))

    def test_post_overtime_ignores_body_org_id(self):
        fn = find_route('/api/overtime', 'POST')
        self.assertEqual([], reads_client_org_id(fn))

    def test_put_overtime_ignores_body_org_id(self):
        fn = find_route('/api/overtime/<ot_id>', 'PUT')
        self.assertEqual([], reads_client_org_id(fn))

    def test_post_overtime_enforces_team_scope(self):
        """A 'team'-scoped manager must not file overtime for someone outside
        their reporting tree — the same check /api/leaves POST makes."""
        fn = find_route('/api/overtime', 'POST')
        body = ast.dump(fn)
        self.assertIn('get_team_scope_ids', body)

    def test_put_overtime_checks_ownership_before_mutating(self):
        fn = find_route('/api/overtime/<ot_id>', 'PUT')
        body = ast.dump(fn)
        self.assertIn('get_client_overtime_owned_by_org', body)
        self.assertIn('get_team_scope_ids', body)

    def test_put_overtime_legacy_path_unreachable_without_org(self):
        """The old bug: a body with no organization_id skipped the Supabase
        branch entirely and fell through to db.update_overtime_status. With
        org_id now sourced from the token, that fall-through must be guarded."""
        fn = find_route('/api/overtime/<ot_id>', 'PUT')
        self.assertIn('organization_id is required', ast.dump(fn))


class TestRetentionPolicyFixes(unittest.TestCase):
    """Finding 3: GET/PUT /api/org/retention-policy."""

    def test_get_requires_auth(self):
        fn = find_route('/api/org/retention-policy', 'GET')
        self.assertIn('require_client_dashboard_auth', _decorator_names(fn))

    def test_put_requires_admin(self):
        fn = find_route('/api/org/retention-policy', 'PUT')
        self.assertIn('require_client_dashboard_admin', _decorator_names(fn),
                      'setting the data-wipe schedule is an org-wide destructive action')

    def test_get_ignores_query_org_id(self):
        fn = find_route('/api/org/retention-policy', 'GET')
        self.assertEqual([], reads_client_org_id(fn))

    def test_put_ignores_body_org_id(self):
        fn = find_route('/api/org/retention-policy', 'PUT')
        self.assertEqual([], reads_client_org_id(fn))

    def test_put_does_not_trust_client_supplied_updated_by(self):
        """updated_by is an audit field; a caller-supplied value can be
        forged to blame someone else for the change."""
        fn = find_route('/api/org/retention-policy', 'PUT')
        for sub in ast.walk(fn):
            if (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute)
                    and sub.func.attr == 'get' and sub.args
                    and isinstance(sub.args[0], ast.Constant)
                    and sub.args[0].value == 'updated_by'):
                root = sub.func.value
                while isinstance(root, ast.Attribute):
                    root = root.value
                self.assertTrue(isinstance(root, ast.Name) and root.id == 'g',
                                'updated_by must come from the session')


class TestNoRegressionAcrossAllRoutes(unittest.TestCase):
    """Whole-file sweep: nothing else slipped back to unauthenticated."""

    #: Routes that are legitimately public.
    PUBLIC = {
        '/', '/camera', '/live-monitoring', '/<path:path>',
        '/api/health', '/api/system/health',
        '/api/login',                      # public by definition, now throttled
        '/api/stream/<camera_id>',         # guarded by minted stream token
        '/video_feed/<camera_id>',         # delegates to the above
    }

    def _is_retired(self, fn: ast.FunctionDef) -> bool:
        """Retired stubs return 410 and touch no data — safe unauthenticated."""
        for sub in ast.walk(fn):
            if isinstance(sub, ast.Constant) and sub.value == 410:
                return True
        return False

    def _is_node_api(self, paths: list[str]) -> bool:
        return all(p.startswith('/v1/') for p in paths)

    def test_no_unauthenticated_data_routes_remain(self):
        offenders = []
        for fn in ROUTE_FUNCS:
            paths = [p for p, _ in _routes(fn)]
            decs = _decorator_names(fn)
            if any(d.startswith('require_') for d in decs):
                continue
            if all(p in self.PUBLIC for p in paths):
                continue
            if self._is_retired(fn):
                continue
            if self._is_node_api(paths):
                continue  # authenticated by node API key inside the handler
            offenders.append((fn.name, paths))
        self.assertEqual([], offenders, f'Unauthenticated routes still present: {offenders}')

    def test_node_routes_check_a_credential(self):
        """Every /v1/ route presents SOME credential. /v1/activate is the
        bootstrap: it has no node key yet by definition, and trades a
        one-time install_token for one. Everything after it must use the key."""
        for fn in ROUTE_FUNCS:
            paths = [p for p, _ in _routes(fn)]
            if not paths or not self._is_node_api(paths):
                continue
            body = ast.dump(fn)
            credential = ('_node_api_key_from_request' in body) or ('install_token' in body)
            self.assertTrue(credential,
                            f'{fn.name} is under /v1/ but presents no credential')

    def test_authenticated_routes_do_not_trust_client_org_id(self):
        """The class of bug behind half the original report: a decorator was
        added but the body kept reading org_id off the wire. Allowlisted
        below are routes that read it only to compare against the token, or
        that use it as a non-tenant filter."""
        allowlist = {
            'api_client_bootstrap', 'api_get_notifications',
            'api_get_notifications_unread_count', 'api_mark_notification_read',
            'api_mark_all_notifications_read', 'api_delete_notification',
            'api_bulk_delete_notifications', 'api_add_staff',
            'api_set_staff_dashboard_scope', 'api_bulk_delete_archived_staff',
        }
        offenders = []
        for fn in ROUTE_FUNCS:
            if not any(d.startswith('require_') for d in _decorator_names(fn)):
                continue
            if fn.name in allowlist:
                continue
            if reads_client_org_id(fn):
                offenders.append(fn.name)
        self.assertEqual([], offenders, f'Routes trusting client org_id: {offenders}')


class TestCorsFix(unittest.TestCase):
    """Finding 4: CORS wildcard."""

    def test_no_bare_cors_app_call(self):
        for sub in ast.walk(APP_TREE):
            if (isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name)
                    and sub.func.id == 'CORS'):
                self.assertTrue(sub.keywords, 'CORS(app) with no resources= is a wildcard')
                self.assertIn('resources', [kw.arg for kw in sub.keywords])

    def test_default_allowlist_is_defined_and_not_wildcard(self):
        """The earlier version of this test was a string search that passed
        trivially against the old CORS(app) code — i.e. it proved nothing.
        Assert on the actual parsed value instead."""
        default = None
        for sub in ast.walk(APP_TREE):
            if (isinstance(sub, ast.Assign) and isinstance(sub.targets[0], ast.Name)
                    and sub.targets[0].id == '_DEFAULT_CORS_ORIGINS'
                    and isinstance(sub.value, ast.Constant)):
                default = sub.value.value
        self.assertIsNotNone(default, '_DEFAULT_CORS_ORIGINS is not defined')
        origins = [o.strip() for o in default.split(',') if o.strip()]
        self.assertTrue(origins, 'empty default would let flask-cors fall back to *')
        self.assertNotIn('*', origins)
        for origin in origins:
            self.assertTrue(origin.startswith('http://localhost')
                            or origin.startswith('http://127.0.0.1'),
                            f'default allowlist should be local-only, got {origin}')

    def test_allowlist_is_read_from_env(self):
        self.assertIn('CORS_ALLOWED_ORIGINS', APP_SOURCE)


class TestLoginThrottleWiring(unittest.TestCase):
    """Finding 5: brute force — all three login routes, not just /api/login."""

    def test_api_login_checks_throttle(self):
        fn = find_route('/api/login', 'POST')
        body = ast.dump(fn)
        self.assertIn('is_locked_out', body)
        self.assertIn('register_failure', body)
        self.assertIn('register_success', body)

    def test_every_login_success_path_clears_counters(self):
        """Three backends, three success returns — miss one and a user who
        typed their password wrong twice stays counted forever."""
        fn = find_route('/api/login', 'POST')
        successes = sum(
            1 for sub in ast.walk(fn)
            if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute)
            and sub.func.attr == 'register_success'
        )
        self.assertEqual(3, successes, 'expected register_success on all 3 auth backends')

    def test_other_login_routes_throttled(self):
        for path in ('client_staff_auth_routes.py', 'support_routes.py'):
            full = os.path.join(os.path.dirname(APP_PY), path)
            with open(full, encoding='utf-8', errors='replace') as fh:
                src = fh.read()
            self.assertIn('login_throttle.is_locked_out', src, f'{path} login is unthrottled')
            self.assertIn('login_throttle.register_failure', src, f'{path} never counts failures')


# ─── Layer 2: live behaviour ──────────────────────────────────────────────────

class TestAuthDecoratorsLive(unittest.TestCase):
    """The real decorators, over real HTTP, on stub handlers."""

    @classmethod
    def setUpClass(cls):
        # _get_jwt_secret enforces >=32 chars AND distinctness from the two
        # sibling secrets — a good check, so satisfy it properly rather than
        # weakening it for tests. Overrides whatever .env loaded.
        os.environ['CLIENT_DASHBOARD_JWT_SECRET'] = 'a' * 64
        os.environ['CLIENT_STAFF_JWT_SECRET'] = 'b' * 64
        os.environ['SUPPORT_JWT_SECRET'] = 'c' * 64
        from flask import Flask, jsonify, g
        import client_dashboard_auth as cda
        cls.cda = cda

        app = Flask(__name__)

        @app.route('/plain')
        @cda.require_client_dashboard_auth
        def plain():
            return jsonify({'org': g.dashboard_user['org_id']})

        @app.route('/admin', methods=['POST'])
        @cda.require_client_dashboard_admin
        def admin():
            return jsonify({'org': g.dashboard_user['org_id']})

        cls.client = app.test_client()

    def _token(self, org_id='11111111-1111-1111-1111-111111111111', role='staff'):
        return self.cda.mint_dashboard_token(
            {'id': 'user-1', 'org_id': org_id, 'branch_id': None, 'role': role},
            account_type='client_staff',
        )

    def test_no_header_is_401(self):
        self.assertEqual(401, self.client.get('/plain').status_code)

    def test_garbage_token_is_401(self):
        r = self.client.get('/plain', headers={'Authorization': 'Bearer not-a-jwt'})
        self.assertEqual(401, r.status_code)

    def test_valid_token_passes_and_pins_org(self):
        r = self.client.get('/plain', headers={'Authorization': f'Bearer {self._token()}'})
        self.assertEqual(200, r.status_code)
        self.assertEqual('11111111-1111-1111-1111-111111111111', r.get_json()['org'])

    def test_non_admin_token_is_403_on_admin_route(self):
        r = self.client.post('/admin', headers={'Authorization': f'Bearer {self._token(role="staff")}'})
        self.assertEqual(403, r.status_code)

    def test_admin_token_passes_admin_route(self):
        r = self.client.post('/admin', headers={'Authorization': f'Bearer {self._token(role="admin")}'})
        self.assertEqual(200, r.status_code)

    def test_admin_route_still_401s_without_a_token(self):
        """require_client_dashboard_admin composes the base decorator, so a
        missing token must be 401 (not authenticated), never 403."""
        self.assertEqual(401, self.client.post('/admin').status_code)

    def test_token_from_another_org_cannot_be_repointed(self):
        """The whole point of pinning: org comes from the signed token, and
        a query string can't override it."""
        token = self._token(org_id='22222222-2222-2222-2222-222222222222')
        r = self.client.get(
            '/plain?organization_id=11111111-1111-1111-1111-111111111111',
            headers={'Authorization': f'Bearer {token}'},
        )
        self.assertEqual('22222222-2222-2222-2222-222222222222', r.get_json()['org'])

    def test_token_signed_with_wrong_secret_is_rejected(self):
        import jwt as pyjwt
        from datetime import datetime, timedelta, timezone
        forged = pyjwt.encode(
            {'sub': 'attacker', 'org_id': 'victim-org', 'is_admin': True,
             'exp': datetime.now(timezone.utc) + timedelta(hours=1)},
            'attacker-chosen-secret', algorithm='HS256',
        )
        r = self.client.post('/admin', headers={'Authorization': f'Bearer {forged}'})
        self.assertEqual(401, r.status_code)

    def test_expired_token_is_rejected(self):
        import jwt as pyjwt
        from datetime import datetime, timedelta, timezone
        expired = pyjwt.encode(
            {'sub': 'u', 'org_id': 'o', 'is_admin': True,
             'exp': datetime.now(timezone.utc) - timedelta(hours=1)},
            os.environ['CLIENT_DASHBOARD_JWT_SECRET'], algorithm='HS256',
        )
        r = self.client.get('/plain', headers={'Authorization': f'Bearer {expired}'})
        self.assertEqual(401, r.status_code)

    def test_alg_none_token_is_rejected(self):
        """Classic JWT downgrade: unsigned token claiming alg=none."""
        import base64, json
        def b64(d):
            return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b'=').decode()
        forged = f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64({'sub': 'a', 'org_id': 'o', 'is_admin': True})}."
        r = self.client.post('/admin', headers={'Authorization': f'Bearer {forged}'})
        self.assertEqual(401, r.status_code)


class TestLoginThrottleLive(unittest.TestCase):
    """login_throttle's actual runtime behaviour."""

    @classmethod
    def setUpClass(cls):
        from flask import Flask, request, jsonify
        import login_throttle
        cls.throttle = login_throttle

        app = Flask(__name__)

        @app.route('/login', methods=['POST'])
        def login():
            body = request.get_json(silent=True) or {}
            email = body.get('email', '')
            if login_throttle.is_locked_out(email):
                return login_throttle.lockout_response(email)
            if body.get('password') == 'correct-horse':
                login_throttle.register_success(email)
                return jsonify({'success': True})
            login_throttle.register_failure(email)
            return jsonify({'success': False}), 401

        cls.client = app.test_client()

    def setUp(self):
        self.throttle.reset_all()

    def _attempt(self, email='victim@example.com', password='wrong', ip='10.0.0.1'):
        return self.client.post('/login', json={'email': email, 'password': password},
                                headers={'X-Forwarded-For': ip})

    def test_correct_password_still_works(self):
        r = self.client.post('/login', json={'email': 'a@b.c', 'password': 'correct-horse'})
        self.assertEqual(200, r.status_code)

    def test_a_few_failures_are_not_blocked(self):
        for _ in range(self.throttle.MAX_FAILURES - 1):
            self.assertEqual(401, self._attempt().status_code)

    def test_lockout_trips_at_the_limit(self):
        for _ in range(self.throttle.MAX_FAILURES):
            self._attempt()
        self.assertEqual(429, self._attempt().status_code)

    def test_lockout_returns_retry_after_header(self):
        for _ in range(self.throttle.MAX_FAILURES):
            self._attempt()
        r = self._attempt()
        self.assertIn('Retry-After', r.headers)
        self.assertGreater(int(r.headers['Retry-After']), 0)

    def test_lockout_blocks_even_the_correct_password(self):
        """Otherwise the throttle is an oracle: 'still 429' vs 'suddenly 200'
        tells the attacker they just guessed right."""
        for _ in range(self.throttle.MAX_FAILURES):
            self._attempt()
        r = self.client.post('/login',
                             json={'email': 'victim@example.com', 'password': 'correct-horse'},
                             headers={'X-Forwarded-For': '10.0.0.1'})
        self.assertEqual(429, r.status_code)

    def test_success_clears_the_counter(self):
        for _ in range(self.throttle.MAX_FAILURES - 1):
            self._attempt()
        self.client.post('/login', json={'email': 'victim@example.com', 'password': 'correct-horse'},
                         headers={'X-Forwarded-For': '10.0.0.1'})
        for _ in range(self.throttle.MAX_FAILURES - 1):
            self.assertEqual(401, self._attempt().status_code)

    def test_rotating_ip_still_locks_the_targeted_account(self):
        """The reason there are two counters. An attacker with a botnet gets
        a fresh IP bucket every request, so IP-keyed limiting alone does
        nothing — the per-identifier counter has to catch this."""
        for i in range(self.throttle.MAX_FAILURES):
            self._attempt(ip=f'10.0.{i}.{i}')
        r = self._attempt(ip='10.99.99.99')
        self.assertEqual(429, r.status_code)

    def test_spoofed_xff_cannot_reset_the_identifier_counter(self):
        for i in range(self.throttle.MAX_FAILURES):
            self._attempt(ip=f'203.0.113.{i}')
        self.assertEqual(429, self._attempt(ip='198.51.100.7').status_code)

    def test_one_host_spraying_many_accounts_is_blocked_by_ip(self):
        """Inverse case: many identifiers, one IP. The per-identifier counter
        never trips, so the IP counter has to."""
        for i in range(self.throttle.MAX_FAILURES):
            self._attempt(email=f'user{i}@example.com', ip='192.0.2.5')
        r = self._attempt(email='someone-new@example.com', ip='192.0.2.5')
        self.assertEqual(429, r.status_code)

    def test_innocent_bystander_on_another_ip_is_unaffected(self):
        """A lockout must not become a denial-of-service against the real
        user of an unrelated account."""
        for i in range(self.throttle.MAX_FAILURES):
            self._attempt(email='target@example.com', ip='192.0.2.5')
        r = self.client.post('/login',
                             json={'email': 'bystander@example.com', 'password': 'correct-horse'},
                             headers={'X-Forwarded-For': '8.8.8.8'})
        self.assertEqual(200, r.status_code)

    def test_lockout_message_does_not_reveal_which_counter_tripped(self):
        for _ in range(self.throttle.MAX_FAILURES):
            self._attempt()
        payload = self._attempt().get_json()
        blob = str(payload).lower()
        for leak in ('ip', 'address', 'account', 'exists', 'email address'):
            self.assertNotIn(f' {leak} ', f' {blob} ')

    def test_identifiers_are_not_stored_in_plaintext(self):
        self._attempt(email='secret.person@example.com')
        self.assertNotIn('secret.person@example.com', str(self.throttle._ATTEMPTS.keys()))

    def test_window_expiry_releases_the_lock(self):
        original = self.throttle.LOCKOUT_SECONDS
        try:
            self.throttle.LOCKOUT_SECONDS = 1
            for _ in range(self.throttle.MAX_FAILURES):
                self._attempt()
            self.assertEqual(429, self._attempt().status_code)
            time.sleep(1.2)
            self.assertEqual(401, self._attempt().status_code)
        finally:
            self.throttle.LOCKOUT_SECONDS = original

    def test_case_and_whitespace_variants_share_a_counter(self):
        """Otherwise 'Victim@Example.com ' is a free extra budget."""
        for _ in range(self.throttle.MAX_FAILURES):
            self._attempt(email='victim@example.com')
        r = self._attempt(email='  VICTIM@Example.COM  ')
        self.assertEqual(429, r.status_code)


class TestCorsLive(unittest.TestCase):
    """The CORS block from app.py, evaluated for real against a stub app."""

    def _build(self, env_value=None):
        import importlib
        from flask import Flask, jsonify
        from flask_cors import CORS
        if env_value is None:
            os.environ.pop('CORS_ALLOWED_ORIGINS', None)
        else:
            os.environ['CORS_ALLOWED_ORIGINS'] = env_value

        default = 'http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173'
        origins = [o.strip() for o in
                   os.environ.get('CORS_ALLOWED_ORIGINS', default).split(',') if o.strip()]
        app = Flask(__name__)
        CORS(app, resources={r'/api/*': {'origins': origins}},
             supports_credentials=True,
             allow_headers=['Content-Type', 'Authorization', 'Accept', 'X-Node-Api-Key'],
             methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

        @app.route('/api/users')
        def users():
            return jsonify({'ok': True})

        return app.test_client()

    def tearDown(self):
        os.environ.pop('CORS_ALLOWED_ORIGINS', None)

    def test_evil_origin_gets_no_acao_header(self):
        client = self._build('https://dashboard.example.com')
        r = client.get('/api/users', headers={'Origin': 'https://evil.example.net'})
        self.assertNotIn('Access-Control-Allow-Origin', r.headers)

    def test_allowed_origin_gets_acao_header(self):
        client = self._build('https://dashboard.example.com')
        r = client.get('/api/users', headers={'Origin': 'https://dashboard.example.com'})
        self.assertEqual('https://dashboard.example.com',
                         r.headers.get('Access-Control-Allow-Origin'))

    def test_acao_is_never_literal_wildcard(self):
        client = self._build('https://dashboard.example.com')
        r = client.get('/api/users', headers={'Origin': 'https://dashboard.example.com'})
        self.assertNotEqual('*', r.headers.get('Access-Control-Allow-Origin'))

    def test_preflight_from_evil_origin_is_not_approved(self):
        """The original report's 'CORS Wildcard OPTIONS /api/users (200)'."""
        client = self._build('https://dashboard.example.com')
        r = client.options('/api/users', headers={
            'Origin': 'https://evil.example.net',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization',
        })
        self.assertNotIn('Access-Control-Allow-Origin', r.headers)

    def test_default_when_env_unset_is_localhost_only(self):
        client = self._build(None)
        r = client.get('/api/users', headers={'Origin': 'https://dashboard.example.com'})
        self.assertNotIn('Access-Control-Allow-Origin', r.headers,
                         'unset env must fail closed, not fall back to wildcard')

    def test_multiple_origins_parse(self):
        client = self._build('https://a.example.com, https://b.example.com')
        for origin in ('https://a.example.com', 'https://b.example.com'):
            r = client.get('/api/users', headers={'Origin': origin})
            self.assertEqual(origin, r.headers.get('Access-Control-Allow-Origin'))


if __name__ == '__main__':
    unittest.main(verbosity=2)