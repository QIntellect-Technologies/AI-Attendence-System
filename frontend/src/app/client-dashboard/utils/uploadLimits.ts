/**
 * Client-side upload ceilings.
 *
 * These MUST stay in sync with the backend:
 *   - MAX_PHOTO_BYTES  -> app.py per-route check (5MB, 3 photo routes)
 *   - MAX_UPLOAD_BYTES -> shared/config/flask.py MAX_CONTENT_LENGTH (64MB)
 *
 * The server is authoritative — these exist so a user finds out before
 * uploading 60MB over a slow link, not to enforce anything.
 */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;

/** Returns an error string when the file is too large, otherwise null. */
export const checkFileSize = (
  file: File,
  limitBytes: number,
  label = "File",
): string | null =>
  file.size > limitBytes
    ? `${label} is ${formatBytes(file.size)}. Maximum is ${formatBytes(limitBytes)}.`
    : null;
