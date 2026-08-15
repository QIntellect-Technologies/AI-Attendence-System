"""
support_db_billing.py
───────────────────────────────────────────────────────────────────────────────
Subscriptions and invoices.

Split out of the original monolithic support_db.py. See support_db.py for
the backward-compatible facade that re-exports everything below.
"""

from datetime import date, timedelta, datetime, timezone
import json
from math import radians, sin, cos, atan2, sqrt
from typing import Optional, Any, Callable
import time
import bcrypt
import secrets
import string
import hashlib
import uuid
import os
from supabase_client import get_supabase, reset_supabase_client
from logger_config import get_logger
from support_db_core import _invalidate_tenant_meta_cache
from support_invite_message import build_client_invite_message
from support_db_attendance_gate import (
    resolve_timing_source,
    resolve_manual_instruction_window,
    resolve_branch_default_window,
    resolve_staff_shift_windows,
    resolve_check_in_status,
    resolve_check_out_status,
    _get_branch_timezone,
    _find_approved_overtime,
)
from support_db_attendance_settings import list_pending_manual_instructions_for_branch
from support_db_time_utils import is_missing_table_or_column as _table_missing
import support_db_attendance_exceptions as _attendance_exceptions
from zoneinfo import ZoneInfo, available_timezones
from core.vertical_templates import (
    list_vertical_templates as _list_vertical_templates,
    normalize_vertical_payload,
    build_vertical_config,
    get_vertical_template,
)

def get_subscription(org_id: str) -> Optional[dict]:
    sb = get_supabase()
    result = (
        sb.table('subscriptions')
        .select('*')
        .eq('org_id', org_id)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None

def upsert_subscription(org_id: str, billing_cycle: str,
                         period_start: str, period_end: str) -> dict:
    sb = get_supabase()
    result = sb.table('subscriptions').upsert({
        'org_id':                org_id,
        'billing_cycle':         billing_cycle,
        'current_period_start':  period_start,
        'current_period_end':    period_end,
    }, on_conflict='org_id').execute()

    if not result.data:
        raise RuntimeError('Failed to upsert subscription')
    return result.data[0]

def list_invoices(org_id: str) -> list[dict]:
    sb = get_supabase()
    result = (
        sb.table('invoices')
        .select('*')
        .eq('org_id', org_id)
        .order('created_at', desc=True)
        .execute()
    )
    return result.data or []

def create_invoice(org_id: str, amount: float, due_date: str,
                   grace_period_days: int = 7, notes: str = None) -> dict:
    """Phase 2, Step 6. Creates first invoice for a new org."""
    sb = get_supabase()
    result = sb.table('invoices').insert({
        'org_id':           org_id,
        'amount':           amount,
        'due_date':         due_date,
        'grace_period_days': grace_period_days,
        'status':           'pending',
        'notes':            notes,
    }).execute()

    if not result.data:
        raise RuntimeError('Failed to create invoice')
    return result.data[0]

def mark_invoice_paid(invoice_id: str, marked_by_user_id: str,
                      notes: str = None) -> dict:
    """Section 6, Step 3: QIntellect team marks invoice paid after payment received."""
    sb = get_supabase()
    from datetime import datetime, timezone
    result = (
        sb.table('invoices')
        .update({
            'status':           'paid',
            'paid_at':          datetime.now(timezone.utc).isoformat(),
            'marked_paid_by':   marked_by_user_id,
            'notes':            notes,
        })
        .eq('id', invoice_id)
        .in_('status', ['pending', 'overdue'])  # only mark unpaid invoices
        .execute()
    )

    if not result.data:
        raise ValueError('Invoice not found or already paid/cancelled')

    invoice = result.data[0]
    # Org status (active/grace_period/suspended) is computed from the latest
    # invoice and cached for _STATUS_CACHE_TTL_SECONDS. Without invalidating
    # here, an org that was suspended for non-payment stayed "suspended" in
    # the Support Dashboard for up to a minute after this invoice was paid,
    # even though this is the only path Support has to restore a suspended
    # org's access. Invalidate immediately so restore is instant.
    _invalidate_tenant_meta_cache(str(invoice.get('org_id') or ''))
    return invoice
    # Org status (active/grace_period/suspended) is computed from the latest
    # invoice and cached for _STATUS_CACHE_TTL_SECONDS. Without invalidating
    # here, an org that was suspended for non-payment stayed "suspended" in
    # the Support Dashboard for up to a minute after this invoice was paid,
    # even though this is the only path Support has to restore a suspended
    # org's access. Invalidate immediately so restore is instant.
    _invalidate_tenant_meta_cache(str(invoice.get('org_id') or ''))
    return invoice