"""
shared_face_engine/liveness.py

ACTIVE liveness: verify that the thing in front of the camera performed a
randomly-chosen head movement, across a burst of frames, right now.

────────────────────────────────────────────────────────────────────────────
WHY THIS REPLACES THE FFT CHECK IN spoof.py
────────────────────────────────────────────────────────────────────────────
spoof.py measures the ratio of high- to low-frequency FFT energy in the
face crop, on the theory that real skin carries more fine texture than a
printed photo. That theory does not survive contact with real capture
hardware, because the metric is dominated by sharpness and exposure
rather than by liveness. Measured on synthetic controls matched for
content:

    LIVE face, good light      ratio = 2.04
    LIVE face, dim/backlit     ratio = 2.06
    LIVE face, motion blur     ratio = 0.20
    PRINTED PHOTO, sharp       ratio = 2.37   <-- highest of all
    SCREEN replay (moire)      ratio = 2.12   <-- second highest

The attack samples score ABOVE the genuine ones. A print is sharpened by
the print-and-recapture cycle, and a screen adds its own pixel-grid
high-frequency energy, while a real face indoors is dim and slightly
motion-blurred. So the two distributions do not merely overlap, they are
ordered the wrong way round.

That is why no threshold worked. Any cutoff strict enough to reject the
photo (>2.37) rejects every live face; any cutoff loose enough to admit
live faces (<2.04) admits the photo and the screen replay. Enabling the
check locked out real staff; disabling it let a photo through. Both
observations were correct, and neither was a tuning problem.

Movement is a different signal entirely, and it is one a flat artifact
cannot produce. A printed photo cannot turn its head. A still image on a
phone screen cannot either. Replaying a pre-recorded video can, which is
why the direction is chosen SERVER-SIDE per attempt and is not knowable
to the client in advance — an attacker would need footage of the target
performing the specific requested motion, prepared before they knew what
would be asked.

────────────────────────────────────────────────────────────────────────────
HOW YAW IS MEASURED WITHOUT LOADING A NEW MODEL
────────────────────────────────────────────────────────────────────────────
model_loader.py restricts InsightFace to allowed_modules =
["detection", "recognition"], so landmark_3d_68 is not loaded and
`face.pose` is unavailable. Loading it would add a model to every
consumer of the shared engine, including Local Node, for one route's
benefit.

The detection model (det_10g) already returns 5 keypoints per face —
left eye, right eye, nose tip, left mouth corner, right mouth corner —
at no extra cost, since FaceAnalysis.get() produces them in the same
forward pass that produces the embedding. Horizontal yaw follows from
where the nose sits between the eyes:

    yaw_ratio = (nose.x - eye_midpoint.x) / interocular_distance

Normalising by interocular distance makes this invariant to how far the
subject is from the lens and to image resolution, which a raw pixel
offset would not be. Facing the camera puts the nose near the eye
midpoint (~0.0); turning the head drives it toward the trailing eye.
This is a proxy, not a calibrated pose angle, and it does not need to be
anything more — the check is "did this ratio move a long way and come
back", which is a relative measurement.

────────────────────────────────────────────────────────────────────────────
MIRRORING
────────────────────────────────────────────────────────────────────────────
Front-camera captures may or may not be horizontally flipped depending on
platform and plugin version, which would invert left from right and cause
false rejections. The app normalises this before upload by un-mirroring
front-lens captures (see face_verification_screen.dart), so the frames
arriving here are always in true orientation.

That normalisation is safe to leave client-side even though nothing else
about the liveness decision is: flipping an image horizontally cannot
manufacture head motion that did not occur. An attacker who flips their
frames still has to produce a real excursion in the ratio, and the
excursion is what is being checked. Contrast with the match verdict
itself, which is exactly the kind of claim a device must never be
allowed to assert — see this module's callers in
client_field_attendance_routes.py.

────────────────────────────────────────────────────────────────────────────
WHAT THIS DOES AND DOES NOT STOP
────────────────────────────────────────────────────────────────────────────
Stops: printed photos, still images displayed on a screen, a colleague
holding up the enrolled employee's photo — the entire class of attack
that motivated the original report.

Does not fully stop: a determined attacker replaying video of the target
that happens to contain the requested motion, or a real-time deepfake
puppet. Raising the bar there needs a trained PAD model (MiniFASNet /
Silent-Face-Anti-Spoofing, ~2MB ONNX, loadable through the existing
onnxruntime dependency) run alongside this, not instead of it. Passive
texture models and active challenges fail to different attacks, which is
why production systems run both.
"""

from __future__ import annotations

import secrets
from typing import Any, Sequence

import numpy as np

# Challenge directions. Kept to the horizontal axis: yaw is by far the
# most reliably measurable movement from 5 keypoints, and pitch (nodding)
# moves the nose along the axis where the eye-midpoint baseline gives no
# stable normaliser.
CHALLENGES = ("turn_left", "turn_right")

CHALLENGE_PROMPTS = {
    "turn_left": "Slowly turn your head to your LEFT, then back to centre.",
    "turn_right": "Slowly turn your head to your RIGHT, then back to centre.",
}

# How far the normalised nose offset must travel to count as a real turn.
# A face looking straight at the lens sits near 0.0; a deliberate turn
# reaches roughly 0.35-0.60. 0.22 clears natural head sway and the jitter
# of keypoint estimation without demanding an uncomfortable rotation.
YAW_EXCURSION_THRESHOLD = 0.22

# At least one frame must be near-frontal, so the sequence is a MOVEMENT
# rather than a static photo that happens to be held at an angle.
YAW_CENTRE_TOLERANCE = 0.12

# Minimum frames carrying a usable face. Below this there is no
# trajectory to speak of.
MIN_USABLE_FRAMES = 3


def new_challenge() -> str:
    """Pick a challenge direction. secrets, not random: the whole point is
    that the client cannot predict or influence which motion is coming."""
    return secrets.choice(CHALLENGES)


def estimate_yaw_ratio(kps: np.ndarray | Sequence) -> float | None:
    """Normalised horizontal nose offset from the eye midpoint.

    Expects InsightFace's 5x2 keypoint array in true (un-mirrored)
    orientation. Returns None if the keypoints are unusable.

    Sign convention, in true orientation: NEGATIVE when the subject turns
    to their own left (the nose moves toward image-left), POSITIVE when
    they turn to their own right.
    """
    try:
        pts = np.asarray(kps, dtype=float)
        if pts.shape[0] < 3:
            return None

        left_eye, right_eye, nose = pts[0], pts[1], pts[2]
        eye_mid_x = (left_eye[0] + right_eye[0]) / 2.0
        interocular = float(np.linalg.norm(right_eye - left_eye))

        # Degenerate geometry: eyes coincident, or a face so small the
        # keypoints carry no signal. Refuse rather than divide by ~0 and
        # emit a huge ratio that would look like a dramatic turn.
        if interocular < 1e-3:
            return None

        return float((nose[0] - eye_mid_x) / interocular)
    except Exception:
        return None


def verify_challenge(
    yaw_series: Sequence[float | None],
    challenge: str,
    excursion_threshold: float = YAW_EXCURSION_THRESHOLD,
    centre_tolerance: float = YAW_CENTRE_TOLERANCE,
) -> dict[str, Any]:
    """Decide whether a burst's yaw trajectory performed `challenge`.

    Returns {"passed": bool, "reason": str, ...diagnostics}. `reason` is
    for server logs and admin review; do not hand it to the client
    verbatim, since telling an attacker precisely which sub-check failed
    is telling them what to fix.
    """
    usable = [y for y in yaw_series if y is not None]
    if len(usable) < MIN_USABLE_FRAMES:
        return {
            "passed": False,
            "reason": f"only {len(usable)} of {len(yaw_series)} frames had a usable face",
            "usable_frames": len(usable),
        }

    if challenge not in CHALLENGES:
        return {"passed": False, "reason": f"unknown challenge {challenge!r}"}

    # In true orientation, turning to the subject's own left drives the
    # ratio negative. Flip the series for that case so the rest of the
    # logic only ever reasons about a positive excursion.
    signed = [-y for y in usable] if challenge == "turn_left" else list(usable)

    peak = max(signed)
    trough = min(signed)
    centred = min(abs(y) for y in usable)

    # A static photo held at an angle produces a large |yaw| but no
    # variation across frames, and never passes near centre. Requiring
    # both a peak in the requested direction AND a near-frontal frame
    # forces an actual movement to have occurred.
    moved_far_enough = peak >= excursion_threshold
    returned_to_centre = centred <= centre_tolerance

    # Guard against the same frame submitted N times, which would give a
    # perfectly flat series. Real motion always leaves spread.
    spread = peak - trough
    has_variation = spread >= (excursion_threshold * 0.5)

    passed = moved_far_enough and returned_to_centre and has_variation

    if not passed:
        if not moved_far_enough:
            reason = f"peak excursion {peak:.3f} < {excursion_threshold}"
        elif not returned_to_centre:
            reason = f"no near-frontal frame (closest |yaw| {centred:.3f} > {centre_tolerance})"
        else:
            reason = f"yaw series too flat (spread {spread:.3f}) — frames may be duplicates"
    else:
        reason = "ok"

    return {
        "passed": passed,
        "reason": reason,
        "challenge": challenge,
        "peak_excursion": float(peak),
        "spread": float(spread),
        "closest_to_centre": float(centred),
        "usable_frames": len(usable),
    }