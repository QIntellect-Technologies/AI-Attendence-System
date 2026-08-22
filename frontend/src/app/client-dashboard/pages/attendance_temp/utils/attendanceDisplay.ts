/**
 * pages/attendance_temp/utils/attendanceDisplay.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Design tokens + branch-timezone-aware datetime helpers shared across the
 * Attendance module (AttendanceView.tsx's table/editing and
 * ManualAttendanceModal.tsx's Add/Edit form).
 *
 * This lives in its own leaf module -- not re-exported from
 * AttendanceView.tsx -- specifically to avoid a circular import:
 * AttendanceView.tsx imports ManualAttendanceModal.tsx (to render the Add/
 * Edit modal), so if ManualAttendanceModal.tsx imported T/toDatetimeLocalValue
 * back from AttendanceView.tsx, the two modules would import each other. Same
 * reasoning as pages/LeaveManagement/theme.ts's header comment for the
 * identical problem there.
 */

// ─── Design tokens ─────────────────────────────────────────────────────────
// Matches the app-wide palette in src/styles/theme.css (--teal-600,
// --slate-50, --red-600, --red-100, --bg-card, --border, --text-heading,
// --text-body, --text-muted) so this module's cards/forms don't visually
// drift from the rest of the Client Dashboard.

export const T = {
  teal600: "#0d9488",
  teal50: "#f0fdfa",
  teal100: "#ccfbf1",
  navy700: "#134471",
  slate50: "#f8fafc",
  slate100: "#f1f5f9",
  slate200: "#e2e8f0",
  green600: "#16a34a",
  green100: "#f0fdf4",
  red600: "#e11d48",
  red100: "#fff1f2",
  amber600: "#d97706",
  amber100: "#fffbeb",
  bgPage: "#f5f6fa",
  bgCard: "#ffffff",
  border: "#e2e8f0",
  textHeading: "#1a699f",
  textBody: "#334155",
  textMuted: "#64748b",
  textLight: "#94a3b8",
  shadow: "0 1px 3px rgba(15,45,74,0.07),0 1px 2px rgba(15,45,74,0.04)",
} as const;

export default T;

// ─── Branch timezone resolution ────────────────────────────────────────────

/** Minimal branch shape this module needs -- a structural subset of
 * OrgConfigContext's OrgBranch, so any branch list already in scope
 * (masterData.branches, etc.) satisfies this without extra mapping. */
export interface BranchLike {
  id: number;
  name: string;
  timezone?: string;
}

/** IANA zone used whenever a branch has no timezone configured yet, or the
 * branch itself can't be resolved (missing/invalid branchId). Matches
 * Intl's own "no timeZone means system/UTC-ish" fallback so an unconfigured
 * branch degrades gracefully instead of throwing. */
const FALLBACK_TIMEZONE = "UTC";

export function getBranchTimezone(
  branchId: number | string | null | undefined,
  branches: BranchLike[],
): string {
  const numericId = Number(branchId);
  if (branchId === null || branchId === undefined || Number.isNaN(numericId)) {
    return FALLBACK_TIMEZONE;
  }
  const branch = branches.find((b) => Number(b.id) === numericId);
  const zone = branch?.timezone?.trim();
  return zone || FALLBACK_TIMEZONE;
}

// ─── datetime-local <-> ISO conversion (branch-timezone-aware) ────────────

/** Offset, in minutes, to ADD to a UTC instant to get that instant's local
 * wall-clock time in `timeZone` (positive east of UTC). Computed from the
 * zone's actual rendering of `date` via Intl, so DST is handled correctly
 * for the date in question rather than using a fixed offset. */
function getTimezoneOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return (asUtc - date.getTime()) / 60000;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * ISO datetime (any offset, typically UTC from the backend) -> the branch's
 * local wall-clock time as a "YYYY-MM-DDTHH:mm" string, the native format
 * <input type="datetime-local"> expects. Returns "" for a missing/invalid
 * value so the input just renders empty instead of "Invalid Date".
 */
export function toDatetimeLocalValue(
  value: string | null | undefined,
  timeZone: string,
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const zone = timeZone || FALLBACK_TIMEZONE;
  const offsetMinutes = getTimezoneOffsetMinutes(date, zone);
  const local = new Date(date.getTime() + offsetMinutes * 60000);

  return (
    `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}` +
    `T${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`
  );
}

/**
 * The reverse of toDatetimeLocalValue -- a "YYYY-MM-DDTHH:mm" wall-clock
 * string (as typed into a datetime-local input, meaning "this time in the
 * branch's own timezone") -> a UTC ISO datetime string safe to send to the
 * backend. Returns null for a missing/malformed value so callers can treat
 * "cleared the field" and "invalid" the same way (see
 * ManualAttendanceModal.tsx's checkOut handling).
 */
export function fromDatetimeLocalValue(
  value: string | null | undefined,
  timeZone: string,
): string | null {
  if (!value) return null;
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return null;

  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  if ([year, month, day, hour, minute].some((n) => Number.isNaN(n)))
    return null;

  const zone = timeZone || FALLBACK_TIMEZONE;
  // First pass: treat the typed wall-clock numbers as if they were UTC.
  // That instant is close enough to the real one (within a day) to look up
  // the zone's actual offset for it, which we then apply to get the real
  // UTC instant. Two-pass rather than a fixed offset table so DST is
  // handled correctly for the date in question.
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMinutes = getTimezoneOffsetMinutes(new Date(guessUtcMs), zone);
  const actualUtcMs = guessUtcMs - offsetMinutes * 60000;

  const result = new Date(actualUtcMs);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}
