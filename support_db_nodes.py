# """
# support_db_nodes.py
# ───────────────────────────────────────────────────────────────────────────────
# Node health/offline detection and the Local Node sync API (install tokens,
# heartbeats, camera config, training-job polling, embeddings push, cloud-mode
# attendance recording).

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
# from support_db_core import NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS, NODE_OFFLINE_THRESHOLD_MAX_SECONDS, NODE_OFFLINE_THRESHOLD_MIN_SECONDS, _ensure_org_client_access, _execute_supabase
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

# def get_node_health(org_id: str) -> list[dict]:
#     from support_db_organizations import get_organization
#     sb = get_supabase()
#     org = get_organization(org_id)
#     threshold_seconds = _resolve_node_offline_threshold_seconds(org)

#     branches_result = (
#         sb.table('branches')
#         .select('id, name, fallback_active')
#         .eq('org_id', org_id)
#         .is_('dropped_at', 'null')
#         .execute()
#     )
#     branches = branches_result.data or []

#     try:
#         keys_result = (
#             sb.table('node_api_keys')
#             .select('branch_id, node_id, node_label, last_seen_at, status, created_at, last_heartbeat_payload')
#             .eq('org_id', org_id)
#             .eq('status', 'active')
#             .execute()
#         )
#     except Exception as exc:
#         logger.warning('node_api_keys monitoring columns may be missing; loading basic node health only: %s', exc)
#         keys_result = (
#             sb.table('node_api_keys')
#             .select('branch_id, node_id, last_seen_at, status, created_at')
#             .eq('org_id', org_id)
#             .eq('status', 'active')
#             .execute()
#         )

#     key_by_branch = {k['branch_id']: k for k in (keys_result.data or [])}

#     health = []
#     for branch in branches:
#         key = key_by_branch.get(branch['id'])
#         payload = {}
#         last_seen = None
#         node_status = 'never_connected'
#         diff_minutes = None

#         if key:
#             payload = key.get('last_heartbeat_payload') or {}
#             if not isinstance(payload, dict):
#                 payload = {}
#             last_seen = key.get('last_seen_at')
#             node_status, diff_minutes = _compute_node_status(last_seen, threshold_seconds)

#         health.append({
#             'branch_id': branch['id'],
#             'branch_name': branch['name'],
#             'node_id': key.get('node_id') if key else None,
#             'node_label': key.get('node_label') if key else None,
#             'status': node_status,
#             'last_seen_at': last_seen,
#             'minutes_since_seen': diff_minutes,
#             'offline_threshold_seconds': threshold_seconds,
#             'fallback_active': branch['fallback_active'],
#             'attendance_mode': payload.get('attendance_mode'),
#             'configured_cameras': payload.get('configured_cameras'),
#             'cycle_status': payload.get('cycle_status'),
#             'last_cycle_at': payload.get('last_cycle_at'),
#             'last_error': payload.get('last_error'),
#             'agent_version': payload.get('agent_version'),
#             'hostname': payload.get('hostname'),
#             'last_heartbeat_payload': payload,
#         })

#     return health

# def _resolve_node_offline_threshold_seconds(org: dict) -> int:
#     """Single source of truth for the offline-detection SLA.

#     Falls back to NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS for cloud-mode
#     orgs (threshold is None by design — see create_organization/
#     update_organization) or malformed values, rather than crashing a
#     health-check sweep over one bad org.
#     """
#     try:
#         value = int(org.get('node_offline_threshold_seconds') or NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS)
#     except (TypeError, ValueError):
#         return NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS
#     return max(NODE_OFFLINE_THRESHOLD_MIN_SECONDS, min(value, NODE_OFFLINE_THRESHOLD_MAX_SECONDS))

# def _compute_node_status(last_seen_at: str | None, threshold_seconds: int) -> tuple[str, float | None]:
#     """Returns (status, minutes_since_seen). status is one of
#     'never_connected' | 'online' | 'offline'. Used by get_node_health,
#     list_support_node_health_page, and run_offline_detection_sweep so
#     online/offline can never be computed two different ways.
#     """
#     if not last_seen_at:
#         return 'never_connected', None
#     last_seen_dt = _parse_dt(last_seen_at)
#     if not last_seen_dt:
#         return 'never_connected', None
#     diff_seconds = (datetime.now(timezone.utc) - last_seen_dt).total_seconds()
#     status = 'online' if diff_seconds < threshold_seconds else 'offline'
#     return status, diff_seconds / 60

# def set_fallback(branch_id: str, active: bool) -> dict:
#     """Manual fallback override from Node Health section."""
#     sb = get_supabase()
#     result = (
#         sb.table('branches')
#         .update({'fallback_active': active})
#         .eq('id', branch_id)
#         .execute()
#     )
#     if not result.data:
#         raise ValueError(f'Branch {branch_id} not found')
#     return result.data[0]

# def _sha256_secret(raw: str) -> str:
#     value = str(raw or '').strip()
#     if not value:
#         raise ValueError('Secret value is required')
#     return hashlib.sha256(value.encode('utf-8')).hexdigest()

# def _token(prefix: str) -> str:
#     return f"{prefix}_{secrets.token_urlsafe(32)}"

# def _iso_now() -> str:
#     return datetime.now(timezone.utc).isoformat()

# def _parse_dt(value: str | None):
#     if not value:
#         return None
#     try:
#         return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
#     except Exception:
#         return None

# def _get_branch_owned_by_org(org_id: str, branch_id: str, include_dropped: bool = False) -> dict:
#     result = _execute_supabase(
#         'get_branch_owned_by_org',
#         lambda: get_supabase().table('branches').select('*').eq('id', str(branch_id)).eq('org_id', str(org_id)).limit(1),
#     )
#     if not result.data:
#         raise ValueError('Branch does not belong to this organization')
#     branch = result.data[0]
#     if branch.get('dropped_at') and not include_dropped:
#         raise ValueError('Branch has been dropped from this organization')
#     return branch

# def create_branch_install_token(
#     org_id: str,
#     branch_id: str,
#     created_by: str | None = None,
#     ttl_days: int = 7,
#     created_by_actor_type: str = "support",
# ) -> dict:
#     org_key = str(org_id or "").strip()
#     branch_key = str(branch_id or "").strip()
#     actor_id = str(created_by or "").strip() or None
#     actor_type = str(created_by_actor_type or "support").strip().lower()

#     if actor_type not in {"support", "client", "system"}:
#         raise ValueError("created_by_actor_type must be support, client, or system")

#     if not org_key:
#         raise ValueError("org_id is required")

#     if not branch_key:
#         raise ValueError("branch_id is required")

#     org = _ensure_org_client_access(org_key, "Installer token generation")

#     if str(org.get("attendance_mode") or "").strip().lower() != "local":
#         raise ValueError("Node installer is available only for local attendance mode")

#     branch = _get_branch_owned_by_org(org_key, branch_key)

#     ttl = max(1, min(int(ttl_days or 7), 30))
#     raw_token = "qia_install_" + secrets.token_urlsafe(32)
#     token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
#     now = datetime.now(timezone.utc)
#     expires_at = (now + timedelta(days=ttl)).isoformat()

#     insert_data = {
#         "org_id": org_key,
#         "branch_id": str(branch["id"]),
#         "token_hash": token_hash,
#         "expires_at": expires_at,
#         "created_by_actor_type": actor_type,
#         "created_by_internal_user_id": actor_id if actor_type == "support" else None,
#         "created_by_client_user_id": actor_id if actor_type == "client" else None,
#     }

#     # Backward-compatible legacy column.
#     # Only set it for support users because the legacy FK points to internal_users.
#     if actor_type == "support":
#         insert_data["created_by"] = actor_id
#     else:
#         insert_data["created_by"] = None

#     result = (
#         get_supabase()
#         .table("install_tokens")
#         .insert(insert_data)
#         .execute()
#     )

#     rows = result.data or []
#     if not rows:
#         raise RuntimeError("Failed to create install token")

#     row = dict(rows[0])
#     row["install_token"] = raw_token
#     row["organization_name"] = org.get("name")
#     row["branch_name"] = branch.get("name")
#     row["attendance_mode"] = org.get("attendance_mode")
#     return row

# def activate_node_with_install_token(
#     install_token: str,
#     node_label: str | None = None,
#     railway_api_base_url: str | None = None,
# ) -> dict:
#     """Exchange a one-time install token for a scoped node_api_key."""
#     from support_db_organizations import get_organization
#     sb = get_supabase()
#     raw = str(install_token or '').strip()
#     if not raw:
#         raise ValueError('install_token is required')

#     hashed = _sha256_secret(raw)
#     token_result = (
#         sb.table('install_tokens')
#         .select('*')
#         .eq('token_hash', hashed)
#         .limit(1)
#         .execute()
#     )
#     if not token_result.data:
#         raise ValueError('Invalid install token')

#     token_row = token_result.data[0]
#     if token_row.get('used_at'):
#         raise ValueError('Install token has already been used')

#     expires_at = _parse_dt(token_row.get('expires_at'))
#     if expires_at and expires_at < datetime.now(timezone.utc):
#         raise ValueError('Install token has expired')

#     org_id = str(token_row.get('org_id'))
#     branch_id = str(token_row.get('branch_id'))
#     org = get_organization(org_id)
#     branch = _get_branch_owned_by_org(org_id, branch_id)

#     node_api_key = _token('qia_node')
#     node_label_clean = str(node_label or '').strip()
#     # node_id must be a unique machine identifier, not the human-readable label.
#     # node_label can repeat across branches/tests (for example "Main Branch Laptop"),
#     # but node_api_keys.node_id has a unique constraint in Supabase.
#     node_id = f"node_{branch_id.replace('-', '')[:10]}_{secrets.token_hex(6)}"

#     # One active node per branch. Revoking older keys is safer than letting two
#     # physical machines write attendance for the same branch accidentally.
#     try:
#         sb.table('node_api_keys').update({'status': 'revoked'}).eq('branch_id', branch_id).eq('status', 'active').execute()
#     except Exception as exc:
#         logger.warning(f'Could not revoke previous node keys for branch {branch_id}: {exc}')

#     node_key_payload = {
#         'org_id': org_id,
#         'branch_id': branch_id,
#         'key_hash': _sha256_secret(node_api_key),
#         'node_id': node_id,
#         'status': 'active',
#         'last_seen_at': _iso_now(),
#         # Optional monitoring columns. If your Supabase migration has not been
#         # run yet, the fallback insert below keeps activation working.
#         'node_label': node_label_clean or None,
#         'last_heartbeat_payload': {
#             'node_label': node_label_clean or None,
#             'attendance_mode': org.get('attendance_mode') or 'cloud',
#             'cycle_status': 'activated',
#             'configured_cameras': 0,
#             'last_error': None,
#             'last_cycle_at': _iso_now(),
#         },
#     }

#     try:
#         inserted = sb.table('node_api_keys').insert(node_key_payload).execute()
#     except Exception as exc:
#         logger.warning(
#             'node_api_keys monitoring columns may be missing; retrying activation '
#             f'without optional node_label/last_heartbeat_payload fields: {exc}'
#         )
#         fallback_payload = dict(node_key_payload)
#         fallback_payload.pop('node_label', None)
#         fallback_payload.pop('last_heartbeat_payload', None)
#         inserted = sb.table('node_api_keys').insert(fallback_payload).execute()

#     if not inserted.data:
#         raise RuntimeError('Failed to create node API key')

#     sb.table('install_tokens').update({
#         'used_at': _iso_now(),
#         'used_by_node_id': node_id,
#     }).eq('id', token_row['id']).execute()

#     return {
#         'node_api_key': node_api_key,
#         'node_id': node_id,
#         'org_id': org_id,
#         'branch_id': branch_id,
#         'organization_name': org.get('name'),
#         'branch_name': branch.get('name'), 
#         'node_label': node_label_clean or None,
#         'attendance_mode': org.get('attendance_mode') or 'cloud',
#         'railway_api_base_url': railway_api_base_url or os.environ.get('RAILWAY_API_BASE_URL') or '',
#         'sync_poll_interval': int(os.environ.get('SYNC_POLL_INTERVAL', '30')),
#         'message': 'Node activated successfully. Store node_api_key locally; it will not be shown again.',
#     }

# def get_node_by_api_key(node_api_key: str) -> dict:
#     sb = get_supabase()
#     raw = str(node_api_key or '').strip()
#     if not raw:
#         raise ValueError('node_api_key is required')

#     result = (
#         sb.table('node_api_keys')
#         .select('*')
#         .eq('key_hash', _sha256_secret(raw))
#         .eq('status', 'active')
#         .limit(1)
#         .execute()
#     )
#     if not result.data:
#         raise ValueError('Invalid or revoked node_api_key')
#     return result.data[0]

# def node_heartbeat(node_api_key: str, payload: dict | None = None) -> dict:
#     sb = get_supabase()
#     node = get_node_by_api_key(node_api_key)
#     now = _iso_now()
#     heartbeat_payload = payload if isinstance(payload, dict) else {}

#     update_payload = {
#         'last_seen_at': now,
#         # Optional JSONB column used by Support Dashboard live monitoring.
#         'last_heartbeat_payload': {
#             **heartbeat_payload,
#             'server_received_at': now,
#         },
#     }

#     try:
#         sb.table('node_api_keys').update(update_payload).eq('id', node['id']).execute()
#     except Exception as exc:
#         logger.warning(
#             'Could not update last_heartbeat_payload. Run the node monitoring '
#             f'migration; falling back to last_seen_at only: {exc}'
#         )
#         sb.table('node_api_keys').update({'last_seen_at': now}).eq('id', node['id']).execute()

#     # If the node came back online, clear manual/automatic fallback for branch.
#     try:
#         sb.table('branches').update({'fallback_active': False}).eq('id', node['branch_id']).execute()
#     except Exception as exc:
#         logger.warning(f'Could not clear fallback for branch {node.get("branch_id")}: {exc}')

#     return {
#         'success': True,
#         'status': 'online',
#         'node_id': node.get('node_id'),
#         'org_id': node.get('org_id'),
#         'branch_id': node.get('branch_id'),
#         'last_seen_at': now,
#     }

# def get_local_node_status(org_id: str) -> dict | None:
#     """
#     Get the local node status for an organization.
#     Returns dict with:
#     - offline (bool): True if node is offline based on heartbeat threshold
#     - last_heartbeat (str): ISO timestamp of last heartbeat
#     - node_id (str): Node ID if online
#     Returns None if no node found for org.
#     """
#     try:
#         sb = get_supabase()
        
#         # Get the organization's node info
#         org_result = _execute_supabase(
#             'get_local_node_status.org',
#             lambda: sb.table('client_onboarding_configs')
#             .select('node_offline_threshold_seconds')
#             .eq('organization_id', str(org_id))
#             .limit(1),
#         )
        
#         threshold_seconds = 300  # Default 5 minutes
#         if org_result.data and len(org_result.data) > 0:
#             threshold_seconds = org_result.data[0].get('node_offline_threshold_seconds', 300)
        
#         # Get the node's last heartbeat
#         node_result = _execute_supabase(
#             'get_local_node_status.node',
#             lambda: sb.table('node_api_keys')
#             .select('id, node_id, last_seen_at')
#             .eq('org_id', str(org_id))
#             .eq('status', 'active')
#             .limit(1),
#         )
        
#         if not node_result.data or len(node_result.data) == 0:
#             return None
        
#         node = node_result.data[0]
#         last_seen = node.get('last_seen_at')
        
#         if not last_seen:
#             return {
#                 'offline': True,
#                 'last_heartbeat': None,
#                 'node_id': node.get('node_id'),
#             }
        
#         # Check if node is offline based on threshold
#         try:
#             from datetime import datetime, timezone, timedelta
#             last_seen_dt = datetime.fromisoformat(last_seen.replace('Z', '+00:00'))
#             now_dt = datetime.now(timezone.utc)
#             seconds_since_heartbeat = (now_dt - last_seen_dt).total_seconds()
#             is_offline = seconds_since_heartbeat > threshold_seconds
            
#             return {
#                 'offline': is_offline,
#                 'last_heartbeat': last_seen,
#                 'node_id': node.get('node_id'),
#             }
#         except Exception as e:
#             logger.warning(f'Could not parse heartbeat time: {e}')
#             return {
#                 'offline': True,
#                 'last_heartbeat': last_seen,
#                 'node_id': node.get('node_id'),
#             }
#     except Exception as e:
#         logger.warning(f'Could not get local node status for org {org_id}: {e}')
#         return None

# def get_recent_fallback_attendance(
#     org_id: str,
#     person_id: str,
#     branch_id: str | None = None,
#     within_seconds: int = 300,
# ) -> dict | None:
#     """
#     Get recent fallback/manual attendance marker for a person.
#     Returns the attendance record if found within the time window, None otherwise.
#     Used to show fallback markers when local node is offline.
#     """
#     try:
#         from datetime import datetime, timezone, timedelta
        
#         sb = get_supabase()
#         now = datetime.now(timezone.utc)
#         cutoff = now - timedelta(seconds=within_seconds)
#         cutoff_iso = cutoff.isoformat().replace('+00:00', 'Z')
        
#         query = (
#             sb.table('client_attendance')
#             .select('*')
#             .eq('organization_id', str(org_id))
#             .eq('person_id', str(person_id))
#             .eq('source', 'manual')  # Fallback/manual attendance
#             .gte('created_at', cutoff_iso)
#             .order('created_at', desc=True)
#             .limit(1)
#         )
        
#         if branch_id:
#             query = query.eq('branch_id', str(branch_id))
        
#         result = _execute_supabase('get_recent_fallback_attendance', lambda: query)
        
#         if result.data and len(result.data) > 0:
#             return result.data[0]
#         return None
#     except Exception as e:
#         logger.warning(f'Could not get fallback attendance for {org_id}/{person_id}: {e}')
#         return None

# def _local_node_camera_view(row: dict) -> dict:
#     """Shape one branch_cameras row into the payload local_node.camera_config
#     .normalize_camera() expects (id/camera_id, camera_name/name, rtsp_url/
#     rtspUrl). Single conversion point so get_node_config and any future
#     node-facing camera read stay identical in shape."""
#     camera_id = str(row.get('id'))
#     name = row.get('camera_name') or 'Camera'
#     rtsp_url = row.get('rtsp_url') or ''
#     return {
#         'id': camera_id,
#         'camera_id': camera_id,
#         'camera_name': name,
#         'name': name,
#         'channel': row.get('channel'),
#         'camera_type': row.get('camera_type') or 'nvr',
#         'stream_path': row.get('stream_path'),
#         'location': row.get('location'),
#         'rtsp_url': rtsp_url,
#         'rtspUrl': rtsp_url,
#         'enabled': bool(row.get('enabled', True)),
#     }

# def get_node_config(node_api_key: str) -> dict:
#     from support_db_staff import _branch_ui_id, _normalize_people_type
#     node = get_node_by_api_key(node_api_key)
#     org = _ensure_org_client_access(str(node['org_id']), 'Local node config sync')
#     branch = _get_branch_owned_by_org(str(node['org_id']), str(node['branch_id']))
#     branch_ui_id = _branch_ui_id(str(node['org_id']), str(node['branch_id']))

#     # branch_cameras + branch_network_configs are the tables
#     # _sync_local_node_camera_config actually writes to (see that function's
#     # docstring). client_onboarding_configs.cameras is onboarding *input*
#     # only — it is never guaranteed to be in sync with what a client edited
#     # afterward, so the node must never read it directly.
#     sb = get_supabase()
#     cameras_result = _execute_supabase(
#         'get_node_config.cameras',
#         lambda: (
#             sb.table('branch_cameras')
#             .select('*')
#             .eq('organization_id', str(node['org_id']))
#             .eq('branch_id', str(node['branch_id']))
#             .eq('enabled', True)
#             .order('channel')
#         ),
#     )
#     cameras = [_local_node_camera_view(row) for row in (cameras_result.data or [])]

#     capture_settings_result = _execute_supabase(
#         'get_node_config.capture_settings',
#         lambda: (
#             sb.table('attendance_capture_settings')
#             .select('people_type, mode, sync_delay_minutes')
#             .eq('org_id', str(node['org_id']))
#             .eq('branch_id', str(node['branch_id']))
#         ),
#     )
#     capture_settings_rows = capture_settings_result.data or []

#     sync_delay_minutes = 0
#     for row in capture_settings_rows:
#         try:
#             sync_delay_minutes = max(sync_delay_minutes, int(row.get('sync_delay_minutes') or 0))
#         except Exception:
#             continue

#     configured_people_types = sorted({
#         _normalize_people_type(row.get('people_type'), 'staff')
#         for row in capture_settings_rows
#         if row.get('people_type')
#     })

#     # Determine if shift mode is enabled for ANY people_type in this branch.
#     # If ANY attendance_capture_settings has mode='shift', then shift gating
#     # is active and the local node should enforce it. This prevents the
#     # fallback in shift_gate.is_event_within_shift() that would accept
#     # out-of-hours detections when shift_windows sync fails or is incomplete.
#     #
#     # BUGFIX: this used to read row.get('mode') against a query that only
#     # selected 'people_type' — 'mode' was never fetched, so this was always
#     # None and shift_mode_enabled was unconditionally False for every
#     # branch, silently disabling the exact safety switch this comment
#     # describes. Folded into the single capture_settings_result query above
#     # (which also now carries sync_delay_minutes) instead of a third
#     # round-trip to the same table.
#     shift_mode_enabled = any(
#         row.get('mode') == 'shift'
#         for row in capture_settings_rows
#     )

#     # shift_windows / staff_shift_windows are the two fields shift_gate.py's
#     # safety fallback depends on (shift_mode_enabled=True + no window found
#     # -> hold for review). Every OTHER query in this function goes through
#     # _execute_supabase's retry wrapper; these two previously did not — a
#     # single bad row (dangling shift_id_ref, transient Supabase hiccup)
#     # raised straight out of resolve_staff_shift_windows/
#     # resolve_branch_default_window, which had no caller-side try/except
#     # either, so the exception propagated out of get_node_config entirely,
#     # 500ing the WHOLE /v1/node/config response. Per node_service.run_cycle,
#     # a failed fetch_node_config() call updates NOTHING that cycle — the
#     # node just kept whatever shift_windows/staff_shift_windows it last had
#     # (frequently {}, from before any shift was even assigned), indefinitely,
#     # with zero visibility into why. Catching here means one bad row costs
#     # this branch its shift data for one poll cycle (~30s), not forever, and
#     # every other part of this response (cameras, capture settings, sync
#     # timing) keeps working even while shift data is being debugged.
#     shift_windows = {}
#     try:
#         for people_type in configured_people_types:
#             window = resolve_branch_default_window(str(node['org_id']), str(node['branch_id']), people_type)
#             if window:
#                 shift_windows[people_type] = window
#     except Exception:
#         logger.warning(
#             "get_node_config: resolve_branch_default_window failed for branch=%s — "
#             "sending shift_windows={} this cycle rather than 500ing the whole config sync",
#             str(node['branch_id']), exc_info=True,
#         )
#         shift_windows = {}

#     # Personal shift overrides (tier 2, client_staff.shift_id_ref) — the
#     # piece Local Node's shift_gate.py has been ready to consume since it
#     # added person_code-aware gating, but which get_node_config never
#     # actually sent down until now. See resolve_staff_shift_windows'
#     # docstring for the exact key shape ("people_type:person_code").
#     # AFTER
#     try:
#         staff_shift_windows = resolve_staff_shift_windows(str(node['org_id']), str(node['branch_id']))
#     except Exception:
#         logger.warning(
#             "get_node_config: resolve_staff_shift_windows failed for branch=%s — "
#             "sending staff_shift_windows={} this cycle rather than 500ing the whole config sync",
#             str(node['branch_id']), exc_info=True,
#         )
#         staff_shift_windows = {}

#     # Per-date manual attendance instructions — the highest-precedence
#     # gating tier, above both personal and branch-default shift. Reuses
#     # the exact same query /v1/node/poll-manual-instructions already runs,
#     # so a live detection is judged against an operator's override on
#     # FIRST touch instead of landing in held_for_review and only getting
#     # corrected ~20s later by ManualInstructionsWorker's separate
#     # write-to-attendance-row path. Same fail-open-empty posture as
#     # shift_windows/staff_shift_windows above — one bad poll cycle costs
#     # this branch its manual-instruction data for ~30s, not a 500 on the
#     # whole config sync.
#     try:
#         manual_instructions = list_pending_manual_instructions_for_branch(
#             str(node['org_id']), str(node['branch_id'])
#         )
#     except Exception:
#         logger.warning(
#             "get_node_config: list_pending_manual_instructions_for_branch failed for branch=%s — "
#             "sending manual_instructions=[] this cycle rather than 500ing the whole config sync",
#             str(node['branch_id']), exc_info=True,
#         )
#         manual_instructions = []

#     return {
#         'node_id': node.get('node_id'),
#         'org_id': str(node['org_id']),
#         'branch_id': str(node['branch_id']),
#         'branch_ui_id': branch_ui_id,
#         'attendance_mode': org.get('attendance_mode') or 'cloud',
#         'node_offline_threshold_seconds': org.get('node_offline_threshold_seconds'),
#         'organization': {
#             'id': str(node['org_id']),
#             'name': org.get('name'),
#             'attendance_mode': org.get('attendance_mode'),
#         },
#         'branch': branch,
#         'cameras': cameras,
#         'sync_poll_interval': int(os.environ.get('SYNC_POLL_INTERVAL', '30')),
#         'sync_delay_minutes': sync_delay_minutes,
#         'shift_mode_enabled': shift_mode_enabled,
#         'shift_windows': shift_windows,
#         'staff_shift_windows': staff_shift_windows,
#         'manual_instructions': manual_instructions,
#     }

# def poll_node_training_jobs(node_api_key: str, limit: int = 5) -> list[dict]:
#     from support_db_staff import get_client_staff_member
#     sb = get_supabase()
#     node = get_node_by_api_key(node_api_key)
#     _ensure_org_client_access(str(node['org_id']), 'Local node training sync')
#     safe_limit = max(1, min(int(limit or 5), 20))

#     result = (
#         sb.table('face_training_jobs')
#         .select('*')
#         .eq('org_id', str(node['org_id']))
#         .eq('branch_id', str(node['branch_id']))
#         .eq('status', 'pending')
#         .order('created_at')
#         .limit(safe_limit)
#         .execute()
#     )

#     jobs = []
#     now = _iso_now()
#     for job in result.data or []:
#         job_id = str(job['id'])
#         update_data = {
#             'status': 'processing',
#             'claimed_by_node_id': node.get('node_id'),
#             'claimed_at': now,
#             'updated_at': now,
#         }
#         try:
#             updated = sb.table('face_training_jobs').update(update_data).eq('id', job_id).eq('status', 'pending').execute()
#             claimed = (updated.data or [job])[0]
#         except Exception:
#             # Older migrations may not have claim columns yet. Keep polling usable.
#             updated = sb.table('face_training_jobs').update({'status': 'processing', 'updated_at': now}).eq('id', job_id).eq('status', 'pending').execute()
#             claimed = (updated.data or [job])[0]

#         staff_id = str(claimed.get('client_staff_id') or claimed.get('staff_id'))
#         staff = None
#         try:
#             staff = get_client_staff_member(staff_id)
#         except Exception as exc:
#             logger.warning(f'Could not attach staff to training job {job_id}: {exc}')

#         claimed['staff'] = staff
#         claimed['download_url'] = claimed.get('storage_path')
#         jobs.append(claimed)

#     return jobs

# def _replace_face_embeddings_cloud(
#     org_id: str,
#     staff_id: str,
#     embeddings: list[list[float]],
#     is_fallback_copy: bool,
#     source_job_id: str | None = None,
# ) -> int:
#     """Delete-then-insert this staff member's embeddings for one copy type
#     (primary vs fallback), scoped to (org_id, staff_id, is_fallback_copy).

#     Single write path for face_embeddings_cloud. Both the cloud-mode
#     training-job pipeline and the local-node embeddings-push pipeline call
#     this, so a retrain from either source cleanly replaces only its own
#     copy type without touching the other's vectors.
#     """
#     sb = get_supabase()
#     try:
#         (
#             sb.table('face_embeddings_cloud')
#             .delete()
#             .eq('org_id', str(org_id))
#             .eq('staff_id', str(staff_id))
#             .eq('is_fallback_copy', bool(is_fallback_copy))
#             .execute()
#         )
#     except Exception:
#         pass

#     rows = [{
#         'org_id': str(org_id),
#         'staff_id': str(staff_id),
#         'embedding': emb,
#         'is_fallback_copy': bool(is_fallback_copy),
#         'source_job_id': str(source_job_id) if source_job_id else None,
#     } for emb in embeddings]

#     if rows:
#         sb.table('face_embeddings_cloud').insert(rows).execute()

#     return len(rows)

# _LOCAL_NODE_EMBEDDING_SOFT_MIN = 3

# def _valid_embedding_list(value: Any) -> list[list[float]]:
#     """Return only real InsightFace-style numeric embedding vectors.

#     This prevents a node from accidentally marking training as successful when
#     it did not actually extract biometric vectors. Buffalo_L vectors are 512
#     floats; the >=128 guard keeps the function tolerant to model changes while
#     still rejecting empty/sample payloads.
#     """
#     valid: list[list[float]] = []
#     if not isinstance(value, list):
#         return valid

#     for item in value:
#         if not isinstance(item, list) or len(item) < 128:
#             continue
#         try:
#             vector = [float(x) for x in item]
#         except (TypeError, ValueError):
#             continue
#         valid.append(vector)

#     return valid

# def mark_node_training_job_trained(node_api_key: str, job_id: str, payload: dict) -> dict:
#     from support_db_organizations import get_organization
#     from support_db_staff import update_client_staff
#     sb = get_supabase()
#     node = get_node_by_api_key(node_api_key)
#     requested_status = str(payload.get('status') or 'trained').lower()
#     if requested_status not in ('trained', 'failed'):
#         raise ValueError('status must be trained or failed')

#     job_result = (
#         sb.table('face_training_jobs')
#         .select('*')
#         .eq('id', str(job_id))
#         .eq('org_id', str(node['org_id']))
#         .eq('branch_id', str(node['branch_id']))
#         .limit(1)
#         .execute()
#     )
#     if not job_result.data:
#         raise ValueError('Training job not found for this node')

#     job = job_result.data[0]
#     staff_id = str(job.get('client_staff_id') or job.get('staff_id'))
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
#             f'Training rejected by server: only {embedding_count} valid embeddings were submitted; '
#             f'at least {min_embeddings} are required.'
#         )

#     if status == 'trained':
#         org = get_organization(str(node['org_id']))
#         is_fallback = str(org.get('attendance_mode') or '').lower() == 'local'

#         _replace_face_embeddings_cloud(
#             org_id=str(node['org_id']),
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
#         'local_embedding_version': str(payload.get('local_embedding_version') or '') or None,
#     }

#     # Optional columns from the node sync migration. Keep this endpoint robust if
#     # the migration was run before these telemetry columns existed.
#     for key in ('training_duration_seconds', 'total_frames_processed', 'avg_quality'):
#         if key in payload:
#             update_payload[key] = payload.get(key)

#     updated = sb.table('face_training_jobs').update(update_payload).eq('id', str(job_id)).execute()
#     if not updated.data:
#         raise RuntimeError('Failed to update training job')

#     return updated.data[0]

# def _node_attendance_metadata(item: dict) -> dict:
#     """Build safe attendance metadata for node-submitted events.

#     The attendance.source column has a database CHECK constraint. The local
#     node endpoint is camera-scoped, so the stored source must remain the stable
#     DB value `camera`. Detailed local origin labels such as
#     `local_node_manual_test`, `local_node_camera`, or `local_node_buffered` are
#     preserved inside metadata instead of being written into the constrained
#     source column.
#     """
#     metadata = item.get('metadata') if isinstance(item.get('metadata'), dict) else {}
#     metadata = dict(metadata)

#     raw_source = str(item.get('source') or '').strip()
#     if raw_source and raw_source != 'camera':
#         metadata.setdefault('raw_source', raw_source)

#     return metadata

# def push_node_attendance(node_api_key: str, payload: dict) -> dict:
#     """Accept attendance events from a local node.

#     Identity contract: the node knows a person only as (people_type, person_code)
#     — it never holds a client_staff.id UUID, by design (trainer_desktop and the
#     local node are intentionally airgapped from Supabase identity). Each event
#     is resolved to a client_staff row scoped to this node's own org/branch,
#     exactly as _assert_unique_client_staff_person_code does at staff-creation
#     time. org_id/branch_id come from the authenticated node_api_key, never from
#     the request body, so a node cannot write into another branch's data.
#     """
#     from support_db_attendance_dashboard import _dashboard_day_window_utc
#     from support_db_internal import _support_text
#     from support_db_staff import _normalize_people_type
#     sb = get_supabase()
#     node = get_node_by_api_key(node_api_key)
#     _ensure_org_client_access(str(node['org_id']), 'Local node attendance sync')

#     events = payload.get('logs') if isinstance(payload.get('logs'), list) else []
#     results: list[dict] = []

#     for item in events:
#         if not isinstance(item, dict):
#             continue

#         local_event_id = _support_text(item.get('local_event_id'))
#         people_type = _normalize_people_type(item.get('people_type'), 'staff')
#         person_code = _support_text(item.get('person_code'))

#         if not local_event_id or not person_code:
#             results.append({
#                 'local_event_id': local_event_id or None,
#                 'status': 'rejected',
#                 'reason': 'local_event_id and person_code are required',
#             })
#             continue

#         staff_result = (
#             sb.table('client_staff')
#             .select('id, name, is_archived, status, shift_id_ref, department_id, check_in_grace_override, check_out_grace_override, person_code')
#             .eq('org_id', str(node['org_id']))
#             .eq('branch_id', str(node['branch_id']))
#             .eq('people_type', people_type)
#             .ilike('person_code', person_code)
#             .eq('is_archived', False)
#             .neq('status', 'inactive')
#             .limit(1)
#             .execute()
#         )
#         staff = staff_result.data[0] if staff_result.data else None

#         # Fallback: a local node's embedding package (person_code from the
#         # trainer_desktop enrollment CSV, e.g. "3") is not guaranteed to be
#         # the same string as client_staff.person_code (zero-padded in this
#         # dashboard's Staff ID convention, e.g. "0003") — same identity, two
#         # representations. The exact ilike above only catches an identical
#         # string. Only attempted when person_code is purely numeric, so this
#         # can never accidentally widen matching for alphanumeric codes (e.g.
#         # a registration number containing letters) — those still require an
#         # exact match, unchanged from before.
#         #
#         # Both queries here exclude archived/inactive staff — a stale or
#         # removed enrollment must never silently absorb a new detection
#         # just because its person_code, digit-stripped, still collides with
#         # someone currently active. If more than one ACTIVE row still
#         # collides, that's a real data problem (duplicate/ambiguous codes)
#         # and we refuse to guess rather than mis-attribute the event.
#         if staff is None and person_code.isdigit():
#             same_scope_result = (
#                 sb.table('client_staff')
#                 .select('id, name, is_archived, status, shift_id_ref, department_id, check_in_grace_override, check_out_grace_override, person_code')
#                 .eq('org_id', str(node['org_id']))
#                 .eq('branch_id', str(node['branch_id']))
#                 .eq('people_type', people_type)
#                 .eq('is_archived', False)
#                 .neq('status', 'inactive')
#                 .execute()
#             )
#             target = int(person_code)
#             matches = [
#                 c for c in (same_scope_result.data or [])
#                 if str(c.get('person_code') or '').strip().isdigit()
#                 and int(str(c.get('person_code')).strip()) == target
#             ]
#             if len(matches) == 1:
#                 staff = matches[0]
#             elif len(matches) > 1:
#                 logger.warning(
#                     "push_node_attendance: person_code %s matches %d active staff "
#                     "rows in org=%s branch=%s — refusing to guess, dropping event",
#                     person_code, len(matches), node['org_id'], node['branch_id'],
#                 )

#         if staff is None:
#             logger.warning(
#                 f'Attendance skipped: no client_staff match for '
#                 f'people_type={people_type} person_code={person_code} in node scope'
#             )
#             results.append({
#                 'local_event_id': local_event_id,
#                 'status': 'skipped',
#                 'reason': 'No matching person found in this branch',
#             })
#             continue

#         if staff.get('is_archived') or str(staff.get('status') or 'active') == 'inactive':
#             results.append({
#                 'local_event_id': local_event_id,
#                 'status': 'skipped',
#                 'reason': 'Person is archived or inactive',
#             })
#             continue

#         event_time_raw = item.get('marked_at') or item.get('timestamp') or _iso_now()
#         try:
#             event_dt = datetime.fromisoformat(str(event_time_raw).replace('Z', '+00:00'))
#         except Exception:
#             event_dt = datetime.now(timezone.utc)

#         instruction_id = _node_attendance_metadata(item).get('instruction_id')
#         window = (
#             resolve_manual_instruction_window(str(node['org_id']), instruction_id)
#             if instruction_id else None
#         ) or resolve_timing_source(
#             org_id=str(node['org_id']),
#             branch_id=str(node['branch_id']),
#             staff=staff,
#             people_type=people_type,
#             event_time_utc=event_dt,
#         )
#         branch_zone = _get_branch_timezone(sb, str(node['org_id']), str(node['branch_id']))

#         # Same UTC day-window convention _dashboard_day_window_utc already
#         # uses elsewhere — kept consistent rather than introducing a second
#         # day-boundary definition on this call path.
#         _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)
#         existing_result = (
#             sb.table('attendance')
#             # day_status must be selected here -- _maybe_notify_payroll_decision
#             # below compares node_day_status against existing.get('day_status')
#             # to detect the transition INTO a classified state. Without it,
#             # existing.get('day_status') is always None (the key is simply
#             # absent from the row), so that comparison can never match and
#             # the notification fires on every re-sync of an already-
#             # classified row instead of only once, on the actual transition.
#             .select('id, check_out_timestamp, day_status')
#             .eq('org_id', str(node['org_id']))
#             .eq('staff_id', str(staff['id']))
#             .gte('timestamp', day_start_iso)
#             .lt('timestamp', day_end_iso)
#             .limit(1)
#             .execute()
#         )
#         existing = existing_result.data[0] if existing_result.data else None

#         has_check_out_payload = bool(item.get('check_out_marked_at'))

#         # node_day_status/node_notes/node_hold_reason mirror what
#         # attendance_sync_worker.py forwards for the checkout-hold feature
#         # (see local_db.py's record_attendance_local checkout branch and
#         # the held-checkout/check-in resolution functions). 'day_status' is
#         # a DELIBERATELY separate column from this table's own 'status'
#         # column — 'status' here is the check-in timing classification
#         # (on_time/late/early/unscheduled, from resolve_check_in_status),
#         # while the node's status field is day-level (present/half_day/
#         # short_leave/late/overtime). Reusing 'status' for both would
#         # silently corrupt whichever one lost the collision.
#         #
#         # short_leave/late added alongside half_day/overtime: the local
#         # node's held-review screen resolves a late check-in to one of
#         # late/short_leave/half_day, and an early checkout to one of
#         # early-left (notes-only, status untouched)/short_leave/half_day —
#         # see local_db.mark_held_check_ins_late,
#         # mark_held_check_ins_short_leave, mark_held_checkouts_short_leave,
#         # mark_held_checkouts_early_left, and mark_held_checkouts_late (the
#         # late-CHECKOUT hold's own late/overtime pair). Without 'late' and
#         # 'short_leave' here, an operator's decision would silently
#         # collapse to 'present' the moment it reached the cloud, discarding
#         # it entirely.
#         node_day_status = _support_text(item.get('status')).lower() or 'present'
#         if node_day_status not in ('present', 'half_day', 'short_leave', 'late', 'overtime'):
#             node_day_status = 'present'
#         node_notes = _support_text(item.get('notes')) or None
#         node_hold_reason = _support_text(item.get('check_out_hold_reason')).lower() or None
#         if node_hold_reason not in ('early', 'late'):
#             node_hold_reason = None

#         # check_in_confirmed: whether `timestamp` below is a REAL confirmed
#         # check-in or just an audit-trail sighting time on a row resolved
#         # via mark_held_check_ins_half_day (local_db.py). Defaults True —
#         # older node builds that never send this key (pre-dating the
#         # check-in-hold feature) keep behaving exactly as before, where
#         # every synced check-in was implicitly confirmed.
#         node_check_in_confirmed = bool(item.get('check_in_confirmed', True))
#         # Still non-NULL only if this row is being flushed WITHOUT going
#         # through confirm_held_check_ins / mark_held_check_ins_half_day
#         # first (e.g. operator hit "Sync selected" directly on a held late
#         # check-in) — mirrors node_hold_reason's checkout-side comment.
#         node_check_in_hold_reason = _support_text(item.get('check_in_hold_reason')).lower() or None
#         if node_check_in_hold_reason not in ('late',):
#             node_check_in_hold_reason = None

#         # Computed once and reused on every write path below (insert AND
#         # every update branch) — previously this was only computed inside
#         # `if not existing:`, so status/timestamp were written on a row's
#         # very first sync and then FROZEN forever: a checkout sync, a
#         # held-checkout resolution, or any other update to an existing row
#         # never touched them again. If the row's first-ever sync happened
#         # under a since-corrected shift config (or captured a since-
#         # superseded marked_at — see record_attendance_local's
#         # check_in_refreshed/window_closed corrections), the dashboard
#         # kept showing the stale original classification/time forever,
#         # even after the node re-synced the corrected check-in. Recomputing
#         # here on every write self-heals that: the cloud's check-in
#         # timestamp and classification always converge to whatever the
#         # node currently reports as authoritative for this event.
#         check_in_status = resolve_check_in_status(window, event_dt, branch_zone)

#         _CLASSIFIED_DAY_STATUSES = ('half_day', 'short_leave', 'late', 'overtime')

#         def _maybe_notify_payroll_decision(
#             previous_day_status: str | None, attendance_id, check_out_hint=None,
#         ) -> None:
#             """Fires the payroll-decision-pending notification, AND (new)
#             creates the linked leave/overtime adjustment record, only on
#             the transition INTO a classified day_status -- node_day_status
#             is recomputed on every sync (see the comment above), so
#             comparing against what was there before this write is what
#             stops an already-classified, still-undecided row from
#             re-notifying/re-creating on every heartbeat. previous_day_status
#             is None for a brand-new insert (nothing to compare against, so
#             any classified value on arrival counts as a transition).

#             check_out_hint: this row's check_out_timestamp as of THIS
#             write, if any (may come from the existing row or from this
#             sync's own payload depending on which call site passes it) --
#             used only to decide half_day's first_half/second_half split
#             and as the event-time anchor for short_leave/overtime. See
#             create_half_day_adjustment's half_day_period comment below for
#             why presence of a checkout is what drives that split for the
#             local-node path (which has no explicit check_in/check_out leg
#             the way the mobile exceptions flow does).

#             Local-node classification never auto-linked to Leave/Overtime
#             Management before this -- only the notification fired, leaving
#             admins with a Payroll Decisions entry but no leave/overtime
#             request to actually approve/reject. 'late' deliberately still
#             creates nothing here (see create_short_leave_adjustment's
#             docstring on why 'late' is a count, not a record)."""
#             if node_day_status not in _CLASSIFIED_DAY_STATUSES or not attendance_id:
#                 return
#             if node_day_status == previous_day_status:
#                 return
#             try:
#                 _attendance_exceptions.notify_payroll_decision_pending(
#                     org_id=str(node['org_id']),
#                     branch_id=str(node['branch_id']),
#                     staff_id=str(staff['id']),
#                     staff_name=staff.get('name') or 'Staff member',
#                     attendance_id=attendance_id,
#                     day_status=node_day_status,
#                     event_local_str=event_dt.astimezone(branch_zone).strftime('%b %d, %I:%M %p'),
#                 )
#             except Exception:
#                 pass

#             if node_day_status == 'overtime':
#                 try:
#                     _attendance_exceptions.create_overtime_adjustment(
#                         org_id=str(node['org_id']),
#                         staff_id=str(staff['id']),
#                         attendance_id=str(attendance_id),
#                         branch_id=str(node['branch_id']),
#                         check_out_timestamp=check_out_hint or event_time_raw,
#                     )
#                 except Exception:
#                     logger.exception(
#                         'Failed to create overtime request for local-node attendance=%s',
#                         attendance_id,
#                     )
#             elif node_day_status == 'short_leave':
#                 try:
#                     _attendance_exceptions.create_short_leave_adjustment(
#                         org_id=str(node['org_id']),
#                         staff_id=str(staff['id']),
#                         attendance_id=str(attendance_id),
#                         branch_id=str(node['branch_id']),
#                         event_timestamp=check_out_hint or event_time_raw,
#                     )
#                 except Exception:
#                     logger.exception(
#                         'Failed to create short-leave request for local-node attendance=%s',
#                         attendance_id,
#                     )
#             elif node_day_status == 'half_day':
#                 # Heuristic: the node has no explicit check_in/check_out
#                 # "leg" the way the mobile exceptions flow does (see
#                 # _on_half_day_decided there) -- half_day here is a single
#                 # day-level classification with no leg attached to it. A
#                 # checkout already on the row (this sync's own payload, or
#                 # one synced earlier) reads as the missing half being the
#                 # AFTERNOON (second_half: the person was here in the
#                 # morning, so the checkout exists, but left/was marked
#                 # half-day after); no checkout yet reads as the missing
#                 # half being the MORNING (first_half: a late/absent
#                 # check-in, nothing to check out from yet). Mirrors
#                 # mark_held_check_ins_half_day (check-in side, no checkout)
#                 # vs mark_held_checkouts_half_day (checkout side) in
#                 # local_db.py.
#                 half_day_period = 'second_half' if check_out_hint else 'first_half'
#                 try:
#                     _attendance_exceptions.create_half_day_adjustment(
#                         org_id=str(node['org_id']),
#                         staff_id=str(staff['id']),
#                         attendance_id=str(attendance_id),
#                         half_day_period=half_day_period,
#                         branch_id=str(node['branch_id']),
#                         event_timestamp=check_out_hint or event_time_raw,
#                     )
#                 except Exception:
#                     logger.exception(
#                         'Failed to create half-day leave for local-node attendance=%s',
#                         attendance_id,
#                     )

#         if not existing:
#             insert_row = {
#                 'org_id': str(node['org_id']),
#                 'branch_id': str(node['branch_id']),
#                 'staff_id': str(staff['id']),
#                 'timestamp': event_time_raw,
#                 'status': check_in_status,
#                 'day_status': node_day_status,
#                 'notes': node_notes,\
#                 'check_out_hold_reason': node_hold_reason,
#                 'check_in_confirmed': node_check_in_confirmed,  
#                 'check_out_hold_reason': node_hold_reason,
#                 'source': 'camera',
#                 # Additive, non-breaking classification alongside 'source'
#                 # (which stays 'camera' for both local-node and cloud
#                 # detections and is left untouched — see capture_channel's
#                 # own migration note for why a new column, not a repurposed
#                 # one). Exactly one of 'local_node' / 'cloud' / 'mobile_app'
#                 # per row, set once at insert; each of the three attendance
#                 # insert sites in this module writes exactly one value, by
#                 # construction of which function it is.
#                 'capture_channel': 'local_node',
#                 'confidence': float(item.get('confidence') or 0),
#                 'camera_id': _support_text(item.get('camera_id')) or None,
#                 'node_id': node.get('node_id'),
#                 'device_id': _support_text(item.get('device_id')) or node.get('node_id'),
#                 'metadata': _node_attendance_metadata(item),
#             }

#             # A row can arrive with BOTH legs already filled in on its very first
#             # sync (check-in and check-out both happened locally before the first
#             # sync attempt fired) — "no existing cloud row" just means this is the
#             # first sync, not that there's no checkout to record. Without this, the
#             # checkout half of the payload was silently dropped on insert, and the
#             # row then sat with a null check_out_timestamp forever, since every
#             # later sync of the same row hits the update branch instead.
#             if has_check_out_payload and window and window.get('capture_check_out'):
#                 check_out_dt_raw = item.get('check_out_marked_at')
#                 try:
#                     check_out_dt = datetime.fromisoformat(str(check_out_dt_raw).replace('Z', '+00:00'))
#                 except Exception:
#                     check_out_dt = event_dt
#                 overtime = _find_approved_overtime(
#                     sb, str(node['org_id']), str(staff['id']), check_out_dt.astimezone(branch_zone).date()
#                 )
#                 check_out_status = resolve_check_out_status(
#                     window, check_out_dt, branch_zone,
#                     overtime_hours=float(overtime['hours']) if overtime else 0,
#                 )
#                 check_out_metadata_raw = item.get('check_out_metadata')
#                 insert_row.update({
#                     'check_out_timestamp': check_out_dt_raw,
#                     'check_out_status': check_out_status,
#                     'check_out_confidence': float(item.get('check_out_confidence') or 0),
#                     'check_out_camera_id': _support_text(item.get('check_out_camera_id')) or None,
#                     'check_out_metadata': check_out_metadata_raw if isinstance(check_out_metadata_raw, dict) else {},
#                 })

#             insert_result = sb.table('attendance').insert(insert_row).execute()
#             if insert_result.data:
#                 _maybe_notify_payroll_decision(
#                     None, insert_result.data[0].get('id'),
#                     check_out_hint=insert_row.get('check_out_timestamp'),
#                 )
#                 results.append({'local_event_id': local_event_id, 'status': 'inserted'})
#             else:
#                 results.append({'local_event_id': local_event_id, 'status': 'skipped', 'reason': 'Insert failed'})
#             continue

#         # A held checkout resolved via mark_held_checkouts_half_day,
#         # mark_held_checkouts_short_leave, or mark_held_checkouts_late
#         # clears/re-confirms check_out_marked_at locally (see local_db.py's
#         # docstrings for each) — there's a day-level outcome (half_day/
#         # short_leave/late/overtime) and/or an operator note that must
#         # still reach the cloud even when there's no NEW checkout payload
#         # in this sync batch. Without this branch, those actions would
#         # silently never sync anything once resolved, since
#         # has_check_out_payload would be False and the row would just fall
#         # through to 'already_marked'.
#         has_resolution_update = (
#             node_day_status in ('half_day', 'short_leave', 'late', 'overtime')
#             or node_notes is not None or node_hold_reason is not None
#             or node_check_in_hold_reason is not None
#             or node_check_in_confirmed != bool(existing.get('check_in_confirmed', True))
#         )

#         if not has_check_out_payload:
#             if not has_resolution_update:
#                 results.append({'local_event_id': local_event_id, 'status': 'already_marked'})
#                 continue
#             resolution_update = (
#                 sb.table('attendance')
#                 .update({
#                     'timestamp': event_time_raw,
#                     'status': check_in_status,
#                     'day_status': node_day_status,
#                     'notes': node_notes,
#                     'check_out_hold_reason': node_hold_reason,
#                     'check_in_confirmed': node_check_in_confirmed,         
#                     'check_in_hold_reason': node_check_in_hold_reason,
#                 })
#                 .eq('id', existing['id'])
#                 .execute()
#             )
#             if resolution_update.data:
#                 _maybe_notify_payroll_decision(
#                     existing.get('day_status'), existing['id'],
#                     check_out_hint=existing.get('check_out_timestamp'),
#                 )
#                 results.append({'local_event_id': local_event_id, 'status': 'updated'})
#             else:
#                 results.append({'local_event_id': local_event_id, 'status': 'skipped', 'reason': 'Update failed'})
#             continue

#         if not (window and window.get('capture_check_out')):
#             results.append({'local_event_id': local_event_id, 'status': 'already_marked'})
#             continue

#         check_out_dt_raw = item.get('check_out_marked_at')
#         try:
#             check_out_dt = datetime.fromisoformat(str(check_out_dt_raw).replace('Z', '+00:00'))
#         except Exception:
#             check_out_dt = event_dt

#         # Last-write-wins: the node refreshes its local checkout time on
#         # every sighting after check-in and may sync the same day's
#         # record multiple times as the person stays in view. Only guard
#         # against a genuinely out-of-order delivery (a stale retry
#         # arriving after a newer sync already landed) — never regress a
#         # later checkout time back to an earlier one.
#         existing_check_out_raw = existing.get('check_out_timestamp')
#         if existing_check_out_raw:
#             try:
#                 existing_check_out_dt = datetime.fromisoformat(str(existing_check_out_raw).replace('Z', '+00:00'))
#                 if check_out_dt <= existing_check_out_dt:
#                     # The checkout TIME itself isn't advancing — typically
#                     # because a held row's informative check_out_marked_at
#                     # was already synced once via an explicit "sync
#                     # selected" on the still-held row, and this later sync
#                     # is the operator's resolution (confirm/half-day/
#                     # leave-open) catching up. confirm_held_checkouts in
#                     # particular never changes check_out_marked_at, only
#                     # clears check_out_hold_reason locally — so that clear
#                     # must still reach the cloud even though the timestamp
#                     # is unchanged, or a resolved row would stay flagged as
#                     # held forever.
#                     if has_resolution_update:
#                         resolution_update = (
#                             sb.table('attendance')
#                             .update({
#                                 'timestamp': event_time_raw,
#                                 'status': check_in_status,
#                                 'day_status': node_day_status,
#                                 'notes': node_notes,
#                                 'check_out_hold_reason': node_hold_reason,
#                             })
#                             .eq('id', existing['id'])
#                             .execute()
#                         )
#                         if resolution_update.data:
#                             _maybe_notify_payroll_decision(
#                                 existing.get('day_status'), existing['id'],
#                                 check_out_hint=existing_check_out_raw,
#                             )
#                             results.append({'local_event_id': local_event_id, 'status': 'updated'})
#                         else:
#                             results.append({'local_event_id': local_event_id, 'status': 'skipped', 'reason': 'Update failed'})
#                     else:
#                         results.append({'local_event_id': local_event_id, 'status': 'already_marked'})
#                     continue
#             except Exception:
#                 pass
#         overtime = _find_approved_overtime(
#             sb, str(node['org_id']), str(staff['id']), check_out_dt.astimezone(branch_zone).date()
#         )
#         check_out_status = resolve_check_out_status(
#             window, check_out_dt, branch_zone,
#             overtime_hours=float(overtime['hours']) if overtime else 0,
#         )
#         check_out_metadata_raw = item.get('check_out_metadata')

#         update_result = (
#             sb.table('attendance')
#             .update({
#                 'timestamp': event_time_raw,
#                 'status': check_in_status,
#                 'check_out_timestamp': check_out_dt_raw,
#                 'check_out_status': check_out_status,
#                 'check_out_confidence': float(item.get('check_out_confidence') or 0),
#                 'check_out_camera_id': _support_text(item.get('check_out_camera_id')) or None,
#                 'check_out_metadata': check_out_metadata_raw if isinstance(check_out_metadata_raw, dict) else {},
#                 # Carried through here too — covers a held row synced as-is
#                 # (hold_reason still set, so the dashboard can flag it as
#                 # "resolved via raw sync, unreviewed" per
#                 # attendance_sync_worker.py's comment) as well as a normal
#                 # confirmed checkout, which needs any earlier hold_reason/
#                 # notes cleared or refreshed on this same write.
#                 'day_status': node_day_status,
#                 'notes': node_notes,
#                 'check_out_hold_reason': node_hold_reason,
#                 'check_in_confirmed': node_check_in_confirmed,     
#                 'check_in_hold_reason': node_check_in_hold_reason, 
#             })
#             .eq('id', existing['id'])
#             .execute()
#         )
#         if update_result.data:
#             _maybe_notify_payroll_decision(
#                 existing.get('day_status'), existing['id'],
#                 check_out_hint=check_out_dt_raw,
#             )
#             results.append({'local_event_id': local_event_id, 'status': 'updated'})
#         else:
#             results.append({'local_event_id': local_event_id, 'status': 'skipped', 'reason': 'Update failed'})

#     return {
#         'inserted_count': sum(1 for r in results if r['status'] == 'inserted'),
#         'updated_count': sum(1 for r in results if r['status'] == 'updated'),
#         'results': results,
#     }

# def push_node_embeddings(node_api_key: str, payload: dict) -> dict:
#     """Accept trainer_desktop-derived face embeddings pushed from a local
#     node's zip import, and mirror them into Supabase as fallback-copy
#     embeddings so cloud-mode recognition keeps working if the node goes
#     offline.

#     Identity contract matches push_node_attendance: the node never holds a
#     client_staff.id UUID. Each record is resolved to a client_staff row
#     scoped to this node's own org/branch via (people_type, person_code).
#     org_id/branch_id come from the authenticated node_api_key, never from
#     the request body.
#     """
#     from support_db_internal import _support_text
#     from support_db_staff import _normalize_people_type, update_client_staff
#     sb = get_supabase()
#     node = get_node_by_api_key(node_api_key)
#     _ensure_org_client_access(str(node['org_id']), 'Local node embeddings sync')

#     records = payload.get('records') if isinstance(payload.get('records'), list) else []
#     results: list[dict] = []

#     for record in records:
#         if not isinstance(record, dict):
#             continue

#         people_type = _normalize_people_type(record.get('people_type'), 'staff')
#         person_code = _support_text(record.get('person_code'))

#         if not person_code:
#             results.append({
#                 'people_type': people_type,
#                 'person_code': None,
#                 'status': 'rejected',
#                 'reason': 'person_code is required',
#             })
#             continue

#         staff_result = (
#             sb.table('client_staff')
#             .select('id, name, is_archived, status')
#             .eq('org_id', str(node['org_id']))
#             .eq('branch_id', str(node['branch_id']))
#             .eq('people_type', people_type)
#             .ilike('person_code', person_code)
#             .limit(1)
#             .execute()
#         )

#         if not staff_result.data:
#             logger.warning(
#                 f'Embeddings push skipped: no client_staff match for '
#                 f'people_type={people_type} person_code={person_code} in node scope'
#             )
#             results.append({
#                 'people_type': people_type,
#                 'person_code': person_code,
#                 'status': 'skipped',
#                 'reason': 'No matching person found in this branch',
#             })
#             continue

#         staff = staff_result.data[0]
#         if staff.get('is_archived') or str(staff.get('status') or 'active') == 'inactive':
#             results.append({
#                 'people_type': people_type,
#                 'person_code': person_code,
#                 'status': 'skipped',
#                 'reason': 'Person is archived or inactive',
#             })
#             continue

#         valid_embeddings = _valid_embedding_list(record.get('embeddings') or [])
#         if not valid_embeddings:
#             results.append({
#                 'people_type': people_type,
#                 'person_code': person_code,
#                 'status': 'rejected',
#                 'reason': 'No valid embedding vectors were submitted',
#             })
#             continue

#         if len(valid_embeddings) < _LOCAL_NODE_EMBEDDING_SOFT_MIN:
#             # Soft warning only — trainer_desktop already curates quality
#             # before packaging, unlike raw camera captures which need a
#             # hard floor (see mark_node_training_job_trained's min_embeddings).
#             logger.warning(
#                 f'Local-node embeddings push for person_code={person_code} '
#                 f'submitted only {len(valid_embeddings)} valid vectors '
#                 f'(soft minimum is {_LOCAL_NODE_EMBEDDING_SOFT_MIN}); accepting anyway.'
#             )

#         staff_id = str(staff['id'])
#         written = _replace_face_embeddings_cloud(
#             org_id=str(node['org_id']),
#             staff_id=staff_id,
#             embeddings=valid_embeddings,
#             is_fallback_copy=True,
#             source_job_id=None,
#         )

#         update_client_staff(staff_id, {
#             'face_training_status': 'trained',
#             'is_face_verified': True,
#         })

#         results.append({
#             'people_type': people_type,
#             'person_code': person_code,
#             'staff_id': staff_id,
#             'status': 'synced',
#             'embedding_count': written,
#         })

#     return {
#         'synced_count': sum(1 for r in results if r['status'] == 'synced'),
#         'results': results,
#     }

# def get_staff_face_embeddings(org_id: str, staff_id: str) -> list[list[float]]:
#     """Return one staff member's raw enrolled embedding vectors (merges
#     primary cloud-trained and fallback local-node-imported copies, same
#     "more vectors only improves match tolerance" reasoning as
#     get_org_recognition_embeddings). Used by mobile self-verify
#     (client_field_attendance_routes.verify_face) for a 1:1 check against
#     the CALLER's own enrollment, as opposed to that function's whole-org
#     1:N read for camera-based recognition -- different callers, same
#     underlying face_embeddings_cloud table.

#     Returns an empty list (never raises) for "not enrolled yet" -- the
#     route turns that into a friendly "contact your admin" message rather
#     than a 500.
#     """
#     sb = get_supabase()
#     org_key = str(org_id)
#     staff_key = str(staff_id)

#     result = _execute_supabase(
#         'get_staff_face_embeddings',
#         lambda: (
#             sb.table('face_embeddings_cloud')
#             .select('embedding')
#             .eq('org_id', org_key)
#             .eq('staff_id', staff_key)
#         ),
#     )
#     return [
#         row['embedding'] for row in (result.data or [])
#         if isinstance(row.get('embedding'), list) and row.get('embedding')
#     ]

# def get_org_recognition_embeddings(org_id: str, branch_id: str | None = None) -> list[dict]:
#     """Return every attendance-eligible person's raw embedding vectors for
#     one Supabase-tenant organization (optionally scoped to one branch), for
#     building an in-memory recognition cache.

#     Merges primary (cloud-trained) and fallback (local-node-imported)
#     copies for the same person — both are genuine face vectors; more
#     vectors only improves match tolerance across attendance_mode switches.
#     """
#     from support_db_staff import _normalize_people_type
#     sb = get_supabase()
#     org_key = str(org_id)

#     staff_query = (
#         sb.table('client_staff')
#         .select('id, name, people_type, branch_id')
#         .eq('org_id', org_key)
#         .eq('role', 'staff')
#         .eq('is_archived', False)
#         .neq('status', 'inactive')
#     )
#     if branch_id:
#         staff_query = staff_query.eq('branch_id', str(branch_id))

#     staff_result = _execute_supabase('get_org_recognition_embeddings.staff', lambda: staff_query)
#     staff_rows = staff_result.data or []
#     if not staff_rows:
#         return []

#     staff_ids = [str(row['id']) for row in staff_rows if row.get('id')]
#     staff_by_id = {str(row['id']): row for row in staff_rows}

#     embeddings_result = _execute_supabase(
#         'get_org_recognition_embeddings.embeddings',
#         lambda: (
#             sb.table('face_embeddings_cloud')
#             .select('staff_id, embedding')
#             .eq('org_id', org_key)
#             .in_('staff_id', staff_ids)
#         ),
#     )

#     grouped: dict[str, list[list[float]]] = {}
#     for row in (embeddings_result.data or []):
#         staff_id = str(row.get('staff_id') or '')
#         embedding = row.get('embedding')
#         if not staff_id or not isinstance(embedding, list) or not embedding:
#             continue
#         grouped.setdefault(staff_id, []).append(embedding)

#     people = []
#     for staff_id, embeddings in grouped.items():
#         staff = staff_by_id.get(staff_id)
#         if not staff:
#             continue
#         people.append({
#             'staff_id': staff_id,
#             'name': staff.get('name') or 'Unknown',
#             'people_type': _normalize_people_type(staff.get('people_type'), 'staff'),
#             'branch_id': str(staff.get('branch_id') or ''),
#             'embeddings': embeddings,
#         })

#     return people

# def record_cloud_camera_attendance(
#     org_id: str,
#     branch_id: str | None,
#     staff_id: str,
#     confidence: float,
#     source: str,
#     camera_id: str | None = None,
#     device_id: str | None = None,
#     metadata: dict | None = None,
# ) -> dict:
#     """Record one cloud-camera-recognized attendance event.

#     Mirrors push_node_attendance's insert-or-update contract exactly, so
#     Live CCTV cloud recognition and local-node sync produce identical
#     behavior for the same branch/people_type settings — one source of truth
#     (attendance_capture_settings / shifts / overrides), two capture methods.

#     The first detection of a person on a given UTC day is a check-in. Any
#     later detection the same day is a check-out candidate if the resolved
#     timing window has capture_check_out enabled; otherwise it's a no-op
#     ('already_marked'), same as the previous behavior. The caller
#     (app.py's _ai_loop) has no explicit "this is a checkout" signal today —
#     re-detection later in the day is what drives it, since this stream
#     runs continuously rather than being triggered per action.
#     """
#     from support_db_attendance_dashboard import _dashboard_day_window_utc
#     sb = get_supabase()
#     org_key = str(org_id)
#     staff_key = str(staff_id)
#     _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)

#     staff_result = (
#         sb.table('client_staff')
#         .select('id, name, people_type, shift_id_ref, department_id, check_in_grace_override, check_out_grace_override')
#         .eq('id', staff_key)
#         .eq('org_id', org_key)
#         .limit(1)
#         .execute()
#     )
#     staff_row = staff_result.data[0] if staff_result.data else {'id': staff_key}
#     people_type = staff_row.get('people_type') or 'staff'

#     event_dt = datetime.now(timezone.utc)
#     window = resolve_timing_source(
#         org_id=org_key,
#         branch_id=str(branch_id) if branch_id else None,
#         staff=staff_row,
#         people_type=people_type,
#         event_time_utc=event_dt,
#     )
#     branch_zone = _get_branch_timezone(sb, org_key, str(branch_id)) if branch_id else ZoneInfo('UTC')

#     existing_result = (
#         sb.table('attendance')
#         .select('id, check_out_timestamp, notes')
#         .eq('org_id', org_key)
#         .eq('staff_id', staff_key)
#         .gte('timestamp', day_start_iso)
#         .lt('timestamp', day_end_iso)
#         .limit(1)
#         .execute()
#     )
#     existing = existing_result.data[0] if existing_result.data else None
#     now = _iso_now()

#     if not existing:
#         status = resolve_check_in_status(window, event_dt, branch_zone)
#         row = {
#             'org_id': org_key,
#             'branch_id': str(branch_id) if branch_id else None,
#             'staff_id': staff_key,
#             'timestamp': now,
#             'status': status,
#             'source': 'camera',
#             'capture_channel': 'cloud',
#             'confidence': float(confidence or 0),
#             'camera_id': str(camera_id) if camera_id else None,
#             'device_id': str(device_id) if device_id else None,
#             'metadata': _node_attendance_metadata({'source': source, 'metadata': metadata or {}}),
#         }
#         row.update(_attendance_exceptions.check_in_write_fields(status))
#         result = sb.table('attendance').insert(row).execute()
#         if not result.data:
#             raise RuntimeError('Failed to record cloud camera attendance')
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
#             'staff_id': staff_key,
#             'attendance_id': new_id,
#             'marked_at': now,
#             'status': status,
#         }

#     if existing.get('check_out_timestamp'):
#         return {'already_marked': True, 'staff_id': staff_key, 'attendance_id': existing.get('id')}

#     if not (window and window.get('capture_check_out')):
#         return {'already_marked': True, 'staff_id': staff_key, 'attendance_id': existing.get('id')}

#     overtime = _find_approved_overtime(sb, org_key, staff_key, event_dt.astimezone(branch_zone).date())
#     check_out_status = resolve_check_out_status(
#         window, event_dt, branch_zone,
#         overtime_hours=float(overtime['hours']) if overtime else 0,
#     )
#     checkout_fields = _attendance_exceptions.check_out_write_fields(check_out_status, existing.get('notes'))
#     update_payload = {
#         'check_out_timestamp': now,
#         'check_out_status': check_out_status,
#         'check_out_confidence': float(confidence or 0),
#         'check_out_camera_id': str(camera_id) if camera_id else None,
#         'check_out_metadata': _node_attendance_metadata({'source': source, 'metadata': metadata or {}}),
#     }
#     update_payload.update(checkout_fields)
#     update_result = (
#         sb.table('attendance')
#         .update(update_payload)
#         .eq('id', existing['id'])
#         .execute()
#     )
#     if not update_result.data:
#         raise RuntimeError('Failed to record cloud camera check-out')

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
#         'staff_id': staff_key,
#         'attendance_id': existing['id'],
#         'marked_at': now,
#         'status': check_out_status,
#     }

"""
support_db_nodes.py
───────────────────────────────────────────────────────────────────────────────
Node health/offline detection and the Local Node sync API (install tokens,
heartbeats, camera config, training-job polling, embeddings push, cloud-mode
attendance recording).

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
from support_db_core import NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS, NODE_OFFLINE_THRESHOLD_MAX_SECONDS, NODE_OFFLINE_THRESHOLD_MIN_SECONDS, _ensure_org_client_access, _execute_supabase
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

def get_node_health(org_id: str) -> list[dict]:
    from support_db_organizations import get_organization
    sb = get_supabase()
    org = get_organization(org_id)
    threshold_seconds = _resolve_node_offline_threshold_seconds(org)

    branches_result = (
        sb.table('branches')
        .select('id, name, fallback_active')
        .eq('org_id', org_id)
        .is_('dropped_at', 'null')
        .execute()
    )
    branches = branches_result.data or []

    try:
        keys_result = (
            sb.table('node_api_keys')
            .select('branch_id, node_id, node_label, last_seen_at, status, created_at, last_heartbeat_payload')
            .eq('org_id', org_id)
            .eq('status', 'active')
            .execute()
        )
    except Exception as exc:
        logger.warning('node_api_keys monitoring columns may be missing; loading basic node health only: %s', exc)
        keys_result = (
            sb.table('node_api_keys')
            .select('branch_id, node_id, last_seen_at, status, created_at')
            .eq('org_id', org_id)
            .eq('status', 'active')
            .execute()
        )

    key_by_branch = {k['branch_id']: k for k in (keys_result.data or [])}

    health = []
    for branch in branches:
        key = key_by_branch.get(branch['id'])
        payload = {}
        last_seen = None
        node_status = 'never_connected'
        diff_minutes = None

        if key:
            payload = key.get('last_heartbeat_payload') or {}
            if not isinstance(payload, dict):
                payload = {}
            last_seen = key.get('last_seen_at')
            node_status, diff_minutes = _compute_node_status(last_seen, threshold_seconds)

        health.append({
            'branch_id': branch['id'],
            'branch_name': branch['name'],
            'node_id': key.get('node_id') if key else None,
            'node_label': key.get('node_label') if key else None,
            'status': node_status,
            'last_seen_at': last_seen,
            'minutes_since_seen': diff_minutes,
            'offline_threshold_seconds': threshold_seconds,
            'fallback_active': branch['fallback_active'],
            'attendance_mode': payload.get('attendance_mode'),
            'configured_cameras': payload.get('configured_cameras'),
            'cycle_status': payload.get('cycle_status'),
            'last_cycle_at': payload.get('last_cycle_at'),
            'last_error': payload.get('last_error'),
            'agent_version': payload.get('agent_version'),
            'hostname': payload.get('hostname'),
            'last_heartbeat_payload': payload,
        })

    return health

def _resolve_node_offline_threshold_seconds(org: dict) -> int:
    """Single source of truth for the offline-detection SLA.

    Falls back to NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS for cloud-mode
    orgs (threshold is None by design — see create_organization/
    update_organization) or malformed values, rather than crashing a
    health-check sweep over one bad org.
    """
    try:
        value = int(org.get('node_offline_threshold_seconds') or NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS)
    except (TypeError, ValueError):
        return NODE_OFFLINE_THRESHOLD_DEFAULT_SECONDS
    return max(NODE_OFFLINE_THRESHOLD_MIN_SECONDS, min(value, NODE_OFFLINE_THRESHOLD_MAX_SECONDS))

def _compute_node_status(last_seen_at: str | None, threshold_seconds: int) -> tuple[str, float | None]:
    """Returns (status, minutes_since_seen). status is one of
    'never_connected' | 'online' | 'offline'. Used by get_node_health,
    list_support_node_health_page, and run_offline_detection_sweep so
    online/offline can never be computed two different ways.
    """
    if not last_seen_at:
        return 'never_connected', None
    last_seen_dt = _parse_dt(last_seen_at)
    if not last_seen_dt:
        return 'never_connected', None
    diff_seconds = (datetime.now(timezone.utc) - last_seen_dt).total_seconds()
    status = 'online' if diff_seconds < threshold_seconds else 'offline'
    return status, diff_seconds / 60

def set_fallback(branch_id: str, active: bool) -> dict:
    """Manual fallback override from Node Health section."""
    sb = get_supabase()
    result = (
        sb.table('branches')
        .update({'fallback_active': active})
        .eq('id', branch_id)
        .execute()
    )
    if not result.data:
        raise ValueError(f'Branch {branch_id} not found')
    return result.data[0]

def _sha256_secret(raw: str) -> str:
    value = str(raw or '').strip()
    if not value:
        raise ValueError('Secret value is required')
    return hashlib.sha256(value.encode('utf-8')).hexdigest()

def _token(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(32)}"

def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()

def _parse_dt(value: str | None):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except Exception:
        return None

def _get_branch_owned_by_org(org_id: str, branch_id: str, include_dropped: bool = False) -> dict:
    result = _execute_supabase(
        'get_branch_owned_by_org',
        lambda: get_supabase().table('branches').select('*').eq('id', str(branch_id)).eq('org_id', str(org_id)).limit(1),
    )
    if not result.data:
        raise ValueError('Branch does not belong to this organization')
    branch = result.data[0]
    if branch.get('dropped_at') and not include_dropped:
        raise ValueError('Branch has been dropped from this organization')
    return branch

def create_branch_install_token(
    org_id: str,
    branch_id: str,
    created_by: str | None = None,
    ttl_days: int = 7,
    created_by_actor_type: str = "support",
) -> dict:
    org_key = str(org_id or "").strip()
    branch_key = str(branch_id or "").strip()
    actor_id = str(created_by or "").strip() or None
    actor_type = str(created_by_actor_type or "support").strip().lower()

    if actor_type not in {"support", "client", "system"}:
        raise ValueError("created_by_actor_type must be support, client, or system")

    if not org_key:
        raise ValueError("org_id is required")

    if not branch_key:
        raise ValueError("branch_id is required")

    org = _ensure_org_client_access(org_key, "Installer token generation")

    if str(org.get("attendance_mode") or "").strip().lower() != "local":
        raise ValueError("Node installer is available only for local attendance mode")

    branch = _get_branch_owned_by_org(org_key, branch_key)

    ttl = max(1, min(int(ttl_days or 7), 30))
    raw_token = "qia_install_" + secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(days=ttl)).isoformat()

    insert_data = {
        "org_id": org_key,
        "branch_id": str(branch["id"]),
        "token_hash": token_hash,
        "expires_at": expires_at,
        "created_by_actor_type": actor_type,
        "created_by_internal_user_id": actor_id if actor_type == "support" else None,
        "created_by_client_user_id": actor_id if actor_type == "client" else None,
    }

    # Backward-compatible legacy column.
    # Only set it for support users because the legacy FK points to internal_users.
    if actor_type == "support":
        insert_data["created_by"] = actor_id
    else:
        insert_data["created_by"] = None

    result = (
        get_supabase()
        .table("install_tokens")
        .insert(insert_data)
        .execute()
    )

    rows = result.data or []
    if not rows:
        raise RuntimeError("Failed to create install token")

    row = dict(rows[0])
    row["install_token"] = raw_token
    row["organization_name"] = org.get("name")
    row["branch_name"] = branch.get("name")
    row["attendance_mode"] = org.get("attendance_mode")
    return row

def activate_node_with_install_token(
    install_token: str,
    node_label: str | None = None,
    railway_api_base_url: str | None = None,
) -> dict:
    """Exchange a one-time install token for a scoped node_api_key."""
    from support_db_organizations import get_organization
    sb = get_supabase()
    raw = str(install_token or '').strip()
    if not raw:
        raise ValueError('install_token is required')

    hashed = _sha256_secret(raw)
    token_result = (
        sb.table('install_tokens')
        .select('*')
        .eq('token_hash', hashed)
        .limit(1)
        .execute()
    )
    if not token_result.data:
        raise ValueError('Invalid install token')

    token_row = token_result.data[0]
    if token_row.get('used_at'):
        raise ValueError('Install token has already been used')

    expires_at = _parse_dt(token_row.get('expires_at'))
    if expires_at and expires_at < datetime.now(timezone.utc):
        raise ValueError('Install token has expired')

    org_id = str(token_row.get('org_id'))
    branch_id = str(token_row.get('branch_id'))
    org = get_organization(org_id)
    branch = _get_branch_owned_by_org(org_id, branch_id)

    node_api_key = _token('qia_node')
    node_label_clean = str(node_label or '').strip()
    # node_id must be a unique machine identifier, not the human-readable label.
    # node_label can repeat across branches/tests (for example "Main Branch Laptop"),
    # but node_api_keys.node_id has a unique constraint in Supabase.
    node_id = f"node_{branch_id.replace('-', '')[:10]}_{secrets.token_hex(6)}"

    # One active node per branch. Revoking older keys is safer than letting two
    # physical machines write attendance for the same branch accidentally.
    try:
        sb.table('node_api_keys').update({'status': 'revoked'}).eq('branch_id', branch_id).eq('status', 'active').execute()
    except Exception as exc:
        logger.warning(f'Could not revoke previous node keys for branch {branch_id}: {exc}')

    node_key_payload = {
        'org_id': org_id,
        'branch_id': branch_id,
        'key_hash': _sha256_secret(node_api_key),
        'node_id': node_id,
        'status': 'active',
        'last_seen_at': _iso_now(),
        # Optional monitoring columns. If your Supabase migration has not been
        # run yet, the fallback insert below keeps activation working.
        'node_label': node_label_clean or None,
        'last_heartbeat_payload': {
            'node_label': node_label_clean or None,
            'attendance_mode': org.get('attendance_mode') or 'cloud',
            'cycle_status': 'activated',
            'configured_cameras': 0,
            'last_error': None,
            'last_cycle_at': _iso_now(),
        },
    }

    try:
        inserted = sb.table('node_api_keys').insert(node_key_payload).execute()
    except Exception as exc:
        logger.warning(
            'node_api_keys monitoring columns may be missing; retrying activation '
            f'without optional node_label/last_heartbeat_payload fields: {exc}'
        )
        fallback_payload = dict(node_key_payload)
        fallback_payload.pop('node_label', None)
        fallback_payload.pop('last_heartbeat_payload', None)
        inserted = sb.table('node_api_keys').insert(fallback_payload).execute()

    if not inserted.data:
        raise RuntimeError('Failed to create node API key')

    sb.table('install_tokens').update({
        'used_at': _iso_now(),
        'used_by_node_id': node_id,
    }).eq('id', token_row['id']).execute()

    return {
        'node_api_key': node_api_key,
        'node_id': node_id,
        'org_id': org_id,
        'branch_id': branch_id,
        'organization_name': org.get('name'),
        'branch_name': branch.get('name'), 
        'node_label': node_label_clean or None,
        'attendance_mode': org.get('attendance_mode') or 'cloud',
        'railway_api_base_url': railway_api_base_url or os.environ.get('RAILWAY_API_BASE_URL') or '',
        'sync_poll_interval': int(os.environ.get('SYNC_POLL_INTERVAL', '30')),
        'message': 'Node activated successfully. Store node_api_key locally; it will not be shown again.',
    }

def get_node_by_api_key(node_api_key: str) -> dict:
    sb = get_supabase()
    raw = str(node_api_key or '').strip()
    if not raw:
        raise ValueError('node_api_key is required')

    result = (
        sb.table('node_api_keys')
        .select('*')
        .eq('key_hash', _sha256_secret(raw))
        .eq('status', 'active')
        .limit(1)
        .execute()
    )
    if not result.data:
        raise ValueError('Invalid or revoked node_api_key')
    return result.data[0]

def node_heartbeat(node_api_key: str, payload: dict | None = None) -> dict:
    sb = get_supabase()
    node = get_node_by_api_key(node_api_key)
    now = _iso_now()
    heartbeat_payload = payload if isinstance(payload, dict) else {}

    update_payload = {
        'last_seen_at': now,
        # Optional JSONB column used by Support Dashboard live monitoring.
        'last_heartbeat_payload': {
            **heartbeat_payload,
            'server_received_at': now,
        },
    }

    try:
        sb.table('node_api_keys').update(update_payload).eq('id', node['id']).execute()
    except Exception as exc:
        logger.warning(
            'Could not update last_heartbeat_payload. Run the node monitoring '
            f'migration; falling back to last_seen_at only: {exc}'
        )
        sb.table('node_api_keys').update({'last_seen_at': now}).eq('id', node['id']).execute()

    # If the node came back online, clear manual/automatic fallback for branch.
    try:
        sb.table('branches').update({'fallback_active': False}).eq('id', node['branch_id']).execute()
    except Exception as exc:
        logger.warning(f'Could not clear fallback for branch {node.get("branch_id")}: {exc}')

    return {
        'success': True,
        'status': 'online',
        'node_id': node.get('node_id'),
        'org_id': node.get('org_id'),
        'branch_id': node.get('branch_id'),
        'last_seen_at': now,
    }

def get_local_node_status(org_id: str) -> dict | None:
    """
    Get the local node status for an organization.
    Returns dict with:
    - offline (bool): True if node is offline based on heartbeat threshold
    - last_heartbeat (str): ISO timestamp of last heartbeat
    - node_id (str): Node ID if online
    Returns None if no node found for org.
    """
    try:
        sb = get_supabase()
        
        # Get the organization's node info
        org_result = _execute_supabase(
            'get_local_node_status.org',
            lambda: sb.table('client_onboarding_configs')
            .select('node_offline_threshold_seconds')
            .eq('organization_id', str(org_id))
            .limit(1),
        )
        
        threshold_seconds = 300  # Default 5 minutes
        if org_result.data and len(org_result.data) > 0:
            threshold_seconds = org_result.data[0].get('node_offline_threshold_seconds', 300)
        
        # Get the node's last heartbeat
        node_result = _execute_supabase(
            'get_local_node_status.node',
            lambda: sb.table('node_api_keys')
            .select('id, node_id, last_seen_at')
            .eq('org_id', str(org_id))
            .eq('status', 'active')
            .limit(1),
        )
        
        if not node_result.data or len(node_result.data) == 0:
            return None
        
        node = node_result.data[0]
        last_seen = node.get('last_seen_at')
        
        if not last_seen:
            return {
                'offline': True,
                'last_heartbeat': None,
                'node_id': node.get('node_id'),
            }
        
        # Check if node is offline based on threshold
        try:
            from datetime import datetime, timezone, timedelta
            last_seen_dt = datetime.fromisoformat(last_seen.replace('Z', '+00:00'))
            now_dt = datetime.now(timezone.utc)
            seconds_since_heartbeat = (now_dt - last_seen_dt).total_seconds()
            is_offline = seconds_since_heartbeat > threshold_seconds
            
            return {
                'offline': is_offline,
                'last_heartbeat': last_seen,
                'node_id': node.get('node_id'),
            }
        except Exception as e:
            logger.warning(f'Could not parse heartbeat time: {e}')
            return {
                'offline': True,
                'last_heartbeat': last_seen,
                'node_id': node.get('node_id'),
            }
    except Exception as e:
        logger.warning(f'Could not get local node status for org {org_id}: {e}')
        return None

def get_recent_fallback_attendance(
    org_id: str,
    person_id: str,
    branch_id: str | None = None,
    within_seconds: int = 300,
) -> dict | None:
    """
    Get recent fallback/manual attendance marker for a person.
    Returns the attendance record if found within the time window, None otherwise.
    Used to show fallback markers when local node is offline.
    """
    try:
        from datetime import datetime, timezone, timedelta
        
        sb = get_supabase()
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=within_seconds)
        cutoff_iso = cutoff.isoformat().replace('+00:00', 'Z')
        
        query = (
            sb.table('client_attendance')
            .select('*')
            .eq('organization_id', str(org_id))
            .eq('person_id', str(person_id))
            .eq('source', 'manual')  # Fallback/manual attendance
            .gte('created_at', cutoff_iso)
            .order('created_at', desc=True)
            .limit(1)
        )
        
        if branch_id:
            query = query.eq('branch_id', str(branch_id))
        
        result = _execute_supabase('get_recent_fallback_attendance', lambda: query)
        
        if result.data and len(result.data) > 0:
            return result.data[0]
        return None
    except Exception as e:
        logger.warning(f'Could not get fallback attendance for {org_id}/{person_id}: {e}')
        return None

def get_recent_fallback_attendance_bulk(
    org_id: str,
    person_ids: list,
    branch_id: str | None = None,
    within_seconds: int = 300,
) -> dict:
    """
    Batched version of get_recent_fallback_attendance: one Supabase round
    trip for the whole person_ids list instead of one per person.

    api_cctv_live_tracking previously called get_recent_fallback_attendance
    once per staff member inside a Python loop whenever the local node was
    offline. That's an N+1 query pattern — for an org with, say, 50 staff
    it meant 50 sequential network round trips to Supabase on every single
    poll. The Live CCTV Tracking page polls this endpoint every ~2s and
    aborts the previous in-flight request each time it fires a new one
    (see useLiveCctvTracking.load() on the frontend). Once the N+1 loop
    pushed a single request's duration past the poll interval, every
    request got aborted by the next poll before it could finish, so the
    endpoint never resolved successfully — visible in the Network tab as
    a continuous stream of (failed)/cancelled requests and a UI stuck at
    0/0/0 counts.

    Returns { person_id (str): attendance_record } for anyone with a
    matching manual/fallback attendance row inside the window. Missing
    keys mean "no recent fallback attendance found" — same meaning as
    get_recent_fallback_attendance returning None.
    """
    ids = [str(pid) for pid in person_ids if pid is not None]
    if not ids:
        return {}

    try:
        from datetime import datetime, timezone, timedelta

        sb = get_supabase()
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=within_seconds)
        cutoff_iso = cutoff.isoformat().replace('+00:00', 'Z')

        query = (
            sb.table('client_attendance')
            .select('*')
            .eq('organization_id', str(org_id))
            .in_('person_id', ids)
            .eq('source', 'manual')
            .gte('created_at', cutoff_iso)
            .order('created_at', desc=True)
        )

        if branch_id:
            query = query.eq('branch_id', str(branch_id))

        result = _execute_supabase('get_recent_fallback_attendance_bulk', lambda: query)

        by_person: dict = {}
        for row in (result.data or []):
            pid = str(row.get('person_id'))
            # Rows are ordered created_at desc, so the first row seen per
            # person_id is the most recent one — matches the .limit(1)
            # semantics of the single-person version.
            if pid not in by_person:
                by_person[pid] = row
        return by_person
    except Exception as e:
        logger.warning(f'Could not get bulk fallback attendance for {org_id}: {e}')
        return {}

def _local_node_camera_view(row: dict) -> dict:
    """Shape one branch_cameras row into the payload local_node.camera_config
    .normalize_camera() expects (id/camera_id, camera_name/name, rtsp_url/
    rtspUrl). Single conversion point so get_node_config and any future
    node-facing camera read stay identical in shape."""
    camera_id = str(row.get('id'))
    name = row.get('camera_name') or 'Camera'
    rtsp_url = row.get('rtsp_url') or ''
    return {
        'id': camera_id,
        'camera_id': camera_id,
        'camera_name': name,
        'name': name,
        'channel': row.get('channel'),
        'camera_type': row.get('camera_type') or 'nvr',
        'stream_path': row.get('stream_path'),
        'location': row.get('location'),
        'rtsp_url': rtsp_url,
        'rtspUrl': rtsp_url,
        'enabled': bool(row.get('enabled', True)),
    }

def get_node_config(node_api_key: str) -> dict:
    from support_db_staff import _branch_ui_id, _normalize_people_type
    node = get_node_by_api_key(node_api_key)
    org = _ensure_org_client_access(str(node['org_id']), 'Local node config sync')
    branch = _get_branch_owned_by_org(str(node['org_id']), str(node['branch_id']))
    branch_ui_id = _branch_ui_id(str(node['org_id']), str(node['branch_id']))

    # branch_cameras + branch_network_configs are the tables
    # _sync_local_node_camera_config actually writes to (see that function's
    # docstring). client_onboarding_configs.cameras is onboarding *input*
    # only — it is never guaranteed to be in sync with what a client edited
    # afterward, so the node must never read it directly.
    sb = get_supabase()
    cameras_result = _execute_supabase(
        'get_node_config.cameras',
        lambda: (
            sb.table('branch_cameras')
            .select('*')
            .eq('organization_id', str(node['org_id']))
            .eq('branch_id', str(node['branch_id']))
            .eq('enabled', True)
            .order('channel')
        ),
    )
    cameras = [_local_node_camera_view(row) for row in (cameras_result.data or [])]

    capture_settings_result = _execute_supabase(
        'get_node_config.capture_settings',
        lambda: (
            sb.table('attendance_capture_settings')
            .select('people_type, mode, sync_delay_minutes')
            .eq('org_id', str(node['org_id']))
            .eq('branch_id', str(node['branch_id']))
        ),
    )
    capture_settings_rows = capture_settings_result.data or []

    sync_delay_minutes = 0
    for row in capture_settings_rows:
        try:
            sync_delay_minutes = max(sync_delay_minutes, int(row.get('sync_delay_minutes') or 0))
        except Exception:
            continue

    configured_people_types = sorted({
        _normalize_people_type(row.get('people_type'), 'staff')
        for row in capture_settings_rows
        if row.get('people_type')
    })

    # Determine if shift mode is enabled for ANY people_type in this branch.
    # If ANY attendance_capture_settings has mode='shift', then shift gating
    # is active and the local node should enforce it. This prevents the
    # fallback in shift_gate.is_event_within_shift() that would accept
    # out-of-hours detections when shift_windows sync fails or is incomplete.
    #
    # BUGFIX: this used to read row.get('mode') against a query that only
    # selected 'people_type' — 'mode' was never fetched, so this was always
    # None and shift_mode_enabled was unconditionally False for every
    # branch, silently disabling the exact safety switch this comment
    # describes. Folded into the single capture_settings_result query above
    # (which also now carries sync_delay_minutes) instead of a third
    # round-trip to the same table.
    shift_mode_enabled = any(
        row.get('mode') == 'shift'
        for row in capture_settings_rows
    )

    # shift_windows / staff_shift_windows are the two fields shift_gate.py's
    # safety fallback depends on (shift_mode_enabled=True + no window found
    # -> hold for review). Every OTHER query in this function goes through
    # _execute_supabase's retry wrapper; these two previously did not — a
    # single bad row (dangling shift_id_ref, transient Supabase hiccup)
    # raised straight out of resolve_staff_shift_windows/
    # resolve_branch_default_window, which had no caller-side try/except
    # either, so the exception propagated out of get_node_config entirely,
    # 500ing the WHOLE /v1/node/config response. Per node_service.run_cycle,
    # a failed fetch_node_config() call updates NOTHING that cycle — the
    # node just kept whatever shift_windows/staff_shift_windows it last had
    # (frequently {}, from before any shift was even assigned), indefinitely,
    # with zero visibility into why. Catching here means one bad row costs
    # this branch its shift data for one poll cycle (~30s), not forever, and
    # every other part of this response (cameras, capture settings, sync
    # timing) keeps working even while shift data is being debugged.
    shift_windows = {}
    try:
        for people_type in configured_people_types:
            window = resolve_branch_default_window(str(node['org_id']), str(node['branch_id']), people_type)
            if window:
                shift_windows[people_type] = window
    except Exception:
        logger.warning(
            "get_node_config: resolve_branch_default_window failed for branch=%s — "
            "sending shift_windows={} this cycle rather than 500ing the whole config sync",
            str(node['branch_id']), exc_info=True,
        )
        shift_windows = {}

    # Personal shift overrides (tier 2, client_staff.shift_id_ref) — the
    # piece Local Node's shift_gate.py has been ready to consume since it
    # added person_code-aware gating, but which get_node_config never
    # actually sent down until now. See resolve_staff_shift_windows'
    # docstring for the exact key shape ("people_type:person_code").
    # AFTER
    try:
        staff_shift_windows = resolve_staff_shift_windows(str(node['org_id']), str(node['branch_id']))
    except Exception:
        logger.warning(
            "get_node_config: resolve_staff_shift_windows failed for branch=%s — "
            "sending staff_shift_windows={} this cycle rather than 500ing the whole config sync",
            str(node['branch_id']), exc_info=True,
        )
        staff_shift_windows = {}

    # Per-date manual attendance instructions — the highest-precedence
    # gating tier, above both personal and branch-default shift. Reuses
    # the exact same query /v1/node/poll-manual-instructions already runs,
    # so a live detection is judged against an operator's override on
    # FIRST touch instead of landing in held_for_review and only getting
    # corrected ~20s later by ManualInstructionsWorker's separate
    # write-to-attendance-row path. Same fail-open-empty posture as
    # shift_windows/staff_shift_windows above — one bad poll cycle costs
    # this branch its manual-instruction data for ~30s, not a 500 on the
    # whole config sync.
    try:
        manual_instructions = list_pending_manual_instructions_for_branch(
            str(node['org_id']), str(node['branch_id'])
        )
    except Exception:
        logger.warning(
            "get_node_config: list_pending_manual_instructions_for_branch failed for branch=%s — "
            "sending manual_instructions=[] this cycle rather than 500ing the whole config sync",
            str(node['branch_id']), exc_info=True,
        )
        manual_instructions = []

    return {
        'node_id': node.get('node_id'),
        'org_id': str(node['org_id']),
        'branch_id': str(node['branch_id']),
        'branch_ui_id': branch_ui_id,
        'attendance_mode': org.get('attendance_mode') or 'cloud',
        'node_offline_threshold_seconds': org.get('node_offline_threshold_seconds'),
        'organization': {
            'id': str(node['org_id']),
            'name': org.get('name'),
            'attendance_mode': org.get('attendance_mode'),
        },
        'branch': branch,
        'cameras': cameras,
        'sync_poll_interval': int(os.environ.get('SYNC_POLL_INTERVAL', '30')),
        'sync_delay_minutes': sync_delay_minutes,
        'shift_mode_enabled': shift_mode_enabled,
        'shift_windows': shift_windows,
        'staff_shift_windows': staff_shift_windows,
        'manual_instructions': manual_instructions,
    }



def _replace_face_embeddings_cloud(
    org_id: str,
    staff_id: str,
    embeddings: list[list[float]],
    is_fallback_copy: bool,
    source_job_id: str | None = None,
) -> int:
    """Delete-then-insert this staff member's embeddings for one copy type
    (primary vs fallback), scoped to (org_id, staff_id, is_fallback_copy).

    Single write path for face_embeddings_cloud. Both the cloud-mode
    training-job pipeline and the local-node embeddings-push pipeline call
    this, so a retrain from either source cleanly replaces only its own
    copy type without touching the other's vectors.
    """
    sb = get_supabase()
    try:
        (
            sb.table('face_embeddings_cloud')
            .delete()
            .eq('org_id', str(org_id))
            .eq('staff_id', str(staff_id))
            .eq('is_fallback_copy', bool(is_fallback_copy))
            .execute()
        )
    except Exception:
        pass

    rows = [{
        'org_id': str(org_id),
        'staff_id': str(staff_id),
        'embedding': emb,
        'is_fallback_copy': bool(is_fallback_copy),
        'source_job_id': str(source_job_id) if source_job_id else None,
    } for emb in embeddings]

    if rows:
        sb.table('face_embeddings_cloud').insert(rows).execute()

    return len(rows)

_LOCAL_NODE_EMBEDDING_SOFT_MIN = 3

def _valid_embedding_list(value: Any) -> list[list[float]]:
    """Return only real InsightFace-style numeric embedding vectors.

    This prevents a node from accidentally marking training as successful when
    it did not actually extract biometric vectors. Buffalo_L vectors are 512
    floats; the >=128 guard keeps the function tolerant to model changes while
    still rejecting empty/sample payloads.
    """
    valid: list[list[float]] = []
    if not isinstance(value, list):
        return valid

    for item in value:
        if not isinstance(item, list) or len(item) < 128:
            continue
        try:
            vector = [float(x) for x in item]
        except (TypeError, ValueError):
            continue
        valid.append(vector)

    return valid


def _node_attendance_metadata(item: dict) -> dict:
    """Build safe attendance metadata for node-submitted events.

    The attendance.source column has a database CHECK constraint. The local
    node endpoint is camera-scoped, so the stored source must remain the stable
    DB value `camera`. Detailed local origin labels such as
    `local_node_manual_test`, `local_node_camera`, or `local_node_buffered` are
    preserved inside metadata instead of being written into the constrained
    source column.
    """
    metadata = item.get('metadata') if isinstance(item.get('metadata'), dict) else {}
    metadata = dict(metadata)

    raw_source = str(item.get('source') or '').strip()
    if raw_source and raw_source != 'camera':
        metadata.setdefault('raw_source', raw_source)

    return metadata

def push_node_attendance(node_api_key: str, payload: dict) -> dict:
    """Accept attendance events from a local node.

    Identity contract: the node knows a person only as (people_type, person_code)
    — it never holds a client_staff.id UUID, by design (trainer_desktop and the
    local node are intentionally airgapped from Supabase identity). Each event
    is resolved to a client_staff row scoped to this node's own org/branch,
    exactly as _assert_unique_client_staff_person_code does at staff-creation
    time. org_id/branch_id come from the authenticated node_api_key, never from
    the request body, so a node cannot write into another branch's data.
    """
    from support_db_attendance_dashboard import _dashboard_day_window_utc
    from support_db_internal import _support_text
    from support_db_staff import _normalize_people_type
    sb = get_supabase()
    node = get_node_by_api_key(node_api_key)
    _ensure_org_client_access(str(node['org_id']), 'Local node attendance sync')

    events = payload.get('logs') if isinstance(payload.get('logs'), list) else []
    results: list[dict] = []

    for item in events:
        if not isinstance(item, dict):
            continue

        local_event_id = _support_text(item.get('local_event_id'))
        people_type = _normalize_people_type(item.get('people_type'), 'staff')
        person_code = _support_text(item.get('person_code'))

        if not local_event_id or not person_code:
            results.append({
                'local_event_id': local_event_id or None,
                'status': 'rejected',
                'reason': 'local_event_id and person_code are required',
            })
            continue

        staff_result = (
            sb.table('client_staff')
            .select('id, name, is_archived, status, shift_id_ref, department_id, check_in_grace_override, check_out_grace_override, person_code')
            .eq('org_id', str(node['org_id']))
            .eq('branch_id', str(node['branch_id']))
            .eq('people_type', people_type)
            .ilike('person_code', person_code)
            .eq('is_archived', False)
            .neq('status', 'inactive')
            .limit(1)
            .execute()
        )
        staff = staff_result.data[0] if staff_result.data else None

        # Fallback: a local node's embedding package (person_code from the
        # trainer_desktop enrollment CSV, e.g. "3") is not guaranteed to be
        # the same string as client_staff.person_code (zero-padded in this
        # dashboard's Staff ID convention, e.g. "0003") — same identity, two
        # representations. The exact ilike above only catches an identical
        # string. Only attempted when person_code is purely numeric, so this
        # can never accidentally widen matching for alphanumeric codes (e.g.
        # a registration number containing letters) — those still require an
        # exact match, unchanged from before.
        #
        # Both queries here exclude archived/inactive staff — a stale or
        # removed enrollment must never silently absorb a new detection
        # just because its person_code, digit-stripped, still collides with
        # someone currently active. If more than one ACTIVE row still
        # collides, that's a real data problem (duplicate/ambiguous codes)
        # and we refuse to guess rather than mis-attribute the event.
        if staff is None and person_code.isdigit():
            same_scope_result = (
                sb.table('client_staff')
                .select('id, name, is_archived, status, shift_id_ref, department_id, check_in_grace_override, check_out_grace_override, person_code')
                .eq('org_id', str(node['org_id']))
                .eq('branch_id', str(node['branch_id']))
                .eq('people_type', people_type)
                .eq('is_archived', False)
                .neq('status', 'inactive')
                .execute()
            )
            target = int(person_code)
            matches = [
                c for c in (same_scope_result.data or [])
                if str(c.get('person_code') or '').strip().isdigit()
                and int(str(c.get('person_code')).strip()) == target
            ]
            if len(matches) == 1:
                staff = matches[0]
            elif len(matches) > 1:
                logger.warning(
                    "push_node_attendance: person_code %s matches %d active staff "
                    "rows in org=%s branch=%s — refusing to guess, dropping event",
                    person_code, len(matches), node['org_id'], node['branch_id'],
                )

        if staff is None:
            logger.warning(
                f'Attendance skipped: no client_staff match for '
                f'people_type={people_type} person_code={person_code} in node scope'
            )
            results.append({
                'local_event_id': local_event_id,
                'status': 'skipped',
                'reason': 'No matching person found in this branch',
            })
            continue

        if staff.get('is_archived') or str(staff.get('status') or 'active') == 'inactive':
            results.append({
                'local_event_id': local_event_id,
                'status': 'skipped',
                'reason': 'Person is archived or inactive',
            })
            continue

        event_time_raw = item.get('marked_at') or item.get('timestamp') or _iso_now()
        try:
            event_dt = datetime.fromisoformat(str(event_time_raw).replace('Z', '+00:00'))
        except Exception:
            event_dt = datetime.now(timezone.utc)

        instruction_id = _node_attendance_metadata(item).get('instruction_id')
        window = (
            resolve_manual_instruction_window(str(node['org_id']), instruction_id)
            if instruction_id else None
        ) or resolve_timing_source(
            org_id=str(node['org_id']),
            branch_id=str(node['branch_id']),
            staff=staff,
            people_type=people_type,
            event_time_utc=event_dt,
        )
        branch_zone = _get_branch_timezone(sb, str(node['org_id']), str(node['branch_id']))

        # Same UTC day-window convention _dashboard_day_window_utc already
        # uses elsewhere — kept consistent rather than introducing a second
        # day-boundary definition on this call path.
        _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)
        existing_result = (
            sb.table('attendance')
            # day_status must be selected here -- _maybe_notify_payroll_decision
            # below compares node_day_status against existing.get('day_status')
            # to detect the transition INTO a classified state. Without it,
            # existing.get('day_status') is always None (the key is simply
            # absent from the row), so that comparison can never match and
            # the notification fires on every re-sync of an already-
            # classified row instead of only once, on the actual transition.
            .select('id, check_out_timestamp, day_status')
            .eq('org_id', str(node['org_id']))
            .eq('staff_id', str(staff['id']))
            .gte('timestamp', day_start_iso)
            .lt('timestamp', day_end_iso)
            .limit(1)
            .execute()
        )
        existing = existing_result.data[0] if existing_result.data else None

        has_check_out_payload = bool(item.get('check_out_marked_at'))

        # node_day_status/node_notes/node_hold_reason mirror what
        # attendance_sync_worker.py forwards for the checkout-hold feature
        # (see local_db.py's record_attendance_local checkout branch and
        # the held-checkout/check-in resolution functions). 'day_status' is
        # a DELIBERATELY separate column from this table's own 'status'
        # column — 'status' here is the check-in timing classification
        # (on_time/late/early/unscheduled, from resolve_check_in_status),
        # while the node's status field is day-level (present/half_day/
        # short_leave/late/overtime). Reusing 'status' for both would
        # silently corrupt whichever one lost the collision.
        #
        # short_leave/late added alongside half_day/overtime: the local
        # node's held-review screen resolves a late check-in to one of
        # late/short_leave/half_day, and an early checkout to one of
        # early-left (notes-only, status untouched)/short_leave/half_day —
        # see local_db.mark_held_check_ins_late,
        # mark_held_check_ins_short_leave, mark_held_checkouts_short_leave,
        # mark_held_checkouts_early_left, and mark_held_checkouts_late (the
        # late-CHECKOUT hold's own late/overtime pair). Without 'late' and
        # 'short_leave' here, an operator's decision would silently
        # collapse to 'present' the moment it reached the cloud, discarding
        # it entirely.
        node_day_status = _support_text(item.get('status')).lower() or 'present'
        if node_day_status not in ('present', 'half_day', 'short_leave', 'late', 'overtime'):
            node_day_status = 'present'
        node_notes = _support_text(item.get('notes')) or None
        node_hold_reason = _support_text(item.get('check_out_hold_reason')).lower() or None
        if node_hold_reason not in ('early', 'late'):
            node_hold_reason = None

        # check_in_confirmed: whether `timestamp` below is a REAL confirmed
        # check-in or just an audit-trail sighting time on a row resolved
        # via mark_held_check_ins_half_day (local_db.py). Defaults True —
        # older node builds that never send this key (pre-dating the
        # check-in-hold feature) keep behaving exactly as before, where
        # every synced check-in was implicitly confirmed.
        node_check_in_confirmed = bool(item.get('check_in_confirmed', True))
        # Still non-NULL only if this row is being flushed WITHOUT going
        # through confirm_held_check_ins / mark_held_check_ins_half_day
        # first (e.g. operator hit "Sync selected" directly on a held late
        # check-in) — mirrors node_hold_reason's checkout-side comment.
        node_check_in_hold_reason = _support_text(item.get('check_in_hold_reason')).lower() or None
        if node_check_in_hold_reason not in ('late',):
            node_check_in_hold_reason = None

        # Computed once and reused on every write path below (insert AND
        # every update branch) — previously this was only computed inside
        # `if not existing:`, so status/timestamp were written on a row's
        # very first sync and then FROZEN forever: a checkout sync, a
        # held-checkout resolution, or any other update to an existing row
        # never touched them again. If the row's first-ever sync happened
        # under a since-corrected shift config (or captured a since-
        # superseded marked_at — see record_attendance_local's
        # check_in_refreshed/window_closed corrections), the dashboard
        # kept showing the stale original classification/time forever,
        # even after the node re-synced the corrected check-in. Recomputing
        # here on every write self-heals that: the cloud's check-in
        # timestamp and classification always converge to whatever the
        # node currently reports as authoritative for this event.
        check_in_status = resolve_check_in_status(window, event_dt, branch_zone)

        _CLASSIFIED_DAY_STATUSES = ('half_day', 'short_leave', 'late', 'overtime')

        def _maybe_notify_payroll_decision(
            previous_day_status: str | None, attendance_id, check_out_hint=None,
        ) -> None:
            """Fires the payroll-decision-pending notification, AND (new)
            creates the linked leave/overtime adjustment record, only on
            the transition INTO a classified day_status -- node_day_status
            is recomputed on every sync (see the comment above), so
            comparing against what was there before this write is what
            stops an already-classified, still-undecided row from
            re-notifying/re-creating on every heartbeat. previous_day_status
            is None for a brand-new insert (nothing to compare against, so
            any classified value on arrival counts as a transition).

            check_out_hint: this row's check_out_timestamp as of THIS
            write, if any (may come from the existing row or from this
            sync's own payload depending on which call site passes it) --
            used only to decide half_day's first_half/second_half split
            and as the event-time anchor for short_leave/overtime. See
            create_half_day_adjustment's half_day_period comment below for
            why presence of a checkout is what drives that split for the
            local-node path (which has no explicit check_in/check_out leg
            the way the mobile exceptions flow does).

            Local-node classification never auto-linked to Leave/Overtime
            Management before this -- only the notification fired, leaving
            admins with a Payroll Decisions entry but no leave/overtime
            request to actually approve/reject. 'late' deliberately still
            creates nothing here (see create_short_leave_adjustment's
            docstring on why 'late' is a count, not a record)."""
            if node_day_status not in _CLASSIFIED_DAY_STATUSES or not attendance_id:
                return
            if node_day_status == previous_day_status:
                return
            try:
                _attendance_exceptions.notify_payroll_decision_pending(
                    org_id=str(node['org_id']),
                    branch_id=str(node['branch_id']),
                    staff_id=str(staff['id']),
                    staff_name=staff.get('name') or 'Staff member',
                    attendance_id=attendance_id,
                    day_status=node_day_status,
                    event_local_str=event_dt.astimezone(branch_zone).strftime('%b %d, %I:%M %p'),
                )
            except Exception:
                pass

            if node_day_status == 'overtime':
                try:
                    _attendance_exceptions.create_overtime_adjustment(
                        org_id=str(node['org_id']),
                        staff_id=str(staff['id']),
                        attendance_id=str(attendance_id),
                        branch_id=str(node['branch_id']),
                        check_out_timestamp=check_out_hint or event_time_raw,
                    )
                except Exception:
                    logger.exception(
                        'Failed to create overtime request for local-node attendance=%s',
                        attendance_id,
                    )
            elif node_day_status == 'short_leave':
                try:
                    _attendance_exceptions.create_short_leave_adjustment(
                        org_id=str(node['org_id']),
                        staff_id=str(staff['id']),
                        attendance_id=str(attendance_id),
                        branch_id=str(node['branch_id']),
                        event_timestamp=check_out_hint or event_time_raw,
                    )
                except Exception:
                    logger.exception(
                        'Failed to create short-leave request for local-node attendance=%s',
                        attendance_id,
                    )
            elif node_day_status == 'half_day':
                # Heuristic: the node has no explicit check_in/check_out
                # "leg" the way the mobile exceptions flow does (see
                # _on_half_day_decided there) -- half_day here is a single
                # day-level classification with no leg attached to it. A
                # checkout already on the row (this sync's own payload, or
                # one synced earlier) reads as the missing half being the
                # AFTERNOON (second_half: the person was here in the
                # morning, so the checkout exists, but left/was marked
                # half-day after); no checkout yet reads as the missing
                # half being the MORNING (first_half: a late/absent
                # check-in, nothing to check out from yet). Mirrors
                # mark_held_check_ins_half_day (check-in side, no checkout)
                # vs mark_held_checkouts_half_day (checkout side) in
                # local_db.py.
                half_day_period = 'second_half' if check_out_hint else 'first_half'
                try:
                    _attendance_exceptions.create_half_day_adjustment(
                        org_id=str(node['org_id']),
                        staff_id=str(staff['id']),
                        attendance_id=str(attendance_id),
                        half_day_period=half_day_period,
                        branch_id=str(node['branch_id']),
                        event_timestamp=check_out_hint or event_time_raw,
                    )
                except Exception:
                    logger.exception(
                        'Failed to create half-day leave for local-node attendance=%s',
                        attendance_id,
                    )

        if not existing:
            insert_row = {
                'org_id': str(node['org_id']),
                'branch_id': str(node['branch_id']),
                'staff_id': str(staff['id']),
                'timestamp': event_time_raw,
                'status': check_in_status,
                'day_status': node_day_status,
                'notes': node_notes,\
                'check_out_hold_reason': node_hold_reason,
                'check_in_confirmed': node_check_in_confirmed,  
                'check_out_hold_reason': node_hold_reason,
                'source': 'camera',
                # Additive, non-breaking classification alongside 'source'
                # (which stays 'camera' for both local-node and cloud
                # detections and is left untouched — see capture_channel's
                # own migration note for why a new column, not a repurposed
                # one). Exactly one of 'local_node' / 'cloud' / 'mobile_app'
                # per row, set once at insert; each of the three attendance
                # insert sites in this module writes exactly one value, by
                # construction of which function it is.
                'capture_channel': 'local_node',
                'confidence': float(item.get('confidence') or 0),
                'camera_id': _support_text(item.get('camera_id')) or None,
                'node_id': node.get('node_id'),
                'device_id': _support_text(item.get('device_id')) or node.get('node_id'),
                'metadata': _node_attendance_metadata(item),
            }

            # A row can arrive with BOTH legs already filled in on its very first
            # sync (check-in and check-out both happened locally before the first
            # sync attempt fired) — "no existing cloud row" just means this is the
            # first sync, not that there's no checkout to record. Without this, the
            # checkout half of the payload was silently dropped on insert, and the
            # row then sat with a null check_out_timestamp forever, since every
            # later sync of the same row hits the update branch instead.
            if has_check_out_payload and window and window.get('capture_check_out'):
                check_out_dt_raw = item.get('check_out_marked_at')
                try:
                    check_out_dt = datetime.fromisoformat(str(check_out_dt_raw).replace('Z', '+00:00'))
                except Exception:
                    check_out_dt = event_dt
                overtime = _find_approved_overtime(
                    sb, str(node['org_id']), str(staff['id']), check_out_dt.astimezone(branch_zone).date()
                )
                check_out_status = resolve_check_out_status(
                    window, check_out_dt, branch_zone,
                    overtime_hours=float(overtime['hours']) if overtime else 0,
                )
                check_out_metadata_raw = item.get('check_out_metadata')
                insert_row.update({
                    'check_out_timestamp': check_out_dt_raw,
                    'check_out_status': check_out_status,
                    'check_out_confidence': float(item.get('check_out_confidence') or 0),
                    'check_out_camera_id': _support_text(item.get('check_out_camera_id')) or None,
                    'check_out_metadata': check_out_metadata_raw if isinstance(check_out_metadata_raw, dict) else {},
                })

            insert_result = sb.table('attendance').insert(insert_row).execute()
            if insert_result.data:
                _maybe_notify_payroll_decision(
                    None, insert_result.data[0].get('id'),
                    check_out_hint=insert_row.get('check_out_timestamp'),
                )
                results.append({'local_event_id': local_event_id, 'status': 'inserted'})
            else:
                results.append({'local_event_id': local_event_id, 'status': 'skipped', 'reason': 'Insert failed'})
            continue

        # A held checkout resolved via mark_held_checkouts_half_day,
        # mark_held_checkouts_short_leave, or mark_held_checkouts_late
        # clears/re-confirms check_out_marked_at locally (see local_db.py's
        # docstrings for each) — there's a day-level outcome (half_day/
        # short_leave/late/overtime) and/or an operator note that must
        # still reach the cloud even when there's no NEW checkout payload
        # in this sync batch. Without this branch, those actions would
        # silently never sync anything once resolved, since
        # has_check_out_payload would be False and the row would just fall
        # through to 'already_marked'.
        has_resolution_update = (
            node_day_status in ('half_day', 'short_leave', 'late', 'overtime')
            or node_notes is not None or node_hold_reason is not None
            or node_check_in_hold_reason is not None
            or node_check_in_confirmed != bool(existing.get('check_in_confirmed', True))
        )

        if not has_check_out_payload:
            if not has_resolution_update:
                results.append({'local_event_id': local_event_id, 'status': 'already_marked'})
                continue
            resolution_update = (
                sb.table('attendance')
                .update({
                    'timestamp': event_time_raw,
                    'status': check_in_status,
                    'day_status': node_day_status,
                    'notes': node_notes,
                    'check_out_hold_reason': node_hold_reason,
                    'check_in_confirmed': node_check_in_confirmed,         
                    'check_in_hold_reason': node_check_in_hold_reason,
                })
                .eq('id', existing['id'])
                .execute()
            )
            if resolution_update.data:
                _maybe_notify_payroll_decision(
                    existing.get('day_status'), existing['id'],
                    check_out_hint=existing.get('check_out_timestamp'),
                )
                results.append({'local_event_id': local_event_id, 'status': 'updated'})
            else:
                results.append({'local_event_id': local_event_id, 'status': 'skipped', 'reason': 'Update failed'})
            continue

        if not (window and window.get('capture_check_out')):
            results.append({'local_event_id': local_event_id, 'status': 'already_marked'})
            continue

        check_out_dt_raw = item.get('check_out_marked_at')
        try:
            check_out_dt = datetime.fromisoformat(str(check_out_dt_raw).replace('Z', '+00:00'))
        except Exception:
            check_out_dt = event_dt

        # Last-write-wins: the node refreshes its local checkout time on
        # every sighting after check-in and may sync the same day's
        # record multiple times as the person stays in view. Only guard
        # against a genuinely out-of-order delivery (a stale retry
        # arriving after a newer sync already landed) — never regress a
        # later checkout time back to an earlier one.
        existing_check_out_raw = existing.get('check_out_timestamp')
        if existing_check_out_raw:
            try:
                existing_check_out_dt = datetime.fromisoformat(str(existing_check_out_raw).replace('Z', '+00:00'))
                if check_out_dt <= existing_check_out_dt:
                    # The checkout TIME itself isn't advancing — typically
                    # because a held row's informative check_out_marked_at
                    # was already synced once via an explicit "sync
                    # selected" on the still-held row, and this later sync
                    # is the operator's resolution (confirm/half-day/
                    # leave-open) catching up. confirm_held_checkouts in
                    # particular never changes check_out_marked_at, only
                    # clears check_out_hold_reason locally — so that clear
                    # must still reach the cloud even though the timestamp
                    # is unchanged, or a resolved row would stay flagged as
                    # held forever.
                    if has_resolution_update:
                        resolution_update = (
                            sb.table('attendance')
                            .update({
                                'timestamp': event_time_raw,
                                'status': check_in_status,
                                'day_status': node_day_status,
                                'notes': node_notes,
                                'check_out_hold_reason': node_hold_reason,
                            })
                            .eq('id', existing['id'])
                            .execute()
                        )
                        if resolution_update.data:
                            _maybe_notify_payroll_decision(
                                existing.get('day_status'), existing['id'],
                                check_out_hint=existing_check_out_raw,
                            )
                            results.append({'local_event_id': local_event_id, 'status': 'updated'})
                        else:
                            results.append({'local_event_id': local_event_id, 'status': 'skipped', 'reason': 'Update failed'})
                    else:
                        results.append({'local_event_id': local_event_id, 'status': 'already_marked'})
                    continue
            except Exception:
                pass
        overtime = _find_approved_overtime(
            sb, str(node['org_id']), str(staff['id']), check_out_dt.astimezone(branch_zone).date()
        )
        check_out_status = resolve_check_out_status(
            window, check_out_dt, branch_zone,
            overtime_hours=float(overtime['hours']) if overtime else 0,
        )
        check_out_metadata_raw = item.get('check_out_metadata')

        update_result = (
            sb.table('attendance')
            .update({
                'timestamp': event_time_raw,
                'status': check_in_status,
                'check_out_timestamp': check_out_dt_raw,
                'check_out_status': check_out_status,
                'check_out_confidence': float(item.get('check_out_confidence') or 0),
                'check_out_camera_id': _support_text(item.get('check_out_camera_id')) or None,
                'check_out_metadata': check_out_metadata_raw if isinstance(check_out_metadata_raw, dict) else {},
                # Carried through here too — covers a held row synced as-is
                # (hold_reason still set, so the dashboard can flag it as
                # "resolved via raw sync, unreviewed" per
                # attendance_sync_worker.py's comment) as well as a normal
                # confirmed checkout, which needs any earlier hold_reason/
                # notes cleared or refreshed on this same write.
                'day_status': node_day_status,
                'notes': node_notes,
                'check_out_hold_reason': node_hold_reason,
                'check_in_confirmed': node_check_in_confirmed,     
                'check_in_hold_reason': node_check_in_hold_reason, 
            })
            .eq('id', existing['id'])
            .execute()
        )
        if update_result.data:
            _maybe_notify_payroll_decision(
                existing.get('day_status'), existing['id'],
                check_out_hint=check_out_dt_raw,
            )
            results.append({'local_event_id': local_event_id, 'status': 'updated'})
        else:
            results.append({'local_event_id': local_event_id, 'status': 'skipped', 'reason': 'Update failed'})

    return {
        'inserted_count': sum(1 for r in results if r['status'] == 'inserted'),
        'updated_count': sum(1 for r in results if r['status'] == 'updated'),
        'results': results,
    }

def push_node_embeddings(node_api_key: str, payload: dict) -> dict:
    """Accept trainer_desktop-derived face embeddings pushed from a local
    node's zip import, and mirror them into Supabase as fallback-copy
    embeddings so cloud-mode recognition keeps working if the node goes
    offline.

    Identity contract matches push_node_attendance: the node never holds a
    client_staff.id UUID. Each record is resolved to a client_staff row
    scoped to this node's own org/branch via (people_type, person_code).
    org_id/branch_id come from the authenticated node_api_key, never from
    the request body.
    """
    from support_db_internal import _support_text
    from support_db_staff import _normalize_people_type, update_client_staff
    sb = get_supabase()
    node = get_node_by_api_key(node_api_key)
    _ensure_org_client_access(str(node['org_id']), 'Local node embeddings sync')

    records = payload.get('records') if isinstance(payload.get('records'), list) else []
    results: list[dict] = []

    for record in records:
        if not isinstance(record, dict):
            continue

        people_type = _normalize_people_type(record.get('people_type'), 'staff')
        person_code = _support_text(record.get('person_code'))

        if not person_code:
            results.append({
                'people_type': people_type,
                'person_code': None,
                'status': 'rejected',
                'reason': 'person_code is required',
            })
            continue

        staff_result = (
            sb.table('client_staff')
            .select('id, name, is_archived, status')
            .eq('org_id', str(node['org_id']))
            .eq('branch_id', str(node['branch_id']))
            .eq('people_type', people_type)
            .ilike('person_code', person_code)
            .limit(1)
            .execute()
        )

        if not staff_result.data:
            logger.warning(
                f'Embeddings push skipped: no client_staff match for '
                f'people_type={people_type} person_code={person_code} in node scope'
            )
            results.append({
                'people_type': people_type,
                'person_code': person_code,
                'status': 'skipped',
                'reason': 'No matching person found in this branch',
            })
            continue

        staff = staff_result.data[0]
        if staff.get('is_archived') or str(staff.get('status') or 'active') == 'inactive':
            results.append({
                'people_type': people_type,
                'person_code': person_code,
                'status': 'skipped',
                'reason': 'Person is archived or inactive',
            })
            continue

        valid_embeddings = _valid_embedding_list(record.get('embeddings') or [])
        if not valid_embeddings:
            results.append({
                'people_type': people_type,
                'person_code': person_code,
                'status': 'rejected',
                'reason': 'No valid embedding vectors were submitted',
            })
            continue

        if len(valid_embeddings) < _LOCAL_NODE_EMBEDDING_SOFT_MIN:
            # Soft warning only — trainer_desktop already curates quality
            # before packaging, unlike raw camera captures which need a
            # hard floor (see mark_node_training_job_trained's min_embeddings).
            logger.warning(
                f'Local-node embeddings push for person_code={person_code} '
                f'submitted only {len(valid_embeddings)} valid vectors '
                f'(soft minimum is {_LOCAL_NODE_EMBEDDING_SOFT_MIN}); accepting anyway.'
            )

        staff_id = str(staff['id'])
        written = _replace_face_embeddings_cloud(
            org_id=str(node['org_id']),
            staff_id=staff_id,
            embeddings=valid_embeddings,
            is_fallback_copy=True,
            source_job_id=None,
        )

        update_client_staff(staff_id, {
            'face_training_status': 'trained',
            'is_face_verified': True,
        })

        results.append({
            'people_type': people_type,
            'person_code': person_code,
            'staff_id': staff_id,
            'status': 'synced',
            'embedding_count': written,
        })

    return {
        'synced_count': sum(1 for r in results if r['status'] == 'synced'),
        'results': results,
    }

def get_staff_face_embeddings(org_id: str, staff_id: str) -> list[list[float]]:
    """Return one staff member's raw enrolled embedding vectors (merges
    primary cloud-trained and fallback local-node-imported copies, same
    "more vectors only improves match tolerance" reasoning as
    get_org_recognition_embeddings). Used by mobile self-verify
    (client_field_attendance_routes.verify_face) for a 1:1 check against
    the CALLER's own enrollment, as opposed to that function's whole-org
    1:N read for camera-based recognition -- different callers, same
    underlying face_embeddings_cloud table.

    Returns an empty list (never raises) for "not enrolled yet" -- the
    route turns that into a friendly "contact your admin" message rather
    than a 500.
    """
    sb = get_supabase()
    org_key = str(org_id)
    staff_key = str(staff_id)

    result = _execute_supabase(
        'get_staff_face_embeddings',
        lambda: (
            sb.table('face_embeddings_cloud')
            .select('embedding')
            .eq('org_id', org_key)
            .eq('staff_id', staff_key)
        ),
    )
    return [
        row['embedding'] for row in (result.data or [])
        if isinstance(row.get('embedding'), list) and row.get('embedding')
    ]

def get_org_recognition_embeddings(org_id: str, branch_id: str | None = None) -> list[dict]:
    """Return every attendance-eligible person's raw embedding vectors for
    one Supabase-tenant organization (optionally scoped to one branch), for
    building an in-memory recognition cache.

    Merges primary (cloud-trained) and fallback (local-node-imported)
    copies for the same person — both are genuine face vectors; more
    vectors only improves match tolerance across attendance_mode switches.
    """
    from support_db_staff import _normalize_people_type
    sb = get_supabase()
    org_key = str(org_id)

    staff_query = (
        sb.table('client_staff')
        .select('id, name, people_type, branch_id')
        .eq('org_id', org_key)
        .eq('role', 'staff')
        .eq('is_archived', False)
        .neq('status', 'inactive')
    )
    if branch_id:
        staff_query = staff_query.eq('branch_id', str(branch_id))

    staff_result = _execute_supabase('get_org_recognition_embeddings.staff', lambda: staff_query)
    staff_rows = staff_result.data or []
    if not staff_rows:
        return []

    staff_ids = [str(row['id']) for row in staff_rows if row.get('id')]
    staff_by_id = {str(row['id']): row for row in staff_rows}

    embeddings_result = _execute_supabase(
        'get_org_recognition_embeddings.embeddings',
        lambda: (
            sb.table('face_embeddings_cloud')
            .select('staff_id, embedding')
            .eq('org_id', org_key)
            .in_('staff_id', staff_ids)
        ),
    )

    grouped: dict[str, list[list[float]]] = {}
    for row in (embeddings_result.data or []):
        staff_id = str(row.get('staff_id') or '')
        embedding = row.get('embedding')
        if not staff_id or not isinstance(embedding, list) or not embedding:
            continue
        grouped.setdefault(staff_id, []).append(embedding)

    people = []
    for staff_id, embeddings in grouped.items():
        staff = staff_by_id.get(staff_id)
        if not staff:
            continue
        people.append({
            'staff_id': staff_id,
            'name': staff.get('name') or 'Unknown',
            'people_type': _normalize_people_type(staff.get('people_type'), 'staff'),
            'branch_id': str(staff.get('branch_id') or ''),
            'embeddings': embeddings,
        })

    return people

def record_cloud_camera_attendance(
    org_id: str,
    branch_id: str | None,
    staff_id: str,
    confidence: float,
    source: str,
    camera_id: str | None = None,
    device_id: str | None = None,
    metadata: dict | None = None,
) -> dict:
    """Record one cloud-camera-recognized attendance event.

    Mirrors push_node_attendance's insert-or-update contract exactly, so
    Live CCTV cloud recognition and local-node sync produce identical
    behavior for the same branch/people_type settings — one source of truth
    (attendance_capture_settings / shifts / overrides), two capture methods.

    The first detection of a person on a given UTC day is a check-in. Any
    later detection the same day is a check-out candidate if the resolved
    timing window has capture_check_out enabled; otherwise it's a no-op
    ('already_marked'), same as the previous behavior. The caller
    (app.py's _ai_loop) has no explicit "this is a checkout" signal today —
    re-detection later in the day is what drives it, since this stream
    runs continuously rather than being triggered per action.
    """
    from support_db_attendance_dashboard import _dashboard_day_window_utc
    sb = get_supabase()
    org_key = str(org_id)
    staff_key = str(staff_id)
    _, day_start_iso, day_end_iso = _dashboard_day_window_utc(None)

    staff_result = (
        sb.table('client_staff')
        .select('id, name, people_type, shift_id_ref, department_id, check_in_grace_override, check_out_grace_override')
        .eq('id', staff_key)
        .eq('org_id', org_key)
        .limit(1)
        .execute()
    )
    staff_row = staff_result.data[0] if staff_result.data else {'id': staff_key}
    people_type = staff_row.get('people_type') or 'staff'

    event_dt = datetime.now(timezone.utc)
    window = resolve_timing_source(
        org_id=org_key,
        branch_id=str(branch_id) if branch_id else None,
        staff=staff_row,
        people_type=people_type,
        event_time_utc=event_dt,
    )
    branch_zone = _get_branch_timezone(sb, org_key, str(branch_id)) if branch_id else ZoneInfo('UTC')

    existing_result = (
        sb.table('attendance')
        .select('id, check_out_timestamp, notes')
        .eq('org_id', org_key)
        .eq('staff_id', staff_key)
        .gte('timestamp', day_start_iso)
        .lt('timestamp', day_end_iso)
        .limit(1)
        .execute()
    )
    existing = existing_result.data[0] if existing_result.data else None
    now = _iso_now()

    if not existing:
        status = resolve_check_in_status(window, event_dt, branch_zone)
        row = {
            'org_id': org_key,
            'branch_id': str(branch_id) if branch_id else None,
            'staff_id': staff_key,
            'timestamp': now,
            'status': status,
            'source': 'camera',
            'capture_channel': 'cloud',
            'confidence': float(confidence or 0),
            'camera_id': str(camera_id) if camera_id else None,
            'device_id': str(device_id) if device_id else None,
            'metadata': _node_attendance_metadata({'source': source, 'metadata': metadata or {}}),
        }
        row.update(_attendance_exceptions.check_in_write_fields(status))
        result = sb.table('attendance').insert(row).execute()
        if not result.data:
            raise RuntimeError('Failed to record cloud camera attendance')
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
            'staff_id': staff_key,
            'attendance_id': new_id,
            'marked_at': now,
            'status': status,
        }

    if existing.get('check_out_timestamp'):
        return {'already_marked': True, 'staff_id': staff_key, 'attendance_id': existing.get('id')}

    if not (window and window.get('capture_check_out')):
        return {'already_marked': True, 'staff_id': staff_key, 'attendance_id': existing.get('id')}

    overtime = _find_approved_overtime(sb, org_key, staff_key, event_dt.astimezone(branch_zone).date())
    check_out_status = resolve_check_out_status(
        window, event_dt, branch_zone,
        overtime_hours=float(overtime['hours']) if overtime else 0,
    )
    checkout_fields = _attendance_exceptions.check_out_write_fields(check_out_status, existing.get('notes'))
    update_payload = {
        'check_out_timestamp': now,
        'check_out_status': check_out_status,
        'check_out_confidence': float(confidence or 0),
        'check_out_camera_id': str(camera_id) if camera_id else None,
        'check_out_metadata': _node_attendance_metadata({'source': source, 'metadata': metadata or {}}),
    }
    update_payload.update(checkout_fields)
    update_result = (
        sb.table('attendance')
        .update(update_payload)
        .eq('id', existing['id'])
        .execute()
    )
    if not update_result.data:
        raise RuntimeError('Failed to record cloud camera check-out')

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
        'staff_id': staff_key,
        'attendance_id': existing['id'],
        'marked_at': now,
        'status': check_out_status,
    }