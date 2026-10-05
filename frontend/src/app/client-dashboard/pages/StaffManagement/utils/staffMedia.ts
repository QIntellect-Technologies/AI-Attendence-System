/**
 * modules/staff/utils/staffMedia.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Profile-image URL resolution. Distinguishes browser object URLs (local
 * preview, never persisted) from backend-served paths that need the Flask
 * origin prefixed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Origin to prefix onto relative backend media paths.
 *
 * MUST mirror api.ts's BASE_URL: empty string = same origin. When
 * VITE_API_BASE_URL is unset the frontend is served from the same origin as
 * Flask (Vite's /api proxy in dev, one Railway service in production), so a
 * relative path is already correct and needs no prefix.
 *
 * The old "http://localhost:5000" fallback was baked into the production
 * bundle at build time, so every deployed staff photo pointed at the
 * viewer's own machine and died in the browser's CORS preflight:
 *   Access to fetch at 'http://localhost:5000/api/staff/<id>/photo'
 *   from origin 'https://<app>.up.railway.app' has been blocked...
 * A missing env var must degrade to same-origin, never to a hardcoded host.
 */
export const FLASK_ORIGIN = (() => {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
  return raw && raw !== "/api" ? raw.replace(/\/$/, "") : "";
})();

export function resolveProfileImageUrl(
  url: string | undefined,
): string | undefined {
  if (!url) return undefined;
  // Already absolute (blob:, https:, http:)
  if (/^(blob:|https?:)/.test(url)) return url;
  // Relative API path → prefix with Flask origin
  if (url.startsWith("/")) return `${FLASK_ORIGIN}${url}`;
  return url;
}

export function isBrowserPreviewUrl(url: string | undefined): boolean {
  return /^(blob:|data:)/.test(String(url || ""));
}

export function persistedMediaUrl(url: string | undefined): string {
  const value = String(url || "").trim();
  return value && !isBrowserPreviewUrl(value) ? value : "";
}
