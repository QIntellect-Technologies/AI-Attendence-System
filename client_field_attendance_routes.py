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
from logger_config import get_logger
from client_routes_helpers import ok, handle
import support_db as support_cp_db
from shared_face_engine import detect_and_extract, verify_against_vectors
from shared_face_engine.liveness import (
    CHALLENGE_PROMPTS,
    estimate_yaw_ratio,
    new_challenge,
    verify_challenge,
)
from face_challenge_token import consume_challenge_token, mint_challenge_token
from config import MODELS_DIR, FACE_DETECTION_CONFIDENCE, FACE_MATCHING_THRESHOLD

# Number of burst frames accepted per verification attempt. Five over ~3s
# gives liveness.verify_challenge enough trajectory to see a turn AND a
# return to centre, while capping decode+detect cost per request: each
# frame is a full InsightFace forward pass, and detect_and_extract holds
# a process-wide inference lock, so an unbounded list here would let one
# request stall every camera stream sharing the singleton model.
MAX_BURST_FRAMES = 6

client_field_attendance_bp = Blueprint(
    "client_field_attendance", __name__, url_prefix="/api/field"
)

logger = get_logger(__name__)


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
    """Shape a client-supplied geofence object for storage/display only.

    NOT used to decide anything any more (see mark_field_attendance below,
    which now calls support_db.evaluate_field_geofence itself instead of
    trusting this). Geofence evaluation happening purely on-device used to
    be a deliberate trust boundary, the same one this app still uses for
    office WiFi (mark_attendance in client_staff_attendance_routes.py
    takes wifi_verified from the client body as-is) -- but unlike WiFi
    SSID/BSSID, GPS coordinates are trivially spoofable via a mock-location
    provider (a standard "Fake GPS" app), which let an employee mark
    attendance from anywhere while the app's own geofence check reported
    "inside" the whole time. This helper is kept only for the
    /check-geofence fallback route and any other read-only display use --
    it must never again be the thing that decides inside/outside for a
    mark.
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


def _largest_face(frame):
    """Detect faces and return the largest, or None.

    Self-portrait, so take the largest detected face rather than the
    first one returned -- keeps a colleague visible in the background
    from accidentally becoming "the" face compared. Shared by both
    request shapes in verify_face so the deferred and live paths can
    never drift on which face they picked.
    """
    faces = detect_and_extract(frame, MODELS_DIR, min_confidence=FACE_DETECTION_CONFIDENCE)
    if not faces:
        return None

    def _bbox_area(face: dict) -> float:
        x1, y1, x2, y2 = face["bbox"]
        return max(0.0, x2 - x1) * max(0.0, y2 - y1)

    return max(faces, key=_bbox_area)


@client_field_attendance_bp.route("/liveness-challenge", methods=["POST"])
@require_client_staff_auth
def liveness_challenge():
    """Issue a signed, single-use liveness challenge for the caller.

    The app calls this immediately before capturing, shows the returned
    `prompt` to the employee, records a burst while they perform it, and
    posts the burst back to /verify-face along with `challenge_token`.

    The direction is chosen HERE, with secrets.choice, and travels only
    inside a signed token -- see face_challenge_token's docstring. If the
    app were allowed to name its own challenge, an attacker with one
    pre-recorded clip of the target turning right would simply always
    declare "turn_right", and the randomisation that makes replay
    expensive would do nothing.

    Identity comes from g.client_staff (verified JWT). Any user_id in the
    body is ignored, exactly as in verify_face below.
    """
    def _run():
        org_id = g.client_staff["org_id"]
        staff_id = g.client_staff["id"]

        challenge = new_challenge()
        token, expires_at = mint_challenge_token(org_id, staff_id, challenge)

        # `challenge` is echoed for the app's own logging/telemetry only.
        # verify_face NEVER reads it back from the body -- it reads the
        # copy inside the signature. Echoing it is therefore harmless:
        # the client already has to be told which way to turn.
        return ok({
            "challenge": challenge,
            "prompt": CHALLENGE_PROMPTS[challenge],
            "challenge_token": token,
            "expires_at": expires_at.isoformat(),
            "frames_expected": MAX_BURST_FRAMES - 1,
        })

    return handle(_run)


@client_field_attendance_bp.route("/verify-face", methods=["POST"])
@require_client_staff_auth
def verify_face():
    """1:1 face match against the caller's own enrolled embeddings, plus
    active liveness, decided entirely server-side.

    Identity is always taken from the authenticated staff context
    (g.client_staff, from the verified JWT). staff_id/user_id in the
    request body is ignored on purpose: a mobile client can't verify
    against, or spoof a match for, anyone but themselves, because there
    is no code path here that reads an id out of the body.

    Unlike geofence/WiFi (see this module's header), this decision stays
    server-side: it's the one signal here that exists specifically to
    stop one person marking attendance for another, so a client-asserted
    boolean would defeat its own purpose.

    ── Two accepted request shapes ───────────────────────────────────────
    LIVE (preferred): {"frames": [b64, ...], "challenge_token": "..."}
        Full check -- identity match on the best frame AND liveness via
        the head-turn trajectory across the burst. Returns
        liveness_checked=true.

    DEFERRED: {"image": b64}
        Identity match only, no liveness. This exists solely for
        OfflineQueueService's sync-time replay of a selfie captured while
        the device had no connectivity: one still frame was stored on
        disk hours earlier, so there is no burst to analyse and no way to
        run a challenge retroactively. Returns liveness_checked=false so
        the caller can flag the mark for admin review rather than
        silently treating it as equivalent to a live check.

    ── Why liveness is a trajectory and not a texture score ──────────────
    The previous implementation used shared_face_engine.spoof's FFT
    high/low frequency ratio. That metric tracks sharpness, not liveness,
    and on matched content it ranks the attacks ABOVE the genuine
    samples: printed photo 2.37, screen replay 2.12, live face in good
    light 2.04, live face motion-blurred 0.20. Print-and-recapture
    sharpens, screens contribute their own pixel-grid energy, and a real
    face indoors is dim and slightly blurred. No threshold separates
    them -- strict enough to reject the print rejected every live face,
    loose enough to admit live faces admitted the print. That is why
    enabling it locked staff out and disabling it let photos through.
    See shared_face_engine/liveness.py for the full write-up.

    Returns { verified, similarity, liveness_checked, message }. Always
    200 with verified=false for "no face"/"no match"/"not enrolled"/
    "liveness failed" -- those are normal outcomes for the app to show
    and retry, not server errors.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        org_id = g.client_staff["org_id"]
        staff_id = g.client_staff["id"]

        stored_vectors = support_cp_db.get_staff_face_embeddings(org_id, staff_id)
        if not stored_vectors:
            return ok({
                "verified": False,
                "liveness_checked": False,
                "message": "Your face isn't enrolled yet. Contact your admin to complete enrollment.",
            })
        known = [np.array(v) for v in stored_vectors]

        raw_frames = payload.get("frames")
        is_burst = isinstance(raw_frames, list) and len(raw_frames) > 0

        # ── Deferred path: single stored still, identity only ──────────
        if not is_burst:
            frame = _decode_face_image(payload)
            if frame is None:
                return ok({
                    "verified": False,
                    "liveness_checked": False,
                    "message": "No usable image was received.",
                })
            face = _largest_face(frame)
            if face is None or face.get("embedding") is None:
                return ok({
                    "verified": False,
                    "liveness_checked": False,
                    "message": "No face detected. Try again with better lighting.",
                })
            similarity, is_match = verify_against_vectors(
                face["embedding"], known, threshold=FACE_MATCHING_THRESHOLD,
            )
            return ok({
                "verified": bool(is_match),
                "similarity": float(similarity),
                "liveness_checked": False,
                "message": "Face verified successfully." if is_match else "Face does not match. Try again.",
            })

        # ── Live path: burst + server-chosen challenge ─────────────────
        # Consume the challenge FIRST, before spending CPU on decoding and
        # running a forward pass over every frame. An attacker firing
        # bursts with junk tokens should be rejected at signature-check
        # cost, not at six-InsightFace-passes cost.
        claims = consume_challenge_token(payload.get("challenge_token"), org_id, staff_id)
        if claims is None:
            return ok({
                "verified": False,
                "liveness_checked": False,
                "message": "Your verification session expired. Please start again.",
            })
        # Authoritative challenge: read out of the signature, NEVER out of
        # the request body. This line is the replay defence.
        challenge = claims["challenge"]

        if len(raw_frames) > MAX_BURST_FRAMES:
            raw_frames = raw_frames[:MAX_BURST_FRAMES]

        yaw_series: list[float | None] = []
        best_similarity = -1.0
        best_is_match = False
        faces_seen = 0

        for raw in raw_frames:
            frame = _decode_face_image({"image": raw})
            if frame is None:
                yaw_series.append(None)
                continue
            face = _largest_face(frame)
            if face is None:
                yaw_series.append(None)
                continue

            faces_seen += 1
            yaw_series.append(estimate_yaw_ratio(face["kps"]) if face.get("kps") is not None else None)

            # Identity is scored on EVERY frame and the best kept, rather
            # than on one nominated frame. The employee is mid-turn for
            # most of the burst, and a profile view embeds poorly against
            # frontal enrollment vectors -- scoring only, say, the middle
            # frame would false-reject genuine staff for turning as
            # instructed. Taking the best is not a weakening: every frame
            # still has to clear FACE_MATCHING_THRESHOLD on its own, and
            # all of them are bound to this one challenge-token attempt.
            emb = face.get("embedding")
            if emb is not None:
                similarity, is_match = verify_against_vectors(
                    emb, known, threshold=FACE_MATCHING_THRESHOLD,
                )
                if similarity > best_similarity:
                    best_similarity = float(similarity)
                    best_is_match = bool(is_match)

        if faces_seen == 0:
            return ok({
                "verified": False,
                "liveness_checked": True,
                "message": "No face detected. Try again with better lighting.",
            })

        live = verify_challenge(yaw_series, challenge)
        if not live["passed"]:
            # Log the specific sub-check that failed for admin review, but
            # return one generic message: telling a client exactly which
            # part of the liveness test it missed is telling an attacker
            # what to fix.
            logger.info(
                "Liveness failed for staff=%s org=%s challenge=%s: %s (%s)",
                staff_id, org_id, challenge, live["reason"], live,
            )
            return ok({
                "verified": False,
                "liveness_checked": True,
                "message": "We couldn't confirm a live face. Follow the on-screen prompt and try again.",
            })

        if not best_is_match:
            return ok({
                "verified": False,
                "similarity": float(max(0.0, best_similarity)),
                "liveness_checked": True,
                "message": "Face does not match. Try again.",
            })

        return ok({
            "verified": True,
            "similarity": float(best_similarity),
            "liveness_checked": True,
            "message": "Face verified successfully.",
        })

    return handle(_run)


@client_field_attendance_bp.route("/mark-attendance", methods=["POST"])
@require_client_staff_auth
def mark_field_attendance():
    """
    Body: { "latitude"|"lat": float, "longitude"|"lng": float,
            "is_mocked": bool (optional, defaults false -- Geolocator's
              on-device mock-location signal, see geofence_service.dart's
              isMockLocation),
            "geofence": {"configured": bool, "inside": bool,
                         "distance": float, "radius": float,
                         "label": str|null} (optional -- see below,
                         no longer trusted for the actual decision),
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

    Recomputes the geofence evaluation itself server-side
    (support_db.evaluate_field_geofence, from `lat`/`lng` against this
    staff member's assigned geofence_lat/geofence_lng/
    geofence_radius_meters) rather than trusting whatever the client's
    on-device GeofenceService.evaluateGeofence claimed. GPS coordinates,
    unlike WiFi SSID/BSSID, are trivially spoofable with a mock-location
    provider ("Fake GPS" apps) -- a spoofed lat/lng would make the
    client's own on-device check report "inside" too, so the fix isn't
    "trust the server's math instead of the client's math" (both would
    compute the same distance from the same fake coordinates), it's that
    this route now (a) is the single place that computes the number used
    for the decision at all, so it can't silently diverge from what an
    admin later reviews, and (b) actually acts on `is_mocked` and
    "outside the assigned geofence" by routing the mark into the same
    admin-review hold a face mismatch gets (see
    mark_field_staff_attendance's identity_hold_reasons), instead of the
    old behavior of only firing a geo-alert nothing downstream consumed.
    A mark is still never *rejected* outright for either reason -- same
    as a face mismatch, it lands but is flagged -- so a genuine GPS drift
    or a legitimately reassigned work site doesn't just fail silently;
    an admin decides.

    The client's own `geofence` object (if sent) is intentionally NOT fed
    into the decision here -- it's a legacy field from when the on-device
    check was authoritative, kept only so `_sanitize_geofence` can still
    validate/shape it for any caller that still sends it, but it is
    discarded in favor of the freshly recomputed result below.

    face_verified here is NEVER a client-asserted "trust me" the way
    geofence used to be -- it only ever carries the result of a real
    server-side /verify-face call the app already made (either
    synchronously on the live path, or at sync time for a queued offline
    capture). This route doesn't run face matching itself; it just
    threads through what already happened.
    """
    def _run():
        payload = request.get_json(silent=True) or {}
        lat, lng = _require_lat_lng(payload)
        org_id = g.client_staff["org_id"]
        staff_id = g.client_staff["id"]
        branch_id = g.client_staff.get("branch_id")

        # Authoritative, server-computed geofence result -- this, not
        # _sanitize_geofence(payload), is what actually decides
        # inside/outside for this mark. Reuses evaluate_field_geofence
        # (the same function /check-geofence already exposed but the
        # marking path never called) instead of duplicating the haversine
        # math here.
        geofence_result = support_cp_db.evaluate_field_geofence(
            org_id=org_id,
            staff_id=staff_id,
            latitude=lat,
            longitude=lng,
        )
        is_mocked = bool(payload.get("is_mocked", False))
        face_verified = payload.get("face_verified")
        result = support_cp_db.mark_field_staff_attendance(
            org_id=org_id,
            branch_id=branch_id,
            staff_id=staff_id,
            latitude=lat,
            longitude=lng,
            geofence_result=geofence_result,
            is_mocked=is_mocked,
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