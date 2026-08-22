"""
support_db_staff.py
───────────────────────────────────────────────────────────────────────────────
Client staff management (CRUD, photos, face-training jobs) and the employee
data retention policy.

Split out of the original monolithic support_db.py. See support_db.py for
the backward-compatible facade that re-exports everything below.
"""

from datetime import date, timedelta, datetime, timezone
import json
from math import radians, sin, cos, atan2, sqrt
from typing import Optional, Any, Callable
import re
import time
import unicodedata
import bcrypt
import secrets
import string
import hashlib
import uuid
import os
from supabase_client import get_supabase, reset_supabase_client
from logger_config import get_logger
from support_db_core import _execute_supabase, _json_list, _org_access_allows_client
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

def _safe_float(value: Any) -> float | None:
    """Parse an optional numeric field (geofence lat/lng) without raising.

    Distinct from the several `float(x or 0)` coercions elsewhere in this
    module: those exist for columns where 0 is a valid value (salary), so
    "missing" and "zero" collapse together on purpose. A geofence's lat/lng
    must NOT collapse that way -- (0, 0) is a real point off the coast of
    Africa, not "unconfigured" -- so this returns None for missing/blank/
    unparseable input instead of 0.0.
    """
    if value is None or value == '':
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

def _haversine_distance_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two lat/lng points, in meters.

    Mirrors geofence_service.dart's calculateDistance exactly (same
    formula, same 6371000m earth radius) so a distance computed here and
    one computed on-device for display never disagree by more than
    floating-point noise.
    """
    earth_radius_m = 6371000.0
    phi1, phi2 = radians(lat1), radians(lat2)
    d_phi = radians(lat2 - lat1)
    d_lambda = radians(lng2 - lng1)
    a = sin(d_phi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(d_lambda / 2) ** 2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return earth_radius_m * c

def _client_branch_indexes(org_id: str) -> tuple[list[dict], dict[str, int], dict[str, dict]]:
    from support_db_branches import list_branches
    branches = list_branches(str(org_id))
    backend_to_ui: dict[str, int] = {}
    by_backend: dict[str, dict] = {}
    for idx, branch in enumerate(branches, start=1):
        backend_id = str(branch.get('id'))
        backend_to_ui[backend_id] = idx
        by_backend[backend_id] = branch
    return branches, backend_to_ui, by_backend

def _resolve_client_branch(org_id: str, raw_branch_id: Any) -> tuple[dict, int]:
    branches, backend_to_ui, by_backend = _client_branch_indexes(str(org_id))
    if not branches:
        raise ValueError('No branches are configured for this organization')

    raw = str(raw_branch_id or '').strip()
    if not raw:
        raise ValueError('branch_id is required')

    if raw in by_backend:
        return by_backend[raw], backend_to_ui[raw]

    try:
        ui_id = int(raw)
    except (TypeError, ValueError):
        ui_id = 0

    if ui_id > 0 and ui_id <= len(branches):
        branch = branches[ui_id - 1]
        return branch, ui_id

    raise ValueError('Selected branch does not belong to this organization')

def _branch_ui_id(org_id: str, branch_id: str | None) -> int | None:
    if not branch_id:
        return None
    _, backend_to_ui, _ = _client_branch_indexes(str(org_id))
    return backend_to_ui.get(str(branch_id))

from role_permissions import ROLE_CAPABILITIES

CLIENT_STAFF_ACCOUNT_ROLES = set(ROLE_CAPABILITIES.keys())

_CLIENT_STAFF_HAS_PEOPLE_TYPE_COLUMN: bool | None = None

def _normalize_people_type(value: object, fallback: str = "staff") -> str:
    text = str(value or fallback).strip().lower().replace(" ", "_").replace("-", "_")
    aliases = {
        "students": "student",
        "teachers": "teacher",
        "workers": "worker",
        "employees": "employee",
        "staff_members": "staff",
        "members": "member",
        "volunteers": "volunteer",
        "personnel": "personnel",
    }
    return aliases.get(text, text or fallback)

# ── Person-name validation ───────────────────────────────────────────────────
#
# Names arrive from the client dashboard and the Local Node enroll screen and
# were previously written to the database as-is: create_client_staff() only
# checked the value wasn't empty, and update_client_staff() didn't even do
# that — it copied payload['name'] straight into the update. So markup
# (<script>alert("HACKED")</script>) and SQL-shaped payloads (' OR '1'='1)
# were stored verbatim.
#
# On the SQL side this was never exploitable — Supabase parameterises every
# query — and the React dashboard escapes text nodes, so it isn't a live XSS
# either. What it IS, concretely:
#   * permanently polluted person records that no one can clean up from the UI
#   * a payload waiting for the first consumer that DOESN'T escape — the Local
#     Node UI, a future email/report template, a webhook
#   * spreadsheet formula injection: a name beginning =, +, - or @ is executed
#     by Excel on open, and ExportExcelButton.tsx writes cell values raw
#
# So the fix is an allow-list at the write boundary, where every client shares
# it, rather than an escape at each read site (which only helps the read sites
# that remember).
_NAME_MAX_LENGTH = 100
_NAME_MIN_LENGTH = 2

# Unicode-aware on purpose: \w with re.UNICODE would also admit digits and
# underscore, and this has to accept Urdu/Arabic/Chinese names, not just
# Latin ones. Allowed besides letters and marks: space, hyphen, apostrophe
# (both ASCII and typographic), period and comma — enough for "Muhammad
# Ali", "O'Brien", "Jean-Luc", "Smith, Jr." and "محمد علی".
_NAME_ALLOWED_PATTERN = re.compile(
    r"^[^\W\d_][\w\s\-'\u2019.,]*$",
    re.UNICODE,
)
_NAME_HAS_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)
_NAME_DIGIT = re.compile(r"\d")
# Leading =, +, - or @ makes Excel/Sheets treat the cell as a formula.
_SPREADSHEET_FORMULA_PREFIX = ("=", "+", "-", "@", "\t", "\r")


def _validate_person_name(value: object, field_label: str = "Name") -> str:
    """Normalise and validate a human name, or raise ValueError.

    Returns the cleaned name. Callers should store the RETURN VALUE, not the
    original — whitespace is collapsed and Unicode is NFC-normalised so that
    two visually identical names can't be stored as different byte strings.
    """
    raw = str(value or "")

    # NFC first: composed and decomposed forms of the same accented name
    # would otherwise compare unequal and defeat duplicate checks.
    text = unicodedata.normalize("NFC", raw)

    # Strip control characters (including the zero-width and bidi marks that
    # get used to disguise payloads) before any other check.
    text = "".join(ch for ch in text if unicodedata.category(ch)[0] != "C")

    # Collapse internal whitespace runs to single spaces.
    text = " ".join(text.split())

    if not text:
        raise ValueError(f"{field_label} is required")

    if len(text) < _NAME_MIN_LENGTH:
        raise ValueError(f"{field_label} must be at least {_NAME_MIN_LENGTH} characters")

    if len(text) > _NAME_MAX_LENGTH:
        raise ValueError(f"{field_label} must be {_NAME_MAX_LENGTH} characters or fewer")

    if text.startswith(_SPREADSHEET_FORMULA_PREFIX):
        raise ValueError(f"{field_label} cannot start with =, +, - or @")

    if _NAME_DIGIT.search(text):
        raise ValueError(f"{field_label} cannot contain numbers")

    if not _NAME_HAS_LETTER.search(text):
        raise ValueError(f"{field_label} must contain letters")

    if not _NAME_ALLOWED_PATTERN.match(text):
        raise ValueError(
            f"{field_label} can only contain letters, spaces, hyphens, "
            "apostrophes, periods and commas"
        )

    return text


# Person code (Employee ID / Registration Number / Teacher Code / Worker ID —
# see _person_code_label in support_db_client_users.py for the per-people_type
# display name). Was previously accepted as any non-empty string of any
# length straight from the request body via _person_code_from_payload — no
# cap, no character allow-list, so oversized strings and markup/SQL-shaped
# payloads went straight into client_staff.person_code / .employee_id.
#
# Deliberately stricter than the name allow-list: real-world codes in this
# product are always machine-generated or short manual entries in the
# EMP-001 / TCH-001 / REG-001 shape (see peopleCodeModel's placeholders in
# the frontend's types.ts) — letters, digits, hyphen and underscore only, no
# spaces, no Unicode needed. That also means no XSS/SQL pattern list is
# needed the way _validate_person_name has one: the allow-list itself
# already excludes every character an HTML tag or SQL clause requires
# (<, >, ", ', ;, /, whitespace, ( )).
_PERSON_CODE_MAX_LENGTH = 30
_PERSON_CODE_ALLOWED_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,%d})?$" % (_PERSON_CODE_MAX_LENGTH - 1))


def _validate_person_code(value: object, field_label: str = "Employee ID") -> str:
    """Normalise and validate a person code, or raise ValueError.

    Returns the cleaned code. Callers should store the RETURN VALUE, not the
    original — mirrors _validate_person_name's contract above.
    """
    raw = str(value or "")

    # Strip control characters (including zero-width/bidi marks) before any
    # other check, same reasoning as _validate_person_name.
    text = "".join(ch for ch in raw if unicodedata.category(ch)[0] != "C").strip()

    if not text:
        raise ValueError(f"{field_label} is required")

    if len(text) > _PERSON_CODE_MAX_LENGTH:
        raise ValueError(f"{field_label} must be {_PERSON_CODE_MAX_LENGTH} characters or fewer")

    if not _PERSON_CODE_ALLOWED_PATTERN.match(text):
        raise ValueError(
            f"{field_label} can only contain letters, digits, hyphens and underscores, "
            "and must start with a letter or digit"
        )

    return text


def _normalize_account_role(value: object, fallback: str = "staff") -> str:
    role = str(value or fallback).strip().lower()
    return role if role in CLIENT_STAFF_ACCOUNT_ROLES else fallback

def _digits_only(value: object) -> str:
    return ''.join(ch for ch in str(value or '') if ch.isdigit())

def _is_valid_cnic(value: object) -> bool:
    """Pakistani CNIC: 13 digits, conventionally dash-grouped 5-7-1
    (e.g. 42101-1234567-1). Accepts either the dashed display format or
    13 bare digits -- mirrors the frontend's isValidCnic check, kept here
    too since the API is reachable independent of the dashboard form."""
    return len(_digits_only(value)) == 13

def _require_cnic_fields(people_type: str, payload: dict) -> dict:
    """Validate and normalize the identity-document fields for one
    create/update payload. Raises ValueError with a field-specific message
    on the first missing/invalid field, mirroring the dashboard's own
    required-field messages so API and UI errors read the same way.

    Returns the normalized values to write: {'cnic': ...} for a non-student
    person, or {'father_name': ..., 'father_cnic': ..., 'father_phone': ...}
    for a student. Only ever returns the keys relevant to that person_type,
    since a student's own CNIC and a staff member's guardian details are
    both simply not applicable fields, not optional ones.
    """
    if people_type == 'student':
        father_name = str(payload.get('father_name') or payload.get('fatherName') or '').strip()
        father_cnic = str(payload.get('father_cnic') or payload.get('fatherCnic') or '').strip()
        father_phone = str(
            payload.get('father_phone') or payload.get('fatherPhone')
            or payload.get('father_number') or payload.get('fatherNumber') or ''
        ).strip()
        # Same allow-list as the person's own name — a guardian name is
        # rendered and exported through exactly the same paths.
        father_name = _validate_person_name(father_name, 'Father name')
        if not father_phone:
            raise ValueError('Father number is required')
        if not father_cnic:
            raise ValueError('Father CNIC is required')
        if not _is_valid_cnic(father_cnic):
            raise ValueError('Enter a valid 13-digit father CNIC (e.g. 42101-1234567-1)')
        return {'father_name': father_name, 'father_cnic': father_cnic, 'father_phone': father_phone}

    cnic = str(payload.get('cnic') or '').strip()
    if not cnic:
        raise ValueError('CNIC is required')
    if not _is_valid_cnic(cnic):
        raise ValueError('Enter a valid 13-digit CNIC (e.g. 42101-1234567-1)')
    return {'cnic': cnic}

def _client_staff_has_people_type_column() -> bool:
    """Return True when public.client_staff.people_type exists.

    The dashboard remains boot-safe while migrations roll out. When the column
    is missing, business people type filtering becomes a no-op, but the account
    role still stays inside the DB check constraint.
    """
    global _CLIENT_STAFF_HAS_PEOPLE_TYPE_COLUMN
    if _CLIENT_STAFF_HAS_PEOPLE_TYPE_COLUMN is not None:
        return _CLIENT_STAFF_HAS_PEOPLE_TYPE_COLUMN

    try:
        get_supabase().table('client_staff').select('people_type').limit(1).execute()
        _CLIENT_STAFF_HAS_PEOPLE_TYPE_COLUMN = True
    except Exception:
        _CLIENT_STAFF_HAS_PEOPLE_TYPE_COLUMN = False

    return bool(_CLIENT_STAFF_HAS_PEOPLE_TYPE_COLUMN)

def _staff_filter_parts(role: str | None = None, people_type: str | None = None) -> tuple[str | None, str | None]:
    """Split DB account role from template/business people type.

    `client_staff.role` has a check constraint and must remain an account role
    such as staff/admin/hr. Values like student, teacher, worker belong in
    `client_staff.people_type`, not in role.
    """
    raw_people_type = people_type or None
    raw_role = role or None

    # Explicit "every account role" sentinel. list_client_staff defaults to
    # role='staff' when the caller passes nothing, which is correct for the
    # Staff Directory table (it should only ever show role='staff' rows —
    # admins/HR/managers have their own account, not a directory entry).
    # But callers building a *people picker* — e.g. the Reporting Hierarchy
    # "Manager" dropdown in the Add/Edit modal — need every person in the
    # org regardless of account role, since a manager can themselves be an
    # admin/hr/manager-role account. Without this, a manager whose account
    # role isn't exactly 'staff' is silently missing from the dropdown's
    # options even though manager_id is saved correctly — the select then
    # can't show them as selected (no matching <option>), which looks
    # exactly like the assignment was never saved even though it was.
    if raw_role and str(raw_role).strip().lower() == "all":
        return None, (_normalize_people_type(raw_people_type) if raw_people_type else None)

    if raw_people_type:
        return _normalize_account_role(raw_role, "staff"), _normalize_people_type(raw_people_type)

    if raw_role and _normalize_people_type(raw_role) not in CLIENT_STAFF_ACCOUNT_ROLES:
        return "staff", _normalize_people_type(raw_role)

    return _normalize_account_role(raw_role, "staff") if raw_role else None, None

def _resolve_shift_map(org_id: str | None, shift_ids: set) -> dict[str, dict]:
    """Batch-resolve client_staff.shift_id_ref -> {label, start, end} against
    the `shifts` table — the read-side counterpart to
    support_db_shifts.assign_staff_shift() / support_db_attendance_gate._get_shift().

    `shifts` is the SOLE owner of check-in/check-out time (see
    support_db_shifts.py's module docstring); shift_id_ref only decides WHICH
    shift applies. Every staff-serialization call site must resolve through
    here rather than reading client_staff.shift_label/duty_start/duty_end
    directly — those legacy columns are written only by the old Add/Edit-modal
    flow and are never touched by the Shift Allocation tab, which is why the
    Directory previously went stale the moment a shift was (re)assigned there.

    Pass a precomputed map for list responses (list_client_staff,
    _direct_staff_page) to avoid N+1; single-row callers can omit it and
    _client_staff_safe will resolve just that one shift.
    """
    ids = sorted({str(s) for s in shift_ids if s})
    if not ids or not org_id:
        return {}
    sb = get_supabase()
    try:
        result = (
            sb.table('shifts')
            .select('id, name, check_in_time, check_out_time, is_active')
            .eq('org_id', str(org_id))
            .in_('id', ids)
            .execute()
        )
    except Exception:
        # A dangling/malformed shift_id_ref must never blank out the whole
        # staff list — same defensive posture as resolve_staff_shift_windows.
        return {}
    return {
        str(row['id']): {
            'label': row.get('name') or 'Shift',
            'start': str(row.get('check_in_time') or '09:00:00')[:5],
            'end': (str(row['check_out_time'])[:5] if row.get('check_out_time') else None),
            # Deliberately not filtered out of the query above (unlike
            # support_db_attendance_gate._get_shift, which filters
            # is_active=True because it's answering "should this still gate
            # attendance"). Display answers a different question — "what is
            # this person actually assigned to right now" — so a deactivated
            # shift the person is still pointed at should still show its real
            # name/time, not silently fall back to a fake default. Exposed
            # here so the frontend can badge "inactive shift" later without
            # another round trip; no UI change made in this pass.
            'is_active': bool(row.get('is_active', True)),
        }
        for row in (result.data or [])
    }

def _client_staff_safe(
    row: dict,
    org_id: str | None = None,
    branch_indexes: tuple[list[dict], dict[str, int], dict[str, dict]] | None = None,
    shifts_by_id: dict[str, dict] | None = None,
) -> dict:
    """Serialize one client_staff row for the Client Dashboard.

    The stable business identifier is person_code. Labels are template-aware:
    students see Registration Number, employees see Employee ID, workers see
    Worker ID, teachers see Teacher Code. Backend UUIDs remain available as ids
    for API calls, but are not used as display identifiers.
    """
    from support_db_client_users import _person_code_label
    row = dict(row or {})
    org_id = str(org_id or row.get('org_id') or '')
    branch_backend_id = str(row.get('branch_id') or '') if row.get('branch_id') else ''

    if branch_indexes is not None:
        _, backend_to_ui, by_backend = branch_indexes
        ui_branch_id = backend_to_ui.get(branch_backend_id)
    else:
        by_backend = {}
        ui_branch_id = _branch_ui_id(org_id, branch_backend_id) if org_id else None

    branch_name = row.get('branch_name') or ''
    if not branch_name and org_id and branch_backend_id:
        try:
            if not by_backend:
                _, _, by_backend = _client_branch_indexes(org_id)
            branch_name = by_backend.get(branch_backend_id, {}).get('name') or ''
        except Exception:
            branch_name = ''

    # Office WiFi auto-mark used to be a hardcoded SSID/BSSID baked into the
    # mobile app (office_home_screen.dart's _officeSSID/_officeBSSID). It now
    # lives on this person's own client_staff row -- office_ssid/office_bssid
    # (a JSON list of BSSIDs, since mesh offices have more than one access
    # point on the same SSID) -- set from Staff Management's "Attendance
    # Location" section and read back below. Per-staff rather than
    # per-branch so a manager can vary it per person if ever needed, while
    # still normally just copying the same value across everyone at a site.
    office_ssid = row.get('office_ssid') or None
    office_bssid_list = _json_list(row.get('office_bssid'))

    # Field-staff geofence (static-location scenario): the site this person
    # is expected to be at, and how far from it (meters) still counts as
    # "there." None/None means "not configured yet" -- evaluate_field_geofence
    # and the mobile app must treat that as distinct from a real 0,0 point.
    geofence_lat = _safe_float(row.get('geofence_lat'))
    geofence_lng = _safe_float(row.get('geofence_lng'))
    geofence_radius_meters = row.get('geofence_radius_meters')
    geofence_radius_meters = (
        int(geofence_radius_meters) if geofence_radius_meters not in (None, '') else None
    )
    geofence_label = row.get('geofence_label') or None

    access_modules = _json_list(row.get('access_modules'))
    benefits = _json_list(row.get('benefits'))
    role_name = row.get('role_name') or row.get('position') or 'Staff'
    status = row.get('status') or ('inactive' if row.get('is_archived') else 'active')
    people_type = _normalize_people_type(
        row.get('people_type') or row.get('person_type') or row.get('role') or 'staff'
    )
    person_code = str(
        row.get('person_code')
        or row.get('registration_number')
        or row.get('employee_id')
        or ''
    ).strip()

    # Shift Allocation tab is the sole shift-assignment surface and only ever
    # writes shift_id_ref (see support_db_shifts.assign_staff_shift) — the
    # display fields below MUST resolve through it, not through the legacy
    # shift_label/duty_start/duty_end columns, or they silently go stale the
    # moment a real shift is (re)assigned. shifts_by_id is a precomputed batch
    # map from list callers; single-row callers (create/update/restore/
    # get_client_staff_member) fall back to resolving just this one shift.
    shift_id_ref = row.get('shift_id_ref')
    resolved_shift = None
    if shift_id_ref:
        if shifts_by_id is not None:
            resolved_shift = shifts_by_id.get(str(shift_id_ref))
        else:
            resolved_shift = _resolve_shift_map(org_id, {shift_id_ref}).get(str(shift_id_ref))

    if resolved_shift:
        shift_label = resolved_shift['label']
        duty_start = resolved_shift['start']
        duty_end = resolved_shift['end'] or (row.get('duty_end') or '17:00')
    else:
        shift_label = row.get('shift_label') or 'Morning'
        duty_start = row.get('duty_start') or '09:00'
        duty_end = row.get('duty_end') or '17:00'

    return {
        'id': row.get('id'),
        'user_id': row.get('id'),
        'userId': row.get('id'),
        'staff_id': row.get('id'),
        'staffId': row.get('id'),
        'name': row.get('name') or '',
        'email': row.get('email') or '',
        'phone': row.get('phone') or '',
        'role': row.get('role') or 'staff',
        'client_role': row.get('role') or 'staff',
        'account_role': row.get('role') or 'staff',
        'accountRole': row.get('role') or 'staff',
        'people_type': people_type,
        'peopleType': people_type,
        'person_type': people_type,
        'personType': people_type,
        'department': row.get('department_name') or '',
        'dept': row.get('department_name') or '',
        'position': role_name,
        'designation': role_name,
        'salary': float(row.get('salary') or 0),
        'benefits': benefits,
        'join_date': row.get('join_date') or '',
        'status': status,
        'active': bool(not row.get('is_archived') and status != 'inactive'),
        'staff_type': row.get('staff_type') or 'office',
        'staffType': row.get('staff_type') or 'office',
        'geofence_lat': geofence_lat,
        'geofenceLat': geofence_lat,
        'geofence_lng': geofence_lng,
        'geofenceLng': geofence_lng,
        'geofence_radius_meters': geofence_radius_meters,
        'geofenceRadiusMeters': geofence_radius_meters,
        'geofence_label': geofence_label,
        'geofenceLabel': geofence_label,
        'office_ssid': office_ssid,
        'officeSsid': office_ssid,
        'office_bssid_list': office_bssid_list,
        'officeBssidList': office_bssid_list,
        'access_modules': access_modules,
        'allowedModules': access_modules,
        'moduleAccess': access_modules,
        'accessModules': access_modules,
        'organization_id': org_id,
        'organizationId': org_id,
        'branch_id': ui_branch_id,
        'branchId': ui_branch_id,
        'branch_ui_id': ui_branch_id,
        'branchUiId': ui_branch_id,
        'backend_branch_id': branch_backend_id,
        'backendBranchId': branch_backend_id,
        'branch_uuid': branch_backend_id,
        'branchUuid': branch_backend_id,
        'branch_name': branch_name,
        'branchName': branch_name,
        'shift': shift_label,
        'shift_id': str(shift_id_ref) if shift_id_ref else (row.get('shift_id') or 'morning'),
        'shiftId': str(shift_id_ref) if shift_id_ref else (row.get('shift_id') or 'morning'),
        'shift_id_ref': str(shift_id_ref) if shift_id_ref else None,
        'shiftIdRef': str(shift_id_ref) if shift_id_ref else None,
        'shift_is_active': (resolved_shift['is_active'] if resolved_shift else None),
        'shiftIsActive': (resolved_shift['is_active'] if resolved_shift else None),
        'shift_label': shift_label,
        'shiftLabel': shift_label,
        'duty_start': duty_start,
        'dutyStart': duty_start,
        'duty_end': duty_end,
        'dutyEnd': duty_end,
        'profile_image_url': row.get('profile_image_url') or '',
        'profileImageUrl': row.get('profile_image_url') or '',
        'avatarUrl': row.get('profile_image_url') or '',
        'photo_url': row.get('profile_image_url') or '',
        'photoUrl': row.get('profile_image_url') or '',
        'profile_image_name': row.get('profile_image_name') or '',
        'profileImageName': row.get('profile_image_name') or '',
        'attendance_enabled': bool(row.get('attendance_enabled', True)),
        'attendanceEnabled': bool(row.get('attendance_enabled', True)),
        'is_face_verified': bool(row.get('is_face_verified', False)),
        'isFaceVerified': bool(row.get('is_face_verified', False)),
        'face_training_status': row.get('face_training_status') or 'not_trained',
        'faceTrainingStatus': row.get('face_training_status') or 'not_trained',
        'created_at': row.get('created_at'),
        'createdAt': row.get('created_at'),
        'updated_at': row.get('updated_at') or row.get('created_at'),
        'updatedAt': row.get('updated_at') or row.get('created_at'),
        'archived_at': row.get('archived_at'),
        'archivedAt': row.get('archived_at'),
        'employee_id': person_code,
        'employeeId': person_code,
        'person_code': person_code,
        'personCode': person_code,
        'registration_number': row.get('registration_number') or (person_code if people_type == 'student' else ''),
        'registrationNumber': row.get('registration_number') or (person_code if people_type == 'student' else ''),
        'person_code_label': row.get('person_code_label') or _person_code_label(people_type),
        'personCodeLabel': row.get('person_code_label') or _person_code_label(people_type),
        # Identity documents — cnic belongs to the person themselves
        # (required for every non-student people_type); father_name/
        # father_cnic/father_phone are guardian details required for
        # students instead. Both sets are always read back out here
        # regardless of people_type so a template switch never looks like
        # silent data loss — the unused set is just blank.
        'cnic': row.get('cnic') or '',
        'father_name': row.get('father_name') or '',
        'fatherName': row.get('father_name') or '',
        'father_cnic': row.get('father_cnic') or '',
        'fatherCnic': row.get('father_cnic') or '',
        'father_phone': row.get('father_phone') or '',
        'fatherPhone': row.get('father_phone') or '',
        # Reporting Hierarchy fields (support_db_hierarchy.py writes these
        # three columns via assign_manager/set_linked_client_user/
        # set_dashboard_scope). They MUST be read back out here, or:
        #   (a) every place that renders this dict (staff list, Edit modal
        #       initial values) resets to "No manager" / "branch" on refresh
        #       even though the DB still has the real values, and
        #   (b) worse — authenticate_client_staff_for_dashboard() returns
        #       this exact dict straight into mint_dashboard_token(), so a
        #       saved dashboard_scope='team' had ZERO effect on that
        #       manager's next login token: mint_dashboard_token falls back
        #       to user.get('dashboard_scope')/user.get('manager_id') when
        #       no explicit kwarg is passed, and both were always missing
        #       from this dict, so every client_staff session silently
        #       minted as 'branch' (unscoped) regardless of what was set.
        'manager_id': row.get('manager_id'),
        'managerId': row.get('manager_id'),
        'linked_client_user_id': row.get('linked_client_user_id'),
        'linkedClientUserId': row.get('linked_client_user_id'),
        'dashboard_scope': row.get('dashboard_scope') or 'branch',
        'dashboardScope': row.get('dashboard_scope') or 'branch',
        # client_staff-origin marker, distinct from client_users (the org
        # owner/admin invited by Support). AuthContext.normaliseUser and
        # Login.tsx's isAdminPendingOnboarding both read requires_onboarding
        # off this dict — without an explicit False here, a client_staff
        # row promoted to role='admin' (the "Grant admin" toggle in Staff
        # Management) looked identical to a genuine pending org-owner
        # signup once role alone was checked, and got bounced to
        # /onboarding on login (then 400'd there, since that endpoint only
        # knows the client_users table — this staff row's id doesn't exist
        # in it). Onboarding is a one-time, org-owner-only flow; a
        # client_staff account — admin-toggled or not — always joins an
        # org that's already been through it, so these are hardcoded, not
        # derived like the client_users equivalents in
        # support_db_client_users._client_user_safe.
        'source': 'client_staff',
        'organization_status': 'active',
        'organizationStatus': 'active',
        'requires_onboarding': False,
        'requiresOnboarding': False,
        'dashboard_ready': bool(org_id and ui_branch_id),
        'dashboardReady': bool(org_id and ui_branch_id),
    }

def _next_employee_id(org_id: str) -> str:
    sb = get_supabase()
    result = (
        sb.table('client_staff')
        .select('id', count='exact')
        .eq('org_id', str(org_id))
        .execute()
    )
    return f"EMP-{int((result.count or 0) + 1):04d}"

def list_client_staff(org_id: str, branch_id: Any = None, role: str | None = 'staff', archived: bool = False, people_type: str | None = None) -> list[dict]:
    from support_db_organizations import get_organization
    org_key = str(org_id)
    get_organization(org_key)

    # Resolve branch metadata once for the whole response. Without this, every
    # staff row calls list_branches() again through _client_staff_safe().
    branch_indexes = _client_branch_indexes(org_key)

    account_role, business_people_type = _staff_filter_parts(role=role, people_type=people_type)

    backend_branch_id = None
    if branch_id not in (None, ''):
        branch, _ = _resolve_client_branch(org_key, branch_id)
        backend_branch_id = str(branch['id'])

    def _staff_query():
        query = (
            get_supabase()
            .table('client_staff')
            .select('*')
            .eq('org_id', org_key)
            .eq('is_archived', bool(archived))
            .order('name')
        )
        if account_role:
            query = query.eq('role', account_role)
        if business_people_type and _client_staff_has_people_type_column():
            query = query.eq('people_type', business_people_type)
        if backend_branch_id:
            query = query.eq('branch_id', backend_branch_id)
        return query

    result = _execute_supabase('list_client_staff', _staff_query)
    rows = result.data or []
    shifts_by_id = _resolve_shift_map(org_key, {r.get('shift_id_ref') for r in rows})
    return [
        _client_staff_safe(row, org_key, branch_indexes, shifts_by_id)
        for row in rows
    ]

def get_client_staff_member(staff_id: str) -> dict:
    sb = get_supabase()
    result = sb.table('client_staff').select('*').eq('id', str(staff_id)).limit(1).execute()
    if not result.data:
        raise ValueError('Staff member not found')
    return _client_staff_safe(result.data[0], result.data[0].get('org_id'))

def _count_active_staff_for_branch(org_id: str, branch_id: str) -> int:
    sb = get_supabase()
    result = (
        sb.table('client_staff')
        .select('id', count='exact')
        .eq('org_id', str(org_id))
        .eq('branch_id', str(branch_id))
        .eq('is_archived', False)
        .neq('status', 'inactive')
        .execute()
    )
    return int(result.count or 0)


_SALARY_MIN = 1.0
_SALARY_MAX = 100_000_000.0


def _coerce_staff_salary(raw) -> float:
    """Coerce a per-employee salary within the supported PKR bounds.

    Base salary feeds payroll_engine as a positive figure that deductions
    subtract from. A negative inverts the whole period calculation, and
    because net_pay is floored at 0 (payroll_engine.py:244) the corruption
    is silent — the employee simply earns nothing, with no error raised.
    Deductions belong in leaveTypeRules/lateComingPolicy, never here.
    """
    if raw in (None, ''):
        return 0.0
    if isinstance(raw, bool):
        raise ValueError('salary must be a number')
    try:
        salary = float(raw)
    except (TypeError, ValueError):
        raise ValueError('salary must be a number')
    if salary != salary or salary in (float('inf'), float('-inf')):
        raise ValueError('salary must be a finite number')
    if salary < _SALARY_MIN:
        raise ValueError(f'salary must be at least {int(_SALARY_MIN)}')
    if salary > _SALARY_MAX:
        raise ValueError(f'salary cannot exceed {int(_SALARY_MAX)}')
    return salary


def create_client_staff(
    org_id: str,
    payload: dict,
    created_by: str | None = None,
    # Fail-closed by default: every legitimate caller (app.py's
    # api_add_staff) already passes this explicitly off the session's own
    # is_admin claim. A default of True would silently hand admin-grant
    # power to any future caller that forgets to pass it.
    granted_by_is_admin: bool = False,
) -> dict:
    from support_db_client_users import _assert_unique_client_staff_login_identifier, _assert_unique_client_staff_person_code, _hash_password, _person_code_from_payload, _person_code_label
    from support_db_organizations import get_organization
    sb = get_supabase()
    org_key = str(org_id)
    org = get_organization(org_key)
    if not _org_access_allows_client(org.get('status')):
        raise ValueError('Organization access is suspended. People cannot be added until billing is active.')

    branch, ui_branch_id = _resolve_client_branch(
        org_key,
        payload.get('branch_id')
        or payload.get('backend_branch_id')
        or payload.get('branchId')
        or payload.get('branchUiId')
        or payload.get('branch_ui_id'),
    )
    branch_id = str(branch['id'])
    capacity = int(branch.get('max_staff_capacity') or 0)
    if capacity > 0 and _count_active_staff_for_branch(org_key, branch_id) >= capacity:
        raise ValueError('Branch capacity limit reached. Please contact QIntellect to upgrade your plan.')

    # Raises ValueError (surfaced as a 400 by the route) on markup, SQL-shaped
    # payloads, digits, spreadsheet-formula prefixes and empty/oversized input.
    name = _validate_person_name(payload.get('name'), 'Name')

    incoming_role = payload.get('account_role') or payload.get('accountRole') or payload.get('role') or 'staff'
    account_role = _normalize_account_role(incoming_role, 'staff')
    if account_role == 'admin' and not granted_by_is_admin:
        raise ValueError('Only an existing admin can grant the admin role.')

    # Admin grant implies every module, always — enforced here (not just in
    # StaffManagement.tsx's picker) so the module checklist can never leave
    # an admin account under-provisioned, and so a client that posts
    # access_modules directly can't hand out the admin role without full
    # access, or full access without the admin role. Mirrors the frontend's
    # "Full dashboard access... every module" copy on the Admin Access
    # toggle.
    access_modules_value = payload.get('access_modules')
    if account_role == 'admin':
        from support_db_client_users import _active_client_modules
        access_modules_value = _active_client_modules(org_key)
    people_type = _normalize_people_type(
        payload.get('people_type')
        or payload.get('peopleType')
        or payload.get('person_type')
        or payload.get('personType')
        or (payload.get('role') if _normalize_people_type(payload.get('role')) not in CLIENT_STAFF_ACCOUNT_ROLES else None)
        or org.get('primary_people_type')
        or 'staff'
    )
    person_code = _person_code_from_payload(payload, people_type)
    _assert_unique_client_staff_person_code(
        org_id=org_key,
        branch_id=branch_id,
        people_type=people_type,
        person_code=person_code,
    )

    # Identity documents: CNIC for non-students, guardian details for
    # students. Required for every new person — raises ValueError (caught
    # by the route as a 400) if missing/malformed, same as the name check
    # above.
    identity_fields = _require_cnic_fields(people_type, payload)

    email = str(payload.get('email') or '').strip().lower() or None
    phone = str(payload.get('phone') or '').strip() or None
    _assert_unique_client_staff_login_identifier(email=email, phone=phone)

    raw_password = str(payload.get('password') or '').strip()
    password_hash = _hash_password(raw_password) if raw_password else None
    now = datetime.now(timezone.utc).isoformat()

    status = str(payload.get('status') or 'active').strip().lower()
    if status not in ('active', 'inactive', 'pending'):
        status = 'active'

    staff_type = payload.get('staff_type') if payload.get('staff_type') in ('office', 'field') else 'office'
    role_name = str(payload.get('position') or payload.get('role_name') or '').strip() or None

    insert_data = {
        'org_id': org_key,
        'branch_id': branch_id,
        'employee_id': person_code,
        'person_code': person_code,
        'person_code_label': _person_code_label(people_type),
        'registration_number': person_code if people_type == 'student' else None,
        'name': name,
        'email': email,
        'phone': phone,
        'password_hash': password_hash,
        'role': account_role,
        'department_name': str(payload.get('department') or payload.get('department_name') or '').strip() or None,
        'role_name': role_name,
        'position': role_name,
        'status': status,
        'salary': _coerce_staff_salary(payload.get('salary')),
        'benefits': _json_list(payload.get('benefits')),
        'join_date': payload.get('join_date') or None,
        'staff_type': staff_type,
        'access_modules': _json_list(access_modules_value),
        'shift_id': payload.get('shift_id'),
        'shift_label': payload.get('shift_label') or payload.get('shift'),
        'duty_start': payload.get('duty_start') or '09:00',
        'duty_end': payload.get('duty_end') or '17:00',
        'profile_image_url': payload.get('profile_image_url') or payload.get('profileImageUrl'),
        'profile_image_name': payload.get('profile_image_name') or payload.get('profileImageName'),
        'face_training_status': payload.get('face_training_status') or 'not_trained',
        'is_face_verified': bool(payload.get('is_face_verified', False)),
        # Field-staff assigned geofence (static-location scenario) — None
        # means "not configured," never silently defaulted to 0,0.
        'geofence_lat': _safe_float(payload.get('geofence_lat') or payload.get('geofenceLat')),
        'geofence_lng': _safe_float(payload.get('geofence_lng') or payload.get('geofenceLng')),
        'geofence_radius_meters': (
            int(payload['geofence_radius_meters']) if payload.get('geofence_radius_meters') not in (None, '')
            else int(payload['geofenceRadiusMeters']) if payload.get('geofenceRadiusMeters') not in (None, '')
            else 150
        ),
        'geofence_label': (str(payload.get('geofence_label') or payload.get('geofenceLabel') or '').strip() or None),
        # Office-staff WiFi — replaces the app's old hardcoded SSID/BSSID.
        'office_ssid': (str(payload.get('office_ssid') or payload.get('officeSsid') or '').strip() or None),
        'office_bssid': _json_list(payload.get('office_bssid') or payload.get('office_bssid_list') or payload.get('officeBssidList')),
        'created_by': created_by,
        'updated_at': now,
        **identity_fields,
    }

    if _client_staff_has_people_type_column():
        insert_data['people_type'] = people_type

    result = sb.table('client_staff').insert(insert_data).execute()
    if not result.data:
        raise RuntimeError('Failed to create person')

    row = result.data[0]
    safe = _client_staff_safe(row, org_key)
    safe['branch_ui_id'] = ui_branch_id
    safe['branchUiId'] = ui_branch_id
    return safe

def update_client_staff_own_password(staff_id: str, new_password: str) -> dict:
    """
    Self-service password change for a client_staff (manager/staff)
    Client Dashboard session — the client_staff counterpart to
    support_db_client_users.update_client_user_profile's password branch.
    Called only from support_db_client_users.change_own_dashboard_password,
    which resolves staff_id from the caller's own JWT — never from a
    client-supplied id.
 
    NOTE: client_staff has no must_change_password / password_changed_at
    columns today (unlike client_users — see create_client_staff's
    insert_data above, which never sets them). Only password_hash and
    updated_at are touched here. If first-login-forced-reset tracking is
    ever needed for client_staff, add those columns via migration first
    rather than silently writing to columns that don't exist.
    """
    from support_db_client_users import _hash_password, validate_strong_password

    new_password = str(new_password or '').strip()
    validate_strong_password(new_password)
 
    sb = get_supabase()
 
    existing = (
        sb.table('client_staff')
        .select('id, is_archived, status')
        .eq('id', str(staff_id))
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise ValueError('Staff account not found')
 
    row = existing.data[0]
    if row.get('is_archived') or str(row.get('status') or '').lower() == 'inactive':
        raise ValueError('This account is inactive')
 
    saved = (
        sb.table('client_staff')
        .update({
            'password_hash': _hash_password(new_password),
            'updated_at': datetime.now(timezone.utc).isoformat(),
        })
        .eq('id', str(staff_id))
        .execute()
    )
 
    if not saved.data:
        raise RuntimeError(
            f'Password update for client_staff {staff_id} returned no data. '
            'Verify the row exists and RLS policies allow updates.'
        )
 
    return {'id': str(staff_id)}

def update_client_staff(
    staff_id: str,
    payload: dict,
    # Fail-closed by default — see create_client_staff above for why.
    granted_by_is_admin: bool = False,
) -> dict:
    from support_db_client_users import _assert_unique_client_staff_login_identifier, _assert_unique_client_staff_person_code, _hash_password, _person_code_from_payload, _person_code_label
    sb = get_supabase()
    current = get_client_staff_member(str(staff_id))
    org_id = str(current['organization_id'])

    update_data: dict = {}
    field_map = {
        'name': 'name',
        'email': 'email',
        'phone': 'phone',
        'department': 'department_name',
        'department_name': 'department_name',
        'position': 'position',
        'role_name': 'role_name',
        'salary': 'salary',
        'join_date': 'join_date',
        'staff_type': 'staff_type',
        'status': 'status',
        'shift_id': 'shift_id',
        'shift_label': 'shift_label',
        'duty_start': 'duty_start',
        'duty_end': 'duty_end',
        'profile_image_url': 'profile_image_url',
        'profileImageUrl': 'profile_image_url',
        'profile_image_name': 'profile_image_name',
        'profileImageName': 'profile_image_name',
        'attendance_enabled': 'attendance_enabled',
        'is_face_verified': 'is_face_verified',
        'face_training_status': 'face_training_status',
        'geofence_lat': 'geofence_lat',
        'geofenceLat': 'geofence_lat',
        'geofence_lng': 'geofence_lng',
        'geofenceLng': 'geofence_lng',
        'geofence_radius_meters': 'geofence_radius_meters',
        'geofenceRadiusMeters': 'geofence_radius_meters',
        'geofence_label': 'geofence_label',
        'geofenceLabel': 'geofence_label',
        'office_ssid': 'office_ssid',
        'officeSsid': 'office_ssid',
        'office_bssid': 'office_bssid',
        'office_bssid_list': 'office_bssid',
        'officeBssidList': 'office_bssid',
        'cnic': 'cnic',
        'father_name': 'father_name',
        'fatherName': 'father_name',
        'father_cnic': 'father_cnic',
        'fatherCnic': 'father_cnic',
        'father_phone': 'father_phone',
        'fatherPhone': 'father_phone',
    }
    if _client_staff_has_people_type_column():
        field_map['people_type'] = 'people_type'
        field_map['peopleType'] = 'people_type'
        field_map['person_type'] = 'people_type'
        field_map['personType'] = 'people_type'

    for incoming, column in field_map.items():
        if incoming in payload:
            update_data[column] = payload.get(incoming)

    # The loop above copies payload values straight through, so before this
    # the update path was strictly weaker than create: create at least
    # rejected an empty name, update accepted anything at all — including the
    # markup and SQL-shaped strings create was meant to keep out. Anyone who
    # could edit a person could put back whatever create refused.
    #
    # Only validate keys the caller actually sent; a partial update that
    # doesn't touch a name must not fail because of a bad value already in
    # the row.
    for column, label in (
        ('name', 'Name'),
        ('father_name', "Father's name"),
    ):
        if column in update_data:
            update_data[column] = _validate_person_name(update_data[column], label)

    if 'role' in payload or 'account_role' in payload or 'accountRole' in payload:
        next_account_role = _normalize_account_role(
            payload.get('account_role')
            or payload.get('accountRole')
            or payload.get('role')
            or current.get('client_role')
            or 'staff',
            'staff',
        )
        already_admin = str(current.get('client_role') or '').strip().lower() == 'admin'
        if next_account_role == 'admin' and not already_admin and not granted_by_is_admin:
            raise ValueError('Only an existing admin can grant the admin role.')
        update_data['role'] = next_account_role

    next_people_type = _normalize_people_type(
        payload.get('people_type')
        or payload.get('peopleType')
        or payload.get('person_type')
        or payload.get('personType')
        or current.get('people_type')
        or current.get('peopleType')
        or 'staff'
    )
    if _client_staff_has_people_type_column() and (
        'people_type' in payload
        or 'peopleType' in payload
        or 'person_type' in payload
        or 'personType' in payload
    ):
        update_data['people_type'] = next_people_type

    if 'role_name' not in update_data and 'position' in update_data:
        update_data['role_name'] = update_data['position']
    if 'position' not in update_data and 'role_name' in update_data:
        update_data['position'] = update_data['role_name']

    if 'benefits' in payload:
        update_data['benefits'] = _json_list(payload.get('benefits'))
    if 'access_modules' in payload:
        update_data['access_modules'] = _json_list(payload.get('access_modules'))

    # Admin grant implies every module, always — see the matching comment
    # in create_client_staff. Covers both "just promoted to admin in this
    # request" and "already admin, some other field is being edited" (an
    # admin's access_modules must never drift narrower than the org's full
    # module set, no matter which field triggered this update).
    #
    # Admin grant also implies org/branch-wide row VISIBILITY, not just
    # module access. dashboard_scope ('team' vs 'branch') is a separate
    # axis from role ('staff' vs 'admin') — see get_team_scope_ids in
    # client_dashboard_auth.py, which filters every staff/attendance/leave
    # list down to a manager's own reports whenever dashboard_scope ==
    # 'team', regardless of role. Without this reset, someone promoted to
    # admin while still carrying dashboard_scope='team' from their old
    # manager account would get full account-management rights and every
    # module, but their own Staff Directory/Attendance/Leave views would
    # still be silently narrowed to their former reporting tree — "admin"
    # would not actually mean org-wide. Forcing 'branch' here (Supabase's
    # unscoped value, see get_team_scope_ids's None-means-no-restriction
    # contract) makes admin unambiguous: full access, full visibility, no
    # leftover scoping from whatever role they held before. A demotion
    # back to 'staff' is untouched here on purpose — that's a distinct
    # decision (see the "back to normal employee" module-fallback question)
    # and shouldn't be silently bundled into this block.
    effective_role = update_data.get('role', current.get('client_role'))
    if str(effective_role or '').strip().lower() == 'admin':
        from support_db_client_users import _active_client_modules
        update_data['access_modules'] = _active_client_modules(org_id)
        update_data['dashboard_scope'] = 'branch'

    next_branch_id = str(current.get('backend_branch_id') or current.get('branch_uuid') or '')
    raw_branch = payload.get('branch_id') or payload.get('backend_branch_id') or payload.get('branchId') or payload.get('branchUiId')
    if raw_branch not in (None, ''):
        branch, _ = _resolve_client_branch(org_id, raw_branch)
        resolved_branch_id = str(branch['id'])
        if resolved_branch_id != next_branch_id:
            capacity = int(branch.get('max_staff_capacity') or 0)
            if capacity > 0 and _count_active_staff_for_branch(org_id, resolved_branch_id) >= capacity:
                raise ValueError('Branch capacity limit reached. Please contact QIntellect to upgrade your plan.')
        next_branch_id = resolved_branch_id
        update_data['branch_id'] = next_branch_id

    code_keys = {
        'person_code',
        'personCode',
        'registration_number',
        'registrationNumber',
        'employee_number',
        'employeeNumber',
        'worker_id',
        'workerId',
        'teacher_code',
        'teacherCode',
        'employee_id',
    }
    person_code_changed = any(key in payload for key in code_keys)
    people_type_changed = any(key in payload for key in ('people_type', 'peopleType', 'person_type', 'personType'))
    branch_changed = 'branch_id' in update_data

    if person_code_changed or people_type_changed or branch_changed:
        next_person_code = _person_code_from_payload(
            payload,
            next_people_type,
            fallback=str(current.get('person_code') or current.get('personCode') or current.get('employee_id') or '').strip(),
        )
        _assert_unique_client_staff_person_code(
            org_id=org_id,
            branch_id=next_branch_id,
            people_type=next_people_type,
            person_code=next_person_code,
            exclude_staff_id=str(staff_id),
        )
        update_data['person_code'] = next_person_code
        update_data['employee_id'] = next_person_code
        update_data['person_code_label'] = _person_code_label(next_people_type)
        update_data['registration_number'] = next_person_code if next_people_type == 'student' else None

    if 'name' in update_data:
        update_data['name'] = str(update_data['name'] or '').strip()
        if not update_data['name']:
            raise ValueError('Name is required')
    if 'email' in update_data:
        email = str(update_data.get('email') or '').strip().lower()
        update_data['email'] = email or None
    if 'phone' in update_data:
        update_data['phone'] = str(update_data.get('phone') or '').strip() or None

    if 'email' in update_data or 'phone' in update_data:
        _assert_unique_client_staff_login_identifier(
            email=update_data.get('email') if 'email' in update_data else None,
            phone=update_data.get('phone') if 'phone' in update_data else None,
            exclude_staff_id=str(staff_id),
        )

    if 'salary' in update_data:
        update_data['salary'] = _coerce_staff_salary(update_data.get('salary'))
    if 'geofence_lat' in update_data:
        update_data['geofence_lat'] = _safe_float(update_data.get('geofence_lat'))
    if 'geofence_lng' in update_data:
        update_data['geofence_lng'] = _safe_float(update_data.get('geofence_lng'))
    if 'geofence_radius_meters' in update_data:
        radius = update_data.get('geofence_radius_meters')
        update_data['geofence_radius_meters'] = int(radius) if radius not in (None, '') else 150
    if 'geofence_label' in update_data:
        label = str(update_data.get('geofence_label') or '').strip()
        update_data['geofence_label'] = label or None
    if 'office_ssid' in update_data:
        ssid = str(update_data.get('office_ssid') or '').strip()
        update_data['office_ssid'] = ssid or None
    if 'office_bssid' in update_data:
        update_data['office_bssid'] = _json_list(update_data.get('office_bssid'))
    if 'staff_type' in update_data and update_data['staff_type'] not in ('office', 'field'):
        update_data['staff_type'] = 'office'
    if 'status' in update_data and update_data['status'] not in ('active', 'inactive', 'pending'):
        update_data['status'] = 'active'

    # Identity documents — validated only when actually being written
    # (partial updates are the norm here; a save that doesn't touch these
    # fields shouldn't be blocked by them). Format is checked the same way
    # as create_client_staff's _require_cnic_fields, but "required" isn't
    # re-enforced on every update -- an update that clears the field is
    # rejected by the not-blank check below rather than silently storing
    # an empty string, since these are always-required fields once a
    # record exists.
    if 'cnic' in update_data:
        cnic = str(update_data.get('cnic') or '').strip()
        if not cnic:
            raise ValueError('CNIC is required')
        if not _is_valid_cnic(cnic):
            raise ValueError('Enter a valid 13-digit CNIC (e.g. 42101-1234567-1)')
        update_data['cnic'] = cnic
    if 'father_name' in update_data:
        father_name = str(update_data.get('father_name') or '').strip()
        if not father_name:
            raise ValueError('Father name is required')
        update_data['father_name'] = father_name
    if 'father_phone' in update_data:
        father_phone = str(update_data.get('father_phone') or '').strip()
        if not father_phone:
            raise ValueError('Father number is required')
        update_data['father_phone'] = father_phone
    if 'father_cnic' in update_data:
        father_cnic = str(update_data.get('father_cnic') or '').strip()
        if not father_cnic:
            raise ValueError('Father CNIC is required')
        if not _is_valid_cnic(father_cnic):
            raise ValueError('Enter a valid 13-digit father CNIC (e.g. 42101-1234567-1)')
        update_data['father_cnic'] = father_cnic

    new_password = str(payload.get('password') or '').strip()
    password_reset = bool(new_password)
    if new_password:
        update_data['password_hash'] = _hash_password(new_password)

    if not update_data:
        return current

    update_data['updated_at'] = datetime.now(timezone.utc).isoformat()
    result = sb.table('client_staff').update(update_data).eq('id', str(staff_id)).execute()
    if not result.data:
        raise RuntimeError('Failed to update person')

    if password_reset:
        # An admin resetting someone else's password is the actual recovery
        # step for a hijacked/offboarded account -- without this, the reset
        # changes the password but leaves an already-authenticated
        # attacker's token valid for up to 12h (desktop) / 30d (mobile).
        # Kills BOTH surfaces this staff_id can hold a session on -- see
        # session_registry.end_all_client_staff_sessions's docstring for
        # why one hook isn't enough.
        import session_registry
        session_registry.end_all_client_staff_sessions(str(staff_id))

    return _client_staff_safe(result.data[0], org_id)

def archive_client_staff(staff_id: str, reason: str = 'Archived from Staff Management', archived_by: str | None = None) -> dict:
    sb = get_supabase()
    current = get_client_staff_member(str(staff_id))
    now = datetime.now(timezone.utc).isoformat()
    result = (
        sb.table('client_staff')
        .update({
            'is_archived': True,
            'status': 'inactive',
            'archived_at': now,
            'archived_by': archived_by,
            'archive_reason': reason,
            'attendance_enabled': False,
            'updated_at': now,
        })
        .eq('id', str(staff_id))
        .execute()
    )
    if not result.data:
        raise RuntimeError('Failed to archive staff member')
    return {
        'user_id': str(staff_id),
        'name': current.get('name'),
        'organization_id': current.get('organization_id'),
        'branch_id': current.get('backend_branch_id'),
        'deleted_embeddings': 0,
        'deleted_at': now,
        'retention_until': None,
    }

def restore_client_staff(staff_id: str, restored_by: str | None = None) -> dict:
    sb = get_supabase()
    now = datetime.now(timezone.utc).isoformat()
    result = (
        sb.table('client_staff')
        .update({
            'is_archived': False,
            'status': 'active',
            'archived_at': None,
            'archived_by': None,
            'archive_reason': None,
            'attendance_enabled': True,
            'is_face_verified': False,
            'face_training_status': 'not_trained',
            'updated_at': now,
        })
        .eq('id', str(staff_id))
        .execute()
    )
    if not result.data:
        raise ValueError('Archived staff member not found')
    row = _client_staff_safe(result.data[0], result.data[0].get('org_id'))
    return {
        'user_id': str(staff_id),
        'name': row.get('name'),
        'organization_id': row.get('organization_id'),
        'branch_id': row.get('backend_branch_id'),
        'restored_by': restored_by,
        'requires_training': True,
        'message': 'Employee restored. Biometric training is required again.',
    }

def delete_client_staff(staff_id: str) -> dict:
    sb = get_supabase()
    current = get_client_staff_member(str(staff_id))
    result = sb.table('client_staff').delete().eq('id', str(staff_id)).execute()
    if not result.data:
        raise ValueError('Archived staff member not found or cannot be permanently deleted')
    return {'deleted_user_id': str(staff_id), 'name': current.get('name')}

def update_client_staff_photo(staff_id: str, photo_url: str, filename: str) -> dict:
    return update_client_staff(str(staff_id), {
        'profile_image_url': photo_url,
        'profile_image_name': filename,
    })

def _normalize_employee_retention_years(value, default: int = 5) -> int:
    try:
        years = int(value)
    except (TypeError, ValueError):
        years = default
    return max(1, min(years, 10))

def get_employee_retention_policy(org_id: str) -> dict:
    """
    Return employee HR retention policy for a Supabase organization UUID.

    This is the Supabase-first counterpart of the legacy SQLite retention
    helpers. Client Dashboard data belongs in Supabase; Flask only mediates it.
    """
    from support_db_organizations import get_organization
    org = get_organization(str(org_id))
    years = _normalize_employee_retention_years(org.get('employee_retention_years'))

    return {
        'organization_id': str(org_id),
        'organization_name': org.get('name'),
        'employee_retention_years': years,
        'retention_policy_updated_at': org.get('retention_policy_updated_at'),
        'retention_policy_updated_by': org.get('retention_policy_updated_by'),
    }

def update_employee_retention_policy(
    org_id: str,
    employee_retention_years: int,
    updated_by: str | None = None,
) -> dict:
    """Persist employee HR retention policy on Supabase organizations."""
    from support_db_organizations import get_organization
    sb = get_supabase()
    get_organization(str(org_id))
    years = _normalize_employee_retention_years(employee_retention_years)
    now = datetime.now(timezone.utc).isoformat()

    payload = {
        'employee_retention_years': years,
        'retention_policy_updated_at': now,
    }

    if updated_by:
        payload['retention_policy_updated_by'] = str(updated_by)

    result = (
        sb.table('organizations')
        .update(payload)
        .eq('id', str(org_id))
        .execute()
    )

    if not result.data:
        raise ValueError(f'Organization {org_id} not found or policy update failed')

    return get_employee_retention_policy(str(org_id))