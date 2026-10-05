from __future__ import annotations

import os
import sys

from supabase_client import get_supabase


def main():
    print("SUPABASE_URL (env):", os.environ.get("SUPABASE_URL"))
    print("Using supabase client to check attendance_capture_settings.sync_delay_minutes...")
    try:
        sb = get_supabase()
    except Exception as exc:
        print("Failed to create supabase client:", exc)
        sys.exit(2)

    try:
        # Querying information_schema via PostgREST isn't available; attempt a select
        # of the column — if it doesn't exist the API will return an error.
        res = sb.table("attendance_capture_settings").select("sync_delay_minutes").limit(1).execute()
        print("Query OK. Response:", res)
    except Exception as exc:
        print("Query failed (column likely missing or insufficient privileges):", exc)
        sys.exit(3)


if __name__ == "__main__":
    main()
