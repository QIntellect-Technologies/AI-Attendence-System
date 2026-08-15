"""
supabase_client.py
──────────────────────────────────────────────────────────────────────────────
Thread-safe Supabase service-role client singleton for Flask.

Service-role key stays server-side only. Browsers/installers/local nodes never
receive it.
"""

import os
import threading
from supabase import create_client, Client
from logger_config import get_logger

logger = get_logger(__name__)

_client: Client | None = None
_client_lock = threading.Lock()


def get_supabase() -> Client:
    """Return a process-wide Supabase client using a double-checked lock."""
    global _client
    if _client is not None:
        return _client

    with _client_lock:
        if _client is not None:
            return _client

        url = os.environ.get('SUPABASE_URL', '').strip()
        key = os.environ.get('SUPABASE_SERVICE_KEY', '').strip()

        if not url or not key:
            raise RuntimeError(
                'SUPABASE_URL and SUPABASE_SERVICE_KEY must be set. '
                'Add them to your .env file. Never commit them to git.'
            )

        _client = create_client(url, key)
        logger.info('✓ Supabase service-role client ready')
        return _client


def reset_supabase_client() -> None:
    """Drop the cached client after a retryable HTTP/protocol failure."""
    global _client
    with _client_lock:
        _client = None
    logger.warning('Supabase client reset; next request will reconnect')
