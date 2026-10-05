"""
scripts/audit_shift_overlaps.py
──────────────────────────────────────────────────────────────────────────────
Lists shifts that share hours with another shift in the same branch and
people_type.

This is a REVIEW tool, not a violation report. Overlapping shifts are allowed
and often intentional — Morning 09:00–17:00 beside Evening 14:00–22:00 puts two
people on the floor through the lunch rush. Nothing in attendance resolves a
shift by matching a punch time (every lookup is by the person's own
shift_id_ref), so an overlap is never ambiguous. What it can be is
accidental, which is what this surfaces.

Read-only by design. Which shift to retime, if any, is a scheduling decision
for whoever runs the branch.

Usage:
    python scripts/audit_shift_overlaps.py                # every org
    python scripts/audit_shift_overlaps.py --org <org_id> # one org
    python scripts/audit_shift_overlaps.py --warnings     # include handovers

Exit code is 0 unless --strict is passed, since an overlap is not by itself
a fault. With --strict it exits 1 on any shared-hours overlap, for an org
that genuinely runs a tiling roster and wants this to gate a deploy.
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# MUST come before importing supabase_client. get_supabase() reads
# SUPABASE_URL / SUPABASE_SERVICE_KEY straight from the process environment
# and never loads .env itself — app.py normally does that for it during Flask
# bootstrap. This script runs standalone, so it has to do the same, or
# get_supabase() raises "must be set" even with a perfectly good .env sitting
# right next to it. Same reasoning, same call site position, as
# backfill_admin_dashboard_scope.py.
#
# Uses core.env.load_env() rather than calling load_dotenv() directly, since
# that helper exists for precisely this case (see its docstring).
try:
    from core.env import load_env
except ImportError:                                  # pragma: no cover
    from dotenv import load_dotenv as load_env       # older layouts
load_env()

from supabase_client import get_supabase                      # noqa: E402
from support_db_shift_overlap import (                        # noqa: E402
    compare,
    format_window,
)

SHIFT_COLUMNS = (
    "id, org_id, branch_id, people_type, name, check_in_time, grace_minutes, "
    "check_out_time, checkout_grace_minutes, is_active"
)


def load_shifts(org_id: str | None) -> list[dict]:
    query = get_supabase().table("shifts").select(SHIFT_COLUMNS)
    if org_id:
        query = query.eq("org_id", str(org_id))
    return query.execute().data or []


def branch_names() -> dict[str, str]:
    """One lookup for readable output — a report full of raw UUIDs can't be
    acted on without a second round of manual queries."""
    rows = get_supabase().table("branches").select("id, name").execute().data or []
    return {str(r["id"]): r.get("name") or str(r["id"]) for r in rows}


def audit(org_id: str | None, include_warnings: bool, *, strict: bool = False) -> int:
    shifts = [s for s in load_shifts(org_id) if s.get("is_active") is not False]

    # Group by the scope a conflict is defined within — same org, branch, and
    # people_type. Shifts outside one scope never compete for the same punch.
    scopes: dict[tuple, list[dict]] = defaultdict(list)
    for shift in shifts:
        scopes[
            (str(shift.get("org_id")), str(shift.get("branch_id")),
             str(shift.get("people_type")))
        ].append(shift)

    names = branch_names()
    conflict_count = 0
    warning_count = 0

    for (scope_org, branch_id, people_type), group in sorted(scopes.items()):
        # Each unordered pair once. compare() is symmetric.
        for index, first in enumerate(group):
            for second in group[index + 1:]:
                result = compare(first, second)
                if result is None:
                    continue
                if result.severity == "warning":
                    warning_count += 1
                    if not include_warnings:
                        continue
                else:
                    conflict_count += 1

                marker = "shares hours" if result.severity == "conflict" else "handover"
                print(
                    f"[{marker}] org={scope_org} "
                    f"branch={names.get(branch_id, branch_id)} "
                    f"people_type={people_type}\n"
                    f"    {first.get('name')} ({format_window(first)})  "
                    f"vs  {second.get('name')} ({format_window(second)})\n"
                    f"    overlap: {result.overlap_minutes} min\n"
                    f"    shift ids: {first.get('id')} / {second.get('id')}\n"
                )

    total_scopes = len(scopes)
    print(
        f"Checked {len(shifts)} active shift(s) across {total_scopes} "
        f"branch/people_type scope(s)."
    )
    print(f"Shared-hours overlaps: {conflict_count}")
    print(
        f"Handover notes: {warning_count}"
        + ("" if include_warnings else " (re-run with --warnings to list)")
    )

    if conflict_count:
        print(
            "\nThese are not errors. Each person's attendance follows their "
            "own assigned shift, so shared hours resolve fine. Review them "
            "only to confirm each overlap was intended."
        )
    return 1 if (strict and conflict_count) else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org", dest="org_id", default=None,
                        help="Limit to one organization id.")
    parser.add_argument("--warnings", action="store_true",
                        help="Also list grace-tail handover notes.")
    parser.add_argument("--strict", action="store_true",
                        help="Exit 1 if any shifts share duty hours. For orgs "
                             "that run a strict tiling roster.")
    args = parser.parse_args()

    # A missing .env is a setup problem, not a crash. A raw traceback here
    # buries the one line that matters under a stack that looks like the
    # script is broken.
    try:
        get_supabase()
    except RuntimeError as exc:
        print(f"Can't reach the database: {exc}", file=sys.stderr)
        print(
            "\nThis script reads live shift data, so it needs the same "
            "credentials the\napp uses. Check that a .env file exists in the "
            "project root (beside app.py,\nNOT in scripts/) and contains "
            "SUPABASE_URL and SUPABASE_SERVICE_KEY.\n"
            "\nTo check the overlap logic without a database, run the test "
            "suite instead:\n    python -m pytest tests/test_shift_overlap.py",
            file=sys.stderr,
        )
        return 2

    return audit(args.org_id, args.warnings, strict=args.strict)


if __name__ == "__main__":
    raise SystemExit(main())