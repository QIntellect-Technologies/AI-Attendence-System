# """
# support_db_attendance_mobile.py
# ───────────────────────────────────────────────────────────────────────────────
# Mobile self-service attendance for client_staff (office check-in/out and
# field geofenced attendance).

# Split out of the original monolithic support_db.py. See support_db.py for
# the backward-compatible facade that re-exports everything below.
# """

# from datetime import date, timedelta, datetime, timezone
# import json
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
# from support_invite_message import build_client_invite_message
# from support_db_attendance_gate import (
#     resolve_timing_source,
#     resolve_manual_instruction_window,
#     resolve_branch_default_window,
#     resolve_staff_shift_windows,
#     resolve_check_in_status,
#     resolve_check_out_status,
#     _get_branch_timezone,
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

# def _resolve_client_staff_attendance_window(
#     org_id: str,
#     branch_id: str | None,
#     staff_id: str,
#     event_dt: 'datetime',
# ) -> tuple[dict, dict, 'ZoneInfo']:
#     """Shared staff-lookup + shift-window resolution used by both
#     mark_client_staff_attendance (write) and get_client_staff_attendance_today
#     (read) -- one place decides "which shift/capture rules apply to this
#     person right now," so the two can never resolve a different window for
#     the same person/moment. Raises ValueError for not-found/archived staff,
#     same contract every support_db_* function already uses.
#     """
#     sb = get_supabase()
#     org_key = str(org_id)
#     staff_key = str(staff_id)

#     staff_result = (
#         sb.table('client_staff')
#         .select(
#             'id, name, people_type, shift_id_ref, department_id, '
#             'check_in_grace_override, check_out_grace_override, '
#             'is_archived, status'
#         )
#         .eq('id', staff_key)
#         .eq('org_id', org_key)
#         .limit(1)
#         .execute()
#     )
#     if not staff_result.data:
#         raise ValueError('Staff member not found')
#     staff_row = staff_result.data[0]
#     if staff_row.get('is_archived') or str(staff_row.get('status') or 'active') == 'inactive':
#         raise ValueError('This account is archived or inactive.')
#     people_type = staff_row.get('people_type') or 'staff'

#     window = resolve_timing_source(
#         org_id=org_key,
#         branch_id=str(branch_id) if branch_id else None,
#         staff=staff_row,
#         people_type=people_type,
#         event_time_utc=event_dt,
#     )
#     branch_zone = _get_branch_timezone(sb, org_key, str(branch_id)) if branch_id else ZoneInfo('UTC')
#     return staff_row, window, branch_zone

# def get_client_staff_attendance_today(
#     org_id: str,
#     branch_id: str | None,
#     staff_id: str,
# ) -> dict:
#     """Read-only "where do I stand today" check for the mobile home screen.

#     Answers the one question the UI can't derive from history alone:
#     whether the resolved shift for THIS person, right now, allows a
#     checkout mark at all (capture_check_out) -- needed to decide whether to
#     show a Check Out button immediately after check-in, not just after the
#     app discovers it by attempting one. Shares its window resolution with
#     mark_client_staff_attendance via _resolve_client_staff_attendance_window
#     so the two never disagree about which shift applies.
#     """
#     from support_db_attendance_dashboard import _dashboard_day_window_utc
#     sb = get_supabase()
#     org_key = str(org_id)
#     staff_key = str(staff_id)
#     event_dt = datetime.now(timezone.utc)

#     _, window, _ = _resolve_client_staff_attendance_window(org_key, branch_id, staff_key, event_dt)

#     _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)
#     existing_result = (
#         sb.table('attendance')
#         .select(
#             'id, timestamp, check_out_timestamp, status, check_out_status, '
#             'notes, day_status, check_in_hold_reason, check_out_hold_reason, '
#             'check_in_confirmed'
#         )
#         .eq('org_id', org_key)
#         .eq('staff_id', staff_key)
#         .gte('timestamp', day_start_iso)
#         .lt('timestamp', day_end_iso)
#         .limit(1)
#         .execute()
#     )
#     existing = existing_result.data[0] if existing_result.data else None
#     duration_minutes, duration_label = _attendance_exceptions.compute_duration(
#         existing.get('timestamp') if existing else None,
#         existing.get('check_out_timestamp') if existing else None,
#     )

#     return {
#         'marked': existing is not None,
#         'checked_out': bool(existing and existing.get('check_out_timestamp')),
#         'capture_check_out': bool(window and window.get('capture_check_out')),
#         'time': str(existing.get('timestamp'))[11:16] if existing and existing.get('timestamp') else '',
#         'out_time': (
#             str(existing.get('check_out_timestamp'))[11:16]
#             if existing and existing.get('check_out_timestamp') else ''
#         ),
#         # Timing classification (early/on_time/late/overtime/unscheduled),
#         # separate from day_status (present/half_day/overtime).
#         'check_in_status': existing.get('status') if existing else None,
#         'check_out_status': existing.get('check_out_status') if existing else None,
#         'day_status': (existing.get('day_status') if existing else None) or 'present',
#         'notes': existing.get('notes') if existing else None,
#         # Non-null only while a late check-in / early-or-late checkout is
#         # still awaiting admin resolution — drives the app's "Pending
#         # Review" banner.
#         'check_in_hold_reason': existing.get('check_in_hold_reason') if existing else None,
#         'check_out_hold_reason': existing.get('check_out_hold_reason') if existing else None,
#         'check_in_confirmed': (
#             True if not existing or existing.get('check_in_confirmed') is None
#             else bool(existing.get('check_in_confirmed'))
#         ),
#         'duration_minutes': duration_minutes,
#         'duration_label': duration_label,
#     }

# def _check_action_replay(
#     existing: dict | None,
#     client_action_id: str | None,
#     *,
#     capture_check_out: bool,
# ) -> dict | None:
#     """Detects a retried CHECK-IN call arriving after its own response was
#     lost -- returns the check-in outcome again instead of letting it fall
#     through to the check-out branch, which would otherwise silently check
#     the person out on a retry they never intended as one.

#     Only the check-in half needs this. A retried CHECK-OUT call needs no
#     special handling: the existing `existing.get('check_out_timestamp')`
#     branch already returns the same "already_marked/checked_out" result
#     idempotently for any call once the row has a checkout timestamp,
#     client_action_id or not.

#     Returns None when there's nothing to replay (no existing row, no
#     client_action_id supplied, or the id doesn't match -- i.e. this really
#     is a new checkout attempt) so the caller falls through to its normal
#     insert-or-checkout logic unchanged.
#     """
#     if not existing or existing.get('check_out_timestamp') or not client_action_id:
#         return None
#     existing_metadata = existing.get('metadata') or {}
#     if existing_metadata.get('client_action_id') != client_action_id:
#         return None
#     return {
#         'already_marked': True,
#         'checked_out': False,
#         'attendance_id': existing['id'],
#         'capture_check_out': capture_check_out,
#         'replayed': True,
#     }

# def mark_client_staff_attendance(
#     org_id: str,
#     branch_id: str | None,
#     staff_id: str,
#     *,
#     ssid: str | None = None,
#     bssid: str | None = None,
#     wifi_verified: bool = False,
#     synced_after_offline: bool = False,
#     client_action_id: str | None = None,
# ) -> dict:
#     """Self-service check-in/check-out from the mobile app (office staff).

#     Mirrors record_cloud_camera_attendance's insert-or-update contract
#     exactly, so a mobile self-mark and a camera detection produce
#     identical check-in/check-out behavior for the same branch/people_type
#     timing rules -- one source of truth (attendance_capture_settings /
#     shifts / overrides), another capture method alongside 'camera' and
#     'camera_cloud'. The first mark of a UTC day is a check-in; a second
#     mark the same day is a check-out if the resolved window has
#     capture_check_out enabled, otherwise it's a no-op ('already_marked').

#     org_id/branch_id/staff_id must come from the caller's verified JWT
#     (g.client_staff in the route), never the request body -- see
#     require_client_staff_auth. A mobile client can never mark attendance
#     for another org/branch/staff member by editing the payload.

#     source is 'mobile_fallback' when this call is the delayed sync of a
#     mark the app cached locally after a failed real-time attempt (see
#     office_home_screen.dart's offline-cache path), otherwise
#     'mobile_office' for a normal real-time mark. Both are pre-approved
#     values on attendance.source's CHECK constraint alongside 'camera' /
#     'camera_cloud' / 'mobile_field' / 'mobile_cloud', so this needs no
#     migration and no forced-'camera' workaround the way
#     _node_attendance_metadata needs for the node's source values.

#     client_action_id is the offline queue's idempotency key
#     (OfflineQueueService.dart) -- stored in metadata and checked via
#     _check_action_replay so a dropped response never gets replayed as a
#     checkout. Optional: a live, never-queued call can omit it and this
#     behaves exactly as before.
#     """
#     from support_db_attendance_dashboard import _dashboard_day_window_utc
#     from support_db_nodes import _iso_now
#     sb = get_supabase()
#     org_key = str(org_id)
#     staff_key = str(staff_id)
#     source = 'mobile_fallback' if synced_after_offline else 'mobile_office'

#     event_dt = datetime.now(timezone.utc)
#     staff_row, window, branch_zone = _resolve_client_staff_attendance_window(
#         org_key, branch_id, staff_key, event_dt,
#     )
#     people_type = staff_row.get('people_type') or 'staff'

#     _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)
#     existing_result = (
#         sb.table('attendance')
#         .select('id, check_out_timestamp, notes, metadata')
#         .eq('org_id', org_key)
#         .eq('staff_id', staff_key)
#         .gte('timestamp', day_start_iso)
#         .lt('timestamp', day_end_iso)
#         .limit(1)
#         .execute()
#     )
#     existing = existing_result.data[0] if existing_result.data else None

#     replay = _check_action_replay(
#         existing, client_action_id,
#         capture_check_out=bool(window and window.get('capture_check_out')),
#     )
#     if replay is not None:
#         return replay

#     now = _iso_now()
#     metadata = {
#         'ssid': ssid,
#         'bssid': bssid,
#         'wifi_verified': bool(wifi_verified),
#         'client_action_id': client_action_id,
#     }

#     if not existing:
#         status = resolve_check_in_status(window, event_dt, branch_zone)
#         row = {
#             'org_id': org_key,
#             'branch_id': str(branch_id) if branch_id else None,
#             'staff_id': staff_key,
#             'timestamp': now,
#             'status': status,
#             'source': source,
#             'capture_channel': 'mobile_app',
#             'confidence': 1.0,
#             'metadata': metadata,
#         }
#         row.update(_attendance_exceptions.check_in_write_fields(status))
#         try:
#             result = sb.table('attendance').insert(row).execute()
#         except Exception as exc:
#             # Unwrapped before this fix -- a PostgREST rejection (NOT NULL /
#             # CHECK / unique-constraint violation, etc.) surfaced only as
#             # httpx's bare "400 Bad Request" status line, with the actual
#             # reason (exc's message/details/hint from Supabase's JSON error
#             # body) silently discarded, and the route turning it into an
#             # undiagnosable generic 500. Log the real reason server-side
#             # (safe -- may contain schema/column detail) and re-raise as
#             # RuntimeError, matching the "no data returned" case right
#             # below and this module's existing error-handling contract
#             # (client_routes_helpers.handle: RuntimeError -> 500 with a
#             # clean message, nothing internal leaked to the client).
#             logger.error(
#                 'mark_client_staff_attendance insert failed for org=%s staff=%s row=%s: %s',
#                 org_key, staff_key, row, exc,
#             )
#             raise RuntimeError('Failed to record attendance') from exc
#         if not result.data:
#             raise RuntimeError('Failed to record attendance')
#         new_id = result.data[0].get('id')
#         if status == 'late':
#             _attendance_exceptions.notify_check_in_exception(
#                 org_id=org_key, branch_id=branch_id, staff_id=staff_key,
#                 staff_name=staff_row.get('name') or 'Staff member',
#                 attendance_id=new_id,
#                 event_local_str=_attendance_exceptions.local_time_str(event_dt, branch_zone),
#             )
#         return {
#             'already_marked': False,
#             'checked_out': False,
#             'attendance_id': new_id,
#             'marked_at': now,
#             'status': status,
#             'notes': row.get('notes'),
#             'pending_review': status == 'late',
#             'source': source,
#             'capture_check_out': bool(window and window.get('capture_check_out')),
#         }

#     if existing.get('check_out_timestamp'):
#         return {
#             'already_marked': True,
#             'checked_out': True,
#             'attendance_id': existing.get('id'),
#             'capture_check_out': bool(window and window.get('capture_check_out')),
#         }

#     if not (window and window.get('capture_check_out')):
#         return {
#             'already_marked': True,
#             'checked_out': False,
#             'attendance_id': existing.get('id'),
#             'capture_check_out': False,
#         }

#     # Mobile self-service checkouts never consult _find_approved_overtime —
#     # unlike local-node captures, both the late/overtime classification AND
#     # the payroll include/exclude decision belong to the admin, made in the
#     # notifications/exceptions page. Silently classifying straight to
#     # 'overtime' here would skip check_out_hold_reason and the notification
#     # entirely (see notify_check_out_exception below), which is exactly the
#     # bug this guards against: a prior admin-approved overtime_requests row
#     # for today would otherwise auto-classify *today's* checkout too.
#     check_out_status = resolve_check_out_status(window, event_dt, branch_zone)
#     checkout_fields = _attendance_exceptions.check_out_write_fields(check_out_status, existing.get('notes'))
#     update_payload = {
#         'check_out_timestamp': now,
#         'check_out_status': check_out_status,
#         'check_out_confidence': 1.0,
#         'check_out_metadata': metadata,
#     }
#     update_payload.update(checkout_fields)
#     try:
#         update_result = (
#             sb.table('attendance')
#             .update(update_payload)
#             .eq('id', existing['id'])
#             .execute()
#         )
#     except Exception as exc:
#         logger.error(
#             'mark_client_staff_attendance checkout update failed for org=%s staff=%s '
#             'attendance_id=%s payload=%s: %s',
#             org_key, staff_key, existing['id'], update_payload, exc,
#         )
#         raise RuntimeError('Failed to record checkout') from exc
#     if not update_result.data:
#         raise RuntimeError('Failed to record checkout')

#     if check_out_status in ('early', 'late'):
#         _attendance_exceptions.notify_check_out_exception(
#             org_id=org_key, branch_id=branch_id, staff_id=staff_key,
#             staff_name=staff_row.get('name') or 'Staff member',
#             attendance_id=existing['id'], status=check_out_status,
#             event_local_str=_attendance_exceptions.local_time_str(event_dt, branch_zone),
#         )

#     return {
#         'already_marked': False,
#         'checked_out': True,
#         'attendance_id': existing['id'],
#         'marked_at': now,
#         'status': check_out_status,
#         'notes': checkout_fields.get('notes'),
#         'pending_review': check_out_status in ('early', 'late'),
#         'source': source,
#         'capture_check_out': True,
#     }

# def evaluate_field_geofence(org_id: str, staff_id: str, latitude: float, longitude: float) -> dict:
#     """Compare a field-staff member's live GPS fix against their OWN
#     assigned geofence (client_staff.geofence_lat/lng/radius_meters/label,
#     set from Staff Management's "Attendance Location" section).

#     Returns:
#         {
#           'configured': bool,  # False = no geofence assigned to this person yet
#           'inside': bool,
#           'distance': float,   # meters; 0.0 when not configured
#           'radius': float,
#           'label': str | None,
#         }

#     'configured' is what lets the mobile app tell "no site assigned yet"
#     apart from "assigned, and you happen to be 0m away" -- see
#     geofence_service.dart's evaluateGeofence doc comment, which mirrors
#     this exact contract on-device. The mobile app no longer calls this
#     function on its attendance-marking path (see
#     client_field_attendance_routes.py's mark_field_attendance) -- it
#     evaluates the geofence itself from config already on the app's
#     session, so the server doesn't re-fetch the staff row and recompute
#     the distance on every mark. This function is kept for
#     /api/field/check-geofence and any other server-side caller that still
#     wants the computed answer.

#     staff_id is expected to come from the caller's verified JWT
#     (g.client_staff), same isolation rule as mark_client_staff_attendance --
#     never trust an org/staff id pulled from the request body.
#     """
#     from support_db_staff import _haversine_distance_meters, get_client_staff_member
#     staff = get_client_staff_member(str(staff_id))
#     if str(staff.get('organization_id') or '') != str(org_id):
#         raise ValueError('Staff member not found for this organization')

#     geo_lat = staff.get('geofenceLat')
#     geo_lng = staff.get('geofenceLng')
#     radius = float(staff.get('geofenceRadiusMeters') or 150)
#     label = staff.get('geofenceLabel')

#     if geo_lat is None or geo_lng is None:
#         return {
#             'configured': False,
#             'inside': False,
#             'distance': 0.0,
#             'radius': radius,
#             'label': label,
#         }

#     distance = _haversine_distance_meters(float(latitude), float(longitude), float(geo_lat), float(geo_lng))
#     return {
#         'configured': True,
#         'inside': distance <= radius,
#         'distance': round(distance, 1),
#         'radius': radius,
#         'label': label,
#     }

# def mark_field_staff_attendance(
#     org_id: str,
#     branch_id: str | None,
#     staff_id: str,
#     *,
#     latitude: float | None = None,
#     longitude: float | None = None,
#     geofence_result: dict | None = None,
#     synced_after_offline: bool = False,
#     client_action_id: str | None = None,
#     face_verified: bool | None = None,
#     face_similarity: float | None = None,
# ) -> dict:
#     """Self-service check-in/check-out for FIELD staff from the mobile app.

#     Mirrors mark_client_staff_attendance's insert-or-update contract
#     exactly (same attendance table, same "first mark of the UTC day is a
#     check-in, a second mark is a check-out only if the resolved window's
#     capture_check_out allows it" rule via
#     _resolve_client_staff_attendance_window) so a field self-mark and an
#     office self-mark behave identically except for what's recorded in
#     metadata: geofence evaluation (inside/distance/radius/configured)
#     instead of ssid/bssid/wifi_verified, and source='mobile_field' instead
#     of 'mobile_office' (both are pre-approved on attendance.source's CHECK
#     constraint already -- see mark_client_staff_attendance's docstring).

#     A mark is NEVER blocked for being outside the geofence -- the mobile
#     flow already warns the employee and lets them proceed after firing a
#     geo-alert (see field_attendance_screen.dart's confirmation dialog) --
#     this just records what actually happened (inside/outside + distance)
#     so an admin can review it on the Client Dashboard attendance log.

#     face_verified/face_similarity: set when this mark is the sync-time
#     completion of an offline queued action (OfflineQueueService's
#     'field_attendance_offline' case) -- the selfie was captured while
#     offline and matched against /api/field/verify-face only once
#     connectivity returned. face_verified=None means the live path already
#     ran verify-face synchronously before calling this (the normal case) --
#     nothing new to record. face_verified=False means the deferred match
#     failed or came back inconclusive: the mark still lands (never silently
#     dropped -- see field_attendance_screen.dart's plan for why "recorded
#     but pending" beats "not present until synced"), but is flagged
#     pending_face_review alongside the existing late/early pending_review
#     path, through the same notify_check_in_exception/
#     notify_check_out_exception admin-alert pipeline.

#     client_action_id: see mark_client_staff_attendance's docstring --
#     identical contract, via the shared _check_action_replay helper.
#     """
#     from support_db_attendance_dashboard import _dashboard_day_window_utc
#     from support_db_nodes import _iso_now
#     sb = get_supabase()
#     org_key = str(org_id)
#     staff_key = str(staff_id)
#     source = 'mobile_fallback' if synced_after_offline else 'mobile_field'

#     event_dt = datetime.now(timezone.utc)
#     staff_row, window, branch_zone = _resolve_client_staff_attendance_window(
#         org_key, branch_id, staff_key, event_dt,
#     )

#     _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)
#     existing_result = (
#         sb.table('attendance')
#         .select('id, check_out_timestamp, notes, metadata')
#         .eq('org_id', org_key)
#         .eq('staff_id', staff_key)
#         .gte('timestamp', day_start_iso)
#         .lt('timestamp', day_end_iso)
#         .limit(1)
#         .execute()
#     )
#     existing = existing_result.data[0] if existing_result.data else None

#     replay = _check_action_replay(
#         existing, client_action_id,
#         capture_check_out=bool(window and window.get('capture_check_out')),
#     )
#     if replay is not None:
#         replay['geofence'] = geofence_result or {}
#         return replay

#     now = _iso_now()

#     geofence_result = geofence_result or {}
#     pending_face_review = face_verified is False
#     metadata = {
#         'latitude': latitude,
#         'longitude': longitude,
#         'geofence_configured': bool(geofence_result.get('configured')),
#         'geofence_inside': bool(geofence_result.get('inside')),
#         'geofence_distance_meters': geofence_result.get('distance'),
#         'geofence_radius_meters': geofence_result.get('radius'),
#         'geofence_label': geofence_result.get('label'),
#         'face_verified': face_verified,
#         'face_similarity': face_similarity,
#         'client_action_id': client_action_id,
#     }

#     if not existing:
#         status = resolve_check_in_status(window, event_dt, branch_zone)
#         row = {
#             'org_id': org_key,
#             'branch_id': str(branch_id) if branch_id else None,
#             'staff_id': staff_key,
#             'timestamp': now,
#             'status': status,
#             'source': source,
#             'capture_channel': 'mobile_app',
#             'confidence': 1.0,
#             'metadata': metadata,
#         }
#         row.update(_attendance_exceptions.check_in_write_fields(status))
#         try:
#             result = sb.table('attendance').insert(row).execute()
#         except Exception as exc:
#             logger.error(
#                 'mark_field_staff_attendance insert failed for org=%s staff=%s row=%s: %s',
#                 org_key, staff_key, row, exc,
#             )
#             raise RuntimeError('Failed to record attendance') from exc
#         if not result.data:
#             raise RuntimeError('Failed to record attendance')
#         new_id = result.data[0].get('id')
#         if status == 'late' or pending_face_review:
#             _attendance_exceptions.notify_check_in_exception(
#                 org_id=org_key, branch_id=branch_id, staff_id=staff_key,
#                 staff_name=staff_row.get('name') or 'Staff member',
#                 attendance_id=new_id,
#                 event_local_str=_attendance_exceptions.local_time_str(event_dt, branch_zone),
#             )
#         return {
#             'already_marked': False,
#             'checked_out': False,
#             'attendance_id': new_id,
#             'marked_at': now,
#             'status': status,
#             'notes': row.get('notes'),
#             'pending_review': status == 'late' or pending_face_review,
#             'pending_face_review': pending_face_review,
#             'face_verified': face_verified,
#             'source': source,
#             'capture_check_out': bool(window and window.get('capture_check_out')),
#             'geofence': geofence_result,
#         }

#     if existing.get('check_out_timestamp'):
#         return {
#             'already_marked': True,
#             'checked_out': True,
#             'attendance_id': existing.get('id'),
#             'capture_check_out': bool(window and window.get('capture_check_out')),
#             'geofence': geofence_result,
#         }

#     if not (window and window.get('capture_check_out')):
#         return {
#             'already_marked': True,
#             'checked_out': False,
#             'attendance_id': existing.get('id'),
#             'capture_check_out': False,
#             'geofence': geofence_result,
#         }

#     # See mark_client_staff_attendance's matching comment: mobile checkouts
#     # (office and field share this bug) never consult _find_approved_overtime.
#     # Late/overtime classification always goes through the admin notification
#     # flow instead of silently auto-approving off a stale approved OT row.
#     check_out_status = resolve_check_out_status(window, event_dt, branch_zone)
#     checkout_fields = _attendance_exceptions.check_out_write_fields(check_out_status, existing.get('notes'))
#     update_payload = {
#         'check_out_timestamp': now,
#         'check_out_status': check_out_status,
#         'check_out_confidence': 1.0,
#         'check_out_metadata': metadata,
#     }
#     update_payload.update(checkout_fields)
#     try:
#         update_result = (
#             sb.table('attendance')
#             .update(update_payload)
#             .eq('id', existing['id'])
#             .execute()
#         )
#     except Exception as exc:
#         logger.error(
#             'mark_field_staff_attendance checkout update failed for org=%s staff=%s '
#             'attendance_id=%s payload=%s: %s',
#             org_key, staff_key, existing['id'], update_payload, exc,
#         )
#         raise RuntimeError('Failed to record checkout') from exc
#     if not update_result.data:
#         raise RuntimeError('Failed to record checkout')

#     if check_out_status in ('early', 'late') or pending_face_review:
#         _attendance_exceptions.notify_check_out_exception(
#             org_id=org_key, branch_id=branch_id, staff_id=staff_key,
#             staff_name=staff_row.get('name') or 'Staff member',
#             attendance_id=existing['id'], status=check_out_status,
#             event_local_str=_attendance_exceptions.local_time_str(event_dt, branch_zone),
#         )

#     return {
#         'already_marked': False,
#         'checked_out': True,
#         'attendance_id': existing['id'],
#         'marked_at': now,
#         'status': check_out_status,
#         'notes': checkout_fields.get('notes'),
#         'pending_review': check_out_status in ('early', 'late') or pending_face_review,
#         'pending_face_review': pending_face_review,
#         'face_verified': face_verified,
#         'source': source,
#         'capture_check_out': True,
#         'geofence': geofence_result,
#     }

# def record_field_geo_alert(org_id: str, staff_id: str, latitude: float, longitude: float, distance: float) -> None:
#     """Best-effort log of a field employee marking attendance outside their
#     assigned geofence. There is intentionally no dedicated table for this
#     yet (no migration tooling available here) -- this logs server-side so
#     it's at least visible in ops/monitoring; a `field_geo_alerts` table
#     with a Client Dashboard-visible list is the natural next step once
#     someone owns that migration. Never raises -- an alert is best-effort
#     and must not block the attendance mark that triggered it, mirroring
#     the mobile app's own "silent fail" GeofenceService.sendGeoAlert.
#     """
#     try:
#         logger.warning(
#             'Field geo-alert: org=%s staff=%s lat=%s lng=%s distance_m=%s',
#             org_id, staff_id, latitude, longitude, distance,
#         )
#     except Exception:
#         pass


"""
support_db_attendance_mobile.py
───────────────────────────────────────────────────────────────────────────────
Mobile self-service attendance for client_staff (office check-in/out and
field geofenced attendance).

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

logger = get_logger(__name__)
from support_invite_message import build_client_invite_message
from support_db_attendance_gate import (
    resolve_timing_source,
    resolve_manual_instruction_window,
    resolve_branch_default_window,
    resolve_staff_shift_windows,
    resolve_check_in_status,
    resolve_check_out_status,
    _get_branch_timezone,
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

def _resolve_client_staff_attendance_window(
    org_id: str,
    branch_id: str | None,
    staff_id: str,
    event_dt: 'datetime',
) -> tuple[dict, dict, 'ZoneInfo']:
    """Shared staff-lookup + shift-window resolution used by both
    mark_client_staff_attendance (write) and get_client_staff_attendance_today
    (read) -- one place decides "which shift/capture rules apply to this
    person right now," so the two can never resolve a different window for
    the same person/moment. Raises ValueError for not-found/archived staff,
    same contract every support_db_* function already uses.
    """
    sb = get_supabase()
    org_key = str(org_id)
    staff_key = str(staff_id)

    staff_result = (
        sb.table('client_staff')
        .select(
            'id, name, people_type, shift_id_ref, department_id, '
            'check_in_grace_override, check_out_grace_override, '
            'is_archived, status'
        )
        .eq('id', staff_key)
        .eq('org_id', org_key)
        .limit(1)
        .execute()
    )
    if not staff_result.data:
        raise ValueError('Staff member not found')
    staff_row = staff_result.data[0]
    if staff_row.get('is_archived') or str(staff_row.get('status') or 'active') == 'inactive':
        raise ValueError('This account is archived or inactive.')
    people_type = staff_row.get('people_type') or 'staff'

    window = resolve_timing_source(
        org_id=org_key,
        branch_id=str(branch_id) if branch_id else None,
        staff=staff_row,
        people_type=people_type,
        event_time_utc=event_dt,
    )
    branch_zone = _get_branch_timezone(sb, org_key, str(branch_id)) if branch_id else ZoneInfo('UTC')
    return staff_row, window, branch_zone

def get_client_staff_attendance_today(
    org_id: str,
    branch_id: str | None,
    staff_id: str,
) -> dict:
    """Read-only "where do I stand today" check for the mobile home screen.

    Answers the one question the UI can't derive from history alone:
    whether the resolved shift for THIS person, right now, allows a
    checkout mark at all (capture_check_out) -- needed to decide whether to
    show a Check Out button immediately after check-in, not just after the
    app discovers it by attempting one. Shares its window resolution with
    mark_client_staff_attendance via _resolve_client_staff_attendance_window
    so the two never disagree about which shift applies.
    """
    from support_db_attendance_dashboard import _dashboard_day_window_utc
    sb = get_supabase()
    org_key = str(org_id)
    staff_key = str(staff_id)
    event_dt = datetime.now(timezone.utc)

    _, window, _ = _resolve_client_staff_attendance_window(org_key, branch_id, staff_key, event_dt)

    _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)
    existing_result = (
        sb.table('attendance')
        .select(
            'id, timestamp, check_out_timestamp, status, check_out_status, '
            'notes, day_status, check_in_hold_reason, check_out_hold_reason, '
            'check_in_confirmed'
        )
        .eq('org_id', org_key)
        .eq('staff_id', staff_key)
        .gte('timestamp', day_start_iso)
        .lt('timestamp', day_end_iso)
        .limit(1)
        .execute()
    )
    existing = existing_result.data[0] if existing_result.data else None
    duration_minutes, duration_label = _attendance_exceptions.compute_duration(
        existing.get('timestamp') if existing else None,
        existing.get('check_out_timestamp') if existing else None,
    )

    return {
        'marked': existing is not None,
        'checked_out': bool(existing and existing.get('check_out_timestamp')),
        'capture_check_out': bool(window and window.get('capture_check_out')),
        'time': str(existing.get('timestamp'))[11:16] if existing and existing.get('timestamp') else '',
        'out_time': (
            str(existing.get('check_out_timestamp'))[11:16]
            if existing and existing.get('check_out_timestamp') else ''
        ),
        # Timing classification (early/on_time/late/overtime/unscheduled),
        # separate from day_status (present/half_day/overtime).
        'check_in_status': existing.get('status') if existing else None,
        'check_out_status': existing.get('check_out_status') if existing else None,
        'day_status': (existing.get('day_status') if existing else None) or 'present',
        'notes': existing.get('notes') if existing else None,
        # Non-null only while a late check-in / early-or-late checkout is
        # still awaiting admin resolution — drives the app's "Pending
        # Review" banner.
        'check_in_hold_reason': existing.get('check_in_hold_reason') if existing else None,
        'check_out_hold_reason': existing.get('check_out_hold_reason') if existing else None,
        'check_in_confirmed': (
            True if not existing or existing.get('check_in_confirmed') is None
            else bool(existing.get('check_in_confirmed'))
        ),
        'duration_minutes': duration_minutes,
        'duration_label': duration_label,
    }

def _check_action_replay(
    existing: dict | None,
    client_action_id: str | None,
    *,
    capture_check_out: bool,
) -> dict | None:
    """Detects a retried CHECK-IN call arriving after its own response was
    lost -- returns the check-in outcome again instead of letting it fall
    through to the check-out branch, which would otherwise silently check
    the person out on a retry they never intended as one.

    Only the check-in half needs this. A retried CHECK-OUT call needs no
    special handling: the existing `existing.get('check_out_timestamp')`
    branch already returns the same "already_marked/checked_out" result
    idempotently for any call once the row has a checkout timestamp,
    client_action_id or not.

    Returns None when there's nothing to replay (no existing row, no
    client_action_id supplied, or the id doesn't match -- i.e. this really
    is a new checkout attempt) so the caller falls through to its normal
    insert-or-checkout logic unchanged.
    """
    if not existing or existing.get('check_out_timestamp') or not client_action_id:
        return None
    existing_metadata = existing.get('metadata') or {}
    if existing_metadata.get('client_action_id') != client_action_id:
        return None
    return {
        'already_marked': True,
        'checked_out': False,
        'attendance_id': existing['id'],
        'capture_check_out': capture_check_out,
        'replayed': True,
    }

def mark_client_staff_attendance(
    org_id: str,
    branch_id: str | None,
    staff_id: str,
    *,
    ssid: str | None = None,
    bssid: str | None = None,
    wifi_verified: bool = False,
    synced_after_offline: bool = False,
    client_action_id: str | None = None,
) -> dict:
    """Self-service check-in/check-out from the mobile app (office staff).

    Mirrors record_cloud_camera_attendance's insert-or-update contract
    exactly, so a mobile self-mark and a camera detection produce
    identical check-in/check-out behavior for the same branch/people_type
    timing rules -- one source of truth (attendance_capture_settings /
    shifts / overrides), another capture method alongside 'camera' and
    'camera_cloud'. The first mark of a UTC day is a check-in; a second
    mark the same day is a check-out if the resolved window has
    capture_check_out enabled, otherwise it's a no-op ('already_marked').

    org_id/branch_id/staff_id must come from the caller's verified JWT
    (g.client_staff in the route), never the request body -- see
    require_client_staff_auth. A mobile client can never mark attendance
    for another org/branch/staff member by editing the payload.

    source is 'mobile_fallback' when this call is the delayed sync of a
    mark the app cached locally after a failed real-time attempt (see
    office_home_screen.dart's offline-cache path), otherwise
    'mobile_office' for a normal real-time mark. Both are pre-approved
    values on attendance.source's CHECK constraint alongside 'camera' /
    'camera_cloud' / 'mobile_field' / 'mobile_cloud', so this needs no
    migration and no forced-'camera' workaround the way
    _node_attendance_metadata needs for the node's source values.

    client_action_id is the offline queue's idempotency key
    (OfflineQueueService.dart) -- stored in metadata and checked via
    _check_action_replay so a dropped response never gets replayed as a
    checkout. Optional: a live, never-queued call can omit it and this
    behaves exactly as before.
    """
    from support_db_attendance_dashboard import _dashboard_day_window_utc
    from support_db_nodes import _iso_now
    sb = get_supabase()
    org_key = str(org_id)
    staff_key = str(staff_id)
    source = 'mobile_fallback' if synced_after_offline else 'mobile_office'

    event_dt = datetime.now(timezone.utc)
    staff_row, window, branch_zone = _resolve_client_staff_attendance_window(
        org_key, branch_id, staff_key, event_dt,
    )
    people_type = staff_row.get('people_type') or 'staff'

    _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)
    existing_result = (
        sb.table('attendance')
        .select('id, check_out_timestamp, notes, metadata')
        .eq('org_id', org_key)
        .eq('staff_id', staff_key)
        .gte('timestamp', day_start_iso)
        .lt('timestamp', day_end_iso)
        .limit(1)
        .execute()
    )
    existing = existing_result.data[0] if existing_result.data else None

    replay = _check_action_replay(
        existing, client_action_id,
        capture_check_out=bool(window and window.get('capture_check_out')),
    )
    if replay is not None:
        return replay

    now = _iso_now()
    metadata = {
        'ssid': ssid,
        'bssid': bssid,
        'wifi_verified': bool(wifi_verified),
        'client_action_id': client_action_id,
    }

    if not existing:
        status = resolve_check_in_status(window, event_dt, branch_zone)
        row = {
            'org_id': org_key,
            'branch_id': str(branch_id) if branch_id else None,
            'staff_id': staff_key,
            'timestamp': now,
            'status': status,
            'source': source,
            'capture_channel': 'mobile_app',
            'confidence': 1.0,
            'metadata': metadata,
        }
        row.update(_attendance_exceptions.check_in_write_fields(status))
        try:
            result = sb.table('attendance').insert(row).execute()
        except Exception as exc:
            # Unwrapped before this fix -- a PostgREST rejection (NOT NULL /
            # CHECK / unique-constraint violation, etc.) surfaced only as
            # httpx's bare "400 Bad Request" status line, with the actual
            # reason (exc's message/details/hint from Supabase's JSON error
            # body) silently discarded, and the route turning it into an
            # undiagnosable generic 500. Log the real reason server-side
            # (safe -- may contain schema/column detail) and re-raise as
            # RuntimeError, matching the "no data returned" case right
            # below and this module's existing error-handling contract
            # (client_routes_helpers.handle: RuntimeError -> 500 with a
            # clean message, nothing internal leaked to the client).
            logger.error(
                'mark_client_staff_attendance insert failed for org=%s staff=%s row=%s: %s',
                org_key, staff_key, row, exc,
            )
            raise RuntimeError('Failed to record attendance') from exc
        if not result.data:
            raise RuntimeError('Failed to record attendance')
        new_id = result.data[0].get('id')
        if status == 'late':
            _attendance_exceptions.notify_check_in_exception(
                org_id=org_key, branch_id=branch_id, staff_id=staff_key,
                staff_name=staff_row.get('name') or 'Staff member',
                attendance_id=new_id,
                event_local_str=_attendance_exceptions.local_time_str(event_dt, branch_zone),
            )
        return {
            'already_marked': False,
            'checked_out': False,
            'attendance_id': new_id,
            'marked_at': now,
            'status': status,
            'notes': row.get('notes'),
            'pending_review': status == 'late',
            'source': source,
            'capture_check_out': bool(window and window.get('capture_check_out')),
        }

    if existing.get('check_out_timestamp'):
        return {
            'already_marked': True,
            'checked_out': True,
            'attendance_id': existing.get('id'),
            'capture_check_out': bool(window and window.get('capture_check_out')),
        }

    if not (window and window.get('capture_check_out')):
        return {
            'already_marked': True,
            'checked_out': False,
            'attendance_id': existing.get('id'),
            'capture_check_out': False,
        }

    # Mobile self-service checkouts never consult _find_approved_overtime —
    # unlike local-node captures, both the late/overtime classification AND
    # the payroll include/exclude decision belong to the admin, made in the
    # notifications/exceptions page. Silently classifying straight to
    # 'overtime' here would skip check_out_hold_reason and the notification
    # entirely (see notify_check_out_exception below), which is exactly the
    # bug this guards against: a prior admin-approved overtime_requests row
    # for today would otherwise auto-classify *today's* checkout too.
    check_out_status = resolve_check_out_status(window, event_dt, branch_zone)
    checkout_fields = _attendance_exceptions.check_out_write_fields(check_out_status, existing.get('notes'))
    update_payload = {
        'check_out_timestamp': now,
        'check_out_status': check_out_status,
        'check_out_confidence': 1.0,
        'check_out_metadata': metadata,
    }
    update_payload.update(checkout_fields)
    try:
        update_result = (
            sb.table('attendance')
            .update(update_payload)
            .eq('id', existing['id'])
            .execute()
        )
    except Exception as exc:
        logger.error(
            'mark_client_staff_attendance checkout update failed for org=%s staff=%s '
            'attendance_id=%s payload=%s: %s',
            org_key, staff_key, existing['id'], update_payload, exc,
        )
        raise RuntimeError('Failed to record checkout') from exc
    if not update_result.data:
        raise RuntimeError('Failed to record checkout')

    if check_out_status in ('early', 'late'):
        _attendance_exceptions.notify_check_out_exception(
            org_id=org_key, branch_id=branch_id, staff_id=staff_key,
            staff_name=staff_row.get('name') or 'Staff member',
            attendance_id=existing['id'], status=check_out_status,
            event_local_str=_attendance_exceptions.local_time_str(event_dt, branch_zone),
        )

    return {
        'already_marked': False,
        'checked_out': True,
        'attendance_id': existing['id'],
        'marked_at': now,
        'status': check_out_status,
        'notes': checkout_fields.get('notes'),
        'pending_review': check_out_status in ('early', 'late'),
        'source': source,
        'capture_check_out': True,
    }

def evaluate_field_geofence(org_id: str, staff_id: str, latitude: float, longitude: float) -> dict:
    """Compare a field-staff member's live GPS fix against their OWN
    assigned geofence (client_staff.geofence_lat/lng/radius_meters/label,
    set from Staff Management's "Attendance Location" section).

    Returns:
        {
          'configured': bool,  # False = no geofence assigned to this person yet
          'inside': bool,
          'distance': float,   # meters; 0.0 when not configured
          'radius': float,
          'label': str | None,
        }

    'configured' is what lets the mobile app tell "no site assigned yet"
    apart from "assigned, and you happen to be 0m away" -- see
    geofence_service.dart's evaluateGeofence doc comment, which mirrors
    this exact contract on-device. The mobile app no longer calls this
    function on its attendance-marking path (see
    client_field_attendance_routes.py's mark_field_attendance) -- it
    evaluates the geofence itself from config already on the app's
    session, so the server doesn't re-fetch the staff row and recompute
    the distance on every mark. This function is kept for
    /api/field/check-geofence and any other server-side caller that still
    wants the computed answer.

    staff_id is expected to come from the caller's verified JWT
    (g.client_staff), same isolation rule as mark_client_staff_attendance --
    never trust an org/staff id pulled from the request body.
    """
    from support_db_staff import _haversine_distance_meters, get_client_staff_member
    staff = get_client_staff_member(str(staff_id))
    if str(staff.get('organization_id') or '') != str(org_id):
        raise ValueError('Staff member not found for this organization')

    geo_lat = staff.get('geofenceLat')
    geo_lng = staff.get('geofenceLng')
    radius = float(staff.get('geofenceRadiusMeters') or 150)
    label = staff.get('geofenceLabel')

    if geo_lat is None or geo_lng is None:
        return {
            'configured': False,
            'inside': False,
            'distance': 0.0,
            'radius': radius,
            'label': label,
        }

    distance = _haversine_distance_meters(float(latitude), float(longitude), float(geo_lat), float(geo_lng))
    return {
        'configured': True,
        'inside': distance <= radius,
        'distance': round(distance, 1),
        'radius': radius,
        'label': label,
    }

def mark_field_staff_attendance(
    org_id: str,
    branch_id: str | None,
    staff_id: str,
    *,
    latitude: float | None = None,
    longitude: float | None = None,
    geofence_result: dict | None = None,
    synced_after_offline: bool = False,
    client_action_id: str | None = None,
    face_verified: bool | None = None,
    face_similarity: float | None = None,
) -> dict:
    """Self-service check-in/check-out for FIELD staff from the mobile app.

    Mirrors mark_client_staff_attendance's insert-or-update contract
    exactly (same attendance table, same "first mark of the UTC day is a
    check-in, a second mark is a check-out only if the resolved window's
    capture_check_out allows it" rule via
    _resolve_client_staff_attendance_window) so a field self-mark and an
    office self-mark behave identically except for what's recorded in
    metadata: geofence evaluation (inside/distance/radius/configured)
    instead of ssid/bssid/wifi_verified, and source='mobile_field' instead
    of 'mobile_office' (both are pre-approved on attendance.source's CHECK
    constraint already -- see mark_client_staff_attendance's docstring).

    A mark is NEVER blocked for being outside the geofence -- the mobile
    flow already warns the employee and lets them proceed after firing a
    geo-alert (see field_attendance_screen.dart's confirmation dialog) --
    this just records what actually happened (inside/outside + distance)
    so an admin can review it on the Client Dashboard attendance log.

    face_verified/face_similarity: set when this mark is the sync-time
    completion of an offline queued action (OfflineQueueService's
    'field_attendance_offline' case) -- the selfie was captured while
    offline and matched against /api/field/verify-face only once
    connectivity returned. face_verified=None means the live path already
    ran verify-face synchronously before calling this (the normal case) --
    nothing new to record. face_verified=False means the deferred match
    failed or came back inconclusive: the mark still lands (never silently
    dropped -- see field_attendance_screen.dart's plan for why "recorded
    but pending" beats "not present until synced"), but is flagged
    pending_face_review alongside the existing late/early pending_review
    path, through the same notify_check_in_exception/
    notify_check_out_exception admin-alert pipeline.

    client_action_id: see mark_client_staff_attendance's docstring --
    identical contract, via the shared _check_action_replay helper.
    """
    from support_db_attendance_dashboard import _dashboard_day_window_utc
    from support_db_nodes import _iso_now
    sb = get_supabase()
    org_key = str(org_id)
    staff_key = str(staff_id)
    source = 'mobile_fallback' if synced_after_offline else 'mobile_field'

    event_dt = datetime.now(timezone.utc)
    staff_row, window, branch_zone = _resolve_client_staff_attendance_window(
        org_key, branch_id, staff_key, event_dt,
    )

    _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)
    existing_result = (
        sb.table('attendance')
        .select('id, check_out_timestamp, notes, metadata')
        .eq('org_id', org_key)
        .eq('staff_id', staff_key)
        .gte('timestamp', day_start_iso)
        .lt('timestamp', day_end_iso)
        .limit(1)
        .execute()
    )
    existing = existing_result.data[0] if existing_result.data else None

    replay = _check_action_replay(
        existing, client_action_id,
        capture_check_out=bool(window and window.get('capture_check_out')),
    )
    if replay is not None:
        replay['geofence'] = geofence_result or {}
        return replay

    now = _iso_now()

    geofence_result = geofence_result or {}
    pending_face_review = face_verified is False
    metadata = {
        'latitude': latitude,
        'longitude': longitude,
        'geofence_configured': bool(geofence_result.get('configured')),
        'geofence_inside': bool(geofence_result.get('inside')),
        'geofence_distance_meters': geofence_result.get('distance'),
        'geofence_radius_meters': geofence_result.get('radius'),
        'geofence_label': geofence_result.get('label'),
        'face_verified': face_verified,
        'face_similarity': face_similarity,
        'client_action_id': client_action_id,
    }

    if not existing:
        status = resolve_check_in_status(window, event_dt, branch_zone)
        row = {
            'org_id': org_key,
            'branch_id': str(branch_id) if branch_id else None,
            'staff_id': staff_key,
            'timestamp': now,
            'status': status,
            'source': source,
            'capture_channel': 'mobile_app',
            'confidence': 1.0,
            'metadata': metadata,
        }
        row.update(_attendance_exceptions.check_in_write_fields(status))
        try:
            result = sb.table('attendance').insert(row).execute()
        except Exception as exc:
            logger.error(
                'mark_field_staff_attendance insert failed for org=%s staff=%s row=%s: %s',
                org_key, staff_key, row, exc,
            )
            raise RuntimeError('Failed to record attendance') from exc
        if not result.data:
            raise RuntimeError('Failed to record attendance')
        new_id = result.data[0].get('id')
        if status == 'late' or pending_face_review:
            _attendance_exceptions.notify_check_in_exception(
                org_id=org_key, branch_id=branch_id, staff_id=staff_key,
                staff_name=staff_row.get('name') or 'Staff member',
                attendance_id=new_id,
                event_local_str=_attendance_exceptions.local_time_str(event_dt, branch_zone),
            )
        return {
            'already_marked': False,
            'checked_out': False,
            'attendance_id': new_id,
            'marked_at': now,
            'status': status,
            'notes': row.get('notes'),
            'pending_review': status == 'late' or pending_face_review,
            'pending_face_review': pending_face_review,
            'face_verified': face_verified,
            'source': source,
            'capture_check_out': bool(window and window.get('capture_check_out')),
            'geofence': geofence_result,
        }

    if existing.get('check_out_timestamp'):
        return {
            'already_marked': True,
            'checked_out': True,
            'attendance_id': existing.get('id'),
            'capture_check_out': bool(window and window.get('capture_check_out')),
            'geofence': geofence_result,
        }

    if not (window and window.get('capture_check_out')):
        return {
            'already_marked': True,
            'checked_out': False,
            'attendance_id': existing.get('id'),
            'capture_check_out': False,
            'geofence': geofence_result,
        }

    # See mark_client_staff_attendance's matching comment: mobile checkouts
    # (office and field share this bug) never consult _find_approved_overtime.
    # Late/overtime classification always goes through the admin notification
    # flow instead of silently auto-approving off a stale approved OT row.
    check_out_status = resolve_check_out_status(window, event_dt, branch_zone)
    checkout_fields = _attendance_exceptions.check_out_write_fields(check_out_status, existing.get('notes'))
    update_payload = {
        'check_out_timestamp': now,
        'check_out_status': check_out_status,
        'check_out_confidence': 1.0,
        'check_out_metadata': metadata,
    }
    update_payload.update(checkout_fields)
    try:
        update_result = (
            sb.table('attendance')
            .update(update_payload)
            .eq('id', existing['id'])
            .execute()
        )
    except Exception as exc:
        logger.error(
            'mark_field_staff_attendance checkout update failed for org=%s staff=%s '
            'attendance_id=%s payload=%s: %s',
            org_key, staff_key, existing['id'], update_payload, exc,
        )
        raise RuntimeError('Failed to record checkout') from exc
    if not update_result.data:
        raise RuntimeError('Failed to record checkout')

    if check_out_status in ('early', 'late') or pending_face_review:
        _attendance_exceptions.notify_check_out_exception(
            org_id=org_key, branch_id=branch_id, staff_id=staff_key,
            staff_name=staff_row.get('name') or 'Staff member',
            attendance_id=existing['id'], status=check_out_status,
            event_local_str=_attendance_exceptions.local_time_str(event_dt, branch_zone),
        )

    return {
        'already_marked': False,
        'checked_out': True,
        'attendance_id': existing['id'],
        'marked_at': now,
        'status': check_out_status,
        'notes': checkout_fields.get('notes'),
        'pending_review': check_out_status in ('early', 'late') or pending_face_review,
        'pending_face_review': pending_face_review,
        'face_verified': face_verified,
        'source': source,
        'capture_check_out': True,
        'geofence': geofence_result,
    }

def record_field_geo_alert(org_id: str, staff_id: str, latitude: float, longitude: float, distance: float) -> None:
    """Best-effort log of a field employee marking attendance outside their
    assigned geofence. There is intentionally no dedicated table for this
    yet (no migration tooling available here) -- this logs server-side so
    it's at least visible in ops/monitoring; a `field_geo_alerts` table
    with a Client Dashboard-visible list is the natural next step once
    someone owns that migration. Never raises -- an alert is best-effort
    and must not block the attendance mark that triggered it, mirroring
    the mobile app's own "silent fail" GeofenceService.sendGeoAlert.
    """
    try:
        logger.warning(
            'Field geo-alert: org=%s staff=%s lat=%s lng=%s distance_m=%s',
            org_id, staff_id, latitude, longitude, distance,
        )
    except Exception:
        pass