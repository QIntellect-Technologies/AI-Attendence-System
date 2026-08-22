# """
# support_db_client_users.py
# ───────────────────────────────────────────────────────────────────────────────
# Client dashboard user accounts/invites, authentication, onboarding config,
# and profile management.

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
# from support_db_core import _compute_org_status, _execute_supabase, _json_dict, _json_list, _org_access_allows_client
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

# _CLIENT_MODULE_MAP: dict[str, str] = {
#     # ── Canonical keys (what moduleRegistry.ts uses, what we now store) ──
#     'attendance':       'attendance',
#     'employees':        'employees',
#     'leave':            'leave',
#     'payroll':          'payroll',
#     'overtime':         'overtime',
#     'reports':          'reports',
#     'cctv':             'cctv',
#     'liveattendance':   'liveattendance',
#     # ── Legacy aliases (old DB rows / old clients) ────────────────────────
#     'staff_directory':  'employees',
#     'leave_management': 'leave',
#     'live_attendance':  'liveattendance',
#     'livecctv':         'cctv',
#     'liveattendancemonitoring': 'liveattendance',
# }

# _VALID_MODULES: frozenset[str] = frozenset({
#     'attendance',
#     'employees',
#     'leave',
#     'payroll',
#     'overtime',
#     'reports',
#     'cctv',
#     'liveattendance',
# })

# _MODULE_ALIASES: dict[str, str] = {
#     'staff_directory':          'employees',
#     'leave_management':         'leave',
#     'live_attendance':          'liveattendance',
#     'livecctv':                 'cctv',
#     'liveattendancemonitoring': 'liveattendance',
# }

# def _normalise_module_name(raw: str) -> str:
#     """
#     Resolve a raw incoming module name to its canonical stored form.
 
#     Accepts both canonical keys and legacy aliases so old API clients and
#     existing DB rows are never broken. Raises ValueError for unknown modules.
#     """
#     key = str(raw or '').strip().lower()
#     if key in _VALID_MODULES:
#         return key
#     canonical = _MODULE_ALIASES.get(key)
#     if canonical:
#         return canonical
#     raise ValueError(
#         f"Unknown module: {raw!r}. "
#         f"Valid modules are: {', '.join(sorted(_VALID_MODULES))}"
#     )

# def _map_module_for_client(module_name: str) -> str:
#     """Map a stored module_name to the key the client dashboard expects."""
#     return _CLIENT_MODULE_MAP.get(
#         str(module_name or '').strip().lower(),
#         str(module_name or '').strip().lower(),
#     )

# def _safe_client_user(row: dict) -> dict:
#     return {k: v for k, v in (row or {}).items() if k != 'password_hash'}

# def _generate_temp_password(length: int = 16) -> str:
#     alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_'
#     return ''.join(secrets.choice(alphabet) for _ in range(length))

# def _hash_password(raw_password: str) -> str:
#     return bcrypt.hashpw(raw_password.encode('utf-8'), bcrypt.gensalt(12)).decode('utf-8')

# def _verify_password(raw_password: str, password_hash: str) -> bool:
#     try:
#         return bcrypt.checkpw(raw_password.encode('utf-8'), password_hash.encode('utf-8'))
#     except Exception:
#         return False

# def _active_client_modules(org_id: str) -> list[str]:
#     from support_db_branches import list_org_modules
#     modules = list_org_modules(org_id)
#     return [
#         _map_module_for_client(m.get('module_name'))
#         for m in modules
#         if m.get('status') == 'active' and m.get('module_name')
#     ]

# def _normalize_branch_module_people_type_entries(payload: object) -> dict[str, list[str]]:
#     from support_db_staff import _normalize_people_type
#     if isinstance(payload, dict) and 'module_people_types' in payload and isinstance(payload.get('module_people_types'), dict):
#         payload = payload.get('module_people_types')
#     if isinstance(payload, dict) and 'modulePeopleTypes' in payload and isinstance(payload.get('modulePeopleTypes'), dict):
#         payload = payload.get('modulePeopleTypes')
#     if not isinstance(payload, dict):
#         raise ValueError('module_people_types must be an object keyed by module name')

#     normalized: dict[str, list[str]] = {}
#     for raw_module, raw_people_types in payload.items():
#         module_key = _normalise_module_name(raw_module)
#         if isinstance(raw_people_types, str):
#             raw_values = [raw_people_types]
#         elif isinstance(raw_people_types, list):
#             raw_values = raw_people_types
#         else:
#             raw_values = []

#         seen: set[str] = set()
#         values: list[str] = []
#         for raw_value in raw_values:
#             people_type = _normalize_people_type(raw_value, 'staff')
#             if not people_type or people_type in seen:
#                 continue
#             seen.add(people_type)
#             values.append(people_type)

#         normalized[module_key] = values

#     return normalized

# def list_branch_module_people_types(org_id: str, branch_id: str) -> dict[str, list[str]]:
#     from support_db_branches import _get_branch_for_update
#     from support_db_organizations import get_organization
#     from support_db_staff import _normalize_people_type
#     get_organization(str(org_id))
#     _get_branch_for_update(str(branch_id), str(org_id))

#     try:
#         result = _execute_supabase(
#             'list_branch_module_people_types',
#             lambda: (
#                 get_supabase()
#                 .table('branch_module_people_types')
#                 .select('*')
#                 .eq('org_id', str(org_id))
#                 .eq('branch_id', str(branch_id))
                
#             ),
#         )
#     except Exception as exc:
#         if _table_missing(exc, 'branch_module_people_types'):
#             logger.warning('branch_module_people_types table is missing; returning empty module people-type config')
#             return {}
#         raise

#     mapping: dict[str, list[str]] = {}
#     for row in result.data or []:
#         module_key = _normalise_module_name(row.get('module_key'))
#         people_type = _normalize_people_type(row.get('people_type'), 'staff')
#         mapping.setdefault(module_key, [])
#         if people_type not in mapping[module_key]:
#             mapping[module_key].append(people_type)

#     return mapping

# def set_branch_module_people_types(org_id: str, branch_id: str, module_people_types: object) -> dict[str, list[str]]:
#     from support_db_branches import _get_branch_for_update
#     from support_db_organizations import get_organization
#     get_organization(str(org_id))
#     _get_branch_for_update(str(branch_id), str(org_id))
#     normalized = _normalize_branch_module_people_type_entries(module_people_types)

#     try:
#         sb = get_supabase()
#         sb.table('branch_module_people_types').delete().eq('org_id', str(org_id)).eq('branch_id', str(branch_id)).execute()
#         rows = [
#             {
#                 'org_id': str(org_id),
#                 'branch_id': str(branch_id),
#                 'module_key': module_key,
#                 'people_type': people_type,
#             }
#             for module_key, people_types in normalized.items()
#             for people_type in people_types
#         ]
#         if rows:
#             sb.table('branch_module_people_types').insert(rows).execute()
#         return list_branch_module_people_types(str(org_id), str(branch_id))
#     except Exception as exc:
#         if _table_missing(exc, 'branch_module_people_types'):
#             logger.warning('branch_module_people_types table is missing; nothing persisted')
#             return {}
#         raise

# def list_org_branch_module_people_types(org_id: str) -> dict[str, dict[str, list[str]]]:
#     from support_db_staff import _normalize_people_type
#     try:
#         result = _execute_supabase(
#             'list_org_branch_module_people_types',
#             lambda: (
#                 get_supabase()
#                 .table('branch_module_people_types')
#                 .select('*')
#                 .eq('org_id', str(org_id))
                
#             ),
#         )
#     except Exception as exc:
#         if _table_missing(exc, 'branch_module_people_types'):
#             logger.warning('branch_module_people_types table is missing; returning empty org-wide config')
#             return {}
#         raise

#     mapping: dict[str, dict[str, list[str]]] = {}
#     for row in result.data or []:
#         branch_id = str(row.get('branch_id') or '')
#         module_key = _normalise_module_name(row.get('module_key'))
#         people_type = _normalize_people_type(row.get('people_type'), 'staff')
#         if not branch_id:
#             continue
#         mapping.setdefault(branch_id, {})
#         mapping[branch_id].setdefault(module_key, [])
#         if people_type not in mapping[branch_id][module_key]:
#             mapping[branch_id][module_key].append(people_type)

#     return mapping

# def _seed_default_branch_module_people_types(
#     org_id: str,
#     branch_id: str,
#     module_keys: list[str] | None = None,
# ) -> None:
#     """
#     Insert default `branch_module_people_types` rows for a branch: every
#     module in `module_keys` (defaults to the org's currently-active modules)
#     x every people type in the org's `enabled_people_types`.

#     Idempotent and non-destructive by design: a module is only seeded if the
#     branch has ZERO existing rows for it. If an admin has already customized
#     that module's people-type scope for this branch, this function leaves it
#     untouched.

#     Called from two entry points, because both can produce a branch with no
#     config:
#       - create_branch: a brand-new branch has no rows for any module yet.
#       - toggle_module (status='active'): a module turned on for an org AFTER
#         its branches already exist needs the same default seed applied
#         retroactively to every existing branch.

#     Known limitation: if an admin deliberately unchecks every people type for
#     a module on a branch (fully disabling it, not just narrowing it), that
#     branch will have zero rows for that module_key and a later re-toggle of
#     the module will re-seed it. This is the accepted tradeoff of presence-
#     based storage (no boolean "explicitly disabled" tombstone).
#     """
#     from support_db_organizations import get_organization
#     org = get_organization(str(org_id))
#     vertical_config = _json_dict(org.get('vertical_config'))
#     enabled_people_types = (
#         _json_list(org.get('enabled_people_types'))
#         or _json_list(vertical_config.get('enabled_people_types'))
#         or ['staff']
#     )

#     target_modules = (
#         [_normalise_module_name(m) for m in module_keys]
#         if module_keys is not None
#         else _active_client_modules(str(org_id))
#     )
#     if not target_modules or not enabled_people_types:
#         return

#     existing = list_branch_module_people_types(str(org_id), str(branch_id))
#     missing_modules = [m for m in target_modules if m not in existing]
#     if not missing_modules:
#         return

#     rows = [
#         {
#             'org_id': str(org_id),
#             'branch_id': str(branch_id),
#             'module_key': module_key,
#             'people_type': people_type,
#         }
#         for module_key in missing_modules
#         for people_type in enabled_people_types
#     ]

#     try:
#         get_supabase().table('branch_module_people_types').insert(rows).execute()
#     except Exception as exc:
#         if _table_missing(exc, 'branch_module_people_types'):
#             logger.warning('branch_module_people_types table is missing; default seed skipped')
#             return
#         raise

# def _latest_invoice(org_id: str) -> Optional[dict]:
#     from support_db_billing import list_invoices
#     invoices = list_invoices(org_id)
#     return invoices[0] if invoices else None

# def _default_people_kind_for_biz(biz_type: object) -> str:
#     key = str(biz_type or '').strip().lower().replace('_', '-').replace('/', '-')
#     if any(part in key for part in ('school', 'college', 'university', 'academy')):
#         return 'students'
#     if any(part in key for part in ('factory', 'manufacturing', 'plant')):
#         return 'workers'
#     if any(part in key for part in ('company', 'corporate', 'office', 'business')):
#         return 'employees'
#     if any(part in key for part in ('ngo', 'non-profit', 'nonprofit')):
#         return 'personnel'
#     if any(part in key for part in ('hospital', 'clinic', 'restaurant', 'hospitality')):
#         return 'staff'
#     return 'employees'

# def _normalize_people_kind(raw: object, biz_type: object = None) -> str:
#     value = str(raw or '').strip().lower().replace(' ', '_')
#     mapping = {
#         'student': 'students',
#         'students': 'students',
#         'staff': 'staff',
#         'staff_member': 'staff',
#         'staff_members': 'staff',
#         'worker': 'workers',
#         'workers': 'workers',
#         'employee': 'employees',
#         'employees': 'employees',
#         'personnel': 'personnel',
#         'patient': 'patients',
#         'patients': 'patients',
#         'member': 'members',
#         'members': 'members',
#         'volunteer': 'volunteers',
#         'volunteers': 'volunteers',
#         'both': 'both',
#         'students_staff': 'both',
#         'student_staff': 'both',
#         'students_and_staff': 'both',
#     }
#     return mapping.get(value) or _default_people_kind_for_biz(biz_type)

# def _build_client_config(org: dict, branches: list[dict], module_keys: list[str], module_people_types_by_branch: dict[str, dict[str, list[str]]] | None = None) -> dict:
#     """
#     Build the existing Client Dashboard OrgConfig shape from support-created
#     Supabase records.

#     Important: Support owns branches/modules/limits. The React dashboard still
#     uses numeric route ids (/admin/branch/1), so we expose UI ids 1..N while
#     preserving the real Supabase UUID as backend_branch_id/backendBranchId.
#     """
#     config_branches = []
#     departments = {}
#     roles = {}
#     cameras = {}

#     for idx, branch in enumerate(branches, start=1):
#         ui_branch_id = idx
#         config_branches.append({
#             'id': ui_branch_id,
#             'name': branch.get('name') or f'Branch {ui_branch_id}',
#             'city': branch.get('location') or '',
#             'location': branch.get('location') or '',
#             'timezone': branch.get('timezone'),
#             'backend_branch_id': branch.get('id'),
#             'backendBranchId': branch.get('id'),
#             'max_staff_capacity': branch.get('max_staff_capacity'),
#             'maxStaffCapacity': branch.get('max_staff_capacity'),
#             'fallback_active': branch.get('fallback_active'),
#             'fallbackActive': branch.get('fallback_active'),
#         })
#         departments[str(ui_branch_id)] = []
#         roles[str(ui_branch_id)] = []
#         cameras[str(ui_branch_id)] = []

#     vertical_config = _json_dict(org.get('vertical_config'))
#     enabled_people_types = _json_list(org.get('enabled_people_types')) or _json_list(vertical_config.get('enabled_people_types')) or ['staff']
#     attendance_people_types = _json_list(org.get('attendance_people_types')) or _json_list(vertical_config.get('attendance_people_types')) or enabled_people_types
#     attendance_people_types = [item for item in attendance_people_types if item in enabled_people_types] or enabled_people_types
#     business_type = str(org.get('business_type') or org.get('biz_type') or org.get('org_type') or 'company').strip().lower()
#     primary_people_type = str(org.get('primary_people_type') or vertical_config.get('primary_people_type') or enabled_people_types[0]).strip().lower()

#     module_people_types_by_branch = module_people_types_by_branch or {}
#     branch_module_people_types: dict[str, dict[str, list[str]]] = {}
#     for idx, branch in enumerate(branches, start=1):
#         backend_branch_id = str(
#             branch.get('backendBranchId')
#             or branch.get('backend_branch_id')
#             or branch.get('branchUuid')
#             or branch.get('branch_uuid')
#             or branch.get('id')
#             or ''
#         )
#         branch_key = backend_branch_id or str(idx)
#         if not backend_branch_id:
#             branch_module_people_types[branch_key] = {}
#             continue
#         raw_branch_config = module_people_types_by_branch.get(backend_branch_id) or {}
#         normalized_branch_config = {
#             module_key: list(people_types or [])
#             for module_key, people_types in (raw_branch_config or {}).items()
#             if module_key and people_types
#         }
#         branch_module_people_types[branch_key] = normalized_branch_config

#     vertical_config = {
#         **vertical_config,
#         'business_type': business_type,
#         'primary_people_type': primary_people_type,
#         'enabled_people_types': enabled_people_types,
#         'attendance_people_types': attendance_people_types,
#     }

#     return {
#         'bizType': org.get('org_type') or business_type,
#         'businessType': business_type,
#         'business_type': business_type,
#         'primaryPeopleType': primary_people_type,
#         'primary_people_type': primary_people_type,
#         'enabledPeopleTypes': enabled_people_types,
#         'enabled_people_types': enabled_people_types,
#         'attendancePeopleTypes': attendance_people_types,
#         'attendance_people_types': attendance_people_types,
#         'verticalConfig': vertical_config,
#         'vertical_config': vertical_config,
#         'peopleKind': _normalize_people_kind(org.get('people_kind'), org.get('org_type')),
#         'people_kind': _normalize_people_kind(org.get('people_kind'), org.get('org_type')),
#         'terminologyOverrides': org.get('terminology_overrides') or {},
#         'terminology_overrides': org.get('terminology_overrides') or {},
#         'orgName': org.get('name') or '',
#         'tagline': '',
#         'address': '',
#         'city': '',
#         'publicContactPhone': org.get('contact_phone') or '',
#         'timezone': 'Asia/Karachi',
#         'size': '',
#         'logo': None,
#         'attendanceMode': org.get('attendance_mode'),
#         'attendance_mode': org.get('attendance_mode'),
#         'maxBranches': org.get('max_branches'),
#         'max_branches': org.get('max_branches'),
#         'branches': config_branches,
#         'departments': departments,
#         'roles': roles,
#         'modules': module_keys,
#         'modulePeopleTypesByBranch': branch_module_people_types,
#         'module_people_types_by_branch': branch_module_people_types,
#         'cameras': cameras,
#         'staffShiftDefinitions': [],
#         'users': [],
#         'employeeProfiles': {},
#         'payrollPolicy': {},
#         'network': {},
#     }

# def create_client_invite(org_id: str, payload: dict, invited_by: str) -> dict:
#     """
#     Create or reset a Client Dashboard admin/HR account for one organization.

#     The temporary password is returned once and is never stored in plaintext.
#     The invite message is generated from the real support-owned deal settings:
#     organization template, attendance mode/scope, modules, branches/capacity,
#     and latest invoice.
#     """
#     from support_db_branches import list_branches, list_org_modules
#     from support_db_organizations import get_organization
#     sb = get_supabase()
#     org = get_organization(org_id)

#     email = str(payload.get('email') or org.get('contact_email') or '').strip().lower()
#     full_name = str(payload.get('full_name') or payload.get('name') or f"{org.get('name')} Admin").strip()
#     role = str(payload.get('role') or 'admin').strip().lower()

#     if not email:
#         raise ValueError('Client email is required')
#     if not full_name:
#         raise ValueError('Client full name is required')
#     if role not in ('admin', 'hr'):
#         raise ValueError('role must be admin or hr')

#     temporary_password = str(payload.get('temporary_password') or '').strip() or _generate_temp_password()
#     password_hash = _hash_password(temporary_password)

#     existing = (
#         sb.table('client_users')
#         .select('id, org_id, email')
#         .eq('email', email)
#         .limit(1)
#         .execute()
#     )

#     row = None
#     if existing.data:
#         current = existing.data[0]
#         if str(current.get('org_id')) != str(org_id):
#             raise ValueError('This email is already invited for another organization')

#         result = (
#             sb.table('client_users')
#             .update({
#                 'password_hash': password_hash,
#                 'full_name': full_name,
#                 'role': role,
#                 'is_active': True,
#                 'must_change_password': True,
#                 'invited_by': invited_by,
#                 'onboarding_completed_at': None,
#             })
#             .eq('id', current['id'])
#             .execute()
#         )
#         row = result.data[0] if result.data else None
#     else:
#         result = sb.table('client_users').insert({
#             'org_id': org_id,
#             'email': email,
#             'password_hash': password_hash,
#             'full_name': full_name,
#             'role': role,
#             'is_active': True,
#             'must_change_password': True,
#             'invited_by': invited_by,
#         }).execute()
#         row = result.data[0] if result.data else None

#     if not row:
#         raise RuntimeError('Failed to create client invite')

#     branches = []
#     modules = []
#     latest_invoice = None

#     try:
#         branches = list_branches(str(org_id))
#     except Exception as exc:
#         logger.warning('Could not load branches for invite org=%s: %s', org_id, exc)

#     try:
#         modules = list_org_modules(str(org_id))
#     except Exception as exc:
#         logger.warning('Could not load modules for invite org=%s: %s', org_id, exc)

#     try:
#         latest_invoice = _latest_invoice(str(org_id))
#     except Exception as exc:
#         logger.warning('Could not load latest invoice for invite org=%s: %s', org_id, exc)

#     login_url = str(
#         payload.get('login_url')
#         or payload.get('dashboard_url')
#         or '/login'
#     ).strip() or '/login'

#     support_contact = str(
#         payload.get('support_contact')
#         or os.getenv('SUPPORT_CONTACT')
#         or os.getenv('SUPPORT_EMAIL')
#         or 'QIntellect Support'
#     ).strip()

#     invite_message = build_client_invite_message(
#         client_name=full_name,
#         login_url=login_url,
#         client_email=email,
#         temporary_password=temporary_password,
#         organization=org,
#         branches=branches,
#         modules=modules,
#         latest_invoice=latest_invoice,
#         support_contact=support_contact,
#     )

#     return {
#         'user': _safe_client_user(row),
#         'email': email,
#         'full_name': full_name,
#         'role': role,
#         'temporary_password': temporary_password,
#         'login_url': login_url,
#         'message': invite_message,
#         'invite_message': invite_message,
#         'deal_summary': {
#             'organization': org,
#             'branches': branches,
#             'modules': modules,
#             'latest_invoice': latest_invoice,
#         },
#     }

# def _client_user_session_from_row(row: dict) -> dict:
#     """Build the frontend-safe client user/session object from client_users."""
#     from support_db_branches import list_branches
#     from support_db_organizations import get_organization
#     org_id = str(row.get('org_id'))
#     org = get_organization(org_id)
#     branches = list_branches(org_id)
#     modules = _active_client_modules(org_id)
#     status = org.get('status') or _compute_org_status(org_id)

#     onboarding_done = bool(row.get('onboarding_completed_at'))
#     commercial_access_ok = _org_access_allows_client(status)
#     dashboard_ready = bool(onboarding_done and commercial_access_ok)
#     requires_onboarding = not onboarding_done

#     return {
#         'id': row['id'],
#         'name': row.get('full_name') or row.get('email'),
#         'full_name': row.get('full_name'),
#         'email': row.get('email'),
#         'phone': row.get('phone') or '',
#         'profile_image_url': row.get('profile_image_url') or '',
#         'profileImageUrl': row.get('profile_image_url') or '',
#         'avatarUrl': row.get('profile_image_url') or '',
#         'photo_url': row.get('profile_image_url') or '',
#         'profile_image_name': row.get('profile_image_name') or '',
#         'profileImageName': row.get('profile_image_name') or '',
#         'password_changed_at': row.get('password_changed_at'),
#         'passwordChangedAt': row.get('password_changed_at'),
#         'role': 'admin' if row.get('role') == 'admin' else 'hr',
#         'client_role': row.get('role'),
#         'source': 'client_users',
#         'organization_id': org_id,
#         'organizationId': org_id,
#         'organization_name': org.get('name'),
#         'organizationName': org.get('name'),
#         'organization_status': status,
#         'organizationStatus': status,
#         'dashboard_ready': dashboard_ready,
#         'dashboardReady': dashboard_ready,
#         'requires_onboarding': requires_onboarding,
#         'requiresOnboarding': requires_onboarding,
#         'onboarding_completed_at': row.get('onboarding_completed_at'),
#         'onboardingCompletedAt': row.get('onboarding_completed_at'),
#         'must_change_password': bool(row.get('must_change_password')),
#         'mustChangePassword': bool(row.get('must_change_password')),
#         'access_modules': modules,
#         'allowedModules': modules,
#         'moduleAccess': modules,
#         'accessModules': modules,
#         # Admin sees all support-created branches. We expose real branch UUIDs
#         # here for security/context, while dashboard branch routes use cfg.branches
#         # numeric UI ids loaded from bootstrap.
#         'branch_id': None,
#         'branchId': None,
#         'allowedBranchIds': [b.get('id') for b in branches if b.get('id')],
#         'portalAccess': {
#             'desktopDashboard': dashboard_ready,
#             'flutterStaffPortal': False,
#         },
#     }

# def get_client_user_session_by_id(user_id: str) -> dict:
#     """Return one client user's current dashboard/session flags."""
#     sb = get_supabase()
#     result = (
#         sb.table('client_users')
#         .select('id, org_id, email, full_name, role, is_active, must_change_password, onboarding_completed_at, phone, profile_image_url, profile_image_name, password_changed_at, created_at, last_login_at')
#         .eq('id', str(user_id))
#         .limit(1)
#         .execute()
#     )

#     if not result.data:
#         raise ValueError('Client user not found')

#     row = result.data[0]
#     if not row.get('is_active'):
#         raise ValueError('Client user is inactive')

#     return _client_user_session_from_row(row)

# def authenticate_client_user(email: str, password: str) -> Optional[dict]:
#     """Authenticate a Client Dashboard user from Supabase client_users."""
#     sb = get_supabase()
#     result = (
#         sb.table('client_users')
#         .select('id, org_id, email, password_hash, full_name, role, is_active, must_change_password, onboarding_completed_at, phone, profile_image_url, profile_image_name, password_changed_at, created_at, last_login_at')
#         .eq('email', str(email or '').strip().lower())
#         .limit(1)
#         .execute()
#     )

#     if not result.data:
#         return None

#     row = result.data[0]
#     if not row.get('is_active'):
#         return None

#     if not _verify_password(password, row.get('password_hash') or ''):
#         return None

#     try:
#         sb.table('client_users').update({
#             'last_login_at': datetime.now(timezone.utc).isoformat(),
#         }).eq('id', row['id']).execute()
#     except Exception as e:
#         logger.warning(f"Could not update client last_login_at for {email}: {e}")

#     return _client_user_session_from_row(row)

# def _find_active_client_staff_row(
#     identifier: str,
#     password: str,
#     select_columns: str = '*',
# ) -> Optional[dict]:
#     """Look up + verify one client_staff row by email/phone + password.

#     Single source of truth for the credential-checking rules (ambiguous
#     identifier, archived, inactive, bad password) shared by every
#     client_staff login surface — currently the mobile portal
#     (authenticate_client_staff) and the Client Dashboard
#     (authenticate_client_staff_for_dashboard). Each caller passes its own
#     select_columns because they need different shapes downstream (the
#     mobile JWT needs the raw backend branch_id; the Dashboard needs the
#     full row so it can go through _client_staff_safe's UI-mapped shape),
#     but the *rules* for "is this identifier+password valid" must never
#     diverge between them.

#     identifier is matched against email OR phone, exactly as stored — the
#     same raw string Staff Management showed the admin as the "Username /
#     Number" when the employee was created. No normalization is applied here
#     beyond a trim, deliberately: whatever was typed into the Phone/Email
#     fields at creation is what must be typed back in at login.

#     Looked up without an org_id filter, same convention as
#     authenticate_client_user's global email lookup — neither portal has an
#     org context until after login succeeds.

#     Raises ValueError (not returns None) when the identifier is ambiguous,
#     so callers can surface a distinct "contact your administrator" message
#     instead of a generic invalid-credentials response.
#     """
#     clean_identifier = str(identifier or '').strip()
#     if not clean_identifier or not password:
#         return None

#     sb = get_supabase()
#     result = (
#         sb.table('client_staff')
#         .select(select_columns)
#         .or_(f'email.eq.{clean_identifier},phone.eq.{clean_identifier}')
#         .limit(2)
#         .execute()
#     )

#     rows = result.data or []
#     if not rows:
#         return None

#     if len(rows) > 1:
#         # Two active staff rows sharing one email/phone is a data problem,
#         # not a login choice to make on their behalf — fail closed rather
#         # than silently picking the first row (which could hand back the
#         # wrong person's org/branch/attendance data).
#         logger.error(
#             f"Ambiguous client_staff login: {len(rows)} rows matched identifier "
#             f"'{clean_identifier}'. Refusing to authenticate any of them."
#         )
#         raise ValueError(
#             'This email/phone number is registered to more than one account. '
#             'Contact your administrator.'
#         )

#     row = rows[0]

#     if row.get('is_archived'):
#         return None
#     if str(row.get('status') or '').lower() != 'active':
#         return None
#     if not _verify_password(password, row.get('password_hash') or ''):
#         return None

#     return row

# def _touch_client_staff_last_login(staff_id: Any) -> None:
#     """Best-effort last_login_at stamp, shared by every client_staff login
#     surface. Never raises — a failed audit stamp must not fail the login
#     itself."""
#     try:
#         get_supabase().table('client_staff').update({
#             'last_login_at': datetime.now(timezone.utc).isoformat(),
#         }).eq('id', staff_id).execute()
#     except Exception as e:
#         logger.warning(f"Could not update client_staff last_login_at for {staff_id}: {e}")

# def authenticate_client_staff(identifier: str, password: str) -> Optional[dict]:
#     """Authenticate an employee/student/worker (client_staff row) for the
#     mobile portal — NOT the Client Dashboard login, which stays on
#     authenticate_client_user (client_users, admin/HR) or
#     authenticate_client_staff_for_dashboard (client_staff, desktop staff
#     access) below.

#     Selects only the columns the mobile JWT actually needs (see
#     client_staff_auth._mint_token): the raw backend branch_id UUID, not the
#     Dashboard's UI-numeric one. Do not widen this to select('*') and
#     reshape through _client_staff_safe — that would hand the JWT minter a
#     UI-mapped branch_id instead of the real one, breaking tenant scoping
#     on every mobile route that trusts the JWT claim.
#     """
#     row = _find_active_client_staff_row(
#         identifier,
#         password,
#         select_columns=(
#             'id, org_id, branch_id, name, email, phone, password_hash, '
#             'role, people_type, staff_type, status, is_archived, '
#             'employee_id, person_code, profile_image_url, last_login_at'
#         ),
#     )
#     if not row:
#         return None

#     _touch_client_staff_last_login(row['id'])
#     return _safe_client_user(row)

# def authenticate_client_staff_for_dashboard(identifier: str, password: str) -> Optional[dict]:
#     """Authenticate a client_staff row for the Client Dashboard (desktop)
#     login — the counterpart to authenticate_client_user for org admins/HR.

#     client_staff rows only exist for Supabase/UUID organizations (legacy
#     numeric orgs keep staff in the SQLite `users` table via
#     db.authenticate_user), so this is only ever reached as a fallback when
#     authenticate_client_user finds nothing for the given identifier.

#     Returns the same shape produced by list_client_staff/create_client_staff
#     (via _client_staff_safe: UI-mapped branch_id, access_modules, role
#     "staff", etc.) so the frontend's AuthContext.normaliseUser() and
#     routes.tsx's ModuleAccessRoute treat a client_staff login identically to
#     a legacy SQLite staff login — same module-gated dashboard, same
#     branch-scoped routing, no frontend changes required.
#     """
#     from support_db_staff import _client_staff_safe
#     row = _find_active_client_staff_row(identifier, password, select_columns='*')
#     if not row:
#         return None

#     _touch_client_staff_last_login(row['id'])
#     return _client_staff_safe(row, row.get('org_id'))

# def get_client_onboarding_config(org_id: str) -> dict | None:
#     """Retrieve the onboarding configuration for an organization."""
#     result = _execute_supabase(
#         'get_client_onboarding_config',
#         lambda: get_supabase().table('client_onboarding_configs').select('*').eq('org_id', str(org_id)).limit(1),
#     )
#     return result.data[0] if result.data else None

# def _branch_maps(branches: list[dict]) -> tuple[dict[str, int], dict[str, str]]:
#     """Return backend UUID→UI numeric and UI numeric→backend UUID maps."""
#     backend_to_ui: dict[str, int] = {}
#     ui_to_backend: dict[str, str] = {}
#     for idx, branch in enumerate(branches, start=1):
#         backend_id = branch.get('id')
#         if backend_id:
#             backend_to_ui[str(backend_id)] = idx
#             ui_to_backend[str(idx)] = str(backend_id)
#     return backend_to_ui, ui_to_backend

# def _ui_branch_key(raw_key: object, backend_to_ui: dict[str, int]) -> Optional[int]:
#     key = str(raw_key or '').strip()
#     if not key:
#         return None
#     if key in backend_to_ui:
#         return backend_to_ui[key]
#     try:
#         parsed = int(key)
#         return parsed if parsed > 0 else None
#     except (TypeError, ValueError):
#         return None

# def _normalize_named_items_by_branch(value: object, branches: list[dict]) -> dict[str, list[dict]]:
#     """Map branch UUID keys from onboarding into numeric UI keys for dashboard."""
#     backend_to_ui, _ = _branch_maps(branches)
#     result: dict[str, list[dict]] = {str(i): [] for i in range(1, len(branches) + 1)}

#     if not isinstance(value, dict):
#         return result

#     for raw_key, raw_items in value.items():
#         ui_id = _ui_branch_key(raw_key, backend_to_ui)
#         if not ui_id:
#             continue
#         items = raw_items if isinstance(raw_items, list) else []
#         normalized: list[dict] = []
#         for idx, item in enumerate(items, start=1):
#             if not isinstance(item, dict):
#                 continue
#             name = str(item.get('name') or '').strip()
#             if not name:
#                 continue
#             normalized.append({
#                 **item,
#                 'id': item.get('id') or idx,
#                 'name': name,
#             })
#         result[str(ui_id)] = normalized
#     return result

# def _normalize_cameras_by_branch(value: object, branches: list[dict]) -> dict[str, list[dict]]:
#     """Map camera configs from backend branch UUID keys into dashboard UI branch ids."""
#     backend_to_ui, ui_to_backend = _branch_maps(branches)
#     result: dict[str, list[dict]] = {str(i): [] for i in range(1, len(branches) + 1)}

#     if not isinstance(value, dict):
#         return result

#     for raw_key, raw_items in value.items():
#         ui_id = _ui_branch_key(raw_key, backend_to_ui)
#         if not ui_id:
#             continue
#         backend_branch_id = backend_to_ui.get(str(raw_key)) and str(raw_key)
#         if not backend_branch_id:
#             backend_branch_id = ui_to_backend.get(str(ui_id))

#         items = raw_items if isinstance(raw_items, list) else []
#         normalized: list[dict] = []
#         for idx, item in enumerate(items, start=1):
#             if not isinstance(item, dict):
#                 continue
#             cam_id = str(item.get('id') or f'camera-{ui_id}-{idx}').strip()
#             name = str(item.get('name') or f'Camera {idx}').strip()
#             rtsp_url = str(item.get('rtspUrl') or item.get('rtsp_url') or '').strip()
#             normalized.append({
#                 **item,
#                 'id': cam_id,
#                 'branchId': ui_id,
#                 'backend_branch_id': backend_branch_id,
#                 'backendBranchId': backend_branch_id,
#                 'name': name,
#                 'location': str(item.get('location') or name).strip(),
#                 'rtspUrl': rtsp_url,
#                 'rtsp_url': rtsp_url,
#                 'channel': str(item.get('channel') or '').strip(),
#                 'type': item.get('type') or 'nvr',
#                 'status': item.get('status') or 'Normal',
#                 'streamPath': item.get('streamPath') or item.get('stream_path'),
#             })
#         result[str(ui_id)] = normalized
#     return result

# def _merge_operational_config(base_config: dict, saved: Optional[dict], branches: list[dict]) -> dict:
#     """
#     Merge client operational configuration into support-owned base config.

#     Supabase is the source of truth. Support-owned values stay authoritative:
#     branches, capacities, purchased modules, attendance mode, and max branches.
#     Client-owned values come from client_onboarding_configs.
#     """
#     if not saved:
#         return base_config

#     merged = dict(base_config)

#     company_profile = saved.get('company_profile') or {}
#     if isinstance(company_profile, dict):
#         address = company_profile.get('address') or ''
#         city = company_profile.get('city') or ''
#         public_contact_phone = company_profile.get('publicContactPhone') or company_profile.get('public_contact_phone') or ''
#         timezone_value = company_profile.get('timezone') or 'Asia/Karachi'
#         logo = company_profile.get('logoDataUrl') or company_profile.get('logo') or None
#         merged.update({
#             'tagline': company_profile.get('tagline') or merged.get('tagline') or '',
#             'address': address,
#             'city': city,
#             'publicContactPhone': public_contact_phone,
#             'public_contact_phone': public_contact_phone,
#             'timezone': timezone_value,
#             'size': company_profile.get('size') or merged.get('size') or '',
#             'logo': logo,
#             # Terminology is support-owned on organizations.people_kind.
#             # Client onboarding profile can no longer override it.
#             'companyProfile': company_profile,
#             'company_profile': company_profile,
#         })

#     merged['departments'] = _normalize_named_items_by_branch(saved.get('departments'), branches)
#     merged['roles'] = _normalize_named_items_by_branch(saved.get('roles'), branches)
#     merged['cameras'] = _normalize_cameras_by_branch(saved.get('cameras'), branches)
#     merged['network'] = saved.get('network') or {}
#     merged['networkConfig'] = saved.get('network') or {}

#     # Per-people-type shift enablement (Settings.tsx's Shift Scheduling
#     # panel). Both casings are set to match this function's existing
#     # convention (see publicContactPhone/public_contact_phone, network/
#     # networkConfig above) — templateRendering.ts and templateColumns.ts on
#     # the client both check camelCase first, snake_case as a fallback.
#     merged['shifts'] = saved.get('shifts') or []
#     merged['staffShiftDefinitions'] = saved.get('staffShiftDefinitions') or saved.get('shifts') or []
#     shift_enabled_people_types = saved.get('shift_enabled_people_types') or saved.get('shiftEnabledPeopleTypes') or []
#     merged['shiftEnabledPeopleTypes'] = shift_enabled_people_types
#     merged['shift_enabled_people_types'] = shift_enabled_people_types

#     merged['onboardingCompleted'] = bool(saved.get('completed_at'))
#     merged['onboarding_completed_at'] = saved.get('completed_at')
#     merged['onboardingCompletedAt'] = saved.get('completed_at')
#     return merged

# def get_client_bootstrap(org_id: str) -> dict:
#     """Return all setup needed by Client Dashboard from Supabase.

#     Bootstrap is the page gate for Client Dashboard. It must be fast and must
#     never fail because optional billing/onboarding helper data is temporarily
#     unavailable. Org, branches, modules, and onboarding are fetched in parallel;
#     the final dashboard config is still derived locally and tenant-scoped.
#     """
#     from support_db_branches import list_branches, list_org_modules
#     from support_db_organizations import get_organization
#     org_key = str(org_id)

#     import concurrent.futures

#     with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
#         f_org = pool.submit(get_organization, org_key)
#         f_branches = pool.submit(list_branches, org_key)
#         f_modules = pool.submit(list_org_modules, org_key)
#         f_onboarding = pool.submit(get_client_onboarding_config, org_key)
#         f_module_people_types = pool.submit(list_org_branch_module_people_types, org_key)

#         org = f_org.result()
#         branches = f_branches.result()
#         modules = f_modules.result()
#         onboarding_config = f_onboarding.result()
#         module_people_types_by_branch = f_module_people_types.result()

#     active_module_keys = [
#         _map_module_for_client(m.get('module_name'))
#         for m in modules
#         if m.get('status') == 'active'
#     ]

#     latest_invoice = None
#     try:
#         latest_invoice = _latest_invoice(org_key)
#     except Exception as exc:
#         logger.warning('Could not load latest invoice for org=%s during bootstrap: %s', org_key, exc)

#     access_status = org.get('status') or _compute_org_status(org_key)
#     onboarding_completed = bool(onboarding_config and onboarding_config.get('completed_at'))
#     base_config = _build_client_config(org, branches, active_module_keys, module_people_types_by_branch=module_people_types_by_branch)
#     config = _merge_operational_config(base_config, onboarding_config, branches)

#     return {
#         'organization': org,
#         'branches': branches,
#         'modules': modules,
#         'active_modules': active_module_keys,
#         'activeModules': active_module_keys,
#         'latest_invoice': latest_invoice,
#         'latestInvoice': latest_invoice,
#         'access_status': access_status,
#         'accessStatus': access_status,
#         'onboarding_config': onboarding_config,
#         'onboardingConfig': onboarding_config,
#         'onboarding_completed': onboarding_completed,
#         'onboardingCompleted': onboarding_completed,
#         'requires_onboarding': not onboarding_completed,
#         'requiresOnboarding': not onboarding_completed,
#         'dashboard_ready': bool(onboarding_completed and _org_access_allows_client(access_status)),
#         'dashboardReady': bool(onboarding_completed and _org_access_allows_client(access_status)),
#         'permissions': {
#             'can_change_business_type': False,
#             'can_change_attendance_mode': False,
#             'can_change_modules': False,
#             'can_add_branch_beyond_limit': False,
#         },
#         'config': config,
#     }

# def _branch_backend_id(raw_key: object, branches: list[dict]) -> Optional[str]:
#     """Resolve a dashboard branch key to the real Supabase branch UUID.

#     The current React dashboard may use numeric UI branch ids (1, 2, 3), while
#     Supabase-owned data must be stored by real branches.id UUIDs. This accepts
#     both shapes so onboarding can safely save operational config.
#     """
#     key = str(raw_key or '').strip()
#     if not key:
#         return None

#     by_backend = {str(branch.get('id')): str(branch.get('id')) for branch in branches if branch.get('id')}
#     if key in by_backend:
#         return by_backend[key]

#     try:
#         ui_id = int(key)
#     except (TypeError, ValueError):
#         return None

#     if ui_id < 1 or ui_id > len(branches):
#         return None

#     backend_id = branches[ui_id - 1].get('id')
#     return str(backend_id) if backend_id else None

# def _normalize_branch_keyed_config(value: object, branches: list[dict], bucket_name: str) -> dict[str, list[dict]]:
#     """Normalize branch-keyed onboarding buckets to real branch UUID keys.

#     Accepts incoming config keyed by either real Supabase branch UUIDs or current
#     dashboard numeric route ids. Empty/missing branches are returned as empty
#     arrays so saved config remains predictable.
#     """
#     result: dict[str, list[dict]] = {
#         str(branch.get('id')): []
#         for branch in branches
#         if branch.get('id')
#     }

#     if value in (None, ''):
#         return result

#     if not isinstance(value, dict):
#         raise ValueError(f'{bucket_name} must be an object keyed by branch id')

#     for raw_key, raw_items in value.items():
#         backend_id = _branch_backend_id(raw_key, branches)
#         if not backend_id:
#             raise ValueError(f'{bucket_name} contains a branch that is not owned by this organization')

#         if raw_items in (None, ''):
#             result[backend_id] = []
#             continue

#         if not isinstance(raw_items, list):
#             raise ValueError(f'{bucket_name}[{raw_key}] must be an array')

#         result[backend_id] = [item for item in raw_items if isinstance(item, dict)]

#     return result

# def _clean_optional_text(value: object) -> Optional[str]:
#     if value is None:
#         return None
#     text = str(value).strip()
#     return text or None

# def _first_present(mapping: dict, *keys: str):
#     for key in keys:
#         if key in mapping and mapping.get(key) not in (None, ''):
#             return mapping.get(key)
#     return None

# def _int_or_default(value: object, default: int) -> int:
#     try:
#         if value is None or str(value).strip() == '':
#             return default
#         return int(value)
#     except (TypeError, ValueError):
#         return default

# def _bool_or_default(value: object, default: bool = True) -> bool:
#     if isinstance(value, bool):
#         return value
#     if value is None:
#         return default
#     return str(value).strip().lower() not in {'0', 'false', 'no', 'off'}

# def _branch_network_from_config(network_config: object, branch_id: str, branches: list[dict]) -> dict:
#     """Return one branch's NVR/network config from several supported shapes.

#     Supported shapes:
#       network: {"<branch_uuid>": {...}}
#       network: {"1": {...}}
#       network: {"byBranch": {"<branch_uuid>": {...}}}
#       network: {"branches": {"1": {...}}}
#       network: {publicIp/nvrLocalIp/rtspUsername/...}  # flat, applied to all
#     """
#     if not isinstance(network_config, dict):
#         return {}

#     candidate = None

#     # Direct branch-keyed object.
#     for raw_key, raw_value in network_config.items():
#         if isinstance(raw_value, dict) and _branch_backend_id(raw_key, branches) == branch_id:
#             candidate = raw_value
#             break

#     # Nested branch-keyed objects used by some React forms.
#     if candidate is None:
#         for container_key in ('byBranch', 'branches', 'branchConfigs', 'networkByBranch', 'configs'):
#             nested = network_config.get(container_key)
#             if not isinstance(nested, dict):
#                 continue
#             for raw_key, raw_value in nested.items():
#                 if isinstance(raw_value, dict) and _branch_backend_id(raw_key, branches) == branch_id:
#                     candidate = raw_value
#                     break
#             if candidate is not None:
#                 break

#     # Flat network object applied to all branches.
#     if candidate is None:
#         flat_fields = {
#             'public_ip', 'publicIp', 'wan_ip', 'wanIp',
#             'nvr_local_ip', 'nvrLocalIp', 'nvr_dvr_ip', 'nvrDvrIp',
#             'rtsp_port', 'rtspPort', 'rtsp_username', 'rtspUsername',
#             'rtsp_password', 'rtspPassword',
#         }
#         if any(key in network_config for key in flat_fields):
#             candidate = network_config

#     return dict(candidate or {})

# _VALID_CAMERA_TYPES: frozenset[str] = frozenset({'nvr', 'dvr', 'ip_camera', 'webcam'})

# def _normalize_camera_type(value: object) -> str:
#     text = str(value or '').strip().lower().replace(' ', '_').replace('-', '_')
#     return text if text in _VALID_CAMERA_TYPES else 'nvr'

# def _normalize_local_node_camera_row(camera: dict, org_id: str, branch_id: str) -> dict:
#     name = _clean_optional_text(
#         _first_present(camera, 'camera_name', 'cameraName', 'name', 'label')
#     ) or 'Camera'
#     camera_type = _normalize_camera_type(_first_present(camera, 'camera_type', 'cameraType', 'type'))

#     # A webcam is physically attached to one local machine — it has no
#     # network address a cloud worker could ever reach. Never persist a
#     # public RTSP URL for one, regardless of what the dashboard form sent;
#     # this mirrors the DB CHECK constraint so app code can't drift from it.
#     public_rtsp_url = (
#         _clean_optional_text(_first_present(camera, 'public_rtsp_url', 'publicRtspUrl'))
#         if camera_type != 'webcam' else None
#     )

#     return {
#         'organization_id': str(org_id),
#         'branch_id': str(branch_id),
#         'camera_name': name,
#         'camera_type': camera_type,
#         'channel': _int_or_default(_first_present(camera, 'channel', 'camera_channel', 'cameraChannel'), 1),
#         'stream_path': _clean_optional_text(_first_present(camera, 'stream_path', 'streamPath', 'path')),
#         'rtsp_url': _clean_optional_text(_first_present(camera, 'rtsp_url', 'rtspUrl')),
#         'public_rtsp_url': public_rtsp_url,
#         'location': _clean_optional_text(_first_present(camera, 'location', 'placement')),
#         'enabled': _bool_or_default(_first_present(camera, 'enabled', 'is_enabled', 'isEnabled'), True),
#         'updated_at': datetime.now(timezone.utc).isoformat(),
#     }

# def _sync_local_node_camera_config(
#     sb,
#     *,
#     org_id: str,
#     branches: list[dict],
#     cameras_by_branch: dict[str, list[dict]],
#     network_config: object,
#     updated_at: str,
# ) -> dict:
#     """Mirror onboarding CCTV config into tables consumed by Local Node.

#     client_onboarding_configs keeps the dashboard configuration. The local node
#     does not read that JSON directly; it reads branch_network_configs and
#     branch_cameras through /api/local-node/config. This function keeps those
#     tables in sync whenever onboarding is completed.
#     """
#     synced_branches = 0
#     synced_cameras = 0

#     for branch in branches:
#         branch_id = str(branch.get('id') or '').strip()
#         if not branch_id:
#             continue

#         branch_cameras = cameras_by_branch.get(branch_id) or []
#         branch_network = _branch_network_from_config(network_config, branch_id, branches)

#         # If there is neither camera nor network data for this branch, leave any
#         # old local-node rows alone. This avoids deleting a manually configured
#         # node when a partial onboarding/profile update omits CCTV data.
#         if not branch_cameras and not branch_network:
#             continue

#         network_payload = {
#             'organization_id': str(org_id),
#             'branch_id': branch_id,
#             'public_ip': _clean_optional_text(_first_present(branch_network, 'public_ip', 'publicIp', 'wan_ip', 'wanIp')),
#             'nvr_local_ip': _clean_optional_text(_first_present(branch_network, 'nvr_local_ip', 'nvrLocalIp', 'nvr_dvr_ip', 'nvrDvrIp', 'local_ip', 'localIp', 'nvrIp', 'dvrIp', 'ip')),
#             'rtsp_port': _int_or_default(_first_present(branch_network, 'rtsp_port', 'rtspPort', 'port'), 554),
#             'rtsp_username': _clean_optional_text(_first_present(branch_network, 'rtsp_username', 'rtspUsername', 'username', 'nvrUsername')),
#             'rtsp_password': _clean_optional_text(_first_present(branch_network, 'rtsp_password', 'rtspPassword', 'password', 'nvrPassword')),
#             'updated_at': updated_at,
#         }

#         # A network row is required even when each camera already has a complete
#         # rtsp_url, because /api/local-node/config first checks
#         # branch_network_configs before returning cameras.
#         network_result = (
#             sb.table('branch_network_configs')
#             .upsert(network_payload, on_conflict='organization_id,branch_id')
#             .execute()
#         )
#         if not network_result.data:
#             raise RuntimeError('Failed to save branch network configuration')

#         # Onboarding is source of truth for cameras for this branch.
#         sb.table('branch_cameras').delete().eq('organization_id', str(org_id)).eq('branch_id', branch_id).execute()

#         camera_rows = [
#             _normalize_local_node_camera_row(camera, str(org_id), branch_id)
#             for camera in branch_cameras
#             if isinstance(camera, dict)
#         ]
#         if camera_rows:
#             camera_result = sb.table('branch_cameras').insert(camera_rows).execute()
#             if not camera_result.data:
#                 raise RuntimeError('Failed to save branch camera configuration')
#             synced_cameras += len(camera_result.data)

#         synced_branches += 1

#     return {
#         'synced_branches': synced_branches,
#         'synced_cameras': synced_cameras,
#     }

# def _extract_company_profile(config: dict, org: dict) -> dict:
#     """Extract client-owned company profile fields from onboarding config."""
#     profile = config.get('company_profile') if isinstance(config.get('company_profile'), dict) else {}

#     return {
#         'orgName': org.get('name') or config.get('orgName') or '',
#         'bizType': org.get('org_type') or config.get('bizType') or 'business',
#         'tagline': profile.get('tagline') or config.get('tagline') or '',
#         'address': profile.get('address') or config.get('address') or '',
#         'city': profile.get('city') or config.get('city') or '',
#         'publicContactPhone': profile.get('publicContactPhone') or profile.get('public_contact_phone') or '',
#         'timezone': profile.get('timezone') or 'Asia/Karachi',
#         'size': profile.get('size') or config.get('size') or '',
#         'logo': profile.get('logo') or profile.get('logoDataUrl') or config.get('logo'),
#         'logoDataUrl': profile.get('logoDataUrl') or profile.get('logo') or config.get('logo'),
#         'logoFileName': profile.get('logoFileName') or '',
#     }

# def save_client_onboarding_config(user_id: str, org_id: str, config: dict) -> dict:
#     """
#     Complete invited-client onboarding.

#     This does NOT create a new organization or new commercial branches/modules.
#     It saves only operational configuration against the organization created by
#     QIntellect Support Dashboard.
#     """
#     from support_db_branches import list_branches
#     from support_db_organizations import get_organization
#     from support_db_staff import _normalize_people_type
#     if not isinstance(config, dict):
#         raise ValueError('config must be an object')

#     sb = get_supabase()
#     org = get_organization(str(org_id))

#     user_result = (
#         sb.table('client_users')
#         .select('id, org_id, email, full_name, role, is_active, must_change_password, onboarding_completed_at')
#         .eq('id', str(user_id))
#         .limit(1)
#         .execute()
#     )

#     if not user_result.data:
#         raise ValueError('Client user not found')

#     client_user = user_result.data[0]

#     if not client_user.get('is_active'):
#         raise ValueError('Client user is inactive')

#     if str(client_user.get('org_id')) != str(org_id):
#         raise ValueError('Client user does not belong to this organization')

#     support_branches = list_branches(str(org_id))

#     # Normalize incoming branch-keyed operational config to real Supabase branch
#     # UUIDs. This accepts both current dashboard UI branch ids (1, 2, 3) and
#     # backend branch UUIDs, but only stores UUID keys.
#     normalized_departments = _normalize_branch_keyed_config(
#         config.get('departments') or {},
#         support_branches,
#         'departments',
#     )
#     normalized_roles = _normalize_branch_keyed_config(
#         config.get('roles') or {},
#         support_branches,
#         'roles',
#     )
#     normalized_cameras = _normalize_branch_keyed_config(
#         config.get('cameras') or {},
#         support_branches,
#         'cameras',
#     )
#     network_config = config.get('network') or config.get('networkConfig') or {}

#     # Shift Scheduling (Settings.tsx's ShiftSchedulingEditor) — which people
#     # types use shift-based attendance. Read on the client via
#     # resolvePeopleRenderingModel's supportsShift (templateRendering.ts) and
#     # its DRY-mirrored copy in templateColumns.ts, both of which check
#     # cfg.shiftEnabledPeopleTypes. Previously this payload never included
#     # the field and _merge_operational_config below never read it back, so
#     # every save silently reverted to the `!isStudent` fallback on the next
#     # bootstrap — the Shift tab/fields could never actually be enabled for
#     # students (or disabled for a workforce type) regardless of what was
#     # checked here.
#     shift_enabled_people_types = sorted({
#         _normalize_people_type(value)
#         for value in (
#             config.get('shiftEnabledPeopleTypes')
#             or config.get('shift_enabled_people_types')
#             or []
#         )
#         if str(value or '').strip()
#     })

#     now = datetime.now(timezone.utc).isoformat()

#     payload = {
#         'org_id': str(org_id),
#         'completed_by': str(user_id),
#         'company_profile': _extract_company_profile(config, org),
#         # Store operational data keyed by real Supabase branch UUIDs.
#         # get_client_bootstrap maps them back to numeric UI ids for the current dashboard.
#         'departments': normalized_departments,
#         'roles': normalized_roles,
#         'shifts': [],
#         'shift_enabled_people_types': shift_enabled_people_types,
#         'cameras': normalized_cameras,
#         'network': network_config,
#         'completed_at': now,
#         'updated_at': now,
#     }

#     saved = sb.table('client_onboarding_configs').upsert(
#         payload,
#         on_conflict='org_id',
#     ).execute()

#     if not saved.data:
#         raise RuntimeError('Failed to save client onboarding configuration')

#     camera_sync = _sync_local_node_camera_config(
#         sb,
#         org_id=str(org_id),
#         branches=support_branches,
#         cameras_by_branch=normalized_cameras,
#         network_config=network_config,
#         updated_at=now,
#     )

#     sb.table('client_users').update({
#         'onboarding_completed_at': now,
#     }).eq('id', str(user_id)).execute()

#     session_user = get_client_user_session_by_id(str(user_id))
#     bootstrap = get_client_bootstrap(str(org_id))

#     return {
#         'user': session_user,
#         'camera_sync': camera_sync,
#         'cameraSync': camera_sync,
#         **bootstrap,
#     }

# def _person_code_from_payload(payload: dict, people_type: str, fallback: str = '') -> str:
#     value = (
#         payload.get('person_code')
#         or payload.get('personCode')
#         or payload.get('registration_number')
#         or payload.get('registrationNumber')
#         or payload.get('employee_number')
#         or payload.get('employeeNumber')
#         or payload.get('worker_id')
#         or payload.get('workerId')
#         or payload.get('teacher_code')
#         or payload.get('teacherCode')
#         or payload.get('employee_id')
#         or fallback
#     )
#     text = str(value or '').strip()
#     if not text:
#         raise ValueError('Person code is required.')
#     return text

# def _person_code_label(people_type: object) -> str:
#     from support_db_staff import _normalize_people_type
#     key = _normalize_people_type(people_type)
#     if key == 'student':
#         return 'Registration Number'
#     if key == 'teacher':
#         return 'Teacher Code'
#     if key == 'worker':
#         return 'Worker ID'
#     if key == 'employee':
#         return 'Employee ID'
#     return 'Staff ID'

# def _assert_unique_client_staff_person_code(
#     *,
#     org_id: str,
#     branch_id: str,
#     people_type: str,
#     person_code: str,
#     exclude_staff_id: str | None = None,
# ) -> None:
#     from support_db_staff import _normalize_people_type
#     query = (
#         get_supabase()
#         .table('client_staff')
#         .select('id, name, person_code')
#         .eq('org_id', str(org_id))
#         .eq('branch_id', str(branch_id))
#         .eq('people_type', _normalize_people_type(people_type))
#         .ilike('person_code', str(person_code).strip())
#         .eq('is_archived', False)
#         .limit(1)
#     )
#     if exclude_staff_id:
#         query = query.neq('id', str(exclude_staff_id))
#     result = query.execute()
#     if result.data:
#         raise ValueError(f'{_person_code_label(people_type)} already exists in this branch.')

# def _assert_unique_client_staff_login_identifier(
#     *,
#     email: str | None,
#     phone: str | None,
#     exclude_staff_id: str | None = None,
# ) -> None:
#     """Two client_staff rows can never share an email or phone, checked
#     globally across every org — not scoped to one branch/org the way
#     person_code is.

#     This has to match the scope of authenticate_client_staff's lookup
#     (mobile portal login), which also searches client_staff by email OR
#     phone with no org_id filter, since a field worker's login request
#     carries no org context until after that lookup succeeds. If two staff
#     rows anywhere were allowed to share an identifier, authenticate_client_
#     staff would find both, refuse to guess which one is logging in, and
#     neither employee could log in at all — so this has to be prevented at
#     creation/edit time, not discovered later at someone's login attempt.

#     Only checks whichever of email/phone was actually supplied — a value
#     left blank isn't a collision candidate against other blank values,
#     since client_staff.email/phone are stored as NULL, not empty string,
#     when absent (see create_client_staff/update_client_staff).
#     """
#     sb = get_supabase()

#     if email:
#         query = (
#             sb.table('client_staff')
#             .select('id')
#             .eq('email', email)
#             .eq('is_archived', False)
#             .limit(1)
#         )
#         if exclude_staff_id:
#             query = query.neq('id', str(exclude_staff_id))
#         if query.execute().data:
#             raise ValueError(
#                 'This email is already used by another person. Please use a different email.'
#             )

#     if phone:
#         query = (
#             sb.table('client_staff')
#             .select('id')
#             .eq('phone', phone)
#             .eq('is_archived', False)
#             .limit(1)
#         )
#         if exclude_staff_id:
#             query = query.neq('id', str(exclude_staff_id))
#         if query.execute().data:
#             raise ValueError(
#                 'This phone number is already used by another person. Please use a different number.'
#             )

# def update_client_user_profile(user_id: str, payload: dict) -> dict:
#     """
#     Update an invited Client Dashboard admin/HR profile in Supabase client_users.
 
#     Separation of concerns:
#       - Profile fields (name, email, phone, photo) are updated independently.
#       - Password change requires current_password bcrypt verification.
#       - must_change_password is only cleared on a successful password change.
#       - A profile-only save never touches password state at all.
 
#     Raises:
#       ValueError  — business-rule violation (caught by route → 400)
#       RuntimeError — unexpected DB failure (caught by route → 500)
#     """
#     sb = get_supabase()
 
#     # ── Fetch current row ────────────────────────────────────────────────────
#     fetch_result = (
#         sb.table('client_users')
#         .select(
#             'id, org_id, email, password_hash, full_name, role, '
#             'is_active, must_change_password, onboarding_completed_at, '
#             'phone, profile_image_url, profile_image_name, password_changed_at'
#         )
#         .eq('id', str(user_id))
#         .limit(1)
#         .execute()
#     )
 
#     if not fetch_result.data:
#         raise ValueError('Client user not found')
 
#     current = fetch_result.data[0]
 
#     if not current.get('is_active'):
#         raise ValueError('Client user is inactive')
 
#     update_data: dict = {}
 
#     # ── Profile fields ───────────────────────────────────────────────────────
 
#     # name / full_name — accept either alias the frontend may send
#     name_value = payload.get('full_name') or payload.get('name')
#     if name_value is not None:
#         full_name = str(name_value).strip()
#         if not full_name:
#             raise ValueError('Name is required')
#         update_data['full_name'] = full_name
 
#     if 'email' in payload:
#         email = str(payload.get('email') or '').strip().lower()
#         if not email:
#             raise ValueError('Email is required')
 
#         # Pre-flight uniqueness check: raises a deterministic ValueError instead
#         # of relying on catching Supabase's unique-constraint exception message.
#         if email != current.get('email', '').lower():
#             conflict = (
#                 sb.table('client_users')
#                 .select('id')
#                 .eq('email', email)
#                 .neq('id', str(user_id))
#                 .limit(1)
#                 .execute()
#             )
#             if conflict.data:
#                 raise ValueError('This email is already used by another account')
 
#         update_data['email'] = email
 
#     if 'phone' in payload:
#         phone = str(payload.get('phone') or '').strip()
#         update_data['phone'] = phone or None
 
#     # Photo URL — accept any of the three aliases the frontend may send
#     photo_url_value = (
#         payload.get('profile_image_url')
#         or payload.get('profileImageUrl')
#         or payload.get('photo_url')
#     )
#     if photo_url_value is not None:
#         update_data['profile_image_url'] = str(photo_url_value).strip() or None
 
#     photo_name_value = (
#         payload.get('profile_image_name')
#         or payload.get('profileImageName')
#     )
#     if photo_name_value is not None:
#         update_data['profile_image_name'] = str(photo_name_value).strip() or None
 
#     # ── Password change ──────────────────────────────────────────────────────
#     current_password = str(payload.get('current_password') or '')
#     new_password = str(payload.get('new_password') or '')
 
#     if new_password:
#         if len(new_password) < 6:
#             raise ValueError('New password must be at least 6 characters')
 
#         if not current_password:
#             raise ValueError('Current password is required to change password')
 
#         if not _verify_password(current_password, current.get('password_hash') or ''):
#             raise ValueError('Current password is incorrect')
 
#         update_data['password_hash'] = _hash_password(new_password)
#         update_data['must_change_password'] = False
#         update_data['password_changed_at'] = datetime.now(timezone.utc).isoformat()
 
#     # Nothing to update — return the current session without a write round-trip
#     if not update_data:
#         return _client_user_session_from_row(current)
 
#     update_data['updated_at'] = datetime.now(timezone.utc).isoformat()
 
#     # ── Persist ──────────────────────────────────────────────────────────────
#     try:
#         saved = (
#             sb.table('client_users')
#             .update(update_data)
#             .eq('id', str(user_id))
#             .execute()
#         )
#     except Exception as exc:
#         # Supabase unique-constraint violations should have been caught by the
#         # pre-flight check above. This handles unexpected DB-level errors.
#         raise RuntimeError(f'Profile update failed: {exc}') from exc
 
#     if not saved.data:
#         raise RuntimeError(
#             f'Profile update for client_user {user_id} returned no data. '
#             'Verify the row exists and RLS policies allow updates.'
#         )
 
#     # Re-fetch via the canonical session builder so the response shape is
#     # identical to what login / refreshUser return.
#     return get_client_user_session_by_id(str(user_id))


"""
support_db_client_users.py
───────────────────────────────────────────────────────────────────────────────
Client dashboard user accounts/invites, authentication, onboarding config,
and profile management.

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
import re
from urllib.parse import urlparse
from supabase_client import get_supabase, reset_supabase_client
from logger_config import get_logger

logger = get_logger(__name__)
from support_db_core import _compute_org_status, _execute_supabase, _json_dict, _json_list, _org_access_allows_client
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

_CLIENT_MODULE_MAP: dict[str, str] = {
    # ── Canonical keys (what moduleRegistry.ts uses, what we now store) ──
    'attendance':       'attendance',
    'employees':        'employees',
    'leave':            'leave',
    'payroll':          'payroll',
    'overtime':         'overtime',
    'reports':          'reports',
    'cctv':             'cctv',
    'liveattendance':   'liveattendance',
    # ── Legacy aliases (old DB rows / old clients) ────────────────────────
    'staff_directory':  'employees',
    'leave_management': 'leave',
    'live_attendance':  'liveattendance',
    'livecctv':         'cctv',
    'liveattendancemonitoring': 'liveattendance',
}

_VALID_MODULES: frozenset[str] = frozenset({
    'attendance',
    'employees',
    'leave',
    'payroll',
    'overtime',
    'reports',
    'cctv',
    'liveattendance',
})

_MODULE_ALIASES: dict[str, str] = {
    'staff_directory':          'employees',
    'leave_management':         'leave',
    'live_attendance':          'liveattendance',
    'livecctv':                 'cctv',
    'liveattendancemonitoring': 'liveattendance',
}

def _normalise_module_name(raw: str) -> str:
    """
    Resolve a raw incoming module name to its canonical stored form.
 
    Accepts both canonical keys and legacy aliases so old API clients and
    existing DB rows are never broken. Raises ValueError for unknown modules.
    """
    key = str(raw or '').strip().lower()
    if key in _VALID_MODULES:
        return key
    canonical = _MODULE_ALIASES.get(key)
    if canonical:
        return canonical
    raise ValueError(
        f"Unknown module: {raw!r}. "
        f"Valid modules are: {', '.join(sorted(_VALID_MODULES))}"
    )

def _map_module_for_client(module_name: str) -> str:
    """Map a stored module_name to the key the client dashboard expects."""
    return _CLIENT_MODULE_MAP.get(
        str(module_name or '').strip().lower(),
        str(module_name or '').strip().lower(),
    )

def _safe_client_user(row: dict) -> dict:
    return {k: v for k, v in (row or {}).items() if k != 'password_hash'}

def _generate_temp_password(length: int = 16) -> str:
    alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_'
    return ''.join(secrets.choice(alphabet) for _ in range(length))

def _hash_password(raw_password: str) -> str:
    return bcrypt.hashpw(raw_password.encode('utf-8'), bcrypt.gensalt(12)).decode('utf-8')

def _verify_password(raw_password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(raw_password.encode('utf-8'), password_hash.encode('utf-8'))
    except Exception:
        return False

def validate_strong_password(new_password: str) -> None:
    """
    Single source of truth for password-strength rules across every
    self-service password-change path (client_users, client_staff, and the
    legacy numeric-id dashboard route in app.py all call this).

    Rules: 8+ characters, at least one uppercase, one lowercase, one digit,
    and one special character. Raises ValueError with a user-facing message
    on the first rule that fails, so callers can surface it as a 400
    directly — same pattern as every other validation in this module.
    """
    pw = str(new_password or '')

    if len(pw) < 8:
        raise ValueError('Password must be at least 8 characters long')
    if not re.search(r'[A-Z]', pw):
        raise ValueError('Password must include at least one uppercase letter')
    if not re.search(r'[a-z]', pw):
        raise ValueError('Password must include at least one lowercase letter')
    if not re.search(r'[0-9]', pw):
        raise ValueError('Password must include at least one number')
    if not re.search(r'[^A-Za-z0-9]', pw):
        raise ValueError('Password must include at least one special character')


def _active_client_modules(org_id: str) -> list[str]:
    from support_db_branches import list_org_modules
    modules = list_org_modules(org_id)
    return [
        _map_module_for_client(m.get('module_name'))
        for m in modules
        if m.get('status') == 'active' and m.get('module_name')
    ]

def _normalize_branch_module_people_type_entries(payload: object) -> dict[str, list[str]]:
    from support_db_staff import _normalize_people_type
    if isinstance(payload, dict) and 'module_people_types' in payload and isinstance(payload.get('module_people_types'), dict):
        payload = payload.get('module_people_types')
    if isinstance(payload, dict) and 'modulePeopleTypes' in payload and isinstance(payload.get('modulePeopleTypes'), dict):
        payload = payload.get('modulePeopleTypes')
    if not isinstance(payload, dict):
        raise ValueError('module_people_types must be an object keyed by module name')

    normalized: dict[str, list[str]] = {}
    for raw_module, raw_people_types in payload.items():
        module_key = _normalise_module_name(raw_module)
        if isinstance(raw_people_types, str):
            raw_values = [raw_people_types]
        elif isinstance(raw_people_types, list):
            raw_values = raw_people_types
        else:
            raw_values = []

        seen: set[str] = set()
        values: list[str] = []
        for raw_value in raw_values:
            people_type = _normalize_people_type(raw_value, 'staff')
            if not people_type or people_type in seen:
                continue
            seen.add(people_type)
            values.append(people_type)

        normalized[module_key] = values

    return normalized

def list_branch_module_people_types(org_id: str, branch_id: str) -> dict[str, list[str]]:
    from support_db_branches import _get_branch_for_update
    from support_db_organizations import get_organization
    from support_db_staff import _normalize_people_type
    get_organization(str(org_id))
    _get_branch_for_update(str(branch_id), str(org_id))

    try:
        result = _execute_supabase(
            'list_branch_module_people_types',
            lambda: (
                get_supabase()
                .table('branch_module_people_types')
                .select('*')
                .eq('org_id', str(org_id))
                .eq('branch_id', str(branch_id))
                
            ),
        )
    except Exception as exc:
        if _table_missing(exc, 'branch_module_people_types'):
            logger.warning('branch_module_people_types table is missing; returning empty module people-type config')
            return {}
        raise

    mapping: dict[str, list[str]] = {}
    for row in result.data or []:
        module_key = _normalise_module_name(row.get('module_key'))
        people_type = _normalize_people_type(row.get('people_type'), 'staff')
        mapping.setdefault(module_key, [])
        if people_type not in mapping[module_key]:
            mapping[module_key].append(people_type)

    return mapping

def set_branch_module_people_types(org_id: str, branch_id: str, module_people_types: object) -> dict[str, list[str]]:
    from support_db_branches import _get_branch_for_update
    from support_db_organizations import get_organization
    get_organization(str(org_id))
    _get_branch_for_update(str(branch_id), str(org_id))
    normalized = _normalize_branch_module_people_type_entries(module_people_types)

    try:
        sb = get_supabase()
        sb.table('branch_module_people_types').delete().eq('org_id', str(org_id)).eq('branch_id', str(branch_id)).execute()
        rows = [
            {
                'org_id': str(org_id),
                'branch_id': str(branch_id),
                'module_key': module_key,
                'people_type': people_type,
            }
            for module_key, people_types in normalized.items()
            for people_type in people_types
        ]
        if rows:
            sb.table('branch_module_people_types').insert(rows).execute()
        return list_branch_module_people_types(str(org_id), str(branch_id))
    except Exception as exc:
        if _table_missing(exc, 'branch_module_people_types'):
            logger.warning('branch_module_people_types table is missing; nothing persisted')
            return {}
        raise

def list_org_branch_module_people_types(org_id: str) -> dict[str, dict[str, list[str]]]:
    from support_db_staff import _normalize_people_type
    try:
        result = _execute_supabase(
            'list_org_branch_module_people_types',
            lambda: (
                get_supabase()
                .table('branch_module_people_types')
                .select('*')
                .eq('org_id', str(org_id))
                
            ),
        )
    except Exception as exc:
        if _table_missing(exc, 'branch_module_people_types'):
            logger.warning('branch_module_people_types table is missing; returning empty org-wide config')
            return {}
        raise

    mapping: dict[str, dict[str, list[str]]] = {}
    for row in result.data or []:
        branch_id = str(row.get('branch_id') or '')
        module_key = _normalise_module_name(row.get('module_key'))
        people_type = _normalize_people_type(row.get('people_type'), 'staff')
        if not branch_id:
            continue
        mapping.setdefault(branch_id, {})
        mapping[branch_id].setdefault(module_key, [])
        if people_type not in mapping[branch_id][module_key]:
            mapping[branch_id][module_key].append(people_type)

    return mapping

def _seed_default_branch_module_people_types(
    org_id: str,
    branch_id: str,
    module_keys: list[str] | None = None,
) -> None:
    """
    Insert default `branch_module_people_types` rows for a branch: every
    module in `module_keys` (defaults to the org's currently-active modules)
    x every people type in the org's `enabled_people_types`.

    Idempotent and non-destructive by design: a module is only seeded if the
    branch has ZERO existing rows for it. If an admin has already customized
    that module's people-type scope for this branch, this function leaves it
    untouched.

    Called from two entry points, because both can produce a branch with no
    config:
      - create_branch: a brand-new branch has no rows for any module yet.
      - toggle_module (status='active'): a module turned on for an org AFTER
        its branches already exist needs the same default seed applied
        retroactively to every existing branch.

    Known limitation: if an admin deliberately unchecks every people type for
    a module on a branch (fully disabling it, not just narrowing it), that
    branch will have zero rows for that module_key and a later re-toggle of
    the module will re-seed it. This is the accepted tradeoff of presence-
    based storage (no boolean "explicitly disabled" tombstone).
    """
    from support_db_organizations import get_organization
    org = get_organization(str(org_id))
    vertical_config = _json_dict(org.get('vertical_config'))
    enabled_people_types = (
        _json_list(org.get('enabled_people_types'))
        or _json_list(vertical_config.get('enabled_people_types'))
        or ['staff']
    )

    target_modules = (
        [_normalise_module_name(m) for m in module_keys]
        if module_keys is not None
        else _active_client_modules(str(org_id))
    )
    if not target_modules or not enabled_people_types:
        return

    existing = list_branch_module_people_types(str(org_id), str(branch_id))
    missing_modules = [m for m in target_modules if m not in existing]
    if not missing_modules:
        return

    rows = [
        {
            'org_id': str(org_id),
            'branch_id': str(branch_id),
            'module_key': module_key,
            'people_type': people_type,
        }
        for module_key in missing_modules
        for people_type in enabled_people_types
    ]

    try:
        get_supabase().table('branch_module_people_types').insert(rows).execute()
    except Exception as exc:
        if _table_missing(exc, 'branch_module_people_types'):
            logger.warning('branch_module_people_types table is missing; default seed skipped')
            return
        raise

def _latest_invoice(org_id: str) -> Optional[dict]:
    from support_db_billing import list_invoices
    invoices = list_invoices(org_id)
    return invoices[0] if invoices else None

def _default_people_kind_for_biz(biz_type: object) -> str:
    key = str(biz_type or '').strip().lower().replace('_', '-').replace('/', '-')
    if any(part in key for part in ('school', 'college', 'university', 'academy')):
        return 'students'
    if any(part in key for part in ('factory', 'manufacturing', 'plant')):
        return 'workers'
    if any(part in key for part in ('company', 'corporate', 'office', 'business')):
        return 'employees'
    if any(part in key for part in ('ngo', 'non-profit', 'nonprofit')):
        return 'personnel'
    if any(part in key for part in ('hospital', 'clinic', 'restaurant', 'hospitality')):
        return 'staff'
    return 'employees'

def _normalize_people_kind(raw: object, biz_type: object = None) -> str:
    value = str(raw or '').strip().lower().replace(' ', '_')
    mapping = {
        'student': 'students',
        'students': 'students',
        'staff': 'staff',
        'staff_member': 'staff',
        'staff_members': 'staff',
        'worker': 'workers',
        'workers': 'workers',
        'employee': 'employees',
        'employees': 'employees',
        'personnel': 'personnel',
        'patient': 'patients',
        'patients': 'patients',
        'member': 'members',
        'members': 'members',
        'volunteer': 'volunteers',
        'volunteers': 'volunteers',
        'both': 'both',
        'students_staff': 'both',
        'student_staff': 'both',
        'students_and_staff': 'both',
    }
    return mapping.get(value) or _default_people_kind_for_biz(biz_type)

def _build_client_config(org: dict, branches: list[dict], module_keys: list[str], module_people_types_by_branch: dict[str, dict[str, list[str]]] | None = None) -> dict:
    """
    Build the existing Client Dashboard OrgConfig shape from support-created
    Supabase records.

    Important: Support owns branches/modules/limits. The React dashboard still
    uses numeric route ids (/admin/branch/1), so we expose UI ids 1..N while
    preserving the real Supabase UUID as backend_branch_id/backendBranchId.
    """
    config_branches = []
    departments = {}
    roles = {}
    cameras = {}

    for idx, branch in enumerate(branches, start=1):
        ui_branch_id = idx
        config_branches.append({
            'id': ui_branch_id,
            'name': branch.get('name') or f'Branch {ui_branch_id}',
            'city': branch.get('location') or '',
            'location': branch.get('location') or '',
            'timezone': branch.get('timezone'),
            'backend_branch_id': branch.get('id'),
            'backendBranchId': branch.get('id'),
            'max_staff_capacity': branch.get('max_staff_capacity'),
            'maxStaffCapacity': branch.get('max_staff_capacity'),
            'fallback_active': branch.get('fallback_active'),
            'fallbackActive': branch.get('fallback_active'),
        })
        departments[str(ui_branch_id)] = []
        roles[str(ui_branch_id)] = []
        cameras[str(ui_branch_id)] = []

    vertical_config = _json_dict(org.get('vertical_config'))
    enabled_people_types = _json_list(org.get('enabled_people_types')) or _json_list(vertical_config.get('enabled_people_types')) or ['staff']
    attendance_people_types = _json_list(org.get('attendance_people_types')) or _json_list(vertical_config.get('attendance_people_types')) or enabled_people_types
    attendance_people_types = [item for item in attendance_people_types if item in enabled_people_types] or enabled_people_types
    business_type = str(org.get('business_type') or org.get('biz_type') or org.get('org_type') or 'company').strip().lower()
    primary_people_type = str(org.get('primary_people_type') or vertical_config.get('primary_people_type') or enabled_people_types[0]).strip().lower()

    module_people_types_by_branch = module_people_types_by_branch or {}
    branch_module_people_types: dict[str, dict[str, list[str]]] = {}
    for idx, branch in enumerate(branches, start=1):
        backend_branch_id = str(
            branch.get('backendBranchId')
            or branch.get('backend_branch_id')
            or branch.get('branchUuid')
            or branch.get('branch_uuid')
            or branch.get('id')
            or ''
        )
        branch_key = backend_branch_id or str(idx)
        if not backend_branch_id:
            branch_module_people_types[branch_key] = {}
            continue
        raw_branch_config = module_people_types_by_branch.get(backend_branch_id) or {}
        normalized_branch_config = {
            module_key: list(people_types or [])
            for module_key, people_types in (raw_branch_config or {}).items()
            if module_key and people_types
        }
        branch_module_people_types[branch_key] = normalized_branch_config

    vertical_config = {
        **vertical_config,
        'business_type': business_type,
        'primary_people_type': primary_people_type,
        'enabled_people_types': enabled_people_types,
        'attendance_people_types': attendance_people_types,
    }

    return {
        # business_type is the source of truth; org_type is a derived mirror
        # kept for backwards compatibility. Preferring org_type here let a
        # free-text value ('Software House') reach tenant rendering, where it
        # matched no known type and fell through to defaults.
        'bizType': business_type or org.get('org_type'),
        'businessType': business_type,
        'business_type': business_type,
        'primaryPeopleType': primary_people_type,
        'primary_people_type': primary_people_type,
        'enabledPeopleTypes': enabled_people_types,
        'enabled_people_types': enabled_people_types,
        'attendancePeopleTypes': attendance_people_types,
        'attendance_people_types': attendance_people_types,
        'verticalConfig': vertical_config,
        'vertical_config': vertical_config,
        'peopleKind': _normalize_people_kind(org.get('people_kind'), org.get('org_type')),
        'people_kind': _normalize_people_kind(org.get('people_kind'), org.get('org_type')),
        'terminologyOverrides': org.get('terminology_overrides') or {},
        'terminology_overrides': org.get('terminology_overrides') or {},
        'orgName': org.get('name') or '',
        'tagline': '',
        'address': '',
        'city': '',
        'publicContactPhone': org.get('contact_phone') or '',
        'timezone': 'Asia/Karachi',
        'size': '',
        'logo': None,
        'attendanceMode': org.get('attendance_mode'),
        'attendance_mode': org.get('attendance_mode'),
        'maxBranches': org.get('max_branches'),
        'max_branches': org.get('max_branches'),
        'branches': config_branches,
        'departments': departments,
        'roles': roles,
        'modules': module_keys,
        'modulePeopleTypesByBranch': branch_module_people_types,
        'module_people_types_by_branch': branch_module_people_types,
        'cameras': cameras,
        'staffShiftDefinitions': [],
        'users': [],
        'employeeProfiles': {},
        'payrollPolicy': {},
        'network': {},
    }

def create_client_invite(org_id: str, payload: dict, invited_by: str) -> dict:
    """
    Create or reset a Client Dashboard admin account for one organization.

    client_users is exclusively the org-owner seat, always role='admin' —
    there is no HR/co-admin tier here (that option was removed; any
    per-person access narrower than full admin is a client_staff row,
    managed from Staff Management's own module picker, not a Support-issued
    invite). Any 'role' key in payload is ignored on purpose: this endpoint
    cannot be used to mint anything other than an admin seat, regardless of
    what a caller sends.

    The temporary password is returned once and is never stored in plaintext.
    The invite message is generated from the real support-owned deal settings:
    organization template, attendance mode/scope, modules, branches/capacity,
    and latest invoice.
    """
    from support_db_branches import list_branches, list_org_modules
    from support_db_organizations import get_organization
    sb = get_supabase()
    org = get_organization(org_id)

    email = str(payload.get('email') or org.get('contact_email') or '').strip().lower()
    full_name = str(payload.get('full_name') or payload.get('name') or f"{org.get('name')} Admin").strip()
    role = 'admin'

    if not email:
        raise ValueError('Client email is required')
    if not full_name:
        raise ValueError('Client full name is required')

    temporary_password = str(payload.get('temporary_password') or '').strip() or _generate_temp_password()
    password_hash = _hash_password(temporary_password)

    existing = (
        sb.table('client_users')
        .select('id, org_id, email')
        .eq('email', email)
        .limit(1)
        .execute()
    )

    row = None
    if existing.data:
        current = existing.data[0]
        if str(current.get('org_id')) != str(org_id):
            raise ValueError('This email is already invited for another organization')

        result = (
            sb.table('client_users')
            .update({
                'password_hash': password_hash,
                'full_name': full_name,
                'role': role,
                'is_active': True,
                'must_change_password': True,
                'invited_by': invited_by,
                'onboarding_completed_at': None,
            })
            .eq('id', current['id'])
            .execute()
        )
        row = result.data[0] if result.data else None

        # This is the actual recovery step for a hijacked client_users admin
        # account (Support resets the password after verifying identity
        # out-of-band). Without this, the reset changes the password but an
        # already-authenticated attacker's token stays valid until natural
        # expiry (up to 12h) -- the exact gap that made recovery impossible
        # for a hacked admin. Only reached on the existing-row branch: a
        # brand-new invite (else branch below) has no prior session to kill.
        import session_registry
        session_registry.invalidate_session(
            'client_user', str(current['id']), reason='password_changed'
        )
    else:
        result = sb.table('client_users').insert({
            'org_id': org_id,
            'email': email,
            'password_hash': password_hash,
            'full_name': full_name,
            'role': role,
            'is_active': True,
            'must_change_password': True,
            'invited_by': invited_by,
        }).execute()
        row = result.data[0] if result.data else None

    if not row:
        raise RuntimeError('Failed to create client invite')

    branches = []
    modules = []
    latest_invoice = None

    try:
        branches = list_branches(str(org_id))
    except Exception as exc:
        logger.warning('Could not load branches for invite org=%s: %s', org_id, exc)

    try:
        modules = list_org_modules(str(org_id))
    except Exception as exc:
        logger.warning('Could not load modules for invite org=%s: %s', org_id, exc)

    try:
        latest_invoice = _latest_invoice(str(org_id))
    except Exception as exc:
        logger.warning('Could not load latest invoice for invite org=%s: %s', org_id, exc)

    login_url = str(
        payload.get('login_url')
        or payload.get('dashboard_url')
        or '/login'
    ).strip() or '/login'

    support_contact = str(
        payload.get('support_contact')
        or os.getenv('SUPPORT_CONTACT')
        or os.getenv('SUPPORT_EMAIL')
        or 'QIntellect Support'
    ).strip()

    invite_message = build_client_invite_message(
        client_name=full_name,
        login_url=login_url,
        client_email=email,
        temporary_password=temporary_password,
        organization=org,
        branches=branches,
        modules=modules,
        latest_invoice=latest_invoice,
        support_contact=support_contact,
    )

    return {
        'user': _safe_client_user(row),
        'email': email,
        'full_name': full_name,
        'role': role,
        'temporary_password': temporary_password,
        'login_url': login_url,
        'message': invite_message,
        'invite_message': invite_message,
        'deal_summary': {
            'organization': org,
            'branches': branches,
            'modules': modules,
            'latest_invoice': latest_invoice,
        },
    }

def _client_user_session_from_row(row: dict) -> dict:
    """Build the frontend-safe client user/session object from client_users."""
    from support_db_branches import list_branches
    from support_db_organizations import get_organization
    org_id = str(row.get('org_id'))
    org = get_organization(org_id)
    branches = list_branches(org_id)
    modules = _active_client_modules(org_id)
    status = org.get('status') or _compute_org_status(org_id)

    onboarding_done = bool(row.get('onboarding_completed_at'))
    commercial_access_ok = _org_access_allows_client(status)
    dashboard_ready = bool(onboarding_done and commercial_access_ok)
    requires_onboarding = not onboarding_done

    return {
        'id': row['id'],
        'name': row.get('full_name') or row.get('email'),
        'full_name': row.get('full_name'),
        'email': row.get('email'),
        'phone': row.get('phone') or '',
        'profile_image_url': row.get('profile_image_url') or '',
        'profileImageUrl': row.get('profile_image_url') or '',
        'avatarUrl': row.get('profile_image_url') or '',
        'photo_url': row.get('profile_image_url') or '',
        'profile_image_name': row.get('profile_image_name') or '',
        'profileImageName': row.get('profile_image_name') or '',
        'password_changed_at': row.get('password_changed_at'),
        'passwordChangedAt': row.get('password_changed_at'),
        # No more coercing any non-'admin' value to 'hr' — that tier is
        # gone. Pass the stored value through as-is; see the migration
        # note in role_permissions.py for what to do with any pre-existing
        # role='hr' rows from before this change.
        'role': row.get('role') or 'admin',
        'client_role': row.get('role'),
        'source': 'client_users',
        'organization_id': org_id,
        'organizationId': org_id,
        'organization_name': org.get('name'),
        'organizationName': org.get('name'),
        'organization_status': status,
        'organizationStatus': status,
        'dashboard_ready': dashboard_ready,
        'dashboardReady': dashboard_ready,
        'requires_onboarding': requires_onboarding,
        'requiresOnboarding': requires_onboarding,
        'onboarding_completed_at': row.get('onboarding_completed_at'),
        'onboardingCompletedAt': row.get('onboarding_completed_at'),
        'must_change_password': bool(row.get('must_change_password')),
        'mustChangePassword': bool(row.get('must_change_password')),
        'access_modules': modules,
        'allowedModules': modules,
        'moduleAccess': modules,
        'accessModules': modules,
        # Admin sees all support-created branches. We expose real branch UUIDs
        # here for security/context, while dashboard branch routes use cfg.branches
        # numeric UI ids loaded from bootstrap.
        'branch_id': None,
        'branchId': None,
        'allowedBranchIds': [b.get('id') for b in branches if b.get('id')],
        'portalAccess': {
            'desktopDashboard': dashboard_ready,
            'flutterStaffPortal': False,
        },
    }

def get_client_user_session_by_id(user_id: str) -> dict:
    """Return one client user's current dashboard/session flags."""
    sb = get_supabase()
    result = (
        sb.table('client_users')
        .select('id, org_id, email, full_name, role, is_active, must_change_password, onboarding_completed_at, phone, profile_image_url, profile_image_name, password_changed_at, created_at, last_login_at')
        .eq('id', str(user_id))
        .limit(1)
        .execute()
    )

    if not result.data:
        raise ValueError('Client user not found')

    row = result.data[0]
    if not row.get('is_active'):
        raise ValueError('Client user is inactive')

    return _client_user_session_from_row(row)

def get_client_user_basic(user_id: str) -> dict:
    """Minimal, display-only lookup for a Client Dashboard user (org admin
    or manager) by id — name/email/role only, no session/module data.

    Exists because `approved_by` on a leave request can be either a
    client_staff row (a manager who is also an employee) or a client_users
    row (an org admin with no employee record). get_client_staff_member
    only ever finds the former and 404s on the latter. This is the
    fallback lookup for that case.

    Unlike get_client_user_session_by_id, this never raises for an
    inactive account — a deactivated admin should still resolve by name
    on historical records they approved.
    """
    result = _execute_supabase(
        'get_client_user_basic',
        lambda: (
            get_supabase()
            .table('client_users')
            .select('id, full_name, email, role')
            .eq('id', str(user_id))
            .limit(1)
        ),
    )
    if not result.data:
        raise ValueError('Client user not found')

    row = result.data[0]
    return {
        'id': row.get('id'),
        'name': row.get('full_name'),
        'full_name': row.get('full_name'),
        'email': row.get('email'),
        'role': row.get('role'),
    }

def authenticate_client_user(email: str, password: str) -> Optional[dict]:
    """Authenticate a Client Dashboard user from Supabase client_users."""
    sb = get_supabase()
    result = (
        sb.table('client_users')
        .select('id, org_id, email, password_hash, full_name, role, is_active, must_change_password, onboarding_completed_at, phone, profile_image_url, profile_image_name, password_changed_at, created_at, last_login_at')
        .eq('email', str(email or '').strip().lower())
        .limit(1)
        .execute()
    )

    if not result.data:
        return None

    row = result.data[0]
    if not row.get('is_active'):
        return None

    if not _verify_password(password, row.get('password_hash') or ''):
        return None

    try:
        sb.table('client_users').update({
            'last_login_at': datetime.now(timezone.utc).isoformat(),
        }).eq('id', row['id']).execute()
    except Exception as e:
        logger.warning(f"Could not update client last_login_at for {email}: {e}")

    return _client_user_session_from_row(row)

def _find_active_client_staff_row(
    identifier: str,
    password: str,
    select_columns: str = '*',
) -> Optional[dict]:
    """Look up + verify one client_staff row by email/phone + password.

    Single source of truth for the credential-checking rules (ambiguous
    identifier, archived, inactive, bad password) shared by every
    client_staff login surface — currently the mobile portal
    (authenticate_client_staff) and the Client Dashboard
    (authenticate_client_staff_for_dashboard). Each caller passes its own
    select_columns because they need different shapes downstream (the
    mobile JWT needs the raw backend branch_id; the Dashboard needs the
    full row so it can go through _client_staff_safe's UI-mapped shape),
    but the *rules* for "is this identifier+password valid" must never
    diverge between them.

    identifier is matched against email OR phone, exactly as stored — the
    same raw string Staff Management showed the admin as the "Username /
    Number" when the employee was created. No normalization is applied here
    beyond a trim, deliberately: whatever was typed into the Phone/Email
    fields at creation is what must be typed back in at login.

    Looked up without an org_id filter, same convention as
    authenticate_client_user's global email lookup — neither portal has an
    org context until after login succeeds.

    Raises ValueError (not returns None) when the identifier is ambiguous,
    so callers can surface a distinct "contact your administrator" message
    instead of a generic invalid-credentials response.
    """
    clean_identifier = str(identifier or '').strip()
    if not clean_identifier or not password:
        return None

    sb = get_supabase()
    result = (
        sb.table('client_staff')
        .select(select_columns)
        .or_(f'email.eq.{clean_identifier},phone.eq.{clean_identifier}')
        .limit(2)
        .execute()
    )

    rows = result.data or []
    if not rows:
        return None

    if len(rows) > 1:
        # Two active staff rows sharing one email/phone is a data problem,
        # not a login choice to make on their behalf — fail closed rather
        # than silently picking the first row (which could hand back the
        # wrong person's org/branch/attendance data).
        logger.error(
            f"Ambiguous client_staff login: {len(rows)} rows matched identifier "
            f"'{clean_identifier}'. Refusing to authenticate any of them."
        )
        raise ValueError(
            'This email/phone number is registered to more than one account. '
            'Contact your administrator.'
        )

    row = rows[0]

    if row.get('is_archived'):
        return None
    if str(row.get('status') or '').lower() != 'active':
        return None
    if not _verify_password(password, row.get('password_hash') or ''):
        return None

    return row

def _touch_client_staff_last_login(staff_id: Any) -> None:
    """Best-effort last_login_at stamp, shared by every client_staff login
    surface. Never raises — a failed audit stamp must not fail the login
    itself."""
    try:
        get_supabase().table('client_staff').update({
            'last_login_at': datetime.now(timezone.utc).isoformat(),
        }).eq('id', staff_id).execute()
    except Exception as e:
        logger.warning(f"Could not update client_staff last_login_at for {staff_id}: {e}")

def authenticate_client_staff(identifier: str, password: str) -> Optional[dict]:
    """Authenticate an employee/student/worker (client_staff row) for the
    mobile portal — NOT the Client Dashboard login, which stays on
    authenticate_client_user (client_users, admin/HR) or
    authenticate_client_staff_for_dashboard (client_staff, desktop staff
    access) below.

    Selects only the columns the mobile JWT actually needs (see
    client_staff_auth._mint_token): the raw backend branch_id UUID, not the
    Dashboard's UI-numeric one. Do not widen this to select('*') and
    reshape through _client_staff_safe — that would hand the JWT minter a
    UI-mapped branch_id instead of the real one, breaking tenant scoping
    on every mobile route that trusts the JWT claim.
    """
    row = _find_active_client_staff_row(
        identifier,
        password,
        select_columns=(
            'id, org_id, branch_id, name, email, phone, password_hash, '
            'role, people_type, staff_type, status, is_archived, '
            'employee_id, person_code, profile_image_url, last_login_at'
        ),
    )
    if not row:
        return None

    _touch_client_staff_last_login(row['id'])
    return _safe_client_user(row)

def authenticate_client_staff_for_dashboard(identifier: str, password: str) -> Optional[dict]:
    """Authenticate a client_staff row for the Client Dashboard (desktop)
    login — the counterpart to authenticate_client_user for org admins/HR.

    client_staff rows only exist for Supabase/UUID organizations (legacy
    numeric orgs keep staff in the SQLite `users` table via
    db.authenticate_user), so this is only ever reached as a fallback when
    authenticate_client_user finds nothing for the given identifier.

    Returns the same shape produced by list_client_staff/create_client_staff
    (via _client_staff_safe: UI-mapped branch_id, access_modules, role
    "staff", etc.) so the frontend's AuthContext.normaliseUser() and
    routes.tsx's ModuleAccessRoute treat a client_staff login identically to
    a legacy SQLite staff login — same module-gated dashboard, same
    branch-scoped routing, no frontend changes required.
    """
    from support_db_staff import _client_staff_safe
    row = _find_active_client_staff_row(identifier, password, select_columns='*')
    if not row:
        return None

    _touch_client_staff_last_login(row['id'])
    return _client_staff_safe(row, row.get('org_id'))

def get_client_onboarding_config(org_id: str) -> dict | None:
    """Retrieve the onboarding configuration for an organization."""
    result = _execute_supabase(
        'get_client_onboarding_config',
        lambda: get_supabase().table('client_onboarding_configs').select('*').eq('org_id', str(org_id)).limit(1),
    )
    return result.data[0] if result.data else None

def _branch_maps(branches: list[dict]) -> tuple[dict[str, int], dict[str, str]]:
    """Return backend UUID→UI numeric and UI numeric→backend UUID maps."""
    backend_to_ui: dict[str, int] = {}
    ui_to_backend: dict[str, str] = {}
    for idx, branch in enumerate(branches, start=1):
        backend_id = branch.get('id')
        if backend_id:
            backend_to_ui[str(backend_id)] = idx
            ui_to_backend[str(idx)] = str(backend_id)
    return backend_to_ui, ui_to_backend

def _ui_branch_key(raw_key: object, backend_to_ui: dict[str, int]) -> Optional[int]:
    key = str(raw_key or '').strip()
    if not key:
        return None
    if key in backend_to_ui:
        return backend_to_ui[key]
    try:
        parsed = int(key)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None

def _normalize_named_items_by_branch(value: object, branches: list[dict]) -> dict[str, list[dict]]:
    """Map branch UUID keys from onboarding into numeric UI keys for dashboard."""
    backend_to_ui, _ = _branch_maps(branches)
    result: dict[str, list[dict]] = {str(i): [] for i in range(1, len(branches) + 1)}

    if not isinstance(value, dict):
        return result

    for raw_key, raw_items in value.items():
        ui_id = _ui_branch_key(raw_key, backend_to_ui)
        if not ui_id:
            continue
        items = raw_items if isinstance(raw_items, list) else []
        normalized: list[dict] = []
        for idx, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                continue
            name = str(item.get('name') or '').strip()
            if not name:
                continue
            normalized.append({
                **item,
                'id': item.get('id') or idx,
                'name': name,
            })
        result[str(ui_id)] = normalized
    return result

def _normalize_cameras_by_branch(value: object, branches: list[dict]) -> dict[str, list[dict]]:
    """Map camera configs from backend branch UUID keys into dashboard UI branch ids."""
    backend_to_ui, ui_to_backend = _branch_maps(branches)
    result: dict[str, list[dict]] = {str(i): [] for i in range(1, len(branches) + 1)}

    if not isinstance(value, dict):
        return result

    for raw_key, raw_items in value.items():
        ui_id = _ui_branch_key(raw_key, backend_to_ui)
        if not ui_id:
            continue
        backend_branch_id = backend_to_ui.get(str(raw_key)) and str(raw_key)
        if not backend_branch_id:
            backend_branch_id = ui_to_backend.get(str(ui_id))

        items = raw_items if isinstance(raw_items, list) else []
        normalized: list[dict] = []
        for idx, item in enumerate(items, start=1):
            if not isinstance(item, dict):
                continue
            cam_id = str(item.get('id') or f'camera-{ui_id}-{idx}').strip()
            name = str(item.get('name') or f'Camera {idx}').strip()
            rtsp_url = str(item.get('rtspUrl') or item.get('rtsp_url') or '').strip()
            normalized.append({
                **item,
                'id': cam_id,
                'branchId': ui_id,
                'backend_branch_id': backend_branch_id,
                'backendBranchId': backend_branch_id,
                'name': name,
                'location': str(item.get('location') or name).strip(),
                'rtspUrl': rtsp_url,
                'rtsp_url': rtsp_url,
                'channel': str(item.get('channel') or '').strip(),
                'type': item.get('type') or 'nvr',
                'status': item.get('status') or 'Normal',
                'streamPath': item.get('streamPath') or item.get('stream_path'),
            })
        result[str(ui_id)] = normalized
    return result

def _merge_operational_config(base_config: dict, saved: Optional[dict], branches: list[dict]) -> dict:
    """
    Merge client operational configuration into support-owned base config.

    Supabase is the source of truth. Support-owned values stay authoritative:
    branches, capacities, purchased modules, attendance mode, and max branches.
    Client-owned values come from client_onboarding_configs.
    """
    if not saved:
        return base_config

    merged = dict(base_config)

    company_profile = saved.get('company_profile') or {}
    if isinstance(company_profile, dict):
        address = company_profile.get('address') or ''
        city = company_profile.get('city') or ''
        public_contact_phone = company_profile.get('publicContactPhone') or company_profile.get('public_contact_phone') or ''
        timezone_value = company_profile.get('timezone') or 'Asia/Karachi'
        logo = company_profile.get('logoDataUrl') or company_profile.get('logo') or None
        merged.update({
            'tagline': company_profile.get('tagline') or merged.get('tagline') or '',
            'address': address,
            'city': city,
            'publicContactPhone': public_contact_phone,
            'public_contact_phone': public_contact_phone,
            'timezone': timezone_value,
            'size': company_profile.get('size') or merged.get('size') or '',
            'logo': logo,
            # Terminology is support-owned on organizations.people_kind.
            # Client onboarding profile can no longer override it.
            'companyProfile': company_profile,
            'company_profile': company_profile,
        })

    merged['departments'] = _normalize_named_items_by_branch(saved.get('departments'), branches)
    merged['roles'] = _normalize_named_items_by_branch(saved.get('roles'), branches)
    merged['cameras'] = _normalize_cameras_by_branch(saved.get('cameras'), branches)
    merged['network'] = saved.get('network') or {}
    merged['networkConfig'] = saved.get('network') or {}

    # Per-people-type shift enablement (Settings.tsx's Shift Scheduling
    # panel). Both casings are set to match this function's existing
    # convention (see publicContactPhone/public_contact_phone, network/
    # networkConfig above) — templateRendering.ts and templateColumns.ts on
    # the client both check camelCase first, snake_case as a fallback.
    merged['shifts'] = saved.get('shifts') or []
    merged['staffShiftDefinitions'] = saved.get('staffShiftDefinitions') or saved.get('shifts') or []
    shift_enabled_people_types = saved.get('shift_enabled_people_types') or saved.get('shiftEnabledPeopleTypes') or []
    merged['shiftEnabledPeopleTypes'] = shift_enabled_people_types
    merged['shift_enabled_people_types'] = shift_enabled_people_types

    merged['onboardingCompleted'] = bool(saved.get('completed_at'))
    merged['onboarding_completed_at'] = saved.get('completed_at')
    merged['onboardingCompletedAt'] = saved.get('completed_at')
    return merged

def get_client_bootstrap(org_id: str) -> dict:
    """Return all setup needed by Client Dashboard from Supabase.

    Bootstrap is the page gate for Client Dashboard. It must be fast and must
    never fail because optional billing/onboarding helper data is temporarily
    unavailable. Org, branches, modules, and onboarding are fetched in parallel;
    the final dashboard config is still derived locally and tenant-scoped.
    """
    from support_db_branches import list_branches, list_org_modules
    from support_db_organizations import get_organization
    org_key = str(org_id)

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        f_org = pool.submit(get_organization, org_key)
        f_branches = pool.submit(list_branches, org_key)
        f_modules = pool.submit(list_org_modules, org_key)
        f_onboarding = pool.submit(get_client_onboarding_config, org_key)
        f_module_people_types = pool.submit(list_org_branch_module_people_types, org_key)

        org = f_org.result()
        branches = f_branches.result()
        modules = f_modules.result()
        onboarding_config = f_onboarding.result()
        module_people_types_by_branch = f_module_people_types.result()

    active_module_keys = [
        _map_module_for_client(m.get('module_name'))
        for m in modules
        if m.get('status') == 'active'
    ]

    latest_invoice = None
    try:
        latest_invoice = _latest_invoice(org_key)
    except Exception as exc:
        logger.warning('Could not load latest invoice for org=%s during bootstrap: %s', org_key, exc)

    access_status = org.get('status') or _compute_org_status(org_key)
    onboarding_completed = bool(onboarding_config and onboarding_config.get('completed_at'))
    base_config = _build_client_config(org, branches, active_module_keys, module_people_types_by_branch=module_people_types_by_branch)
    config = _merge_operational_config(base_config, onboarding_config, branches)

    return {
        'organization': org,
        'branches': branches,
        'modules': modules,
        'active_modules': active_module_keys,
        'activeModules': active_module_keys,
        'latest_invoice': latest_invoice,
        'latestInvoice': latest_invoice,
        'access_status': access_status,
        'accessStatus': access_status,
        'onboarding_config': onboarding_config,
        'onboardingConfig': onboarding_config,
        'onboarding_completed': onboarding_completed,
        'onboardingCompleted': onboarding_completed,
        'requires_onboarding': not onboarding_completed,
        'requiresOnboarding': not onboarding_completed,
        'dashboard_ready': bool(onboarding_completed and _org_access_allows_client(access_status)),
        'dashboardReady': bool(onboarding_completed and _org_access_allows_client(access_status)),
        'permissions': {
            'can_change_business_type': False,
            'can_change_attendance_mode': False,
            'can_change_modules': False,
            'can_add_branch_beyond_limit': False,
        },
        'config': config,
    }

def _branch_backend_id(raw_key: object, branches: list[dict]) -> Optional[str]:
    """Resolve a dashboard branch key to the real Supabase branch UUID.

    The current React dashboard may use numeric UI branch ids (1, 2, 3), while
    Supabase-owned data must be stored by real branches.id UUIDs. This accepts
    both shapes so onboarding can safely save operational config.
    """
    key = str(raw_key or '').strip()
    if not key:
        return None

    by_backend = {str(branch.get('id')): str(branch.get('id')) for branch in branches if branch.get('id')}
    if key in by_backend:
        return by_backend[key]

    try:
        ui_id = int(key)
    except (TypeError, ValueError):
        return None

    if ui_id < 1 or ui_id > len(branches):
        return None

    backend_id = branches[ui_id - 1].get('id')
    return str(backend_id) if backend_id else None

_GROUP_NAME_MAX_LENGTH = 300  # generous ceiling above the 100-char per-field
# frontend limit (class + " - " + section can combine into one `name`); this
# is the real boundary — the frontend maxLength is UX only. Blocks the
# unbounded-paste case (10,000+ chars) reaching Supabase via departments/
# roles onboarding config.


def _validate_group_item_name(item: dict, bucket_name: str) -> None:
    """Reject department/designation/class-section names over the length
    ceiling. Mirrors _validate_camera_rtsp_url: client-side maxLength on
    Settings.tsx/OnboardingWizard.tsx inputs is UX only, this is what
    actually stops an oversized payload from being persisted."""
    for key in ('name', 'className', 'sectionName'):
        value = item.get(key)
        if value and len(str(value)) > _GROUP_NAME_MAX_LENGTH:
            raise ValueError(
                f'{bucket_name}[].{key} must be {_GROUP_NAME_MAX_LENGTH} characters or fewer'
            )


_ALLOWED_RTSP_SCHEMES = {'rtsp', 'rtsps'}


def _validate_camera_rtsp_url(item: dict) -> None:
    """Reject any custom camera URL whose scheme isn't rtsp/rtsps.

    See _normalize_branch_keyed_config's docstring for why this matters:
    the stored value is later opened directly by an ffmpeg-backed
    cv2.VideoCapture on the backend (app.py's /api/stream/<camera_id>) and by
    the local node client, both of which happily follow http(s):// (and other
    schemes) — an unvalidated URL here is a straight path to SSRF against
    internal infrastructure. A webcam entry has no rtsp_url and is exempt.
    """
    camera_type = str(item.get('camera_type') or item.get('cameraType') or item.get('type') or '').strip().lower()
    if camera_type == 'webcam':
        return

    raw_url = item.get('rtsp_url')
    if raw_url in (None, ''):
        raw_url = item.get('rtspUrl')
    if raw_url in (None, ''):
        return

    raw_url = str(raw_url).strip()
    scheme = urlparse(raw_url).scheme.lower()
    if scheme not in _ALLOWED_RTSP_SCHEMES:
        raise ValueError(
            "cameras[].rtsp_url must use the rtsp:// (or rtsps://) protocol"
        )


def _normalize_branch_keyed_config(value: object, branches: list[dict], bucket_name: str) -> dict[str, list[dict]]:
    """Normalize branch-keyed onboarding buckets to real branch UUID keys.

    Accepts incoming config keyed by either real Supabase branch UUIDs or current
    dashboard numeric route ids. Empty/missing branches are returned as empty
    arrays so saved config remains predictable.

    For bucket_name == 'cameras', each item's rtsp_url/rtspUrl is validated
    (see _validate_camera_rtsp_url) — this is the actual persistence point for
    onboarding/Settings camera config, and both /api/stream/<camera_id>
    (app.py) and the local node client ultimately hand this value straight to
    an ffmpeg-backed cv2.VideoCapture, which understands http(s)://, file://,
    and other schemes beyond rtsp. Without this check, a client could set
    rtsp_url to an internal http(s) URL and get the backend server (or the
    local node) to fetch it and stream the response back as "camera video" —
    classic SSRF. Rejecting anything but rtsp/rtsps here is the actual
    security boundary; any client-side check is UX only.
    """
    result: dict[str, list[dict]] = {
        str(branch.get('id')): []
        for branch in branches
        if branch.get('id')
    }

    if value in (None, ''):
        return result

    if not isinstance(value, dict):
        raise ValueError(f'{bucket_name} must be an object keyed by branch id')

    for raw_key, raw_items in value.items():
        backend_id = _branch_backend_id(raw_key, branches)
        if not backend_id:
            raise ValueError(f'{bucket_name} contains a branch that is not owned by this organization')

        if raw_items in (None, ''):
            result[backend_id] = []
            continue

        if not isinstance(raw_items, list):
            raise ValueError(f'{bucket_name}[{raw_key}] must be an array')

        items = [item for item in raw_items if isinstance(item, dict)]
        if bucket_name == 'cameras':
            for item in items:
                _validate_camera_rtsp_url(item)
        if bucket_name in ('departments', 'roles'):
            for item in items:
                _validate_group_item_name(item, bucket_name)
        result[backend_id] = items

    return result

def _clean_optional_text(value: object) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None

def _first_present(mapping: dict, *keys: str):
    for key in keys:
        if key in mapping and mapping.get(key) not in (None, ''):
            return mapping.get(key)
    return None

def _int_or_default(value: object, default: int) -> int:
    try:
        if value is None or str(value).strip() == '':
            return default
        return int(value)
    except (TypeError, ValueError):
        return default

def _bool_or_default(value: object, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() not in {'0', 'false', 'no', 'off'}

def _branch_network_from_config(network_config: object, branch_id: str, branches: list[dict]) -> dict:
    """Return one branch's NVR/network config from several supported shapes.

    Supported shapes:
      network: {"<branch_uuid>": {...}}
      network: {"1": {...}}
      network: {"byBranch": {"<branch_uuid>": {...}}}
      network: {"branches": {"1": {...}}}
      network: {publicIp/nvrLocalIp/rtspUsername/...}  # flat, applied to all
    """
    if not isinstance(network_config, dict):
        return {}

    candidate = None

    # Direct branch-keyed object.
    for raw_key, raw_value in network_config.items():
        if isinstance(raw_value, dict) and _branch_backend_id(raw_key, branches) == branch_id:
            candidate = raw_value
            break

    # Nested branch-keyed objects used by some React forms.
    if candidate is None:
        for container_key in ('byBranch', 'branches', 'branchConfigs', 'networkByBranch', 'configs'):
            nested = network_config.get(container_key)
            if not isinstance(nested, dict):
                continue
            for raw_key, raw_value in nested.items():
                if isinstance(raw_value, dict) and _branch_backend_id(raw_key, branches) == branch_id:
                    candidate = raw_value
                    break
            if candidate is not None:
                break

    # Flat network object applied to all branches.
    if candidate is None:
        flat_fields = {
            'public_ip', 'publicIp', 'wan_ip', 'wanIp',
            'nvr_local_ip', 'nvrLocalIp', 'nvr_dvr_ip', 'nvrDvrIp',
            'rtsp_port', 'rtspPort', 'rtsp_username', 'rtspUsername',
            'rtsp_password', 'rtspPassword',
        }
        if any(key in network_config for key in flat_fields):
            candidate = network_config

    return dict(candidate or {})

_VALID_CAMERA_TYPES: frozenset[str] = frozenset({'nvr', 'dvr', 'ip_camera', 'webcam'})

def _normalize_camera_type(value: object) -> str:
    text = str(value or '').strip().lower().replace(' ', '_').replace('-', '_')
    return text if text in _VALID_CAMERA_TYPES else 'nvr'

def _normalize_local_node_camera_row(camera: dict, org_id: str, branch_id: str) -> dict:
    name = _clean_optional_text(
        _first_present(camera, 'camera_name', 'cameraName', 'name', 'label')
    ) or 'Camera'
    camera_type = _normalize_camera_type(_first_present(camera, 'camera_type', 'cameraType', 'type'))

    # A webcam is physically attached to one local machine — it has no
    # network address a cloud worker could ever reach. Never persist a
    # public RTSP URL for one, regardless of what the dashboard form sent;
    # this mirrors the DB CHECK constraint so app code can't drift from it.
    public_rtsp_url = (
        _clean_optional_text(_first_present(camera, 'public_rtsp_url', 'publicRtspUrl'))
        if camera_type != 'webcam' else None
    )

    return {
        'organization_id': str(org_id),
        'branch_id': str(branch_id),
        'camera_name': name,
        'camera_type': camera_type,
        'channel': _int_or_default(_first_present(camera, 'channel', 'camera_channel', 'cameraChannel'), 1),
        'stream_path': _clean_optional_text(_first_present(camera, 'stream_path', 'streamPath', 'path')),
        'rtsp_url': _clean_optional_text(_first_present(camera, 'rtsp_url', 'rtspUrl')),
        'public_rtsp_url': public_rtsp_url,
        'location': _clean_optional_text(_first_present(camera, 'location', 'placement')),
        'enabled': _bool_or_default(_first_present(camera, 'enabled', 'is_enabled', 'isEnabled'), True),
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }

def _sync_local_node_camera_config(
    sb,
    *,
    org_id: str,
    branches: list[dict],
    cameras_by_branch: dict[str, list[dict]],
    network_config: object,
    updated_at: str,
) -> dict:
    """Mirror onboarding CCTV config into tables consumed by Local Node.

    client_onboarding_configs keeps the dashboard configuration. The local node
    does not read that JSON directly; it reads branch_network_configs and
    branch_cameras through /api/local-node/config. This function keeps those
    tables in sync whenever onboarding is completed.
    """
    synced_branches = 0
    synced_cameras = 0

    for branch in branches:
        branch_id = str(branch.get('id') or '').strip()
        if not branch_id:
            continue

        branch_cameras = cameras_by_branch.get(branch_id) or []
        branch_network = _branch_network_from_config(network_config, branch_id, branches)

        # If there is neither camera nor network data for this branch, leave any
        # old local-node rows alone. This avoids deleting a manually configured
        # node when a partial onboarding/profile update omits CCTV data.
        if not branch_cameras and not branch_network:
            continue

        network_payload = {
            'organization_id': str(org_id),
            'branch_id': branch_id,
            'public_ip': _clean_optional_text(_first_present(branch_network, 'public_ip', 'publicIp', 'wan_ip', 'wanIp')),
            'nvr_local_ip': _clean_optional_text(_first_present(branch_network, 'nvr_local_ip', 'nvrLocalIp', 'nvr_dvr_ip', 'nvrDvrIp', 'local_ip', 'localIp', 'nvrIp', 'dvrIp', 'ip')),
            'rtsp_port': _int_or_default(_first_present(branch_network, 'rtsp_port', 'rtspPort', 'port'), 554),
            'rtsp_username': _clean_optional_text(_first_present(branch_network, 'rtsp_username', 'rtspUsername', 'username', 'nvrUsername')),
            'rtsp_password': _clean_optional_text(_first_present(branch_network, 'rtsp_password', 'rtspPassword', 'password', 'nvrPassword')),
            'updated_at': updated_at,
        }

        # A network row is required even when each camera already has a complete
        # rtsp_url, because /api/local-node/config first checks
        # branch_network_configs before returning cameras.
        network_result = (
            sb.table('branch_network_configs')
            .upsert(network_payload, on_conflict='organization_id,branch_id')
            .execute()
        )
        if not network_result.data:
            raise RuntimeError('Failed to save branch network configuration')

        # Onboarding is source of truth for cameras for this branch.
        sb.table('branch_cameras').delete().eq('organization_id', str(org_id)).eq('branch_id', branch_id).execute()

        camera_rows = [
            _normalize_local_node_camera_row(camera, str(org_id), branch_id)
            for camera in branch_cameras
            if isinstance(camera, dict)
        ]
        if camera_rows:
            camera_result = sb.table('branch_cameras').insert(camera_rows).execute()
            if not camera_result.data:
                raise RuntimeError('Failed to save branch camera configuration')
            synced_cameras += len(camera_result.data)

        synced_branches += 1

    return {
        'synced_branches': synced_branches,
        'synced_cameras': synced_cameras,
    }

def _extract_company_profile(config: dict, org: dict) -> dict:
    """Extract client-owned company profile fields from onboarding config."""
    profile = config.get('company_profile') if isinstance(config.get('company_profile'), dict) else {}

    return {
        'orgName': org.get('name') or config.get('orgName') or '',
        'bizType': (
            org.get('business_type')
            or org.get('org_type')
            or config.get('bizType')
            or 'business'
        ),
        'tagline': profile.get('tagline') or config.get('tagline') or '',
        'address': profile.get('address') or config.get('address') or '',
        'city': profile.get('city') or config.get('city') or '',
        'publicContactPhone': profile.get('publicContactPhone') or profile.get('public_contact_phone') or '',
        'timezone': profile.get('timezone') or 'Asia/Karachi',
        'size': profile.get('size') or config.get('size') or '',
        'logo': profile.get('logo') or profile.get('logoDataUrl') or config.get('logo'),
        'logoDataUrl': profile.get('logoDataUrl') or profile.get('logo') or config.get('logo'),
        'logoFileName': profile.get('logoFileName') or '',
    }

def save_client_onboarding_config(user_id: str, org_id: str, config: dict) -> dict:
    """
    Complete invited-client onboarding.

    This does NOT create a new organization or new commercial branches/modules.
    It saves only operational configuration against the organization created by
    QIntellect Support Dashboard.
    """
    from support_db_branches import list_branches
    from support_db_organizations import get_organization
    from support_db_staff import _normalize_people_type
    if not isinstance(config, dict):
        raise ValueError('config must be an object')

    sb = get_supabase()
    org = get_organization(str(org_id))

    user_result = (
        sb.table('client_users')
        .select('id, org_id, email, full_name, role, is_active, must_change_password, onboarding_completed_at')
        .eq('id', str(user_id))
        .limit(1)
        .execute()
    )

    if not user_result.data:
        raise ValueError('Client user not found')

    client_user = user_result.data[0]

    if not client_user.get('is_active'):
        raise ValueError('Client user is inactive')

    if str(client_user.get('org_id')) != str(org_id):
        raise ValueError('Client user does not belong to this organization')

    support_branches = list_branches(str(org_id))

    # Normalize incoming branch-keyed operational config to real Supabase branch
    # UUIDs. This accepts both current dashboard UI branch ids (1, 2, 3) and
    # backend branch UUIDs, but only stores UUID keys.
    normalized_departments = _normalize_branch_keyed_config(
        config.get('departments') or {},
        support_branches,
        'departments',
    )
    normalized_roles = _normalize_branch_keyed_config(
        config.get('roles') or {},
        support_branches,
        'roles',
    )
    normalized_cameras = _normalize_branch_keyed_config(
        config.get('cameras') or {},
        support_branches,
        'cameras',
    )
    network_config = config.get('network') or config.get('networkConfig') or {}

    # Shift Scheduling (Settings.tsx's ShiftSchedulingEditor) — which people
    # types use shift-based attendance. Read on the client via
    # resolvePeopleRenderingModel's supportsShift (templateRendering.ts) and
    # its DRY-mirrored copy in templateColumns.ts, both of which check
    # cfg.shiftEnabledPeopleTypes. Previously this payload never included
    # the field and _merge_operational_config below never read it back, so
    # every save silently reverted to the `!isStudent` fallback on the next
    # bootstrap — the Shift tab/fields could never actually be enabled for
    # students (or disabled for a workforce type) regardless of what was
    # checked here.
    shift_enabled_people_types = sorted({
        _normalize_people_type(value)
        for value in (
            config.get('shiftEnabledPeopleTypes')
            or config.get('shift_enabled_people_types')
            or []
        )
        if str(value or '').strip()
    })

    now = datetime.now(timezone.utc).isoformat()

    payload = {
        'org_id': str(org_id),
        'completed_by': str(user_id),
        'company_profile': _extract_company_profile(config, org),
        # Store operational data keyed by real Supabase branch UUIDs.
        # get_client_bootstrap maps them back to numeric UI ids for the current dashboard.
        'departments': normalized_departments,
        'roles': normalized_roles,
        'shifts': [],
        'shift_enabled_people_types': shift_enabled_people_types,
        'cameras': normalized_cameras,
        'network': network_config,
        'completed_at': now,
        'updated_at': now,
    }

    saved = sb.table('client_onboarding_configs').upsert(
        payload,
        on_conflict='org_id',
    ).execute()

    if not saved.data:
        raise RuntimeError('Failed to save client onboarding configuration')

    camera_sync = _sync_local_node_camera_config(
        sb,
        org_id=str(org_id),
        branches=support_branches,
        cameras_by_branch=normalized_cameras,
        network_config=network_config,
        updated_at=now,
    )

    sb.table('client_users').update({
        'onboarding_completed_at': now,
    }).eq('id', str(user_id)).execute()

    session_user = get_client_user_session_by_id(str(user_id))
    bootstrap = get_client_bootstrap(str(org_id))

    return {
        'user': session_user,
        'camera_sync': camera_sync,
        'cameraSync': camera_sync,
        **bootstrap,
    }

def _person_code_from_payload(payload: dict, people_type: str, fallback: str = '') -> str:
    # Single choke point for both create_client_staff and update_client_staff
    # (support_db_staff.py) — validating here means every write path gets
    # the same length cap and character allow-list for free, with no risk of
    # the two call sites drifting apart the way name validation once did
    # between create and update (see the comment above the update loop in
    # support_db_staff.py). Raises ValueError on empty, oversized, or
    # markup/SQL-shaped input; surfaced as a 400 by the route the same way
    # _validate_person_name's ValueError already is.
    from support_db_staff import _validate_person_code
    value = (
        payload.get('person_code')
        or payload.get('personCode')
        or payload.get('registration_number')
        or payload.get('registrationNumber')
        or payload.get('employee_number')
        or payload.get('employeeNumber')
        or payload.get('worker_id')
        or payload.get('workerId')
        or payload.get('teacher_code')
        or payload.get('teacherCode')
        or payload.get('employee_id')
        or fallback
    )
    return _validate_person_code(value, _person_code_label(people_type))

def _person_code_label(people_type: object) -> str:
    from support_db_staff import _normalize_people_type
    key = _normalize_people_type(people_type)
    if key == 'student':
        return 'Registration Number'
    if key == 'teacher':
        return 'Teacher Code'
    if key == 'worker':
        return 'Worker ID'
    if key == 'employee':
        return 'Employee ID'
    return 'Staff ID'

def _assert_unique_client_staff_person_code(
    *,
    org_id: str,
    branch_id: str,
    people_type: str,
    person_code: str,
    exclude_staff_id: str | None = None,
) -> None:
    from support_db_staff import _normalize_people_type
    query = (
        get_supabase()
        .table('client_staff')
        .select('id, name, person_code')
        .eq('org_id', str(org_id))
        .eq('branch_id', str(branch_id))
        .eq('people_type', _normalize_people_type(people_type))
        .ilike('person_code', str(person_code).strip())
        .eq('is_archived', False)
        .limit(1)
    )
    if exclude_staff_id:
        query = query.neq('id', str(exclude_staff_id))
    result = query.execute()
    if result.data:
        raise ValueError(f'{_person_code_label(people_type)} already exists in this branch.')

def _assert_unique_client_staff_login_identifier(
    *,
    email: str | None,
    phone: str | None,
    exclude_staff_id: str | None = None,
) -> None:
    """Two client_staff rows can never share an email or phone, checked
    globally across every org — not scoped to one branch/org the way
    person_code is.

    This has to match the scope of authenticate_client_staff's lookup
    (mobile portal login), which also searches client_staff by email OR
    phone with no org_id filter, since a field worker's login request
    carries no org context until after that lookup succeeds. If two staff
    rows anywhere were allowed to share an identifier, authenticate_client_
    staff would find both, refuse to guess which one is logging in, and
    neither employee could log in at all — so this has to be prevented at
    creation/edit time, not discovered later at someone's login attempt.

    Only checks whichever of email/phone was actually supplied — a value
    left blank isn't a collision candidate against other blank values,
    since client_staff.email/phone are stored as NULL, not empty string,
    when absent (see create_client_staff/update_client_staff).
    """
    sb = get_supabase()

    if email:
        query = (
            sb.table('client_staff')
            .select('id')
            .eq('email', email)
            .eq('is_archived', False)
            .limit(1)
        )
        if exclude_staff_id:
            query = query.neq('id', str(exclude_staff_id))
        if query.execute().data:
            raise ValueError(
                'This email is already used by another person. Please use a different email.'
            )

    if phone:
        query = (
            sb.table('client_staff')
            .select('id')
            .eq('phone', phone)
            .eq('is_archived', False)
            .limit(1)
        )
        if exclude_staff_id:
            query = query.neq('id', str(exclude_staff_id))
        if query.execute().data:
            raise ValueError(
                'This phone number is already used by another person. Please use a different number.'
            )

def update_client_user_profile(user_id: str, payload: dict) -> dict:
    """
    Update an invited Client Dashboard admin/HR profile in Supabase client_users.
 
    Separation of concerns:
      - Profile fields (name, email, phone, photo) are updated independently.
      - Password change trusts the caller's session (the route this is
        reached through is behind @require_client_dashboard_auth's
        self-only JWT check) — no current_password re-verification.
      - must_change_password is only cleared on a successful password change.
      - A profile-only save never touches password state at all.
 
    Raises:
      ValueError  — business-rule violation (caught by route → 400)
      RuntimeError — unexpected DB failure (caught by route → 500)
    """
    sb = get_supabase()
 
    # ── Fetch current row ────────────────────────────────────────────────────
    fetch_result = (
        sb.table('client_users')
        .select(
            'id, org_id, email, password_hash, full_name, role, '
            'is_active, must_change_password, onboarding_completed_at, '
            'phone, profile_image_url, profile_image_name, password_changed_at'
        )
        .eq('id', str(user_id))
        .limit(1)
        .execute()
    )
 
    if not fetch_result.data:
        raise ValueError('Client user not found')
 
    current = fetch_result.data[0]
 
    if not current.get('is_active'):
        raise ValueError('Client user is inactive')
 
    update_data: dict = {}
 
    # ── Profile fields ───────────────────────────────────────────────────────
 
    # name / full_name — accept either alias the frontend may send
    name_value = payload.get('full_name') or payload.get('name')
    if name_value is not None:
        full_name = str(name_value).strip()
        if not full_name:
            raise ValueError('Name is required')
        update_data['full_name'] = full_name
 
    if 'email' in payload:
        email = str(payload.get('email') or '').strip().lower()
        if not email:
            raise ValueError('Email is required')
 
        # Pre-flight uniqueness check: raises a deterministic ValueError instead
        # of relying on catching Supabase's unique-constraint exception message.
        if email != current.get('email', '').lower():
            conflict = (
                sb.table('client_users')
                .select('id')
                .eq('email', email)
                .neq('id', str(user_id))
                .limit(1)
                .execute()
            )
            if conflict.data:
                raise ValueError('This email is already used by another account')
 
        update_data['email'] = email
 
    if 'phone' in payload:
        phone = str(payload.get('phone') or '').strip()
        update_data['phone'] = phone or None
 
    # Photo URL — accept any of the three aliases the frontend may send
    photo_url_value = (
        payload.get('profile_image_url')
        or payload.get('profileImageUrl')
        or payload.get('photo_url')
    )
    if photo_url_value is not None:
        update_data['profile_image_url'] = str(photo_url_value).strip() or None
 
    photo_name_value = (
        payload.get('profile_image_name')
        or payload.get('profileImageName')
    )
    if photo_name_value is not None:
        update_data['profile_image_name'] = str(photo_name_value).strip() or None
 
    # ── Password change ────────────────────────────────────────────────
    # No current_password check: this function is only ever reached via
    # routes behind @require_client_dashboard_auth's self-only check
    # (g.dashboard_user['id'] == user_id, from a signed JWT — see
    # client_dashboard_auth.py). The session itself is the proof of
    # identity; re-asking for the current password here would be a second,
    # redundant login, not additional security, and it breaks first-login
    # flows where the password was auto-generated and never seen by the
    # user (see StaffManagement.tsx's credentials-download modal).
    new_password = str(payload.get('new_password') or '').strip()
 
    if new_password:
        validate_strong_password(new_password)

        update_data['password_hash'] = _hash_password(new_password)
        update_data['must_change_password'] = False
        update_data['password_changed_at'] = datetime.now(timezone.utc).isoformat()
 
    # Nothing to update — return the current session without a write round-trip
    if not update_data:
        return _client_user_session_from_row(current)
 
    update_data['updated_at'] = datetime.now(timezone.utc).isoformat()
 
    # ── Persist ──────────────────────────────────────────────────────────────
    try:
        saved = (
            sb.table('client_users')
            .update(update_data)
            .eq('id', str(user_id))
            .execute()
        )
    except Exception as exc:
        # Supabase unique-constraint violations should have been caught by the
        # pre-flight check above. This handles unexpected DB-level errors.
        raise RuntimeError(f'Profile update failed: {exc}') from exc
 
    if not saved.data:
        raise RuntimeError(
            f'Profile update for client_user {user_id} returned no data. '
            'Verify the row exists and RLS policies allow updates.'
        )
 
    # Re-fetch via the canonical session builder so the response shape is
    # identical to what login / refreshUser return.
    return get_client_user_session_by_id(str(user_id))

def change_own_dashboard_password(account_type: str, user_id: str, new_password: str) -> dict:
    """
    Single entry point for 'change my own password' from the Client
    Dashboard, regardless of which table the caller's session lives in.
 
    account_type MUST come from g.dashboard_user (the decoded JWT set by
    @require_client_dashboard_auth in client_dashboard_auth.py) — never
    from the request body. Same for user_id. This keeps the whole
    endpoint free of any user-id-spoofing surface: whoever the token says
    you are is the only account you can ever touch here.
 
    Dispatches to the table-specific implementation:
      - 'client_user'  -> update_client_user_profile (password-only call,
                          reuses its existing validation/hashing so there
                          is exactly one place that logic lives).
      - 'client_staff' -> support_db_staff.update_client_staff_own_password.
    """
    if account_type == 'client_staff':
        from support_db_staff import update_client_staff_own_password
        return update_client_staff_own_password(str(user_id), new_password)
 
    if account_type == 'client_user':
        return update_client_user_profile(str(user_id), {'new_password': new_password})
 
    raise ValueError('Unsupported account type for password change')