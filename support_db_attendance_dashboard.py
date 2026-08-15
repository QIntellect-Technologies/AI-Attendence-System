# """
# support_db_attendance_dashboard.py
# ───────────────────────────────────────────────────────────────────────────────
# Client dashboard read models for attendance, leave, and overtime, plus a
# group of tenant-safe helpers (cameras, staff lookups) shared by those views.

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
# )
# from support_db_attendance_settings import list_pending_manual_instructions_for_branch
# from support_db_time_utils import is_missing_table_or_column as _table_missing
# import support_db_attendance_exceptions as _attendance_exceptions
# from zoneinfo import ZoneInfo, available_timezones
# from core.vertical_templates import (
#     list_vertical_templates as _list_vertical_templates,
#     normalize_vertical_payload,
#     build_vertical_config,
#     get_vertical_template,
# )

# def _dashboard_day_window_utc(date_value: str | None = None) -> tuple[str, str, str]:
#     """Return UTC start/end ISO strings for one dashboard attendance day."""
#     if date_value:
#         try:
#             selected = date.fromisoformat(str(date_value)[:10])
#         except Exception:
#             selected = datetime.now(timezone.utc).date()
#     else:
#         selected = datetime.now(timezone.utc).date()

#     start = datetime(selected.year, selected.month, selected.day, tzinfo=timezone.utc)
#     end = start + timedelta(days=1)
#     return selected.isoformat(), start.isoformat(), end.isoformat()


# def _dashboard_range_bound_utc(value: str | None, *, is_end: bool = False) -> str | None:
#     if value is None:
#         return None

#     raw = str(value).strip()
#     if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
#         date_value = date.fromisoformat(raw)
#         if is_end:
#             date_value += timedelta(days=1)
#         return datetime(
#             date_value.year,
#             date_value.month,
#             date_value.day,
#             tzinfo=timezone.utc,
#         ).isoformat()

#     try:
#         parsed = datetime.fromisoformat(raw)
#         if parsed.tzinfo is None:
#             parsed = parsed.replace(tzinfo=timezone.utc)
#         return parsed.isoformat()
#     except Exception:
#         return raw


# def _resolve_attendance_branch_id(raw_branch_id: object, branches: list[dict]) -> str | None:
#     raw = str(raw_branch_id or '').strip()
#     if not raw:
#         return None

#     # Accept the real Supabase UUID.
#     for branch in branches:
#         backend_id = str(branch.get('id') or '').strip()
#         if backend_id and raw == backend_id:
#             return backend_id

#     # Accept the current React numeric UI id (1, 2, 3, ...).
#     try:
#         ui_id = int(raw)
#     except (TypeError, ValueError):
#         return None

#     if ui_id < 1 or ui_id > len(branches):
#         return None

#     backend_id = branches[ui_id - 1].get('id')
#     return str(backend_id) if backend_id else None

# def _attendance_row_for_dashboard(
#     row: dict,
#     *,
#     staff_by_id: dict[str, dict],
#     branch_by_id: dict[str, dict],
#     branch_ui_by_id: dict[str, int],
# ) -> dict:
#     """Map Supabase attendance rows into the existing React attendance shape."""
#     from support_db_nodes import _iso_now
#     from support_db_staff import _normalize_people_type
#     staff_id = str(row.get('staff_id') or '').strip()
#     staff = staff_by_id.get(staff_id, {})
#     backend_branch_id = str(row.get('branch_id') or staff.get('branch_id') or '').strip()
#     branch = branch_by_id.get(backend_branch_id, {})
#     branch_ui_id = branch_ui_by_id.get(backend_branch_id)
#     ts = row.get('timestamp') or row.get('created_at') or _iso_now()
#     # NULL means the row predates this column (written before the
#     # check-in-hold feature) — treat as confirmed, matching
#     # push_node_attendance's own default for the same reason.
#     check_in_confirmed = row.get('check_in_confirmed')
#     check_in_confirmed = True if check_in_confirmed is None else bool(check_in_confirmed)
#     # A held late check-in resolved as half-day (mark_held_check_ins_half_day)
#     # keeps `timestamp` around only as an audit trail of the sighting — it
#     # was never a real check-in, so the check-in field must say so rather
#     # than showing that time as if it were confirmed.
#     check_in_display = 'Half Day' if (row.get('day_status') == 'half_day' and not check_in_confirmed) else ts
#     # A held checkout resolved as half-day (mark_held_checkouts_half_day)
#     # clears check_out_timestamp locally — there's no real checkout time to
#     # show, so the checkout field must say so rather than showing blank.
#     # Guarded on "no check_out_timestamp" (rather than day_status alone) so
#     # a checkout that's genuinely been confirmed with a real time is never
#     # shadowed by a half_day flag left over from check-in-side half-day
#     # handling, where no checkout was ever attempted in the first place.
#     # Same reasoning for 'overtime' (mark_held_checkouts_overtime) — a held
#     # LATE checkout sighting flagged as overtime instead of a normal
#     # checkout, also cleared locally, same "show the flag, not blank" need.
#     check_out_display = (
#         'Half Day' if (row.get('day_status') == 'half_day' and not row.get('check_out_timestamp'))
#         else 'Overtime' if (row.get('day_status') == 'overtime' and not row.get('check_out_timestamp'))
#         else row.get('check_out_timestamp')
#     )
#     duration_minutes, duration_label = _attendance_exceptions.compute_duration(
#         row.get('timestamp'), row.get('check_out_timestamp')
#     )
#     name = staff.get('name') or row.get('staff_name') or 'Unknown'
#     department = staff.get('department_name') or staff.get('department') or ''
#     designation = staff.get('role_name') or staff.get('position') or staff.get('designation') or ''
#     people_type = _normalize_people_type(staff.get('people_type') or staff.get('person_type') or staff.get('role') or 'staff')
#     person_code = str(staff.get('person_code') or staff.get('registration_number') or staff.get('employee_id') or staff_id).strip()

#     return {
#         'id': row.get('id'),
#         'user_id': staff_id,
#         'userId': staff_id,
#         'staff_id': staff_id,
#         'staffId': staff_id,
#         'user_name': name,
#         'userName': name,
#         'staff_name': name,
#         'staffName': name,
#         'name': name,
#         'employee_id': person_code,
#         'employeeId': person_code,
#         'person_code': person_code,
#         'personCode': person_code,
#         'registration_number': staff.get('registration_number') or (person_code if people_type == 'student' else ''),
#         'registrationNumber': staff.get('registration_number') or (person_code if people_type == 'student' else ''),
#         'code': person_code,
#         'email': staff.get('email') or '',
#         'department': department,
#         'designation': designation,
#         'position': designation,
#         'people_type': people_type,
#         'peopleType': people_type,
#         'branch_id': branch_ui_id,
#         'branchId': branch_ui_id,
#         'backend_branch_id': backend_branch_id,
#         'backendBranchId': backend_branch_id,
#         'branch_uuid': backend_branch_id,
#         'branch_name': branch.get('name') or staff.get('branch_name') or '',
#         'branchName': branch.get('name') or staff.get('branch_name') or '',
#         # 'status' here is the day-level outcome the frontend already reads
#         # literally — attendanceApi.ts's mapLog/mapTodayRecord read
#         # raw.status straight through, confirmed by reading that file, so
#         # this is no longer a guess. Driven by the attendance table's own
#         # 'day_status' column (present/half_day), set via a held checkout
#         # resolved with "Mark half-day" — see local_db.py's
#         # mark_held_checkouts_half_day and push_node_attendance's
#         # node_day_status handling.
#         #
#         # Half-day still wins outright (it's an operator override of the
#         # whole day). Otherwise the label now reflects whether checkout has
#         # actually happened yet, instead of collapsing both into "PRESENT".
#         'status': (
#             'HALF_DAY' if row.get('day_status') == 'half_day'
#             else 'CHECKED_OUT' if row.get('check_out_timestamp')
#             else 'CHECKED_IN'
#         ),
#         'day_status': row.get('day_status') or 'present',
#         'dayStatus': row.get('day_status') or 'present',
#         # Real, timing-aware classification computed by resolve_check_in_status /
#         # resolve_check_out_status at write time (on_time / late / early /
#         # unscheduled). A separate key from 'status' above, which is
#         # day-level (PRESENT/HALF_DAY), not a timing classification.
#         'check_in_status': row.get('status') or 'unscheduled',
#         'checkInStatus': row.get('status') or 'unscheduled',
#         # Operator-facing context set by the local node — either the
#         # check-in-side "confirmed after window closed" note or the
#         # checkout-side early/late hold note. See local_db.py's
#         # _format_early_before_shift_note / _format_checkout_hold_note.
#         # attendanceApi.ts already reads this key through unchanged.
#         'notes': row.get('notes'),
#         # 'early' | 'late' | None — non-null only if this row's checkout was
#         # synced while still held for review, before an operator resolved
#         # it (see attendance_sync_worker.py's comment on this field). None
#         # for a normal confirmed checkout or one resolved via half-day/
#         # leave-open.
#         'check_out_hold_reason': row.get('check_out_hold_reason'),
#         'checkOutHoldReason': row.get('check_out_hold_reason'),
#         # 'late' | None — non-null only if a late check-in was synced while
#         # still held for review, before an operator resolved it via
#         # confirm_held_check_ins / mark_held_check_ins_half_day. Mirrors
#         # check_out_hold_reason above.
#         'check_in_hold_reason': row.get('check_in_hold_reason'),
#         'checkInHoldReason': row.get('check_in_hold_reason'),
#         # 'include' | 'exclude' | None. Only ever set by
#         # set_local_node_payroll_decision (support_db_attendance_exceptions.py)
#         # for a local-node row already classified half_day/short_leave/late/
#         # overtime -- see that module's Phase 3 section. None means either
#         # "nothing to decide" (an ordinary present/on_time day) or "not
#         # decided yet" -- the dashboard should only treat this as a real
#         # pending decision when day_status is one of the classified values
#         # AND capture_channel is 'local_node' AND this is still None.
#         'check_out_payroll_decision': row.get('check_out_payroll_decision'),
#         'checkOutPayrollDecision': row.get('check_out_payroll_decision'),
#         # Reserved for the cloud/mobile exceptions flow -- resolve_attendance_exception
#         # does not write this column yet, so it will always be None for
#         # mobile-sourced rows today. Included for forward-compat so the
#         # dashboard doesn't need another backend round-trip once it does.
#         'check_in_payroll_decision': row.get('check_in_payroll_decision'),
#         'checkInPayrollDecision': row.get('check_in_payroll_decision'),
#         # Computed once here from timestamp/check_out_timestamp — same
#         # helper the mobile history endpoint uses, so the two surfaces
#         # never disagree about how long someone worked.
#         'work_duration': 'Half Day' if row.get('day_status') == 'half_day' else duration_label,
#         'workDuration': 'Half Day' if row.get('day_status') == 'half_day' else duration_label,
#         'duration_minutes': duration_minutes,
#         'durationMinutes': duration_minutes,
#         'pending_review': bool(row.get('check_in_hold_reason') or row.get('check_out_hold_reason')),
#         'pendingReview': bool(row.get('check_in_hold_reason') or row.get('check_out_hold_reason')),
#         'check_in': check_in_display,
#         'checkIn': check_in_display,
#         'check_out': check_out_display,
#         'checkOut': check_out_display,
#         'check_out_status': row.get('check_out_status'),
#         'checkOutStatus': row.get('check_out_status'),
#         'check_out_confidence': float(row.get('check_out_confidence') or 0) if row.get('check_out_timestamp') else None,
#         'checkOutConfidence': float(row.get('check_out_confidence') or 0) if row.get('check_out_timestamp') else None,
#         'check_out_camera_id': row.get('check_out_camera_id'),
#         'checkOutCameraId': row.get('check_out_camera_id'),
#         'timestamp': ts,
#         'log_date': str(ts)[:10],
#         'confidence': float(row.get('confidence') or 0),
#         'source': row.get('source') or 'camera',
#         # local_node | cloud | mobile_app — None for rows written before
#         # this column existed (no backfill guess for the smaller number of
#         # already-ambiguous 'camera' rows predating node_id being reliably
#         # set; see the migration notes for the one case that IS backfillable).
#         'capture_channel': row.get('capture_channel'),
#         'captureChannel': row.get('capture_channel'),
#         'camera_id': row.get('camera_id'),
#         'cameraId': row.get('camera_id'),
#         'node_id': row.get('node_id'),
#         'nodeId': row.get('node_id'),
#         'device_id': row.get('device_id'),
#         'deviceId': row.get('device_id'),
#         'metadata': row.get('metadata') if isinstance(row.get('metadata'), dict) else {},
#         'created_at': row.get('created_at') or ts,
#         'createdAt': row.get('created_at') or ts,
#         'organization_id': row.get('org_id'),
#         'organizationId': row.get('org_id'),
#         'org_id': row.get('org_id'),
#     }

# def _client_attendance_rows(
#     org_id: str,
#     *,
#     branch_id: object = None,
#     date_value: str | None = None,
#     start: str | None = None,
#     end: str | None = None,
#     today_only: bool = True,
#     limit: int = 500,
#     people_type: str | None = None,
#     scope_ids: frozenset | None = None,
# ) -> list[dict]:
#     """Read Supabase attendance rows for Client Dashboard screens."""
#     from support_db_branches import list_branches
#     from support_db_organizations import get_organization
#     from support_db_staff import _normalize_people_type
#     if scope_ids is not None and not scope_ids:
#         return []

#     sb = get_supabase()
#     org_id = str(org_id)
#     get_organization(org_id)
#     branches = list_branches(org_id)
#     branch_by_id = {str(branch.get('id')): branch for branch in branches if branch.get('id')}
#     branch_ui_by_id = {str(branch.get('id')): idx for idx, branch in enumerate(branches, start=1) if branch.get('id')}
#     backend_branch_id = _resolve_attendance_branch_id(branch_id, branches)

#     safe_limit = max(1, min(int(limit or 500), 2000))

#     log_date = None
#     start_iso = None
#     end_iso = None
#     if today_only:
#         log_date, start_iso, end_iso = _dashboard_day_window_utc(date_value)
#     else:
#         start_iso = _dashboard_range_bound_utc(start, is_end=False)
#         end_iso = _dashboard_range_bound_utc(end, is_end=True)

#     def _attendance_query():
#         query = (
#             get_supabase()
#             .table('attendance')
#             .select('*')
#             .eq('org_id', org_id)
#             .order('timestamp', desc=True)
#             .limit(safe_limit)
#         )
#         if backend_branch_id:
#             query = query.eq('branch_id', backend_branch_id)
#         if start_iso and end_iso:
#             query = query.gte('timestamp', start_iso).lt('timestamp', end_iso)
#         elif start_iso:
#             query = query.gte('timestamp', start_iso)
#         elif end_iso:
#             query = query.lt('timestamp', end_iso)
#         if scope_ids is not None:
#             query = query.in_('staff_id', list(scope_ids))
#         return query

#     result = _execute_supabase('client_attendance_rows', _attendance_query)
#     rows = result.data or []
#     if not rows:
#         return []

#     staff_ids = sorted({str(row.get('staff_id') or '').strip() for row in rows if row.get('staff_id')})
#     staff_by_id: dict[str, dict] = {}
#     if staff_ids:
#         staff_result = _execute_supabase(
#             'client_attendance_staff_lookup',
#             lambda: (
#                 get_supabase()
#                 .table('client_staff')
#                 .select('id, org_id, branch_id, employee_id, person_code, registration_number, person_code_label, name, email, department_name, role_name, position, role, people_type, status, is_archived')
#                 .eq('org_id', org_id)
#                 .in_('id', staff_ids)
#             ),
#         )
#         staff_by_id = {str(staff.get('id')): staff for staff in (staff_result.data or [])}

#     normalized_people_type = _normalize_people_type(people_type, '') if people_type else ''
#     if normalized_people_type:
#         rows = [
#             row for row in rows
#             if _normalize_people_type(
#                 staff_by_id.get(str(row.get('staff_id') or ''), {}).get('people_type')
#                 or staff_by_id.get(str(row.get('staff_id') or ''), {}).get('person_type')
#                 or staff_by_id.get(str(row.get('staff_id') or ''), {}).get('role')
#                 or '',
#                 '',
#             ) == normalized_people_type
#         ]

#     mapped = [
#         _attendance_row_for_dashboard(
#             row,
#             staff_by_id=staff_by_id,
#             branch_by_id=branch_by_id,
#             branch_ui_by_id=branch_ui_by_id,
#         )
#         for row in rows
#     ]

#     if log_date:
#         for item in mapped:
#             item['log_date'] = log_date
#             item['logDate'] = log_date

#     return mapped

# def get_client_staff_attendance_history(
#     org_id: str,
#     staff_id: str,
#     limit: int = 100,
# ) -> list[dict]:
#     """
#     Own-attendance history for the mobile self-service portal (client_staff).

#     Staff-scoped counterpart to _client_attendance_rows (org/branch-scoped,
#     used by Client Dashboard screens) — reads the SAME Supabase `attendance`
#     table mark_client_staff_attendance() writes into. The mobile app
#     previously called /get_attendance_by_name, which reads the disconnected
#     legacy SQLite `db` module by user_name; a Supabase-tenant staff member's
#     own just-marked attendance could never appear there — which is exactly
#     why the home screen showed "Not Marked Yet" moments after a successful
#     mark, and why the WiFi auto-mark timer kept re-submitting (it re-marks
#     whenever _todayPresent reads false, which it always did).

#     Shaped to the flat {date, time, outTime, workDuration, status} keys
#     office_home_screen.dart already parses, rather than the nested
#     check_in/check_out shape _attendance_row_for_dashboard returns for the
#     React dashboard — one mapping surface per consumer, not a shared shape
#     stretched to fit both.
#     """
#     org_id = str(org_id)
#     staff_id = str(staff_id)
#     safe_limit = max(1, min(int(limit or 100), 500))

#     def _query():
#         return (
#             get_supabase()
#             .table('attendance')
#             .select(
#                 'id, timestamp, check_out_timestamp, day_status, capture_channel, '
#                 'status, check_out_status, notes, check_in_hold_reason, '
#                 'check_out_hold_reason, branch_id'
#             )
#             .eq('org_id', org_id)
#             .eq('staff_id', staff_id)
#             .order('timestamp', desc=True)
#             .limit(safe_limit)
#         )

#     result = _execute_supabase('client_staff_attendance_history', _query)
#     rows = result.data or []

#     # Resolve each distinct branch's timezone once up front rather than
#     # per-row -- a staff member's history normally sits in one branch, but
#     # nothing here assumes that, so this stays correct (and still cheap)
#     # if it doesn't. Falls back to UTC for a row with no branch_id, same
#     # as _resolve_client_staff_attendance_window's own fallback elsewhere
#     # in this file.
#     sb = get_supabase()
#     branch_ids = {str(r['branch_id']) for r in rows if r.get('branch_id')}
#     branch_zones = {
#         bid: _get_branch_timezone(sb, org_id, bid) for bid in branch_ids
#     }

#     history = []
#     for row in rows:
#         ts = str(row.get('timestamp') or '')
#         check_out_ts = row.get('check_out_timestamp')
#         check_out_str = str(check_out_ts) if check_out_ts else ''
#         day_status = row.get('day_status') or 'present'
#         hold_reason = row.get('check_in_hold_reason') or row.get('check_out_hold_reason')

#         duration_minutes, work_duration = _attendance_exceptions.compute_duration(
#             row.get('timestamp'), row.get('check_out_timestamp')
#         )

#         # Pending Review outranks Half Day/Present in the status label —
#         # an admin hasn't decided the day outcome yet, so showing "Present"
#         # or "Half Day" here would be presenting a still-open exception as
#         # already resolved.
#         status_label = (
#             'Pending Review' if hold_reason
#             else 'Half Day' if day_status == 'half_day'
#             else 'Overtime' if day_status == 'overtime'
#             else 'Present'
#         )

#         zone = branch_zones.get(str(row.get('branch_id') or ''), ZoneInfo('UTC'))

#         history.append({
#             'id': row.get('id'),
#             # Branch-local calendar date -- previously a raw slice of the
#             # UTC 'timestamp' string, so a mark made within a few hours of
#             # local midnight in a non-UTC branch could land on the "wrong"
#             # date. local_date_str_iso already existed for exactly this
#             # (see its docstring) but was never wired in here.
#             'date': _attendance_exceptions.local_date_str_iso(ts, zone) if ts else '',
#             # Branch-local HH:MM, not the raw UTC string sliced verbatim --
#             # that was the actual cause of the mobile app showing a time
#             # hours off from what the person actually experienced (5h off
#             # for a UTC+5 branch). local_time_str_iso already existed for
#             # this too (see support_db_attendance_exceptions.py) but,
#             # again, was never called from this function.
#             'time': _attendance_exceptions.local_time_str_iso(ts, zone) if ts else '',
#             'outTime': _attendance_exceptions.local_time_str_iso(check_out_str, zone) if check_out_str else '',
#             'workDuration': 'Half Day' if day_status == 'half_day' else work_duration,
#             'durationMinutes': duration_minutes,
#             'status': status_label,
#             'checkInStatus': row.get('status'),
#             'checkOutStatus': row.get('check_out_status'),
#             'notes': row.get('notes'),
#             'pendingReview': bool(hold_reason),
#             'holdReason': hold_reason,
#             'captureChannel': row.get('capture_channel'),
#         })

#     return history

# def get_client_attendance_today(
#     org_id: str, branch_id: object = None, date_value: str | None = None,
#     start: str | None = None, end: str | None = None,
#     limit: int = 500, people_type: str | None = None,
#     scope_ids: frozenset | None = None,
# ) -> list[dict]:
#     if start is not None or end is not None:
#         return _client_attendance_rows(
#             org_id,
#             branch_id=branch_id,
#             start=start,
#             end=end,
#             today_only=False,
#             limit=limit,
#             people_type=people_type,
#             scope_ids=scope_ids,
#         )
#     return _client_attendance_rows(
#         org_id, branch_id=branch_id, date_value=date_value,
#         today_only=True, limit=limit, people_type=people_type,
#         scope_ids=scope_ids,
#     )

# def get_client_attendance_logs(
#     org_id: str, branch_id: object = None, limit: int = 100,
#     people_type: str | None = None, scope_ids: frozenset | None = None,
# ) -> list[dict]:
#     return _client_attendance_rows(
#         org_id, branch_id=branch_id, today_only=False, limit=limit,
#         people_type=people_type, scope_ids=scope_ids,
#     )

# def get_client_attendance_statistics(
#     org_id: str,
#     branch_id: object = None,
#     date_value: str | None = None,
#     people_type: str | None = None,
# ) -> dict:
#     """Supabase-backed attendance stats for Support-created UUID organizations."""
#     from support_db_branches import list_branches
#     from support_db_nodes import _iso_now
#     from support_db_staff import list_client_staff
#     org_id = str(org_id)
#     branches = list_branches(org_id)
#     backend_branch_id = _resolve_attendance_branch_id(branch_id, branches)

#     staff_rows = list_client_staff(
#         org_id,
#         branch_id=backend_branch_id if backend_branch_id else None,
#         role='staff',
#         people_type=people_type,
#         archived=False,
#     )
#     attendance_rows = get_client_attendance_today(
#         org_id,
#         branch_id=backend_branch_id if backend_branch_id else None,
#         date_value=date_value,
#         limit=2000,
#         people_type=people_type,
#     )
#     unique_staff_today = {str(row.get('staff_id') or row.get('staffId') or '') for row in attendance_rows}
#     unique_staff_today.discard('')
#     total_staff = len(staff_rows)
#     present_today = len(unique_staff_today)

#     return {
#         'total_users': total_staff,
#         'attendance_users': total_staff,
#         'total_staff': total_staff,
#         'enrolled_users': sum(1 for row in staff_rows if row.get('is_face_verified')),
#         'today_count': len(attendance_rows),
#         'today_attendance': len(attendance_rows),
#         'unique_users_today': present_today,
#         'present_today': present_today,
#         'absent_today': max(0, total_staff - present_today),
#         'avg_confidence': (
#             sum(float(row.get('confidence') or 0) for row in attendance_rows) / len(attendance_rows)
#             if attendance_rows else 0
#         ),
#         'recent_entries': attendance_rows[:10],
#         'timestamp': _iso_now(),
#     }

# def mark_client_staff_absent_today(
#     org_id: str,
#     staff_id: str,
#     branch_id: object = None,
#     people_type: str | None = None,
#     date_value: str | None = None,
# ) -> dict:
#     """Remove today's attendance rows for one tenant-owned person.

#     This is the UUID/Supabase counterpart of the legacy SQLite absent action.
#     It validates organization ownership and optional people_type before deleting
#     attendance, so student/staff/worker attendance cannot cross tenant scope.
#     """
#     from support_db_branches import list_branches
#     from support_db_staff import _normalize_people_type, get_client_staff_member
#     org_key = str(org_id)
#     staff_key = str(staff_id)
#     if not org_key:
#         raise ValueError('organization_id is required')
#     if not staff_key:
#         raise ValueError('staff_id is required')

#     staff = get_client_staff_member(staff_key)
#     if str(staff.get('organization_id') or '') != org_key:
#         raise ValueError('Person does not belong to this organization')

#     normalized_people_type = _normalize_people_type(people_type, '') if people_type else ''
#     if normalized_people_type:
#         staff_people_type = _normalize_people_type(
#             staff.get('people_type') or staff.get('peopleType') or staff.get('person_type') or staff.get('personType') or 'staff',
#             '',
#         )
#         if staff_people_type != normalized_people_type:
#             raise ValueError('Person does not belong to the requested attendance scope')

#     branches = list_branches(org_key)
#     backend_branch_id = _resolve_attendance_branch_id(branch_id, branches) if branch_id not in (None, '') else None
#     if backend_branch_id and str(staff.get('backend_branch_id') or '') != str(backend_branch_id):
#         raise ValueError('Person does not belong to the requested branch')

#     _log_date, start_iso, end_iso = _dashboard_day_window_utc(date_value)
#     query = (
#         get_supabase()
#         .table('attendance')
#         .delete()
#         .eq('org_id', org_key)
#         .eq('staff_id', staff_key)
#         .gte('timestamp', start_iso)
#         .lt('timestamp', end_iso)
#     )
#     if backend_branch_id:
#         query = query.eq('branch_id', str(backend_branch_id))

#     result = query.execute()
#     return {
#         'success': True,
#         'staff_id': staff_key,
#         'organization_id': org_key,
#         'branch_id': backend_branch_id,
#         'deleted_count': len(result.data or []),
#     }

# _EDITABLE_ATTENDANCE_STATUS_VALUES = {'on_time', 'late', 'early', 'unscheduled'}

# def update_client_attendance_record(org_id: str, record_id: str, payload: dict) -> dict:
#     """Admin edit of one attendance row from the Client Dashboard.

#     Lets an operator correct check-in, check-out, arrival (timing)
#     classification, and notes by hand -- e.g. a camera miss or a staff
#     member who forgot their card, but there's a genuine record to fix.
#     This is a direct field-level edit, not a resolve/hold workflow, so it
#     intentionally does not touch check_in_hold_reason / check_out_hold_reason
#     -- an operator editing values here is providing the correct data
#     themselves, there's nothing left to "hold for review".

#     Body fields (all optional, only supplied ones are changed):
#       - check_in / checkIn / timestamp:      ISO datetime string
#       - check_out / checkOut / check_out_timestamp: ISO datetime string,
#         or "" / null to clear a checkout (e.g. correcting a mistaken one)
#       - arrival_status / arrivalStatus / check_in_status / status:
#         one of 'on_time' | 'late' | 'early' | 'unscheduled'
#       - notes: free text, or "" / null to clear

#     Returns the same shape as the other dashboard attendance reads
#     (_attendance_row_for_dashboard), so the caller can drop the response
#     straight into the row it just edited without a second fetch.
#     """
#     from support_db_branches import list_branches
#     from support_db_nodes import _parse_dt
#     from support_db_staff import get_client_staff_member
#     org_key = str(org_id or '').strip()
#     row_key = str(record_id or '').strip()
#     if not org_key:
#         raise ValueError('organization_id is required')
#     if not row_key:
#         raise ValueError('record id is required')

#     sb = get_supabase()
#     existing = (
#         sb.table('attendance')
#         .select('*')
#         .eq('id', row_key)
#         .eq('org_id', org_key)
#         .limit(1)
#         .execute()
#     )
#     if not existing.data:
#         raise ValueError('Attendance record not found')

#     updates: dict = {}

#     if any(key in payload for key in ('check_in', 'checkIn', 'timestamp')):
#         raw_check_in = payload.get('check_in', payload.get('checkIn', payload.get('timestamp')))
#         parsed = _parse_dt(raw_check_in)
#         if raw_check_in and not parsed:
#             raise ValueError('check_in must be a valid ISO datetime')
#         if parsed:
#             updates['timestamp'] = parsed.astimezone(timezone.utc).isoformat()

#     if any(key in payload for key in ('check_out', 'checkOut', 'check_out_timestamp')):
#         raw_check_out = payload.get(
#             'check_out', payload.get('checkOut', payload.get('check_out_timestamp')),
#         )
#         if raw_check_out in (None, ''):
#             # Explicit clear -- e.g. undoing a mistaken checkout.
#             updates['check_out_timestamp'] = None
#         else:
#             parsed = _parse_dt(raw_check_out)
#             if not parsed:
#                 raise ValueError('check_out must be a valid ISO datetime')
#             updates['check_out_timestamp'] = parsed.astimezone(timezone.utc).isoformat()

#     if any(
#         key in payload
#         for key in ('arrival_status', 'arrivalStatus', 'check_in_status', 'checkInStatus', 'status')
#     ):
#         raw_status = str(
#             payload.get(
#                 'arrival_status',
#                 payload.get(
#                     'arrivalStatus',
#                     payload.get('check_in_status', payload.get('checkInStatus', payload.get('status'))),
#                 ),
#             )
#             or ''
#         ).strip().lower()
#         if raw_status and raw_status not in _EDITABLE_ATTENDANCE_STATUS_VALUES:
#             raise ValueError(
#                 f"status must be one of {sorted(_EDITABLE_ATTENDANCE_STATUS_VALUES)}",
#             )
#         updates['status'] = raw_status or 'unscheduled'

#     if 'notes' in payload:
#         notes = payload.get('notes')
#         updates['notes'] = str(notes).strip() if notes else None

#     if not updates:
#         raise ValueError('No editable fields were provided')

#     (
#         sb.table('attendance')
#         .update(updates)
#         .eq('id', row_key)
#         .eq('org_id', org_key)
#         .execute()
#     )

#     refreshed = (
#         sb.table('attendance')
#         .select('*')
#         .eq('id', row_key)
#         .eq('org_id', org_key)
#         .limit(1)
#         .execute()
#     )
#     row = (refreshed.data or existing.data)[0]

#     staff_id = str(row.get('staff_id') or '').strip()
#     staff = get_client_staff_member(staff_id) if staff_id else {}
#     branches = list_branches(org_key)
#     branch_by_id = {str(b.get('id')): b for b in branches if b.get('id')}
#     branch_ui_by_id = {str(b.get('id')): idx for idx, b in enumerate(branches, start=1) if b.get('id')}

#     return _attendance_row_for_dashboard(
#         row,
#         staff_by_id={staff_id: staff} if staff_id else {},
#         branch_by_id=branch_by_id,
#         branch_ui_by_id=branch_ui_by_id,
#     )

# def complete_face_training_job_from_dashboard(job_id: str, payload: dict) -> dict:
#     """Complete a training job from the Flask Client Dashboard route.

#     This is used for demo/cloud synchronous training where Flask processes the
#     video before the staff member is returned to the UI. It applies the same
#     server-side validation as the Local Node route: staff is never marked
#     trained unless real embedding vectors are submitted.
#     """
#     from support_db_nodes import _iso_now, _replace_face_embeddings_cloud, _valid_embedding_list
#     from support_db_organizations import get_organization
#     from support_db_staff import update_client_staff
#     sb = get_supabase()
#     requested_status = str(payload.get('status') or 'trained').lower()
#     if requested_status not in ('trained', 'failed'):
#         raise ValueError('status must be trained or failed')

#     job_result = (
#         sb.table('face_training_jobs')
#         .select('*')
#         .eq('id', str(job_id))
#         .limit(1)
#         .execute()
#     )
#     if not job_result.data:
#         raise ValueError('Training job not found')

#     job = job_result.data[0]
#     staff_id = str(job.get('client_staff_id') or job.get('staff_id') or '')
#     if not staff_id:
#         raise ValueError('Training job is missing staff id')

#     now = _iso_now()
#     min_embeddings = 10
#     try:
#         min_embeddings = max(1, int(payload.get('min_embedding_count') or min_embeddings))
#     except (TypeError, ValueError):
#         min_embeddings = 10

#     valid_embeddings = _valid_embedding_list(payload.get('embeddings') or [])
#     embedding_count = len(valid_embeddings)
#     status = requested_status
#     error_message = None

#     if requested_status == 'trained' and embedding_count < min_embeddings:
#         status = 'failed'
#         error_message = (
#             f'Training rejected by server: only {embedding_count} valid embeddings were extracted; '
#             f'at least {min_embeddings} are required.'
#         )

#     if status == 'trained':
#         org_id = str(job.get('org_id'))
#         branch_id = str(job.get('branch_id') or '') or None
#         org = get_organization(org_id)
#         is_fallback = str(org.get('attendance_mode') or '').lower() == 'local'

#         _replace_face_embeddings_cloud(
#             org_id=org_id,                # ✅ use the local org_id, not node['org_id']
#             staff_id=staff_id,
#             embeddings=valid_embeddings,
#             is_fallback_copy=is_fallback,
#             source_job_id=str(job_id),
#         )

#         update_client_staff(staff_id, {
#             'face_training_status': 'trained',
#             'is_face_verified': True,
#         })
#     else:
#         if error_message is None:
#             error_message = str(payload.get('error_message') or 'Training failed')
#         update_client_staff(staff_id, {
#             'face_training_status': 'failed',
#             'is_face_verified': False,
#         })

#     update_payload = {
#         'status': status,
#         'error_message': error_message,
#         'processed_at': now,
#         'updated_at': now,
#         'embedding_count': embedding_count,
#     }

#     for key in ('training_duration_seconds', 'total_frames_processed', 'avg_quality'):
#         if key in payload:
#             update_payload[key] = payload.get(key)

#     updated = sb.table('face_training_jobs').update(update_payload).eq('id', str(job_id)).execute()
#     if not updated.data:
#         raise RuntimeError('Failed to update training job')

#     return updated.data[0]

# def _support_clean_text(value: object) -> str:
#     return str(value or '').strip()

# def _resolve_owned_backend_branch_id(org_id: str, raw_branch_id: object = None) -> str | None:
#     from support_db_staff import _resolve_client_branch
#     raw = _support_clean_text(raw_branch_id)
#     if not raw:
#         return None
#     branch, _ = _resolve_client_branch(str(org_id), raw)
#     return str(branch['id'])

# def list_client_cameras(org_id: str, branch_id: object = None) -> list[dict]:
#     """Return client CCTV cameras from branch_cameras — the single source of
#     truth get_node_config() also reads. Never read cameras back out of
#     client_onboarding_configs.cameras: that JSONB blob is onboarding *input*
#     only, mirrored into branch_cameras by _sync_local_node_camera_config, and
#     can silently go stale after a client edits cameras post-onboarding."""
#     from support_db_branches import list_branches
#     from support_db_client_users import _branch_maps
#     branches = list_branches(str(org_id))
#     backend_to_ui, _ui_to_backend = _branch_maps(branches)
#     branch_name_by_id = {str(b.get('id')): b.get('name') for b in branches}
#     selected_backend = _resolve_owned_backend_branch_id(str(org_id), branch_id) if _support_clean_text(branch_id) else None

#     sb = get_supabase()
#     query = sb.table('branch_cameras').select('*').eq('organization_id', str(org_id))
#     if selected_backend:
#         query = query.eq('branch_id', selected_backend)
#     result = _execute_supabase('list_client_cameras', lambda: query.order('channel'))

#     rows = []
#     for camera in result.data or []:
#         backend_branch_id = str(camera.get('branch_id') or '')
#         ui_id = backend_to_ui.get(backend_branch_id)
#         camera_id = str(camera.get('id'))
#         name = camera.get('camera_name') or 'Camera'
#         rtsp_url = camera.get('rtsp_url') or ''
#         rows.append({
#             **camera,
#             'id': camera_id,
#             'camera_id': camera_id,
#             'name': name,
#             'camera_name': name,
#             'type': camera.get('camera_type') or 'nvr',
#             'camera_type': camera.get('camera_type') or 'nvr',
#             'organization_id': str(org_id),
#             'org_id': str(org_id),
#             'branch_id': backend_branch_id,
#             'backend_branch_id': backend_branch_id,
#             'branchId': ui_id,
#             'branchName': branch_name_by_id.get(backend_branch_id),
#             'branch_name': branch_name_by_id.get(backend_branch_id),
#             'rtsp_url': rtsp_url,
#             'rtspUrl': rtsp_url,
#         })
#     return rows

# def get_client_camera_by_id(org_id: str, camera_id: str) -> dict | None:
#     from support_db_branches import list_branches
#     from support_db_client_users import _branch_maps
#     camera_key = _support_clean_text(camera_id)
#     if not camera_key:
#         return None
#     sb = get_supabase()
#     result = (
#         sb.table('branch_cameras')
#         .select('*')
#         .eq('organization_id', str(org_id))
#         .eq('id', camera_key)
#         .limit(1)
#         .execute()
#     )
#     if not result.data:
#         return None

#     branches = list_branches(str(org_id))
#     backend_to_ui, _ui_to_backend = _branch_maps(branches)
#     branch_name_by_id = {str(b.get('id')): b.get('name') for b in branches}

#     camera = result.data[0]
#     backend_branch_id = str(camera.get('branch_id') or '')
#     name = camera.get('camera_name') or 'Camera'
#     rtsp_url = camera.get('rtsp_url') or ''
#     return {
#         **camera,
#         'id': camera_key,
#         'camera_id': camera_key,
#         'name': name,
#         'camera_name': name,
#         'type': camera.get('camera_type') or 'nvr',
#         'camera_type': camera.get('camera_type') or 'nvr',
#         'org_id': str(org_id),
#         'organization_id': str(org_id),
#         'branch_id': backend_branch_id,
#         'backend_branch_id': backend_branch_id,
#         'branchId': backend_to_ui.get(backend_branch_id),
#         'branchName': branch_name_by_id.get(backend_branch_id),
#         'rtsp_url': rtsp_url,
#         'rtspUrl': rtsp_url,
#     }

# def _client_staff_lookup(org_id: str, staff_ids: list[str]) -> dict[str, dict]:
#     from support_db_staff import _client_staff_safe, _resolve_shift_map
#     if not staff_ids:
#         return {}
#     result = _execute_supabase(
#         'client_staff_lookup',
#         lambda: (
#             get_supabase()
#             .table('client_staff')
#             .select('*')
#             .eq('org_id', str(org_id))
#             .in_('id', staff_ids)
#         ),
#     )
#     rows = result.data or []
#     shifts_by_id = _resolve_shift_map(org_id, {r.get('shift_id_ref') for r in rows})
#     return {
#         str(row.get('id')): _client_staff_safe(row, str(org_id), shifts_by_id=shifts_by_id)
#         for row in rows
#     }

# def _resolve_staff_people_type(staff: dict | None) -> str:
#     """
#     Single source of truth for "what people_type is this staff record".
#     Used by both list_client_leave_requests' people_type filter AND
#     _map_client_leave's returned row, so the value the backend filters on
#     and the value the client actually receives can never drift apart again.
#     """
#     from support_db_staff import _normalize_people_type
#     staff = staff or {}
#     return _normalize_people_type(
#         staff.get('people_type') or staff.get('person_type') or staff.get('role') or 'staff',
#         'staff',
#     )

# def _map_client_leave(row: dict, staff_by_id: dict[str, dict] | None = None) -> dict:
#     staff_by_id = staff_by_id or {}
#     staff_id = _support_clean_text(row.get('staff_id') or row.get('user_id') or row.get('client_staff_id'))
#     staff = staff_by_id.get(staff_id, {})
#     branch_id = _support_clean_text(row.get('branch_id') or staff.get('backend_branch_id'))
#     start_date = row.get('start_date') or row.get('startDate') or ''
#     end_date = row.get('end_date') or row.get('endDate') or start_date
#     days = row.get('days')
#     if days in (None, ''):
#         try:
#             days = max(1, (date.fromisoformat(str(end_date)) - date.fromisoformat(str(start_date))).days + 1)
#         except Exception:
#             days = 1
#     name = row.get('user_name') or row.get('staff_name') or staff.get('name') or 'Unknown'
#     branch_name = row.get('branch_name') or staff.get('branch_name') or ''
#     department = row.get('department') or staff.get('department') or ''
#     leave_type = row.get('leave_type') or row.get('type') or 'annual'
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
#         'name': name,
#         'user_name': name,
#         'userName': name,
#         'staff_name': name,
#         'staffName': name,
#         'branch_id': branch_id,
#         'branchId': branch_id,
#         'backend_branch_id': branch_id,
#         'backendBranchId': branch_id,
#         'branch_name': branch_name,
#         'branchName': branch_name,
#         'department': department,
#         'dept': department,
#         'people_type': people_type,
#         'peopleType': people_type,
#         'leave_type': leave_type,
#         'type': leave_type,
#         'half_day_period': row.get('half_day_period'),
#         'halfDayPeriod': row.get('half_day_period'),
#         'half_day_start_time': row.get('half_day_start_time'),
#         'halfDayStartTime': row.get('half_day_start_time'),
#         'half_day_end_time': row.get('half_day_end_time'),
#         'halfDayEndTime': row.get('half_day_end_time'),
#         'start_date': start_date,
#         'startDate': start_date,
#         'end_date': end_date,
#         'endDate': end_date,
#         'days': int(days or 1),
#         'reason': row.get('reason') or '',
#         'status': row.get('status') or 'pending',
#         'approved_by': row.get('approved_by'),
#         'approvedBy': row.get('approved_by'),
#         'created_at': row.get('created_at'),
#         'createdAt': row.get('created_at'),
#         'updated_at': row.get('updated_at'),
#         'updatedAt': row.get('updated_at'),
#     }

# def list_client_leave_requests(
#     org_id: str, branch_id: object = None, user_id: object = None,
#     status: str | None = None, people_type: str | None = None,
#     scope_ids: frozenset | None = None,
# ) -> list[dict]:
#     from support_db_organizations import get_organization
#     from support_db_staff import _normalize_people_type
#     org_key = str(org_id)
#     get_organization(org_key)
#     if scope_ids is not None and not scope_ids:
#         return []

#     branch_backend = _resolve_owned_backend_branch_id(org_key, branch_id) if _support_clean_text(branch_id) else None
#     user_key = _support_clean_text(user_id)
#     clean_status = str(status).lower() if status else ''
#     clean_people_type = _normalize_people_type(people_type, 'staff') if people_type else None

#     try:
#         def _leave_query():
#             query = get_supabase().table('leave_requests').select('*').eq('org_id', org_key)
#             if branch_backend:
#                 query = query.eq('branch_id', branch_backend)
#             if user_key:
#                 query = query.eq('staff_id', user_key)
#             if clean_status:
#                 query = query.eq('status', clean_status)
#             if scope_ids is not None:
#                 query = query.in_('staff_id', list(scope_ids))
#             return query.order('created_at', desc=True)
#         result = _execute_supabase('list_client_leave_requests', _leave_query)
#     except Exception as exc:
#         if _table_missing(exc, 'leave_requests'):
#             logger.warning('leave_requests table is missing; returning empty tenant-scoped leave list')
#             return []
#         raise

#     rows = result.data or []
#     staff_ids = sorted({_support_clean_text(row.get('staff_id') or row.get('user_id')) for row in rows if _support_clean_text(row.get('staff_id') or row.get('user_id'))})
#     staff_by_id = _client_staff_lookup(org_key, staff_ids)

#     if clean_people_type:
#         filtered_rows = []
#         for row in rows:
#             staff_id = _support_clean_text(row.get('staff_id') or row.get('user_id'))
#             staff = staff_by_id.get(staff_id, {})
#             if _resolve_staff_people_type(staff) == clean_people_type:
#                 filtered_rows.append(row)
#         rows = filtered_rows

#     leave_type_rules: dict[str, str] = {}
#     try:
#         from support_db_payroll import get_payroll_policy
#         policy = get_payroll_policy(org_key)
#         raw_rules = policy.get('leaveTypeRules') if isinstance(policy, dict) else {}
#         if isinstance(raw_rules, dict):
#             leave_type_rules = {
#                 str(k).strip().lower(): str(v).strip().lower()
#                 for k, v in raw_rules.items()
#                 if str(k).strip() and str(v).strip().lower() in {'paid', 'unpaid'}
#             }
#     except Exception:
#         leave_type_rules = {}

#     attendance_ref_re = re.compile(r'attendance_id=([0-9a-f-]{8,})', re.IGNORECASE)
#     linked_attendance_ids: set[str] = set()
#     for row in rows:
#         reason_text = str(row.get('reason') or '')
#         match = attendance_ref_re.search(reason_text)
#         if match:
#             linked_attendance_ids.add(match.group(1))

#     payroll_decision_by_attendance: dict[str, str] = {}
#     if linked_attendance_ids:
#         try:
#             attendance_result = _execute_supabase(
#                 'list_client_leave_requests.attendance_payroll_decisions',
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

#     mapped_rows: list[dict] = []
#     for row in rows:
#         mapped = _map_client_leave(row, staff_by_id)
#         leave_type = _support_clean_text(mapped.get('leave_type') or mapped.get('type')).lower()

#         reason_text = str(row.get('reason') or '')
#         match = attendance_ref_re.search(reason_text)
#         attendance_id = match.group(1) if match else ''
#         payroll_decision = payroll_decision_by_attendance.get(attendance_id, '') if attendance_id else ''
#         is_attendance_adjustment = attendance_id != '' or leave_type == 'attendance_adjustment'

#         if payroll_decision == 'exclude':
#             leave_compensation = 'excluded'
#         elif payroll_decision == 'include':
#             leave_compensation = 'unpaid'
#         elif is_attendance_adjustment:
#             # Attendance-adjusted leave rows are payroll-linked exceptions.
#             # With no explicit exclude decision, payroll includes them.
#             leave_compensation = 'unpaid'
#         else:
#             leave_compensation = leave_type_rules.get(leave_type, 'not_configured')

#         mapped['leave_compensation'] = leave_compensation
#         mapped['leaveCompensation'] = leave_compensation
#         mapped['leave_payroll_decision'] = payroll_decision or None
#         mapped['leavePayrollDecision'] = payroll_decision or None
#         mapped_rows.append(mapped)

#     return mapped_rows


"""
support_db_attendance_dashboard.py
───────────────────────────────────────────────────────────────────────────────
Client dashboard read models for attendance, leave, and overtime, plus a
group of tenant-safe helpers (cameras, staff lookups) shared by those views.

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

def _dashboard_day_window_utc(date_value: str | None = None) -> tuple[str, str, str]:
    """Return UTC start/end ISO strings for one dashboard attendance day."""
    if date_value:
        try:
            selected = date.fromisoformat(str(date_value)[:10])
        except Exception:
            selected = datetime.now(timezone.utc).date()
    else:
        selected = datetime.now(timezone.utc).date()

    start = datetime(selected.year, selected.month, selected.day, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return selected.isoformat(), start.isoformat(), end.isoformat()


def _dashboard_range_bound_utc(value: str | None, *, is_end: bool = False) -> str | None:
    if value is None:
        return None

    raw = str(value).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        date_value = date.fromisoformat(raw)
        if is_end:
            date_value += timedelta(days=1)
        return datetime(
            date_value.year,
            date_value.month,
            date_value.day,
            tzinfo=timezone.utc,
        ).isoformat()

    try:
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.isoformat()
    except Exception:
        return raw


def _resolve_attendance_branch_id(raw_branch_id: object, branches: list[dict]) -> str | None:
    raw = str(raw_branch_id or '').strip()
    if not raw:
        return None

    # Accept the real Supabase UUID.
    for branch in branches:
        backend_id = str(branch.get('id') or '').strip()
        if backend_id and raw == backend_id:
            return backend_id

    # Accept the current React numeric UI id (1, 2, 3, ...).
    try:
        ui_id = int(raw)
    except (TypeError, ValueError):
        return None

    if ui_id < 1 or ui_id > len(branches):
        return None

    backend_id = branches[ui_id - 1].get('id')
    return str(backend_id) if backend_id else None

def _attendance_row_for_dashboard(
    row: dict,
    *,
    staff_by_id: dict[str, dict],
    branch_by_id: dict[str, dict],
    branch_ui_by_id: dict[str, int],
) -> dict:
    """Map Supabase attendance rows into the existing React attendance shape."""
    from support_db_nodes import _iso_now
    from support_db_staff import _normalize_people_type
    staff_id = str(row.get('staff_id') or '').strip()
    staff = staff_by_id.get(staff_id, {})
    backend_branch_id = str(row.get('branch_id') or staff.get('branch_id') or '').strip()
    branch = branch_by_id.get(backend_branch_id, {})
    branch_ui_id = branch_ui_by_id.get(backend_branch_id)
    ts = row.get('timestamp') or row.get('created_at') or _iso_now()
    # NULL means the row predates this column (written before the
    # check-in-hold feature) — treat as confirmed, matching
    # push_node_attendance's own default for the same reason.
    check_in_confirmed = row.get('check_in_confirmed')
    check_in_confirmed = True if check_in_confirmed is None else bool(check_in_confirmed)
    # A held late check-in resolved as half-day (mark_held_check_ins_half_day)
    # keeps `timestamp` around only as an audit trail of the sighting — it
    # was never a real check-in, so the check-in field must say so rather
    # than showing that time as if it were confirmed.
    check_in_display = 'Half Day' if (row.get('day_status') == 'half_day' and not check_in_confirmed) else ts
    # A held checkout resolved as half-day (mark_held_checkouts_half_day)
    # clears check_out_timestamp locally — there's no real checkout time to
    # show, so the checkout field must say so rather than showing blank.
    # Guarded on "no check_out_timestamp" (rather than day_status alone) so
    # a checkout that's genuinely been confirmed with a real time is never
    # shadowed by a half_day flag left over from check-in-side half-day
    # handling, where no checkout was ever attempted in the first place.
    # Same reasoning for 'overtime' (mark_held_checkouts_overtime) — a held
    # LATE checkout sighting flagged as overtime instead of a normal
    # checkout, also cleared locally, same "show the flag, not blank" need.
    check_out_display = (
        'Half Day' if (row.get('day_status') == 'half_day' and not row.get('check_out_timestamp'))
        else 'Overtime' if (row.get('day_status') == 'overtime' and not row.get('check_out_timestamp'))
        else row.get('check_out_timestamp')
    )
    duration_minutes, duration_label = _attendance_exceptions.compute_duration(
        row.get('timestamp'), row.get('check_out_timestamp')
    )
    name = staff.get('name') or row.get('staff_name') or 'Unknown'
    department = staff.get('department_name') or staff.get('department') or ''
    designation = staff.get('role_name') or staff.get('position') or staff.get('designation') or ''
    people_type = _normalize_people_type(staff.get('people_type') or staff.get('person_type') or staff.get('role') or 'staff')
    person_code = str(staff.get('person_code') or staff.get('registration_number') or staff.get('employee_id') or staff_id).strip()

    return {
        'id': row.get('id'),
        'user_id': staff_id,
        'userId': staff_id,
        'staff_id': staff_id,
        'staffId': staff_id,
        'user_name': name,
        'userName': name,
        'staff_name': name,
        'staffName': name,
        'name': name,
        'employee_id': person_code,
        'employeeId': person_code,
        'person_code': person_code,
        'personCode': person_code,
        'registration_number': staff.get('registration_number') or (person_code if people_type == 'student' else ''),
        'registrationNumber': staff.get('registration_number') or (person_code if people_type == 'student' else ''),
        'code': person_code,
        'email': staff.get('email') or '',
        'department': department,
        'designation': designation,
        'position': designation,
        'people_type': people_type,
        'peopleType': people_type,
        'branch_id': branch_ui_id,
        'branchId': branch_ui_id,
        'backend_branch_id': backend_branch_id,
        'backendBranchId': backend_branch_id,
        'branch_uuid': backend_branch_id,
        'branch_name': branch.get('name') or staff.get('branch_name') or '',
        'branchName': branch.get('name') or staff.get('branch_name') or '',
        # 'status' here is the day-level outcome the frontend already reads
        # literally — attendanceApi.ts's mapLog/mapTodayRecord read
        # raw.status straight through, confirmed by reading that file, so
        # this is no longer a guess. Driven by the attendance table's own
        # 'day_status' column (present/half_day), set via a held checkout
        # resolved with "Mark half-day" — see local_db.py's
        # mark_held_checkouts_half_day and push_node_attendance's
        # node_day_status handling.
        #
        # Half-day still wins outright (it's an operator override of the
        # whole day). Otherwise the label now reflects whether checkout has
        # actually happened yet, instead of collapsing both into "PRESENT".
        'status': (
            'HALF_DAY' if row.get('day_status') == 'half_day'
            else 'CHECKED_OUT' if row.get('check_out_timestamp')
            else 'CHECKED_IN'
        ),
        'day_status': row.get('day_status') or 'present',
        'dayStatus': row.get('day_status') or 'present',
        # Real, timing-aware classification computed by resolve_check_in_status /
        # resolve_check_out_status at write time (on_time / late / early /
        # unscheduled). A separate key from 'status' above, which is
        # day-level (PRESENT/HALF_DAY), not a timing classification.
        'check_in_status': row.get('status') or 'unscheduled',
        'checkInStatus': row.get('status') or 'unscheduled',
        # Operator-facing context set by the local node — either the
        # check-in-side "confirmed after window closed" note or the
        # checkout-side early/late hold note. See local_db.py's
        # _format_early_before_shift_note / _format_checkout_hold_note.
        # attendanceApi.ts already reads this key through unchanged.
        'notes': row.get('notes'),
        # 'early' | 'late' | None — non-null only if this row's checkout was
        # synced while still held for review, before an operator resolved
        # it (see attendance_sync_worker.py's comment on this field). None
        # for a normal confirmed checkout or one resolved via half-day/
        # leave-open.
        'check_out_hold_reason': row.get('check_out_hold_reason'),
        'checkOutHoldReason': row.get('check_out_hold_reason'),
        # 'late' | None — non-null only if a late check-in was synced while
        # still held for review, before an operator resolved it via
        # confirm_held_check_ins / mark_held_check_ins_half_day. Mirrors
        # check_out_hold_reason above.
        'check_in_hold_reason': row.get('check_in_hold_reason'),
        'checkInHoldReason': row.get('check_in_hold_reason'),
        # 'include' | 'exclude' | None. Only ever set by
        # set_local_node_payroll_decision (support_db_attendance_exceptions.py)
        # for a local-node row already classified half_day/short_leave/late/
        # overtime -- see that module's Phase 3 section. None means either
        # "nothing to decide" (an ordinary present/on_time day) or "not
        # decided yet" -- the dashboard should only treat this as a real
        # pending decision when day_status is one of the classified values
        # AND capture_channel is 'local_node' AND this is still None.
        'check_out_payroll_decision': row.get('check_out_payroll_decision'),
        'checkOutPayrollDecision': row.get('check_out_payroll_decision'),
        # Reserved for the cloud/mobile exceptions flow -- resolve_attendance_exception
        # does not write this column yet, so it will always be None for
        # mobile-sourced rows today. Included for forward-compat so the
        # dashboard doesn't need another backend round-trip once it does.
        'check_in_payroll_decision': row.get('check_in_payroll_decision'),
        'checkInPayrollDecision': row.get('check_in_payroll_decision'),
        # Computed once here from timestamp/check_out_timestamp — same
        # helper the mobile history endpoint uses, so the two surfaces
        # never disagree about how long someone worked.
        'work_duration': 'Half Day' if row.get('day_status') == 'half_day' else duration_label,
        'workDuration': 'Half Day' if row.get('day_status') == 'half_day' else duration_label,
        'duration_minutes': duration_minutes,
        'durationMinutes': duration_minutes,
        'pending_review': bool(row.get('check_in_hold_reason') or row.get('check_out_hold_reason')),
        'pendingReview': bool(row.get('check_in_hold_reason') or row.get('check_out_hold_reason')),
        'check_in': check_in_display,
        'checkIn': check_in_display,
        'check_out': check_out_display,
        'checkOut': check_out_display,
        'check_out_status': row.get('check_out_status'),
        'checkOutStatus': row.get('check_out_status'),
        'check_out_confidence': float(row.get('check_out_confidence') or 0) if row.get('check_out_timestamp') else None,
        'checkOutConfidence': float(row.get('check_out_confidence') or 0) if row.get('check_out_timestamp') else None,
        'check_out_camera_id': row.get('check_out_camera_id'),
        'checkOutCameraId': row.get('check_out_camera_id'),
        'timestamp': ts,
        'log_date': str(ts)[:10],
        'confidence': float(row.get('confidence') or 0),
        'source': row.get('source') or 'camera',
        # local_node | cloud | mobile_app — None for rows written before
        # this column existed (no backfill guess for the smaller number of
        # already-ambiguous 'camera' rows predating node_id being reliably
        # set; see the migration notes for the one case that IS backfillable).
        'capture_channel': row.get('capture_channel'),
        'captureChannel': row.get('capture_channel'),
        'camera_id': row.get('camera_id'),
        'cameraId': row.get('camera_id'),
        'node_id': row.get('node_id'),
        'nodeId': row.get('node_id'),
        'device_id': row.get('device_id'),
        'deviceId': row.get('device_id'),
        'metadata': row.get('metadata') if isinstance(row.get('metadata'), dict) else {},
        'created_at': row.get('created_at') or ts,
        'createdAt': row.get('created_at') or ts,
        'organization_id': row.get('org_id'),
        'organizationId': row.get('org_id'),
        'org_id': row.get('org_id'),
    }

def _client_attendance_rows(
    org_id: str,
    *,
    branch_id: object = None,
    date_value: str | None = None,
    start: str | None = None,
    end: str | None = None,
    today_only: bool = True,
    limit: int = 500,
    people_type: str | None = None,
    scope_ids: frozenset | None = None,
) -> list[dict]:
    """Read Supabase attendance rows for Client Dashboard screens."""
    from support_db_branches import list_branches
    from support_db_organizations import get_organization
    from support_db_staff import _normalize_people_type
    if scope_ids is not None and not scope_ids:
        return []

    sb = get_supabase()
    org_id = str(org_id)
    get_organization(org_id)
    branches = list_branches(org_id)
    branch_by_id = {str(branch.get('id')): branch for branch in branches if branch.get('id')}
    branch_ui_by_id = {str(branch.get('id')): idx for idx, branch in enumerate(branches, start=1) if branch.get('id')}
    backend_branch_id = _resolve_attendance_branch_id(branch_id, branches)

    safe_limit = max(1, min(int(limit or 500), 2000))

    log_date = None
    start_iso = None
    end_iso = None
    if today_only:
        log_date, start_iso, end_iso = _dashboard_day_window_utc(date_value)
    else:
        start_iso = _dashboard_range_bound_utc(start, is_end=False)
        end_iso = _dashboard_range_bound_utc(end, is_end=True)

    def _attendance_query():
        query = (
            get_supabase()
            .table('attendance')
            .select('*')
            .eq('org_id', org_id)
            .order('timestamp', desc=True)
            .limit(safe_limit)
        )
        if backend_branch_id:
            query = query.eq('branch_id', backend_branch_id)
        if start_iso and end_iso:
            query = query.gte('timestamp', start_iso).lt('timestamp', end_iso)
        elif start_iso:
            query = query.gte('timestamp', start_iso)
        elif end_iso:
            query = query.lt('timestamp', end_iso)
        if scope_ids is not None:
            query = query.in_('staff_id', list(scope_ids))
        return query

    result = _execute_supabase('client_attendance_rows', _attendance_query)
    rows = result.data or []
    if not rows:
        return []

    staff_ids = sorted({str(row.get('staff_id') or '').strip() for row in rows if row.get('staff_id')})
    staff_by_id: dict[str, dict] = {}
    if staff_ids:
        staff_result = _execute_supabase(
            'client_attendance_staff_lookup',
            lambda: (
                get_supabase()
                .table('client_staff')
                .select('id, org_id, branch_id, employee_id, person_code, registration_number, person_code_label, name, email, department_name, role_name, position, role, people_type, status, is_archived')
                .eq('org_id', org_id)
                .in_('id', staff_ids)
            ),
        )
        staff_by_id = {str(staff.get('id')): staff for staff in (staff_result.data or [])}

    normalized_people_type = _normalize_people_type(people_type, '') if people_type else ''
    if normalized_people_type:
        rows = [
            row for row in rows
            if _normalize_people_type(
                staff_by_id.get(str(row.get('staff_id') or ''), {}).get('people_type')
                or staff_by_id.get(str(row.get('staff_id') or ''), {}).get('person_type')
                or staff_by_id.get(str(row.get('staff_id') or ''), {}).get('role')
                or '',
                '',
            ) == normalized_people_type
        ]

    mapped = [
        _attendance_row_for_dashboard(
            row,
            staff_by_id=staff_by_id,
            branch_by_id=branch_by_id,
            branch_ui_by_id=branch_ui_by_id,
        )
        for row in rows
    ]

    if log_date:
        for item in mapped:
            item['log_date'] = log_date
            item['logDate'] = log_date

    return mapped

def get_client_staff_attendance_history(
    org_id: str,
    staff_id: str,
    limit: int = 100,
) -> list[dict]:
    """
    Own-attendance history for the mobile self-service portal (client_staff).

    Staff-scoped counterpart to _client_attendance_rows (org/branch-scoped,
    used by Client Dashboard screens) — reads the SAME Supabase `attendance`
    table mark_client_staff_attendance() writes into. The mobile app
    previously called /get_attendance_by_name, which reads the disconnected
    legacy SQLite `db` module by user_name; a Supabase-tenant staff member's
    own just-marked attendance could never appear there — which is exactly
    why the home screen showed "Not Marked Yet" moments after a successful
    mark, and why the WiFi auto-mark timer kept re-submitting (it re-marks
    whenever _todayPresent reads false, which it always did).

    Shaped to the flat {date, time, outTime, workDuration, status} keys
    office_home_screen.dart already parses, rather than the nested
    check_in/check_out shape _attendance_row_for_dashboard returns for the
    React dashboard — one mapping surface per consumer, not a shared shape
    stretched to fit both.
    """
    org_id = str(org_id)
    staff_id = str(staff_id)
    safe_limit = max(1, min(int(limit or 100), 500))

    def _query():
        return (
            get_supabase()
            .table('attendance')
            .select(
                'id, timestamp, check_out_timestamp, day_status, capture_channel, '
                'status, check_out_status, notes, check_in_hold_reason, '
                'check_out_hold_reason, branch_id'
            )
            .eq('org_id', org_id)
            .eq('staff_id', staff_id)
            .order('timestamp', desc=True)
            .limit(safe_limit)
        )

    result = _execute_supabase('client_staff_attendance_history', _query)
    rows = result.data or []

    # Resolve each distinct branch's timezone once up front rather than
    # per-row -- a staff member's history normally sits in one branch, but
    # nothing here assumes that, so this stays correct (and still cheap)
    # if it doesn't. Falls back to UTC for a row with no branch_id, same
    # as _resolve_client_staff_attendance_window's own fallback elsewhere
    # in this file.
    sb = get_supabase()
    branch_ids = {str(r['branch_id']) for r in rows if r.get('branch_id')}
    branch_zones = {
        bid: _get_branch_timezone(sb, org_id, bid) for bid in branch_ids
    }

    history = []
    for row in rows:
        ts = str(row.get('timestamp') or '')
        check_out_ts = row.get('check_out_timestamp')
        check_out_str = str(check_out_ts) if check_out_ts else ''
        day_status = row.get('day_status') or 'present'
        hold_reason = row.get('check_in_hold_reason') or row.get('check_out_hold_reason')

        duration_minutes, work_duration = _attendance_exceptions.compute_duration(
            row.get('timestamp'), row.get('check_out_timestamp')
        )

        # Pending Review outranks Half Day/Present in the status label —
        # an admin hasn't decided the day outcome yet, so showing "Present"
        # or "Half Day" here would be presenting a still-open exception as
        # already resolved.
        status_label = (
            'Pending Review' if hold_reason
            else 'Half Day' if day_status == 'half_day'
            else 'Overtime' if day_status == 'overtime'
            else 'Present'
        )

        zone = branch_zones.get(str(row.get('branch_id') or ''), ZoneInfo('UTC'))

        history.append({
            'id': row.get('id'),
            # Branch-local calendar date -- previously a raw slice of the
            # UTC 'timestamp' string, so a mark made within a few hours of
            # local midnight in a non-UTC branch could land on the "wrong"
            # date. local_date_str_iso already existed for exactly this
            # (see its docstring) but was never wired in here.
            'date': _attendance_exceptions.local_date_str_iso(ts, zone) if ts else '',
            # Branch-local HH:MM, not the raw UTC string sliced verbatim --
            # that was the actual cause of the mobile app showing a time
            # hours off from what the person actually experienced (5h off
            # for a UTC+5 branch). local_time_str_iso already existed for
            # this too (see support_db_attendance_exceptions.py) but,
            # again, was never called from this function.
            'time': _attendance_exceptions.local_time_str_iso(ts, zone) if ts else '',
            'outTime': _attendance_exceptions.local_time_str_iso(check_out_str, zone) if check_out_str else '',
            'workDuration': 'Half Day' if day_status == 'half_day' else work_duration,
            'durationMinutes': duration_minutes,
            'status': status_label,
            'checkInStatus': row.get('status'),
            'checkOutStatus': row.get('check_out_status'),
            'notes': row.get('notes'),
            'pendingReview': bool(hold_reason),
            'holdReason': hold_reason,
            'captureChannel': row.get('capture_channel'),
        })

    return history

def get_client_attendance_today(
    org_id: str, branch_id: object = None, date_value: str | None = None,
    start: str | None = None, end: str | None = None,
    limit: int = 500, people_type: str | None = None,
    scope_ids: frozenset | None = None,
) -> list[dict]:
    if start is not None or end is not None:
        return _client_attendance_rows(
            org_id,
            branch_id=branch_id,
            start=start,
            end=end,
            today_only=False,
            limit=limit,
            people_type=people_type,
            scope_ids=scope_ids,
        )
    return _client_attendance_rows(
        org_id, branch_id=branch_id, date_value=date_value,
        today_only=True, limit=limit, people_type=people_type,
        scope_ids=scope_ids,
    )

def get_client_attendance_logs(
    org_id: str, branch_id: object = None, limit: int = 100,
    people_type: str | None = None, scope_ids: frozenset | None = None,
) -> list[dict]:
    return _client_attendance_rows(
        org_id, branch_id=branch_id, today_only=False, limit=limit,
        people_type=people_type, scope_ids=scope_ids,
    )

def get_client_attendance_statistics(
    org_id: str,
    branch_id: object = None,
    date_value: str | None = None,
    people_type: str | None = None,
    scope_ids: frozenset | None = None,
) -> dict:
    """Supabase-backed attendance stats for Support-created UUID organizations.

    scope_ids follows the same convention as get_client_attendance_today /
    get_client_attendance_logs in this file — None means unscoped (org
    admin), a set means the caller is a team-scoped manager and both the
    staff roster and today's attendance must be narrowed to their reports
    before any count is computed, or a manager would see their whole
    org's totals under "my team" stats.
    """
    from support_db_branches import list_branches
    from support_db_nodes import _iso_now
    from support_db_staff import list_client_staff
    from client_dashboard_auth import filter_rows_by_scope
    org_id = str(org_id)
    branches = list_branches(org_id)
    backend_branch_id = _resolve_attendance_branch_id(branch_id, branches)

    staff_rows = list_client_staff(
        org_id,
        branch_id=backend_branch_id if backend_branch_id else None,
        role='staff',
        people_type=people_type,
        archived=False,
    )
    staff_rows = filter_rows_by_scope(staff_rows, scope_ids, 'id', 'staff_id')
    attendance_rows = get_client_attendance_today(
        org_id,
        branch_id=backend_branch_id if backend_branch_id else None,
        date_value=date_value,
        limit=2000,
        people_type=people_type,
        scope_ids=scope_ids,
    )
    unique_staff_today = {str(row.get('staff_id') or row.get('staffId') or '') for row in attendance_rows}
    unique_staff_today.discard('')
    total_staff = len(staff_rows)
    present_today = len(unique_staff_today)

    return {
        'total_users': total_staff,
        'attendance_users': total_staff,
        'total_staff': total_staff,
        'enrolled_users': sum(1 for row in staff_rows if row.get('is_face_verified')),
        'today_count': len(attendance_rows),
        'today_attendance': len(attendance_rows),
        'unique_users_today': present_today,
        'present_today': present_today,
        'absent_today': max(0, total_staff - present_today),
        'avg_confidence': (
            sum(float(row.get('confidence') or 0) for row in attendance_rows) / len(attendance_rows)
            if attendance_rows else 0
        ),
        'recent_entries': attendance_rows[:10],
        'timestamp': _iso_now(),
    }

def mark_client_staff_absent_today(
    org_id: str,
    staff_id: str,
    branch_id: object = None,
    people_type: str | None = None,
    date_value: str | None = None,
) -> dict:
    """Remove today's attendance rows for one tenant-owned person.

    This is the UUID/Supabase counterpart of the legacy SQLite absent action.
    It validates organization ownership and optional people_type before deleting
    attendance, so student/staff/worker attendance cannot cross tenant scope.
    """
    from support_db_branches import list_branches
    from support_db_staff import _normalize_people_type, get_client_staff_member
    org_key = str(org_id)
    staff_key = str(staff_id)
    if not org_key:
        raise ValueError('organization_id is required')
    if not staff_key:
        raise ValueError('staff_id is required')

    staff = get_client_staff_member(staff_key)
    if str(staff.get('organization_id') or '') != org_key:
        raise ValueError('Person does not belong to this organization')

    normalized_people_type = _normalize_people_type(people_type, '') if people_type else ''
    if normalized_people_type:
        staff_people_type = _normalize_people_type(
            staff.get('people_type') or staff.get('peopleType') or staff.get('person_type') or staff.get('personType') or 'staff',
            '',
        )
        if staff_people_type != normalized_people_type:
            raise ValueError('Person does not belong to the requested attendance scope')

    branches = list_branches(org_key)
    backend_branch_id = _resolve_attendance_branch_id(branch_id, branches) if branch_id not in (None, '') else None
    if backend_branch_id and str(staff.get('backend_branch_id') or '') != str(backend_branch_id):
        raise ValueError('Person does not belong to the requested branch')

    _log_date, start_iso, end_iso = _dashboard_day_window_utc(date_value)
    query = (
        get_supabase()
        .table('attendance')
        .delete()
        .eq('org_id', org_key)
        .eq('staff_id', staff_key)
        .gte('timestamp', start_iso)
        .lt('timestamp', end_iso)
    )
    if backend_branch_id:
        query = query.eq('branch_id', str(backend_branch_id))

    result = query.execute()
    return {
        'success': True,
        'staff_id': staff_key,
        'organization_id': org_key,
        'branch_id': backend_branch_id,
        'deleted_count': len(result.data or []),
    }

_EDITABLE_ATTENDANCE_STATUS_VALUES = {'on_time', 'late', 'early', 'unscheduled'}

def update_client_attendance_record(org_id: str, record_id: str, payload: dict) -> dict:
    """Admin edit of one attendance row from the Client Dashboard.

    Lets an operator correct check-in, check-out, arrival (timing)
    classification, and notes by hand -- e.g. a camera miss or a staff
    member who forgot their card, but there's a genuine record to fix.
    This is a direct field-level edit, not a resolve/hold workflow, so it
    intentionally does not touch check_in_hold_reason / check_out_hold_reason
    -- an operator editing values here is providing the correct data
    themselves, there's nothing left to "hold for review".

    Body fields (all optional, only supplied ones are changed):
      - check_in / checkIn / timestamp:      ISO datetime string
      - check_out / checkOut / check_out_timestamp: ISO datetime string,
        or "" / null to clear a checkout (e.g. correcting a mistaken one)
      - arrival_status / arrivalStatus / check_in_status / status:
        one of 'on_time' | 'late' | 'early' | 'unscheduled'
      - notes: free text, or "" / null to clear

    Returns the same shape as the other dashboard attendance reads
    (_attendance_row_for_dashboard), so the caller can drop the response
    straight into the row it just edited without a second fetch.
    """
    from support_db_branches import list_branches
    from support_db_nodes import _parse_dt
    from support_db_staff import get_client_staff_member
    org_key = str(org_id or '').strip()
    row_key = str(record_id or '').strip()
    if not org_key:
        raise ValueError('organization_id is required')
    if not row_key:
        raise ValueError('record id is required')

    sb = get_supabase()
    existing = (
        sb.table('attendance')
        .select('*')
        .eq('id', row_key)
        .eq('org_id', org_key)
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise ValueError('Attendance record not found')

    updates: dict = {}

    if any(key in payload for key in ('check_in', 'checkIn', 'timestamp')):
        raw_check_in = payload.get('check_in', payload.get('checkIn', payload.get('timestamp')))
        parsed = _parse_dt(raw_check_in)
        if raw_check_in and not parsed:
            raise ValueError('check_in must be a valid ISO datetime')
        if parsed:
            updates['timestamp'] = parsed.astimezone(timezone.utc).isoformat()

    if any(key in payload for key in ('check_out', 'checkOut', 'check_out_timestamp')):
        raw_check_out = payload.get(
            'check_out', payload.get('checkOut', payload.get('check_out_timestamp')),
        )
        if raw_check_out in (None, ''):
            # Explicit clear -- e.g. undoing a mistaken checkout.
            updates['check_out_timestamp'] = None
        else:
            parsed = _parse_dt(raw_check_out)
            if not parsed:
                raise ValueError('check_out must be a valid ISO datetime')
            updates['check_out_timestamp'] = parsed.astimezone(timezone.utc).isoformat()

    if any(
        key in payload
        for key in ('arrival_status', 'arrivalStatus', 'check_in_status', 'checkInStatus', 'status')
    ):
        raw_status = str(
            payload.get(
                'arrival_status',
                payload.get(
                    'arrivalStatus',
                    payload.get('check_in_status', payload.get('checkInStatus', payload.get('status'))),
                ),
            )
            or ''
        ).strip().lower()
        if raw_status and raw_status not in _EDITABLE_ATTENDANCE_STATUS_VALUES:
            raise ValueError(
                f"status must be one of {sorted(_EDITABLE_ATTENDANCE_STATUS_VALUES)}",
            )
        updates['status'] = raw_status or 'unscheduled'

    if 'notes' in payload:
        notes = payload.get('notes')
        updates['notes'] = str(notes).strip() if notes else None

    if not updates:
        raise ValueError('No editable fields were provided')

    (
        sb.table('attendance')
        .update(updates)
        .eq('id', row_key)
        .eq('org_id', org_key)
        .execute()
    )

    refreshed = (
        sb.table('attendance')
        .select('*')
        .eq('id', row_key)
        .eq('org_id', org_key)
        .limit(1)
        .execute()
    )
    row = (refreshed.data or existing.data)[0]

    staff_id = str(row.get('staff_id') or '').strip()
    staff = get_client_staff_member(staff_id) if staff_id else {}
    branches = list_branches(org_key)
    branch_by_id = {str(b.get('id')): b for b in branches if b.get('id')}
    branch_ui_by_id = {str(b.get('id')): idx for idx, b in enumerate(branches, start=1) if b.get('id')}

    return _attendance_row_for_dashboard(
        row,
        staff_by_id={staff_id: staff} if staff_id else {},
        branch_by_id=branch_by_id,
        branch_ui_by_id=branch_ui_by_id,
    )

def complete_face_training_job_from_dashboard(job_id: str, payload: dict) -> dict:
    """Complete a training job from the Flask Client Dashboard route.

    This is used for demo/cloud synchronous training where Flask processes the
    video before the staff member is returned to the UI. It applies the same
    server-side validation as the Local Node route: staff is never marked
    trained unless real embedding vectors are submitted.
    """
    from support_db_nodes import _iso_now, _replace_face_embeddings_cloud, _valid_embedding_list
    from support_db_organizations import get_organization
    from support_db_staff import update_client_staff
    sb = get_supabase()
    requested_status = str(payload.get('status') or 'trained').lower()
    if requested_status not in ('trained', 'failed'):
        raise ValueError('status must be trained or failed')

    job_result = (
        sb.table('face_training_jobs')
        .select('*')
        .eq('id', str(job_id))
        .limit(1)
        .execute()
    )
    if not job_result.data:
        raise ValueError('Training job not found')

    job = job_result.data[0]
    staff_id = str(job.get('client_staff_id') or job.get('staff_id') or '')
    if not staff_id:
        raise ValueError('Training job is missing staff id')

    now = _iso_now()
    min_embeddings = 10
    try:
        min_embeddings = max(1, int(payload.get('min_embedding_count') or min_embeddings))
    except (TypeError, ValueError):
        min_embeddings = 10

    valid_embeddings = _valid_embedding_list(payload.get('embeddings') or [])
    embedding_count = len(valid_embeddings)
    status = requested_status
    error_message = None

    if requested_status == 'trained' and embedding_count < min_embeddings:
        status = 'failed'
        error_message = (
            f'Training rejected by server: only {embedding_count} valid embeddings were extracted; '
            f'at least {min_embeddings} are required.'
        )

    if status == 'trained':
        org_id = str(job.get('org_id'))
        branch_id = str(job.get('branch_id') or '') or None
        org = get_organization(org_id)
        is_fallback = str(org.get('attendance_mode') or '').lower() == 'local'

        _replace_face_embeddings_cloud(
            org_id=org_id,                # ✅ use the local org_id, not node['org_id']
            staff_id=staff_id,
            embeddings=valid_embeddings,
            is_fallback_copy=is_fallback,
            source_job_id=str(job_id),
        )

        update_client_staff(staff_id, {
            'face_training_status': 'trained',
            'is_face_verified': True,
        })
    else:
        if error_message is None:
            error_message = str(payload.get('error_message') or 'Training failed')
        update_client_staff(staff_id, {
            'face_training_status': 'failed',
            'is_face_verified': False,
        })

    update_payload = {
        'status': status,
        'error_message': error_message,
        'processed_at': now,
        'updated_at': now,
        'embedding_count': embedding_count,
    }

    for key in ('training_duration_seconds', 'total_frames_processed', 'avg_quality'):
        if key in payload:
            update_payload[key] = payload.get(key)

    updated = sb.table('face_training_jobs').update(update_payload).eq('id', str(job_id)).execute()
    if not updated.data:
        raise RuntimeError('Failed to update training job')

    return updated.data[0]

def _support_clean_text(value: object) -> str:
    return str(value or '').strip()

def _resolve_owned_backend_branch_id(org_id: str, raw_branch_id: object = None) -> str | None:
    from support_db_staff import _resolve_client_branch
    raw = _support_clean_text(raw_branch_id)
    if not raw:
        return None
    branch, _ = _resolve_client_branch(str(org_id), raw)
    return str(branch['id'])

def list_client_cameras(org_id: str, branch_id: object = None) -> list[dict]:
    """Return client CCTV cameras from branch_cameras — the single source of
    truth get_node_config() also reads. Never read cameras back out of
    client_onboarding_configs.cameras: that JSONB blob is onboarding *input*
    only, mirrored into branch_cameras by _sync_local_node_camera_config, and
    can silently go stale after a client edits cameras post-onboarding."""
    from support_db_branches import list_branches
    from support_db_client_users import _branch_maps
    branches = list_branches(str(org_id))
    backend_to_ui, _ui_to_backend = _branch_maps(branches)
    branch_name_by_id = {str(b.get('id')): b.get('name') for b in branches}
    selected_backend = _resolve_owned_backend_branch_id(str(org_id), branch_id) if _support_clean_text(branch_id) else None

    sb = get_supabase()
    query = sb.table('branch_cameras').select('*').eq('organization_id', str(org_id))
    if selected_backend:
        query = query.eq('branch_id', selected_backend)
    result = _execute_supabase('list_client_cameras', lambda: query.order('channel'))

    rows = []
    for camera in result.data or []:
        backend_branch_id = str(camera.get('branch_id') or '')
        ui_id = backend_to_ui.get(backend_branch_id)
        camera_id = str(camera.get('id'))
        name = camera.get('camera_name') or 'Camera'
        rtsp_url = camera.get('rtsp_url') or ''
        rows.append({
            **camera,
            'id': camera_id,
            'camera_id': camera_id,
            'name': name,
            'camera_name': name,
            'type': camera.get('camera_type') or 'nvr',
            'camera_type': camera.get('camera_type') or 'nvr',
            'organization_id': str(org_id),
            'org_id': str(org_id),
            'branch_id': backend_branch_id,
            'backend_branch_id': backend_branch_id,
            'branchId': ui_id,
            'branchName': branch_name_by_id.get(backend_branch_id),
            'branch_name': branch_name_by_id.get(backend_branch_id),
            'rtsp_url': rtsp_url,
            'rtspUrl': rtsp_url,
        })
    return rows

def get_client_camera_by_id(org_id: str, camera_id: str) -> dict | None:
    from support_db_branches import list_branches
    from support_db_client_users import _branch_maps
    camera_key = _support_clean_text(camera_id)
    if not camera_key:
        return None

    # branch_cameras.id is a uuid column. A non-UUID camera_id (e.g. the
    # 'cam_1784143596732_j3yb5v' / 'camera-<branch>-<n>' style ids that
    # client_onboarding_configs.cameras JSONB allows) makes Postgres reject
    # the query outright with 22P02 'invalid input syntax for type uuid',
    # which surfaced as an unhandled APIError and a 500 from
    # /api/stream/token. Treat an id that cannot possibly match as simply
    # "no such camera" — the caller (api_mint_stream_token) already turns
    # None into a clean 404, which is also the correct answer for a caller
    # asking about a camera that isn't theirs. Do NOT let this become a way
    # to distinguish "malformed id" from "someone else's camera": both must
    # look identical from outside.
    try:
        uuid.UUID(camera_key)
    except (ValueError, AttributeError, TypeError):
        logger.info(
            'Camera lookup rejected a non-UUID camera_id for org %s (not a valid '
            'branch_cameras.id); treating as not found', org_id,
        )
        return None

    result = _execute_supabase(
        'get_client_camera_by_id',
        lambda: (
            get_supabase()
            .table('branch_cameras')
            .select('*')
            .eq('organization_id', str(org_id))
            .eq('id', camera_key)
            .limit(1)
        ),
    )
    if not result.data:
        return None

    branches = list_branches(str(org_id))
    backend_to_ui, _ui_to_backend = _branch_maps(branches)
    branch_name_by_id = {str(b.get('id')): b.get('name') for b in branches}

    camera = result.data[0]
    backend_branch_id = str(camera.get('branch_id') or '')
    name = camera.get('camera_name') or 'Camera'
    rtsp_url = camera.get('rtsp_url') or ''
    return {
        **camera,
        'id': camera_key,
        'camera_id': camera_key,
        'name': name,
        'camera_name': name,
        'type': camera.get('camera_type') or 'nvr',
        'camera_type': camera.get('camera_type') or 'nvr',
        'org_id': str(org_id),
        'organization_id': str(org_id),
        'branch_id': backend_branch_id,
        'backend_branch_id': backend_branch_id,
        'branchId': backend_to_ui.get(backend_branch_id),
        'branchName': branch_name_by_id.get(backend_branch_id),
        'rtsp_url': rtsp_url,
        'rtspUrl': rtsp_url,
    }

def _client_staff_lookup(org_id: str, staff_ids: list[str]) -> dict[str, dict]:
    from support_db_staff import _client_staff_safe, _resolve_shift_map
    if not staff_ids:
        return {}
    result = _execute_supabase(
        'client_staff_lookup',
        lambda: (
            get_supabase()
            .table('client_staff')
            .select('*')
            .eq('org_id', str(org_id))
            .in_('id', staff_ids)
        ),
    )
    rows = result.data or []
    shifts_by_id = _resolve_shift_map(org_id, {r.get('shift_id_ref') for r in rows})
    return {
        str(row.get('id')): _client_staff_safe(row, str(org_id), shifts_by_id=shifts_by_id)
        for row in rows
    }

def _resolve_staff_people_type(staff: dict | None) -> str:
    """
    Single source of truth for "what people_type is this staff record".
    Used by both list_client_leave_requests' people_type filter AND
    _map_client_leave's returned row, so the value the backend filters on
    and the value the client actually receives can never drift apart again.
    """
    from support_db_staff import _normalize_people_type
    staff = staff or {}
    return _normalize_people_type(
        staff.get('people_type') or staff.get('person_type') or staff.get('role') or 'staff',
        'staff',
    )

def _map_client_leave(row: dict, staff_by_id: dict[str, dict] | None = None) -> dict:
    staff_by_id = staff_by_id or {}
    staff_id = _support_clean_text(row.get('staff_id') or row.get('user_id') or row.get('client_staff_id'))
    staff = staff_by_id.get(staff_id, {})
    branch_id = _support_clean_text(row.get('branch_id') or staff.get('backend_branch_id'))
    start_date = row.get('start_date') or row.get('startDate') or ''
    end_date = row.get('end_date') or row.get('endDate') or start_date
    days = row.get('days')
    if days in (None, ''):
        try:
            days = max(1, (date.fromisoformat(str(end_date)) - date.fromisoformat(str(start_date))).days + 1)
        except Exception:
            days = 1
    name = row.get('user_name') or row.get('staff_name') or staff.get('name') or 'Unknown'
    branch_name = row.get('branch_name') or staff.get('branch_name') or ''
    department = row.get('department') or staff.get('department') or ''
    leave_type = row.get('leave_type') or row.get('type') or 'annual'
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
        'name': name,
        'user_name': name,
        'userName': name,
        'staff_name': name,
        'staffName': name,
        'branch_id': branch_id,
        'branchId': branch_id,
        'backend_branch_id': branch_id,
        'backendBranchId': branch_id,
        'branch_name': branch_name,
        'branchName': branch_name,
        'department': department,
        'dept': department,
        'people_type': people_type,
        'peopleType': people_type,
        'leave_type': leave_type,
        'type': leave_type,
        'half_day_period': row.get('half_day_period'),
        'halfDayPeriod': row.get('half_day_period'),
        'half_day_start_time': row.get('half_day_start_time'),
        'halfDayStartTime': row.get('half_day_start_time'),
        'half_day_end_time': row.get('half_day_end_time'),
        'halfDayEndTime': row.get('half_day_end_time'),
        'start_date': start_date,
        'startDate': start_date,
        'end_date': end_date,
        'endDate': end_date,
        'days': int(days or 1),
        'reason': row.get('reason') or '',
        'status': row.get('status') or 'pending',
        'approved_by': row.get('approved_by'),
        'approvedBy': row.get('approved_by'),
        'created_at': row.get('created_at'),
        'createdAt': row.get('created_at'),
        'updated_at': row.get('updated_at'),
        'updatedAt': row.get('updated_at'),
    }

def list_client_leave_requests(
    org_id: str, branch_id: object = None, user_id: object = None,
    status: str | None = None, people_type: str | None = None,
    scope_ids: frozenset | None = None,
) -> list[dict]:
    from support_db_organizations import get_organization
    from support_db_staff import _normalize_people_type
    org_key = str(org_id)
    get_organization(org_key)
    if scope_ids is not None and not scope_ids:
        return []

    branch_backend = _resolve_owned_backend_branch_id(org_key, branch_id) if _support_clean_text(branch_id) else None
    user_key = _support_clean_text(user_id)
    clean_status = str(status).lower() if status else ''
    clean_people_type = _normalize_people_type(people_type, 'staff') if people_type else None

    try:
        def _leave_query():
            query = get_supabase().table('leave_requests').select('*').eq('org_id', org_key)
            if branch_backend:
                query = query.eq('branch_id', branch_backend)
            if user_key:
                query = query.eq('staff_id', user_key)
            if clean_status:
                query = query.eq('status', clean_status)
            if scope_ids is not None:
                query = query.in_('staff_id', list(scope_ids))
            return query.order('created_at', desc=True)
        result = _execute_supabase('list_client_leave_requests', _leave_query)
    except Exception as exc:
        if _table_missing(exc, 'leave_requests'):
            logger.warning('leave_requests table is missing; returning empty tenant-scoped leave list')
            return []
        raise

    rows = result.data or []
    staff_ids = sorted({_support_clean_text(row.get('staff_id') or row.get('user_id')) for row in rows if _support_clean_text(row.get('staff_id') or row.get('user_id'))})
    staff_by_id = _client_staff_lookup(org_key, staff_ids)

    if clean_people_type:
        filtered_rows = []
        for row in rows:
            staff_id = _support_clean_text(row.get('staff_id') or row.get('user_id'))
            staff = staff_by_id.get(staff_id, {})
            if _resolve_staff_people_type(staff) == clean_people_type:
                filtered_rows.append(row)
        rows = filtered_rows

    leave_type_rules: dict[str, str] = {}
    try:
        from support_db_payroll import get_payroll_policy
        policy = get_payroll_policy(org_key)
        raw_rules = policy.get('leaveTypeRules') if isinstance(policy, dict) else {}
        if isinstance(raw_rules, dict):
            leave_type_rules = {
                str(k).strip().lower(): str(v).strip().lower()
                for k, v in raw_rules.items()
                if str(k).strip() and str(v).strip().lower() in {'paid', 'unpaid'}
            }
    except Exception:
        leave_type_rules = {}

    attendance_ref_re = re.compile(r'attendance_id=([0-9a-f-]{8,})', re.IGNORECASE)
    linked_attendance_ids: set[str] = set()
    for row in rows:
        reason_text = str(row.get('reason') or '')
        match = attendance_ref_re.search(reason_text)
        if match:
            linked_attendance_ids.add(match.group(1))

    payroll_decision_by_attendance: dict[str, str] = {}
    if linked_attendance_ids:
        try:
            attendance_result = _execute_supabase(
                'list_client_leave_requests.attendance_payroll_decisions',
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

    mapped_rows: list[dict] = []
    for row in rows:
        mapped = _map_client_leave(row, staff_by_id)
        leave_type = _support_clean_text(mapped.get('leave_type') or mapped.get('type')).lower()

        reason_text = str(row.get('reason') or '')
        match = attendance_ref_re.search(reason_text)
        attendance_id = match.group(1) if match else ''
        payroll_decision = payroll_decision_by_attendance.get(attendance_id, '') if attendance_id else ''
        is_attendance_adjustment = attendance_id != '' or leave_type == 'attendance_adjustment'

        if payroll_decision == 'exclude':
            leave_compensation = 'excluded'
        elif payroll_decision == 'include':
            leave_compensation = 'unpaid'
        elif is_attendance_adjustment:
            # Attendance-adjusted leave rows are payroll-linked exceptions.
            # With no explicit exclude decision, payroll includes them.
            leave_compensation = 'unpaid'
        else:
            leave_compensation = leave_type_rules.get(leave_type, 'not_configured')

        mapped['leave_compensation'] = leave_compensation
        mapped['leaveCompensation'] = leave_compensation
        mapped['leave_payroll_decision'] = payroll_decision or None
        mapped['leavePayrollDecision'] = payroll_decision or None
        mapped_rows.append(mapped)

    return mapped_rows