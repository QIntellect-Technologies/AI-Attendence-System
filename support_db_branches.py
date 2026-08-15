# """
# support_db_branches.py
# ───────────────────────────────────────────────────────────────────────────────
# Branches and per-org module entitlements.

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
# from support_db_core import _BRANCH_CACHE, _cache_get, _cache_set, _ensure_org_client_access, _execute_supabase, _invalidate_tenant_meta_cache, _validate_branch_timezone
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

# def list_branches(org_id: str, include_dropped: bool = False) -> list[dict]:
#     from support_db_organizations import _delete_error_is_schema_mismatch
#     org_key = str(org_id)
#     cache_key = f"{org_key}:dropped={int(bool(include_dropped))}"
#     cached = _cache_get(_BRANCH_CACHE, cache_key)
#     if cached is not None:
#         return [dict(branch) for branch in cached]

#     def _query_with_drop_filter():
#         query = (
#             get_supabase()
#             .table('branches')
#             .select('*')
#             .eq('org_id', org_key)
#         )
#         if not include_dropped:
#             query = query.is_('dropped_at', 'null')
#         return query.order('created_at')

#     try:
#         result = _execute_supabase('list_branches', _query_with_drop_filter)
#         rows = [dict(branch) for branch in (result.data or [])]
#     except Exception as exc:
#         if not _delete_error_is_schema_mismatch(exc, 'branches'):
#             raise
#         result = _execute_supabase(
#             'list_branches_without_drop_filter',
#             lambda: (
#                 get_supabase()
#                 .table('branches')
#                 .select('*')
#                 .eq('org_id', org_key)
#                 .order('created_at')
#             ),
#         )
#         rows = [dict(branch) for branch in (result.data or [])]
#         if not include_dropped:
#             rows = [row for row in rows if not row.get('dropped_at')]

#     _cache_set(_BRANCH_CACHE, cache_key, rows)
#     return [dict(branch) for branch in rows]

# def create_branch(payload: dict) -> dict:
#     from support_db_client_users import _seed_default_branch_module_people_types
#     from support_db_organizations import get_organization
#     sb = get_supabase()
#     org_id = payload['org_id']

#     org = get_organization(org_id)
#     current_count = len(list_branches(str(org_id)))

#     if current_count >= org['max_branches']:
#         raise ValueError(
#             f'Branch limit reached ({org["max_branches"]}). '
#             f'Increase max_branches on the organization first.'
#         )

#     branch_timezone = _validate_branch_timezone(payload.get('timezone') or 'UTC')

#     result = sb.table('branches').insert({
#         'org_id':               org_id,
#         'name':                 payload['name'].strip(),
#         'location':             payload.get('location'),
#         'max_staff_capacity':   int(payload.get('max_staff_capacity', 50)),
#         'timezone':             branch_timezone,
#     }).execute()

#     if not result.data:
#         raise RuntimeError('Failed to create branch')

#     branch = result.data[0]
#     _seed_default_branch_module_people_types(str(org_id), str(branch['id']))
#     _invalidate_tenant_meta_cache(str(org_id))
#     return branch

# def _count_active_people_for_branch(org_id: str, branch_id: str) -> int:
#     """Count active, non-archived people assigned to one support-owned branch.

#     This is used before decreasing branch capacity. The current tenant people
#     table is client_staff, but the function intentionally counts all active
#     records instead of hardcoding only role=staff so school/student templates
#     remain compatible as the people model expands.
#     """
#     from support_db_organizations import _delete_error_is_schema_mismatch
#     try:
#         result = (
#             get_supabase()
#             .table('client_staff')
#             .select('id', count='exact')
#             .eq('org_id', str(org_id))
#             .eq('branch_id', str(branch_id))
#             .eq('is_archived', False)
#             .neq('status', 'inactive')
#             .execute()
#         )
#         return int(result.count or 0)
#     except Exception as exc:
#         if _table_missing(exc, 'client_staff') or _delete_error_is_schema_mismatch(exc, 'client_staff'):
#             return 0
#         raise

# def _get_branch_for_update(branch_id: str, org_id: str | None = None) -> dict:
#     """Load one branch and optionally enforce organization ownership."""
#     sb = get_supabase()
#     query = (
#         sb.table('branches')
#         .select('*')
#         .eq('id', str(branch_id))
#         .is_('dropped_at', 'null')
#         .limit(1)
#     )
#     if org_id:
#         query = query.eq('org_id', str(org_id))
#     result = query.execute()
#     if not result.data:
#         raise ValueError('Branch not found for this organization' if org_id else f'Branch {branch_id} not found')
#     return result.data[0]

# def update_branch(branch_id: str, payload: dict, org_id: str | None = None) -> dict:
#     """
#     Update branch-level paid capacity/settings owned by QIntellect Support.

#     Mutable fields:
#       - name
#       - location
#       - max_staff_capacity
#       - fallback_active

#     Safety rules:
#       - If org_id is supplied, branch ownership is verified before update.
#       - Capacity can increase or decrease anytime.
#       - Capacity decrease is blocked only when it would fall below the current active people count.
#     """
#     sb = get_supabase()
#     current_branch = _get_branch_for_update(str(branch_id), str(org_id) if org_id else None)
#     branch_org_id = str(org_id or current_branch.get('org_id') or '').strip()

#     allowed = {'name', 'location', 'max_staff_capacity', 'fallback_active', 'timezone'}
#     update_data = {k: v for k, v in (payload or {}).items() if k in allowed}

#     if not update_data:
#         raise ValueError('No valid branch fields to update')

#     if 'name' in update_data:
#         update_data['name'] = str(update_data['name'] or '').strip()
#         if not update_data['name']:
#             raise ValueError('Branch name is required')

#     if 'timezone' in update_data:
#         update_data['timezone'] = _validate_branch_timezone(update_data['timezone'])

#     if 'location' in update_data:
#         location = str(update_data.get('location') or '').strip()
#         update_data['location'] = location or None

#     if 'max_staff_capacity' in update_data:
#         try:
#             capacity = int(update_data['max_staff_capacity'])
#         except (TypeError, ValueError):
#             raise ValueError('max_staff_capacity must be a valid number')

#         if capacity < 1:
#             raise ValueError('max_staff_capacity must be at least 1')

#         if branch_org_id:
#             active_people = _count_active_people_for_branch(branch_org_id, str(branch_id))
#             if capacity < active_people:
#                 raise ValueError(
#                     f'max_staff_capacity cannot be lower than active people in this branch ({active_people}).'
#                 )

#         update_data['max_staff_capacity'] = capacity

#     if 'fallback_active' in update_data and not isinstance(update_data['fallback_active'], bool):
#         raise ValueError('fallback_active must be a boolean')

#     result = (
#         sb.table('branches')
#         .update(update_data)
#         .eq('id', str(branch_id))
#         .execute()
#     )

#     if not result.data:
#         raise ValueError(f'Branch {branch_id} not found')

#     branch = result.data[0]
#     _invalidate_tenant_meta_cache(str(branch.get('org_id') or branch_org_id or ''))
#     return branch

# def _unique_text_ids(values: object) -> list[str]:
#     if not isinstance(values, list):
#         return []
#     seen: set[str] = set()
#     result: list[str] = []
#     for item in values:
#         text = str(item or '').strip()
#         if text and text not in seen:
#             seen.add(text)
#             result.append(text)
#     return result

# def drop_organization_branches_for_limit(
#     org_id: str,
#     branch_ids: list[str],
#     dropped_by: str | None,
#     reason: str | None = None,
# ) -> list[dict]:
#     """Soft-drop support-owned branches after max_branches is decreased.

#     Dropped branches remain in the database for audit/history, but are removed
#     from Client Dashboard bootstrap and cannot receive new node installers.
#     """
#     org_key = str(org_id)
#     selected_ids = _unique_text_ids(branch_ids)
#     if not selected_ids:
#         return []

#     active_branches = list_branches(org_key)
#     active_by_id = {str(branch.get('id')): branch for branch in active_branches if branch.get('id')}
#     missing = [branch_id for branch_id in selected_ids if branch_id not in active_by_id]
#     if missing:
#         raise ValueError('One or more selected branches do not belong to this organization or are already dropped')

#     now = datetime.now(timezone.utc).isoformat()
#     clean_reason = str(reason or '').strip() or 'Dropped after branch limit decrease'
#     result = (
#         get_supabase()
#         .table('branches')
#         .update({
#             'dropped_at': now,
#             'dropped_by': str(dropped_by) if dropped_by else None,
#             'drop_reason': clean_reason,
#             'updated_at': now,
#         })
#         .eq('org_id', org_key)
#         .in_('id', selected_ids)
#         .is_('dropped_at', 'null')
#         .execute()
#     )
#     rows = [dict(row or {}) for row in (result.data or [])]
#     if len(rows) != len(selected_ids):
#         raise RuntimeError('Failed to drop all selected branches')

#     try:
#         get_supabase().table('node_api_keys').update({'status': 'revoked'}).eq('org_id', org_key).in_('branch_id', selected_ids).eq('status', 'active').execute()
#     except Exception as exc:
#         logger.warning('Could not revoke active node keys for dropped branches org=%s: %s', org_key, exc)

#     try:
#         get_supabase().table('install_tokens').update({'used_at': now}).eq('org_id', org_key).in_('branch_id', selected_ids).is_('used_at', 'null').execute()
#     except Exception as exc:
#         logger.warning('Could not close install tokens for dropped branches org=%s: %s', org_key, exc)

#     _invalidate_tenant_meta_cache(org_key)
#     return rows

# def _validate_branch_limit_decrease(
#     *,
#     org_id: str,
#     new_max_branches: int,
#     drop_branch_ids: object,
#     updated_by: str | None,
#     reason: str | None = None,
# ) -> None:
#     active_branches = list_branches(str(org_id))
#     active_count = len(active_branches)
#     if new_max_branches >= active_count:
#         return

#     required_drop_count = active_count - new_max_branches
#     selected_ids = _unique_text_ids(drop_branch_ids)
#     if len(selected_ids) != required_drop_count:
#         branch_names = ', '.join(str(branch.get('name') or branch.get('id')) for branch in active_branches)
#         raise ValueError(
#             f'Branch limit decrease requires selecting exactly {required_drop_count} branch(es) to drop. '
#             f'Active branches: {branch_names}'
#         )

#     drop_organization_branches_for_limit(
#         org_id=str(org_id),
#         branch_ids=selected_ids,
#         dropped_by=updated_by,
#         reason=reason,
#     )

# def create_client_branch_install_token(
#     *,
#     user_id: str,
#     branch_id: str,
#     ttl_days: int = 7,
#     node_label: str | None = None,
# ) -> dict:
#     """Create a branch-scoped installer token for an authenticated client user."""
#     from support_db_client_users import _active_client_modules, get_client_user_session_by_id
#     from support_db_nodes import _get_branch_owned_by_org, create_branch_install_token
#     session = get_client_user_session_by_id(str(user_id))
#     role = str(session.get('role') or session.get('client_role') or '').strip().lower()
#     if role not in {'admin', 'hr'}:
#         raise ValueError('Only client admin or HR users can download node installers')

#     org_id = str(session.get('organization_id') or session.get('organizationId') or '').strip()
#     if not org_id:
#         raise ValueError('Client user is not linked to an organization')

#     org = _ensure_org_client_access(org_id, 'Installer download')
#     modules = set(_active_client_modules(org_id))
#     if 'attendance' not in modules:
#         raise ValueError('Attendance module is not active for this organization')

#     if str(org.get('attendance_mode') or '').strip().lower() != 'local':
#         raise ValueError('Node installer is available only for local attendance mode')

#     branch = _get_branch_owned_by_org(org_id, str(branch_id))
#     allowed_branch_ids = {str(item) for item in (session.get('allowedBranchIds') or []) if item}
#     if allowed_branch_ids and str(branch.get('id')) not in allowed_branch_ids:
#         raise ValueError('Client user is not allowed to access this branch')

#     token = create_branch_install_token(
#         org_id=org_id,
#         branch_id=str(branch.get("id")),
#         created_by=str(user_id),
#         ttl_days=ttl_days,
#         created_by_actor_type="client",
#     )
#     if node_label:
#         token['node_label'] = str(node_label).strip()
#     return token

# def list_org_modules(org_id: str) -> list[dict]:
#     result = _execute_supabase(
#         'list_org_modules',
#         lambda: get_supabase().table('organization_modules').select('*').eq('org_id', org_id).order('purchased_at'),
#     )
#     return result.data or []

# def set_org_modules(org_id: str, module_names: list[str]) -> list[dict]:
#     """
#     Replace the full purchased module set for an organisation.
 
#     Phase 2, Step 4. Upserts active modules; deactivates everything else.
#     Accepts both canonical keys and legacy aliases — stores only canonical keys.
#     """
#     from support_db_client_users import _normalise_module_name
#     sb = get_supabase()
 
#     # 1. Validate + normalise every incoming name (raises ValueError on unknown)
#     normalised: list[str] = []
#     for raw in module_names:
#         normalised.append(_normalise_module_name(raw))
 
#     # 2. Deduplicate while preserving order (aliases may collapse to same key)
#     seen: set[str] = set()
#     unique: list[str] = []
#     for name in normalised:
#         if name not in seen:
#             seen.add(name)
#             unique.append(name)
 
#     # 3. Upsert every module in the new set as active
#     for module_name in unique:
#         sb.table('organization_modules').upsert(
#             {
#                 'org_id':       org_id,
#                 'module_name':  module_name,
#                 'status':       'active',
#             },
#             on_conflict='org_id,module_name',
#         ).execute()
 
#     # 4. Deactivate modules no longer in the set
#     if unique:
#         sb.table('organization_modules').update(
#             {'status': 'inactive'}
#         ).eq('org_id', org_id).not_.in_('module_name', unique).execute()
#     else:
#         # Empty list = deactivate everything
#         sb.table('organization_modules').update(
#             {'status': 'inactive'}
#         ).eq('org_id', org_id).execute()
 
#     return list_org_modules(org_id)

# def toggle_module(org_id: str, module_name: str, status: str) -> dict:
#     """Toggle a single module independently from billing (Section 7)."""
#     from support_db_client_users import _normalise_module_name, _seed_default_branch_module_people_types
#     sb = get_supabase()

#     result = sb.table('organization_modules').upsert({
#         'org_id':       org_id,
#         'module_name':  module_name,
#         'status':       status,
#     }, on_conflict='org_id,module_name').execute()

#     if not result.data:
#         raise RuntimeError(f'Failed to toggle module {module_name}')

#     # A module turned on for an org that already has branches needs the same
#     # default people-type seed a brand-new branch gets in create_branch —
#     # otherwise every existing branch shows nobody for this module until an
#     # admin manually visits the Modules tab. Seeding is insert-if-absent, so
#     # this is a no-op for branches that already have rows for this module.
#     if str(status).strip().lower() == 'active':
#         canonical_module = _normalise_module_name(module_name)
#         for branch in list_branches(str(org_id)):
#             _seed_default_branch_module_people_types(
#                 str(org_id), str(branch['id']), module_keys=[canonical_module],
#             )

#     return result.data[0]


"""
support_db_branches.py
───────────────────────────────────────────────────────────────────────────────
Branches and per-org module entitlements.

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
from support_db_core import _BRANCH_CACHE, _cache_get, _cache_set, _ensure_org_client_access, _execute_supabase, _invalidate_tenant_meta_cache, _validate_branch_timezone
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

def list_branches(org_id: str, include_dropped: bool = False) -> list[dict]:
    from support_db_organizations import _delete_error_is_schema_mismatch
    org_key = str(org_id)
    cache_key = f"{org_key}:dropped={int(bool(include_dropped))}"
    cached = _cache_get(_BRANCH_CACHE, cache_key)
    if cached is not None:
        return [dict(branch) for branch in cached]

    def _query_with_drop_filter():
        query = (
            get_supabase()
            .table('branches')
            .select('*')
            .eq('org_id', org_key)
        )
        if not include_dropped:
            query = query.is_('dropped_at', 'null')
        return query.order('created_at')

    try:
        result = _execute_supabase('list_branches', _query_with_drop_filter)
        rows = [dict(branch) for branch in (result.data or [])]
    except Exception as exc:
        if not _delete_error_is_schema_mismatch(exc, 'branches'):
            raise
        result = _execute_supabase(
            'list_branches_without_drop_filter',
            lambda: (
                get_supabase()
                .table('branches')
                .select('*')
                .eq('org_id', org_key)
                .order('created_at')
            ),
        )
        rows = [dict(branch) for branch in (result.data or [])]
        if not include_dropped:
            rows = [row for row in rows if not row.get('dropped_at')]

    _cache_set(_BRANCH_CACHE, cache_key, rows)
    return [dict(branch) for branch in rows]

def create_branch(payload: dict) -> dict:
    from support_db_client_users import _seed_default_branch_module_people_types
    from support_db_organizations import get_organization
    sb = get_supabase()
    org_id = payload['org_id']

    org = get_organization(org_id)
    current_count = len(list_branches(str(org_id)))

    if current_count >= org['max_branches']:
        raise ValueError(
            f'Branch limit reached ({org["max_branches"]}). '
            f'Increase max_branches on the organization first.'
        )

    branch_timezone = _validate_branch_timezone(payload.get('timezone') or 'UTC')

    result = sb.table('branches').insert({
        'org_id':               org_id,
        'name':                 payload['name'].strip(),
        'location':             payload.get('location'),
        'max_staff_capacity':   int(payload.get('max_staff_capacity', 50)),
        'timezone':             branch_timezone,
    }).execute()

    if not result.data:
        raise RuntimeError('Failed to create branch')

    branch = result.data[0]
    _seed_default_branch_module_people_types(str(org_id), str(branch['id']))
    _invalidate_tenant_meta_cache(str(org_id))
    return branch

def _count_active_people_for_branch(org_id: str, branch_id: str) -> int:
    """Count active, non-archived people assigned to one support-owned branch.

    This is used before decreasing branch capacity. The current tenant people
    table is client_staff, but the function intentionally counts all active
    records instead of hardcoding only role=staff so school/student templates
    remain compatible as the people model expands.
    """
    from support_db_organizations import _delete_error_is_schema_mismatch
    try:
        result = (
            get_supabase()
            .table('client_staff')
            .select('id', count='exact')
            .eq('org_id', str(org_id))
            .eq('branch_id', str(branch_id))
            .eq('is_archived', False)
            .neq('status', 'inactive')
            .execute()
        )
        return int(result.count or 0)
    except Exception as exc:
        if _table_missing(exc, 'client_staff') or _delete_error_is_schema_mismatch(exc, 'client_staff'):
            return 0
        raise

def _get_branch_for_update(branch_id: str, org_id: str | None = None) -> dict:
    """Load one branch and optionally enforce organization ownership."""
    sb = get_supabase()
    query = (
        sb.table('branches')
        .select('*')
        .eq('id', str(branch_id))
        .is_('dropped_at', 'null')
        .limit(1)
    )
    if org_id:
        query = query.eq('org_id', str(org_id))
    result = query.execute()
    if not result.data:
        raise ValueError('Branch not found for this organization' if org_id else f'Branch {branch_id} not found')
    return result.data[0]

def update_branch(branch_id: str, payload: dict, org_id: str | None = None) -> dict:
    """
    Update branch-level paid capacity/settings owned by QIntellect Support.

    Mutable fields:
      - name
      - location
      - max_staff_capacity
      - fallback_active

    Safety rules:
      - If org_id is supplied, branch ownership is verified before update.
      - Capacity can increase or decrease anytime.
      - Capacity decrease is blocked only when it would fall below the current active people count.
    """
    sb = get_supabase()
    current_branch = _get_branch_for_update(str(branch_id), str(org_id) if org_id else None)
    branch_org_id = str(org_id or current_branch.get('org_id') or '').strip()

    allowed = {'name', 'location', 'max_staff_capacity', 'fallback_active', 'timezone'}
    update_data = {k: v for k, v in (payload or {}).items() if k in allowed}

    if not update_data:
        raise ValueError('No valid branch fields to update')

    if 'name' in update_data:
        update_data['name'] = str(update_data['name'] or '').strip()
        if not update_data['name']:
            raise ValueError('Branch name is required')

    if 'timezone' in update_data:
        update_data['timezone'] = _validate_branch_timezone(update_data['timezone'])

    if 'location' in update_data:
        location = str(update_data.get('location') or '').strip()
        update_data['location'] = location or None

    if 'max_staff_capacity' in update_data:
        try:
            capacity = int(update_data['max_staff_capacity'])
        except (TypeError, ValueError):
            raise ValueError('max_staff_capacity must be a valid number')

        if capacity < 1:
            raise ValueError('max_staff_capacity must be at least 1')

        if branch_org_id:
            active_people = _count_active_people_for_branch(branch_org_id, str(branch_id))
            if capacity < active_people:
                raise ValueError(
                    f'max_staff_capacity cannot be lower than active people in this branch ({active_people}).'
                )

        update_data['max_staff_capacity'] = capacity

    if 'fallback_active' in update_data and not isinstance(update_data['fallback_active'], bool):
        raise ValueError('fallback_active must be a boolean')

    result = (
        sb.table('branches')
        .update(update_data)
        .eq('id', str(branch_id))
        .execute()
    )

    if not result.data:
        raise ValueError(f'Branch {branch_id} not found')

    branch = result.data[0]
    _invalidate_tenant_meta_cache(str(branch.get('org_id') or branch_org_id or ''))
    return branch

def _unique_text_ids(values: object) -> list[str]:
    if not isinstance(values, list):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for item in values:
        text = str(item or '').strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result

def drop_organization_branches_for_limit(
    org_id: str,
    branch_ids: list[str],
    dropped_by: str | None,
    reason: str | None = None,
) -> list[dict]:
    """Soft-drop support-owned branches after max_branches is decreased.

    Dropped branches remain in the database for audit/history, but are removed
    from Client Dashboard bootstrap and cannot receive new node installers.
    """
    org_key = str(org_id)
    selected_ids = _unique_text_ids(branch_ids)
    if not selected_ids:
        return []

    active_branches = list_branches(org_key)
    active_by_id = {str(branch.get('id')): branch for branch in active_branches if branch.get('id')}
    missing = [branch_id for branch_id in selected_ids if branch_id not in active_by_id]
    if missing:
        raise ValueError('One or more selected branches do not belong to this organization or are already dropped')

    now = datetime.now(timezone.utc).isoformat()
    clean_reason = str(reason or '').strip() or 'Dropped after branch limit decrease'
    result = (
        get_supabase()
        .table('branches')
        .update({
            'dropped_at': now,
            'dropped_by': str(dropped_by) if dropped_by else None,
            'drop_reason': clean_reason,
            'updated_at': now,
        })
        .eq('org_id', org_key)
        .in_('id', selected_ids)
        .is_('dropped_at', 'null')
        .execute()
    )
    rows = [dict(row or {}) for row in (result.data or [])]
    if len(rows) != len(selected_ids):
        raise RuntimeError('Failed to drop all selected branches')

    try:
        get_supabase().table('node_api_keys').update({'status': 'revoked'}).eq('org_id', org_key).in_('branch_id', selected_ids).eq('status', 'active').execute()
    except Exception as exc:
        logger.warning('Could not revoke active node keys for dropped branches org=%s: %s', org_key, exc)

    try:
        get_supabase().table('install_tokens').update({'used_at': now}).eq('org_id', org_key).in_('branch_id', selected_ids).is_('used_at', 'null').execute()
    except Exception as exc:
        logger.warning('Could not close install tokens for dropped branches org=%s: %s', org_key, exc)

    _invalidate_tenant_meta_cache(org_key)
    return rows

def _validate_branch_limit_decrease(
    *,
    org_id: str,
    new_max_branches: int,
    drop_branch_ids: object,
    updated_by: str | None,
    reason: str | None = None,
) -> None:
    active_branches = list_branches(str(org_id))
    active_count = len(active_branches)
    if new_max_branches >= active_count:
        return

    required_drop_count = active_count - new_max_branches
    selected_ids = _unique_text_ids(drop_branch_ids)
    if len(selected_ids) != required_drop_count:
        branch_names = ', '.join(str(branch.get('name') or branch.get('id')) for branch in active_branches)
        raise ValueError(
            f'Branch limit decrease requires selecting exactly {required_drop_count} branch(es) to drop. '
            f'Active branches: {branch_names}'
        )

    drop_organization_branches_for_limit(
        org_id=str(org_id),
        branch_ids=selected_ids,
        dropped_by=updated_by,
        reason=reason,
    )

def create_client_branch_install_token(
    *,
    user_id: str,
    branch_id: str,
    ttl_days: int = 7,
    node_label: str | None = None,
) -> dict:
    """Create a branch-scoped installer token for an authenticated client user."""
    from support_db_client_users import _active_client_modules, get_client_user_session_by_id
    from support_db_nodes import _get_branch_owned_by_org, create_branch_install_token
    session = get_client_user_session_by_id(str(user_id))
    role = str(session.get('role') or session.get('client_role') or '').strip().lower()
    if role != 'admin':
        raise ValueError('Only a client admin can download node installers')

    org_id = str(session.get('organization_id') or session.get('organizationId') or '').strip()
    if not org_id:
        raise ValueError('Client user is not linked to an organization')

    org = _ensure_org_client_access(org_id, 'Installer download')
    modules = set(_active_client_modules(org_id))
    if 'attendance' not in modules:
        raise ValueError('Attendance module is not active for this organization')

    if str(org.get('attendance_mode') or '').strip().lower() != 'local':
        raise ValueError('Node installer is available only for local attendance mode')

    branch = _get_branch_owned_by_org(org_id, str(branch_id))
    allowed_branch_ids = {str(item) for item in (session.get('allowedBranchIds') or []) if item}
    if allowed_branch_ids and str(branch.get('id')) not in allowed_branch_ids:
        raise ValueError('Client user is not allowed to access this branch')

    token = create_branch_install_token(
        org_id=org_id,
        branch_id=str(branch.get("id")),
        created_by=str(user_id),
        ttl_days=ttl_days,
        created_by_actor_type="client",
    )
    if node_label:
        token['node_label'] = str(node_label).strip()
    return token

def list_org_modules(org_id: str) -> list[dict]:
    result = _execute_supabase(
        'list_org_modules',
        lambda: get_supabase().table('organization_modules').select('*').eq('org_id', org_id).order('purchased_at'),
    )
    return result.data or []

def set_org_modules(org_id: str, module_names: list[str]) -> list[dict]:
    """
    Replace the full purchased module set for an organisation.
 
    Phase 2, Step 4. Upserts active modules; deactivates everything else.
    Accepts both canonical keys and legacy aliases — stores only canonical keys.
    """
    from support_db_client_users import _normalise_module_name
    sb = get_supabase()
 
    # 1. Validate + normalise every incoming name (raises ValueError on unknown)
    normalised: list[str] = []
    for raw in module_names:
        normalised.append(_normalise_module_name(raw))
 
    # 2. Deduplicate while preserving order (aliases may collapse to same key)
    seen: set[str] = set()
    unique: list[str] = []
    for name in normalised:
        if name not in seen:
            seen.add(name)
            unique.append(name)
 
    # 3. Upsert every module in the new set as active
    for module_name in unique:
        sb.table('organization_modules').upsert(
            {
                'org_id':       org_id,
                'module_name':  module_name,
                'status':       'active',
            },
            on_conflict='org_id,module_name',
        ).execute()
 
    # 4. Deactivate modules no longer in the set
    if unique:
        sb.table('organization_modules').update(
            {'status': 'inactive'}
        ).eq('org_id', org_id).not_.in_('module_name', unique).execute()
    else:
        # Empty list = deactivate everything
        sb.table('organization_modules').update(
            {'status': 'inactive'}
        ).eq('org_id', org_id).execute()
 
    return list_org_modules(org_id)

def toggle_module(org_id: str, module_name: str, status: str) -> dict:
    """Toggle a single module independently from billing (Section 7)."""
    from support_db_client_users import _normalise_module_name, _seed_default_branch_module_people_types
    sb = get_supabase()

    result = sb.table('organization_modules').upsert({
        'org_id':       org_id,
        'module_name':  module_name,
        'status':       status,
    }, on_conflict='org_id,module_name').execute()

    if not result.data:
        raise RuntimeError(f'Failed to toggle module {module_name}')

    # A module turned on for an org that already has branches needs the same
    # default people-type seed a brand-new branch gets in create_branch —
    # otherwise every existing branch shows nobody for this module until an
    # admin manually visits the Modules tab. Seeding is insert-if-absent, so
    # this is a no-op for branches that already have rows for this module.
    if str(status).strip().lower() == 'active':
        canonical_module = _normalise_module_name(module_name)
        for branch in list_branches(str(org_id)):
            _seed_default_branch_module_people_types(
                str(org_id), str(branch['id']), module_keys=[canonical_module],
            )

    return result.data[0]