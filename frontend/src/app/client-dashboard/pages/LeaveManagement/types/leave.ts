/**
 * src/modules/leave/types/leave.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for all leave-related types.
 *
 * KEY FIX: LeaveExportMetadata was previously a named interface with specific
 * required keys. buildFilterMetadata() returns Record<string, string | undefined>
 * which TypeScript cannot prove satisfies specific required keys — hence the
 * type error in LeaveManagement.tsx line 216.
 *
 * Fix: LeaveExportMetadata is now a type alias for Record<string, string | undefined>.
 * useLeaveFilters.exportMetadata, buildFilterMetadata's return type, and
 * useLeaveExport.filterMetadata all share the exact same type.
 * One type, one place — no more widening/narrowing mismatch.
 */

// ─── Core leave item ───────────────────────────────────────────────────────

export interface PendingLeaveItem {
  id: string;

  userId?: number | string;
  staffId?: string;

  branchId?: number | string;
  branchName: string;

  name: string;
  staffName?: string;

  /** Normalized business people type for scope filters (e.g., staff, worker). */
  peopleType?: string;

  dept: string;
  department?: string;

  type: "annual" | "casual" | "sick" | "emergency" | string;

  /** Payroll compensation treatment for this leave request. */
  leaveCompensation?:
    | "paid"
    | "unpaid"
    | "excluded"
    | "not_configured"
    | string;

  /** Payroll include/exclude decision for attendance-adjusted leaves. */
  leavePayrollDecision?: "include" | "exclude" | null | string;

  /**
   * Half-day period selected for half-day leave requests.
   * Undefined/null means a full-day leave.
   */
  halfDayPeriod?: "first_half" | "second_half" | "morning" | "afternoon" | null;

  /** Exact "HH:mm" start/end time picked for a half-day leave, if any. */
  halfDayStartTime?: string | null;
  halfDayEndTime?: string | null;

  days: number;

  status?: "Pending" | "Approved" | "Rejected";

  appliedOn?: string;
  startDate?: string;
  endDate?: string;
  reason?: string;

  approvedBy?: string | null;

  createdAt?: string;
  updatedAt?: string;
}

// ─── Filter state ──────────────────────────────────────────────────────────

export interface LeaveFilterState {
  department: string | null;
  type: string | null;
  search: string;
}

// ─── Filter options (for dropdowns) ───────────────────────────────────────

export interface LeaveFilterOption {
  value: string;
  label: string;
  count?: number;
  description?: string;
}

// ─── Export metadata ───────────────────────────────────────────────────────
//
// IMPORTANT: This is intentionally a flexible record, not a named interface
// with required keys. The metadata is built dynamically from active filters —
// its keys vary at runtime. Constraining it to specific required keys caused
// the type mismatch: buildFilterMetadata() returns Record<string, string | undefined>
// which TypeScript cannot widen to satisfy a named interface with required keys.
//
// All three sites that reference this type:
//   1. buildFilterMetadata()       in leave-filters.ts  — return type
//   2. useLeaveFilters.exportMetadata                   — property type
//   3. UseLeaveExportOptions.filterMetadata             — parameter type
// now share this single alias. No cast, no workaround.

export type LeaveExportMetadata = Record<string, string | undefined>;

// ─── Leave History (per-employee aggregate) ────────────────────────────────
//
// One row per staff member for the History tab — built from the full
// roster (so zero-leave employees still appear) joined against this
// period's approved leaves. "quotaConfigured" distinguishes "0 configured
// quota" from "no quota configured yet" (see useLeaveHistory) so the UI
// can render "—" instead of a misleading "0 remaining".

export interface LeaveHistoryRow {
  staffId: string;
  name: string;
  department: string;
  branchName?: string;

  totalPaidLeaves: number;
  takenPaidLeaves: number;
  totalUnpaidLeaves: number;
  takenUnpaidLeaves: number;
  totalLeaves: number;
  remainingPaidLeaves: number;
  remainingUnpaidLeaves: number;
  remainingLeaves: number;

  /** False when none of this employee's leave quotas are configured
   * in Payroll Rules yet — total/remaining columns are meaningless in
   * that case and the UI should show "—", not 0. */
  quotaConfigured: boolean;
}
