"""
concurrency.py
──────────────────────────────────────────────────────────────────────────────
Parallel fan-out that degrades to sequential execution instead of failing.

Why this exists
---------------
Several read paths (client bootstrap, CCTV live tracking, dashboard overview)
fan out into independent Supabase queries and want them run concurrently so
wall time is the slowest query rather than the sum of all of them. Each of
those call sites used its own ThreadPoolExecutor.

On a constrained host that is not safe. Under cPanel/CloudLinux the whole
account shares one LVE process/thread ceiling, and every Passenger worker,
onnxruntime session and pool worker counts against it. When the ceiling is
reached, `ThreadPoolExecutor.submit()` raises:

    RuntimeError: can't start new thread

from `threading.Thread.start()`, *before* any Future exists. That means
try/except around `future.result()` never runs, and a route whose whole
purpose was to degrade gracefully returns a 500 instead. Observed in
production on /api/client/bootstrap and /api/cctv/live-tracking.

Reusing one long-lived module-level executor does not fix this either: the
threads that exhaust the cap belong to other processes, so the first
`submit()` on a fresh pool is exactly where it breaks.

Contract
--------
`gather()` runs the jobs concurrently when threads are available, and runs
them one after another when they are not. Callers get the same results either
way; only latency changes. Nothing here raises `RuntimeError: can't start new
thread` up to the route layer.

Set PARALLEL_FETCH_DISABLED=1 to force sequential mode everywhere, which is a
reasonable default on shared hosting.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Callable

from logger_config import get_logger

logger = get_logger(__name__)

# Hard off-switch. On a host where threads are scarce, paying the pool setup
# cost only to fall back on every request is pure overhead.
_DISABLED = os.environ.get('PARALLEL_FETCH_DISABLED', '').strip() in {'1', 'true', 'True'}

# After a thread-exhaustion failure, stop attempting parallel execution for a
# while. Without this every request re-pays the cost of discovering the cap is
# still hit, which is the moment the host is under the most pressure.
_COOLDOWN_SECONDS = float(os.environ.get('PARALLEL_FETCH_COOLDOWN_SECONDS', '60'))

_state_lock = threading.Lock()
_parallel_blocked_until = 0.0


def _parallel_allowed() -> bool:
    if _DISABLED:
        return False
    with _state_lock:
        return time.monotonic() >= _parallel_blocked_until


def _block_parallel(reason: str) -> None:
    global _parallel_blocked_until
    with _state_lock:
        _parallel_blocked_until = time.monotonic() + _COOLDOWN_SECONDS
    logger.warning(
        'Thread pool unavailable (%s); running fetches sequentially for the '
        'next %.0fs. This is a degraded-performance path, not an error.',
        reason, _COOLDOWN_SECONDS,
    )


def _run_sequential(
    jobs: dict[str, Callable[[], Any]],
) -> tuple[dict[str, Any], dict[str, BaseException]]:
    results: dict[str, Any] = {}
    errors: dict[str, BaseException] = {}
    for key, fn in jobs.items():
        try:
            results[key] = fn()
        except BaseException as exc:  # noqa: BLE001 - re-raised by caller if essential
            errors[key] = exc
    return results, errors


def gather(
    jobs: dict[str, Callable[[], Any]],
    *,
    max_workers: int | None = None,
) -> tuple[dict[str, Any], dict[str, BaseException]]:
    """Run every zero-argument callable in `jobs` and collect outcomes.

    Returns (results, errors). A key appears in exactly one of the two. A job
    raising does not affect any other job, in either execution mode.

    Concurrency is best-effort. If the host cannot start threads, everything
    runs sequentially and the caller sees identical results.
    """
    if not jobs:
        return {}, {}

    if len(jobs) == 1 or not _parallel_allowed():
        return _run_sequential(jobs)

    import concurrent.futures

    workers = max_workers or len(jobs)
    workers = max(1, min(workers, len(jobs)))

    results: dict[str, Any] = {}
    errors: dict[str, BaseException] = {}
    futures: dict[str, Any] = {}
    pending: dict[str, Callable[[], Any]] = {}
    pool = None

    try:
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    except RuntimeError as exc:
        _block_parallel(str(exc))
        return _run_sequential(jobs)

    try:
        for key, fn in jobs.items():
            if pending:
                # Already fell back mid-submit; do not start new threads.
                pending[key] = fn
                continue
            try:
                futures[key] = pool.submit(fn)
            except RuntimeError as exc:
                # Thread cap hit partway through. Everything not yet submitted
                # runs inline; already-submitted work is still collected below,
                # so no job runs twice.
                _block_parallel(str(exc))
                pending[key] = fn

        for key, future in futures.items():
            try:
                results[key] = future.result()
            except BaseException as exc:  # noqa: BLE001
                errors[key] = exc
    finally:
        if pool is not None:
            pool.shutdown(wait=True)

    if pending:
        seq_results, seq_errors = _run_sequential(pending)
        results.update(seq_results)
        errors.update(seq_errors)

    return results, errors


def gather_or_raise(
    jobs: dict[str, Callable[[], Any]],
    *,
    essential: tuple[str, ...] = (),
    max_workers: int | None = None,
) -> tuple[dict[str, Any], dict[str, BaseException]]:
    """`gather()`, but re-raise the first failure among `essential` keys.

    Use for fan-outs where some results have no safe default (e.g. the
    organization row itself) while the rest can degrade.
    """
    results, errors = gather(jobs, max_workers=max_workers)
    for key in essential:
        if key in errors:
            raise errors[key]
    return results, errors
