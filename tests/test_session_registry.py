"""Regression tests for session_registry.py (the "No Session Invalidation —
Unlimited Concurrent Sessions" finding) and its wiring into all three JWT
auth surfaces.

Two layers, same split as test_security_fixes.py:

  LIVE    — session_registry.py imported for real, its Supabase calls
            replaced with an in-memory fake table so rotate/validate/
            end/invalidate can be exercised without a live DB.

  STATIC  — app.py can't be imported in a test process (pulls in
            insightface/cv2/numpy/torch and warms a face model at import
            time — see test_security_fixes.py), so the new
            /api/client/auth/logout route is verified against its AST
            instead of by calling it.

Run: python test_session_registry.py
"""

from __future__ import annotations

import ast
import os
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import session_registry as sr


# ─── Fake Supabase table ────────────────────────────────────────────────────

class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    """Minimal stand-in for the postgrest builder chain session_registry.py
    actually uses: .table(x).upsert(row, on_conflict=...).execute() and
    .table(x).select(cols).eq(k, v).eq(k, v).limit(n).execute()."""

    def __init__(self, table: "_FakeTable", mode: str, row=None):
        self._table = table
        self._mode = mode
        self._row = row
        self._filters: dict[str, str] = {}

    def eq(self, key, value):
        self._filters[key] = str(value)
        return self

    def limit(self, _n):
        return self

    def execute(self):
        self._table.calls += 1
        if self._table.raise_always:
            raise RuntimeError("simulated persistent Supabase error")
        if self._table.raise_on_next:
            self._table.raise_on_next = False
            raise RuntimeError("simulated transient Supabase error")

        if self._mode == "upsert":
            key = (self._row["account_type"], self._row["user_id"])
            self._table.rows[key] = dict(self._row)
            return _FakeResult([dict(self._row)])

        # select
        key = (self._filters.get("account_type"), self._filters.get("user_id"))
        row = self._table.rows.get(key)
        return _FakeResult([dict(row)] if row else [])


class _FakeTable:
    def __init__(self):
        self.rows: dict[tuple, dict] = {}
        self.calls = 0
        self.raise_on_next = False
        self.raise_always = False

    def upsert(self, row, on_conflict=None):
        return _FakeQuery(self, "upsert", row=row)

    def select(self, _cols):
        return _FakeQuery(self, "select")


class _FakeSupabase:
    def __init__(self):
        self._table = _FakeTable()

    def table(self, name):
        assert name == "active_sessions"
        return self._table


class SessionRegistryTests(unittest.TestCase):
    def setUp(self):
        self.fake = _FakeSupabase()
        sr._CACHE.clear()
        self._patchers = [
            patch("session_registry.get_supabase", return_value=self.fake),
            patch("session_registry.reset_supabase_client", lambda: None),
        ]
        for p in self._patchers:
            p.start()
            self.addCleanup(p.stop)

    # ── rotate / validate ───────────────────────────────────────────────────

    def test_rotate_then_validate_current_sid_ok(self):
        sid = sr.rotate_session("internal_user", "u1")
        ok, reason = sr.validate_session("internal_user", "u1", sid)
        self.assertTrue(ok)
        self.assertIsNone(reason)

    def test_new_login_supersedes_old_sid(self):
        old_sid = sr.rotate_session("internal_user", "u1")
        sr._CACHE.clear()  # force a fresh DB read, not the write-through cache
        new_sid = sr.rotate_session("internal_user", "u1")
        self.assertNotEqual(old_sid, new_sid)

        ok, reason = sr.validate_session("internal_user", "u1", old_sid)
        self.assertFalse(ok)
        self.assertEqual(reason, sr.SESSION_SUPERSEDED)

    def test_unknown_account_is_superseded_not_trusted(self):
        ok, reason = sr.validate_session("internal_user", "ghost", "some-sid")
        self.assertFalse(ok)
        self.assertEqual(reason, sr.SESSION_SUPERSEDED)

    def test_missing_sid_claim_is_rejected_without_a_db_call(self):
        sr.rotate_session("internal_user", "u1")
        calls_before = self.fake._table.calls
        ok, reason = sr.validate_session("internal_user", "u1", "")
        self.assertFalse(ok)
        self.assertEqual(reason, sr.SESSION_SUPERSEDED)
        self.assertEqual(self.fake._table.calls, calls_before)

    # ── logout / admin invalidation ─────────────────────────────────────────

    def test_end_session_invalidates_and_is_not_password_changed(self):
        sid = sr.rotate_session("client_user", "u1")
        sr.end_session("client_user", "u1")
        ok, reason = sr.validate_session("client_user", "u1", sid)
        self.assertFalse(ok)
        self.assertEqual(reason, sr.SESSION_SUPERSEDED)

    def test_invalidate_session_reports_password_changed(self):
        sid = sr.rotate_session("internal_user", "u1")
        sr.invalidate_session("internal_user", "u1", reason="password_changed")
        ok, reason = sr.validate_session("internal_user", "u1", sid)
        self.assertFalse(ok)
        self.assertEqual(reason, sr.PASSWORD_CHANGED)

    def test_end_all_client_staff_sessions_kills_desktop_and_mobile(self):
        desktop_sid = sr.rotate_session("client_staff", "s1")
        mobile_sid = sr.rotate_session("client_staff_mobile", "s1")

        sr.end_all_client_staff_sessions("s1")

        ok_desktop, reason_desktop = sr.validate_session("client_staff", "s1", desktop_sid)
        ok_mobile, reason_mobile = sr.validate_session("client_staff_mobile", "s1", mobile_sid)
        self.assertFalse(ok_desktop)
        self.assertFalse(ok_mobile)
        self.assertEqual(reason_desktop, sr.PASSWORD_CHANGED)
        self.assertEqual(reason_mobile, sr.PASSWORD_CHANGED)

    def test_client_staff_and_client_staff_mobile_are_independent(self):
        """A desktop re-login must not kill the same person's mobile
        session, and vice versa -- see module docstring."""
        mobile_sid = sr.rotate_session("client_staff_mobile", "s1")
        sr.rotate_session("client_staff", "s1")  # desktop login for the same staff row

        ok, reason = sr.validate_session("client_staff_mobile", "s1", mobile_sid)
        self.assertTrue(ok)
        self.assertIsNone(reason)

    # ── caching ──────────────────────────────────────────────────────────────

    def test_repeat_validate_within_ttl_hits_cache_not_db(self):
        sid = sr.rotate_session("internal_user", "u1")
        calls_before = self.fake._table.calls
        sr.validate_session("internal_user", "u1", sid)
        sr.validate_session("internal_user", "u1", sid)
        sr.validate_session("internal_user", "u1", sid)
        # rotate_session's own upsert already happened; none of the three
        # validate_session calls above should have hit the fake DB again.
        self.assertEqual(self.fake._table.calls, calls_before)

    def test_cache_expires_after_ttl(self):
        sid = sr.rotate_session("internal_user", "u1")
        sr.validate_session("internal_user", "u1", sid)
        calls_before = self.fake._table.calls
        with patch("session_registry.time.monotonic", return_value=time.monotonic() + 999):
            sr.validate_session("internal_user", "u1", sid)
        self.assertGreater(self.fake._table.calls, calls_before)

    # ── fail-open on transient errors ───────────────────────────────────────

    def test_validate_fails_open_on_transient_read_error(self):
        sr.rotate_session("internal_user", "u1")
        sr._CACHE.clear()
        self.fake._table.raise_always = True
        ok, reason = sr.validate_session("internal_user", "u1", "whatever-sid")
        self.assertTrue(ok)
        self.assertIsNone(reason)

    def test_rotate_fails_closed_on_persistent_write_error(self):
        self.fake._table.raise_always = True
        with self.assertRaises(RuntimeError):
            sr.rotate_session("internal_user", "u1")


# ─── Static checks: every consuming route wired correctly ──────────────────

APP_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.py")
with open(APP_PY, encoding="utf-8", errors="replace") as fh:
    APP_SOURCE = fh.read()
APP_TREE = ast.parse(APP_SOURCE)


def _module_tree(filename: str) -> ast.Module:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    with open(path, encoding="utf-8", errors="replace") as fh:
        return ast.parse(fh.read())


def _find_function(tree: ast.Module, name: str) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"function {name!r} not found")


def _find_if(func: ast.FunctionDef, *, test_matches) -> ast.If:
    """First `if` statement anywhere in func whose test node satisfies
    test_matches(test_node) -> bool."""
    for node in ast.walk(func):
        if isinstance(node, ast.If) and test_matches(node.test):
            return node
    raise AssertionError(f"no matching `if` found in {func.name}")


def _calls_dotted_name(stmts: list, module: str, attr: str) -> bool:
    """True if any statement in `stmts` (a Python list of AST statements,
    e.g. an If node's .body or .orelse) contains a call shaped like
    `module.attr(...)`."""
    for stmt in stmts:
        for node in ast.walk(stmt):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and func.attr == attr
                and isinstance(func.value, ast.Name)
                and func.value.id == module
            ):
                return True
    return False


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
    out = []
    for dec in node.decorator_list:
        if not isinstance(dec, ast.Call):
            continue
        target = dec.func
        if not (isinstance(target, ast.Attribute) and target.attr == "route"):
            continue
        if not dec.args or not isinstance(dec.args[0], ast.Constant):
            continue
        methods = []
        for kw in dec.keywords:
            if kw.arg == "methods" and isinstance(kw.value, ast.List):
                methods = [
                    elt.value for elt in kw.value.elts if isinstance(elt, ast.Constant)
                ]
        out.append((dec.args[0].value, methods))
    return out


class ClientDashboardLogoutRouteTests(unittest.TestCase):
    def test_logout_route_exists_authenticated_and_calls_registry(self):
        for node in ast.walk(APP_TREE):
            if not isinstance(node, ast.FunctionDef):
                continue
            for path, methods in _routes(node):
                if path == "/api/client/auth/logout":
                    self.assertIn("POST", methods)
                    self.assertIn(
                        "require_client_dashboard_auth", _decorator_names(node)
                    )
                    body_src = ast.get_source_segment(APP_SOURCE, node) or ""
                    self.assertIn("logout_dashboard_user", body_src)
                    return
        self.fail("/api/client/auth/logout route not found in app.py")


class ClientStaffPasswordResetSessionKillTests(unittest.TestCase):
    """support_db_staff.update_client_staff — an admin resetting a staff
    member's password (Staff Management edit form) must kill both of that
    person's active sessions (desktop + mobile), not just change the row.
    See end_all_client_staff_sessions's docstring for why one hook isn't
    enough. Static-checked, same reasoning as ClientDashboardLogoutRouteTests:
    this function pulls in support_db_client_users/support_db_attendance_gate/
    core.vertical_templates and a real Supabase update chain, so a live
    call-through test would mock more plumbing than it exercises."""

    def setUp(self):
        self.tree = _module_tree("support_db_staff.py")
        self.func = _find_function(self.tree, "update_client_staff")

    def test_password_reset_branch_kills_both_staff_sessions(self):
        if_node = _find_if(
            self.func,
            test_matches=lambda t: isinstance(t, ast.Name) and t.id == "password_reset",
        )
        self.assertTrue(
            _calls_dotted_name(if_node.body, "session_registry", "end_all_client_staff_sessions"),
            "update_client_staff's `if password_reset:` branch must call "
            "session_registry.end_all_client_staff_sessions",
        )

    def test_session_kill_is_conditional_on_password_reset_not_unconditional(self):
        """A password-less profile edit (name/department/etc.) must NOT
        touch session_registry -- only an actual password change should."""
        call_count = sum(
            1
            for node in ast.walk(self.func)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "end_all_client_staff_sessions"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "session_registry"
        )
        # Exactly one call site in the whole function -- inside the guard,
        # counted at the AST level so a comment mentioning the same
        # function name elsewhere can't produce a false positive.
        self.assertEqual(call_count, 1)
        if_node = _find_if(
            self.func,
            test_matches=lambda t: isinstance(t, ast.Name) and t.id == "password_reset",
        )
        # And it must not also appear in the guard's own orelse (there is
        # none today, but this pins the branch, not just the function, in
        # case an `else:` is added later without moving the call).
        self.assertFalse(
            _calls_dotted_name(if_node.orelse, "session_registry", "end_all_client_staff_sessions")
        )


class SupportInviteResetSessionKillTests(unittest.TestCase):
    """support_db_client_users.create_client_invite — Support resetting an
    EXISTING client_users admin's password (the recovery path for a hacked
    org-admin account) must kill that admin's active session. A brand-new
    invite (no prior row) has no session to kill and must not attempt one."""

    def setUp(self):
        self.tree = _module_tree("support_db_client_users.py")
        self.func = _find_function(self.tree, "create_client_invite")

    def test_existing_admin_reset_branch_invalidates_session(self):
        if_node = _find_if(
            self.func,
            test_matches=lambda t: (
                isinstance(t, ast.Attribute)
                and t.attr == "data"
                and isinstance(t.value, ast.Name)
                and t.value.id == "existing"
            ),
        )
        self.assertTrue(
            _calls_dotted_name(if_node.body, "session_registry", "invalidate_session"),
            "create_client_invite's `if existing.data:` (reset) branch must "
            "call session_registry.invalidate_session",
        )

    def test_new_invite_branch_does_not_invalidate_a_session(self):
        """The else branch (brand-new client_users row, nothing existed
        before) must never call session_registry -- there is no prior
        session for a row that didn't exist a moment ago."""
        if_node = _find_if(
            self.func,
            test_matches=lambda t: (
                isinstance(t, ast.Attribute)
                and t.attr == "data"
                and isinstance(t.value, ast.Name)
                and t.value.id == "existing"
            ),
        )
        self.assertFalse(
            _calls_dotted_name(if_node.orelse, "session_registry", "invalidate_session")
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)