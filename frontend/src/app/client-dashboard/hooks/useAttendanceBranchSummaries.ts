/**
 * useAttendanceBranchSummaries.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared hook that computes per-branch attendance summary rows.
 *
 * [Fix-3] Extracted from AttendanceView.tsx where it was a stranded pure
 * function operating on module data inside a UI component. Moving it here:
 *
 *   1. Makes the aggregation reusable across any view that needs branch-level
 *      attendance metrics (dashboard cards, export summaries, branch picker).
 *
 *   2. Makes backend migration safe: when the backend returns aggregate data,
 *      swap the useMemo body for a useQuery call here — zero UI changes needed.
 *
 *   3. Keeps AttendanceView's useAttendanceSources hook focused on data
 *      selection/scoping rather than aggregation.
 *
 * Backend migration:
 *   Replace the useMemo with:
 *     const { data } = useQuery(['attendance-summaries', branchIds], fetchSummaries)
 *     return data ?? []
 *   The return type BranchAttendanceSummary stays the same.
 */

import { useMemo } from "react";

// ─── Types (kept local — import into AttendanceView from here) ────────────────

export interface BranchLike {
  id: number;
  name: string;
  timezone?: string;
}

export interface AttendanceStaffLike {
  id: string | number;
  name: string;
  branchId?: number;
  [key: string]: unknown;
}

export interface ApiAttendanceLike {
  user_id?: number;
  user_name?: string;
  status: string;
  branchId?: number;
  branch_id?: number;
  staffId?: string | number;
  [key: string]: unknown;
}

export interface BranchAttendanceSummary {
  branchId: number;
  branchName: string;
  city?: string;
  /** Number of staff registered at this branch. */
  primaryCount: number;
  /** Percentage of registered staff who are present (0–100). */
  attendanceRate: number;
}

// ─── Pure aggregation ─────────────────────────────────────────────────────────

/**
 * Determines whether an attendance record belongs to a given branch.
 *
 * Resolution order:
 *   1. Direct branch id on the record (branchId / branch_id).
 *   2. Staff id match against branch staff roster.
 *   3. Staff name match against branch staff roster (case-insensitive).
 *
 * This layered approach handles both API records (which carry a branchId) and
 * dummy records (which may only have a staffId or user_name).
 */
function recordBelongsToBranch(
  record: ApiAttendanceLike,
  branchId: number,
  branchStaff: AttendanceStaffLike[],
): boolean {
  const directBranchId = Number(record.branchId ?? record.branch_id ?? 0);
  if (directBranchId) return directBranchId === branchId;

  const recordStaffId = String(record.staffId ?? record.user_id ?? "");
  const recordName = String(record.user_name ?? "")
    .toLowerCase()
    .trim();

  return branchStaff.some(
    (member) =>
      String(member.id) === recordStaffId ||
      member.name.toLowerCase().trim() === recordName,
  );
}

// [Fix] record.status is a check-in/checkout LIFECYCLE marker
// ("CHECKED_OUT" / "HALF_DAY" / "CHECKED_IN" etc), not the attendance
// classification -- it is never literally "PRESENT" or "LATE", so matching
// against it here always returned 0 present regardless of real attendance.
// The actual classification lives in day_status ("present" / "late" /
// "short_leave" / "half_day" / "overtime"). All of these mean the person
// showed up in some form, so all count toward "present" for this rate --
// only a staff member with NO record at all for the day is absent.
const PRESENT_DAY_STATUSES = new Set([
  "present",
  "late",
  "short_leave",
  "half_day",
  "overtime",
]);
// Kept as a fallback for any older/dummy data shapes that only carry the
// legacy `status` field and never populated `day_status`.
const PRESENT_STATUSES = new Set(["PRESENT", "COMPLETED", "LATE"]);

function isPresentRecord(record: ApiAttendanceLike): boolean {
  const dayStatus = String(record.day_status ?? record.dayStatus ?? "")
    .toLowerCase()
    .trim();
  if (dayStatus) return PRESENT_DAY_STATUSES.has(dayStatus);
  return PRESENT_STATUSES.has(String(record.status ?? "").toUpperCase());
}

/**
 * Pure computation. Safe to call outside React — no hooks inside.
 * Exported for unit testing.
 */
export function computeAttendanceBranchSummaries(
  branches: BranchLike[],
  staffItems: AttendanceStaffLike[],
  attendanceItems: ApiAttendanceLike[],
): BranchAttendanceSummary[] {
  return branches.map((branch) => {
    const branchStaff = staffItems.filter(
      (member) => Number(member.branchId) === Number(branch.id),
    );

    const branchAttendance = attendanceItems.filter((record) =>
      recordBelongsToBranch(record, Number(branch.id), branchStaff),
    );

    const presentCount = branchAttendance.filter(isPresentRecord).length;

    const attendanceRate = branchStaff.length
      ? Math.round((presentCount / branchStaff.length) * 100)
      : 0;

    return {
      branchId: Number(branch.id),
      branchName: branch.name,
      timezone: branch.timezone,
      primaryCount: branchStaff.length,
      attendanceRate,
    };
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Memoized hook wrapper around computeAttendanceBranchSummaries.
 *
 * Re-runs only when branches, staff, or attendance arrays change by reference,
 * so it is safe to call on every render of AttendanceView without extra guards.
 */
export function useAttendanceBranchSummaries(
  branches: BranchLike[],
  staffItems: AttendanceStaffLike[],
  attendanceItems: ApiAttendanceLike[],
): BranchAttendanceSummary[] {
  return useMemo(
    () =>
      computeAttendanceBranchSummaries(branches, staffItems, attendanceItems),
    [branches, staffItems, attendanceItems],
  );
}
