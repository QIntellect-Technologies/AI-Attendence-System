/**
 * modules/staff/utils/shiftOverlap.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONE definition of "do these two shifts collide?" on the client.
 *
 * Deliberate mirror of backend/support_db_shift_overlap.py — same spans, same
 * severities, same half-open intervals, same midnight-wrap handling. The two
 * are kept in step by the shared table of cases in shiftOverlap.test.ts, which
 * is transcribed from tests/test_shift_overlap.py; change one, change both.
 *
 * The backend copy is AUTHORITATIVE and is what actually protects the data.
 * This copy exists for two things it can do that the server can't:
 *
 *   1. Catch a conflict across UNSAVED draft rows. ShiftTimingsModal saves
 *      rows one at a time in a loop, so without a pre-flight check a batch
 *      containing an internal conflict writes the first row, then fails on
 *      the second — leaving the catalog half-updated.
 *   2. Tell the admin which rows collide, inline, before they press Save.
 *
 * Never treat a pass here as authorization to skip the server. The server
 * rejects independently, and a 409 from it is the real answer.
 *
 * ── THE MODEL (identical to the Python docstring) ────────────────────────────
 *   duty span   [checkIn, checkOut)                     → overlap = "conflict"
 *   claim span  [checkIn, checkOut + checkoutGrace)     → overlap = "warning"
 *
 * Duty overlap is a hard error: a punch inside the intersection can't be
 * attributed to one shift. Claim-only overlap is a warning: back-to-back
 * shifts (Morning 09:00–17:00 → Evening 17:00–01:00) are a normal roster
 * whose grace tails simply touch, and must stay creatable.
 *
 * Open-ended shifts (checkout capture off) claim only [checkIn, checkIn +
 * grace). Overnight shifts wrap midnight and are normalised to one or two
 * flat segments before comparison, so wrap is handled once, here.
 */

export const DAY_MINUTES = 24 * 60;

export type ShiftConflictSeverity = "conflict" | "warning";

/** The minimum any shift-shaped object must expose to be compared. Both
 * ShiftRecord (from the API) and ShiftTimingsDraftRow (local, unsaved)
 * structurally satisfy this, so neither needs converting first. */
export interface ComparableShift {
  id?: string;
  name?: string;
  check_in_time?: string | null;
  grace_minutes?: number | null;
  check_out_time?: string | null;
  checkout_grace_minutes?: number | null;
  /** Draft rows carry this instead of a null check_out_time. */
  capture_check_out?: boolean;
  is_active?: boolean;
}

export interface ShiftConflict {
  shiftId?: string;
  shiftName: string;
  severity: ShiftConflictSeverity;
  overlapMinutes: number;
  /** "09:00–17:00", or "09:00 (open-ended)". */
  window: string;
}

type Segment = readonly [number, number];

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** "HH:MM" / "HH:MM:SS" → minutes past midnight. null for blank or invalid,
 * so a half-typed time in an input doesn't throw on every keystroke. */
export const toMinutes = (value: unknown): number | null => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parts = text.split(":");
  if (parts.length < 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};

/** Reformats from the PARSED minutes rather than slicing the raw string — a
 * slice turns an unparseable value into a plausible-looking truncation
 * ("not-a-time" → "not-a") and shows it to an admin as if it were a time. */
const formatTime = (value: unknown): string => {
  const minutes = toMinutes(value);
  if (minutes === null) return String(value ?? "").trim() || "??:??";
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${hh}:${mm}`;
};

/** True when this shift captures a checkout leg at all. Draft rows express
 * that as a `capture_check_out` flag; saved records express it as a non-null
 * check_out_time. Both are read here so callers never normalise first. */
const capturesCheckout = (shift: ComparableShift): boolean =>
  shift.capture_check_out === false
    ? false
    : Boolean(shift.check_out_time && String(shift.check_out_time).trim());

export const formatShiftWindow = (shift: ComparableShift): string => {
  const start = formatTime(shift.check_in_time);
  return capturesCheckout(shift)
    ? `${start}–${formatTime(shift.check_out_time)}`
    : `${start} (open-ended)`;
};

// ─── Circular-clock segment math ─────────────────────────────────────────────

const segments = (start: number, length: number): Segment[] => {
  const from = ((start % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const span = Math.max(0, Math.min(length, DAY_MINUTES));
  if (span === 0) return [];
  const end = from + span;
  return end <= DAY_MINUTES
    ? [[from, end]]
    : [
        [from, DAY_MINUTES],
        [0, end - DAY_MINUTES],
      ];
};

/** Forward distance start → end. A checkout equal to the check-in is a full
 * 24-hour shift, not a zero-length one — a 0 here would silently make a
 * round-the-clock post collide with nothing. */
const spanLength = (start: number, end: number): number => {
  const delta = (((end - start) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return delta || DAY_MINUTES;
};

const overlapMinutes = (a: Segment[], b: Segment[]): number =>
  a.reduce(
    (total, [aStart, aEnd]) =>
      total +
      b.reduce(
        (inner, [bStart, bEnd]) =>
          inner + Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart)),
        0,
      ),
    0,
  );

// ─── Span derivation ─────────────────────────────────────────────────────────

const openEndedSegments = (
  checkIn: number,
  shift: ComparableShift,
): Segment[] =>
  segments(checkIn, Math.max(Number(shift.grace_minutes ?? 0), 1));

const dutySegments = (shift: ComparableShift): Segment[] => {
  const checkIn = toMinutes(shift.check_in_time);
  if (checkIn === null) return [];
  if (!capturesCheckout(shift)) return openEndedSegments(checkIn, shift);

  const checkOut = toMinutes(shift.check_out_time);
  if (checkOut === null) return openEndedSegments(checkIn, shift);
  return segments(checkIn, spanLength(checkIn, checkOut));
};

const claimSegments = (shift: ComparableShift): Segment[] => {
  const checkIn = toMinutes(shift.check_in_time);
  if (checkIn === null) return [];
  if (!capturesCheckout(shift)) return openEndedSegments(checkIn, shift);

  const checkOut = toMinutes(shift.check_out_time);
  if (checkOut === null) return openEndedSegments(checkIn, shift);

  const tail = Math.max(0, Number(shift.checkout_grace_minutes ?? 0));
  return segments(
    checkIn,
    Math.min(spanLength(checkIn, checkOut) + tail, DAY_MINUTES),
  );
};

// ─── The public check ────────────────────────────────────────────────────────

/** Classify one pair. null when the two shifts don't touch at all. */
export const compareShifts = (
  candidate: ComparableShift,
  other: ComparableShift,
): ShiftConflict | null => {
  const duty = overlapMinutes(dutySegments(candidate), dutySegments(other));
  let severity: ShiftConflictSeverity;
  let minutes: number;

  if (duty > 0) {
    severity = "conflict";
    minutes = duty;
  } else {
    const claim = overlapMinutes(
      claimSegments(candidate),
      claimSegments(other),
    );
    if (claim <= 0) return null;
    severity = "warning";
    minutes = claim;
  }

  return {
    shiftId: other.id,
    shiftName: String(other.name ?? "").trim() || "Untitled shift",
    severity,
    overlapMinutes: minutes,
    window: formatShiftWindow(other),
  };
};

/** Every collision between `candidate` and shifts already configured for the
 * same branch + people_type. Callers pass an already-scoped list — the modal
 * only ever holds one branch's rows — so scoping isn't re-derived here.
 *
 * Hard conflicts sort first, then by size, so a caller that surfaces only the
 * first item surfaces the worst one. */
export const findShiftConflicts = (
  candidate: ComparableShift,
  existing: readonly ComparableShift[],
  options: { excludeId?: string; includeInactive?: boolean } = {},
): ShiftConflict[] => {
  const { excludeId, includeInactive = false } = options;

  return existing
    .filter((other) => {
      if (excludeId && other.id === excludeId) return false;
      if (!includeInactive && other.is_active === false) return false;
      return true;
    })
    .map((other) => compareShifts(candidate, other))
    .filter((c): c is ShiftConflict => c !== null)
    .sort(
      (a, b) =>
        Number(a.severity !== "conflict") - Number(b.severity !== "conflict") ||
        b.overlapMinutes - a.overlapMinutes,
    );
};

/** One line of copy for a conflict, phrased for the admin rather than the
 * schema. Shared by every surface that renders one so a conflict reads the
 * same in the modal, the allocation tab, and a toast. */
export const describeShiftConflict = (conflict: ShiftConflict): string =>
  conflict.severity === "conflict"
    ? `Shares ${conflict.overlapMinutes} min with "${conflict.shiftName}" (${conflict.window}). Fine if two people cover that stretch together \u2014 each person\u2019s attendance follows their own assigned shift.`
    : `The grace window of "${conflict.shiftName}" (${conflict.window}) runs ${conflict.overlapMinutes} min into this shift.`;

/**
 * Checks every row in a draft set against every other, once per pair.
 * Returns a map of row id → its conflicts, so the modal can mark each
 * offending row rather than reporting a single batch-level failure the
 * admin then has to locate by eye.
 *
 * Rows with no usable check-in time are skipped: they're mid-edit, and the
 * required-field check already catches them at save.
 */
export const findConflictsWithinDraftSet = <
  T extends ComparableShift & { id: string },
>(
  rows: readonly T[],
): Record<string, ShiftConflict[]> => {
  const usable = rows.filter((row) => toMinutes(row.check_in_time) !== null);
  const byRowId: Record<string, ShiftConflict[]> = {};

  usable.forEach((row, index) => {
    usable.slice(index + 1).forEach((other) => {
      const conflict = compareShifts(row, other);
      if (!conflict) return;

      // Record both directions: each row needs to show what IT collides
      // with, named after the other row.
      (byRowId[row.id] ??= []).push({ ...conflict, shiftId: other.id });
      (byRowId[other.id] ??= []).push({
        ...compareShifts(other, row)!,
        shiftId: row.id,
      });
    });
  });

  return byRowId;
};

/** Whether a set contains a duty-hours overlap (as opposed to only a grace
 * tail). Used to decide what to HIGHLIGHT, not what to block \u2014 overlapping
 * shifts save normally. */
export const hasBlockingConflict = (
  conflicts: readonly ShiftConflict[] | undefined,
): boolean => Boolean(conflicts?.some((c) => c.severity === "conflict"));
