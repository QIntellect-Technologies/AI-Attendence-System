"""
client_field_attendance_routes.py
──────────────────────────────────────────────────────────────────────────────
Mobile self-service attendance for FIELD staff (client_staff rows with
staff_type='field') — the geofence counterpart of
client_staff_attendance_routes.py's office/WiFi flow.

Writes into the same Supabase `attendance` table the Client Dashboard reads,
tagged source='mobile_field' (or 'mobile_fallback' for a delayed offline
sync), so a field check-in shows up on the dashboard immediately, distinct
from an office WiFi mark, with the geofence evaluation (inside/distance/
radius/configured) folded into metadata for admin review.

Previously the app called /api/attendance/check-geofence and
/api/field/geo-alert (geofence_service.dart) and /api/field/mark-attendance,
/api/field/attendance-logs (api_service.dart) — none of which existed as
routes; every field attendance attempt was silently hitting a 404 and the
app's local fallback logic. This blueprint is the actual fix. Register it
in app.py alongside client_staff_attendance_bp.

Geofence evaluation itself runs on-device (GeofenceService.evaluateGeofence
in the Flutter app, mirroring support_db.evaluate_field_geofence's exact
contract) against config already pushed to the app at login — the same
trust boundary this module already uses for office WiFi (wifi_verified in
client_staff_attendance_routes.py is likewise computed on-device and taken
as-is). mark-attendance below stores what the device computed instead of
re-fetching the staff row and recomputing the distance server-side on
every mark; /check-geofence is kept only as an unused-by-the-app fallback.

Face verification (verify-face below) is the one check in this flow that
does NOT move client-side: face_verification_screen.dart posts a single
still frame and this route runs the actual match against the caller's own
enrolled embeddings (face_embeddings_cloud) server-side, then returns
verified true/false. Unlike geofence/WiFi, this is the signal that exists
specifically to stop one person marking attendance for another, so the
match decision has to live somewhere the device itself can't assert it
away. The app previously posted to /api/attendance/verify-face, which
never existed as a route either — fixed to /api/field/verify-face to sit
alongside this blueprint's other field-staff endpoints.
"""
from __future__ import annotations

import base64

import numpy as np
from flask import Blueprint, request, g

from client_staff_auth import require_client_staff_auth
from client_routes_helpers import ok, handle
import support_db as support_cp_db
from shared_face_engine import detect_and_extract, compute_aggregate_embedding, compare_embeddings
from shared_face_engine.spoof import detect_spoofing
from config import MODELS_DIR, FACE_DETECTION_CONFIDENCE, FACE_MATCHING_THRESHOLD, ANTI_SPOOFING_ENABLED

client_field_attendance_bp = Blueprint(
    "client_field_attendance", __name__, url_prefix="/api/field"
)


def _decode_face_image(payload: dict):
    """Decode the base64 still frame face_verification_screen.dart's
    _verify sends into an OpenCV BGR frame, or None if unusable.

    Deliberately tolerant of a "data:image/jpeg;base64,..." prefix even
    though the current app doesn't send one -- cheap to accept, and
    matches how the web dashboard's own image inputs already have to
    handle both forms.
    """
    raw = payload.get("image")
    if not raw or not isinstance(raw, str):
        return None
    if raw.strip().lower().startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        image_bytes = base64.b64decode(raw, validate=False)
    except Exception:
        return None
    if not image_bytes:
        return None

    import cv2  # local import, mirrors app.py's recognize_face_frame

    nparr = np.frombuffer(image_bytes, np.uint8)
    return cv2.imdecode(nparr, cv2.IMREAD_COLOR)


def _require_lat_lng(payload: dict) -> tuple[float, float]:
    lat = payload.get("latitude", payload.get("lat"))
    lng = payload.get("longitude", payload.get("lng"))
    if lat is None or lng is None:
        raise ValueError("latitude/longitude are required")
    try:
        return float(lat), float(lng)
    except (TypeError, ValueError):
        raise ValueError("latitude/longitude must be numbers")


def _sanitize_geofence(payload: dict) -> dict:
    """Shape the on-device geofence evaluation for storage.

    Geofence evaluation now happens on-device (GeofenceService.
    evaluateGeofence in the app, against the geofence_lat/geofence_lng/
    geofence_radius_meters/geofence_label already pushed to the app at
    login via /api/staff/me) instead of here -- this route used to call
    support_db.evaluate_field_geofence itself on every mark, which meant
    re-fetching the staff row and recomputing the haversine distance
    server-side even though the app had just done the same math to show
    the employee their own status. That's a deliberate trust boundary,
    the same one this app already uses for office WiFi (mark_attendance
    below takes wifi_verified from the client body as-is, no server-side
    recheck). A mark is never blocked by geofence status either way (see
    mark_field_staff_attendance's docstring) -- this just validates the
    shape so a missing/malformed payload can't 500 the mark, and always
    records *something* even if the app sent nothing.
    """
    raw = payload.get("geofence")
    if not isinstance(raw, dict):
        return {"configured": False, "inside": False, "distance": 0.0, "radius": None, "label": None}

    def _num(value):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    label = raw.get("label")
    return {
        "configured": bool(raw.get("configured")),
        "inside": bool(raw.get("inside")),
        "distance": _num(raw.get("distance")) or 0.0,
        "radius": _num(raw.get("radius")),
        "label": str(label).strip() or None if label is not None else None,
    }


@client_field_attendance_bp.route("/check-geofence", methods=["POST"])
@require_client_staff_auth
def check_geofence():
    """
    Body: { "latitude": float, "longitude": float }

    The mobile app no longer calls this route on its attendance path —
    it evaluates the geofence on-device instead (GeofenceService.
    evaluateGeofence, mirroring evaluate_field_geofence's exact contract)
    using the config already pushed to it at login, so it doesn't need a
    server round trip just to preview its own status. This route is kept
    for any other caller (e.g. a future admin-side preview) that still
    wants the server-computed answer; it costs nothing while unused.

    staff_id/org_id come from g.client_staff (verified JWT), never the
    request body — a mobile client can't check (or spoof) another staff
    member's geofence by editing user_id, because there is no such field
    read here.

    Returns { configured, inside, distance, radius, label } — see
    support_db.evaluate_field_geofence's docstring for what `configured`
    means and why it matters.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        lat, lng = _require_lat_lng(payload)
        result = support_cp_db.evaluate_field_geofence(
            org_id=g.client_staff["org_id"],
            staff_id=g.client_staff["id"],
            latitude=lat,
            longitude=lng,
        )
        return ok(result)

    return handle(_run)


@client_field_attendance_bp.route("/verify-face", methods=["POST"])
@require_client_staff_auth
def verify_face():
    """
    Body: { "image": "<base64 JPEG/PNG still frame>" }

    1:1 verification, not 1:N identification — the frame is only ever
    compared against embeddings already enrolled for the CALLER
    (g.client_staff, from the verified JWT). staff_id/user_id in the
    request body (face_verification_screen.dart still sends one) is
    ignored on purpose: a mobile client can't verify against, or spoof a
    match for, anyone but themselves, because there is no code path here
    that reads an id out of the body.

    Unlike geofence/WiFi (see this module's header), this decision stays
    server-side: it's the one signal here that exists specifically to
    stop one person marking attendance for another, so a client-asserted
    boolean would defeat its own purpose.

    Enrollment is unchanged — still the video-upload -> face_training_job
    pipeline (/api/enroll/upload-video), which populates the same
    face_embeddings_cloud rows this reads via
    support_db.get_staff_face_embeddings. This route never enrolls or
    overwrites anything, only compares.

    Returns { verified: bool, similarity: float, message: str }. Always
    200 with verified=false for "no face"/"no match"/"not enrolled" —
    those are normal outcomes for the app to show and retry, not server
    errors.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = g.client_staff["org_id"]
        staff_id = g.client_staff["id"]

        frame = _decode_face_image(payload)
        if frame is None:
            return ok({"verified": False, "message": "No usable image was received."})

        face_results = detect_and_extract(frame, MODELS_DIR, min_confidence=FACE_DETECTION_CONFIDENCE)
        if not face_results:
            return ok({"verified": False, "message": "No face detected. Try again with better lighting."})

        # Self-portrait, so take the largest detected face rather than the
        # first one returned — keeps a second person visible in the
        # background from accidentally becoming "the" face compared.
        def _bbox_area(face: dict) -> float:
            x1, y1, x2, y2 = face["bbox"]
            return max(0.0, x2 - x1) * max(0.0, y2 - y1)

        face = max(face_results, key=_bbox_area)
        test_embedding = face.get("embedding")
        if test_embedding is None:
            return ok({"verified": False, "message": "Could not read a usable face from that image."})

        bbox = tuple(int(v) for v in face["bbox"])
        spoof_info = detect_spoofing(frame, bbox, enabled=ANTI_SPOOFING_ENABLED)
        if spoof_info.get("is_spoof"):
            return ok({
                "verified": False,
                "message": "That looked like a photo of a photo/screen, not a live face. Try again.",
            })

        stored_vectors = support_cp_db.get_staff_face_embeddings(org_id, staff_id)
        if not stored_vectors:
            return ok({
                "verified": False,
                "message": "Your face isn't enrolled yet. Contact your admin to complete enrollment.",
            })

        aggregate_emb = compute_aggregate_embedding([np.array(v) for v in stored_vectors])
        if aggregate_emb is None:
            return ok({
                "verified": False,
                "message": "Your face isn't enrolled yet. Contact your admin to complete enrollment.",
            })

        similarity, is_match = compare_embeddings(
            aggregate_emb, test_embedding, threshold=FACE_MATCHING_THRESHOLD,
        )
        return ok({
            "verified": bool(is_match),
            "similarity": float(similarity),
            "message": "Face verified successfully." if is_match else "Face does not match. Try again.",
        })

    return handle(_run)


@client_field_attendance_bp.route("/mark-attendance", methods=["POST"])
@require_client_staff_auth
def mark_field_attendance():
    """
    Body: { "latitude"|"lat": float, "longitude"|"lng": float,
            "geofence": {"configured": bool, "inside": bool,
                         "distance": float, "radius": float,
                         "label": str|null},
            "synced_after_offline": bool,
            "client_action_id": str (optional -- offline queue's
              idempotency key, see mark_client_staff_attendance's
              docstring for the exact replay contract),
            "face_verified": bool (optional -- only present when this
              mark is the sync-time completion of an offline-queued
              selfie, i.e. OfflineQueueService's 'field_attendance_offline'
              case; omit entirely for the normal live path, which already
              ran /verify-face synchronously before calling here),
            "face_similarity": float (optional, accompanies face_verified) }

    Takes the geofence evaluation from the client as-is (computed
    on-device by GeofenceService.evaluateGeofence against the config
    already on the app's session — see _sanitize_geofence) instead of
    re-fetching the staff row and recomputing it server-side on every
    mark. Marking is never blocked by being outside the geofence — see
    mark_field_staff_attendance's docstring — the mobile app's own
    confirmation dialog is the gate, so there is no server-side check
    left that this trust would weaken.

    face_verified here is NEVER a client-asserted "trust me" the way
    geofence is -- it only ever carries the result of a real server-side
    /verify-face call the app already made (either synchronously on the
    live path, or at sync time for a queued offline capture). This route
    doesn't run face matching itself; it just threads through what
    already happened.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        lat, lng = _require_lat_lng(payload)
        org_id = g.client_staff["org_id"]
        staff_id = g.client_staff["id"]
        branch_id = g.client_staff.get("branch_id")

        geofence_result = _sanitize_geofence(payload)
        face_verified = payload.get("face_verified")
        result = support_cp_db.mark_field_staff_attendance(
            org_id=org_id,
            branch_id=branch_id,
            staff_id=staff_id,
            latitude=lat,
            longitude=lng,
            geofence_result=geofence_result,
            synced_after_offline=bool(payload.get("synced_after_offline", False)),
            client_action_id=payload.get("client_action_id"),
            face_verified=bool(face_verified) if face_verified is not None else None,
            face_similarity=payload.get("face_similarity"),
        )
        return ok(result)

    return handle(_run)


@client_field_attendance_bp.route("/geo-alert", methods=["POST"])
@require_client_staff_auth
def geo_alert():
    """
    Body: { "latitude": float, "longitude": float, "distance": float }

    Best-effort log that this employee marked (or attempted to mark)
    attendance while outside their assigned geofence — see
    support_db.record_field_geo_alert's docstring for why this is a log
    today rather than a queryable table. Never fails the request even if
    logging itself has a problem, matching the mobile app's own
    "silent fail" GeofenceService.sendGeoAlert.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        try:
            lat, lng = _require_lat_lng(payload)
        except ValueError:
            lat, lng = None, None
        distance = payload.get("distance")
        support_cp_db.record_field_geo_alert(
            org_id=g.client_staff["org_id"],
            staff_id=g.client_staff["id"],
            latitude=lat,
            longitude=lng,
            distance=distance,
        )
        return ok({"logged": True})

    return handle(_run)


@client_field_attendance_bp.route("/attendance-logs", methods=["GET"])
@require_client_staff_auth
def field_attendance_logs():
    """Own attendance history for the field app's history screen — same
    Supabase `attendance` table and the same per-staff isolation
    (g.client_staff) as client_staff_attendance_routes.py's /history."""
    def _run():
        limit = request.args.get("limit", type=int) or 100
        logs = support_cp_db.get_client_staff_attendance_history(
            org_id=g.client_staff["org_id"],
            staff_id=g.client_staff["id"],
            limit=limit,
        )
        return ok({"logs": logs})

    return handle(_run)