"""
support_db_dashboard_summary.py
───────────────────────────────────────────────────────────────────────────────
Fast tenant summary API and the single-call Dashboard Overview snapshot.

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

logger = get_logger(__name__)


def _resolve_fast_summary_branch_id(org_id: str, branch_id: object = None) -> str | None:
    """Resolve UI branch id or backend UUID to backend branch UUID for summaries."""
    from support_db_staff import _resolve_client_branch
    if branch_id in (None, ''):
        return None
    try:
        branch, _ui_id = _resolve_client_branch(str(org_id), branch_id)
        return str(branch.get('id')) if branch and branch.get('id') else None
    except Exception:
        text = str(branch_id or '').strip()
        return text or None

def _fast_summary_fallback(org_id: str, branch_id: object = None, days: int = 7) -> dict:
    """Fallback when the SQL RPC has not been installed yet.

    This is intentionally aggregate-first and small. It never returns full staff
    directories, so dashboards remain safe on larger tenants even before the SQL
    function is installed. For maximum scale, run sql/tenant_performance_summary.sql.
    """
    from support_db_branches import list_branches
    from support_db_nodes import _iso_now
    org_id = str(org_id)
    branches = list_branches(org_id)
    backend_branch_id = _resolve_fast_summary_branch_id(org_id, branch_id)
    selected_branches = [b for b in branches if not backend_branch_id or str(b.get('id')) == str(backend_branch_id)]

    def _staff_count(branch_uuid: str | None = None) -> int:
        def _query():
            q = (
                get_supabase()
                .table('client_staff')
                .select('id', count='exact')
                .eq('org_id', org_id)
                .eq('role', 'staff')
                .eq('is_archived', False)
            )
            return q.eq('branch_id', str(branch_uuid)) if branch_uuid else q

        result = _execute_supabase('fast_summary_fallback.staff_count', _query)
        return int(result.count or 0)

    today_start = datetime.now(timezone.utc).date().isoformat()
    tomorrow = (datetime.now(timezone.utc).date() + timedelta(days=1)).isoformat()

    def _present_count(branch_uuid: str | None = None) -> int:
        def _query():
            q = (
                get_supabase()
                .table('attendance')
                .select('staff_id')
                .eq('org_id', org_id)
                .gte('timestamp', today_start)
                .lt('timestamp', tomorrow)
                .limit(100000)
            )
            return q.eq('branch_id', str(branch_uuid)) if branch_uuid else q

        result = _execute_supabase('fast_summary_fallback.present_count', _query)
        rows = result.data or []
        return len({str(r.get('staff_id') or '') for r in rows if r.get('staff_id')})

    def _payroll_sum(branch_uuid: str | None = None) -> float:
        # Fallback only. The RPC does this in Postgres. Here we keep selected
        # columns small and scoped; this is still safe but not the fastest path.
        def _query():
            q = (
                get_supabase()
                .table('client_staff')
                .select('id,salary,branch_id')
                .eq('org_id', org_id)
                .eq('role', 'staff')
                .eq('is_archived', False)
            )
            return q.eq('branch_id', str(branch_uuid)) if branch_uuid else q

        result = _execute_supabase('fast_summary_fallback.payroll_sum', _query)
        rows = result.data or []
        return float(sum(float(r.get('salary') or 0) for r in rows))

    branch_rows = []
    for idx, branch in enumerate(selected_branches, start=1):
        branch_uuid = str(branch.get('id'))
        staff_count = _staff_count(branch_uuid)
        present = _present_count(branch_uuid)
        payroll = _payroll_sum(branch_uuid)
        branch_rows.append({
            'id': idx,
            'branchId': idx,
            'backend_branch_id': branch_uuid,
            'backendBranchId': branch_uuid,
            'name': branch.get('name') or f'Branch {idx}',
            'branchName': branch.get('name') or f'Branch {idx}',
            'staff': staff_count,
            'staffCount': staff_count,
            'activeStaff': staff_count,
            'presentToday': present,
            'absentToday': max(0, staff_count - present),
            'attendanceRate': round((present / staff_count) * 100) if staff_count else 0,
            'payroll': payroll,
            'revenue': payroll,
            'pendingLeaves': 0,
            'late': 0,
            'lateCount': 0,
        })

    total_staff = sum(int(b['staffCount']) for b in branch_rows)
    present_today = sum(int(b['presentToday']) for b in branch_rows)
    monthly_payroll = sum(float(b['payroll']) for b in branch_rows)
    totals = {
        'branches': len(branch_rows),
        'total_staff': total_staff,
        'totalStaff': total_staff,
        'present_today': present_today,
        'presentToday': present_today,
        'absent_today': max(0, total_staff - present_today),
        'absentToday': max(0, total_staff - present_today),
        'late_today': 0,
        'lateToday': 0,
        'attendance_rate': round((present_today / total_staff) * 100) if total_staff else 0,
        'attendanceRate': round((present_today / total_staff) * 100) if total_staff else 0,
        'monthly_payroll': monthly_payroll,
        'monthlyPayroll': monthly_payroll,
        'pending_leaves': 0,
        'pendingLeaves': 0,
    }

    # Small chart payload only; counts are filled by RPC when installed.
    days_safe = max(1, min(int(days or 7), 90))
    base_date = datetime.now(timezone.utc).date()
    attendance_by_day = []
    for offset in range(days_safe - 1, -1, -1):
        day = base_date - timedelta(days=offset)
        attendance_by_day.append({
            'date': day.isoformat(),
            'label': day.strftime('%a'),
            'attendance': 0,
            'present': 0,
        })

    return {
        'organization_id': org_id,
        'branch_id': backend_branch_id,
        'generated_at': _iso_now(),
        'days': days_safe,
        'totals': totals,
        'branches': branch_rows,
        'attendance_by_day': attendance_by_day,
        'attendanceByDay': attendance_by_day,
    }

def get_tenant_fast_summary(org_id: str, branch_id: object = None, days: int = 7) -> dict:
    """Return pre-aggregated tenant dashboard/report summary.

    Best path: SQL RPC public.get_tenant_fast_summary performs aggregation in
    Postgres using indexes. Fallback remains tenant-scoped and safe, but the RPC
    should be installed for large customers.
    """
    from support_db_organizations import get_organization
    org_id = str(org_id)
    get_organization(org_id)
    backend_branch_id = _resolve_fast_summary_branch_id(org_id, branch_id)
    days_safe = max(1, min(int(days or 7), 90))

    try:
        rpc_result = _execute_supabase(
            'get_tenant_fast_summary_rpc',
            lambda: get_supabase().rpc('get_tenant_fast_summary', {
                'p_org_id': org_id,
                'p_branch_id': backend_branch_id,
                'p_days': days_safe,
            }),
        )
        data = rpc_result.data
        if isinstance(data, dict):
            data.setdefault('success', True)
            data.setdefault('attendanceByDay', data.get('attendance_by_day') or [])
            return data
    except Exception as exc:
        logger.warning('Fast tenant summary RPC unavailable; using safe fallback: %s', exc)

    return _fast_summary_fallback(org_id, backend_branch_id, days_safe)

_DASHBOARD_SNAPSHOT_CACHE_TTL_SECONDS = 5.0

_DASHBOARD_SNAPSHOT_CACHE: dict[str, tuple[float, dict]] = {}

def _dashboard_text(value: object, fallback: str = '') -> str:
    text = str(value or '').strip()
    return text or fallback

def _dashboard_float(value: object, fallback: float = 0.0) -> float:
    try:
        parsed = float(value or 0)
        return parsed if parsed == parsed else fallback
    except (TypeError, ValueError):
        return fallback

def _dashboard_int(value: object, fallback: int = 0) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return fallback

def _dashboard_round(value: object) -> int:
    return int(round(_dashboard_float(value)))

def _dashboard_cache_key(org_id: str, branch_id: object, date_value: object, days: int) -> str:
    return f'{org_id}|{_dashboard_text(branch_id)}|{_dashboard_text(date_value)}|{days}'

def _dashboard_cache_get(key: str) -> dict | None:
    item = _DASHBOARD_SNAPSHOT_CACHE.get(key)
    if not item:
        return None
    expires_at, value = item
    if expires_at <= time.monotonic():
        _DASHBOARD_SNAPSHOT_CACHE.pop(key, None)
        return None
    return dict(value)

def _dashboard_cache_set(key: str, value: dict) -> None:
    _DASHBOARD_SNAPSHOT_CACHE[key] = (
        time.monotonic() + _DASHBOARD_SNAPSHOT_CACHE_TTL_SECONDS,
        dict(value),
    )

def _dashboard_branch_maps(branches: list[dict]) -> tuple[dict[str, int], dict[str, dict], dict[int, dict]]:
    backend_to_ui: dict[str, int] = {}
    by_backend: dict[str, dict] = {}
    by_ui: dict[int, dict] = {}
    for idx, branch in enumerate(branches, start=1):
        backend_id = _dashboard_text(branch.get('id'))
        if backend_id:
            backend_to_ui[backend_id] = idx
            by_backend[backend_id] = branch
            by_ui[idx] = branch
    return backend_to_ui, by_backend, by_ui

def _dashboard_week_days(days: int = 7) -> list[dict]:
    today = datetime.now(timezone.utc).date()
    size = max(1, min(int(days or 7), 14))
    return [
        {
            'date': (today - timedelta(days=offset)).isoformat(),
            'day': (today - timedelta(days=offset)).strftime('%a'),
            'count': 0,
        }
        for offset in range(size - 1, -1, -1)
    ]

def _dashboard_month_labels(size: int = 6) -> list[str]:
    today = datetime.now(timezone.utc).date()
    labels: list[str] = []
    for offset in range(size - 1, -1, -1):
        month = today.month - offset
        year = today.year
        while month <= 0:
            month += 12
            year -= 1
        labels.append(date(year, month, 1).strftime('%b'))
    return labels

def _dashboard_identity(row: dict) -> str:
    return _dashboard_text(
        row.get('staff_id')
        or row.get('staffId')
        or row.get('user_id')
        or row.get('userId')
        or row.get('client_staff_id')
        or row.get('id')
    )

def _dashboard_branch_uuid(row: dict) -> str:
    return _dashboard_text(
        row.get('backend_branch_id')
        or row.get('backendBranchId')
        or row.get('branch_uuid')
        or row.get('branchUuid')
        or row.get('branch_id')
    )

def _dashboard_staff_rows(
    org_id: str,
    backend_branch_id: str | None = None,
    people_type: str | None = None,
    scope_ids: frozenset | None = None,
) -> list[dict]:
    """Load only dashboard-needed staff columns for exact counts/shift distribution.

    scope_ids: None = unscoped (org/branch admin, or a 'branch'-scoped
    caller). Non-empty frozenset = restrict to that manager's own team.
    Empty frozenset = a 'team'-scoped manager with zero direct reports —
    return [] without hitting Supabase, same contract
    _shift_distribution_for_branch already uses.
    """
    from support_db_staff import _client_staff_has_people_type_column, _normalize_people_type
    if scope_ids is not None and not scope_ids:
        return []
    # Strongest schema first. The SQL contract creates department_id and
    # department_name. Fallback selects keep older dev DBs from breaking while
    # still staying tenant-scoped and non-demo.
    selects = [
        'id,org_id,branch_id,employee_id,name,email,department_id,department_name,role_name,position,role,people_type,status,is_archived,salary,shift_id,shift_label,duty_start,duty_end,is_face_verified,attendance_enabled,created_at,updated_at',
        'id,org_id,branch_id,employee_id,name,email,department_name,role_name,position,role,people_type,status,is_archived,salary,shift_id,shift_label,duty_start,duty_end,is_face_verified,attendance_enabled,created_at,updated_at',
        'id,org_id,branch_id,employee_id,name,email,position,role,people_type,status,is_archived,salary,shift_id,shift_label,duty_start,duty_end,is_face_verified,attendance_enabled,created_at,updated_at',
        '*',
    ]
    last_exc: Exception | None = None
    for columns in selects:
        try:
            def _query(columns=columns):
                q = (
                    get_supabase()
                    .table('client_staff')
                    .select(columns)
                    .eq('org_id', str(org_id))
                )
                if columns != '*':
                    q = q.eq('role', 'staff').eq('is_archived', False)
                if people_type and _client_staff_has_people_type_column():
                    q = q.eq('people_type', _normalize_people_type(people_type))
                if backend_branch_id:
                    q = q.eq('branch_id', str(backend_branch_id))
                if scope_ids is not None:
                    q = q.in_('id', list(scope_ids))
                return q.order('name').limit(100000)

            result = _execute_supabase('dashboard_overview.staff', _query)
            rows = [dict(row) for row in (result.data or [])]
            if columns == '*':
                rows = [
                    row for row in rows
                    if str(row.get('role') or 'staff').lower() == 'staff'
                    and not bool(row.get('is_archived'))
                    and (not backend_branch_id or str(row.get('branch_id') or '') == str(backend_branch_id))
                    and (not people_type or _normalize_people_type(row.get('people_type') or row.get('person_type') or row.get('role') or '', '') == _normalize_people_type(people_type, ''))
                    and (scope_ids is None or str(row.get('id') or '') in {str(s) for s in scope_ids})
                ]
            elif people_type and not _client_staff_has_people_type_column():
                rows = [
                    row for row in rows
                    if _normalize_people_type(row.get('people_type') or row.get('person_type') or row.get('role') or '', '') == _normalize_people_type(people_type, '')
                ]
            return rows
        except Exception as exc:
            last_exc = exc
            text = str(exc).lower()
            if 'client_staff' not in text and 'pgrst204' not in text and '42703' not in text and 'schema cache' not in text:
                raise
            continue
    raise last_exc or RuntimeError('Unable to load dashboard staff rows')

def _dashboard_real_shift_distribution(
    org_id: str,
    backend_branch_id: str | None,
    branches: list[dict],
    people_type: str | None,
    scope_ids: frozenset | None,
) -> list[dict]:
    """Delegates to support_db_fast's per-branch shift reader — the single
    source of truth for shift distribution (the `shifts` table
    StaffManagement.tsx's Shift Allocation tab reads via listBranchShifts()).
    Replaces the old 4-bucket Morning/Evening/Night/Custom heuristic, which
    classified staff by duty_start/duty_end text instead of their actual
    assigned shift_id_ref, and could never reflect a branch's real
    configured shifts.
    """
    import support_db_fast  # local: avoids a circular import at module load

    sb = get_supabase()
    if backend_branch_id:
        return support_db_fast._shift_distribution_for_branch(
            sb, org_id, backend_branch_id, people_type, scope_ids,
        )
    return support_db_fast._merge_shift_distributions([
        support_db_fast._shift_distribution_for_branch(
            sb, org_id, _dashboard_text(branch.get('id')), people_type, scope_ids,
        )
        for branch in branches
        if _dashboard_text(branch.get('id'))
    ])

def _dashboard_weekly_from_attendance(rows: list[dict], days: int = 7) -> list[dict]:
    weekly = _dashboard_week_days(days)
    by_date: dict[str, set[str]] = {item['date']: set() for item in weekly}
    for row in rows:
        stamp = _dashboard_text(row.get('timestamp') or row.get('check_in') or row.get('checkIn') or row.get('created_at'))
        day = stamp[:10]
        staff_id = _dashboard_identity(row)
        if day in by_date and staff_id:
            by_date[day].add(staff_id)
    return [
        {'day': item['day'], 'count': len(by_date.get(item['date'], set()))}
        for item in weekly
    ]

def _dashboard_performance_from_totals(total_staff: int, present: int, late: int, absent: int) -> list[dict]:
    months = _dashboard_month_labels(6)
    result = []
    for idx, month in enumerate(months):
        if idx == len(months) - 1:
            on_time = max(0, present - late)
            result.append({'month': month, 'On Time': on_time, 'Late': late, 'Absent': absent})
        else:
            result.append({'month': month, 'On Time': 0, 'Late': 0, 'Absent': 0})
    return result

def _dashboard_payroll_trend(total_payroll: float, overtime: float = 0.0) -> list[dict]:
    months = _dashboard_month_labels(6)
    weights = [0.82, 0.87, 0.91, 0.94, 0.97, 1.0]
    return [
        {
            'month': month,
            'Payroll': int(round(total_payroll * weights[idx])),
            'Overtime': int(round(overtime * weights[idx])),
        }
        for idx, month in enumerate(months)
    ]

def _dashboard_live_log(rows: list[dict]) -> list[dict]:
    payload = []
    for idx, row in enumerate(rows[:10]):
        payload.append({
            'id': _dashboard_text(row.get('id'), f'log-{idx}'),
            'name': _dashboard_text(row.get('name') or row.get('staffName') or row.get('staff_name') or row.get('userName') or row.get('user_name'), 'Unknown'),
            'department': _dashboard_text(row.get('department'), 'General'),
            'branchName': _dashboard_text(row.get('branchName') or row.get('branch_name'), 'Main Branch'),
            'status': 'Late' if 'late' in _dashboard_text(row.get('status')).lower() else 'Present',
            'time': _dashboard_text(row.get('timestamp') or row.get('checkIn') or row.get('check_in') or row.get('created_at')),
        })
    return payload

def _dashboard_pending_leaves(rows: list[dict]) -> list[dict]:
    result = []
    for row in rows[:50]:
        result.append({
            'id': _dashboard_text(row.get('id')),
            'name': _dashboard_text(row.get('name') or row.get('staffName') or row.get('staff_name') or row.get('userName'), 'Unknown'),
            'dept': _dashboard_text(row.get('dept') or row.get('department'), 'General'),
            'branchName': _dashboard_text(row.get('branchName') or row.get('branch_name'), 'Main Branch'),
            'type': _dashboard_text(row.get('type') or row.get('leave_type'), 'Leave'),
            'days': _dashboard_int(row.get('days'), 1),
            'status': 'Pending',
        })
    return result

def _dashboard_cctv_status(cameras: list[dict]) -> list[dict]:
    result = []
    for idx, camera in enumerate(cameras):
        result.append({
            **camera,
            'id': _dashboard_text(camera.get('id') or camera.get('camera_id'), f'camera-{idx}'),
            'location': _dashboard_text(camera.get('location') or camera.get('name') or camera.get('camera_name'), 'Camera'),
            'status': _dashboard_text(camera.get('status'), 'Normal'),
            'lastSeen': _dashboard_text(camera.get('lastSeen') or camera.get('last_seen'), 'Online'),
            'branchName': _dashboard_text(camera.get('branchName') or camera.get('branch_name'), 'Main Branch'),
        })
    return result

def get_client_dashboard_overview(
    org_id: str,
    branch_id: object = None,
    date_value: str | None = None,
    days: int = 7,
    people_type: str | None = None,
    scope_ids: frozenset | None = None,
) -> dict:
    """Return one tenant-safe snapshot for the Dashboard Overview page.

    This is the performance boundary for the overview. React should call this
    once instead of mounting attendance, payroll, leave, and CCTV hooks that all
    fetch independently. Module pages keep their paginated endpoints.

    scope_ids: caller's team-scope id set from
    client_dashboard_auth.get_effective_scope_ids. None = unscoped
    (org/branch admin, or a 'branch'-scoped caller). Non-empty frozenset =
    restrict people/attendance/leave/shift cards to that manager's own
    team. Empty frozenset (manager, zero direct reports) = those cards
    report real zeros. Payroll and CCTV are deliberately left unscoped —
    same exception get_fast_summary's payroll_scope_ids=None documents:
    payroll is an access-module grant, not a hierarchy grant, and CCTV is
    a branch fixture, not a per-staff concept.
    """
    from support_db_attendance_dashboard import _resolve_attendance_branch_id, get_client_attendance_logs, get_client_attendance_today, list_client_cameras, list_client_leave_requests
    from support_db_branches import list_branches
    from support_db_nodes import _iso_now
    from support_db_organizations import get_organization
    from support_db_payroll import get_client_payroll_page
    org_key = _dashboard_text(org_id)
    if not org_key:
        raise ValueError('organization_id is required')

    days_safe = max(1, min(int(days or 7), 14))
    branches = list_branches(org_key)
    backend_to_ui, branch_by_backend, _branch_by_ui = _dashboard_branch_maps(branches)
    backend_branch_id = _resolve_attendance_branch_id(branch_id, branches) if _dashboard_text(branch_id) else None
    selected_branches = [
        branch for branch in branches
        if not backend_branch_id or _dashboard_text(branch.get('id')) == backend_branch_id
    ]

    cache_key = _dashboard_cache_key(
        org_key, backend_branch_id or branch_id,
        f"{date_value or ''}:{people_type or ''}:{'|'.join(sorted(scope_ids)) if scope_ids is not None else 'unscoped'}",
        days_safe,
    )
    cached = _dashboard_cache_get(cache_key)
    if cached is not None:
        return cached

    org = get_organization(org_key)
    summary = get_tenant_fast_summary(org_key, branch_id=backend_branch_id, days=days_safe)
    totals = summary.get('totals') if isinstance(summary.get('totals'), dict) else {}

    staff_rows = _dashboard_staff_rows(org_key, backend_branch_id, people_type=people_type, scope_ids=scope_ids)
    # get_tenant_fast_summary's totals are unscoped (its RPC has no
    # scope_ids parameter — same limitation get_fast_summary documents).
    # staff_rows is always the correctly-scoped source now, so it's used
    # directly rather than letting an unscoped total override it.
    total_staff = len(staff_rows)

    today_rows = get_client_attendance_today(
        org_key, branch_id=backend_branch_id, date_value=date_value,
        limit=2000, people_type=people_type, scope_ids=scope_ids,
    )
    logs = get_client_attendance_logs(
        org_key, branch_id=backend_branch_id, limit=50,
        people_type=people_type, scope_ids=scope_ids,
    )
    present_ids = {_dashboard_identity(row) for row in today_rows if _dashboard_identity(row)}
    present_today = len(present_ids)
    # Derived from the same scoped today_rows rather than the unscoped
    # totals fallback, for the same reason present_today no longer uses it.
    late_today = sum(1 for row in today_rows if row.get('status') == 'late')
    absent_today = max(0, total_staff - present_today)
    avg_attendance = round((present_today / total_staff) * 100) if total_staff else 0

    pending_leave_rows = list_client_leave_requests(
        org_key, branch_id=backend_branch_id, status='pending', scope_ids=scope_ids,
    )
    pending_leaves = _dashboard_pending_leaves(pending_leave_rows)

    # Payroll stays unscoped — see docstring.
    payroll_page = get_client_payroll_page(
        org_key, branch_id=backend_branch_id, page=1, page_size=500,
        sort_by='name', sort_dir='asc',
    )
    payroll_rows = payroll_page.get('rows') or []
    monthly_payroll = _dashboard_float(
        (payroll_page.get('summary') or {}).get('totalPayout')
        or (payroll_page.get('summary') or {}).get('total_payout')
        or totals.get('monthlyPayroll')
        or totals.get('monthly_payroll'),
        sum(_dashboard_float(row.get('netPay') or row.get('net_pay') or row.get('salary')) for row in payroll_rows),
    )
    total_overtime = sum(_dashboard_float(row.get('overtimeAmount') or row.get('overtime_amount')) for row in payroll_rows)

    cctv = _dashboard_cctv_status(list_client_cameras(org_key, backend_branch_id))
    cctv_alerts = sum(1 for item in cctv if _dashboard_text(item.get('status')).lower() == 'alert')

    weekly = _dashboard_weekly_from_attendance(logs, days_safe)
    if today_rows:
        # Ensure today's bar reflects today's attendance even when recent logs
        # were capped or came from a different ordering window.
        today_label = datetime.now(timezone.utc).date().strftime('%a')
        for item in weekly:
            if item['day'] == today_label:
                item['count'] = present_today

    branch_performance = []
    for idx, branch in enumerate(branches, start=1):
        branch_uuid = _dashboard_text(branch.get('id'))
        branch_staff = [row for row in staff_rows if _dashboard_text(row.get('branch_id')) == branch_uuid]
        if backend_branch_id and branch_uuid != backend_branch_id:
            continue
        branch_present = len({
            _dashboard_identity(row)
            for row in today_rows
            if _dashboard_branch_uuid(row) == branch_uuid and _dashboard_identity(row)
        })
        branch_total = len(branch_staff)
        # Sourced from payroll_rows (deliberately unscoped) instead of
        # branch_staff (scoped) — a team-scoped manager's payroll figure
        # must stay branch-wide, same as every other payroll card.
        branch_name = _dashboard_text(branch.get('name'), f'Branch {idx}')
        branch_payroll = sum(
            _dashboard_float(row.get('netPay') or row.get('net_pay') or row.get('salary'))
            for row in payroll_rows
            if _dashboard_text(row.get('branchName')) == branch_name
        )
        branch_alerts = sum(1 for item in cctv if _dashboard_branch_uuid(item) == branch_uuid and _dashboard_text(item.get('status')).lower() == 'alert')
        branch_performance.append({
            'branchId': idx, 'branchName': branch_name,
            'city': _dashboard_text(branch.get('location') or branch.get('city')),
            'totalStaff': branch_total, 'presentToday': branch_present,
            'absentToday': max(0, branch_total - branch_present),
            'avgAttendance': round((branch_present / branch_total) * 100) if branch_total else 0,
            'lateToday': 0, 'payroll': branch_payroll, 'cctvAlerts': branch_alerts,
        })

    branch_weekly = []
    for perf in branch_performance:
        branch_weekly.append({
            'branchId': perf['branchId'],
            'branchName': perf['branchName'],
            'data': [
                {**item, 'count': perf['presentToday'] if idx == len(weekly) - 1 else 0}
                for idx, item in enumerate(weekly)
            ],
        })

    branch_attendance_performance = [
        {
            'branchId': perf['branchId'],
            'branchName': perf['branchName'],
            'avgAttendance': perf['avgAttendance'],
            'data': _dashboard_performance_from_totals(
                perf['totalStaff'],
                perf['presentToday'],
                perf['lateToday'],
                perf['absentToday'],
            ),
        }
        for perf in branch_performance
    ]
    branch_payroll_trends = [
        {
            'branchId': perf['branchId'],
            'branchName': perf['branchName'],
            'totalPayroll': perf['payroll'],
            'data': _dashboard_payroll_trend(perf['payroll'], 0),
        }
        for perf in branch_performance
    ]

    selected_branch = selected_branches[0] if backend_branch_id and selected_branches else None
    selected_ui_id = backend_to_ui.get(_dashboard_text(selected_branch.get('id'))) if selected_branch else None
    now_label = datetime.now(timezone.utc).strftime('%A, %B %d, %Y')

    shift_distribution = _dashboard_real_shift_distribution(
        org_key, backend_branch_id, branches, people_type, scope_ids,
    )

    snapshot = {
        'organization_id': org_key,
        'organizationName': org.get('name'),
        'scope': 'branch' if backend_branch_id else 'global',
        'branchId': selected_ui_id,
        'branchName': selected_branch.get('name') if selected_branch else None,
        'branchCity': selected_branch.get('location') if selected_branch else None,
        'title': 'Organization Overview' if not backend_branch_id else 'Attendance Overview',
        'subtitle': (
            f"{selected_branch.get('name')}{(' · ' + selected_branch.get('location')) if selected_branch and selected_branch.get('location') else ''} · {now_label}"
            if selected_branch
            else f"All Branches · {len(branches)} branches · {now_label}"
        ),
        'globalFilterBranchId': selected_ui_id,
        'selectedBranchId': selected_ui_id,
        'selectedBranchName': selected_branch.get('name') if selected_branch else None,
        'branchFilterOptions': [
            {'id': idx, 'name': branch.get('name') or f'Branch {idx}'}
            for idx, branch in enumerate(branches, start=1)
        ],
        'stats': {
            'totalBranches': len(branches) if not backend_branch_id else len(selected_branches),
            'totalStaff': total_staff,
            'presentToday': present_today,
            'absentToday': absent_today,
            'avgAttendance': avg_attendance,
            'lateToday': late_today,
            'earlyLeft': 0,
            'pendingLeaves': len(pending_leaves),
            'monthlyPayroll': monthly_payroll,
            'cctvAlerts': cctv_alerts,
        },
        # Keep staff payload intentionally small; dashboard cards use summaries.
        'staff': [],
        'liveLog': _dashboard_live_log(logs),
        'shiftDistribution': shift_distribution,
        'todayStatus': [
            {'name': 'Present', 'value': present_today},
            {'name': 'Late', 'value': late_today},
            {'name': 'Absent', 'value': absent_today},
        ],
        'weeklyAttendance': weekly,
        'branchWeeklyAttendance': branch_weekly,
        'pendingLeaves': pending_leaves,
        'cctvStatus': cctv,
        'attendancePerformance': _dashboard_performance_from_totals(total_staff, present_today, late_today, absent_today),
        'branchAttendancePerformance': branch_attendance_performance,
        'payrollTrends': _dashboard_payroll_trend(monthly_payroll, total_overtime),
        'branchPayrollTrends': branch_payroll_trends,
        'branchPerformance': branch_performance,
        'generated_at': _iso_now(),
    }
    _dashboard_cache_set(cache_key, snapshot)
    return dict(snapshot)