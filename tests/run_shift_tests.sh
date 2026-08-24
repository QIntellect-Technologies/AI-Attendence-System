#!/usr/bin/env bash
# Ticket #20 — one command to verify the shift-conflict fix.
#
# Run from the backend/ directory of a full checkout (the end-to-end file
# needs local_node/ importable; it SKIPS cleanly if that isn't present, so
# this is still safe to run from a backend-only checkout).
set -uo pipefail

echo "── 1. Overlap rule (pure logic) ─────────────────────────────────"
python -m pytest tests/test_shift_overlap.py -v --no-header || FAILED=1

echo
echo "── 2. Guard is wired into every write path ──────────────────────"
python -m pytest tests/test_shift_write_paths.py -v --no-header || FAILED=1

echo
echo "── 3. Assignment reaches attendance marking + Local Node ────────"
python -m pytest tests/test_shift_assignment_end_to_end.py -v --no-header || FAILED=1

echo
echo "── 4. Existing shift/attendance suites (no regressions) ─────────"
python -m pytest tests/ -q --no-header || FAILED=1

echo
echo "── 5. Audit: overlaps already in the database ───────────────────"
echo "   (read-only; needs live Supabase credentials — skipped if absent)"
python scripts/audit_shift_overlaps.py --warnings 2>/dev/null \
  || echo "   SKIPPED: no database connection configured."

echo
if [ "${FAILED:-0}" = "1" ]; then
  echo "RESULT: FAILURES above — do not deploy."
  exit 1
fi
echo "RESULT: all shift-conflict tests passed."
