# """
# supabase_client.py
# ──────────────────────────────────────────────────────────────────────────────
# Thread-safe Supabase service-role client singleton for Flask.

# Service-role key stays server-side only. Browsers/installers/local nodes never
# receive it.
# """

# import os
# import threading
# from supabase import create_client, Client
# from logger_config import get_logger

# logger = get_logger(__name__)

# _client: Client | None = None
# _client_lock = threading.Lock()


# def get_supabase() -> Client:
#     """Return a process-wide Supabase client using a double-checked lock."""
#     global _client
#     if _client is not None:
#         return _client

#     with _client_lock:
#         if _client is not None:
#             return _client

#         url = os.environ.get('SUPABASE_URL', '').strip()
#         key = os.environ.get('SUPABASE_SERVICE_KEY', '').strip()

#         if not url or not key:
#             raise RuntimeError(
#                 'SUPABASE_URL and SUPABASE_SERVICE_KEY must be set. '
#                 'Add them to your .env file. Never commit them to git.'
#             )

#         _client = create_client(url, key)
#         logger.info('✓ Supabase service-role client ready')
#         return _client


# def reset_supabase_client() -> None:
#     """Drop the cached client after a retryable HTTP/protocol failure."""
#     global _client
#     with _client_lock:
#         _client = None
#     logger.warning('Supabase client reset; next request will reconnect')

"""
supabase_client.py
──────────────────────────────────────────────────────────────────────────────
Thread-safe Supabase service-role client singleton for Flask.

Service-role key stays server-side only. Browsers/installers/local nodes never
receive it.
"""

import os
import threading
from supabase import create_client, Client, ClientOptions
from logger_config import get_logger

logger = get_logger(__name__)

_client: Client | None = None
_client_lock = threading.Lock()

# No timeout was previously set here, so postgrest-py/httpx fell back to
# their own defaults. On a healthy connection that's invisible; during a
# Supabase-side slowdown (degraded gateway, congested region, etc.) a
# single query can hang far longer than a dashboard request should ever
# wait, and several such calls in sequence (RPC attempt -> summary ->
# branches -> per-branch shift distribution) can stack into tens of
# seconds. A bounded timeout here makes that fail fast instead, so
# _execute_supabase's retry/cache-fallback logic actually gets a chance
# to run rather than the whole request just hanging.
#
# Override via env var if 5s is ever too aggressive/lenient for your
# region's baseline latency.
_SUPABASE_TIMEOUT_SECONDS = float(os.environ.get('SUPABASE_CLIENT_TIMEOUT_SECONDS', '5'))


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

        _client = create_client(
            url,
            key,
            options=ClientOptions(postgrest_client_timeout=_SUPABASE_TIMEOUT_SECONDS),
        )
        logger.info(
            '✓ Supabase service-role client ready (timeout=%ss)',
            _SUPABASE_TIMEOUT_SECONDS,
        )
        return _client


def reset_supabase_client() -> None:
    """Drop the cached client after a retryable HTTP/protocol failure."""
    global _client
    with _client_lock:
        _client = None
    logger.warning('Supabase client reset; next request will reconnect')