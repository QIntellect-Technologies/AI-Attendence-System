"""Regression tests for: "SQL Injection Payload Causes Unhandled WAF Crash".

Covers two independent layers of the fix, both in support_db_core.py:

  1. build_or_ilike_filter / build_or_eq_filter — the hand-built PostgREST
     `.or_()` filter strings (Staff/Payroll search, login-by-identifier
     lookup) now quote values per PostgREST's own escaping rule instead of
     interpolating them raw. Verifies structural characters (',', '(',
     ')', '"') can never break out of the quoted value, and that ILIKE's
     own wildcard characters ('%', '_') are escaped so they match
     literally.

  2. _readable_supabase_error / _is_retryable_supabase_error — any
     Supabase/postgrest failure is now classified into a clean
     ValueError (bad/blocked request -> 400) or RuntimeError (infra
     outage -> 500) using the real HTTP status code where available,
     with a last-resort net so nothing (a raw JSONDecodeError, a pydantic
     ValidationError, an unrecognized future exception type) can escape
     unclassified the way it did when a Cloudflare WAF 403 HTML page
     reached the old code path.

Run: python test_search_waf_crash_fix.py
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
os.environ.setdefault("JWT_SECRET", "test")

import support_db_core as core

try:
    from postgrest.exceptions import APIError
except ImportError:  # pragma: no cover
    APIError = None


def _waf_block_exc(status: int = 403) -> Exception:
    """Shape postgrest-py raises when a response body isn't valid JSON —
    e.g. Cloudflare's HTML block page for a WAF-flagged request. `code` is
    the raw HTTP status in this case (see generate_default_error_message
    in postgrest/exceptions.py)."""
    if APIError is not None:
        return APIError({
            "message": "JSON could not be generated",
            "code": status,
            "hint": None,
            "details": str(b"<html><head><title>403 Forbidden</title></html>"),
        })
    # postgrest isn't installed in this environment — fall back to the
    # even-more-primitive failure mode (a raw JSONDecodeError from trying
    # to json-decode the HTML body directly) to still exercise the
    # last-resort classification path.
    try:
        json.loads("<html>not json")
    except json.JSONDecodeError as exc:
        return exc


class TestFilterInjectionFix(unittest.TestCase):
    """The actual injection surface: hand-built `.or_()` filter strings."""

    def test_sqli_payload_cannot_break_out_of_ilike_filter(self):
        clause = core.build_or_ilike_filter("' OR 1=1 --", ["name", "email"])
        # The payload is a valid *search term* now, not filter syntax: it
        # is fully contained inside one quoted value per column, and no
        # unescaped comma/paren/quote from it can appear outside a
        # "..." pair to redefine the clause structure.
        self.assertEqual(
            clause,
            'name.ilike."%\' OR 1=1 --%",email.ilike."%\' OR 1=1 --%"',
        )
        self.assertEqual(clause.count('"'), 4)  # one quoted value per column

    def test_embedded_comma_and_parens_stay_inside_the_quotes(self):
        clause = core.build_or_ilike_filter("a,b)c(d", ["name"])
        self.assertEqual(clause, 'name.ilike."%a,b)c(d%"')
        # Only one filter clause was produced -- the comma didn't split it.
        self.assertEqual(clause.count(".ilike."), 1)

    def test_embedded_double_quote_and_backslash_are_escaped(self):
        # Escaping happens in two composed layers -- ILIKE-wildcard
        # escaping first, then PostgREST quote-escaping over the result
        # (each layer's own backslashes get doubled by the outer layer,
        # exactly as they must be for PostgREST to unescape back to the
        # value ILIKE was meant to see) -- so a literal backslash in the
        # input surfaces as four backslashes in the wire value.
        clause = core.build_or_ilike_filter('a"b\\c', ["name"])
        self.assertEqual(clause, 'name.ilike."%a\\"b\\\\\\\\c%"')

    def test_ilike_wildcards_are_escaped_to_literal_matches(self):
        clause = core.build_or_ilike_filter("50% off_thing", ["name"])
        self.assertEqual(clause, 'name.ilike."%50\\\\% off\\\\_thing%"')

    def test_blank_search_yields_no_filter(self):
        self.assertIsNone(core.build_or_ilike_filter("   ", ["name"]))
        self.assertIsNone(core.build_or_ilike_filter(None, ["name"]))

    def test_eq_filter_does_not_alter_the_value_only_quotes_it(self):
        # Exact-match identifier lookups (login by email/phone) must
        # compare what was actually stored -- safety must come entirely
        # from quoting, never from stripping/normalizing characters.
        clause = core.build_or_eq_filter("a,b@x.com", ["email", "phone"])
        self.assertEqual(clause, 'email.eq."a,b@x.com",phone.eq."a,b@x.com"')

    def test_eq_filter_blank_value_yields_no_filter(self):
        self.assertIsNone(core.build_or_eq_filter("   ", ["email", "phone"]))


class TestUpstreamErrorClassification(unittest.TestCase):
    """Every Supabase/postgrest failure must resolve to a clean
    ValueError (400) or RuntimeError (500) -- never propagate raw."""

    def test_waf_block_403_is_not_retried_and_maps_to_value_error(self):
        exc = _waf_block_exc(403)
        if APIError is not None and isinstance(exc, APIError):
            self.assertFalse(core._is_retryable_supabase_error(exc))
        mapped = core._readable_supabase_error(exc, "test.staff_search")
        self.assertIsInstance(mapped, ValueError)
        self.assertNotIsInstance(mapped, core.__dict__.get("_PostgrestAPIError", ()) or ())

    def test_origin_unreachable_502_is_retryable_and_maps_to_runtime_error(self):
        if APIError is None:
            self.skipTest("postgrest not installed in this environment")
        exc = APIError({"message": "JSON could not be generated", "code": 502, "hint": None, "details": "bad gateway"})
        self.assertTrue(core._is_retryable_supabase_error(exc))
        mapped = core._readable_supabase_error(exc, "test.staff_search")
        self.assertIsInstance(mapped, RuntimeError)

    def test_raw_json_decode_error_never_escapes_unclassified(self):
        # This is the literal crash mode from the bug report: something
        # upstream of postgrest's own guard tries to json-decode an HTML
        # body directly. json.JSONDecodeError subclasses ValueError, so
        # this also guards against it being mistaken for an intentional
        # application-level ValueError and passed through unwrapped.
        try:
            json.loads("<html>not json")
        except json.JSONDecodeError as exc:
            mapped = core._readable_supabase_error(exc, "test.staff_search")
            self.assertIsInstance(mapped, RuntimeError)
            self.assertNotIsInstance(mapped, json.JSONDecodeError)

    def test_intentional_application_value_error_passes_through_unwrapped(self):
        original = ValueError("branch_id is required")
        mapped = core._readable_supabase_error(original, "test.branch")
        self.assertIs(mapped, original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
