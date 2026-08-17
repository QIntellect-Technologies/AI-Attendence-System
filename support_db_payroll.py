# """
# support_db_payroll.py
# ───────────────────────────────────────────────────────────────────────────────
# Payroll policy, paid/pending status tracking, payroll-period attendance/leave
# aggregation, and the paginated tenant payroll API.

# Split out of the original monolithic support_db.py. See support_db.py for
# the backward-compatible facade that re-exports everything below.
# """

# from datetime import date, timedelta, datetime, timezone
# import json
# import re
# from math import radians, sin, cos, atan2, sqrt
# from typing import Optional, Any, Callable
# import time
# import bcrypt
# import secrets
# import string
# import hashlib
# import uuid
# import os
# from shared.logging import logger
# from supabase_client import get_supabase, reset_supabase_client
# from logger_config import get_logger
# from support_db_core import _execute_supabase
# from support_invite_message import build_client_invite_message
# from support_db_attendance_gate import (
#     resolve_timing_source,
#     resolve_manual_instruction_window,
#     resolve_branch_default_window,
#     resolve_staff_shift_windows,
#     resolve_check_in_status,
#     resolve_check_out_status,
#     _get_branch_timezone,
#     _find_approved_overtime,
#     # [Fix-5] pure/lookup helpers reused by _resolve_short_leave_hours_batch
#     # below so it can reimplement resolve_timing_source's own precedence
#     # locally against pre-batched data, without touching or caching inside
#     # support_db_attendance_gate.py itself -- that module also backs LIVE
#     # check-in/out gating (mark_client_staff_attendance,
#     # record_cloud_camera_attendance), where a stale cached shift/capture-
#     # setting could misclassify a real check-in. Keeping the batching
#     # entirely on the payroll side means this optimization can never affect
#     # live attendance marking.
#     _normalize_people_type,
#     _window_from_shift,
#     _get_shift,
#     _capture_settings,
#     _half_day_window,
# )
# from support_db_core import _cache_get, _cache_set_for
# from support_db_attendance_settings import list_pending_manual_instructions_for_branch
# from support_db_time_utils import is_missing_table_or_column as _table_missing
# import support_db_attendance_exceptions as _attendance_exceptions
# from zoneinfo import ZoneInfo, available_timezones
# import payroll_engine
# from core.vertical_templates import (
#     list_vertical_templates as _list_vertical_templates,
#     normalize_vertical_payload,
#     build_vertical_config,
#     get_vertical_template,
# )

# # [Fix-4] Remembers which entry of `safe_staff_selects` (in
# # get_client_payroll_page) actually worked for this org last time, so a
# # tenant on a degraded/older schema doesn't re-probe up to 5 columns × 3
# # filter combos on every single page load once we already know which
# # variant lands. Same dict[str, tuple[float, value]] + monotonic-expiry
# # shape as support_db_core._ORG_CACHE -- reuses that module's _cache_get/
# # _cache_set_for rather than a bespoke cache, so this follows the same
# # convention as every other tenant-meta cache in the codebase. Schema
# # doesn't change at runtime for a tenant in practice, so the TTL here is
# # long; a wrong/stale entry just falls through to the full ladder and
# # re-learns, it never hard-fails.
# _PAYROLL_STAFF_SELECT_VARIANT_TTL_SECONDS = 600.0
# _PAYROLL_STAFF_SELECT_VARIANT_CACHE: dict[str, tuple[float, tuple]] = {}

# # [Fix-6] breakdown_by_staff (+ present_days_by_staff + paid_staff_ids) for
# # CLOSED pay periods only -- period_end already in the past, so the
# # attendance/leave/overtime data compute_payroll_breakdown draws on cannot
# # change from a normal revisit of the same page. The current/open period
# # is NEVER cached (see the period_end < today() gate at its one call site)
# # and always computes live. mark_payroll_paid/mark_payroll_pending
# # invalidate this per-org below, since a paid/pending flip changes
# # paid_staff_ids for an otherwise-closed period.
# _PAYROLL_BREAKDOWN_CACHE_TTL_SECONDS = 300.0
# _PAYROLL_BREAKDOWN_CACHE: dict[str, tuple[float, dict]] = {}

# def _invalidate_payroll_breakdown_cache(org_id: str) -> None:
#     prefix = f'{str(org_id)}:'
#     for key in list(_PAYROLL_BREAKDOWN_CACHE.keys()):
#         if key.startswith(prefix):
#             _PAYROLL_BREAKDOWN_CACHE.pop(key, None)

# _DEFAULT_PAYROLL_POLICY = {
#     'otRatePerHour': 0,
#     'defaultSalary': 0,
#     'perDayRateBasis': 'calendar_days',
#     'fixedWorkingDaysPerMonth': 26,
#     'lateComingPolicy': {'mode': 'occurrence_threshold', 'thresholdOccurrences': 3},
#     'shortLeavePolicy': {'dayFraction': 0.5},
#     'leaveTypeRules': {},
#     # Annual per-leave-type paid-day quota, e.g. {'annual': 12, 'sick': 6}.
#     # Keys mirror leaveTypeRules 1:1 (see PayrollModule's Payroll Rules
#     # modal, the only writer of both maps). A type missing here has no
#     # configured quota yet -- callers must treat that as "unknown", not 0,
#     # so an unconfigured type doesn't silently show "0 remaining" days.
#     'leaveTypeQuotas': {},
#     # Org/branch-configurable named allowance types, e.g.
#     # {'transport': {'label': 'Transport', 'mode': 'fixed', 'value': 3000}}.
#     # 'mode' is 'fixed' (flat PKR) or 'percent' (of basic_salary). Applying
#     # one of these to a specific staff member happens on salary_configs.
#     # applied_allowances, not here -- this is only the org/branch-scoped
#     # catalog of what allowance types exist and their default math, mirroring
#     # leaveTypeRules' shape/precedence exactly (see get_payroll_policy).
#     'allowanceTypes': {},
# }

# # payroll_policy_overrides stores one row per (org, branch) or (org, staff)
# # override, disambiguated by which of branch_id/staff_id is "real" on that
# # row. branch_id/staff_id are declared NOT NULL with this sentinel as their
# # default -- deliberately NOT NULL, because save_payroll_policy's upsert
# # targets a plain UNIQUE(org_id, branch_id, staff_id) constraint via
# # on_conflict='org_id,branch_id,staff_id', and standard SQL unique
# # constraints treat NULL as distinct from every other NULL. If the unused
# # column were left NULL, two saves of the same branch override would never
# # collide on conflict -- Postgres would just insert a second row instead of
# # updating the first, and which one a later `.limit(1)` read returns would
# # be undefined. Using a sentinel instead of NULL keeps the constraint a
# # real, non-partial unique index that upsert can target directly.
# _PAYROLL_OVERRIDE_NO_SCOPE = ''

# def _org_default_payroll_policy(org_id: str) -> dict:
#     org_key = str(org_id)
#     try:
#         def _query():
#             return (
#                 get_supabase()
#                 .table('client_onboarding_configs')
#                 .select('payroll_policy')
#                 .eq('org_id', org_key)
#                 .limit(1)
#             )
#         result = _execute_supabase('get_payroll_policy', _query)
#         rows = result.data or []
#         stored = rows[0].get('payroll_policy') if rows else None
#         if isinstance(stored, dict) and stored:
#             return {**_DEFAULT_PAYROLL_POLICY, **stored}
#     except Exception as exc:
#         if not _table_missing(exc, 'client_onboarding_configs'):
#             logger.exception('get_payroll_policy failed for org=%s', org_key)
#     return dict(_DEFAULT_PAYROLL_POLICY)

# def _payroll_policy_override(org_id: str, *, branch_id: str | None = None, staff_id: str | None = None) -> dict | None:
#     """One row per (org, branch) or (org, staff) override, stored in
#     payroll_policy_overrides. Table is optional — orgs that never set a
#     branch/individual override never need it to exist; missing-table is
#     treated as 'no override' rather than an error, same resilience pattern
#     salary_configs uses elsewhere in this module."""
#     org_key = str(org_id)
#     try:
#         def _query():
#             q = get_supabase().table('payroll_policy_overrides').select('policy').eq('org_id', org_key)
#             if staff_id:
#                 q = q.eq('staff_id', str(staff_id)).eq('branch_id', _PAYROLL_OVERRIDE_NO_SCOPE)
#             else:
#                 q = q.eq('branch_id', str(branch_id)).eq('staff_id', _PAYROLL_OVERRIDE_NO_SCOPE)
#             return q.limit(1)
#         result = _execute_supabase('get_payroll_policy_override', _query)
#         rows = result.data or []
#         stored = rows[0].get('policy') if rows else None
#         return stored if isinstance(stored, dict) and stored else None
#     except Exception as exc:
#         if not _table_missing(exc, 'payroll_policy_overrides'):
#             logger.exception('payroll_policy_override lookup failed for org=%s', org_key)
#         return None

# def resolve_effective_ot_rate(salary_config: dict | None, policy: dict) -> float:
#     """Single source of truth for 'what OT rate actually applies to this
#     staff member': their own per-staff override (salary_configs.ot_rate)
#     if set (nonzero), else the resolved policy default for their scope
#     (individual > branch > org -- see get_payroll_policy). Every call site
#     that computes OT pay or displays an OT rate must go through this --
#     duplicating this fallback inline is exactly how the org-first/
#     staff-first precedence bug happened before (two independent copies of
#     the same `or` expression, one fixed and one not). app.py imports this
#     rather than re-implementing it."""
#     salary_config = salary_config or {}
#     return float(salary_config.get('ot_rate') or policy.get('otRatePerHour') or 0)


# def resolve_effective_allowances(applied_allowances: dict | None, policy: dict, basic_salary: float) -> tuple[list[dict], float]:
#     """Single source of truth for 'what allowances actually apply to this
#     staff member and for how much' -- every call site that needs the
#     itemized breakdown or the total allowance amount must go through this
#     rather than re-deriving it, same rule as resolve_effective_ot_rate above.

#     applied_allowances: salary_configs.applied_allowances for this staff
#     member -- {'transport': {'enabled': True, 'overrideValue': 4000}, ...}.
#     A type the staff member hasn't been given is simply absent/not enabled
#     here; it never applies just because it exists in the org catalog.

#     policy: the resolved PayrollPolicy for this staff member's scope (org >
#     branch > staff -- see get_payroll_policy), whose 'allowanceTypes' is the
#     catalog of what each key means (label, fixed/percent mode, default
#     value). A key present in applied_allowances but no longer in the
#     catalog (deleted from Payroll Rules after being applied to someone) is
#     skipped rather than guessed at -- no silent stale amount.

#     Returns (items, total) where items is the itemized list ready for
#     display -- [{'key', 'label', 'mode', 'value', 'amount'}, ...] -- and
#     total is the sum, ready to fold into net_pay alongside the legacy flat
#     'allowances' column (kept separately as an "Other / Manual Adjustment"
#     line -- see _tenant_salary_map_row).
#     """
#     applied = applied_allowances if isinstance(applied_allowances, dict) else {}
#     catalog = policy.get('allowanceTypes')
#     catalog = catalog if isinstance(catalog, dict) else {}

#     items: list[dict] = []
#     total = 0.0
#     for key, entry in applied.items():
#         if not isinstance(entry, dict) or not entry.get('enabled'):
#             continue
#         type_def = catalog.get(key)
#         if not isinstance(type_def, dict):
#             continue
#         mode = type_def.get('mode') if type_def.get('mode') in ('fixed', 'percent', 'none') else 'fixed'
#         # overrideValue, if present (including 0 -- an explicit per-person
#         # override to zero is different from "no override"), wins over the
#         # org/branch-configured default value for this type.
#         value = entry.get('overrideValue')
#         value = float(value) if value is not None else float(type_def.get('value') or 0)
#         if mode == 'percent':
#             amount = round(float(basic_salary) * value / 100.0, 2)
#         elif mode == 'none':
#             amount = 0.0
#         else:
#             amount = round(value, 2)
#         items.append({
#             'key': key,
#             'label': type_def.get('label') or key,
#             'mode': mode,
#             'value': value,
#             'amount': amount,
#         })
#         total += amount
#     return items, round(total, 2)


# def get_payroll_policy(org_id: str, branch_id: str | None = None, staff_id: str | None = None) -> dict:
#     """Effective policy for a staff member/branch: individual override wins
#     over branch override wins over the org-wide default. Callers that just
#     want the org default (e.g. the Payroll Rules modal's base editor) pass
#     neither branch_id nor staff_id, same as before this change."""
#     policy = _org_default_payroll_policy(org_id)
#     if branch_id:
#         branch_override = _payroll_policy_override(org_id, branch_id=branch_id)
#         if branch_override:
#             policy = {**policy, **branch_override}
#     if staff_id:
#         staff_override = _payroll_policy_override(org_id, staff_id=staff_id)
#         if staff_override:
#             policy = {**policy, **staff_override}
#     return policy

# def get_leave_type_rules(org_id: str, branch_id: str | None = None) -> dict:
#     """Effective leave-type paid/unpaid map for org_id (+ branch override,
#     if any) -- the same org > branch precedence get_payroll_policy uses,
#     minus the staff_id tier: nothing in this codebase edits leaveTypeRules
#     at individual scope, only org-wide or per-branch (see PayrollModule's
#     Payroll Rules modal, which is the only writer).

#     This is a read-only projection, not a separate table -- leaveTypeRules
#     stays stored inside PayrollPolicy (support_db_payroll's existing
#     storage), so payroll_engine.compute_payroll_breakdown and every leave
#     surface (dashboard Leave Management filter, mobile leave-request form)
#     always agree on which leave types exist and whether they're paid.
#     Splitting this into its own table would risk the two drifting apart;
#     this function exists purely so leave-facing call sites (leave routes,
#     the mobile leave blueprint) can ask "which leave types are configured"
#     without importing or touching the rest of PayrollPolicy (salary, OT,
#     late-coming) they have no business reading.
#     """
#     policy = get_payroll_policy(org_id, branch_id=branch_id)
#     rules = policy.get('leaveTypeRules')
#     return rules if isinstance(rules, dict) else {}

# def get_leave_type_allocations(org_id: str, branch_id: str | None = None) -> dict:
#     """Effective leaveTypeRules + leaveTypeQuotas together, one policy read
#     instead of two -- GET /api/leaves/types is the single call the Leave
#     Management History tab makes to learn both "which leave types exist"
#     and "how many paid days each type grants per year". Same org > branch
#     precedence as get_leave_type_rules (see that function's docstring);
#     kept as a thin wrapper around it rather than duplicating the lookup.
#     """
#     policy = get_payroll_policy(org_id, branch_id=branch_id)
#     rules = policy.get('leaveTypeRules')
#     quotas = policy.get('leaveTypeQuotas')
#     return {
#         'leaveTypeRules': rules if isinstance(rules, dict) else {},
#         'leaveTypeQuotas': quotas if isinstance(quotas, dict) else {},
#     }

# def save_payroll_policy(org_id: str, policy: dict, branch_id: str | None = None, staff_id: str | None = None) -> dict:
#     """Whole-object replace, not a merge — the frontend always sends the
#     complete policy, so a partial merge here would let stale keys linger.

#     branch_id/staff_id: when given, this writes a scoped override instead
#     of the org-wide default (see get_payroll_policy for the fallback
#     chain). staff_id takes precedence if both are somehow passed, matching
#     the read-side precedence."""
#     org_key = str(org_id)
#     if not org_key:
#         raise ValueError('organization_id is required to save payroll policy')

#     if branch_id or staff_id:
#         # branch_id/staff_id are NOT NULL on this table (sentinel
#         # _PAYROLL_OVERRIDE_NO_SCOPE fills the unused one) so the
#         # UNIQUE(org_id, branch_id, staff_id) constraint the upsert below
#         # targets actually dedups branch-vs-branch and staff-vs-staff
#         # saves instead of silently inserting a new row every time — see
#         # _PAYROLL_OVERRIDE_NO_SCOPE's docstring for why NULL can't be
#         # used here.
#         payload = {
#             'org_id': org_key,
#             'branch_id': str(branch_id) if branch_id and not staff_id else _PAYROLL_OVERRIDE_NO_SCOPE,
#             'staff_id': str(staff_id) if staff_id else _PAYROLL_OVERRIDE_NO_SCOPE,
#             'policy': policy,
#             'updated_at': datetime.now(timezone.utc).isoformat(),
#         }

#         def _upsert_override():
#             return (
#                 get_supabase()
#                 .table('payroll_policy_overrides')
#                 .upsert(payload, on_conflict='org_id,branch_id,staff_id')
#             )
#         _execute_supabase('save_payroll_policy_override', _upsert_override)
#         # A branch/staff override changes the effective OT rate + leave
#         # rules for whatever closed periods that scope's breakdown cache
#         # (_PAYROLL_BREAKDOWN_CACHE, keyed per-org — see its module-level
#         # comment) may already hold. Same invalidation mark_payroll_paid/
#         # pending already do for a paid-status flip; a rules change is no
#         # different and was previously missing this call, so a save here
#         # could silently keep serving pre-change numbers for up to
#         # _PAYROLL_BREAKDOWN_CACHE_TTL_SECONDS.
#         _invalidate_payroll_breakdown_cache(org_key)
#         return policy

#     payload = {
#         'org_id': org_key,
#         'payroll_policy': policy,
#         'updated_at': datetime.now(timezone.utc).isoformat(),
#     }

#     def _upsert():
#         return (
#             get_supabase()
#             .table('client_onboarding_configs')
#             .upsert(payload, on_conflict='org_id')
#         )
#     _execute_supabase('save_payroll_policy', _upsert)
#     _invalidate_payroll_breakdown_cache(org_key)
#     return policy

# def get_paid_payroll_periods(org_id: str, period_start: str, period_end: str) -> set[str]:
#     """staff_ids marked paid for a period that overlaps [period_start, period_end]."""
#     from support_db_attendance_dashboard import _support_clean_text
#     org_key = str(org_id)
#     try:
#         def _query():
#             return (
#                 get_supabase()
#                 .table('payroll_payments')
#                 .select('staff_id')
#                 .eq('org_id', org_key)
#                 .eq('period_start', period_start)
#                 .eq('period_end', period_end)
#             )
#         result = _execute_supabase('get_paid_payroll_periods', _query)
#         return {_support_clean_text(row.get('staff_id')) for row in (result.data or []) if row.get('staff_id')}
#     except Exception as exc:
#         if not _table_missing(exc, 'payroll_payments'):
#             logger.exception('get_paid_payroll_periods failed for org=%s', org_key)
#         return set()

# def mark_payroll_paid(
#     org_id: str,
#     staff_id: str,
#     period_start: str,
#     period_end: str,
#     breakdown: dict | None = None,
# ) -> None:
#     """breakdown: optional payroll_engine.PayrollBreakdown.to_dict() for this
#     staff member/period. When supplied, unpaid_leave_days/late_count are
#     frozen as first-class columns and the full breakdown is kept for audit —
#     this is what makes a Paid period immutable against later attendance
#     corrections, instead of silently recomputing forever."""
#     org_key = str(org_id)
#     payload = {
#         'org_id': org_key,
#         'staff_id': str(staff_id),
#         'period_start': period_start,
#         'period_end': period_end,
#         'paid_at': datetime.now(timezone.utc).isoformat(),
#     }
#     if breakdown:
#         payload['unpaid_leave_days'] = breakdown.get('unpaid_leave_days', 0)
#         payload['late_count'] = breakdown.get('late_count', 0)
#         payload['breakdown'] = breakdown

#     def _upsert():
#         return (
#             get_supabase()
#             .table('payroll_payments')
#             .upsert(payload, on_conflict='org_id,staff_id,period_start,period_end')
#         )
#     try:
#         _execute_supabase('mark_payroll_paid', _upsert)
#     except Exception as exc:
#         if _table_missing(exc, 'payroll_payments'):
#             logger.exception(
#                 'mark_payroll_paid failed for org=%s: payroll_payments table is missing',
#                 org_key,
#             )
#             raise RuntimeError(
#                 'Unable to mark payroll paid: payroll_payments table is missing in Supabase schema. '
#                 'Apply the migration to create public.payroll_payments.'
#             ) from exc
#         raise
#     # [Fix-6] A paid/pending flip changes paid_staff_ids for whatever
#     # period this staff member belongs to -- if that period is closed and
#     # already cached, the cached paid_staff_ids set is now stale. Clearing
#     # is coarse (whole org, not just this one period) but cheap and simple;
#     # the next request for any closed period just recomputes once.
#     _invalidate_payroll_breakdown_cache(org_key)

# def mark_payroll_pending(org_id: str, staff_id: str, period_start: str, period_end: str) -> None:
#     org_key = str(org_id)

#     def _delete():
#         return (
#             get_supabase()
#             .table('payroll_payments')
#             .delete()
#             .eq('org_id', org_key)
#             .eq('staff_id', str(staff_id))
#             .eq('period_start', period_start)
#             .eq('period_end', period_end)
#         )
#     try:
#         _execute_supabase('mark_payroll_pending', _delete)
#     except Exception as exc:
#         if _table_missing(exc, 'payroll_payments'):
#             logger.exception(
#                 'mark_payroll_pending failed for org=%s: payroll_payments table is missing',
#                 org_key,
#             )
#             raise RuntimeError(
#                 'Unable to mark payroll pending: payroll_payments table is missing in Supabase schema. '
#                 'Apply the migration to create public.payroll_payments.'
#             ) from exc
#         raise
#     _invalidate_payroll_breakdown_cache(org_key)

# _PAYROLL_ATTENDANCE_COLUMNS_BASE = (
#     'staff_id, timestamp, status, day_status, branch_id, check_out_timestamp, capture_channel'
# )

# _PAYROLL_ATTENDANCE_COLUMNS_WITH_DECISION = (
#     _PAYROLL_ATTENDANCE_COLUMNS_BASE
#     + ', branch_id, check_out_status, check_in_payroll_decision, check_out_payroll_decision'
# )

# def get_staff_attendance_for_payroll_period(
#     org_id: str,
#     branch_id: str | list[str] | tuple[str, ...],
#     period_start: str,
#     period_end: str,
#     staff_ids: list[str] | tuple[str, ...] | None = None,
# ) -> dict[str, list[dict]]:
#     """Batched, branch-scoped attendance for an entire pay period, grouped
#     by staff_id — the payroll counterpart to get_client_staff_attendance_history
#     (which is staff-scoped, mobile-portal shaped). Returns only the fields
#     payroll_engine consumes.

#     Selects check_out_status plus the two payroll-decision columns added by
#     migration_add_payroll_decision_fields.sql. Falls back to the pre-Phase-1
#     column set if that migration hasn't been applied to this org's database
#     yet (same "degrade instead of break" pattern resolve_attendance_exception
#     already uses for resolved_by/resolved_at) — so this function keeps
#     working whether or not the migration has landed, and the two can ship in
#     either order without a hard dependency.
#     """
#     from support_db_attendance_dashboard import _support_clean_text
#     org_key = str(org_id)
#     filtered_staff_ids = [str(s) for s in (staff_ids or []) if _support_clean_text(s)]
#     has_staff_filter = staff_ids is not None

#     def _query(columns: str):
#         q = (
#             get_supabase()
#             .table('attendance')
#             .select(columns)
#             .eq('org_id', org_key)
#             .gte('timestamp', f'{period_start}T00:00:00')
#             .lte('timestamp', f'{period_end}T23:59:59')
#         )
#         if isinstance(branch_id, (list, tuple)):
#             branch_ids = [str(b) for b in branch_id if _support_clean_text(b)]
#             if not branch_ids:
#                 raise ValueError('branch_id list must contain at least one valid branch id')
#             q = q.in_('branch_id', branch_ids)
#         else:
#             q = q.eq('branch_id', str(branch_id))
#         if has_staff_filter:
#             if filtered_staff_ids:
#                 q = q.in_('staff_id', filtered_staff_ids)
#             else:
#                 q = q.eq('staff_id', '__invalid_staff_id__')
#         return q

#     try:
#         result = _execute_supabase(
#             'payroll_attendance_period',
#             lambda: _query(_PAYROLL_ATTENDANCE_COLUMNS_WITH_DECISION),
#         )
#     except Exception as exc:
#         if _table_missing(exc, 'check_out_status') or _table_missing(exc, 'check_in_payroll_decision') \
#                 or _table_missing(exc, 'check_out_payroll_decision'):
#             logger.warning(
#                 'get_staff_attendance_for_payroll_period: payroll-decision columns not '
#                 'found (migration_add_payroll_decision_fields.sql not yet applied?) — '
#                 'falling back to the pre-migration column set for org=%s',
#                 org_key,
#             )
#             result = _execute_supabase(
#                 'payroll_attendance_period_legacy',
#                 lambda: _query(_PAYROLL_ATTENDANCE_COLUMNS_BASE),
#             )
#         else:
#             raise
#     rows = result.data or []

#     sb = get_supabase()
#     branch_zones: dict[str, ZoneInfo | None] = {}

#     grouped: dict[str, list[dict]] = {}
#     # [Fix-5] Rows needing short-leave-hours resolution are deferred and
#     # resolved in ONE batched pass after this loop (see
#     # _resolve_short_leave_hours_batch below) instead of calling
#     # compute_short_leave_hours per row here -- that function alone does a
#     # client_staff fetch plus up to ~5 more queries (manual override,
#     # half-day leave, shift, branch-default capture-settings) EVERY TIME,
#     # so a period with N short-leave days for the same staff member
#     # re-fetched that same staff's shift/config N times. `pending` holds a
#     # direct reference to each dict already appended to `grouped`, so the
#     # batch resolver can mutate shortLeaveHours/shiftScheduledHours in
#     # place once results are known.
#     pending: list[dict] = []
#     for row in rows:
#         ts = str(row.get('timestamp') or '')
#         staff_id = _support_clean_text(row.get('staff_id'))
#         if not staff_id or not ts:
#             continue
#         row_branch_id = str(row.get('branch_id') or '')
#         if not row_branch_id:
#             continue
#         zone = branch_zones.get(row_branch_id)
#         if zone is None:
#             zone = _get_branch_timezone(sb, org_key, row_branch_id)
#             branch_zones[row_branch_id] = zone

#         day_status = row.get('day_status') or 'present'
#         checkout_ts = row.get('check_out_timestamp')
#         entry = {
#             'date': _attendance_exceptions.local_date_str_iso(ts, zone),
#             'branch_id': row.get('branch_id'),
#             'branchId': row.get('branch_id'),
#             'checkInStatus': row.get('status'),
#             'dayStatus': day_status,
#             'checkOutStatus': row.get('check_out_status'),
#             'checkInPayrollDecision': row.get('check_in_payroll_decision'),
#             'checkOutPayrollDecision': row.get('check_out_payroll_decision'),
#             'checkOutTimestamp': checkout_ts,
#             'captureChannel': row.get('capture_channel'),
#             'shortLeaveHours': 0.0,
#             'shiftScheduledHours': 0.0,
#         }
#         grouped.setdefault(staff_id, []).append(entry)
#         # Only worth resolving the staff member's shift window at all for
#         # rows that actually need it -- every other dayStatus ignores
#         # these two fields entirely.
#         if day_status == 'short_leave' and checkout_ts:
#             pending.append({
#                 'entry': entry,
#                 'staff_id': staff_id,
#                 'branch_id': row_branch_id,
#                 'checkout_ts': checkout_ts,
#                 'zone': zone,
#             })

#     if pending:
#         _resolve_short_leave_hours_batch(org_key, pending)

#     return grouped


# def _resolve_short_leave_hours_batch(org_id: str, pending: list[dict]) -> None:
#     """Batched counterpart to _attendance_exceptions.compute_short_leave_hours.
#     Mutates each pending['entry'] in place, setting shortLeaveHours/
#     shiftScheduledHours, for every attendance row already classified
#     day_status='short_leave'.

#     Reimplements resolve_timing_source's own 5-tier precedence
#     (manual override > half-day leave > staff shift > branch default >
#     simple mode) locally against data fetched ONCE per distinct staff/
#     shift/branch/date-range here, rather than calling resolve_timing_source
#     itself (which re-queries per call, no caching, and is also the live
#     check-in/out gate -- see the import comment above for why this stays
#     fully separate from that module). Any single item that can't be
#     resolved from the batched data falls back to the original per-row
#     compute_short_leave_hours for THAT item only, so this can only get
#     faster, never less correct, than before.
#     """
#     from support_db_attendance_dashboard import _support_clean_text

#     org_key = str(org_id)
#     sb = get_supabase()

#     staff_ids = sorted({p['staff_id'] for p in pending if p['staff_id']})
#     if not staff_ids:
#         return

#     # One query for every staff member's timing fields, instead of one
#     # query per short-leave ROW (a staff member with 3 short-leave days in
#     # the period previously triggered 3 identical lookups of themselves).
#     staff_by_id: dict[str, dict] = {}
#     try:
#         staff_result = _execute_supabase(
#             'payroll_short_leave_staff_batch',
#             lambda: (
#                 sb.table('client_staff')
#                 .select('id, people_type, shift_id_ref, person_code, check_in_grace_override, check_out_grace_override')
#                 .eq('org_id', org_key)
#                 .in_('id', staff_ids)
#             ),
#         )
#         for row in staff_result.data or []:
#             sid = _support_clean_text(row.get('id'))
#             if sid:
#                 staff_by_id[sid] = row
#     except Exception:
#         logger.exception('Batched staff-fields fetch failed for short-leave resolution, org=%s', org_key)
#         staff_by_id = {}

#     # One query for every referenced shift, instead of one per row.
#     shift_ids = sorted({
#         _support_clean_text(staff_by_id[sid].get('shift_id_ref'))
#         for sid in staff_by_id
#         if staff_by_id[sid].get('shift_id_ref')
#     })
#     shifts_by_id: dict[str, dict] = {}
#     if shift_ids:
#         try:
#             shift_result = _execute_supabase(
#                 'payroll_short_leave_shift_batch',
#                 lambda: (
#                     sb.table('shifts')
#                     .select('id, check_in_time, grace_minutes, check_out_time, checkout_grace_minutes, sync_delay_minutes, is_active')
#                     .eq('org_id', org_key)
#                     .in_('id', shift_ids)
#                     .eq('is_active', True)
#                 ),
#             )
#             for row in shift_result.data or []:
#                 rid = _support_clean_text(row.get('id'))
#                 if rid:
#                     shifts_by_id[rid] = row
#         except Exception:
#             logger.exception('Batched shift fetch failed for short-leave resolution, org=%s', org_key)

#     # Local date per pending item, needed for manual-instruction/half-day
#     # lookups below. Computed once here rather than inside the loop twice.
#     for item in pending:
#         checkout_dt = _attendance_exceptions._parse_iso_dt(item['checkout_ts'])
#         item['checkout_dt'] = checkout_dt
#         item['local_date'] = (
#             checkout_dt.astimezone(item['zone']).date() if checkout_dt else None
#         )
#     dated_items = [p for p in pending if p['local_date'] is not None]
#     if not dated_items:
#         return
#     min_date = min(p['local_date'] for p in dated_items)
#     max_date = max(p['local_date'] for p in dated_items)

#     # One query covering the whole period's date range for manual
#     # overrides, instead of one query per (staff, date) pair.
#     manual_by_staff_date: dict[tuple[str, str], dict] = {}
#     try:
#         manual_result = _execute_supabase(
#             'payroll_short_leave_manual_batch',
#             lambda: (
#                 sb.table('manual_attendance_instructions')
#                 .select('staff_id, attendance_date, check_in_time, check_in_grace_minutes, check_out_time, check_out_grace_minutes')
#                 .eq('org_id', org_key)
#                 .in_('staff_id', staff_ids)
#                 .gte('attendance_date', min_date.isoformat())
#                 .lte('attendance_date', max_date.isoformat())
#             ),
#         )
#         for row in manual_result.data or []:
#             sid = _support_clean_text(row.get('staff_id'))
#             adate = _support_clean_text(row.get('attendance_date'))
#             if sid and adate:
#                 manual_by_staff_date[(sid, adate)] = row
#     except Exception:
#         logger.exception('Batched manual-instruction fetch failed for short-leave resolution, org=%s', org_key)

#     # One query covering the whole period's date range for approved
#     # half-day leave, instead of one query per (staff, date) pair. Filtered
#     # precisely per-item afterwards since this is a date-RANGE overlap,
#     # not an exact match.
#     half_day_leaves: list[dict] = []
#     try:
#         half_day_result = _execute_supabase(
#             'payroll_short_leave_half_day_batch',
#             lambda: (
#                 sb.table('leave_requests')
#                 .select('staff_id, half_day_period, leave_type, start_date, end_date')
#                 .eq('org_id', org_key)
#                 .eq('status', 'approved')
#                 .not_.is_('half_day_period', 'null')
#                 .in_('staff_id', staff_ids)
#                 .lte('start_date', max_date.isoformat())
#                 .gte('end_date', min_date.isoformat())
#             ),
#         )
#         half_day_leaves = half_day_result.data or []
#     except Exception:
#         logger.exception('Batched half-day-leave fetch failed for short-leave resolution, org=%s', org_key)

#     half_day_by_staff: dict[str, list[dict]] = {}
#     for row in half_day_leaves:
#         sid = _support_clean_text(row.get('staff_id'))
#         if sid:
#             half_day_by_staff.setdefault(sid, []).append(row)

#     capture_settings_cache: dict[tuple[str, str], dict | None] = {}
#     half_day_window_cache: dict[tuple[str, str, str], dict | None] = {}

#     def _resolve_window(item: dict) -> dict | None:
#         staff_id = item['staff_id']
#         branch_id = item['branch_id']
#         staff = staff_by_id.get(staff_id)
#         if not staff:
#             return None
#         people_type = _normalize_people_type(staff.get('people_type'))
#         local_date = item['local_date']
#         date_key = local_date.isoformat()

#         # Tier 1 -- manual override
#         manual = manual_by_staff_date.get((staff_id, date_key))
#         if manual and (manual.get('check_in_time') or manual.get('check_out_time')):
#             return {
#                 'check_in_time': manual.get('check_in_time'),
#                 'check_in_grace_minutes': manual.get('check_in_grace_minutes') or 0,
#                 'capture_check_out': bool(manual.get('check_out_time')),
#                 'check_out_time': manual.get('check_out_time'),
#                 'check_out_grace_minutes': manual.get('check_out_grace_minutes') or 0,
#             }

#         # Tier 2 -- approved half-day leave overlapping this date
#         for leave in half_day_by_staff.get(staff_id, []):
#             start = leave.get('start_date')
#             end = leave.get('end_date')
#             if start and end and str(start) <= date_key <= str(end) and leave.get('half_day_period'):
#                 hd_key = (branch_id, people_type, str(leave['half_day_period']))
#                 if hd_key not in half_day_window_cache:
#                     try:
#                         half_day_window_cache[hd_key] = _half_day_window(
#                             sb, org_key, branch_id, people_type, str(leave['half_day_period']),
#                         )
#                     except Exception:
#                         half_day_window_cache[hd_key] = None
#                 window = half_day_window_cache[hd_key]
#                 if window:
#                     return window
#                 break

#         # Tiers 3-4 -- staff's assigned shift, else branch default
#         shift_id = _support_clean_text(staff.get('shift_id_ref'))
#         if shift_id and shift_id in shifts_by_id:
#             return _window_from_shift(
#                 shifts_by_id[shift_id],
#                 staff.get('check_in_grace_override'),
#                 staff.get('check_out_grace_override'),
#             )

#         settings_key = (branch_id, people_type)
#         if settings_key not in capture_settings_cache:
#             try:
#                 capture_settings_cache[settings_key] = _capture_settings(sb, org_key, branch_id, people_type)
#             except Exception:
#                 capture_settings_cache[settings_key] = None
#         settings = capture_settings_cache[settings_key]
#         if settings and settings.get('mode') == 'shift' and settings.get('default_shift_id'):
#             default_shift_id = _support_clean_text(settings['default_shift_id'])
#             default_shift = shifts_by_id.get(default_shift_id)
#             if default_shift is None:
#                 try:
#                     default_shift = _get_shift(sb, org_key, default_shift_id)
#                     if default_shift:
#                         shifts_by_id[default_shift_id] = default_shift
#                 except Exception:
#                     default_shift = None
#             if default_shift:
#                 return _window_from_shift(
#                     default_shift,
#                     settings.get('default_check_in_grace_override'),
#                     settings.get('default_check_out_grace_override'),
#                 )

#         # Tier 5 -- simple-mode branch baseline
#         if settings and settings.get('mode') == 'simple' and settings.get('check_in_time'):
#             return {
#                 'check_in_time': settings['check_in_time'],
#                 'check_in_grace_minutes': settings.get('check_in_grace_minutes') or 0,
#                 'capture_check_out': bool(settings.get('capture_check_out')),
#                 'check_out_time': settings.get('check_out_time'),
#                 'check_out_grace_minutes': settings.get('check_out_grace_minutes') or 0,
#             }
#         return None

#     for item in dated_items:
#         try:
#             window = _resolve_window(item)
#             if not window or not window.get('check_out_time') or not window.get('check_in_time'):
#                 raise ValueError('no resolvable window')

#             out_parts = str(window['check_out_time']).split(':')
#             in_parts = str(window['check_in_time']).split(':')
#             if len(out_parts) < 2 or len(in_parts) < 2:
#                 raise ValueError('malformed shift time')
#             target_minutes = int(out_parts[0]) * 60 + int(out_parts[1])
#             check_in_minutes = int(in_parts[0]) * 60 + int(in_parts[1])
#             shift_minutes = target_minutes - check_in_minutes
#             if shift_minutes <= 0:
#                 shift_minutes += 24 * 60
#             shift_hours = round(shift_minutes / 60.0, 2)

#             checkout_dt = item['checkout_dt']
#             local_dt = checkout_dt if checkout_dt.tzinfo else checkout_dt.replace(tzinfo=timezone.utc)
#             local = local_dt.astimezone(item['zone'])
#             actual_minutes = local.hour * 60 + local.minute

#             short_minutes = target_minutes - actual_minutes
#             short_hours = round(short_minutes / 60.0, 2) if short_minutes > 0 else 0.0

#             item['entry']['shortLeaveHours'] = short_hours
#             item['entry']['shiftScheduledHours'] = shift_hours
#         except Exception:
#             # Safety net: anything unresolved from batched data falls back
#             # to the original, always-correct per-row path for just this
#             # one item, rather than silently leaving 0.0/0.0.
#             try:
#                 short_hours, shift_hours = _attendance_exceptions.compute_short_leave_hours(
#                     org_id=org_key,
#                     branch_id=item['branch_id'],
#                     staff_id=item['staff_id'],
#                     check_out_timestamp=item['checkout_ts'],
#                     branch_zone=item['zone'],
#                 )
#                 item['entry']['shortLeaveHours'] = short_hours
#                 item['entry']['shiftScheduledHours'] = shift_hours
#             except Exception:
#                 logger.exception(
#                     'Short-leave hours fallback also failed for staff=%s org=%s',
#                     item['staff_id'], org_key,
#                 )


# def get_approved_leaves_for_payroll_period(
#     org_id: str,
#     branch_id: str | list[str] | tuple[str, ...],
#     period_start: str,
#     period_end: str,
#     staff_ids: list[str] | tuple[str, ...] | None = None,
# ) -> dict[str, list[dict]]:
#     """Approved leaves overlapping the pay period, grouped by staff_id, with
#     day-counts clipped to the period boundary."""
#     from support_db_attendance_dashboard import _support_clean_text
#     org_key = str(org_id)
#     filtered_staff_ids = [str(s) for s in (staff_ids or []) if _support_clean_text(s)]
#     has_staff_filter = staff_ids is not None

#     def _query():
#         q = (
#             get_supabase()
#             .table('leave_requests')
#             .select('staff_id, leave_type, half_day_period, start_date, end_date, branch_id, reason')
#             .eq('org_id', org_key)
#             .eq('status', 'approved')
#             .lte('start_date', period_end)
#             .gte('end_date', period_start)
#         )
#         if isinstance(branch_id, (list, tuple)):
#             branch_ids = [str(b) for b in branch_id if _support_clean_text(b)]
#             if not branch_ids:
#                 raise ValueError('branch_id list must contain at least one valid branch id')
#             q = q.in_('branch_id', branch_ids)
#         else:
#             q = q.eq('branch_id', str(branch_id))
#         if has_staff_filter:
#             if filtered_staff_ids:
#                 q = q.in_('staff_id', filtered_staff_ids)
#             else:
#                 q = q.eq('staff_id', '__invalid_staff_id__')
#         return q

#     try:
#         result = _execute_supabase('payroll_leave_period', _query)
#         rows = result.data or []
#     except Exception as exc:
#         if not _table_missing(exc, 'leave_requests'):
#             logger.exception(
#                 'get_approved_leaves_for_payroll_period failed for org=%s', org_key,
#             )
#         return {}

#     attendance_ref_re = re.compile(r'attendance_id=([0-9a-f-]{8,})', re.IGNORECASE)
#     linked_attendance_ids: set[str] = set()
#     for leave in rows:
#         reason_text = str(leave.get('reason') or '')
#         match = attendance_ref_re.search(reason_text)
#         if match:
#             linked_attendance_ids.add(match.group(1))

#     payroll_decision_by_attendance: dict[str, str] = {}
#     if linked_attendance_ids:
#         try:
#             attendance_result = _execute_supabase(
#                 'payroll_leave_period.attendance_decisions',
#                 lambda: (
#                     get_supabase()
#                     .table('attendance')
#                     .select('id, check_out_payroll_decision')
#                     .eq('org_id', org_key)
#                     .in_('id', sorted(linked_attendance_ids))
#                 ),
#             )
#             for row in (attendance_result.data or []):
#                 attendance_id = _support_clean_text(row.get('id'))
#                 decision = _support_clean_text(row.get('check_out_payroll_decision')).lower()
#                 if attendance_id and decision:
#                     payroll_decision_by_attendance[attendance_id] = decision
#         except Exception:
#             payroll_decision_by_attendance = {}

#     p_start, p_end = date.fromisoformat(period_start), date.fromisoformat(period_end)
#     grouped: dict[str, list[dict]] = {}
#     for leave in rows:
#         try:
#             l_start = date.fromisoformat(str(leave.get('start_date') or ''))
#             l_end = date.fromisoformat(str(leave.get('end_date') or ''))
#         except (ValueError, TypeError):
#             continue

#         overlap_start, overlap_end = max(l_start, p_start), min(l_end, p_end)
#         if overlap_start > overlap_end:
#             continue

#         leave_type = str(leave.get('leave_type') or 'annual').lower()
#         reason_text = str(leave.get('reason') or '')
#         match = attendance_ref_re.search(reason_text)
#         attendance_id = match.group(1) if match else ''
#         payroll_decision = payroll_decision_by_attendance.get(attendance_id, '') if attendance_id else ''
#         is_attendance_adjustment = attendance_id != '' or leave_type == 'attendance_adjustment'
#         if payroll_decision == 'exclude':
#             continue
#         if payroll_decision == 'include' or is_attendance_adjustment:
#             leave_type = 'unpaid'
#         is_half_day = bool(leave.get('half_day_period'))
#         clipped_days = 0.5 if is_half_day else (overlap_end - overlap_start).days + 1

#         staff_id = _support_clean_text(leave.get('staff_id'))
#         if not staff_id:
#             continue

#         if is_half_day:
#             dates = [overlap_start.isoformat()]
#         else:
#             dates = [
#                 (overlap_start + timedelta(days=offset)).isoformat()
#                 for offset in range((overlap_end - overlap_start).days + 1)
#             ]

#         grouped.setdefault(staff_id, []).append({
#             'leaveType': leave_type,
#             'days': clipped_days,
#             'dates': dates,
#         })
#     return grouped

# def get_approved_overtime_hours_for_payroll_period(
#     org_id: str,
#     branch_id: str | list[str] | tuple[str, ...],
#     period_start: str,
#     period_end: str,
#     staff_ids: list[str] | tuple[str, ...] | None = None,
# ) -> dict[str, float]:
#     """Approved overtime hours per staff_id for a pay period — the payroll
#     counterpart to get_staff_attendance_for_payroll_period /
#     get_approved_leaves_for_payroll_period. Sums overtime_requests.hours
#     for status='approved' rows whose ot_date falls inside
#     [period_start, period_end], grouped by staff_id. This is what actually
#     connects Overtime Management (where a request becomes 'approved') to
#     the Payroll page's OT Hours column — before this, payroll never read
#     overtime_requests at all.

#     branch_id must be the real backend branch UUID, same as the attendance
#     and leave functions above — never the UI-facing branchId."""
#     from support_db_attendance_dashboard import _support_clean_text
#     org_key = str(org_id)
#     filtered_staff_ids = [str(s) for s in (staff_ids or []) if _support_clean_text(s)]
#     has_staff_filter = staff_ids is not None
#     try:
#         def _query():
#             q = (
#                 get_supabase()
#                 .table('overtime_requests')
#                 .select('staff_id, hours, ot_date, branch_id')
#                 .eq('org_id', org_key)
#                 .eq('status', 'approved')
#                 .gte('ot_date', period_start)
#                 .lte('ot_date', period_end)
#             )
#             if isinstance(branch_id, (list, tuple)):
#                 branch_ids = [str(b) for b in branch_id if _support_clean_text(b)]
#                 if not branch_ids:
#                     raise ValueError('branch_id list must contain at least one valid branch id')
#                 q = q.in_('branch_id', branch_ids)
#             else:
#                 q = q.eq('branch_id', str(branch_id))
#             if has_staff_filter:
#                 if filtered_staff_ids:
#                     q = q.in_('staff_id', filtered_staff_ids)
#                 else:
#                     q = q.eq('staff_id', '__invalid_staff_id__')
#             return q
#         result = _execute_supabase('payroll_overtime_period', _query)
#         rows = result.data or []
#     except Exception as exc:
#         if not _table_missing(exc, 'overtime_requests'):
#             logger.exception('get_approved_overtime_hours_for_payroll_period failed for org=%s', org_key)
#         return {}

#     grouped: dict[str, float] = {}
#     for row in rows:
#         staff_id = _support_clean_text(row.get('staff_id'))
#         if not staff_id:
#             continue
#         grouped[staff_id] = grouped.get(staff_id, 0.0) + float(row.get('hours') or 0)
#     return grouped


# def get_local_node_overtime_hours_for_payroll_period(
#     org_id: str,
#     branch_id: str | list[str] | tuple[str, ...],
#     period_start: str,
#     period_end: str,
#     attendance_by_staff: dict[str, list[dict]] | None = None,
#     staff_ids: list[str] | tuple[str, ...] | None = None,
# ) -> dict[str, float]:
#     """Overtime hours from LOCAL-NODE-classified rows only (capture_channel=
#     'local_node', day_status='overtime') -- the local-node counterpart to
#     get_approved_overtime_hours_for_payroll_period, which only sums
#     overtime_requests (the cloud/mobile path via _on_overtime_decided).
#     Local-node overtime never creates an overtime_requests row -- see
#     set_local_node_payroll_decision's docstring -- so this is the only
#     place those hours are computed. Reuses
#     support_db_attendance_exceptions.compute_overtime_hours so both paths
#     share one formula.

#     check_out_payroll_decision == 'exclude' is skipped; null/'include' both
#     count -- same undecided-means-include default payroll_engine applies
#     everywhere else.
#     """
#     import support_db_attendance_exceptions as _exceptions_db

#     grouped = attendance_by_staff if attendance_by_staff is not None else get_staff_attendance_for_payroll_period(
#         org_id,
#         branch_id,
#         period_start,
#         period_end,
#         staff_ids=staff_ids,
#     )
#     branch_zones: dict[str, ZoneInfo | None] = {}

#     totals: dict[str, float] = {}
#     for staff_id, rows in grouped.items():
#         for row in rows:
#             if row.get('dayStatus') != 'overtime' or row.get('captureChannel') != 'local_node':
#                 continue
#             if row.get('checkOutPayrollDecision') == 'exclude':
#                 continue
#             checkout_ts = row.get('checkOutTimestamp')
#             if not checkout_ts:
#                 continue

#             row_branch_id = str(row.get('branch_id') or row.get('branchId') or '')
#             if not row_branch_id:
#                 continue

#             zone = branch_zones.get(row_branch_id)
#             if zone is None:
#                 zone = _get_branch_timezone(get_supabase(), str(org_id), row_branch_id)
#                 branch_zones[row_branch_id] = zone

#             hours = _exceptions_db.compute_overtime_hours(
#                 org_id=org_id,
#                 branch_id=row_branch_id,
#                 staff_id=staff_id,
#                 check_out_timestamp=checkout_ts,
#                 branch_zone=zone,
#             )
#             totals[staff_id] = totals.get(staff_id, 0.0) + hours
#     return totals

# def create_client_leave_request(org_id: str, payload: dict) -> dict:
#     from support_db_attendance_dashboard import _map_client_leave, _resolve_owned_backend_branch_id, _support_clean_text
#     from support_db_staff import get_client_staff_member
#     staff_id = _support_clean_text(payload.get('staff_id') or payload.get('staffId') or payload.get('user_id') or payload.get('userId'))
#     if not staff_id:
#         raise ValueError('staff_id/user_id is required')
#     staff = get_client_staff_member(staff_id)
#     if str(staff.get('organization_id')) != str(org_id):
#         raise ValueError('Staff member does not belong to this organization')
#     branch_id = _resolve_owned_backend_branch_id(str(org_id), payload.get('branch_id') or payload.get('branchId') or staff.get('backend_branch_id'))
#     now = datetime.now(timezone.utc).isoformat()

#     leave_type = str(payload.get('leave_type') or payload.get('type') or 'annual').strip().lower()

#     # Half-day is a modifier that can apply to ANY leave category, not a
#     # category of its own -- so whether this request is half-day is read
#     # from an explicit flag (half_day_period being present, or an explicit
#     # half_day/is_half_day/halfDay boolean), never inferred from leave_type.
#     # This is what lets leave_type keep carrying the real category
#     # (annual/sick/...) all the way through to storage, instead of being
#     # overwritten to the literal string 'half_day' and losing the category
#     # (the previous behavior, which forced callers like the mobile apply_leave
#     # route to smuggle the category back in via the free-text `reason` field).
#     half_day_period_raw = _support_clean_text(payload.get('half_day_period') or payload.get('halfDayPeriod'))
#     is_half_day = bool(
#         payload.get('half_day') or payload.get('halfDay') or payload.get('is_half_day')
#         or half_day_period_raw
#         or leave_type == 'half_day'  # back-compat: still honor old-style rows/callers
#     )

#     half_day_period = None
#     half_day_start_time = None
#     half_day_end_time = None
#     if is_half_day:
#         half_day_period = half_day_period_raw
#         if half_day_period not in ('first_half', 'second_half'):
#             raise ValueError("half_day_period must be 'first_half' or 'second_half' for a half-day leave request")
#         if payload.get('start_date') != payload.get('end_date') and (payload.get('startDate') or payload.get('start_date')) != (payload.get('endDate') or payload.get('end_date')):
#             # Half-day leave is defined per single calendar day (that's what
#             # resolve_timing_source._find_approved_half_day_leave checks
#             # against local_date, a single date) — a multi-day span with a
#             # half_day_period would be ambiguous about which day it applies to.
#             raise ValueError('half_day leave requests must have start_date == end_date')
#         half_day_start_time = _support_clean_text(payload.get('half_day_start_time') or payload.get('halfDayStartTime'))
#         half_day_end_time = _support_clean_text(payload.get('half_day_end_time') or payload.get('halfDayEndTime'))
#         # A back-compat row that only ever set leave_type='half_day' (no
#         # real category preserved) has nothing better to fall back to here.
#         if leave_type == 'half_day':
#             leave_type = str(payload.get('category') or 'annual').strip().lower()

#     row = {
#         'org_id': str(org_id),
#         'branch_id': branch_id,
#         'staff_id': staff_id,
#         'user_name': payload.get('user_name') or payload.get('userName') or staff.get('name'),
#         'leave_type': leave_type,
#         'half_day_period': half_day_period,
#         'half_day_start_time': half_day_start_time,
#         'half_day_end_time': half_day_end_time,
#         'start_date': payload.get('start_date') or payload.get('startDate'),
#         'end_date': payload.get('end_date') or payload.get('endDate'),
#         'reason': payload.get('reason') or '',
#         'status': 'pending',
#         'created_at': now,
#         'updated_at': now,
#     }
#     sb = get_supabase()
#     try:
#         result = sb.table('leave_requests').insert(row).execute()
#     except Exception as exc:
#         if _table_missing(exc, 'leave_requests'):
#             raise ValueError('Supabase table leave_requests is missing. Create it before using tenant leave management.') from exc
#         raise
#     if not result.data:
#         raise RuntimeError('Failed to create leave request')
#     mapped = _map_client_leave(result.data[0], {staff_id: staff})

#     # Notify the requester's manager (if one is assigned) AND broadcast to
#     # org admin/HR — this is the one creation path both the mobile
#     # self-service form and the (currently unused) dashboard "add leave"
#     # call go through, so wiring the notification here rather than in each
#     # caller means neither surface can forget it. Soft-fail: a lookup issue
#     # here must never block the leave request itself from being recorded.
#     try:
#         import support_db_hierarchy as _hierarchy_db
#         import support_db_notifications as _notifications_db

#         manager_staff_id = _hierarchy_db.resolve_notification_target(str(org_id), staff_id)
#         employee_name = mapped.get('name') or 'Employee'
#         _notifications_db.create_notification(
#             str(org_id),
#             module_key='leave',
#             event_type='leave_applied',
#             title='Leave request submitted',
#             body=f"{employee_name} applied for {mapped.get('leave_type', 'leave')} leave.",
#             branch_id=branch_id,
#             actor_name=employee_name,
#             target_entity_id=str(mapped.get('id')),
#             target_entity_type='leave_request',
#             target_staff_id=manager_staff_id,
#             also_broadcast=True,
#             metadata={
#                 'leave_id': mapped.get('id'),
#                 'employee_name': employee_name,
#                 'leave_type': mapped.get('leave_type'),
#                 'start_date': mapped.get('start_date'),
#                 'end_date': mapped.get('end_date'),
#             },
#         )
#     except Exception:
#         logger.warning('Failed to create notification for client leave request %s', mapped.get('id'), exc_info=True)

#     return mapped

# def get_client_leave_owned_by_org(leave_id: str, org_id: str) -> dict:
#     """Single org-scoped read, used by the PUT/DELETE routes to check
#     team-scope ownership BEFORE mutating — mirrors the
#     _get_staff_owned_by_org pattern in support_db_hierarchy.py. Raises
#     ValueError (-> 404 via the route) rather than ever leaking whether a
#     leave_id exists in a different org."""
#     from support_db_attendance_dashboard import _map_client_leave
#     sb = get_supabase()
#     result = (
#         sb.table('leave_requests')
#         .select('*')
#         .eq('id', str(leave_id))
#         .eq('org_id', str(org_id))
#         .limit(1)
#         .execute()
#     )
#     if not result.data:
#         raise ValueError('Leave request not found for this organization')
#     return _map_client_leave(result.data[0])

# def update_client_leave_status(leave_id: str, org_id: str, status: str, approved_by: str = 'Admin') -> dict:
#     from support_db_attendance_dashboard import _map_client_leave
#     clean_status = str(status or 'approved').lower()
#     if clean_status not in {'approved', 'rejected', 'pending'}:
#         clean_status = 'approved'
#     now = datetime.now(timezone.utc).isoformat()
#     sb = get_supabase()
#     result = (
#         sb.table('leave_requests')
#         .update({'status': clean_status, 'approved_by': approved_by, 'updated_at': now})
#         .eq('id', str(leave_id))
#         .eq('org_id', str(org_id))
#         .execute()
#     )
#     if not result.data:
#         raise ValueError('Leave request not found for this organization')
#     return _map_client_leave(result.data[0])

# def delete_client_leave_request(leave_id: str, org_id: str) -> bool:
#     sb = get_supabase()
#     result = sb.table('leave_requests').delete().eq('id', str(leave_id)).eq('org_id', str(org_id)).execute()
#     if not result.data:
#         raise ValueError('Leave request not found for this organization')
#     return True

# def _map_client_overtime(row: dict, staff_by_id: dict[str, dict] | None = None, org_id: str | None = None) -> dict:
#     from support_db_attendance_dashboard import _resolve_staff_people_type, _support_clean_text
#     from support_db_staff import _branch_ui_id
#     staff_by_id = staff_by_id or {}
#     staff_id = _support_clean_text(row.get('staff_id') or row.get('user_id') or row.get('client_staff_id'))
#     staff = staff_by_id.get(staff_id, {})
#     backend_branch_id = _support_clean_text(row.get('branch_id') or staff.get('backend_branch_id'))
#     ui_branch_id = _branch_ui_id(str(org_id), backend_branch_id) if org_id and backend_branch_id else None
#     name = row.get('user_name') or row.get('staff_name') or staff.get('name') or 'Unknown'
#     branch_name = row.get('branch_name') or staff.get('branch_name') or ''
#     department = row.get('department') or staff.get('department') or ''
#     people_type = _resolve_staff_people_type(staff)
#     return {
#         **row,
#         'id': row.get('id'),
#         'org_id': row.get('org_id') or row.get('organization_id'),
#         'organization_id': row.get('organization_id') or row.get('org_id'),
#         'user_id': staff_id,
#         'userId': staff_id,
#         'staff_id': staff_id,
#         'staffId': staff_id,
#         'user_name': name,
#         'userName': name,
#         'name': name,
#         'branch_id': ui_branch_id,
#         'branchId': ui_branch_id,
#         'backend_branch_id': backend_branch_id,
#         'backendBranchId': backend_branch_id,
#         'branch_name': branch_name,
#         'branchName': branch_name,
#         'department': department,
#         'people_type': people_type,
#         'peopleType': people_type,
#         'ot_date': row.get('ot_date') or row.get('date') or row.get('overtime_date'),
#         'hours': float(row.get('hours') or 0),
#         'reason': row.get('reason') or '',
#         'status': row.get('status') or 'pending',
#         'approved_by': row.get('approved_by'),
#         'approvedBy': row.get('approved_by'),
#         'created_at': row.get('created_at'),
#         'createdAt': row.get('created_at'),
#         'updated_at': row.get('updated_at'),
#         'updatedAt': row.get('updated_at'),
#     }

# def list_client_overtime_requests(org_id: str, branch_id: object = None, user_id: object = None, status: str | None = None, people_type: str | None = None) -> list[dict]:
#     from support_db_attendance_dashboard import _client_staff_lookup, _resolve_owned_backend_branch_id, _resolve_staff_people_type, _support_clean_text
#     from support_db_organizations import get_organization
#     from support_db_staff import _normalize_people_type
#     get_organization(str(org_id))
#     sb = get_supabase()
#     clean_people_type = _normalize_people_type(people_type, 'staff') if people_type else None
#     try:
#         query = sb.table('overtime_requests').select('*').eq('org_id', str(org_id))
#         branch_backend = _resolve_owned_backend_branch_id(str(org_id), branch_id) if _support_clean_text(branch_id) else None
#         if branch_backend:
#             query = query.eq('branch_id', branch_backend)
#         if _support_clean_text(user_id):
#             query = query.eq('staff_id', _support_clean_text(user_id))
#         if status:
#             query = query.eq('status', str(status).lower())
#         result = query.order('created_at', desc=True).execute()
#     except Exception as exc:
#         if _table_missing(exc, 'overtime_requests'):
#             logger.warning('overtime_requests table is missing; returning empty tenant-scoped overtime list')
#             return []
#         raise
#     rows = result.data or []
#     staff_ids = sorted({_support_clean_text(row.get('staff_id') or row.get('user_id')) for row in rows if _support_clean_text(row.get('staff_id') or row.get('user_id'))})
#     staff_by_id = _client_staff_lookup(str(org_id), staff_ids)

#     if clean_people_type:
#         filtered_rows = []
#         for row in rows:
#             staff_id = _support_clean_text(row.get('staff_id') or row.get('user_id'))
#             staff = staff_by_id.get(staff_id, {})
#             if _resolve_staff_people_type(staff) == clean_people_type:
#                 filtered_rows.append(row)
#         rows = filtered_rows

#     return [_map_client_overtime(row, staff_by_id, org_id) for row in rows]

# def create_client_overtime_request(org_id: str, payload: dict) -> dict:
#     from support_db_attendance_dashboard import _resolve_owned_backend_branch_id, _support_clean_text
#     from support_db_staff import get_client_staff_member
#     staff_id = _support_clean_text(payload.get('staff_id') or payload.get('staffId') or payload.get('user_id') or payload.get('userId'))
#     if not staff_id:
#         raise ValueError('staff_id/user_id is required')
#     staff = get_client_staff_member(staff_id)
#     if str(staff.get('organization_id')) != str(org_id):
#         raise ValueError('Staff member does not belong to this organization')
#     branch_id = _resolve_owned_backend_branch_id(str(org_id), payload.get('branch_id') or payload.get('branchId') or staff.get('backend_branch_id'))
#     now = datetime.now(timezone.utc).isoformat()
#     row = {
#         'org_id': str(org_id),
#         'branch_id': branch_id,
#         'staff_id': staff_id,
#         'user_name': payload.get('user_name') or payload.get('userName') or staff.get('name'),
#         'ot_date': payload.get('ot_date') or payload.get('date') or datetime.now(timezone.utc).date().isoformat(),
#         'hours': float(payload.get('hours') or 0),
#         'reason': payload.get('reason') or '',
#         'status': 'pending',
#         'created_at': now,
#         'updated_at': now,
#     }
#     sb = get_supabase()
#     try:
#         result = sb.table('overtime_requests').insert(row).execute()
#     except Exception as exc:
#         if _table_missing(exc, 'overtime_requests'):
#             raise ValueError('Supabase table overtime_requests is missing. Create it before using tenant overtime management.') from exc
#         raise
#     if not result.data:
#         raise RuntimeError('Failed to create overtime request')
#     return _map_client_overtime(result.data[0], {staff_id: staff}, org_id)

# def get_client_overtime_owned_by_org(overtime_id: str, org_id: str) -> dict:
#     """Single org-scoped read, used by the PUT route to check team-scope
#     ownership BEFORE mutating — see get_client_leave_owned_by_org above."""
#     sb = get_supabase()
#     result = (
#         sb.table('overtime_requests')
#         .select('*')
#         .eq('id', str(overtime_id))
#         .eq('org_id', str(org_id))
#         .limit(1)
#         .execute()
#     )
#     if not result.data:
#         raise ValueError('Overtime request not found for this organization')
#     return _map_client_overtime(result.data[0], org_id=org_id)

# def update_client_overtime_status(overtime_id: str, org_id: str, status: str, approved_by: str = 'Admin') -> dict:
#     clean_status = str(status or 'approved').lower()
#     if clean_status not in {'approved', 'rejected', 'pending'}:
#         clean_status = 'approved'
#     now = datetime.now(timezone.utc).isoformat()
#     sb = get_supabase()
#     result = (
#         sb.table('overtime_requests')
#         .update({'status': clean_status, 'approved_by': approved_by, 'updated_at': now})
#         .eq('id', str(overtime_id))
#         .eq('org_id', str(org_id))
#         .execute()
#     )
#     if not result.data:
#         raise ValueError('Overtime request not found for this organization')
#     return _map_client_overtime(result.data[0], org_id=org_id)

# def get_client_branch_summary(org_id: str, people_type: str | None = None) -> dict:
#     from support_db_attendance_dashboard import get_client_attendance_statistics, list_client_leave_requests
#     from support_db_branches import list_branches
#     from support_db_organizations import get_organization
#     from support_db_staff import _normalize_people_type, list_client_staff
#     org = get_organization(str(org_id))
#     branches = list_branches(str(org_id))
#     clean_people_type = (
#         _normalize_people_type(people_type, "") if people_type else None
#     )
#     now = datetime.now(timezone.utc).isoformat()

#     active_staff = list_client_staff(
#         str(org_id), archived=False, role='staff', people_type=clean_people_type
#     )
#     archived_staff = []
#     try:
#         archived_staff = list_client_staff(
#             str(org_id), archived=True, role='staff', people_type=clean_people_type
#         )
#     except Exception:
#         archived_staff = []

#     staff_by_branch: dict[str, list[dict]] = {}
#     for staff in active_staff:
#         key = str(staff.get('backend_branch_id') or '')
#         staff_by_branch.setdefault(key, []).append(staff)

#     pending_by_branch: dict[str, int] = {}
#     try:
#         for item in list_client_leave_requests(
#             str(org_id), status='pending', people_type=clean_people_type
#         ):
#             key = str(item.get('backend_branch_id') or item.get('branch_id') or '')
#             pending_by_branch[key] = pending_by_branch.get(key, 0) + 1
#     except Exception:
#         pass

#     overtime_by_branch: dict[str, float] = {}
#     try:
#         for item in list_client_overtime_requests(
#             str(org_id), people_type=clean_people_type
#         ):
#             key = str(item.get('backend_branch_id') or item.get('branch_id') or '')
#             overtime_by_branch[key] = overtime_by_branch.get(key, 0.0) + float(item.get('hours') or 0)
#     except Exception:
#         pass

#     rows = []
#     for idx, branch in enumerate(branches, start=1):
#         backend_id = str(branch.get('id'))
#         staff_rows = staff_by_branch.get(backend_id, [])
#         name = branch.get('name') or f'Branch {idx}'
#         city = branch.get('location') or ''
#         staff_count = len(staff_rows)
#         enrolled = sum(1 for item in staff_rows if item.get('is_face_verified'))
#         payroll = sum(float(item.get('salary') or 0) for item in staff_rows)
#         try:
#             stats = get_client_attendance_statistics(str(org_id), branch_id=backend_id)
#         except Exception:
#             stats = {}
#         present = int(stats.get('present_today') or stats.get('unique_users_today') or 0)
#         absent = max(0, staff_count - present)
#         attendance_rate = round((present / staff_count) * 100) if staff_count else 0
#         rows.append({
#             'id': idx,
#             'branchId': idx,
#             'backend_branch_id': backend_id,
#             'backendBranchId': backend_id,
#             'branch_uuid': backend_id,
#             'branchUuid': backend_id,
#             'name': name,
#             'branchName': name,
#             'city': city,
#             'branchCity': city,
#             'maxStaffCapacity': branch.get('max_staff_capacity') or 0,
#             'max_staff_capacity': branch.get('max_staff_capacity') or 0,
#             'staff': staff_count,
#             'staffCount': staff_count,
#             'activeStaff': staff_count,
#             'enrolledStaff': enrolled,
#             'presentToday': present,
#             'absentToday': absent,
#             'attendance': attendance_rate,
#             'attendanceRate': attendance_rate,
#             'payroll': payroll,
#             'revenue': payroll,
#             'late': int(stats.get('late_today') or 0),
#             'lateCount': int(stats.get('late_today') or 0),
#             'pendingLeaves': pending_by_branch.get(backend_id, 0),
#             'overtimeHours': overtime_by_branch.get(backend_id, 0),
#         })

#     total_staff = sum(item['staffCount'] for item in rows)
#     total_present = sum(item['presentToday'] for item in rows)
#     return {
#         'organization_id': str(org_id),
#         'organization_name': org.get('name'),
#         'generated_at': now,
#         'totals': {
#             'branches': len(rows),
#             'staff': total_staff,
#             'activeStaff': total_staff,
#             'enrolledStaff': sum(item['enrolledStaff'] for item in rows),
#             'presentToday': total_present,
#             'absentToday': max(0, total_staff - total_present),
#             'payroll': sum(item['payroll'] for item in rows),
#             'late': sum(item['late'] for item in rows),
#             'pendingLeaves': sum(item['pendingLeaves'] for item in rows),
#             'overtimeHours': sum(item['overtimeHours'] for item in rows),
#             'attendanceRate': round((total_present / total_staff) * 100) if total_staff else 0,
#             'archivedStaff': len(archived_staff),
#         },
#         'branches': rows,
#     }

# def _payroll_text(value: object) -> str:
#     return str(value or '').strip()

# def _payroll_float(value: object, fallback: float = 0.0) -> float:
#     try:
#         return float(value if value is not None and value != '' else fallback)
#     except (TypeError, ValueError):
#         return fallback

# def _payroll_positive_int(value: object, default: int, minimum: int, maximum: int) -> int:
#     try:
#         parsed = int(value)  # type: ignore[arg-type]
#     except (TypeError, ValueError):
#         parsed = default
#     return max(minimum, min(maximum, parsed))

# def _payroll_sort_column(sort_by: object) -> str:
#     key = _payroll_text(sort_by).lower()
#     allowed = {
#         'name': 'name',
#         'staffname': 'name',
#         'employee': 'name',
#         'employeeid': 'employee_id',
#         'code': 'employee_id',
#         # department_name is not guaranteed in every tenant schema; avoid
#         # ordering by optional columns in PostgREST. The mapped row still exposes
#         # department/departmentName after serialization.
#         'department': 'name',
#         'departmentname': 'name',
#         'branch': 'branch_id',
#         'branchname': 'branch_id',
#         'basesalary': 'salary',
#         'basicsalary': 'salary',
#         'salary': 'salary',
#         'netpay': 'salary',
#         'status': 'status',
#         'createdat': 'created_at',
#         'updatedat': 'updated_at',
#     }
#     return allowed.get(key, 'name')

# def get_own_salary_snapshot(org_id: str, staff_id: str) -> dict:
#     """Self-service salary breakdown for exactly one staff member — the
#     mobile HR Assistant's source for salary questions.
 
#     Returns the LAST PROCESSED payroll row on salary_configs, not a live
#     recomputation for the current period — same as what the dashboard
#     Payroll page shows before an admin runs the next payroll cycle. If no
#     salary_configs row exists yet for this staff member, every figure is
#     0 and status is 'Not set' — the caller (support_db_hr_assistant) is
#     expected to say so plainly rather than presenting zeroes as real pay.
#     """
#     org_key, staff_key = str(org_id), str(staff_id)
 
#     def _query_by(column: str):
#         return (
#             get_supabase()
#             .table('salary_configs')
#             .select('*')
#             .eq(column, org_key)
#             .eq('staff_id', staff_key)
#             .limit(1)
#         )
 
#     try:
#         result = _execute_supabase(
#             'get_own_salary_snapshot.organization_id',
#             lambda: _query_by('organization_id'),
#         )
#     except Exception as exc:
#         if 'organization_id' not in str(exc).lower():
#             raise
#         result = _execute_supabase(
#             'get_own_salary_snapshot.org_id',
#             lambda: _query_by('org_id'),
#         )
 
#     rows = result.data or []
#     if not rows:
#         return {
#             'configured': False,
#             'basic_salary': 0.0, 'allowances': 0.0, 'deductions': 0.0,
#             'ot_rate': 0.0, 'net_pay': 0.0,
#             'status': 'Not set', 'last_paid_date': None,
#         }
 
#     row = rows[0]
#     basic_salary = _payroll_float(row.get('basic_salary'))
#     allowances = _payroll_float(row.get('allowances'))
#     deductions = _payroll_float(row.get('deductions'))
#     ot_rate = _payroll_float(row.get('ot_rate'))
#     ot_hours = _payroll_float(row.get('ot_hours'))
#     overtime_amount = _payroll_float(row.get('overtime_amount'), ot_hours * ot_rate)
#     # Same formula as _payroll_page_row's net_pay — do not let this drift.
#     net_pay = max(0.0, basic_salary + allowances + overtime_amount - deductions)
#     status = _payroll_text(row.get('status') or 'Paid') or 'Paid'
#     normalized_status = 'Pending' if status.lower() == 'pending' else 'Paid'
 
#     return {
#         'configured': True,
#         'basic_salary': basic_salary,
#         'allowances': allowances,
#         'deductions': deductions,
#         'ot_rate': ot_rate,
#         'net_pay': net_pay,
#         'status': normalized_status,
#         'last_paid_date': row.get('effective_from') if normalized_status == 'Paid' else None,
#     }


# def _payroll_page_row(
#     org_id: str,
#     staff: dict,
#     branch_lookup: dict[str, dict],
#     branch_ui_lookup: dict[str, int],
#     salary_config: dict | None = None,
#     breakdown: dict | None = None,
#     present_days: int | None = None,
#     paid_staff_ids: set[str] | None = None,
#     effective_ot_rate: float | None = None,
#     policy: dict | None = None,
# ) -> dict:
#     """breakdown: optional payroll_engine.PayrollBreakdown.to_dict() computed
#     live from real attendance/leave/overtime data for the requested period —
#     see get_client_payroll_page. When supplied it is authoritative for
#     deductions/overtime/net_pay; salary_config's own deductions/ot_hours
#     fields become a display-only fallback for un-scoped/no-period requests
#     (e.g. an 'All Branches' view, where a single-branch attendance query
#     isn't resolvable).

#     paid_staff_ids: optional set of staff_ids explicitly marked paid for the
#     requested period (get_paid_payroll_periods) — the real source of truth
#     for 'status' whenever a period was resolved. Falls back to
#     salary_config's manual status field only when no period was requested.

#     policy: this staff member's resolved effective PayrollPolicy (individual
#     > branch > org — see get_client_payroll_page's resolve_policy). Needed
#     to turn salary_config['applied_allowances'] into an actual amount via
#     resolve_effective_allowances — without it, named allowances (fixed/
#     percent) can't be priced and the ALLOWANCES column silently shows only
#     the legacy flat 'allowances' field, same bug class as an unresolved OT
#     rate would be. Caller must pass this; None degrades to "no allowance
#     catalog visible" rather than raising, same resilience posture as an
#     absent salary_config."""
#     from support_db_attendance_dashboard import _resolve_staff_people_type
#     salary_config = salary_config or {}
#     staff_id = _payroll_text(staff.get('id'))
#     people_type = _resolve_staff_people_type(staff)
#     backend_branch_id = _payroll_text(staff.get('branch_id')) or None
#     branch = branch_lookup.get(str(backend_branch_id or '')) or {}
#     branch_name = _payroll_text(staff.get('branch_name') or branch.get('name')) or 'Main Branch'
#     # Department source of truth is public.client_staff.department_name, backed
#     # by optional department_id. A plain client_staff.department column is not
#     # part of the schema contract and must not be used.
#     department = _payroll_text(staff.get('department_name')) or 'Unassigned'

#     basic_salary = _payroll_float(
#         salary_config.get('basic_salary')
#         if salary_config.get('basic_salary') is not None
#         else staff.get('salary')
#     )
#     # Legacy flat number — kept as an "Other / Manual Adjustment" line rather
#     # than migrated away, same as app.py's _tenant_salary_map_row, so a
#     # genuine one-off adjustment someone already has on file doesn't
#     # silently vanish once named allowance types exist.
#     manual_allowance = _payroll_float(salary_config.get('allowances'))
#     applied_allowances = salary_config.get('applied_allowances')
#     applied_allowances = applied_allowances if isinstance(applied_allowances, dict) else {}
#     allowance_items, named_allowance_total = resolve_effective_allowances(
#         applied_allowances, policy or {}, basic_salary,
#     )
#     allowances = manual_allowance + named_allowance_total
#     # ot_rate: raw per-staff override only (0 = none set) — kept as-is so
#     # the frontend can still prefill the "OT Rate Override" edit field with
#     # exactly what's stored, distinct from the resolved rate below.
#     ot_rate = _payroll_float(salary_config.get('ot_rate'))
#     # effective_ot_rate: the rate actually applied to this staff member's
#     # pay — individual override, else their branch's override, else the
#     # org default (see resolve_effective_ot_rate). This is what the "OT
#     # RATE/HR" column should display; falls back to the raw ot_rate above
#     # only if a caller doesn't pass it (defensive, shouldn't happen from
#     # get_client_payroll_page).
#     resolved_ot_rate = _payroll_float(effective_ot_rate) if effective_ot_rate is not None else ot_rate

#     if breakdown is not None:
#         ot_hours = _payroll_float(breakdown.get('overtime_hours'))
#         overtime_amount = _payroll_float(breakdown.get('overtime_amount'))
#         deductions = _payroll_float(breakdown.get('total_deductions'))
#     else:
#         ot_hours = _payroll_float(salary_config.get('ot_hours'))
#         overtime_amount = _payroll_float(salary_config.get('overtime_amount'), ot_hours * ot_rate)
#         deductions = _payroll_float(salary_config.get('deductions'))

#     net_pay = max(0.0, basic_salary + allowances + overtime_amount - deductions)
#     branch_ui_id = branch_ui_lookup.get(str(backend_branch_id or ''))
#     employee_id = _payroll_text(staff.get('employee_id')) or staff_id
#     display_name = _payroll_text(staff.get('name')) or 'Unknown'

#     # Payroll "paid" status must never be read off staff/config rows that
#     # weren't scoped to this period — see mark_payroll_paid/get_paid_payroll_periods.
#     if paid_staff_ids is not None:
#         normalized_status = 'Paid' if staff_id in paid_staff_ids else 'Pending'
#     else:
#         status = _payroll_text(salary_config.get('status') or 'Paid') or 'Paid'
#         normalized_status = 'Pending' if status.lower() == 'pending' else 'Paid'

#     resolved_present_days = _payroll_float(
#         present_days if present_days is not None else salary_config.get('present_days')
#     )

#     cnic = _payroll_text(staff.get('cnic'))

#     result = {
#         'id': salary_config.get('id') or staff_id,
#         'payroll_id': salary_config.get('id') or staff_id,
#         'user_id': staff_id,
#         'staff_id': staff_id,
#         'client_staff_id': staff_id,
#         'employee_id': employee_id,
#         'employeeId': employee_id,
#         'empId': employee_id,
#         'name': display_name,
#         'staff_name': display_name,
#         'staffName': display_name,
#         'people_type': people_type,
#         'peopleType': people_type,
#         'email': staff.get('email'),
#         'cnic': cnic,
#         'designation': staff.get('position') or staff.get('role_name'),
#         'position': staff.get('position') or staff.get('role_name'),
#         'department': department,
#         'department_name': department,
#         'branch_id': branch_ui_id if branch_ui_id is not None else backend_branch_id,
#         'branchId': branch_ui_id if branch_ui_id is not None else backend_branch_id,
#         'backend_branch_id': backend_branch_id,
#         'backendBranchId': backend_branch_id,
#         'branch_uuid': backend_branch_id,
#         'branchUuid': backend_branch_id,
#         'branch_name': branch_name,
#         'branchName': branch_name,
#         'basic_salary': basic_salary,
#         'basicSalary': basic_salary,
#         'base_salary': basic_salary,
#         'baseSalary': basic_salary,
#         'salary': basic_salary,
#         'allowances': allowances,
#         'manual_allowance': manual_allowance,
#         'applied_allowances': applied_allowances,
#         'appliedAllowances': applied_allowances,
#         'allowances_breakdown': allowance_items,
#         'allowancesBreakdown': allowance_items,
#         'deductions': deductions,
#         'ot_rate': ot_rate,
#         'otRate': ot_rate,
#         'effective_ot_rate': resolved_ot_rate,
#         'effectiveOtRate': resolved_ot_rate,
#         'ot_hours': ot_hours,
#         'otHours': ot_hours,
#         'overtime_amount': overtime_amount,
#         'overtimeAmount': overtime_amount,
#         'present_days': resolved_present_days,
#         'presentDays': resolved_present_days,
#         'net_pay': net_pay,
#         'netPay': net_pay,
#         'status': normalized_status,
#         'effective_from': salary_config.get('effective_from'),
#         'effectiveFrom': salary_config.get('effective_from'),
#         'created_at': staff.get('created_at'),
#         'createdAt': staff.get('created_at'),
#         'updated_at': salary_config.get('updated_at') or staff.get('updated_at'),
#         'updatedAt': salary_config.get('updated_at') or staff.get('updated_at'),
#         'organization_id': org_id,
#         'organizationId': org_id,
#     }
#     if breakdown is not None:
#         result['payroll_breakdown'] = breakdown
#     return result



# def get_client_payroll_page(
#     org_id: str,
#     branch_id: object = None,
#     page: object = 1,
#     page_size: object = 250,
#     search: object = None,
#     sort_by: object = 'name',
#     sort_dir: object = 'asc',
#     period_start: object = None,
#     period_end: object = None,
#     people_type: object = None,
# ) -> dict:
#     """Return a UUID-safe, paginated payroll page from Supabase.

#     people_type: same convention as list_client_overtime_requests /
#     get_client_branch_summary -- when given, only staff of that resolved
#     people_type (student/worker/staff/teacher/etc, see
#     support_db_attendance_gate._normalize_people_type) are returned. None
#     (the default) keeps the previous unscoped-by-type behavior. This is a
#     server-side filter, not a display concern, so a "worker" selection can
#     never leak "staff" rows into the page even transiently.

#     Source of truth is public.client_staff.salary. Optional public.salary_configs
#     overlays allowances/deductions/rates. This implementation is intentionally
#     schema-safe: it never queries client_staff.department because that column is
#     not present in all tenant schemas. Department is a display value only and is
#     derived after fetch when available; otherwise it becomes "General".
#     """
#     from support_db_organizations import get_organization
#     from support_db_staff import _client_branch_indexes, _resolve_client_branch
#     org_key = _payroll_text(org_id)
#     if not org_key:
#         raise ValueError('organization_id/orgId is required')

#     clean_people_type = (
#         _normalize_people_type(people_type, '') if people_type else None
#     ) or None

#     # Validates the organization and keeps metadata tenant-scoped/cached.
#     get_organization(org_key)
#     branches, backend_to_ui, branch_by_backend = _client_branch_indexes(org_key)

#     backend_branch_id: str | None = None
#     if _payroll_text(branch_id):
#         branch, _ui_id = _resolve_client_branch(org_key, branch_id)
#         backend_branch_id = _payroll_text(branch.get('id'))

#     page_number = _payroll_positive_int(page, 1, 1, 1_000_000)
#     size = _payroll_positive_int(page_size, 250, 1, 500)
#     start = (page_number - 1) * size
#     end = start + size - 1
#     descending = _payroll_text(sort_dir).lower() == 'desc'

#     requested_sort_column = _payroll_sort_column(sort_by)
#     # Only order by columns that are part of the safe select list. If the UI asks
#     # for department/branch/net salary, the row is still exposed after mapping,
#     # but DB ordering falls back to name so missing optional columns cannot 500.
#     db_sort_column = requested_sort_column if requested_sort_column in {
#         'id', 'branch_id', 'employee_id', 'name', 'email', 'salary', 'status',
#         'created_at', 'updated_at',
#     } else 'name'
#     search_text = _payroll_text(search).replace(',', ' ')

#     safe_staff_selects = [
#         # Contract schema, with CNIC. public.client_staff owns
#         # department_id/department_name plus the identity-document columns
#         # added alongside father_name/father_cnic/father_phone. Tried first;
#         # falls back to the no-cnic variant below on tenants that haven't
#         # migrated yet, same "optional column, never crash" posture as the
#         # rest of this ladder.
#         'id,org_id,branch_id,department_id,department_name,employee_id,name,email,position,role_name,role,people_type,status,is_archived,salary,cnic,created_at,updated_at',
#         # Contract schema. public.client_staff owns department_id/department_name.
#         # Do not query a plain client_staff.department column. It is not part of
#         # the tenant contract and causes PostgREST 42703 errors. people_type is
#         # part of the same stable contract (selected unconditionally elsewhere,
#         # e.g. the short-leave staff batch above), so it's included in every
#         # variant rather than only the top one.
#         'id,org_id,branch_id,department_id,department_name,employee_id,name,email,position,role_name,role,people_type,status,is_archived,salary,created_at,updated_at',
#         # Compatibility with older deployments before role_name was added.
#         'id,org_id,branch_id,department_id,department_name,employee_id,name,email,position,role,people_type,status,is_archived,salary,created_at,updated_at',
#         # Some older tenant schemas do not have position.
#         'id,org_id,branch_id,department_id,department_name,employee_id,name,email,role,people_type,status,is_archived,salary,created_at,updated_at',
#         # Minimal schema; role/is_archived/people_type filtering is applied
#         # only if available.
#         'id,org_id,branch_id,employee_id,name,email,salary,created_at,updated_at',
#         # Last resort. select(*) is safe because it does not name optional columns.
#         '*',
#     ]

#     def _build_staff_query(select_columns: str, include_role_filter: bool, include_archive_filter: bool, include_search: bool):
#         q = (
#             get_supabase()
#             .table('client_staff')
#             .select(select_columns, count='exact')
#             .eq('org_id', org_key)
#         )
#         if include_role_filter:
#             q = q.eq('role', 'staff')
#         if include_archive_filter:
#             q = q.eq('is_archived', False)
#         if backend_branch_id:
#             q = q.eq('branch_id', backend_branch_id)
#         if include_search and search_text:
#             like = f'%{search_text}%'
#             # Only stable text columns are searched server-side. Do not search
#             # department because client_staff.department does not exist here.
#             q = q.or_(f'name.ilike.{like},employee_id.ilike.{like},email.ilike.{like}')
#         return q.order(db_sort_column, desc=descending).range(start, end)

#     staff_result = None
#     last_staff_exc: Exception | None = None
#     winning_variant: tuple | None = None

#     # [Fix-4] Fast path: if we already know which (select_columns,
#     # include_role_filter, include_archive_filter, include_search) combo
#     # worked for this org last time, try ONLY that one first. A healthy-
#     # schema org resolves in a single query instead of the up-to-15-combo
#     # ladder below. If the cached combo no longer works (schema changed
#     # since), this just falls through to the full ladder unchanged --
#     # correctness never depends on the cache being right.
#     cached_variant = _cache_get(_PAYROLL_STAFF_SELECT_VARIANT_CACHE, org_key)
#     if cached_variant is not None:
#         cached_select_columns, cached_include_role_filter, cached_include_archive_filter, cached_include_search = cached_variant
#         try:
#             staff_result = _execute_supabase(
#                 f'client_payroll_page.staff.cached.{cached_select_columns[:24]}',
#                 lambda: _build_staff_query(
#                     cached_select_columns,
#                     cached_include_role_filter,
#                     cached_include_archive_filter,
#                     cached_include_search,
#                 ),
#             )
#             winning_variant = cached_variant
#         except Exception as exc:
#             last_staff_exc = exc
#             staff_result = None

#     # Try from strongest filtering to weakest. This keeps good schemas fast and
#     # still prevents one optional column from breaking the entire dashboard.
#     if staff_result is None:
#         for select_columns in safe_staff_selects:
#             for include_role_filter, include_archive_filter in ((True, True), (False, True), (False, False)):
#                 try:
#                     staff_result = _execute_supabase(
#                         f'client_payroll_page.staff.{select_columns[:24]}',
#                         lambda select_columns=select_columns, include_role_filter=include_role_filter, include_archive_filter=include_archive_filter: _build_staff_query(
#                             select_columns,
#                             include_role_filter,
#                             include_archive_filter,
#                             True,
#                         ),
#                     )
#                     last_staff_exc = None
#                     winning_variant = (select_columns, include_role_filter, include_archive_filter, True)
#                     break
#                 except Exception as exc:
#                     last_staff_exc = exc
#                     text = str(exc).lower()
#                     # If search references a missing optional server column in an
#                     # older deployed file, retry with the current safe search disabled.
#                     if 'client_staff.department' in text or 'column client_staff.department' in text:
#                         try:
#                             staff_result = _execute_supabase(
#                                 f'client_payroll_page.staff.no_department_search.{select_columns[:24]}',
#                                 lambda select_columns=select_columns, include_role_filter=include_role_filter, include_archive_filter=include_archive_filter: _build_staff_query(
#                                     select_columns,
#                                     include_role_filter,
#                                     include_archive_filter,
#                                     False,
#                                 ),
#                             )
#                             last_staff_exc = None
#                             winning_variant = (select_columns, include_role_filter, include_archive_filter, False)
#                             break
#                         except Exception as retry_exc:
#                             last_staff_exc = retry_exc
#                             continue
#                     # Continue only for schema-cache / missing-column problems.
#                     if 'client_staff' not in text and 'pgrst204' not in text and '42703' not in text:
#                         raise
#                     continue
#             if staff_result is not None:
#                 break

#     if staff_result is None:
#         raise last_staff_exc or RuntimeError('Unable to load payroll staff page')

#     if winning_variant is not None:
#         _cache_set_for(
#             _PAYROLL_STAFF_SELECT_VARIANT_CACHE, org_key, winning_variant,
#             _PAYROLL_STAFF_SELECT_VARIANT_TTL_SECONDS,
#         )

#     staff_rows = staff_result.data or []

#     # If we had to use a schema without role/is_archived filters, enforce the
#     # available fields in Python without crashing when they are absent.
#     normalized_staff_rows: list[dict] = []
#     for row in staff_rows:
#         row = dict(row or {})
#         role_value = _payroll_text(row.get('role')).lower()
#         if role_value and role_value != 'staff':
#             continue
#         if row.get('is_archived') is True:
#             continue
#         if clean_people_type:
#             row_people_type = _normalize_people_type(
#                 row.get('people_type') or row.get('peopleType'), 'staff',
#             )
#             if row_people_type != clean_people_type:
#                 continue
#         if search_text:
#             haystack = ' '.join([
#                 _payroll_text(row.get('name')),
#                 _payroll_text(row.get('employee_id')),
#                 _payroll_text(row.get('email')),
#                 _payroll_text(row.get('position')),
#                 _payroll_text(row.get('department_name')),
#             ]).lower()
#             if search_text.lower() not in haystack:
#                 continue
#         normalized_staff_rows.append(row)

#     staff_rows = normalized_staff_rows
#     total = int(staff_result.count or len(staff_rows) or 0)
#     staff_ids = [_payroll_text(row.get('id')) for row in staff_rows if _payroll_text(row.get('id'))]

#     salary_by_staff: dict[str, dict] = {}
#     if staff_ids:
#         try:
#             def _salary_builder_by_organization_id():
#                 return (
#                     get_supabase()
#                     .table('salary_configs')
#                     .select('*')
#                     .eq('organization_id', org_key)
#                     .in_('staff_id', staff_ids)
#                 )

#             try:
#                 salary_result = _execute_supabase(
#                     'client_payroll_page.salary_configs.organization_id',
#                     _salary_builder_by_organization_id,
#                 )
#             except Exception as first_exc:
#                 if 'organization_id' not in str(first_exc).lower():
#                     raise

#                 def _salary_builder_by_org_id():
#                     return (
#                         get_supabase()
#                         .table('salary_configs')
#                         .select('*')
#                         .eq('org_id', org_key)
#                         .in_('staff_id', staff_ids)
#                     )

#                 salary_result = _execute_supabase(
#                     'client_payroll_page.salary_configs.org_id',
#                     _salary_builder_by_org_id,
#                 )

#             for row in salary_result.data or []:
#                 staff_key = _payroll_text(row.get('staff_id') or row.get('user_id') or row.get('client_staff_id'))
#                 if staff_key:
#                     salary_by_staff[staff_key] = row
#         except Exception as exc:
#             if _table_missing(exc, 'salary_configs') or 'salary_configs' in str(exc).lower():
#                 salary_by_staff = {}
#             else:
#                 raise

#     # Live deduction/OT/leave computation via payroll_engine. Attendance/
#     # leave/overtime queries are branch_id-scoped by schema, so rather than
#     # requiring one specific requested branch (backend_branch_id), this
#     # groups the *current page's staff* by their own branch and queries
#     # each branch that actually has staff on this page — which covers both
#     # a single-branch filter (one branch, same result as before) and an
#     # "All Branches" view (multiple branches, merged by staff_id, since
#     # each staff member belongs to exactly one branch so keys never
#     # collide). Only a period is required now, not a branch filter.
#     period_start_text = _payroll_text(period_start) or None
#     period_end_text = _payroll_text(period_end) or None
#     breakdown_by_staff: dict[str, dict] = {}
#     present_days_by_staff: dict[str, int] = {}
#     paid_staff_ids: set[str] | None = None

#     # Policy resolution (individual > branch > org — see get_payroll_policy)
#     # is independent of whether a pay period was requested, so it's hoisted
#     # out of the period-gated block below: the table needs the correct
#     # effective OT rate on every load, including an un-scoped "All
#     # Branches, no period" view, not only once attendance/leave data is
#     # being computed. branch_policy_cache/staff_policy_cache memoize per
#     # distinct branch/staff for this one request so an org with N branches
#     # costs N override lookups total, not one per staff row.
#     org_policy_default = _org_default_payroll_policy(org_key)
#     branch_policy_cache: dict[str, dict] = {}
#     staff_policy_cache: dict[str, dict] = {}

#     def resolve_policy(branch_id: str | None, staff_id: str) -> dict:
#         policy = org_policy_default
#         if branch_id:
#             branch_policy = branch_policy_cache.get(branch_id)
#             if branch_policy is None:
#                 branch_policy = _payroll_policy_override(org_key, branch_id=branch_id) or {}
#                 branch_policy_cache[branch_id] = branch_policy
#             if branch_policy:
#                 policy = {**policy, **branch_policy}
#         if staff_id:
#             staff_policy = staff_policy_cache.get(staff_id)
#             if staff_policy is None:
#                 staff_policy = _payroll_policy_override(org_key, staff_id=staff_id) or {}
#                 staff_policy_cache[staff_id] = staff_policy
#             if staff_policy:
#                 policy = {**policy, **staff_policy}
#         return policy

#     # Effective OT rate per staff — used both to display "OT RATE/HR" on
#     # every row and as the rate fed into compute_payroll_breakdown below.
#     # Computed unconditionally (not just when a period breakdown runs) so
#     # the rate column is always correct, even before a period is picked.
#     effective_ot_rate_by_staff: dict[str, float] = {}
#     policy_by_staff: dict[str, dict] = {}
#     for staff in staff_rows:
#         staff_id = _payroll_text(staff.get('id'))
#         if not staff_id:
#             continue
#         staff_branch_id = _payroll_text(staff.get('branch_id')) or None
#         policy = resolve_policy(staff_branch_id, staff_id)
#         policy_by_staff[staff_id] = policy
#         effective_ot_rate_by_staff[staff_id] = resolve_effective_ot_rate(
#             salary_by_staff.get(staff_id), policy
#         )

#     if period_start_text and period_end_text:
#         try:
#             period_start_date = date.fromisoformat(period_start_text)
#             period_end_date = date.fromisoformat(period_end_text)

#             distinct_branch_ids = sorted({
#                 _payroll_text(staff.get('branch_id'))
#                 for staff in staff_rows
#                 if _payroll_text(staff.get('branch_id'))
#             })

#             # [Fix-6] A CLOSED period (period_end already in the past) can't
#             # have new attendance/leave/overtime logged against it, so its
#             # computed breakdown never changes on a normal revisit of the
#             # same page/filters -- only recompute it once per TTL window.
#             # The current/open period (period_end_date >= today) always
#             # skips this cache and computes live, since its underlying data
#             # can still change within the same day.
#             cache_key: str | None = None
#             cached_breakdown = None
#             if period_end_date < date.today():
#                 cache_key = (
#                     f'{org_key}:{"|".join(distinct_branch_ids)}:'
#                     f'{period_start_text}:{period_end_text}:{"|".join(sorted(staff_ids))}'
#                 )
#                 cached_breakdown = _cache_get(_PAYROLL_BREAKDOWN_CACHE, cache_key)

#             if cached_breakdown is not None:
#                 breakdown_by_staff, present_days_by_staff, paid_staff_ids = cached_breakdown
#             else:
#                 attendance_by_staff: dict[str, list[dict]] = {}
#                 leaves_by_staff: dict[str, list[dict]] = {}
#                 overtime_by_staff: dict[str, float] = {}
#                 local_node_overtime_by_staff: dict[str, float] = {}

#                 attendance_by_staff = get_staff_attendance_for_payroll_period(
#                     org_key, distinct_branch_ids, period_start_text, period_end_text, staff_ids=staff_ids
#                 )
#                 leaves_by_staff = get_approved_leaves_for_payroll_period(
#                     org_key, distinct_branch_ids, period_start_text, period_end_text, staff_ids=staff_ids
#                 )
#                 overtime_by_staff = get_approved_overtime_hours_for_payroll_period(
#                     org_key, distinct_branch_ids, period_start_text, period_end_text, staff_ids=staff_ids
#                 )
#                 local_node_overtime_by_staff = get_local_node_overtime_hours_for_payroll_period(
#                     org_key,
#                     distinct_branch_ids,
#                     period_start_text,
#                     period_end_text,
#                     attendance_by_staff=attendance_by_staff,
#                     staff_ids=staff_ids,
#                 )

#                 paid_staff_ids = get_paid_payroll_periods(org_key, period_start_text, period_end_text)

#                 # resolve_policy/effective_ot_rate_by_staff are already
#                 # computed above, unconditionally — reused here rather than
#                 # re-resolved so the breakdown's OT pay always matches the
#                 # rate the table displays for the same staff member.
#                 for staff in staff_rows:
#                     staff_id = _payroll_text(staff.get('id'))
#                     if not staff_id:
#                         continue
#                     staff_branch_id = _payroll_text(staff.get('branch_id')) or None
#                     salary_config = salary_by_staff.get(staff_id, {})
#                     basic_salary = _payroll_float(
#                         salary_config.get('basic_salary')
#                         if salary_config.get('basic_salary') is not None
#                         else staff.get('salary')
#                     )
#                     # Policy resolved against this staff member's OWN branch —
#                     # not a single requested filter branch — so a branch-level
#                     # policy override applies correctly even when viewing All
#                     # Branches. Individual override > branch override > org default.
#                     policy = resolve_policy(staff_branch_id, staff_id)
#                     # Real approved-this-period OT hours from Overtime Management,
#                     # plus node-classified overtime the local-node payroll-decision
#                     # screen approved (never routes through overtime_requests).
#                     ot_hours = overtime_by_staff.get(staff_id, 0.0) + local_node_overtime_by_staff.get(staff_id, 0.0)
#                     breakdown = payroll_engine.compute_payroll_breakdown(
#                         base_salary=basic_salary,
#                         ot_hours=ot_hours,
#                         ot_rate_per_hour=effective_ot_rate_by_staff.get(staff_id, 0.0),
#                         period_start=period_start_date,
#                         period_end=period_end_date,
#                         policy=policy,
#                         attendance_rows=attendance_by_staff.get(staff_id, []),
#                         leave_rows=leaves_by_staff.get(staff_id, []),
#                     )
#                     breakdown_by_staff[staff_id] = breakdown.to_dict()
#                     present_dates = {r['date'] for r in attendance_by_staff.get(staff_id, []) if r.get('date')}
#                     present_days_by_staff[staff_id] = len(present_dates)

#                 if cache_key is not None:
#                     _cache_set_for(
#                         _PAYROLL_BREAKDOWN_CACHE, cache_key,
#                         (dict(breakdown_by_staff), dict(present_days_by_staff), set(paid_staff_ids or set())),
#                         _PAYROLL_BREAKDOWN_CACHE_TTL_SECONDS,
#                     )
#         except Exception:
#             logger.exception('Payroll breakdown computation failed for org=%s', org_key)
#             breakdown_by_staff = {}
#             present_days_by_staff = {}
#             paid_staff_ids = None

#     rows = [
#         _payroll_page_row(
#             org_key,
#             staff,
#             branch_by_backend,
#             backend_to_ui,
#             salary_by_staff.get(_payroll_text(staff.get('id'))),
#             breakdown=breakdown_by_staff.get(_payroll_text(staff.get('id'))),
#             present_days=present_days_by_staff.get(_payroll_text(staff.get('id'))),
#             paid_staff_ids=paid_staff_ids,
#             effective_ot_rate=effective_ot_rate_by_staff.get(_payroll_text(staff.get('id'))),
#             policy=policy_by_staff.get(_payroll_text(staff.get('id'))),
#         )
#         for staff in staff_rows
#     ]

#     # Sorts that depend on derived/overlay values happen after mapping.
#     sort_key = _payroll_text(sort_by).lower()
#     if sort_key in {'netsalary', 'netpay', 'basesalary', 'basicsalary', 'salary'}:
#         value_key = 'netPay' if sort_key in {'netsalary', 'netpay'} else 'baseSalary'
#         rows.sort(key=lambda item: _payroll_float(item.get(value_key)), reverse=descending)
#     elif sort_key in {'department', 'departmentname', 'branch', 'branchname'}:
#         value_key = 'department' if sort_key.startswith('department') else 'branchName'
#         rows.sort(key=lambda item: _payroll_text(item.get(value_key)).lower(), reverse=descending)

#     total_pages = max(1, (total + size - 1) // size) if total else 1
#     page_total = sum(_payroll_float(row.get('netPay')) for row in rows)
#     page_ot = sum(_payroll_float(row.get('overtimeAmount')) for row in rows)

#     return {
#         'rows': rows,
#         'records': rows,
#         'items': rows,
#         'data': rows,
#         'total': total,
#         'count': total,
#         'totalRecords': total,
#         'page': page_number,
#         'pageSize': size,
#         'totalPages': total_pages,
#         'hasNext': page_number < total_pages,
#         'hasPrev': page_number > 1,
#         'summary': {
#             'totalPayout': page_total,
#             'total_payout': page_total,
#             'totalOT': page_ot,
#             'total_ot': page_ot,
#             'employees': len(rows),
#             'totalStaff': total,
#             'status': 'Pending' if any(str(row.get('status')).lower() == 'pending' for row in rows) else 'Paid',
#         },
#     }


"""
support_db_payroll.py
───────────────────────────────────────────────────────────────────────────────
Payroll policy, paid/pending status tracking, payroll-period attendance/leave
aggregation, and the paginated tenant payroll API.

Split out of the original monolithic support_db.py. See support_db.py for
the backward-compatible facade that re-exports everything below.
"""

from datetime import date, timedelta, datetime, timezone
import json
import re
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

logger = get_logger(__name__)
from support_db_core import _execute_supabase
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
    # [Fix-5] pure/lookup helpers reused by _resolve_short_leave_hours_batch
    # below so it can reimplement resolve_timing_source's own precedence
    # locally against pre-batched data, without touching or caching inside
    # support_db_attendance_gate.py itself -- that module also backs LIVE
    # check-in/out gating (mark_client_staff_attendance,
    # record_cloud_camera_attendance), where a stale cached shift/capture-
    # setting could misclassify a real check-in. Keeping the batching
    # entirely on the payroll side means this optimization can never affect
    # live attendance marking.
    _normalize_people_type,
    _window_from_shift,
    _get_shift,
    _capture_settings,
    _half_day_window,
)
from support_db_core import _cache_get, _cache_set_for
from support_db_attendance_settings import list_pending_manual_instructions_for_branch
from support_db_time_utils import is_missing_table_or_column as _table_missing
import support_db_attendance_exceptions as _attendance_exceptions
from zoneinfo import ZoneInfo, available_timezones
import payroll_engine
from core.vertical_templates import (
    list_vertical_templates as _list_vertical_templates,
    normalize_vertical_payload,
    build_vertical_config,
    get_vertical_template,
)

# [Fix-4] Remembers which entry of `safe_staff_selects` (in
# get_client_payroll_page) actually worked for this org last time, so a
# tenant on a degraded/older schema doesn't re-probe up to 5 columns × 3
# filter combos on every single page load once we already know which
# variant lands. Same dict[str, tuple[float, value]] + monotonic-expiry
# shape as support_db_core._ORG_CACHE -- reuses that module's _cache_get/
# _cache_set_for rather than a bespoke cache, so this follows the same
# convention as every other tenant-meta cache in the codebase. Schema
# doesn't change at runtime for a tenant in practice, so the TTL here is
# long; a wrong/stale entry just falls through to the full ladder and
# re-learns, it never hard-fails.
_PAYROLL_STAFF_SELECT_VARIANT_TTL_SECONDS = 600.0
_PAYROLL_STAFF_SELECT_VARIANT_CACHE: dict[str, tuple[float, tuple]] = {}

# [Fix-6] breakdown_by_staff (+ present_days_by_staff + paid_staff_ids) for
# CLOSED pay periods only -- period_end already in the past, so the
# attendance/leave/overtime data compute_payroll_breakdown draws on cannot
# change from a normal revisit of the same page. The current/open period
# is NEVER cached (see the period_end < today() gate at its one call site)
# and always computes live. mark_payroll_paid/mark_payroll_pending
# invalidate this per-org below, since a paid/pending flip changes
# paid_staff_ids for an otherwise-closed period.
_PAYROLL_BREAKDOWN_CACHE_TTL_SECONDS = 300.0
_PAYROLL_BREAKDOWN_CACHE: dict[str, tuple[float, dict]] = {}

def _invalidate_payroll_breakdown_cache(org_id: str) -> None:
    prefix = f'{str(org_id)}:'
    for key in list(_PAYROLL_BREAKDOWN_CACHE.keys()):
        if key.startswith(prefix):
            _PAYROLL_BREAKDOWN_CACHE.pop(key, None)

_DEFAULT_PAYROLL_POLICY = {
    'otRatePerHour': 0,
    'defaultSalary': 0,
    'perDayRateBasis': 'calendar_days',
    'fixedWorkingDaysPerMonth': 26,
    'lateComingPolicy': {'mode': 'occurrence_threshold', 'thresholdOccurrences': 3},
    'shortLeavePolicy': {'dayFraction': 0.5},
    'leaveTypeRules': {},
    # Annual per-leave-type paid-day quota, e.g. {'annual': 12, 'sick': 6}.
    # Keys mirror leaveTypeRules 1:1 (see PayrollModule's Payroll Rules
    # modal, the only writer of both maps). A type missing here has no
    # configured quota yet -- callers must treat that as "unknown", not 0,
    # so an unconfigured type doesn't silently show "0 remaining" days.
    'leaveTypeQuotas': {},
    # Org/branch-configurable named allowance types, e.g.
    # {'transport': {'label': 'Transport', 'mode': 'fixed', 'value': 3000}}.
    # 'mode' is 'fixed' (flat PKR) or 'percent' (of basic_salary). Applying
    # one of these to a specific staff member happens on salary_configs.
    # applied_allowances, not here -- this is only the org/branch-scoped
    # catalog of what allowance types exist and their default math, mirroring
    # leaveTypeRules' shape/precedence exactly (see get_payroll_policy).
    'allowanceTypes': {},
}

# payroll_policy_overrides stores one row per (org, branch) or (org, staff)
# override, disambiguated by which of branch_id/staff_id is "real" on that
# row. branch_id/staff_id are declared NOT NULL with this sentinel as their
# default -- deliberately NOT NULL, because save_payroll_policy's upsert
# targets a plain UNIQUE(org_id, branch_id, staff_id) constraint via
# on_conflict='org_id,branch_id,staff_id', and standard SQL unique
# constraints treat NULL as distinct from every other NULL. If the unused
# column were left NULL, two saves of the same branch override would never
# collide on conflict -- Postgres would just insert a second row instead of
# updating the first, and which one a later `.limit(1)` read returns would
# be undefined. Using a sentinel instead of NULL keeps the constraint a
# real, non-partial unique index that upsert can target directly.
_PAYROLL_OVERRIDE_NO_SCOPE = ''

def _org_default_payroll_policy(org_id: str) -> dict:
    org_key = str(org_id)
    try:
        def _query():
            return (
                get_supabase()
                .table('client_onboarding_configs')
                .select('payroll_policy')
                .eq('org_id', org_key)
                .limit(1)
            )
        result = _execute_supabase('get_payroll_policy', _query)
        rows = result.data or []
        stored = rows[0].get('payroll_policy') if rows else None
        if isinstance(stored, dict) and stored:
            return {**_DEFAULT_PAYROLL_POLICY, **stored}
    except Exception as exc:
        if not _table_missing(exc, 'client_onboarding_configs'):
            logger.exception('get_payroll_policy failed for org=%s', org_key)
    return dict(_DEFAULT_PAYROLL_POLICY)

def _payroll_policy_override(org_id: str, *, branch_id: str | None = None, staff_id: str | None = None) -> dict | None:
    """One row per (org, branch) or (org, staff) override, stored in
    payroll_policy_overrides. Table is optional — orgs that never set a
    branch/individual override never need it to exist; missing-table is
    treated as 'no override' rather than an error, same resilience pattern
    salary_configs uses elsewhere in this module."""
    org_key = str(org_id)
    try:
        def _query():
            q = get_supabase().table('payroll_policy_overrides').select('policy').eq('org_id', org_key)
            if staff_id:
                q = q.eq('staff_id', str(staff_id)).eq('branch_id', _PAYROLL_OVERRIDE_NO_SCOPE)
            else:
                q = q.eq('branch_id', str(branch_id)).eq('staff_id', _PAYROLL_OVERRIDE_NO_SCOPE)
            return q.limit(1)
        result = _execute_supabase('get_payroll_policy_override', _query)
        rows = result.data or []
        stored = rows[0].get('policy') if rows else None
        return stored if isinstance(stored, dict) and stored else None
    except Exception as exc:
        if not _table_missing(exc, 'payroll_policy_overrides'):
            logger.exception('payroll_policy_override lookup failed for org=%s', org_key)
        return None

def resolve_effective_ot_rate(salary_config: dict | None, policy: dict) -> float:
    """Single source of truth for 'what OT rate actually applies to this
    staff member': their own per-staff override (salary_configs.ot_rate)
    if set (nonzero), else the resolved policy default for their scope
    (individual > branch > org -- see get_payroll_policy). Every call site
    that computes OT pay or displays an OT rate must go through this --
    duplicating this fallback inline is exactly how the org-first/
    staff-first precedence bug happened before (two independent copies of
    the same `or` expression, one fixed and one not). app.py imports this
    rather than re-implementing it."""
    salary_config = salary_config or {}
    return float(salary_config.get('ot_rate') or policy.get('otRatePerHour') or 0)


def resolve_effective_allowances(applied_allowances: dict | None, policy: dict, basic_salary: float) -> tuple[list[dict], float]:
    """Single source of truth for 'what allowances actually apply to this
    staff member and for how much' -- every call site that needs the
    itemized breakdown or the total allowance amount must go through this
    rather than re-deriving it, same rule as resolve_effective_ot_rate above.

    applied_allowances: salary_configs.applied_allowances for this staff
    member -- {'transport': {'enabled': True, 'overrideValue': 4000}, ...}.
    A type the staff member hasn't been given is simply absent/not enabled
    here; it never applies just because it exists in the org catalog.

    policy: the resolved PayrollPolicy for this staff member's scope (org >
    branch > staff -- see get_payroll_policy), whose 'allowanceTypes' is the
    catalog of what each key means (label, fixed/percent mode, default
    value). A key present in applied_allowances but no longer in the
    catalog (deleted from Payroll Rules after being applied to someone) is
    skipped rather than guessed at -- no silent stale amount.

    Returns (items, total) where items is the itemized list ready for
    display -- [{'key', 'label', 'mode', 'value', 'amount'}, ...] -- and
    total is the sum, ready to fold into net_pay alongside the legacy flat
    'allowances' column (kept separately as an "Other / Manual Adjustment"
    line -- see _tenant_salary_map_row).
    """
    applied = applied_allowances if isinstance(applied_allowances, dict) else {}
    catalog = policy.get('allowanceTypes')
    catalog = catalog if isinstance(catalog, dict) else {}

    items: list[dict] = []
    total = 0.0
    for key, entry in applied.items():
        if not isinstance(entry, dict) or not entry.get('enabled'):
            continue
        type_def = catalog.get(key)
        if not isinstance(type_def, dict):
            continue
        mode = type_def.get('mode') if type_def.get('mode') in ('fixed', 'percent', 'none') else 'fixed'
        # overrideValue, if present (including 0 -- an explicit per-person
        # override to zero is different from "no override"), wins over the
        # org/branch-configured default value for this type.
        value = entry.get('overrideValue')
        value = float(value) if value is not None else float(type_def.get('value') or 0)
        if mode == 'percent':
            amount = round(float(basic_salary) * value / 100.0, 2)
        elif mode == 'none':
            amount = 0.0
        else:
            amount = round(value, 2)
        items.append({
            'key': key,
            'label': type_def.get('label') or key,
            'mode': mode,
            'value': value,
            'amount': amount,
        })
        total += amount
    return items, round(total, 2)


def get_payroll_policy(org_id: str, branch_id: str | None = None, staff_id: str | None = None) -> dict:
    """Effective policy for a staff member/branch: individual override wins
    over branch override wins over the org-wide default. Callers that just
    want the org default (e.g. the Payroll Rules modal's base editor) pass
    neither branch_id nor staff_id, same as before this change."""
    policy = _org_default_payroll_policy(org_id)
    if branch_id:
        branch_override = _payroll_policy_override(org_id, branch_id=branch_id)
        if branch_override:
            policy = {**policy, **branch_override}
    if staff_id:
        staff_override = _payroll_policy_override(org_id, staff_id=staff_id)
        if staff_override:
            policy = {**policy, **staff_override}
    return policy

def get_leave_type_rules(org_id: str, branch_id: str | None = None) -> dict:
    """Effective leave-type paid/unpaid map for org_id (+ branch override,
    if any) -- the same org > branch precedence get_payroll_policy uses,
    minus the staff_id tier: nothing in this codebase edits leaveTypeRules
    at individual scope, only org-wide or per-branch (see PayrollModule's
    Payroll Rules modal, which is the only writer).

    This is a read-only projection, not a separate table -- leaveTypeRules
    stays stored inside PayrollPolicy (support_db_payroll's existing
    storage), so payroll_engine.compute_payroll_breakdown and every leave
    surface (dashboard Leave Management filter, mobile leave-request form)
    always agree on which leave types exist and whether they're paid.
    Splitting this into its own table would risk the two drifting apart;
    this function exists purely so leave-facing call sites (leave routes,
    the mobile leave blueprint) can ask "which leave types are configured"
    without importing or touching the rest of PayrollPolicy (salary, OT,
    late-coming) they have no business reading.
    """
    policy = get_payroll_policy(org_id, branch_id=branch_id)
    rules = policy.get('leaveTypeRules')
    return rules if isinstance(rules, dict) else {}

def get_leave_type_allocations(org_id: str, branch_id: str | None = None) -> dict:
    """Effective leaveTypeRules + leaveTypeQuotas together, one policy read
    instead of two -- GET /api/leaves/types is the single call the Leave
    Management History tab makes to learn both "which leave types exist"
    and "how many paid days each type grants per year". Same org > branch
    precedence as get_leave_type_rules (see that function's docstring);
    kept as a thin wrapper around it rather than duplicating the lookup.
    """
    policy = get_payroll_policy(org_id, branch_id=branch_id)
    rules = policy.get('leaveTypeRules')
    quotas = policy.get('leaveTypeQuotas')
    return {
        'leaveTypeRules': rules if isinstance(rules, dict) else {},
        'leaveTypeQuotas': quotas if isinstance(quotas, dict) else {},
    }


_PAYROLL_NON_NEGATIVE_FIELDS = ('otRatePerHour', 'defaultSalary')

def _validate_payroll_policy(policy: dict) -> None:
    """Reject payroll rules that would break the engine's math.

    Base salary and OT rate are money-per-unit values that the engine
    multiplies by days/hours worked. A negative here doesn't just produce a
    small error -- it inverts the sign of the whole computation, so more
    overtime yields *less* pay and an employee can finish a period owing the
    company money. There is no legitimate negative here: a deduction is
    modelled by leaveTypeRules/lateComingPolicy, not by a negative rate.
    """
    for field in _PAYROLL_NON_NEGATIVE_FIELDS:
        if field not in policy:
            continue
        raw = policy.get(field)
        if raw is None or raw == '':
            continue
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise ValueError(f'{field} must be a number')
        if value != value or value in (float('inf'), float('-inf')):
            raise ValueError(f'{field} must be a finite number')
        if value < 0:
            raise ValueError(f'{field} cannot be negative')

    if 'fixedWorkingDaysPerMonth' in policy:
        raw = policy.get('fixedWorkingDaysPerMonth')
        if raw not in (None, ''):
            try:
                days = float(raw)
            except (TypeError, ValueError):
                raise ValueError('fixedWorkingDaysPerMonth must be a number')
            if not 1 <= days <= 31:
                raise ValueError('fixedWorkingDaysPerMonth must be between 1 and 31')


def save_payroll_policy(org_id: str, policy: dict, branch_id: str | None = None, staff_id: str | None = None) -> dict:
    """Whole-object replace, not a merge — the frontend always sends the
    complete policy, so a partial merge here would let stale keys linger.

    branch_id/staff_id: when given, this writes a scoped override instead
    of the org-wide default (see get_payroll_policy for the fallback
    chain). staff_id takes precedence if both are somehow passed, matching
    the read-side precedence."""
    org_key = str(org_id)
    if not org_key:
        raise ValueError('organization_id is required to save payroll policy')

    _validate_payroll_policy(policy or {})

    if branch_id or staff_id:
        # branch_id/staff_id are NOT NULL on this table (sentinel
        # _PAYROLL_OVERRIDE_NO_SCOPE fills the unused one) so the
        # UNIQUE(org_id, branch_id, staff_id) constraint the upsert below
        # targets actually dedups branch-vs-branch and staff-vs-staff
        # saves instead of silently inserting a new row every time — see
        # _PAYROLL_OVERRIDE_NO_SCOPE's docstring for why NULL can't be
        # used here.
        payload = {
            'org_id': org_key,
            'branch_id': str(branch_id) if branch_id and not staff_id else _PAYROLL_OVERRIDE_NO_SCOPE,
            'staff_id': str(staff_id) if staff_id else _PAYROLL_OVERRIDE_NO_SCOPE,
            'policy': policy,
            'updated_at': datetime.now(timezone.utc).isoformat(),
        }

        def _upsert_override():
            return (
                get_supabase()
                .table('payroll_policy_overrides')
                .upsert(payload, on_conflict='org_id,branch_id,staff_id')
            )
        _execute_supabase('save_payroll_policy_override', _upsert_override)
        # A branch/staff override changes the effective OT rate + leave
        # rules for whatever closed periods that scope's breakdown cache
        # (_PAYROLL_BREAKDOWN_CACHE, keyed per-org — see its module-level
        # comment) may already hold. Same invalidation mark_payroll_paid/
        # pending already do for a paid-status flip; a rules change is no
        # different and was previously missing this call, so a save here
        # could silently keep serving pre-change numbers for up to
        # _PAYROLL_BREAKDOWN_CACHE_TTL_SECONDS.
        _invalidate_payroll_breakdown_cache(org_key)
        return policy

    payload = {
        'org_id': org_key,
        'payroll_policy': policy,
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }

    def _upsert():
        return (
            get_supabase()
            .table('client_onboarding_configs')
            .upsert(payload, on_conflict='org_id')
        )
    _execute_supabase('save_payroll_policy', _upsert)
    _invalidate_payroll_breakdown_cache(org_key)
    return policy

def get_paid_payroll_periods(org_id: str, period_start: str, period_end: str) -> set[str]:
    """staff_ids marked paid for a period that overlaps [period_start, period_end]."""
    from support_db_attendance_dashboard import _support_clean_text
    org_key = str(org_id)
    try:
        def _query():
            return (
                get_supabase()
                .table('payroll_payments')
                .select('staff_id')
                .eq('org_id', org_key)
                .eq('period_start', period_start)
                .eq('period_end', period_end)
            )
        result = _execute_supabase('get_paid_payroll_periods', _query)
        return {_support_clean_text(row.get('staff_id')) for row in (result.data or []) if row.get('staff_id')}
    except Exception as exc:
        if not _table_missing(exc, 'payroll_payments'):
            logger.exception('get_paid_payroll_periods failed for org=%s', org_key)
        return set()

def mark_payroll_paid(
    org_id: str,
    staff_id: str,
    period_start: str,
    period_end: str,
    breakdown: dict | None = None,
) -> None:
    """breakdown: optional payroll_engine.PayrollBreakdown.to_dict() for this
    staff member/period. When supplied, unpaid_leave_days/late_count are
    frozen as first-class columns and the full breakdown is kept for audit —
    this is what makes a Paid period immutable against later attendance
    corrections, instead of silently recomputing forever."""
    org_key = str(org_id)
    payload = {
        'org_id': org_key,
        'staff_id': str(staff_id),
        'period_start': period_start,
        'period_end': period_end,
        'paid_at': datetime.now(timezone.utc).isoformat(),
    }
    if breakdown:
        payload['unpaid_leave_days'] = breakdown.get('unpaid_leave_days', 0)
        payload['late_count'] = breakdown.get('late_count', 0)
        payload['breakdown'] = breakdown

    def _upsert():
        return (
            get_supabase()
            .table('payroll_payments')
            .upsert(payload, on_conflict='org_id,staff_id,period_start,period_end')
        )
    try:
        _execute_supabase('mark_payroll_paid', _upsert)
    except Exception as exc:
        if _table_missing(exc, 'payroll_payments'):
            logger.exception(
                'mark_payroll_paid failed for org=%s: payroll_payments table is missing',
                org_key,
            )
            raise RuntimeError(
                'Unable to mark payroll paid: payroll_payments table is missing in Supabase schema. '
                'Apply the migration to create public.payroll_payments.'
            ) from exc
        raise
    # [Fix-6] A paid/pending flip changes paid_staff_ids for whatever
    # period this staff member belongs to -- if that period is closed and
    # already cached, the cached paid_staff_ids set is now stale. Clearing
    # is coarse (whole org, not just this one period) but cheap and simple;
    # the next request for any closed period just recomputes once.
    _invalidate_payroll_breakdown_cache(org_key)

def mark_payroll_pending(org_id: str, staff_id: str, period_start: str, period_end: str) -> None:
    org_key = str(org_id)

    def _delete():
        return (
            get_supabase()
            .table('payroll_payments')
            .delete()
            .eq('org_id', org_key)
            .eq('staff_id', str(staff_id))
            .eq('period_start', period_start)
            .eq('period_end', period_end)
        )
    try:
        _execute_supabase('mark_payroll_pending', _delete)
    except Exception as exc:
        if _table_missing(exc, 'payroll_payments'):
            logger.exception(
                'mark_payroll_pending failed for org=%s: payroll_payments table is missing',
                org_key,
            )
            raise RuntimeError(
                'Unable to mark payroll pending: payroll_payments table is missing in Supabase schema. '
                'Apply the migration to create public.payroll_payments.'
            ) from exc
        raise
    _invalidate_payroll_breakdown_cache(org_key)

_PAYROLL_ATTENDANCE_COLUMNS_BASE = (
    'staff_id, timestamp, status, day_status, branch_id, check_out_timestamp, capture_channel'
)

_PAYROLL_ATTENDANCE_COLUMNS_WITH_DECISION = (
    _PAYROLL_ATTENDANCE_COLUMNS_BASE
    + ', branch_id, check_out_status, check_in_payroll_decision, check_out_payroll_decision'
)

def get_staff_attendance_for_payroll_period(
    org_id: str,
    branch_id: str | list[str] | tuple[str, ...],
    period_start: str,
    period_end: str,
    staff_ids: list[str] | tuple[str, ...] | None = None,
) -> dict[str, list[dict]]:
    """Batched, branch-scoped attendance for an entire pay period, grouped
    by staff_id — the payroll counterpart to get_client_staff_attendance_history
    (which is staff-scoped, mobile-portal shaped). Returns only the fields
    payroll_engine consumes.

    Selects check_out_status plus the two payroll-decision columns added by
    migration_add_payroll_decision_fields.sql. Falls back to the pre-Phase-1
    column set if that migration hasn't been applied to this org's database
    yet (same "degrade instead of break" pattern resolve_attendance_exception
    already uses for resolved_by/resolved_at) — so this function keeps
    working whether or not the migration has landed, and the two can ship in
    either order without a hard dependency.
    """
    from support_db_attendance_dashboard import _support_clean_text
    org_key = str(org_id)
    filtered_staff_ids = [str(s) for s in (staff_ids or []) if _support_clean_text(s)]
    has_staff_filter = staff_ids is not None

    def _query(columns: str):
        q = (
            get_supabase()
            .table('attendance')
            .select(columns)
            .eq('org_id', org_key)
            .gte('timestamp', f'{period_start}T00:00:00')
            .lte('timestamp', f'{period_end}T23:59:59')
        )
        if isinstance(branch_id, (list, tuple)):
            branch_ids = [str(b) for b in branch_id if _support_clean_text(b)]
            if not branch_ids:
                raise ValueError('branch_id list must contain at least one valid branch id')
            q = q.in_('branch_id', branch_ids)
        else:
            q = q.eq('branch_id', str(branch_id))
        if has_staff_filter:
            if filtered_staff_ids:
                q = q.in_('staff_id', filtered_staff_ids)
            else:
                q = q.eq('staff_id', '__invalid_staff_id__')
        return q

    try:
        result = _execute_supabase(
            'payroll_attendance_period',
            lambda: _query(_PAYROLL_ATTENDANCE_COLUMNS_WITH_DECISION),
        )
    except Exception as exc:
        if _table_missing(exc, 'check_out_status') or _table_missing(exc, 'check_in_payroll_decision') \
                or _table_missing(exc, 'check_out_payroll_decision'):
            logger.warning(
                'get_staff_attendance_for_payroll_period: payroll-decision columns not '
                'found (migration_add_payroll_decision_fields.sql not yet applied?) — '
                'falling back to the pre-migration column set for org=%s',
                org_key,
            )
            result = _execute_supabase(
                'payroll_attendance_period_legacy',
                lambda: _query(_PAYROLL_ATTENDANCE_COLUMNS_BASE),
            )
        else:
            raise
    rows = result.data or []

    sb = get_supabase()
    branch_zones: dict[str, ZoneInfo | None] = {}

    grouped: dict[str, list[dict]] = {}
    # [Fix-5] Rows needing short-leave-hours resolution are deferred and
    # resolved in ONE batched pass after this loop (see
    # _resolve_short_leave_hours_batch below) instead of calling
    # compute_short_leave_hours per row here -- that function alone does a
    # client_staff fetch plus up to ~5 more queries (manual override,
    # half-day leave, shift, branch-default capture-settings) EVERY TIME,
    # so a period with N short-leave days for the same staff member
    # re-fetched that same staff's shift/config N times. `pending` holds a
    # direct reference to each dict already appended to `grouped`, so the
    # batch resolver can mutate shortLeaveHours/shiftScheduledHours in
    # place once results are known.
    pending: list[dict] = []
    for row in rows:
        ts = str(row.get('timestamp') or '')
        staff_id = _support_clean_text(row.get('staff_id'))
        if not staff_id or not ts:
            continue
        row_branch_id = str(row.get('branch_id') or '')
        if not row_branch_id:
            continue
        zone = branch_zones.get(row_branch_id)
        if zone is None:
            zone = _get_branch_timezone(sb, org_key, row_branch_id)
            branch_zones[row_branch_id] = zone

        day_status = row.get('day_status') or 'present'
        checkout_ts = row.get('check_out_timestamp')
        entry = {
            'date': _attendance_exceptions.local_date_str_iso(ts, zone),
            'branch_id': row.get('branch_id'),
            'branchId': row.get('branch_id'),
            'checkInStatus': row.get('status'),
            'dayStatus': day_status,
            'checkOutStatus': row.get('check_out_status'),
            'checkInPayrollDecision': row.get('check_in_payroll_decision'),
            'checkOutPayrollDecision': row.get('check_out_payroll_decision'),
            'checkOutTimestamp': checkout_ts,
            'captureChannel': row.get('capture_channel'),
            'shortLeaveHours': 0.0,
            'shiftScheduledHours': 0.0,
        }
        grouped.setdefault(staff_id, []).append(entry)
        # Only worth resolving the staff member's shift window at all for
        # rows that actually need it -- every other dayStatus ignores
        # these two fields entirely.
        if day_status == 'short_leave' and checkout_ts:
            pending.append({
                'entry': entry,
                'staff_id': staff_id,
                'branch_id': row_branch_id,
                'checkout_ts': checkout_ts,
                'zone': zone,
            })

    if pending:
        _resolve_short_leave_hours_batch(org_key, pending)

    return grouped


def _resolve_short_leave_hours_batch(org_id: str, pending: list[dict]) -> None:
    """Batched counterpart to _attendance_exceptions.compute_short_leave_hours.
    Mutates each pending['entry'] in place, setting shortLeaveHours/
    shiftScheduledHours, for every attendance row already classified
    day_status='short_leave'.

    Reimplements resolve_timing_source's own 5-tier precedence
    (manual override > half-day leave > staff shift > branch default >
    simple mode) locally against data fetched ONCE per distinct staff/
    shift/branch/date-range here, rather than calling resolve_timing_source
    itself (which re-queries per call, no caching, and is also the live
    check-in/out gate -- see the import comment above for why this stays
    fully separate from that module). Any single item that can't be
    resolved from the batched data falls back to the original per-row
    compute_short_leave_hours for THAT item only, so this can only get
    faster, never less correct, than before.
    """
    from support_db_attendance_dashboard import _support_clean_text

    org_key = str(org_id)
    sb = get_supabase()

    staff_ids = sorted({p['staff_id'] for p in pending if p['staff_id']})
    if not staff_ids:
        return

    # One query for every staff member's timing fields, instead of one
    # query per short-leave ROW (a staff member with 3 short-leave days in
    # the period previously triggered 3 identical lookups of themselves).
    staff_by_id: dict[str, dict] = {}
    try:
        staff_result = _execute_supabase(
            'payroll_short_leave_staff_batch',
            lambda: (
                sb.table('client_staff')
                .select('id, people_type, shift_id_ref, person_code, check_in_grace_override, check_out_grace_override')
                .eq('org_id', org_key)
                .in_('id', staff_ids)
            ),
        )
        for row in staff_result.data or []:
            sid = _support_clean_text(row.get('id'))
            if sid:
                staff_by_id[sid] = row
    except Exception:
        logger.exception('Batched staff-fields fetch failed for short-leave resolution, org=%s', org_key)
        staff_by_id = {}

    # One query for every referenced shift, instead of one per row.
    shift_ids = sorted({
        _support_clean_text(staff_by_id[sid].get('shift_id_ref'))
        for sid in staff_by_id
        if staff_by_id[sid].get('shift_id_ref')
    })
    shifts_by_id: dict[str, dict] = {}
    if shift_ids:
        try:
            shift_result = _execute_supabase(
                'payroll_short_leave_shift_batch',
                lambda: (
                    sb.table('shifts')
                    .select('id, check_in_time, grace_minutes, check_out_time, checkout_grace_minutes, sync_delay_minutes, is_active')
                    .eq('org_id', org_key)
                    .in_('id', shift_ids)
                    .eq('is_active', True)
                ),
            )
            for row in shift_result.data or []:
                rid = _support_clean_text(row.get('id'))
                if rid:
                    shifts_by_id[rid] = row
        except Exception:
            logger.exception('Batched shift fetch failed for short-leave resolution, org=%s', org_key)

    # Local date per pending item, needed for manual-instruction/half-day
    # lookups below. Computed once here rather than inside the loop twice.
    for item in pending:
        checkout_dt = _attendance_exceptions._parse_iso_dt(item['checkout_ts'])
        item['checkout_dt'] = checkout_dt
        item['local_date'] = (
            checkout_dt.astimezone(item['zone']).date() if checkout_dt else None
        )
    dated_items = [p for p in pending if p['local_date'] is not None]
    if not dated_items:
        return
    min_date = min(p['local_date'] for p in dated_items)
    max_date = max(p['local_date'] for p in dated_items)

    # One query covering the whole period's date range for manual
    # overrides, instead of one query per (staff, date) pair.
    manual_by_staff_date: dict[tuple[str, str], dict] = {}
    try:
        manual_result = _execute_supabase(
            'payroll_short_leave_manual_batch',
            lambda: (
                sb.table('manual_attendance_instructions')
                .select('staff_id, attendance_date, check_in_time, check_in_grace_minutes, check_out_time, check_out_grace_minutes')
                .eq('org_id', org_key)
                .in_('staff_id', staff_ids)
                .gte('attendance_date', min_date.isoformat())
                .lte('attendance_date', max_date.isoformat())
            ),
        )
        for row in manual_result.data or []:
            sid = _support_clean_text(row.get('staff_id'))
            adate = _support_clean_text(row.get('attendance_date'))
            if sid and adate:
                manual_by_staff_date[(sid, adate)] = row
    except Exception:
        logger.exception('Batched manual-instruction fetch failed for short-leave resolution, org=%s', org_key)

    # One query covering the whole period's date range for approved
    # half-day leave, instead of one query per (staff, date) pair. Filtered
    # precisely per-item afterwards since this is a date-RANGE overlap,
    # not an exact match.
    half_day_leaves: list[dict] = []
    try:
        half_day_result = _execute_supabase(
            'payroll_short_leave_half_day_batch',
            lambda: (
                sb.table('leave_requests')
                .select('staff_id, half_day_period, leave_type, start_date, end_date')
                .eq('org_id', org_key)
                .eq('status', 'approved')
                .not_.is_('half_day_period', 'null')
                .in_('staff_id', staff_ids)
                .lte('start_date', max_date.isoformat())
                .gte('end_date', min_date.isoformat())
            ),
        )
        half_day_leaves = half_day_result.data or []
    except Exception:
        logger.exception('Batched half-day-leave fetch failed for short-leave resolution, org=%s', org_key)

    half_day_by_staff: dict[str, list[dict]] = {}
    for row in half_day_leaves:
        sid = _support_clean_text(row.get('staff_id'))
        if sid:
            half_day_by_staff.setdefault(sid, []).append(row)

    capture_settings_cache: dict[tuple[str, str], dict | None] = {}
    half_day_window_cache: dict[tuple[str, str, str], dict | None] = {}

    def _resolve_window(item: dict) -> dict | None:
        staff_id = item['staff_id']
        branch_id = item['branch_id']
        staff = staff_by_id.get(staff_id)
        if not staff:
            return None
        people_type = _normalize_people_type(staff.get('people_type'))
        local_date = item['local_date']
        date_key = local_date.isoformat()

        # Tier 1 -- manual override
        manual = manual_by_staff_date.get((staff_id, date_key))
        if manual and (manual.get('check_in_time') or manual.get('check_out_time')):
            return {
                'check_in_time': manual.get('check_in_time'),
                'check_in_grace_minutes': manual.get('check_in_grace_minutes') or 0,
                'capture_check_out': bool(manual.get('check_out_time')),
                'check_out_time': manual.get('check_out_time'),
                'check_out_grace_minutes': manual.get('check_out_grace_minutes') or 0,
            }

        # Tier 2 -- approved half-day leave overlapping this date
        for leave in half_day_by_staff.get(staff_id, []):
            start = leave.get('start_date')
            end = leave.get('end_date')
            if start and end and str(start) <= date_key <= str(end) and leave.get('half_day_period'):
                hd_key = (branch_id, people_type, str(leave['half_day_period']))
                if hd_key not in half_day_window_cache:
                    try:
                        half_day_window_cache[hd_key] = _half_day_window(
                            sb, org_key, branch_id, people_type, str(leave['half_day_period']),
                        )
                    except Exception:
                        half_day_window_cache[hd_key] = None
                window = half_day_window_cache[hd_key]
                if window:
                    return window
                break

        # Tiers 3-4 -- staff's assigned shift, else branch default
        shift_id = _support_clean_text(staff.get('shift_id_ref'))
        if shift_id and shift_id in shifts_by_id:
            return _window_from_shift(
                shifts_by_id[shift_id],
                staff.get('check_in_grace_override'),
                staff.get('check_out_grace_override'),
            )

        settings_key = (branch_id, people_type)
        if settings_key not in capture_settings_cache:
            try:
                capture_settings_cache[settings_key] = _capture_settings(sb, org_key, branch_id, people_type)
            except Exception:
                capture_settings_cache[settings_key] = None
        settings = capture_settings_cache[settings_key]
        if settings and settings.get('mode') == 'shift' and settings.get('default_shift_id'):
            default_shift_id = _support_clean_text(settings['default_shift_id'])
            default_shift = shifts_by_id.get(default_shift_id)
            if default_shift is None:
                try:
                    default_shift = _get_shift(sb, org_key, default_shift_id)
                    if default_shift:
                        shifts_by_id[default_shift_id] = default_shift
                except Exception:
                    default_shift = None
            if default_shift:
                return _window_from_shift(
                    default_shift,
                    settings.get('default_check_in_grace_override'),
                    settings.get('default_check_out_grace_override'),
                )

        # Tier 5 -- simple-mode branch baseline
        if settings and settings.get('mode') == 'simple' and settings.get('check_in_time'):
            return {
                'check_in_time': settings['check_in_time'],
                'check_in_grace_minutes': settings.get('check_in_grace_minutes') or 0,
                'capture_check_out': bool(settings.get('capture_check_out')),
                'check_out_time': settings.get('check_out_time'),
                'check_out_grace_minutes': settings.get('check_out_grace_minutes') or 0,
            }
        return None

    for item in dated_items:
        try:
            window = _resolve_window(item)
            if not window or not window.get('check_out_time') or not window.get('check_in_time'):
                raise ValueError('no resolvable window')

            out_parts = str(window['check_out_time']).split(':')
            in_parts = str(window['check_in_time']).split(':')
            if len(out_parts) < 2 or len(in_parts) < 2:
                raise ValueError('malformed shift time')
            target_minutes = int(out_parts[0]) * 60 + int(out_parts[1])
            check_in_minutes = int(in_parts[0]) * 60 + int(in_parts[1])
            shift_minutes = target_minutes - check_in_minutes
            if shift_minutes <= 0:
                shift_minutes += 24 * 60
            shift_hours = round(shift_minutes / 60.0, 2)

            checkout_dt = item['checkout_dt']
            local_dt = checkout_dt if checkout_dt.tzinfo else checkout_dt.replace(tzinfo=timezone.utc)
            local = local_dt.astimezone(item['zone'])
            actual_minutes = local.hour * 60 + local.minute

            short_minutes = target_minutes - actual_minutes
            short_hours = round(short_minutes / 60.0, 2) if short_minutes > 0 else 0.0

            item['entry']['shortLeaveHours'] = short_hours
            item['entry']['shiftScheduledHours'] = shift_hours
        except Exception:
            # Safety net: anything unresolved from batched data falls back
            # to the original, always-correct per-row path for just this
            # one item, rather than silently leaving 0.0/0.0.
            try:
                short_hours, shift_hours = _attendance_exceptions.compute_short_leave_hours(
                    org_id=org_key,
                    branch_id=item['branch_id'],
                    staff_id=item['staff_id'],
                    check_out_timestamp=item['checkout_ts'],
                    branch_zone=item['zone'],
                )
                item['entry']['shortLeaveHours'] = short_hours
                item['entry']['shiftScheduledHours'] = shift_hours
            except Exception:
                logger.exception(
                    'Short-leave hours fallback also failed for staff=%s org=%s',
                    item['staff_id'], org_key,
                )


def get_approved_leaves_for_payroll_period(
    org_id: str,
    branch_id: str | list[str] | tuple[str, ...],
    period_start: str,
    period_end: str,
    staff_ids: list[str] | tuple[str, ...] | None = None,
) -> dict[str, list[dict]]:
    """Approved leaves overlapping the pay period, grouped by staff_id, with
    day-counts clipped to the period boundary."""
    from support_db_attendance_dashboard import _support_clean_text
    org_key = str(org_id)
    filtered_staff_ids = [str(s) for s in (staff_ids or []) if _support_clean_text(s)]
    has_staff_filter = staff_ids is not None

    def _query():
        q = (
            get_supabase()
            .table('leave_requests')
            .select('staff_id, leave_type, half_day_period, start_date, end_date, branch_id, reason')
            .eq('org_id', org_key)
            .eq('status', 'approved')
            .lte('start_date', period_end)
            .gte('end_date', period_start)
        )
        if isinstance(branch_id, (list, tuple)):
            branch_ids = [str(b) for b in branch_id if _support_clean_text(b)]
            if not branch_ids:
                raise ValueError('branch_id list must contain at least one valid branch id')
            q = q.in_('branch_id', branch_ids)
        else:
            q = q.eq('branch_id', str(branch_id))
        if has_staff_filter:
            if filtered_staff_ids:
                q = q.in_('staff_id', filtered_staff_ids)
            else:
                q = q.eq('staff_id', '__invalid_staff_id__')
        return q

    try:
        result = _execute_supabase('payroll_leave_period', _query)
        rows = result.data or []
    except Exception as exc:
        if not _table_missing(exc, 'leave_requests'):
            logger.exception(
                'get_approved_leaves_for_payroll_period failed for org=%s', org_key,
            )
        return {}

    attendance_ref_re = re.compile(r'attendance_id=([0-9a-f-]{8,})', re.IGNORECASE)
    linked_attendance_ids: set[str] = set()
    for leave in rows:
        reason_text = str(leave.get('reason') or '')
        match = attendance_ref_re.search(reason_text)
        if match:
            linked_attendance_ids.add(match.group(1))

    payroll_decision_by_attendance: dict[str, str] = {}
    if linked_attendance_ids:
        try:
            attendance_result = _execute_supabase(
                'payroll_leave_period.attendance_decisions',
                lambda: (
                    get_supabase()
                    .table('attendance')
                    .select('id, check_out_payroll_decision')
                    .eq('org_id', org_key)
                    .in_('id', sorted(linked_attendance_ids))
                ),
            )
            for row in (attendance_result.data or []):
                attendance_id = _support_clean_text(row.get('id'))
                decision = _support_clean_text(row.get('check_out_payroll_decision')).lower()
                if attendance_id and decision:
                    payroll_decision_by_attendance[attendance_id] = decision
        except Exception:
            payroll_decision_by_attendance = {}

    p_start, p_end = date.fromisoformat(period_start), date.fromisoformat(period_end)
    grouped: dict[str, list[dict]] = {}
    for leave in rows:
        try:
            l_start = date.fromisoformat(str(leave.get('start_date') or ''))
            l_end = date.fromisoformat(str(leave.get('end_date') or ''))
        except (ValueError, TypeError):
            continue

        overlap_start, overlap_end = max(l_start, p_start), min(l_end, p_end)
        if overlap_start > overlap_end:
            continue

        leave_type = str(leave.get('leave_type') or 'annual').lower()
        reason_text = str(leave.get('reason') or '')
        match = attendance_ref_re.search(reason_text)
        attendance_id = match.group(1) if match else ''
        payroll_decision = payroll_decision_by_attendance.get(attendance_id, '') if attendance_id else ''
        is_attendance_adjustment = attendance_id != '' or leave_type == 'attendance_adjustment'
        if payroll_decision == 'exclude':
            continue
        if payroll_decision == 'include' or is_attendance_adjustment:
            leave_type = 'unpaid'
        is_half_day = bool(leave.get('half_day_period'))
        clipped_days = 0.5 if is_half_day else (overlap_end - overlap_start).days + 1

        staff_id = _support_clean_text(leave.get('staff_id'))
        if not staff_id:
            continue

        if is_half_day:
            dates = [overlap_start.isoformat()]
        else:
            dates = [
                (overlap_start + timedelta(days=offset)).isoformat()
                for offset in range((overlap_end - overlap_start).days + 1)
            ]

        grouped.setdefault(staff_id, []).append({
            'leaveType': leave_type,
            'days': clipped_days,
            'dates': dates,
        })
    return grouped

def get_approved_overtime_hours_for_payroll_period(
    org_id: str,
    branch_id: str | list[str] | tuple[str, ...],
    period_start: str,
    period_end: str,
    staff_ids: list[str] | tuple[str, ...] | None = None,
) -> dict[str, float]:
    """Approved overtime hours per staff_id for a pay period — the payroll
    counterpart to get_staff_attendance_for_payroll_period /
    get_approved_leaves_for_payroll_period. Sums overtime_requests.hours
    for status='approved' rows whose ot_date falls inside
    [period_start, period_end], grouped by staff_id. This is what actually
    connects Overtime Management (where a request becomes 'approved') to
    the Payroll page's OT Hours column — before this, payroll never read
    overtime_requests at all.

    branch_id must be the real backend branch UUID, same as the attendance
    and leave functions above — never the UI-facing branchId."""
    from support_db_attendance_dashboard import _support_clean_text
    org_key = str(org_id)
    filtered_staff_ids = [str(s) for s in (staff_ids or []) if _support_clean_text(s)]
    has_staff_filter = staff_ids is not None
    try:
        def _query():
            q = (
                get_supabase()
                .table('overtime_requests')
                .select('staff_id, hours, ot_date, branch_id')
                .eq('org_id', org_key)
                .eq('status', 'approved')
                .gte('ot_date', period_start)
                .lte('ot_date', period_end)
            )
            if isinstance(branch_id, (list, tuple)):
                branch_ids = [str(b) for b in branch_id if _support_clean_text(b)]
                if not branch_ids:
                    raise ValueError('branch_id list must contain at least one valid branch id')
                q = q.in_('branch_id', branch_ids)
            else:
                q = q.eq('branch_id', str(branch_id))
            if has_staff_filter:
                if filtered_staff_ids:
                    q = q.in_('staff_id', filtered_staff_ids)
                else:
                    q = q.eq('staff_id', '__invalid_staff_id__')
            return q
        result = _execute_supabase('payroll_overtime_period', _query)
        rows = result.data or []
    except Exception as exc:
        if not _table_missing(exc, 'overtime_requests'):
            logger.exception('get_approved_overtime_hours_for_payroll_period failed for org=%s', org_key)
        return {}

    grouped: dict[str, float] = {}
    for row in rows:
        staff_id = _support_clean_text(row.get('staff_id'))
        if not staff_id:
            continue
        grouped[staff_id] = grouped.get(staff_id, 0.0) + float(row.get('hours') or 0)
    return grouped


def get_local_node_overtime_hours_for_payroll_period(
    org_id: str,
    branch_id: str | list[str] | tuple[str, ...],
    period_start: str,
    period_end: str,
    attendance_by_staff: dict[str, list[dict]] | None = None,
    staff_ids: list[str] | tuple[str, ...] | None = None,
) -> dict[str, float]:
    """Overtime hours from LOCAL-NODE-classified rows only (capture_channel=
    'local_node', day_status='overtime') -- the local-node counterpart to
    get_approved_overtime_hours_for_payroll_period, which only sums
    overtime_requests (the cloud/mobile path via _on_overtime_decided).
    Local-node overtime never creates an overtime_requests row -- see
    set_local_node_payroll_decision's docstring -- so this is the only
    place those hours are computed. Reuses
    support_db_attendance_exceptions.compute_overtime_hours so both paths
    share one formula.

    check_out_payroll_decision == 'exclude' is skipped; null/'include' both
    count -- same undecided-means-include default payroll_engine applies
    everywhere else.
    """
    import support_db_attendance_exceptions as _exceptions_db

    grouped = attendance_by_staff if attendance_by_staff is not None else get_staff_attendance_for_payroll_period(
        org_id,
        branch_id,
        period_start,
        period_end,
        staff_ids=staff_ids,
    )
    branch_zones: dict[str, ZoneInfo | None] = {}

    totals: dict[str, float] = {}
    for staff_id, rows in grouped.items():
        for row in rows:
            if row.get('dayStatus') != 'overtime' or row.get('captureChannel') != 'local_node':
                continue
            if row.get('checkOutPayrollDecision') == 'exclude':
                continue
            checkout_ts = row.get('checkOutTimestamp')
            if not checkout_ts:
                continue

            row_branch_id = str(row.get('branch_id') or row.get('branchId') or '')
            if not row_branch_id:
                continue

            zone = branch_zones.get(row_branch_id)
            if zone is None:
                zone = _get_branch_timezone(get_supabase(), str(org_id), row_branch_id)
                branch_zones[row_branch_id] = zone

            hours = _exceptions_db.compute_overtime_hours(
                org_id=org_id,
                branch_id=row_branch_id,
                staff_id=staff_id,
                check_out_timestamp=checkout_ts,
                branch_zone=zone,
            )
            totals[staff_id] = totals.get(staff_id, 0.0) + hours
    return totals

def create_client_leave_request(org_id: str, payload: dict) -> dict:
    from support_db_attendance_dashboard import _map_client_leave, _resolve_owned_backend_branch_id, _support_clean_text
    from support_db_staff import get_client_staff_member
    staff_id = _support_clean_text(payload.get('staff_id') or payload.get('staffId') or payload.get('user_id') or payload.get('userId'))
    if not staff_id:
        raise ValueError('staff_id/user_id is required')
    staff = get_client_staff_member(staff_id)
    if str(staff.get('organization_id')) != str(org_id):
        raise ValueError('Staff member does not belong to this organization')
    branch_id = _resolve_owned_backend_branch_id(str(org_id), payload.get('branch_id') or payload.get('branchId') or staff.get('backend_branch_id'))
    now = datetime.now(timezone.utc).isoformat()

    leave_type = str(payload.get('leave_type') or payload.get('type') or 'annual').strip().lower()

    # Half-day is a modifier that can apply to ANY leave category, not a
    # category of its own -- so whether this request is half-day is read
    # from an explicit flag (half_day_period being present, or an explicit
    # half_day/is_half_day/halfDay boolean), never inferred from leave_type.
    # This is what lets leave_type keep carrying the real category
    # (annual/sick/...) all the way through to storage, instead of being
    # overwritten to the literal string 'half_day' and losing the category
    # (the previous behavior, which forced callers like the mobile apply_leave
    # route to smuggle the category back in via the free-text `reason` field).
    half_day_period_raw = _support_clean_text(payload.get('half_day_period') or payload.get('halfDayPeriod'))
    is_half_day = bool(
        payload.get('half_day') or payload.get('halfDay') or payload.get('is_half_day')
        or half_day_period_raw
        or leave_type == 'half_day'  # back-compat: still honor old-style rows/callers
    )

    half_day_period = None
    half_day_start_time = None
    half_day_end_time = None
    if is_half_day:
        half_day_period = half_day_period_raw
        if half_day_period not in ('first_half', 'second_half'):
            raise ValueError("half_day_period must be 'first_half' or 'second_half' for a half-day leave request")
        if payload.get('start_date') != payload.get('end_date') and (payload.get('startDate') or payload.get('start_date')) != (payload.get('endDate') or payload.get('end_date')):
            # Half-day leave is defined per single calendar day (that's what
            # resolve_timing_source._find_approved_half_day_leave checks
            # against local_date, a single date) — a multi-day span with a
            # half_day_period would be ambiguous about which day it applies to.
            raise ValueError('half_day leave requests must have start_date == end_date')
        half_day_start_time = _support_clean_text(payload.get('half_day_start_time') or payload.get('halfDayStartTime'))
        half_day_end_time = _support_clean_text(payload.get('half_day_end_time') or payload.get('halfDayEndTime'))
        # A back-compat row that only ever set leave_type='half_day' (no
        # real category preserved) has nothing better to fall back to here.
        if leave_type == 'half_day':
            leave_type = str(payload.get('category') or 'annual').strip().lower()

    row = {
        'org_id': str(org_id),
        'branch_id': branch_id,
        'staff_id': staff_id,
        'user_name': payload.get('user_name') or payload.get('userName') or staff.get('name'),
        'leave_type': leave_type,
        'half_day_period': half_day_period,
        'half_day_start_time': half_day_start_time,
        'half_day_end_time': half_day_end_time,
        'start_date': payload.get('start_date') or payload.get('startDate'),
        'end_date': payload.get('end_date') or payload.get('endDate'),
        'reason': payload.get('reason') or '',
        'status': 'pending',
        'created_at': now,
        'updated_at': now,
    }
    sb = get_supabase()
    try:
        result = sb.table('leave_requests').insert(row).execute()
    except Exception as exc:
        if _table_missing(exc, 'leave_requests'):
            raise ValueError('Supabase table leave_requests is missing. Create it before using tenant leave management.') from exc
        raise
    if not result.data:
        raise RuntimeError('Failed to create leave request')
    mapped = _map_client_leave(result.data[0], {staff_id: staff})

    # Notify the requester's manager (if one is assigned) AND broadcast to
    # org admin/HR — this is the one creation path both the mobile
    # self-service form and the (currently unused) dashboard "add leave"
    # call go through, so wiring the notification here rather than in each
    # caller means neither surface can forget it. Soft-fail: a lookup issue
    # here must never block the leave request itself from being recorded.
    try:
        import support_db_hierarchy as _hierarchy_db
        import support_db_notifications as _notifications_db

        manager_staff_id = _hierarchy_db.resolve_notification_target(str(org_id), staff_id)
        employee_name = mapped.get('name') or 'Employee'
        _notifications_db.create_notification(
            str(org_id),
            module_key='leave',
            event_type='leave_applied',
            title='Leave request submitted',
            body=f"{employee_name} applied for {mapped.get('leave_type', 'leave')} leave.",
            branch_id=branch_id,
            actor_name=employee_name,
            target_entity_id=str(mapped.get('id')),
            target_entity_type='leave_request',
            target_staff_id=manager_staff_id,
            also_broadcast=True,
            metadata={
                'leave_id': mapped.get('id'),
                'employee_name': employee_name,
                'leave_type': mapped.get('leave_type'),
                'start_date': mapped.get('start_date'),
                'end_date': mapped.get('end_date'),
            },
        )
    except Exception:
        logger.warning('Failed to create notification for client leave request %s', mapped.get('id'), exc_info=True)

    return mapped

def get_client_leave_owned_by_org(leave_id: str, org_id: str) -> dict:
    """Single org-scoped read, used by the PUT/DELETE routes to check
    team-scope ownership BEFORE mutating — mirrors the
    _get_staff_owned_by_org pattern in support_db_hierarchy.py. Raises
    ValueError (-> 404 via the route) rather than ever leaking whether a
    leave_id exists in a different org."""
    from support_db_attendance_dashboard import _map_client_leave
    sb = get_supabase()
    result = (
        sb.table('leave_requests')
        .select('*')
        .eq('id', str(leave_id))
        .eq('org_id', str(org_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError('Leave request not found for this organization')
    return _map_client_leave(result.data[0])

def update_client_leave_status(leave_id: str, org_id: str, status: str, approved_by: str = 'Admin') -> dict:
    from support_db_attendance_dashboard import _map_client_leave
    clean_status = str(status or 'approved').lower()
    if clean_status not in {'approved', 'rejected', 'pending'}:
        clean_status = 'approved'
    now = datetime.now(timezone.utc).isoformat()
    sb = get_supabase()
    result = (
        sb.table('leave_requests')
        .update({'status': clean_status, 'approved_by': approved_by, 'updated_at': now})
        .eq('id', str(leave_id))
        .eq('org_id', str(org_id))
        .execute()
    )
    if not result.data:
        raise ValueError('Leave request not found for this organization')
    return _map_client_leave(result.data[0])

def delete_client_leave_request(leave_id: str, org_id: str) -> bool:
    sb = get_supabase()
    result = sb.table('leave_requests').delete().eq('id', str(leave_id)).eq('org_id', str(org_id)).execute()
    if not result.data:
        raise ValueError('Leave request not found for this organization')
    return True

def _map_client_overtime(row: dict, staff_by_id: dict[str, dict] | None = None, org_id: str | None = None) -> dict:
    from support_db_attendance_dashboard import _resolve_staff_people_type, _support_clean_text
    from support_db_staff import _branch_ui_id
    staff_by_id = staff_by_id or {}
    staff_id = _support_clean_text(row.get('staff_id') or row.get('user_id') or row.get('client_staff_id'))
    staff = staff_by_id.get(staff_id, {})
    backend_branch_id = _support_clean_text(row.get('branch_id') or staff.get('backend_branch_id'))
    ui_branch_id = _branch_ui_id(str(org_id), backend_branch_id) if org_id and backend_branch_id else None
    name = row.get('user_name') or row.get('staff_name') or staff.get('name') or 'Unknown'
    branch_name = row.get('branch_name') or staff.get('branch_name') or ''
    department = row.get('department') or staff.get('department') or ''
    people_type = _resolve_staff_people_type(staff)
    return {
        **row,
        'id': row.get('id'),
        'org_id': row.get('org_id') or row.get('organization_id'),
        'organization_id': row.get('organization_id') or row.get('org_id'),
        'user_id': staff_id,
        'userId': staff_id,
        'staff_id': staff_id,
        'staffId': staff_id,
        'user_name': name,
        'userName': name,
        'name': name,
        'branch_id': ui_branch_id,
        'branchId': ui_branch_id,
        'backend_branch_id': backend_branch_id,
        'backendBranchId': backend_branch_id,
        'branch_name': branch_name,
        'branchName': branch_name,
        'department': department,
        'people_type': people_type,
        'peopleType': people_type,
        'ot_date': row.get('ot_date') or row.get('date') or row.get('overtime_date'),
        'hours': float(row.get('hours') or 0),
        'reason': row.get('reason') or '',
        'status': row.get('status') or 'pending',
        'approved_by': row.get('approved_by'),
        'approvedBy': row.get('approved_by'),
        'created_at': row.get('created_at'),
        'createdAt': row.get('created_at'),
        'updated_at': row.get('updated_at'),
        'updatedAt': row.get('updated_at'),
    }

def list_client_overtime_requests(org_id: str, branch_id: object = None, user_id: object = None, status: str | None = None, people_type: str | None = None) -> list[dict]:
    from support_db_attendance_dashboard import _client_staff_lookup, _resolve_owned_backend_branch_id, _resolve_staff_people_type, _support_clean_text
    from support_db_organizations import get_organization
    from support_db_staff import _normalize_people_type
    get_organization(str(org_id))
    sb = get_supabase()
    clean_people_type = _normalize_people_type(people_type, 'staff') if people_type else None
    try:
        query = sb.table('overtime_requests').select('*').eq('org_id', str(org_id))
        branch_backend = _resolve_owned_backend_branch_id(str(org_id), branch_id) if _support_clean_text(branch_id) else None
        if branch_backend:
            query = query.eq('branch_id', branch_backend)
        if _support_clean_text(user_id):
            query = query.eq('staff_id', _support_clean_text(user_id))
        if status:
            query = query.eq('status', str(status).lower())
        result = query.order('created_at', desc=True).execute()
    except Exception as exc:
        if _table_missing(exc, 'overtime_requests'):
            logger.warning('overtime_requests table is missing; returning empty tenant-scoped overtime list')
            return []
        raise
    rows = result.data or []
    staff_ids = sorted({_support_clean_text(row.get('staff_id') or row.get('user_id')) for row in rows if _support_clean_text(row.get('staff_id') or row.get('user_id'))})
    staff_by_id = _client_staff_lookup(str(org_id), staff_ids)

    if clean_people_type:
        filtered_rows = []
        for row in rows:
            staff_id = _support_clean_text(row.get('staff_id') or row.get('user_id'))
            staff = staff_by_id.get(staff_id, {})
            if _resolve_staff_people_type(staff) == clean_people_type:
                filtered_rows.append(row)
        rows = filtered_rows

    return [_map_client_overtime(row, staff_by_id, org_id) for row in rows]

def create_client_overtime_request(org_id: str, payload: dict) -> dict:
    from support_db_attendance_dashboard import _resolve_owned_backend_branch_id, _support_clean_text
    from support_db_staff import get_client_staff_member
    staff_id = _support_clean_text(payload.get('staff_id') or payload.get('staffId') or payload.get('user_id') or payload.get('userId'))
    if not staff_id:
        raise ValueError('staff_id/user_id is required')
    staff = get_client_staff_member(staff_id)
    if str(staff.get('organization_id')) != str(org_id):
        raise ValueError('Staff member does not belong to this organization')
    branch_id = _resolve_owned_backend_branch_id(str(org_id), payload.get('branch_id') or payload.get('branchId') or staff.get('backend_branch_id'))
    now = datetime.now(timezone.utc).isoformat()
    row = {
        'org_id': str(org_id),
        'branch_id': branch_id,
        'staff_id': staff_id,
        'user_name': payload.get('user_name') or payload.get('userName') or staff.get('name'),
        'ot_date': payload.get('ot_date') or payload.get('date') or datetime.now(timezone.utc).date().isoformat(),
        'hours': float(payload.get('hours') or 0),
        'reason': payload.get('reason') or '',
        'status': 'pending',
        'created_at': now,
        'updated_at': now,
    }
    sb = get_supabase()
    try:
        result = sb.table('overtime_requests').insert(row).execute()
    except Exception as exc:
        if _table_missing(exc, 'overtime_requests'):
            raise ValueError('Supabase table overtime_requests is missing. Create it before using tenant overtime management.') from exc
        raise
    if not result.data:
        raise RuntimeError('Failed to create overtime request')
    return _map_client_overtime(result.data[0], {staff_id: staff}, org_id)

def get_client_overtime_owned_by_org(overtime_id: str, org_id: str) -> dict:
    """Single org-scoped read, used by the PUT route to check team-scope
    ownership BEFORE mutating — see get_client_leave_owned_by_org above."""
    sb = get_supabase()
    result = (
        sb.table('overtime_requests')
        .select('*')
        .eq('id', str(overtime_id))
        .eq('org_id', str(org_id))
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError('Overtime request not found for this organization')
    return _map_client_overtime(result.data[0], org_id=org_id)

def update_client_overtime_status(overtime_id: str, org_id: str, status: str, approved_by: str = 'Admin') -> dict:
    clean_status = str(status or 'approved').lower()
    if clean_status not in {'approved', 'rejected', 'pending'}:
        clean_status = 'approved'
    now = datetime.now(timezone.utc).isoformat()
    sb = get_supabase()
    result = (
        sb.table('overtime_requests')
        .update({'status': clean_status, 'approved_by': approved_by, 'updated_at': now})
        .eq('id', str(overtime_id))
        .eq('org_id', str(org_id))
        .execute()
    )
    if not result.data:
        raise ValueError('Overtime request not found for this organization')
    return _map_client_overtime(result.data[0], org_id=org_id)

def get_client_branch_summary(org_id: str, people_type: str | None = None) -> dict:
    from support_db_attendance_dashboard import get_client_attendance_statistics, list_client_leave_requests
    from support_db_branches import list_branches
    from support_db_organizations import get_organization
    from support_db_staff import _normalize_people_type, list_client_staff
    org = get_organization(str(org_id))
    branches = list_branches(str(org_id))
    clean_people_type = (
        _normalize_people_type(people_type, "") if people_type else None
    )
    now = datetime.now(timezone.utc).isoformat()

    active_staff = list_client_staff(
        str(org_id), archived=False, role='staff', people_type=clean_people_type
    )
    archived_staff = []
    try:
        archived_staff = list_client_staff(
            str(org_id), archived=True, role='staff', people_type=clean_people_type
        )
    except Exception:
        archived_staff = []

    staff_by_branch: dict[str, list[dict]] = {}
    for staff in active_staff:
        key = str(staff.get('backend_branch_id') or '')
        staff_by_branch.setdefault(key, []).append(staff)

    pending_by_branch: dict[str, int] = {}
    try:
        for item in list_client_leave_requests(
            str(org_id), status='pending', people_type=clean_people_type
        ):
            key = str(item.get('backend_branch_id') or item.get('branch_id') or '')
            pending_by_branch[key] = pending_by_branch.get(key, 0) + 1
    except Exception:
        pass

    overtime_by_branch: dict[str, float] = {}
    try:
        for item in list_client_overtime_requests(
            str(org_id), people_type=clean_people_type
        ):
            key = str(item.get('backend_branch_id') or item.get('branch_id') or '')
            overtime_by_branch[key] = overtime_by_branch.get(key, 0.0) + float(item.get('hours') or 0)
    except Exception:
        pass

    rows = []
    for idx, branch in enumerate(branches, start=1):
        backend_id = str(branch.get('id'))
        staff_rows = staff_by_branch.get(backend_id, [])
        name = branch.get('name') or f'Branch {idx}'
        city = branch.get('location') or ''
        staff_count = len(staff_rows)
        enrolled = sum(1 for item in staff_rows if item.get('is_face_verified'))
        payroll = sum(float(item.get('salary') or 0) for item in staff_rows)
        try:
            stats = get_client_attendance_statistics(str(org_id), branch_id=backend_id)
        except Exception:
            stats = {}
        present = int(stats.get('present_today') or stats.get('unique_users_today') or 0)
        absent = max(0, staff_count - present)
        attendance_rate = round((present / staff_count) * 100) if staff_count else 0
        rows.append({
            'id': idx,
            'branchId': idx,
            'backend_branch_id': backend_id,
            'backendBranchId': backend_id,
            'branch_uuid': backend_id,
            'branchUuid': backend_id,
            'name': name,
            'branchName': name,
            'city': city,
            'branchCity': city,
            'maxStaffCapacity': branch.get('max_staff_capacity') or 0,
            'max_staff_capacity': branch.get('max_staff_capacity') or 0,
            'staff': staff_count,
            'staffCount': staff_count,
            'activeStaff': staff_count,
            'enrolledStaff': enrolled,
            'presentToday': present,
            'absentToday': absent,
            'attendance': attendance_rate,
            'attendanceRate': attendance_rate,
            'payroll': payroll,
            'revenue': payroll,
            'late': int(stats.get('late_today') or 0),
            'lateCount': int(stats.get('late_today') or 0),
            'pendingLeaves': pending_by_branch.get(backend_id, 0),
            'overtimeHours': overtime_by_branch.get(backend_id, 0),
        })

    total_staff = sum(item['staffCount'] for item in rows)
    total_present = sum(item['presentToday'] for item in rows)
    return {
        'organization_id': str(org_id),
        'organization_name': org.get('name'),
        'generated_at': now,
        'totals': {
            'branches': len(rows),
            'staff': total_staff,
            'activeStaff': total_staff,
            'enrolledStaff': sum(item['enrolledStaff'] for item in rows),
            'presentToday': total_present,
            'absentToday': max(0, total_staff - total_present),
            'payroll': sum(item['payroll'] for item in rows),
            'late': sum(item['late'] for item in rows),
            'pendingLeaves': sum(item['pendingLeaves'] for item in rows),
            'overtimeHours': sum(item['overtimeHours'] for item in rows),
            'attendanceRate': round((total_present / total_staff) * 100) if total_staff else 0,
            'archivedStaff': len(archived_staff),
        },
        'branches': rows,
    }

def _payroll_text(value: object) -> str:
    return str(value or '').strip()

def _payroll_float(value: object, fallback: float = 0.0) -> float:
    try:
        return float(value if value is not None and value != '' else fallback)
    except (TypeError, ValueError):
        return fallback

def _payroll_positive_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))

def _payroll_sort_column(sort_by: object) -> str:
    key = _payroll_text(sort_by).lower()
    allowed = {
        'name': 'name',
        'staffname': 'name',
        'employee': 'name',
        'employeeid': 'employee_id',
        'code': 'employee_id',
        # department_name is not guaranteed in every tenant schema; avoid
        # ordering by optional columns in PostgREST. The mapped row still exposes
        # department/departmentName after serialization.
        'department': 'name',
        'departmentname': 'name',
        'branch': 'branch_id',
        'branchname': 'branch_id',
        'basesalary': 'salary',
        'basicsalary': 'salary',
        'salary': 'salary',
        'netpay': 'salary',
        'status': 'status',
        'createdat': 'created_at',
        'updatedat': 'updated_at',
    }
    return allowed.get(key, 'name')

def get_own_salary_snapshot(org_id: str, staff_id: str) -> dict:
    """Self-service salary breakdown for exactly one staff member — the
    mobile HR Assistant's source for salary questions.
 
    Returns the LAST PROCESSED payroll row on salary_configs, not a live
    recomputation for the current period — same as what the dashboard
    Payroll page shows before an admin runs the next payroll cycle. If no
    salary_configs row exists yet for this staff member, every figure is
    0 and status is 'Not set' — the caller (support_db_hr_assistant) is
    expected to say so plainly rather than presenting zeroes as real pay.
    """
    org_key, staff_key = str(org_id), str(staff_id)
 
    def _query_by(column: str):
        return (
            get_supabase()
            .table('salary_configs')
            .select('*')
            .eq(column, org_key)
            .eq('staff_id', staff_key)
            .limit(1)
        )
 
    try:
        result = _execute_supabase(
            'get_own_salary_snapshot.organization_id',
            lambda: _query_by('organization_id'),
        )
    except Exception as exc:
        if 'organization_id' not in str(exc).lower():
            raise
        result = _execute_supabase(
            'get_own_salary_snapshot.org_id',
            lambda: _query_by('org_id'),
        )
 
    rows = result.data or []
    if not rows:
        return {
            'configured': False,
            'basic_salary': 0.0, 'allowances': 0.0, 'deductions': 0.0,
            'ot_rate': 0.0, 'net_pay': 0.0,
            'status': 'Not set', 'last_paid_date': None,
        }
 
    row = rows[0]
    basic_salary = _payroll_float(row.get('basic_salary'))
    allowances = _payroll_float(row.get('allowances'))
    deductions = _payroll_float(row.get('deductions'))
    ot_rate = _payroll_float(row.get('ot_rate'))
    ot_hours = _payroll_float(row.get('ot_hours'))
    overtime_amount = _payroll_float(row.get('overtime_amount'), ot_hours * ot_rate)
    # Same formula as _payroll_page_row's net_pay — do not let this drift.
    net_pay = max(0.0, basic_salary + allowances + overtime_amount - deductions)
    status = _payroll_text(row.get('status') or 'Paid') or 'Paid'
    normalized_status = 'Pending' if status.lower() == 'pending' else 'Paid'
 
    return {
        'configured': True,
        'basic_salary': basic_salary,
        'allowances': allowances,
        'deductions': deductions,
        'ot_rate': ot_rate,
        'net_pay': net_pay,
        'status': normalized_status,
        'last_paid_date': row.get('effective_from') if normalized_status == 'Paid' else None,
    }


def _payroll_page_row(
    org_id: str,
    staff: dict,
    branch_lookup: dict[str, dict],
    branch_ui_lookup: dict[str, int],
    salary_config: dict | None = None,
    breakdown: dict | None = None,
    present_days: int | None = None,
    paid_staff_ids: set[str] | None = None,
    effective_ot_rate: float | None = None,
    policy: dict | None = None,
) -> dict:
    """breakdown: optional payroll_engine.PayrollBreakdown.to_dict() computed
    live from real attendance/leave/overtime data for the requested period —
    see get_client_payroll_page. When supplied it is authoritative for
    deductions/overtime/net_pay; salary_config's own deductions/ot_hours
    fields become a display-only fallback for un-scoped/no-period requests
    (e.g. an 'All Branches' view, where a single-branch attendance query
    isn't resolvable).

    paid_staff_ids: optional set of staff_ids explicitly marked paid for the
    requested period (get_paid_payroll_periods) — the real source of truth
    for 'status' whenever a period was resolved. Falls back to
    salary_config's manual status field only when no period was requested.

    policy: this staff member's resolved effective PayrollPolicy (individual
    > branch > org — see get_client_payroll_page's resolve_policy). Needed
    to turn salary_config['applied_allowances'] into an actual amount via
    resolve_effective_allowances — without it, named allowances (fixed/
    percent) can't be priced and the ALLOWANCES column silently shows only
    the legacy flat 'allowances' field, same bug class as an unresolved OT
    rate would be. Caller must pass this; None degrades to "no allowance
    catalog visible" rather than raising, same resilience posture as an
    absent salary_config."""
    from support_db_attendance_dashboard import _resolve_staff_people_type
    salary_config = salary_config or {}
    staff_id = _payroll_text(staff.get('id'))
    people_type = _resolve_staff_people_type(staff)
    backend_branch_id = _payroll_text(staff.get('branch_id')) or None
    branch = branch_lookup.get(str(backend_branch_id or '')) or {}
    branch_name = _payroll_text(staff.get('branch_name') or branch.get('name')) or 'Main Branch'
    # Department source of truth is public.client_staff.department_name, backed
    # by optional department_id. A plain client_staff.department column is not
    # part of the schema contract and must not be used.
    department = _payroll_text(staff.get('department_name')) or 'Unassigned'

    basic_salary = _payroll_float(
        salary_config.get('basic_salary')
        if salary_config.get('basic_salary') is not None
        else staff.get('salary')
    )
    # Legacy flat number — kept as an "Other / Manual Adjustment" line rather
    # than migrated away, same as app.py's _tenant_salary_map_row, so a
    # genuine one-off adjustment someone already has on file doesn't
    # silently vanish once named allowance types exist.
    manual_allowance = _payroll_float(salary_config.get('allowances'))
    applied_allowances = salary_config.get('applied_allowances')
    applied_allowances = applied_allowances if isinstance(applied_allowances, dict) else {}
    allowance_items, named_allowance_total = resolve_effective_allowances(
        applied_allowances, policy or {}, basic_salary,
    )
    allowances = manual_allowance + named_allowance_total
    # ot_rate: raw per-staff override only (0 = none set) — kept as-is so
    # the frontend can still prefill the "OT Rate Override" edit field with
    # exactly what's stored, distinct from the resolved rate below.
    ot_rate = _payroll_float(salary_config.get('ot_rate'))
    # effective_ot_rate: the rate actually applied to this staff member's
    # pay — individual override, else their branch's override, else the
    # org default (see resolve_effective_ot_rate). This is what the "OT
    # RATE/HR" column should display; falls back to the raw ot_rate above
    # only if a caller doesn't pass it (defensive, shouldn't happen from
    # get_client_payroll_page).
    resolved_ot_rate = _payroll_float(effective_ot_rate) if effective_ot_rate is not None else ot_rate

    if breakdown is not None:
        ot_hours = _payroll_float(breakdown.get('overtime_hours'))
        overtime_amount = _payroll_float(breakdown.get('overtime_amount'))
        deductions = _payroll_float(breakdown.get('total_deductions'))
    else:
        ot_hours = _payroll_float(salary_config.get('ot_hours'))
        overtime_amount = _payroll_float(salary_config.get('overtime_amount'), ot_hours * ot_rate)
        deductions = _payroll_float(salary_config.get('deductions'))

    net_pay = max(0.0, basic_salary + allowances + overtime_amount - deductions)
    branch_ui_id = branch_ui_lookup.get(str(backend_branch_id or ''))
    employee_id = _payroll_text(staff.get('employee_id')) or staff_id
    display_name = _payroll_text(staff.get('name')) or 'Unknown'

    # Payroll "paid" status must never be read off staff/config rows that
    # weren't scoped to this period — see mark_payroll_paid/get_paid_payroll_periods.
    if paid_staff_ids is not None:
        normalized_status = 'Paid' if staff_id in paid_staff_ids else 'Pending'
    else:
        status = _payroll_text(salary_config.get('status') or 'Paid') or 'Paid'
        normalized_status = 'Pending' if status.lower() == 'pending' else 'Paid'

    resolved_present_days = _payroll_float(
        present_days if present_days is not None else salary_config.get('present_days')
    )

    cnic = _payroll_text(staff.get('cnic'))

    result = {
        'id': salary_config.get('id') or staff_id,
        'payroll_id': salary_config.get('id') or staff_id,
        'user_id': staff_id,
        'staff_id': staff_id,
        'client_staff_id': staff_id,
        'employee_id': employee_id,
        'employeeId': employee_id,
        'empId': employee_id,
        'name': display_name,
        'staff_name': display_name,
        'staffName': display_name,
        'people_type': people_type,
        'peopleType': people_type,
        'email': staff.get('email'),
        'cnic': cnic,
        'designation': staff.get('position') or staff.get('role_name'),
        'position': staff.get('position') or staff.get('role_name'),
        'department': department,
        'department_name': department,
        'branch_id': branch_ui_id if branch_ui_id is not None else backend_branch_id,
        'branchId': branch_ui_id if branch_ui_id is not None else backend_branch_id,
        'backend_branch_id': backend_branch_id,
        'backendBranchId': backend_branch_id,
        'branch_uuid': backend_branch_id,
        'branchUuid': backend_branch_id,
        'branch_name': branch_name,
        'branchName': branch_name,
        'basic_salary': basic_salary,
        'basicSalary': basic_salary,
        'base_salary': basic_salary,
        'baseSalary': basic_salary,
        'salary': basic_salary,
        'allowances': allowances,
        'manual_allowance': manual_allowance,
        'applied_allowances': applied_allowances,
        'appliedAllowances': applied_allowances,
        'allowances_breakdown': allowance_items,
        'allowancesBreakdown': allowance_items,
        'deductions': deductions,
        'ot_rate': ot_rate,
        'otRate': ot_rate,
        'effective_ot_rate': resolved_ot_rate,
        'effectiveOtRate': resolved_ot_rate,
        'ot_hours': ot_hours,
        'otHours': ot_hours,
        'overtime_amount': overtime_amount,
        'overtimeAmount': overtime_amount,
        'present_days': resolved_present_days,
        'presentDays': resolved_present_days,
        'net_pay': net_pay,
        'netPay': net_pay,
        'status': normalized_status,
        'effective_from': salary_config.get('effective_from'),
        'effectiveFrom': salary_config.get('effective_from'),
        'created_at': staff.get('created_at'),
        'createdAt': staff.get('created_at'),
        'updated_at': salary_config.get('updated_at') or staff.get('updated_at'),
        'updatedAt': salary_config.get('updated_at') or staff.get('updated_at'),
        'organization_id': org_id,
        'organizationId': org_id,
    }
    if breakdown is not None:
        result['payroll_breakdown'] = breakdown
    return result



def get_client_payroll_page(
    org_id: str,
    branch_id: object = None,
    page: object = 1,
    page_size: object = 250,
    search: object = None,
    sort_by: object = 'name',
    sort_dir: object = 'asc',
    period_start: object = None,
    period_end: object = None,
    people_type: object = None,
) -> dict:
    """Return a UUID-safe, paginated payroll page from Supabase.

    people_type: same convention as list_client_overtime_requests /
    get_client_branch_summary -- when given, only staff of that resolved
    people_type (student/worker/staff/teacher/etc, see
    support_db_attendance_gate._normalize_people_type) are returned. None
    (the default) keeps the previous unscoped-by-type behavior. This is a
    server-side filter, not a display concern, so a "worker" selection can
    never leak "staff" rows into the page even transiently.

    Source of truth is public.client_staff.salary. Optional public.salary_configs
    overlays allowances/deductions/rates. This implementation is intentionally
    schema-safe: it never queries client_staff.department because that column is
    not present in all tenant schemas. Department is a display value only and is
    derived after fetch when available; otherwise it becomes "General".
    """
    from support_db_organizations import get_organization
    from support_db_staff import _client_branch_indexes, _resolve_client_branch
    org_key = _payroll_text(org_id)
    if not org_key:
        raise ValueError('organization_id/orgId is required')

    clean_people_type = (
        _normalize_people_type(people_type, '') if people_type else None
    ) or None

    # Validates the organization and keeps metadata tenant-scoped/cached.
    get_organization(org_key)
    branches, backend_to_ui, branch_by_backend = _client_branch_indexes(org_key)

    backend_branch_id: str | None = None
    if _payroll_text(branch_id):
        branch, _ui_id = _resolve_client_branch(org_key, branch_id)
        backend_branch_id = _payroll_text(branch.get('id'))

    page_number = _payroll_positive_int(page, 1, 1, 1_000_000)
    size = _payroll_positive_int(page_size, 250, 1, 500)
    start = (page_number - 1) * size
    end = start + size - 1
    descending = _payroll_text(sort_dir).lower() == 'desc'

    requested_sort_column = _payroll_sort_column(sort_by)
    # Only order by columns that are part of the safe select list. If the UI asks
    # for department/branch/net salary, the row is still exposed after mapping,
    # but DB ordering falls back to name so missing optional columns cannot 500.
    db_sort_column = requested_sort_column if requested_sort_column in {
        'id', 'branch_id', 'employee_id', 'name', 'email', 'salary', 'status',
        'created_at', 'updated_at',
    } else 'name'
    search_text = _payroll_text(search).replace(',', ' ')

    safe_staff_selects = [
        # Contract schema, with CNIC. public.client_staff owns
        # department_id/department_name plus the identity-document columns
        # added alongside father_name/father_cnic/father_phone. Tried first;
        # falls back to the no-cnic variant below on tenants that haven't
        # migrated yet, same "optional column, never crash" posture as the
        # rest of this ladder.
        'id,org_id,branch_id,department_id,department_name,employee_id,name,email,position,role_name,role,people_type,status,is_archived,salary,cnic,created_at,updated_at',
        # Contract schema. public.client_staff owns department_id/department_name.
        # Do not query a plain client_staff.department column. It is not part of
        # the tenant contract and causes PostgREST 42703 errors. people_type is
        # part of the same stable contract (selected unconditionally elsewhere,
        # e.g. the short-leave staff batch above), so it's included in every
        # variant rather than only the top one.
        'id,org_id,branch_id,department_id,department_name,employee_id,name,email,position,role_name,role,people_type,status,is_archived,salary,created_at,updated_at',
        # Compatibility with older deployments before role_name was added.
        'id,org_id,branch_id,department_id,department_name,employee_id,name,email,position,role,people_type,status,is_archived,salary,created_at,updated_at',
        # Some older tenant schemas do not have position.
        'id,org_id,branch_id,department_id,department_name,employee_id,name,email,role,people_type,status,is_archived,salary,created_at,updated_at',
        # Minimal schema; role/is_archived/people_type filtering is applied
        # only if available.
        'id,org_id,branch_id,employee_id,name,email,salary,created_at,updated_at',
        # Last resort. select(*) is safe because it does not name optional columns.
        '*',
    ]

    def _build_staff_query(select_columns: str, include_role_filter: bool, include_archive_filter: bool, include_search: bool):
        q = (
            get_supabase()
            .table('client_staff')
            .select(select_columns, count='exact')
            .eq('org_id', org_key)
        )
        # include_role_filter is intentionally never applied to `role` here.
        # `role` is the two-tier account-lifecycle column (admin/staff, see
        # role_permissions.py) -- it is NOT a job title, and an 'admin'
        # account is still a real, salaried employee. Filtering role=='staff'
        # silently dropped every admin/manager's own row from payroll (they
        # only ever saw their reports, never themselves). The parameter is
        # kept (rather than removed) so the cached-variant tuple shape below
        # stays stable; it is just never wired to a query clause anymore.
        if include_archive_filter:
            q = q.eq('is_archived', False)
        if backend_branch_id:
            q = q.eq('branch_id', backend_branch_id)
        if include_search and search_text:
            like = f'%{search_text}%'
            # Only stable text columns are searched server-side. Do not search
            # department because client_staff.department does not exist here.
            q = q.or_(f'name.ilike.{like},employee_id.ilike.{like},email.ilike.{like}')
        return q.order(db_sort_column, desc=descending).range(start, end)

    staff_result = None
    last_staff_exc: Exception | None = None
    winning_variant: tuple | None = None

    # [Fix-4] Fast path: if we already know which (select_columns,
    # include_role_filter, include_archive_filter, include_search) combo
    # worked for this org last time, try ONLY that one first. A healthy-
    # schema org resolves in a single query instead of the up-to-15-combo
    # ladder below. If the cached combo no longer works (schema changed
    # since), this just falls through to the full ladder unchanged --
    # correctness never depends on the cache being right.
    cached_variant = _cache_get(_PAYROLL_STAFF_SELECT_VARIANT_CACHE, org_key)
    if cached_variant is not None:
        cached_select_columns, cached_include_role_filter, cached_include_archive_filter, cached_include_search = cached_variant
        try:
            staff_result = _execute_supabase(
                f'client_payroll_page.staff.cached.{cached_select_columns[:24]}',
                lambda: _build_staff_query(
                    cached_select_columns,
                    cached_include_role_filter,
                    cached_include_archive_filter,
                    cached_include_search,
                ),
            )
            winning_variant = cached_variant
        except Exception as exc:
            last_staff_exc = exc
            staff_result = None

    # Try from strongest filtering to weakest. This keeps good schemas fast and
    # still prevents one optional column from breaking the entire dashboard.
    if staff_result is None:
        for select_columns in safe_staff_selects:
            for include_role_filter, include_archive_filter in ((True, True), (False, True), (False, False)):
                try:
                    staff_result = _execute_supabase(
                        f'client_payroll_page.staff.{select_columns[:24]}',
                        lambda select_columns=select_columns, include_role_filter=include_role_filter, include_archive_filter=include_archive_filter: _build_staff_query(
                            select_columns,
                            include_role_filter,
                            include_archive_filter,
                            True,
                        ),
                    )
                    last_staff_exc = None
                    winning_variant = (select_columns, include_role_filter, include_archive_filter, True)
                    break
                except Exception as exc:
                    last_staff_exc = exc
                    text = str(exc).lower()
                    # If search references a missing optional server column in an
                    # older deployed file, retry with the current safe search disabled.
                    if 'client_staff.department' in text or 'column client_staff.department' in text:
                        try:
                            staff_result = _execute_supabase(
                                f'client_payroll_page.staff.no_department_search.{select_columns[:24]}',
                                lambda select_columns=select_columns, include_role_filter=include_role_filter, include_archive_filter=include_archive_filter: _build_staff_query(
                                    select_columns,
                                    include_role_filter,
                                    include_archive_filter,
                                    False,
                                ),
                            )
                            last_staff_exc = None
                            winning_variant = (select_columns, include_role_filter, include_archive_filter, False)
                            break
                        except Exception as retry_exc:
                            last_staff_exc = retry_exc
                            continue
                    # Continue only for schema-cache / missing-column problems.
                    if 'client_staff' not in text and 'pgrst204' not in text and '42703' not in text:
                        raise
                    continue
            if staff_result is not None:
                break

    if staff_result is None:
        raise last_staff_exc or RuntimeError('Unable to load payroll staff page')

    if winning_variant is not None:
        _cache_set_for(
            _PAYROLL_STAFF_SELECT_VARIANT_CACHE, org_key, winning_variant,
            _PAYROLL_STAFF_SELECT_VARIANT_TTL_SECONDS,
        )

    staff_rows = staff_result.data or []

    # If we had to use a schema without role/is_archived filters, enforce the
    # available fields in Python without crashing when they are absent.
    normalized_staff_rows: list[dict] = []
    for row in staff_rows:
        row = dict(row or {})
        # Do NOT drop rows here by `role` (admin/staff account tier) -- see
        # the matching note in _build_staff_query above. An admin's own
        # client_staff row belongs on the payroll page like everyone
        # else's; only is_archived/people_type/search narrow this list.
        if row.get('is_archived') is True:
            continue
        if clean_people_type:
            row_people_type = _normalize_people_type(
                row.get('people_type') or row.get('peopleType'), 'staff',
            )
            if row_people_type != clean_people_type:
                continue
        if search_text:
            haystack = ' '.join([
                _payroll_text(row.get('name')),
                _payroll_text(row.get('employee_id')),
                _payroll_text(row.get('email')),
                _payroll_text(row.get('position')),
                _payroll_text(row.get('department_name')),
            ]).lower()
            if search_text.lower() not in haystack:
                continue
        normalized_staff_rows.append(row)

    staff_rows = normalized_staff_rows
    total = int(staff_result.count or len(staff_rows) or 0)
    staff_ids = [_payroll_text(row.get('id')) for row in staff_rows if _payroll_text(row.get('id'))]

    salary_by_staff: dict[str, dict] = {}
    if staff_ids:
        try:
            def _salary_builder_by_organization_id():
                return (
                    get_supabase()
                    .table('salary_configs')
                    .select('*')
                    .eq('organization_id', org_key)
                    .in_('staff_id', staff_ids)
                )

            try:
                salary_result = _execute_supabase(
                    'client_payroll_page.salary_configs.organization_id',
                    _salary_builder_by_organization_id,
                )
            except Exception as first_exc:
                if 'organization_id' not in str(first_exc).lower():
                    raise

                def _salary_builder_by_org_id():
                    return (
                        get_supabase()
                        .table('salary_configs')
                        .select('*')
                        .eq('org_id', org_key)
                        .in_('staff_id', staff_ids)
                    )

                salary_result = _execute_supabase(
                    'client_payroll_page.salary_configs.org_id',
                    _salary_builder_by_org_id,
                )

            for row in salary_result.data or []:
                staff_key = _payroll_text(row.get('staff_id') or row.get('user_id') or row.get('client_staff_id'))
                if staff_key:
                    salary_by_staff[staff_key] = row
        except Exception as exc:
            if _table_missing(exc, 'salary_configs') or 'salary_configs' in str(exc).lower():
                salary_by_staff = {}
            else:
                raise

    # Live deduction/OT/leave computation via payroll_engine. Attendance/
    # leave/overtime queries are branch_id-scoped by schema, so rather than
    # requiring one specific requested branch (backend_branch_id), this
    # groups the *current page's staff* by their own branch and queries
    # each branch that actually has staff on this page — which covers both
    # a single-branch filter (one branch, same result as before) and an
    # "All Branches" view (multiple branches, merged by staff_id, since
    # each staff member belongs to exactly one branch so keys never
    # collide). Only a period is required now, not a branch filter.
    period_start_text = _payroll_text(period_start) or None
    period_end_text = _payroll_text(period_end) or None
    breakdown_by_staff: dict[str, dict] = {}
    present_days_by_staff: dict[str, int] = {}
    paid_staff_ids: set[str] | None = None

    # Policy resolution (individual > branch > org — see get_payroll_policy)
    # is independent of whether a pay period was requested, so it's hoisted
    # out of the period-gated block below: the table needs the correct
    # effective OT rate on every load, including an un-scoped "All
    # Branches, no period" view, not only once attendance/leave data is
    # being computed. branch_policy_cache/staff_policy_cache memoize per
    # distinct branch/staff for this one request so an org with N branches
    # costs N override lookups total, not one per staff row.
    org_policy_default = _org_default_payroll_policy(org_key)
    branch_policy_cache: dict[str, dict] = {}
    staff_policy_cache: dict[str, dict] = {}

    def resolve_policy(branch_id: str | None, staff_id: str) -> dict:
        policy = org_policy_default
        if branch_id:
            branch_policy = branch_policy_cache.get(branch_id)
            if branch_policy is None:
                branch_policy = _payroll_policy_override(org_key, branch_id=branch_id) or {}
                branch_policy_cache[branch_id] = branch_policy
            if branch_policy:
                policy = {**policy, **branch_policy}
        if staff_id:
            staff_policy = staff_policy_cache.get(staff_id)
            if staff_policy is None:
                staff_policy = _payroll_policy_override(org_key, staff_id=staff_id) or {}
                staff_policy_cache[staff_id] = staff_policy
            if staff_policy:
                policy = {**policy, **staff_policy}
        return policy

    # Effective OT rate per staff — used both to display "OT RATE/HR" on
    # every row and as the rate fed into compute_payroll_breakdown below.
    # Computed unconditionally (not just when a period breakdown runs) so
    # the rate column is always correct, even before a period is picked.
    effective_ot_rate_by_staff: dict[str, float] = {}
    policy_by_staff: dict[str, dict] = {}
    for staff in staff_rows:
        staff_id = _payroll_text(staff.get('id'))
        if not staff_id:
            continue
        staff_branch_id = _payroll_text(staff.get('branch_id')) or None
        policy = resolve_policy(staff_branch_id, staff_id)
        policy_by_staff[staff_id] = policy
        effective_ot_rate_by_staff[staff_id] = resolve_effective_ot_rate(
            salary_by_staff.get(staff_id), policy
        )

    if period_start_text and period_end_text:
        try:
            period_start_date = date.fromisoformat(period_start_text)
            period_end_date = date.fromisoformat(period_end_text)

            distinct_branch_ids = sorted({
                _payroll_text(staff.get('branch_id'))
                for staff in staff_rows
                if _payroll_text(staff.get('branch_id'))
            })

            # [Fix-6] A CLOSED period (period_end already in the past) can't
            # have new attendance/leave/overtime logged against it, so its
            # computed breakdown never changes on a normal revisit of the
            # same page/filters -- only recompute it once per TTL window.
            # The current/open period (period_end_date >= today) always
            # skips this cache and computes live, since its underlying data
            # can still change within the same day.
            cache_key: str | None = None
            cached_breakdown = None
            if period_end_date < date.today():
                cache_key = (
                    f'{org_key}:{"|".join(distinct_branch_ids)}:'
                    f'{period_start_text}:{period_end_text}:{"|".join(sorted(staff_ids))}'
                )
                cached_breakdown = _cache_get(_PAYROLL_BREAKDOWN_CACHE, cache_key)

            if cached_breakdown is not None:
                breakdown_by_staff, present_days_by_staff, paid_staff_ids = cached_breakdown
            else:
                attendance_by_staff: dict[str, list[dict]] = {}
                leaves_by_staff: dict[str, list[dict]] = {}
                overtime_by_staff: dict[str, float] = {}
                local_node_overtime_by_staff: dict[str, float] = {}

                attendance_by_staff = get_staff_attendance_for_payroll_period(
                    org_key, distinct_branch_ids, period_start_text, period_end_text, staff_ids=staff_ids
                )
                leaves_by_staff = get_approved_leaves_for_payroll_period(
                    org_key, distinct_branch_ids, period_start_text, period_end_text, staff_ids=staff_ids
                )
                overtime_by_staff = get_approved_overtime_hours_for_payroll_period(
                    org_key, distinct_branch_ids, period_start_text, period_end_text, staff_ids=staff_ids
                )
                local_node_overtime_by_staff = get_local_node_overtime_hours_for_payroll_period(
                    org_key,
                    distinct_branch_ids,
                    period_start_text,
                    period_end_text,
                    attendance_by_staff=attendance_by_staff,
                    staff_ids=staff_ids,
                )

                paid_staff_ids = get_paid_payroll_periods(org_key, period_start_text, period_end_text)

                # resolve_policy/effective_ot_rate_by_staff are already
                # computed above, unconditionally — reused here rather than
                # re-resolved so the breakdown's OT pay always matches the
                # rate the table displays for the same staff member.
                for staff in staff_rows:
                    staff_id = _payroll_text(staff.get('id'))
                    if not staff_id:
                        continue
                    staff_branch_id = _payroll_text(staff.get('branch_id')) or None
                    salary_config = salary_by_staff.get(staff_id, {})
                    basic_salary = _payroll_float(
                        salary_config.get('basic_salary')
                        if salary_config.get('basic_salary') is not None
                        else staff.get('salary')
                    )
                    # Policy resolved against this staff member's OWN branch —
                    # not a single requested filter branch — so a branch-level
                    # policy override applies correctly even when viewing All
                    # Branches. Individual override > branch override > org default.
                    policy = resolve_policy(staff_branch_id, staff_id)
                    # Real approved-this-period OT hours from Overtime Management,
                    # plus node-classified overtime the local-node payroll-decision
                    # screen approved (never routes through overtime_requests).
                    ot_hours = overtime_by_staff.get(staff_id, 0.0) + local_node_overtime_by_staff.get(staff_id, 0.0)
                    breakdown = payroll_engine.compute_payroll_breakdown(
                        base_salary=basic_salary,
                        ot_hours=ot_hours,
                        ot_rate_per_hour=effective_ot_rate_by_staff.get(staff_id, 0.0),
                        period_start=period_start_date,
                        period_end=period_end_date,
                        policy=policy,
                        attendance_rows=attendance_by_staff.get(staff_id, []),
                        leave_rows=leaves_by_staff.get(staff_id, []),
                    )
                    breakdown_by_staff[staff_id] = breakdown.to_dict()
                    present_dates = {r['date'] for r in attendance_by_staff.get(staff_id, []) if r.get('date')}
                    present_days_by_staff[staff_id] = len(present_dates)

                if cache_key is not None:
                    _cache_set_for(
                        _PAYROLL_BREAKDOWN_CACHE, cache_key,
                        (dict(breakdown_by_staff), dict(present_days_by_staff), set(paid_staff_ids or set())),
                        _PAYROLL_BREAKDOWN_CACHE_TTL_SECONDS,
                    )
        except Exception:
            logger.exception('Payroll breakdown computation failed for org=%s', org_key)
            breakdown_by_staff = {}
            present_days_by_staff = {}
            paid_staff_ids = None

    rows = [
        _payroll_page_row(
            org_key,
            staff,
            branch_by_backend,
            backend_to_ui,
            salary_by_staff.get(_payroll_text(staff.get('id'))),
            breakdown=breakdown_by_staff.get(_payroll_text(staff.get('id'))),
            present_days=present_days_by_staff.get(_payroll_text(staff.get('id'))),
            paid_staff_ids=paid_staff_ids,
            effective_ot_rate=effective_ot_rate_by_staff.get(_payroll_text(staff.get('id'))),
            policy=policy_by_staff.get(_payroll_text(staff.get('id'))),
        )
        for staff in staff_rows
    ]

    # Sorts that depend on derived/overlay values happen after mapping.
    sort_key = _payroll_text(sort_by).lower()
    if sort_key in {'netsalary', 'netpay', 'basesalary', 'basicsalary', 'salary'}:
        value_key = 'netPay' if sort_key in {'netsalary', 'netpay'} else 'baseSalary'
        rows.sort(key=lambda item: _payroll_float(item.get(value_key)), reverse=descending)
    elif sort_key in {'department', 'departmentname', 'branch', 'branchname'}:
        value_key = 'department' if sort_key.startswith('department') else 'branchName'
        rows.sort(key=lambda item: _payroll_text(item.get(value_key)).lower(), reverse=descending)

    total_pages = max(1, (total + size - 1) // size) if total else 1
    page_total = sum(_payroll_float(row.get('netPay')) for row in rows)
    page_ot = sum(_payroll_float(row.get('overtimeAmount')) for row in rows)

    return {
        'rows': rows,
        'records': rows,
        'items': rows,
        'data': rows,
        'total': total,
        'count': total,
        'totalRecords': total,
        'page': page_number,
        'pageSize': size,
        'totalPages': total_pages,
        'hasNext': page_number < total_pages,
        'hasPrev': page_number > 1,
        'summary': {
            'totalPayout': page_total,
            'total_payout': page_total,
            'totalOT': page_ot,
            'total_ot': page_ot,
            'employees': len(rows),
            'totalStaff': total,
            'status': 'Pending' if any(str(row.get('status')).lower() == 'pending' for row in rows) else 'Paid',
        },
    }