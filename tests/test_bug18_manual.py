"""
Manual verification for Bug #18 (Bug B — overnight attendance bucketing).

Run this ON THE LOCAL NODE MACHINE, from the local_node project root
(the directory that CONTAINS the local_node/ package folder), e.g.:

    cd /path/to/local_node_project
    python3 test_bug18_manual.py --branch <branch_id> --people-type staff --name "Malaika Irshad"

WARNING: this writes real rows into your on-disk attendance_buffer.db.
Point it at a TEST branch, not a live production branch, or clean up
the inserted rows afterward (query printed at the end).

What it does — no system clock changes, no waiting for real midnight:
  1. Looks up the person's real person_code from staff_embeddings.
  2. Simulates a check-in detection at 22:58 (inside a 22:00-06:00
     Night shift's check-in window) by passing an explicit
     event_dt_utc — record_attendance_local uses that instead of
     datetime.now() when it's provided.
  3. Simulates a check-out detection at 00:15 the NEXT calendar day.
  4. Reads back attendance_buffer directly and asserts BOTH legs
     landed on the SAME row (same attendance_date = the check-in's
     calendar day), rather than the checkout creating a second,
     bogus row on the next day.
"""
from __future__ import annotations

import argparse
import sqlite3
from datetime import datetime, timezone

from local_node import local_db
from local_node.config_store import DB_PATH


def find_person_code(branch_id: str, people_type: str, staff_name: str) -> str:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT DISTINCT person_code FROM staff_embeddings "
            "WHERE branch_id = ? AND people_type = ? AND full_name = ? LIMIT 1",
            (branch_id, people_type, staff_name),
        ).fetchone()
    if not row:
        raise SystemExit(
            f"No enrolled person_code found for {staff_name!r} "
            f"(branch={branch_id}, people_type={people_type}). "
            "Check the name/branch/people_type match staff_embeddings exactly."
        )
    return row["person_code"]


def dump_rows(branch_id: str, people_type: str, person_code: str) -> list[sqlite3.Row]:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT attendance_date, marked_at, check_in_confirmed, "
            "check_out_marked_at, check_out_confirmed FROM attendance_buffer "
            "WHERE branch_id = ? AND people_type = ? AND person_code = ? "
            "ORDER BY attendance_date",
            (branch_id, people_type, person_code),
        ).fetchall()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--branch", required=True, help="branch_id, e.g. 'main'")
    ap.add_argument("--people-type", default="staff")
    ap.add_argument("--name", required=True, help="staff_name as enrolled, e.g. 'Malaika Irshad'")
    ap.add_argument("--checkin-date", default="2026-08-25", help="YYYY-MM-DD calendar day the shift starts")
    args = ap.parse_args()

    person_code = find_person_code(args.branch, args.people_type, args.name)
    print(f"Resolved person_code={person_code!r} for {args.name!r}")

    checkin_dt = datetime.fromisoformat(f"{args.checkin_date}T22:58:00").replace(tzinfo=timezone.utc)
    checkout_dt = datetime.fromisoformat(f"{args.checkin_date}T22:58:00").replace(tzinfo=timezone.utc)
    # bump to the next calendar day, 00:15
    from datetime import timedelta
    checkout_dt = checkin_dt.replace(hour=0, minute=15, second=0) + timedelta(days=1)

    print(f"\n--- Simulating CHECK-IN at {checkin_dt.isoformat()} ---")
    result_in = local_db.record_attendance_local(
        branch_id=args.branch,
        people_type=args.people_type,
        person_code=person_code,
        staff_name=args.name,
        confidence=0.99,
        source="camera",
        camera_id="TEST-CAM",
        event_dt_utc=checkin_dt,
    )
    print("record_attendance_local ->", result_in)

    print(f"\n--- Simulating CHECK-OUT at {checkout_dt.isoformat()} (next calendar day) ---")
    result_out = local_db.record_attendance_local(
        branch_id=args.branch,
        people_type=args.people_type,
        person_code=person_code,
        staff_name=args.name,
        confidence=0.99,
        source="camera",
        camera_id="TEST-CAM",
        event_dt_utc=checkout_dt,
    )
    print("record_attendance_local ->", result_out)

    rows = dump_rows(args.branch, args.people_type, person_code)
    print(f"\n--- attendance_buffer rows for {args.name} ---")
    for r in rows:
        print(dict(r))

    print("\n--- VERDICT ---")
    if len(rows) == 1 and rows[0]["check_in_confirmed"] and rows[0]["check_out_confirmed"]:
        print("PASS — single row, both legs confirmed on the check-in's calendar day.")
    else:
        print("FAIL — expected exactly one row with both legs confirmed. "
              "If you see two rows (one per calendar day), the checkout was "
              "misfiled as a new check-in and the bug has regressed.")

    print(
        "\nCleanup (run manually if this was a test branch, to remove the rows "
        "this script inserted):\n"
        f"  DELETE FROM attendance_buffer WHERE branch_id='{args.branch}' "
        f"AND people_type='{args.people_type}' AND person_code='{person_code}' "
        f"AND attendance_date IN ('{args.checkin_date}');"
    )


if __name__ == "__main__":
    main()