/**
 * modules/staff/utils/staffMedia.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Profile-image URL resolution. Distinguishes browser object URLs (local
 * preview, never persisted) from backend-served paths that need the Flask
 * origin prefixed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const FLASK_ORIGIN =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ||
  "http://localhost:5000";

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
