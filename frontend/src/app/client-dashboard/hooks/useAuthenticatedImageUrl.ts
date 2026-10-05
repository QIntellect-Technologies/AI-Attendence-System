import { useEffect, useState } from "react";
import { dashboardAuthHeaders } from "../api/api";

/**
 * useAuthenticatedImageUrl
 * ─────────────────────────────────────────────────────────────────────────
 * Every profile-photo route on the backend (/api/users/<id>/photo,
 * /client_profile_photos/<filename>) sits behind @require_client_dashboard_auth
 * and returns 401 without a Bearer token — but a plain <img src="..."> is a
 * native browser request that can never carry a custom Authorization header.
 * That mismatch is what produced the "Authorization header required" 401s
 * on the dashboard header avatar.
 *
 * This hook fetches the photo manually (so the Bearer token goes along for
 * the ride, same as every other authenticated call in api.ts), then exposes
 * the result as a short-lived blob: URL an <img> tag can use directly.
 *
 * Usage:
 *   const photoSrc = useAuthenticatedImageUrl(user.profileImageUrl);
 *   {photoSrc ? <img src={photoSrc} /> : <Initials />}
 */
export function useAuthenticatedImageUrl(
  url: string | null | undefined,
): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setObjectUrl(null);
      return;
    }

    // Already a data: URL or blob: URL — nothing to authenticate, use as-is.
    if (url.startsWith("data:") || url.startsWith("blob:")) {
      setObjectUrl(url);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    (async () => {
      try {
        const res = await fetch(url, {
          credentials: "same-origin",
          headers: { ...dashboardAuthHeaders() },
        });
        if (!res.ok) throw new Error(`Photo request failed (${res.status})`);
        const blob = await res.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      } catch {
        if (!cancelled) setObjectUrl(null);
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [url]);

  return objectUrl;
}

export default useAuthenticatedImageUrl;
