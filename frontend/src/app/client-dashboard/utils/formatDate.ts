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

export interface DisplayTimeOptions {
  /** IANA timezone for timestamp values, such as a branch's configured zone. */
  timeZone?: string;
  /** Include the calendar date for timestamp displays. */
  includeDate?: boolean;
  /** Include seconds for live detection timestamps. */
  includeSeconds?: boolean;
}

/**
 * Formats either a timestamp or a time-only value for dashboard display.
 * Machine-readable time strings remain untouched at their data boundaries.
 */
export function formatDisplayTime(
  value: Date | string | null | undefined,
  options: DisplayTimeOptions = {},
): string {
  if (value === null || value === undefined || value === "") return "—";

  const text = value instanceof Date ? "" : String(value).trim();
  const timeOnly = text.match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i,
  );

  if (timeOnly) {
    let hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    const second = Number(timeOnly[3] ?? 0);
    const meridiem = timeOnly[4]?.replace(/\./g, "").toLowerCase();
    const validHour = meridiem
      ? hour >= 1 && hour <= 12
      : hour >= 0 && hour <= 23;

    if (validHour && minute <= 59 && second <= 59) {
      if (meridiem) {
        hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
      }
      const displayHour = hour % 12 || 12;
      const suffix = hour < 12 ? "AM" : "PM";
      const displayTime = `${displayHour}:${String(minute).padStart(2, "0")}${
        options.includeSeconds
          ? `:${String(second).padStart(2, "0")}`
          : ""
      } ${suffix}`;
      return displayTime;
    }
  }

  const date = value instanceof Date ? value : new Date(text);
  if (Number.isNaN(date.getTime())) return text || "—";

  const formatterOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(options.includeSeconds ? { second: "2-digit" as const } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  };
  const formatter = new Intl.DateTimeFormat("en-US", formatterOptions);
  const parts = formatter.formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const second = parts.find((part) => part.type === "second")?.value;
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value;

  if (!hour || !minute || !dayPeriod) return text || "—";

  const time = `${hour}:${minute}${second ? `:${second}` : ""} ${
    dayPeriod.toLowerCase() === "am" ? "AM" : "PM"
  }`;
  if (!options.includeDate) return time;

  const dateParts = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).formatToParts(date);
  const month = dateParts.find((part) => part.type === "month")?.value;
  const day = dateParts.find((part) => part.type === "day")?.value;
  const year = dateParts.find((part) => part.type === "year")?.value;
  return month && day && year ? `${month} ${day}, ${year}, ${time}` : time;
}

/** `formatDisplayDate` plus local time — e.g. "Jul 01, 2026, 5:31 PM".
 *  Use for timestamps that need to convey *when*, not just *which day*
 *  (export "Exported On" / "Generated" lines). */
export function formatDisplayDateTime(date: Date): string {
  return formatDisplayTime(date, { includeDate: true });
}
