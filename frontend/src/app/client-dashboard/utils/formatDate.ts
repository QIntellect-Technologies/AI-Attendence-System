/**
 * formatDate.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for human-readable date formatting across the app
 * (report period labels, PDF/CSV export timestamps, PDF table date cells).
 *
 * Before this existed, each export surface picked its own default locale
 * format independently — `toLocaleString()` vs `toLocaleDateString()` vs a
 * hand-rolled `Intl` call — which silently drift from one another even
 * though they're rendering the same instant. Centralizing avoids that.
 *
 * NOT used for machine-readable data (e.g. raw CSV data-cell values, which
 * intentionally stay ISO 8601 so spreadsheet apps parse them as sortable
 * dates on import) — this is for what a person reads.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** "MMM DD, YYYY" — e.g. "Jul 01, 2026". The one date format used across
 *  every report/export surface: period labels, PDF header tags, PDF table
 *  date cells, and the date portion of export timestamps. */
export function formatDisplayDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

/** `formatDisplayDate` plus local time — e.g. "Jul 01, 2026, 5:31 PM".
 *  Use for timestamps that need to convey *when*, not just *which day*
 *  (export "Exported On" / "Generated" lines). */
export function formatDisplayDateTime(date: Date): string {
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${formatDisplayDate(date)}, ${time}`;
}
