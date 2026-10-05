"""
Cloud sync / node-identity constants.

These back cloud_db.py and sync_worker.py. SUPABASE_URL and
SUPABASE_SERVICE_KEY are intentionally NOT re-exposed here: supabase_client.py
reads them directly from the environment and fails fast if unset, which is
already correct secret-handling behavior and is left untouched.
"""
import os

__all__ = [
    "NODE_ID", "SUPABASE_STORAGE_BUCKET", "STORAGE_SIGNED_URL_TTL",
    "SYNC_POLL_INTERVAL", "SYNC_ATTENDANCE_BATCH_SIZE", "SYNC_MAX_JOB_RETRIES",
]

NODE_ID = os.environ.get("NODE_ID", "node-default")
SUPABASE_STORAGE_BUCKET = os.environ.get("SUPABASE_STORAGE_BUCKET", "attendai-media")
STORAGE_SIGNED_URL_TTL = int(os.environ.get("STORAGE_SIGNED_URL_TTL", "3600"))
SYNC_POLL_INTERVAL = int(os.environ.get("SYNC_POLL_INTERVAL", "30"))
SYNC_ATTENDANCE_BATCH_SIZE = int(os.environ.get("SYNC_ATTENDANCE_BATCH_SIZE", "100"))
SYNC_MAX_JOB_RETRIES = int(os.environ.get("SYNC_MAX_JOB_RETRIES", "3"))
