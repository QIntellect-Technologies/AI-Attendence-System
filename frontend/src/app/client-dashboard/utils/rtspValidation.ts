/**
 * Client-side mirror of _validate_camera_rtsp_url() in
 * backend/support_db_client_users.py.
 *
 * The stored rtsp_url is later opened directly by an ffmpeg-backed
 * cv2.VideoCapture on the backend (app.py's /api/stream/<camera_id>) and by
 * the local node client, both of which happily follow http(s):// (and other
 * schemes, including file://) — an unvalidated URL here is a straight path
 * to SSRF against internal infrastructure. The backend is the real
 * boundary and rejects any request whose scheme isn't rtsp/rtsps regardless
 * of what this file does; this validator exists purely so the person finds
 * out immediately, instead of after a round trip to the server.
 *
 * Used by both Settings.tsx (post-onboarding camera edit) and
 * OnboardingWizard.tsx (initial camera setup) — both post to the same
 * /api/client/onboarding/complete endpoint and so must stay in sync with
 * the same backend rule. Single source of truth so the two forms can't
 * drift apart the way name validation once did between create and update
 * (see staffValidation.ts's comment on that history).
 */

export const RTSP_URL_MAX_LENGTH = 500;

const ALLOWED_RTSP_SCHEMES = new Set(["rtsp", "rtsps"]);

/**
 * Returns an error message, or null when the URL is acceptable. An empty
 * value is always acceptable — the field is optional ("Leave empty when
 * network + channel is enough"); only a non-empty value is scheme-checked.
 */
export const validateRtspUrl = (value: string | undefined): string | null => {
  const text = (value ?? "").trim();
  if (!text) return null;

  if (text.length > RTSP_URL_MAX_LENGTH) {
    return `RTSP URL must be ${RTSP_URL_MAX_LENGTH} characters or fewer.`;
  }

  // Parse with the URL constructor rather than a regex prefix check, so
  // "rtsp.evil.com" (no scheme) and "rtsp://valid/@http://evil" style
  // tricks are both handled the same way a real parser handles them on the
  // backend (urlparse). A value that doesn't parse as an absolute URL at
  // all is treated as a missing/invalid scheme, same outcome either way.
  let scheme: string;
  try {
    scheme = new URL(text).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return "Enter a valid RTSP URL, e.g. rtsp://username:password@ip:554/channel.";
  }

  if (!ALLOWED_RTSP_SCHEMES.has(scheme)) {
    return "RTSP URL must start with rtsp:// or rtsps:// — other protocols (e.g. http://) are not allowed.";
  }

  return null;
};

/**
 * Minimal shape both Settings.tsx's and OnboardingWizard.tsx's CameraItem
 * satisfy — kept structural rather than importing either file's type so
 * this module has no dependency on either caller.
 */
type RtspCheckable = { rtspUrl: string; type: string };

/**
 * Runs validateRtspUrl across every branch's cameras, not just whichever
 * branch tab or step is currently active — a bad URL left on a branch the
 * person has navigated away from must still block save, not just the one
 * they're looking at. Skips webcam entries, which have no rtsp_url.
 */
export function findInvalidCameraRtspUrl(
  camerasByBranch: Record<string, RtspCheckable[]>,
): string | null {
  for (const list of Object.values(camerasByBranch)) {
    for (const camera of list) {
      if (camera.type === "webcam") continue;
      const error = validateRtspUrl(camera.rtspUrl);
      if (error) return error;
    }
  }
  return null;
}
