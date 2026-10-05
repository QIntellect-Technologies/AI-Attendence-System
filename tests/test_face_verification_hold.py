"""
Tests for the face-verification-bypass fix in support_db_attendance_exceptions.py.

Run with:
    cd backend/backend
    python3 -m pytest tests/test_face_verification_hold.py -v
"""
import sys
sys.path.insert(0, ".")

import support_db_attendance_exceptions as aedb


# ─── Layer 1: apply_face_verification_hold (pure, no DB) ──────────────────

class TestApplyFaceVerificationHold:
    def test_noop_when_face_verified_true_or_none(self):
        """The live (non-deferred) path passes pending_face_review=False --
        must be a complete no-op, byte-for-byte, or every normal check-in
        would be silently altered by this helper."""
        fields = aedb.check_in_write_fields("on_time")
        assert aedb.apply_face_verification_hold(fields, pending_face_review=False) == fields

    def test_check_in_forces_hold_on_mismatch(self):
        out = aedb.apply_face_verification_hold(
            aedb.check_in_write_fields("on_time"), pending_face_review=True
        )
        assert out["check_in_hold_reason"] == "face_mismatch"
        assert out["check_in_confirmed"] is False
        assert "did not match" in out["notes"]

    def test_check_out_forces_hold_on_mismatch(self):
        out = aedb.apply_face_verification_hold(
            aedb.check_out_write_fields("on_time", None), pending_face_review=True
        )
        assert out["check_out_hold_reason"] == "face_mismatch"

    def test_face_mismatch_outranks_late_but_preserves_the_late_note(self):
        """This is the exact case the original bug hid: a late check-in
        that ALSO fails face verification must end up held for identity,
        not silently confirmed via the 'late' path, and must not lose the
        timing note in the process."""
        out = aedb.apply_face_verification_hold(
            aedb.check_in_write_fields("late"), pending_face_review=True
        )
        assert out["check_in_hold_reason"] == "face_mismatch"
        assert out["check_in_confirmed"] is False
        assert "grace period" in out["notes"]       # original late note
        assert "did not match" in out["notes"]      # face-mismatch note appended, not replacing it

    def test_on_time_check_in_never_silently_confirmed_when_mismatched(self):
        """Regression guard for the actual reported bug: check_in_write_fields('on_time')
        alone returns check_in_confirmed=True -- confirm the hold helper
        overrides that back to False when the face didn't match."""
        baseline = aedb.check_in_write_fields("on_time")
        assert baseline["check_in_confirmed"] is True  # sanity: this is what was being trusted blindly
        held = aedb.apply_face_verification_hold(baseline, pending_face_review=True)
        assert held["check_in_confirmed"] is False


# ─── Layer 2: resolve_attendance_exception (mocked Supabase) ──────────────

def _row(**overrides):
    base = {
        "id": "att-1", "notes": None, "day_status": None, "staff_id": "staff-1",
        "branch_id": "branch-1", "timestamp": "2026-08-25T04:00:00Z",
        "check_out_timestamp": None, "check_in_hold_reason": None,
        "check_out_hold_reason": None,
    }
    base.update(overrides)
    return base


def _mock_select_then_update(sb, existing_row, update_result_row=None):
    """Wires the fluent Supabase mock chain for one select().execute() call
    (returns existing_row) followed by one update(...).eq(...).eq(...).execute()
    call (returns update_result_row or the merged update)."""
    select_result = sb.table.return_value.select.return_value
    select_result.eq.return_value.eq.return_value.limit.return_value.execute.return_value.data = [existing_row]

    update_chain = sb.table.return_value.update
    def _update_side_effect(payload):
        chain = update_chain.return_value
        chain.eq.return_value.eq.return_value.execute.return_value.data = [
            update_result_row or {**existing_row, **payload}
        ]
        return chain
    update_chain.side_effect = _update_side_effect
    return update_chain


class TestResolveAttendanceExceptionHoldReasonValidation:
    def test_rejects_mismatched_decision_for_face_mismatch_check_in(self, sb):
        """This is the exact gap called out in the original report: before
        the fix, check_in had NO per-hold-reason validation at all, so a
        face_mismatch row could be resolved with 'half_day' as if it were
        a legitimate late-arrival case."""
        existing = _row(check_in_hold_reason="face_mismatch")
        _mock_select_then_update(sb, existing)
        try:
            aedb.resolve_attendance_exception("org-1", "att-1", "check_in", "half_day")
            assert False, "expected ValueError"
        except ValueError as e:
            assert "face_mismatch" in str(e)

    def test_rejects_mismatched_decision_for_face_mismatch_check_out(self, sb):
        existing = _row(check_out_hold_reason="face_mismatch")
        _mock_select_then_update(sb, existing)
        try:
            aedb.resolve_attendance_exception("org-1", "att-1", "check_out", "early_leave")
            assert False, "expected ValueError"
        except ValueError:
            pass

    def test_late_check_in_still_rejects_face_mismatch_decisions(self, sb):
        """Symmetry check: a plain late hold shouldn't accept identity
        decisions either."""
        existing = _row(check_in_hold_reason="late")
        _mock_select_then_update(sb, existing)
        try:
            aedb.resolve_attendance_exception("org-1", "att-1", "check_in", "confirm_identity")
            assert False, "expected ValueError"
        except ValueError:
            pass


class TestResolveAttendanceExceptionIdentityDecisions:
    def test_confirm_identity_check_in_marks_present_and_confirmed(self, sb):
        existing = _row(check_in_hold_reason="face_mismatch")
        update_chain = _mock_select_then_update(sb, existing)
        aedb.resolve_attendance_exception("org-1", "att-1", "check_in", "confirm_identity")
        payload = update_chain.call_args[0][0]
        assert payload["check_in_confirmed"] is True
        assert payload["day_status"] == "present"
        assert payload["check_in_hold_reason"] is None

    def test_reject_attendance_check_in_never_present_never_payroll(self, sb):
        existing = _row(check_in_hold_reason="face_mismatch")
        update_chain = _mock_select_then_update(sb, existing)
        aedb.resolve_attendance_exception("org-1", "att-1", "check_in", "reject_attendance")
        payload = update_chain.call_args[0][0]
        assert payload["check_in_confirmed"] is False
        assert payload["day_status"] == "rejected"
        assert payload["check_in_payroll_decision"] == "exclude"

    def test_escalate_check_in_same_effect_plus_notification(self, sb, monkeypatch):
        existing = _row(check_in_hold_reason="face_mismatch")
        update_chain = _mock_select_then_update(sb, existing)
        called = {}
        monkeypatch.setattr(
            aedb, "_notify_face_mismatch_escalation",
            lambda **kwargs: called.update(kwargs)
        )
        aedb.resolve_attendance_exception("org-1", "att-1", "check_in", "escalate", resolved_by="admin-1")
        payload = update_chain.call_args[0][0]
        assert payload["day_status"] == "rejected"
        assert payload["check_in_payroll_decision"] == "exclude"
        assert called.get("resolved_by") == "admin-1"

    def test_reject_attendance_check_out_excludes_payroll(self, sb):
        existing = _row(check_out_hold_reason="face_mismatch")
        update_chain = _mock_select_then_update(sb, existing)
        aedb.resolve_attendance_exception("org-1", "att-1", "check_out", "reject_attendance")
        payload = update_chain.call_args[0][0]
        assert payload["day_status"] == "rejected"
        assert payload["check_out_payroll_decision"] == "exclude"


class TestRegressionOrdinaryTimingPathsUnaffected:
    """The fix must not change behavior for rows that never had a face
    mismatch -- these mirror the pre-existing late/early/overtime contract."""

    def test_ordinary_late_check_in_confirm_still_works(self, sb):
        existing = _row(check_in_hold_reason="late")
        update_chain = _mock_select_then_update(sb, existing)
        aedb.resolve_attendance_exception("org-1", "att-1", "check_in", "late")
        payload = update_chain.call_args[0][0]
        assert payload["check_in_confirmed"] is True
        assert payload["day_status"] == "late"

    def test_ordinary_early_checkout_half_day_still_works(self, sb):
        existing = _row(check_out_hold_reason="early")
        update_chain = _mock_select_then_update(sb, existing)
        aedb.resolve_attendance_exception("org-1", "att-1", "check_out", "half_day")
        payload = update_chain.call_args[0][0]
        assert payload["day_status"] == "half_day"

    def test_half_day_still_rejected_for_late_checkout_hold(self, sb):
        existing = _row(check_out_hold_reason="late")
        _mock_select_then_update(sb, existing)
        try:
            aedb.resolve_attendance_exception("org-1", "att-1", "check_out", "half_day")
            assert False, "expected ValueError"
        except ValueError:
            pass
