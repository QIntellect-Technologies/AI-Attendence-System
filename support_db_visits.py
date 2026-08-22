"""
support_db_visits.py
──────────────────────────────────────────────────────────────────────────────
Scenario 2 (Visit Plan / Beat Plan) -- the "activity layer" for field staff.

This module is deliberately independent of everything in support_db.py that
resolves the `attendance` table (mark_field_staff_attendance,
_resolve_client_staff_attendance_window, resolve_check_in_status, etc.).
That's on purpose: a visit plan answers "what did this person do today,"
never "was this person on duty" -- see mark_field_staff_attendance's own
docstring for why a field mark is never blocked by geofence status, which is
the same principle here in reverse -- visit compliance never blocks or
alters an attendance mark either.

Two entities:
  - VisitPlan / VisitPlanStop -- the "expected" list for the day. Either an
    admin or the employee can create/edit it (origin='admin'|'self'), and
    after creation either party can add/edit/remove stops. Stops are
    unordered -- display_order is cosmetic only, never validated.
  - Visit -- the actual event log. plan_stop_id set = a planned stop
    completed; plan_stop_id null = an unplanned/ad-hoc add. Both are always
    accepted -- see log_visit's docstring.

Geofence-per-stop follows the exact same trust boundary already established
for shift attendance (see support_db.evaluate_field_geofence /
geofence_service.dart): the distance-from-stop check happens ON-DEVICE, the
app sends the result, this module stores it as-is. It never blocks a visit
from being logged, only informs admin review.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional

from supabase_client import get_supabase
from logger_config import get_logger
import support_db_attendance_settings as capture_settings_db

logger = get_logger(__name__)

_VALID_EVIDENCE_MODES = ("gps_only", "gps_photo", "gps_photo_note")
_DEFAULT_EVIDENCE_MODE = "gps_only"
_DEFAULT_RADIUS_METERS = 150


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today_str() -> str:
    return date.today().isoformat()


def _require(value, field: str):
    if value is None or (isinstance(value, str) and not value.strip()):
        raise ValueError(f"{field} is required")
    return value


# Bounds for a visit-plan stop -- mirrors the frontend's VisitPlansTab.tsx
# maxLength={150} on location_label/purpose, so a direct API call can't
# bypass the same limit. lat/lng are real-world coordinate bounds (there is
# no legitimate stop outside them); radius_meters has no existing
# convention elsewhere in the codebase (client_staff.geofence_radius_meters
# is stored as a bare int() cast with no bounds either), so this picks a
# practical geofencing range: below 10m a GPS fix can't reliably tell
# "inside" from "outside" the stop, and above 5000m the radius stops
# meaning anything as a distinct-location check.
_LOCATION_LABEL_MAX_LENGTH = 150
_PURPOSE_MAX_LENGTH = 150
_LAT_MIN, _LAT_MAX = -90.0, 90.0
_LNG_MIN, _LNG_MAX = -180.0, 180.0
_RADIUS_MIN_METERS, _RADIUS_MAX_METERS = 10, 5000


def _clean_stop_text(value: object, field: str, max_length: int, *, required: bool) -> Optional[str]:
    text = str(value).strip() if value is not None else ""
    if not text:
        if required:
            raise ValueError(f"{field} is required")
        return None
    if len(text) > max_length:
        raise ValueError(f"{field} must be {max_length} characters or fewer")
    return text


def _clean_stop_coordinate(value: object, field: str, low: float, high: float) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number")
    if num != num or num in (float("inf"), float("-inf")):
        raise ValueError(f"{field} must be a finite number")
    if not (low <= num <= high):
        raise ValueError(f"{field} must be between {low} and {high}")
    return num


def _clean_stop_radius(value: object) -> int:
    if value in (None, ""):
        return _DEFAULT_RADIUS_METERS
    try:
        radius = int(float(value))
    except (TypeError, ValueError):
        raise ValueError("radius_meters must be a number")
    if not (_RADIUS_MIN_METERS <= radius <= _RADIUS_MAX_METERS):
        raise ValueError(
            f"radius_meters must be between {_RADIUS_MIN_METERS} and {_RADIUS_MAX_METERS}"
        )
    return radius


def _validate_stop_payload(payload: dict, *, partial: bool) -> dict:
    """Clean + validate the stop fields present in `payload`.

    partial=False (add_stop): location_label and lat/lng are required.
    partial=True (update_stop): only the keys actually present are
    validated/returned -- a PATCH that doesn't touch lat shouldn't need to
    resend it, but any lat it DOES send still has to be a real latitude.
    Previously update_stop wrote every whitelisted key straight through
    with no validation at all, so a PATCH could set lat=9999,
    radius_meters=-1, or a multi-kilobyte location_label with no pushback.
    """
    cleaned: dict = {}

    if not partial or "location_label" in payload:
        cleaned["location_label"] = _clean_stop_text(
            payload.get("location_label"), "location_label",
            _LOCATION_LABEL_MAX_LENGTH, required=not partial,
        )

    lat_present = "lat" in payload or "latitude" in payload
    lng_present = "lng" in payload or "longitude" in payload
    if not partial or lat_present:
        lat = payload.get("lat", payload.get("latitude"))
        if lat is None and not partial:
            raise ValueError("lat/lng are required")
        if lat is not None:
            cleaned["lat"] = _clean_stop_coordinate(lat, "lat", _LAT_MIN, _LAT_MAX)
    if not partial or lng_present:
        lng = payload.get("lng", payload.get("longitude"))
        if lng is None and not partial:
            raise ValueError("lat/lng are required")
        if lng is not None:
            cleaned["lng"] = _clean_stop_coordinate(lng, "lng", _LNG_MIN, _LNG_MAX)

    if not partial or "radius_meters" in payload:
        cleaned["radius_meters"] = _clean_stop_radius(payload.get("radius_meters"))

    if not partial or "purpose" in payload:
        cleaned["purpose"] = _clean_stop_text(
            payload.get("purpose"), "purpose", _PURPOSE_MAX_LENGTH, required=False,
        )

    return cleaned


# ─── Evidence settings (branch + people_type baseline) ─────────────────────
#
# Not a separate table -- visit_evidence_mode lives directly on
# attendance_capture_settings (see support_db_attendance_settings.py's
# upsert_capture_settings), the same branch+people_type row every other
# field-staff capture rule already lives on. Admins set it through the
# existing PATCH /api/client/branches/<branch_id>/capture-settings/<people_type>
# route (client_attendance_settings_routes.py) -- no new admin route needed,
# just pass visit_evidence_mode in that payload alongside mode/
# capture_check_out. These two functions exist only so the mobile-facing
# code in this module doesn't need to import and know about capture_settings
# rows directly.

def get_visit_evidence_mode(org_id: str, branch_id: Optional[str], people_type: str) -> str:
    """Resolve which evidence a stop check-in requires for this person.
    Requires a real branch_id -- attendance_capture_settings has no
    org-wide-default row concept (see require_specific_branch), matching
    every other setting on this table."""
    if not branch_id:
        return _DEFAULT_EVIDENCE_MODE
    settings = capture_settings_db.get_capture_settings(org_id, str(branch_id), people_type)
    if not settings:
        return _DEFAULT_EVIDENCE_MODE
    return settings.get("visit_evidence_mode") or _DEFAULT_EVIDENCE_MODE


# ─── Visit Plans ─────────────────────────────────────────────────────────

def get_or_create_plan(
    org_id: str,
    branch_id: Optional[str],
    staff_id: str,
    plan_date: str,
    *,
    created_by: Optional[str] = None,
    created_by_role: str = "self",
) -> dict:
    """Fetch today's (or any date's) plan for a staff member, creating an
    empty one on first touch. Both admin and employee call this same
    function -- created_by_role just records who actually caused the
    plan row to first exist; it does not gate who can add stops to it
    afterward (see add_stop)."""
    sb = get_supabase()
    org_key, staff_key = str(org_id), str(staff_id)

    existing = (
        sb.table("visit_plans")
        .select("*")
        .eq("org_id", org_key)
        .eq("staff_id", staff_key)
        .eq("plan_date", plan_date)
        .limit(1)
        .execute()
    )
    if existing.data:
        return existing.data[0]

    row = {
        "org_id": org_key,
        "branch_id": str(branch_id) if branch_id else None,
        "staff_id": staff_key,
        "plan_date": plan_date,
        "origin": created_by_role if created_by_role in ("admin", "self") else "self",
        "created_by": str(created_by) if created_by else None,
        "created_by_role": created_by_role,
    }
    try:
        result = sb.table("visit_plans").insert(row).execute()
    except Exception as exc:
        logger.error("get_or_create_plan insert failed org=%s staff=%s: %s", org_key, staff_key, exc)
        raise RuntimeError("Failed to create visit plan") from exc
    if not result.data:
        raise RuntimeError("Failed to create visit plan")
    return result.data[0]


def get_plan_raw(org_id: str, staff_id: str, plan_date: str) -> dict:
    """The single call the mobile app's Visits tab and the admin dashboard
    both use: plan + its stops + that day's visits, in one round trip
    instead of three separate ones.

    Deliberately returns RAW rows only -- no per-stop status, no computed
    summary. That computation (which stop is completed/pending, how many
    planned/completed/skipped/unplanned) is pure function-of-already-fetched-
    data with no security relevance, so it belongs on the client, the same
    way geofence-distance evaluation moved to GeofenceService.evaluateGeofence
    instead of being recomputed server-side on every check. Doing it here
    too would mean paying for the same set-diff on every poll of a screen
    that's likely to auto-refresh. See visit_plan_service.dart's
    computeSummary/computeStopStatuses for the on-device mirror of this
    contract -- keep the two in sync if the shape of a stop/visit ever
    changes.

    Returns:
        { 'plan': {...} | None, 'stops': [...], 'visits': [...] }

    'plan' is None when nothing has been created yet for this staff/date --
    callers should treat that as "no plan," not an error.
    """
    sb = get_supabase()
    org_key, staff_key = str(org_id), str(staff_id)

    plan_result = (
        sb.table("visit_plans")
        .select("*")
        .eq("org_id", org_key)
        .eq("staff_id", staff_key)
        .eq("plan_date", plan_date)
        .limit(1)
        .execute()
    )
    plan = plan_result.data[0] if plan_result.data else None

    if not plan:
        return {"plan": None, "stops": [], "visits": []}

    stops_result = (
        sb.table("visit_plan_stops")
        .select("*")
        .eq("plan_id", plan["id"])
        .eq("is_deleted", False)
        .order("display_order")
        .execute()
    )

    day_start = f"{plan_date}T00:00:00+00:00"
    day_end = f"{plan_date}T23:59:59.999999+00:00"
    visits_result = (
        sb.table("visits")
        .select("*")
        .eq("org_id", org_key)
        .eq("staff_id", staff_key)
        .gte("timestamp", day_start)
        .lte("timestamp", day_end)
        .order("timestamp")
        .execute()
    )

    return {
        "plan": plan,
        "stops": stops_result.data or [],
        "visits": visits_result.data or [],
    }


def get_staff_visit_plans_range(
    org_id: str,
    staff_id: str,
    start_date: str,
    end_date: str,
) -> list[dict]:
    """Admin dashboard History view (client_visit_plans_routes.py's
    /visit-plans-history) and the mobile app's own History tab -- every
    day in [start_date, end_date] this staff member has a plan and/or at
    least one logged visit, newest first. Each entry is shaped exactly
    like get_plan_raw's return value ({'date', 'plan', 'stops', 'visits'})
    so computeVisitPlanSummary/computeStopVerification (staffApi.ts) and
    VisitPlanService.computeStopStatuses/computeSummary
    (visit_plan_service.dart) run per-day unmodified -- same contract
    get_plan_raw already established for a single day, just one more key
    (`date`) wrapping it.

    Three queries for the WHOLE range, not one get_plan_raw call per day
    -- a full month's History view costs the same handful of round trips
    regardless of range length, the same "one round trip instead of
    three" reasoning get_plan_raw's own docstring gives for a single day,
    applied again here so it doesn't regress back to N+1 once dates are
    involved.

    A day is included only if it has a plan and/or a visit -- empty days
    in the range are omitted rather than padded in with empty entries,
    since there's nothing there for either client to render (a day that
    IS included but has zero stops/visits -- a plan created with no
    activity yet -- is a different, already-handled case; see
    VisitPlansTab.tsx's "Nothing logged this day" branch).
    """
    sb = get_supabase()
    org_key, staff_key = str(org_id), str(staff_id)

    plans_result = (
        sb.table("visit_plans")
        .select("*")
        .eq("org_id", org_key)
        .eq("staff_id", staff_key)
        .gte("plan_date", start_date)
        .lte("plan_date", end_date)
        .execute()
    )
    plans_by_date: dict[str, dict] = {
        p["plan_date"]: p for p in (plans_result.data or [])
    }

    stops_by_plan_id: dict[str, list[dict]] = {}
    plan_ids = [p["id"] for p in plans_by_date.values()]
    if plan_ids:
        stops_result = (
            sb.table("visit_plan_stops")
            .select("*")
            .in_("plan_id", plan_ids)
            .eq("is_deleted", False)
            .order("display_order")
            .execute()
        )
        for stop in stops_result.data or []:
            stops_by_plan_id.setdefault(stop["plan_id"], []).append(stop)

    # Same day_start/day_end-as-ISO-bounds pattern get_plan_raw uses for a
    # single day, just spanning the whole requested range in one query.
    day_start = f"{start_date}T00:00:00+00:00"
    day_end = f"{end_date}T23:59:59.999999+00:00"
    visits_result = (
        sb.table("visits")
        .select("*")
        .eq("org_id", org_key)
        .eq("staff_id", staff_key)
        .gte("timestamp", day_start)
        .lte("timestamp", day_end)
        .order("timestamp")
        .execute()
    )
    visits_by_date: dict[str, list[dict]] = {}
    for visit in visits_result.data or []:
        visit_date = str(visit["timestamp"])[:10]
        visits_by_date.setdefault(visit_date, []).append(visit)

    all_dates = set(plans_by_date) | set(visits_by_date)
    days = []
    for day in sorted(all_dates, reverse=True):
        plan = plans_by_date.get(day)
        stops = stops_by_plan_id.get(plan["id"], []) if plan else []
        days.append({
            "date": day,
            "plan": plan,
            "stops": stops,
            "visits": visits_by_date.get(day, []),
        })
    return days


def list_plans_for_branch(org_id: str, branch_id: Optional[str], plan_date: str) -> list[dict]:
    """Admin dashboard view: every staff member's plan (if any) for one day
    on one branch, for a roster-style compliance overview."""
    sb = get_supabase()
    query = (
        get_supabase()
        .table("visit_plans")
        .select("*")
        .eq("org_id", str(org_id))
        .eq("plan_date", plan_date)
    )
    if branch_id:
        query = query.eq("branch_id", str(branch_id))
    result = query.execute()
    return result.data or []


# ─── Plan Stops ─────────────────────────────────────────────────────────

def add_stop(
    org_id: str,
    plan_id: str,
    payload: dict,
    *,
    created_by: Optional[str] = None,
    created_by_role: str = "self",
) -> dict:
    """Add a stop to an existing plan. Callable by admin or employee alike
    -- there is no ownership check beyond org_id, matching the "either
    party can edit" decision. Validate the plan belongs to this org before
    writing, so a staff JWT from org A can't append a stop to org B's plan
    by guessing a plan_id.

    `payload["client_action_id"]` (optional): idempotency key from the
    mobile offline queue. If a stop with this id already exists (a queued
    "add stop" that actually succeeded before the phone lost the
    response, then got retried), returns that existing row instead of
    inserting a visible duplicate stop.
    """
    sb = get_supabase()
    plan = (
        sb.table("visit_plans")
        .select("id, org_id")
        .eq("id", str(plan_id))
        .limit(1)
        .execute()
    )
    if not plan.data or str(plan.data[0]["org_id"]) != str(org_id):
        raise ValueError("Visit plan not found for this organization")

    client_action_id = payload.get("client_action_id")
    if client_action_id:
        existing = (
            sb.table("visit_plan_stops")
            .select("*")
            .eq("client_action_id", str(client_action_id))
            .limit(1)
            .execute()
        )
        if existing.data:
            return existing.data[0]

    _require(payload.get("location_label"), "location_label")
    lat = payload.get("lat", payload.get("latitude"))
    lng = payload.get("lng", payload.get("longitude"))
    if lat is None or lng is None:
        raise ValueError("lat/lng are required")

    row = {
        "plan_id": str(plan_id),
        "location_label": str(payload["location_label"]).strip(),
        "lat": float(lat),
        "lng": float(lng),
        "radius_meters": int(payload.get("radius_meters") or _DEFAULT_RADIUS_METERS),
        "purpose": payload.get("purpose"),
        "window_start": payload.get("window_start"),
        "window_end": payload.get("window_end"),
        "display_order": int(payload.get("display_order") or 0),
        "created_by": str(created_by) if created_by else None,
        "created_by_role": created_by_role,
        "client_action_id": str(client_action_id) if client_action_id else None,
    }
    try:
        result = sb.table("visit_plan_stops").insert(row).execute()
    except Exception as exc:
        logger.error("add_stop insert failed plan=%s: %s", plan_id, exc)
        raise RuntimeError("Failed to add stop") from exc
    if not result.data:
        raise RuntimeError("Failed to add stop")
    return result.data[0]


def update_stop(org_id: str, stop_id: str, payload: dict) -> dict:
    sb = get_supabase()
    existing = (
        sb.table("visit_plan_stops")
        .select("id, plan_id, visit_plans!inner(org_id)")
        .eq("id", str(stop_id))
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise ValueError("Stop not found")

    updatable_fields = (
        "location_label", "lat", "lng", "radius_meters",
        "purpose", "window_start", "window_end", "display_order",
    )
    update_payload = {k: payload[k] for k in updatable_fields if k in payload}
    if not update_payload:
        return existing.data[0]
    update_payload["updated_at"] = _iso_now()

    result = (
        sb.table("visit_plan_stops")
        .update(update_payload)
        .eq("id", str(stop_id))
        .execute()
    )
    if not result.data:
        raise RuntimeError("Failed to update stop")
    return result.data[0]


def remove_stop(org_id: str, stop_id: str) -> None:
    """Soft delete -- see visit_plan_stops.is_deleted's column comment for
    why a hard delete would corrupt that day's compliance history."""
    sb = get_supabase()
    sb.table("visit_plan_stops").update(
        {"is_deleted": True, "updated_at": _iso_now()}
    ).eq("id", str(stop_id)).execute()


# ─── Visits (the event log) ────────────────────────────────────────────

def log_visit(
    org_id: str,
    branch_id: Optional[str],
    staff_id: str,
    *,
    latitude: float,
    longitude: float,
    plan_stop_id: Optional[str] = None,
    distance_from_stop_meters: Optional[float] = None,
    photo_url: Optional[str] = None,
    note: Optional[str] = None,
    evidence_mode_recorded: str = _DEFAULT_EVIDENCE_MODE,
    source: str = "mobile_field",
    client_action_id: Optional[str] = None,
) -> dict:
    """Record one visit -- planned (plan_stop_id set) or unplanned (None).

    Always accepted. There is no server-side gate here on distance, photo
    presence, or anything else -- evidence-mode enforcement (is a photo
    required?) is a CLIENT-side UX decision (the app disables the Log
    Visit button until required fields are filled), exactly the same
    trust boundary as geofence/WiFi elsewhere in this codebase. This
    function's job is to store what happened, not to referee it -- a
    manager reviewing "visits with no photo despite gps_photo being
    required" is a dashboard query against evidence_mode_recorded, not a
    write-time rejection that could strand a legitimate visit if a
    photo upload failed on a bad connection.

    If plan_stop_id is provided, its org is checked against org_id so a
    staff JWT can't attribute a visit to another org's stop.

    `client_action_id` (optional): idempotency key from the mobile
    offline queue. If a visit already exists under this id, returns it
    unchanged instead of inserting a duplicate -- the offline queue may
    retry an action whose response never made it back to the phone, and
    without this a flaky connection could double-log the same stop visit.
    """
    sb = get_supabase()
    org_key, staff_key = str(org_id), str(staff_id)

    if client_action_id:
        existing = (
            sb.table("visits")
            .select("*")
            .eq("client_action_id", str(client_action_id))
            .limit(1)
            .execute()
        )
        if existing.data:
            return existing.data[0]

    if plan_stop_id:
        stop = (
            sb.table("visit_plan_stops")
            .select("id, visit_plans!inner(org_id, staff_id)")
            .eq("id", str(plan_stop_id))
            .limit(1)
            .execute()
        )
        if not stop.data:
            raise ValueError("Plan stop not found")
        plan_ref = stop.data[0]["visit_plans"]
        if str(plan_ref["org_id"]) != org_key or str(plan_ref["staff_id"]) != staff_key:
            raise ValueError("Plan stop does not belong to this staff member")

    row = {
        "org_id": org_key,
        "branch_id": str(branch_id) if branch_id else None,
        "staff_id": staff_key,
        "plan_stop_id": str(plan_stop_id) if plan_stop_id else None,
        "latitude": float(latitude),
        "longitude": float(longitude),
        "distance_from_stop_meters": (
            float(distance_from_stop_meters) if distance_from_stop_meters is not None else None
        ),
        "photo_url": photo_url,
        "note": note,
        "evidence_mode_recorded": evidence_mode_recorded,
        "source": source,
        "client_action_id": str(client_action_id) if client_action_id else None,
    }
    try:
        result = sb.table("visits").insert(row).execute()
    except Exception as exc:
        logger.error("log_visit insert failed org=%s staff=%s: %s", org_key, staff_key, exc)
        raise RuntimeError("Failed to log visit") from exc
    if not result.data:
        raise RuntimeError("Failed to log visit")
    return result.data[0]


def check_out_visit(
    org_id: str,
    staff_id: str,
    visit_id: str,
    *,
    latitude: float,
    longitude: float,
    client_action_id: Optional[str] = None,
) -> dict:
    """Closes out a visit that was opened by log_visit -- the "leaving the
    stop" half of check-in/check-out at a single location, mirroring how
    shift attendance has a check-in mark and a check-out mark rather than
    one instantaneous punch. Duration is never stored -- it's `timestamp`
    (check-in) to `checked_out_at` (check-out), computed on read the same
    way the roster/detail panel already compute compliance client-side
    (see VisitPlanService.computeStopStatuses's on-device mirror) -- so an
    admin correcting either timestamp later (see update_visit) always
    yields a consistent duration without a second write.

    Ownership is checked the same way log_visit checks a plan_stop_id's
    org/staff: a staff JWT can't check out another staff member's visit.

    `client_action_id` (optional): idempotency key from the mobile
    offline queue, stored in a SEPARATE column from log_visit's
    client_action_id (that one marks the check-in write; this one marks
    the check-out write -- the same visit row goes through both). If this
    exact checkout was already applied under this id, returns the current
    row instead of raising "already checked out" -- a queued checkout
    retried after its response was lost must not look like an error.
    Checking out an already-checked-out visit under a DIFFERENT (or no)
    client_action_id is still rejected, so a genuine double-tap can't
    quietly overwrite the first checkout's timestamp.
    """
    sb = get_supabase()
    org_key, staff_key, visit_key = str(org_id), str(staff_id), str(visit_id)

    existing = (
        sb.table("visits")
        .select("id, org_id, staff_id, checked_out_at, checkout_client_action_id")
        .eq("id", visit_key)
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise ValueError("Visit not found")
    row = existing.data[0]
    if str(row["org_id"]) != org_key or str(row["staff_id"]) != staff_key:
        raise ValueError("Visit does not belong to this staff member")

    if row.get("checked_out_at"):
        if client_action_id and row.get("checkout_client_action_id") == client_action_id:
            return row
        raise ValueError("Visit is already checked out")

    update_payload = {
        "checked_out_at": _iso_now(),
        "checkout_latitude": float(latitude),
        "checkout_longitude": float(longitude),
        "checkout_client_action_id": str(client_action_id) if client_action_id else None,
    }
    try:
        result = sb.table("visits").update(update_payload).eq("id", visit_key).execute()
    except Exception as exc:
        logger.error("check_out_visit failed org=%s visit=%s: %s", org_key, visit_key, exc)
        raise RuntimeError("Failed to check out visit") from exc
    if not result.data:
        raise RuntimeError("Failed to check out visit")
    return result.data[0]


def update_visit(org_id: str, visit_id: str, payload: dict) -> dict:
    """Admin correction path -- edits check-in time (`timestamp`),
    check-out time (`checked_out_at`), and/or `note` on an existing visit.
    Mirrors update_stop's shape (fetch-scoped-by-org, whitelist fields,
    partial update). This is the "regularization" concept discussed for
    shift attendance, applied here instead: GPS failed, the field rep
    logged the visit late, or a manager wants to correct an obviously
    wrong timestamp -- rather than the visit being stuck wrong forever
    with no correction path.

    Rejects a check-out earlier than check-in so a typo can't produce a
    negative/nonsensical duration; every other correction is accepted
    without further gating, same trust level as update_stop.
    """
    sb = get_supabase()
    org_key, visit_key = str(org_id), str(visit_id)

    existing = (
        sb.table("visits")
        .select("id, org_id, timestamp, checked_out_at")
        .eq("id", visit_key)
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise ValueError("Visit not found")
    if str(existing.data[0]["org_id"]) != org_key:
        raise ValueError("Visit does not belong to this organization")

    update_payload: dict = {}
    if "timestamp" in payload and payload["timestamp"]:
        update_payload["timestamp"] = payload["timestamp"]
    if "checked_out_at" in payload:
        update_payload["checked_out_at"] = payload["checked_out_at"] or None
    if "note" in payload:
        update_payload["note"] = payload["note"]

    if not update_payload:
        return existing.data[0]

    check_in = update_payload.get("timestamp", existing.data[0]["timestamp"])
    check_out = update_payload.get("checked_out_at", existing.data[0].get("checked_out_at"))
    if check_in and check_out and str(check_out) < str(check_in):
        raise ValueError("Check-out time cannot be before check-in time")

    result = sb.table("visits").update(update_payload).eq("id", visit_key).execute()
    if not result.data:
        raise RuntimeError("Failed to update visit")
    return result.data[0]


def get_staff_visit_history(org_id: str, staff_id: str, *, limit: int = 100) -> list[dict]:
    """Own visit history for the mobile app -- mirrors
    get_client_staff_attendance_history's per-staff isolation shape."""
    sb = get_supabase()
    result = (
        sb.table("visits")
        .select("*")
        .eq("org_id", str(org_id))
        .eq("staff_id", str(staff_id))
        .order("timestamp", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data or []