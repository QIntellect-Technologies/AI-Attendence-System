"""
One-time backfill: reset dashboard_scope to 'branch' (org/branch-wide) for
every existing client_staff row that is already role='admin' but still
carries dashboard_scope='team' from before this fix existed.

Why this is needed: update_client_staff was patched to force
dashboard_scope='branch' whenever a row's role resolves to 'admin', but
that only fires on the NEXT write to a row — it does not retroactively
touch rows that were already promoted to admin before the patch landed.
Any such row is still silently limited to a "team" view (their own
subordinates only, excluding themselves — see get_team_scope_ids's
docstring in client_dashboard_auth.py) despite having full admin
privileges and every module. This script closes that gap for existing
data in one pass, across every org, without requiring someone to
manually open and re-save each affected staff member's record.

Safe to re-run: only touches rows matching role='admin' AND
dashboard_scope='team' — already-correct rows (dashboard_scope='branch'
or null) are left untouched, so running this twice is a no-op the second
time.

Usage:
    python backfill_admin_dashboard_scope.py            # dry run (default)
    python backfill_admin_dashboard_scope.py --apply     # actually writes
"""
from __future__ import annotations

import sys

from dotenv import load_dotenv

# Mirrors app.py's own startup sequence — supabase_client.get_supabase()
# reads SUPABASE_URL/SUPABASE_SERVICE_KEY from the process environment and
# does not load .env itself; app.py normally does this for it. This script
# runs standalone (no app.py import), so it has to do the same load here,
# before importing supabase_client, or get_supabase() raises even when a
# valid .env file is sitting right next to this script.
load_dotenv()

from supabase_client import get_supabase


def find_stale_admin_rows():
    sb = get_supabase()
    resp = (
        sb.table("client_staff")
        .select("id, org_id, name, email, role, dashboard_scope")
        .eq("role", "admin")
        .eq("dashboard_scope", "team")
        .execute()
    )
    return resp.data or []


def apply_backfill(rows: list[dict]) -> int:
    sb = get_supabase()
    updated = 0
    for row in rows:
        sb.table("client_staff").update({"dashboard_scope": "branch"}).eq("id", row["id"]).execute()
        updated += 1
    return updated


def main() -> None:
    dry_run = "--apply" not in sys.argv

    rows = find_stale_admin_rows()

    if not rows:
        print("No stale admin rows found (nothing has role='admin' and dashboard_scope='team'). Nothing to do.")
        return

    print(f"Found {len(rows)} admin row(s) still stuck at dashboard_scope='team':")
    for row in rows:
        label = row.get("name") or row.get("email") or row["id"]
        print(f"  - {label}  (org_id={row['org_id']}, staff_id={row['id']})")

    if dry_run:
        print("\nDry run only — no changes written. Re-run with --apply to fix these rows.")
        return

    updated = apply_backfill(rows)
    print(f"\nUpdated {updated} row(s) to dashboard_scope='branch'.")


if __name__ == "__main__":
    main()