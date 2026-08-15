/**
 * src/modules/leave/hooks/useLeaveFilters.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized leave filter state management.
 *
 * Manages all leave-related filters:
 *   - Date filter (from useDateFilter)
 *   - Branch selector (from useBranchSelector)
 *   - Department filter
 *   - Leave type filter
 *   - Search filter
 *
 * Single source of truth for filter state.
 * Decouples filter management from UI rendering.
 */

import React, { useMemo, useCallback } from "react";
import type { PendingLeaveItem, LeaveFilterState } from "../types/leave";
import {
  buildDepartmentFilterOptions,
  buildLeaveTypeFilterOptions,
  leaveMatchesFilters,
  filterLeavesByDateRange,
  buildFilterMetadata,
  LEAVE_FILTER_DEFAULTS,
} from "../config/leave-filters";
import type { LeaveFilterOption } from "../types/leave";

/**
 * Options for the useLeaveFilters hook.
 */
export interface UseLeaveFiltersOptions {
  /** All pending leaves (unfiltered) */
  leaves: PendingLeaveItem[];

  /** Current date filter state (from useDateFilter) */
  dateFilter: {
    dates: string[];
    mode: "daily" | "weekly" | "monthly" | "custom";
    label: string;
    selectedDate?: string;
  };

  /** Current branch selection (for global scope) */
  isGlobal: boolean;
  selectedBranchId?: number;
  selectedPeopleType?: string | null;

  /** Optional: initial filter state (for testing or restoration) */
  initialFilters?: Partial<LeaveFilterState>;

  /** Template-schema filter metadata from the shared template resolver. */
  templateFilters?: Array<{
    key: string;
    label: string;
    placeholder?: string;
    options?: Array<{
      value: string;
      label: string;
      description?: string;
      count?: number;
    }>;
  }>;

  /** Template configuration used to build filter options when available. */
  templateConfig?: Record<string, unknown> | null;

  /** Dynamic leave type configuration from the leave module or org config. */
  leaveTypes?: string[] | null;

  /** Dynamic label for the "All" option in group/department filters. */
  groupFilterAllLabel?: string;
}

/**
 * Return value from useLeaveFilters hook.
 */
export interface UseLeaveFiltersReturn {
  // ── Current filter state ──────────────────────────────────────────────
  filters: LeaveFilterState;

  // ── Setters for individual filters ────────────────────────────────────
  setDepartment: (dept: string | null) => void;
  setType: (type: string | null) => void;
  setSearch: (query: string) => void;

  // ── Filter options for UI (dropdowns, etc.) ──────────────────────────
  departmentOptions: LeaveFilterOption[];
  typeOptions: LeaveFilterOption[];

  // ── Filtering pipeline ───────────────────────────────────────────────
  /** Leaves filtered by date range only */
  dateFilteredLeaves: PendingLeaveItem[];

  /** Leaves filtered by date + all other active filters */
  fullyFilteredLeaves: PendingLeaveItem[];

  // ── Statistics and metadata ──────────────────────────────────────────
  /** Count of leaves after date filtering (before dept/type/search) */
  dateFilteredCount: number;

  /** Count of leaves after all filtering */
  fullyFilteredCount: number;

  /**
   * Count of leaves in `fullyFilteredLeaves` that are still Pending.
   *
   * Distinct from `fullyFilteredCount`: since `filterLeavesByDateRange`
   * never excludes pending leaves on date grounds, this is the true
   * "awaiting approval" count honoring dept/type/search — never narrowed
   * by the date/period selector, matching the panel's inbox-style intent.
   */
  pendingCount: number;

  /** Is any filter currently active? */
  hasActiveFilters: boolean;

  /** Reset all filters to defaults */
  reset: () => void;

  /** CSV export metadata */
  exportMetadata: Record<string, string | undefined>;
}

/**
 * Hook for managing all leave filters.
 *
 * Combines date, branch, department, type, and search filters.
 * Provides both filter state and filtering pipeline.
 *
 * Usage:
 *   const filters = useLeaveFilters({
 *     leaves: allLeaves,
 *     dateFilter,
 *     isGlobal,
 *     selectedBranchId,
 *   });
 *
 *   // Use filters.fullyFilteredLeaves for table display
 *   // Use filters.departmentOptions for dropdown
 *   // Use filters.reset() to clear all filters
 */
export function useLeaveFilters({
  leaves,
  dateFilter,
  isGlobal,
  selectedBranchId,
  selectedPeopleType,
  initialFilters = {},
  templateFilters,
  templateConfig,
  leaveTypes,
  groupFilterAllLabel,
}: UseLeaveFiltersOptions): UseLeaveFiltersReturn {
  // ── Stateful filters (department, type, search) ────────────────────────
  // NOTE: Date filter is managed by useDateFilter hook (external)
  // NOTE: Branch filter is managed by useBranchSelector hook (external)

  // Initialize filter state with defaults + any provided initial values
  const [filterState, setFilterState] = React.useState<LeaveFilterState>({
    ...LEAVE_FILTER_DEFAULTS,
    ...initialFilters,
  });

  // ── Individual filter setters ──────────────────────────────────────────
  const setDepartment = useCallback((dept: string | null) => {
    setFilterState((prev) => ({
      ...prev,
      department: dept,
    }));
  }, []);

  const setType = useCallback((type: string | null) => {
    setFilterState((prev) => ({
      ...prev,
      type,
    }));
  }, []);

  const setSearch = useCallback((query: string) => {
    setFilterState((prev) => ({
      ...prev,
      search: query,
    }));
  }, []);

  // ── Reset function ────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setFilterState(LEAVE_FILTER_DEFAULTS);
  }, []);

  // ── Filtering pipeline (memoized for performance) ─────────────────────

  /**
   * Step 1: Filter by date range.
   * This is the base dataset for building filter options.
   */
  const dateFilteredLeaves = useMemo<PendingLeaveItem[]>(
    () => filterLeavesByDateRange(leaves, dateFilter.dates, dateFilter.mode),
    [leaves, dateFilter.dates, dateFilter.mode],
  );

  const peopleTypeScopedLeaves = useMemo<PendingLeaveItem[]>(() => {
    const normalize = (value: unknown): string =>
      String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    const aliases: Record<string, string> = {
      workers: "worker",
      employees: "employee",
      staff_members: "staff",
      staffs: "staff",
    };
    const selected =
      aliases[normalize(selectedPeopleType)] ?? normalize(selectedPeopleType);
    if (!selected || selected === "all" || selected === "__all__") {
      return dateFilteredLeaves;
    }
    return dateFilteredLeaves.filter((leave) => {
      const rowTypeRaw = normalize(
        (leave as Record<string, unknown>).peopleType ?? "staff",
      );
      const rowType = aliases[rowTypeRaw] ?? rowTypeRaw;
      return rowType === selected;
    });
  }, [dateFilteredLeaves, selectedPeopleType]);

  /**
   * Step 2: Filter options based on date-filtered data.
   * This way, options only show what's actually in the current date range.
   */
  const templateGroupFilterKey = useMemo(() => {
    const preferredKeys = ["department", "class", "section", "designation"];
    return (
      templateFilters?.find((filter) => preferredKeys.includes(filter.key))
        ?.key ?? "department"
    );
  }, [templateFilters]);

  const departmentOptions = useMemo<LeaveFilterOption[]>(
    () =>
      buildDepartmentFilterOptions(peopleTypeScopedLeaves, {
        templateConfig,
        templateFilterKey: templateGroupFilterKey,
        groupFilterAllLabel,
      }),
    [
      peopleTypeScopedLeaves,
      templateConfig,
      templateGroupFilterKey,
      groupFilterAllLabel,
    ],
  );

  const typeOptions = useMemo<LeaveFilterOption[]>(
    () => buildLeaveTypeFilterOptions(peopleTypeScopedLeaves, leaveTypes),
    [peopleTypeScopedLeaves, leaveTypes],
  );

  /**
   * Step 3: Apply all other filters (department, type, search).
   */
  const fullyFilteredLeaves = useMemo<PendingLeaveItem[]>(
    () =>
      peopleTypeScopedLeaves.filter((leave) =>
        leaveMatchesFilters(leave, filterState),
      ),
    [peopleTypeScopedLeaves, filterState],
  );

  /**
   * Step 4: Check if any filter is active.
   */
  const hasActiveFilters = useMemo<boolean>(
    () =>
      filterState.department !== null ||
      filterState.type !== null ||
      filterState.search !== "",
    [filterState],
  );

  /**
   * Step 4b: Pending count, independent of date scope (see doc comment
   * on the return type — this is what the KPI card should show).
   */
  const pendingCount = useMemo<number>(
    () =>
      fullyFilteredLeaves.filter((leave) => leave.status === "Pending").length,
    [fullyFilteredLeaves],
  );

  /**
   * Step 5: Build CSV export metadata.
   */
  const exportMetadata = useMemo<Record<string, string | undefined>>(() => {
    const branchLabel = isGlobal
      ? selectedBranchId
        ? `Branch ${selectedBranchId}`
        : "All Branches"
      : "Current Branch";

    return buildFilterMetadata(filterState, dateFilter.label, branchLabel);
  }, [filterState, dateFilter.label, isGlobal, selectedBranchId]);

  return {
    filters: filterState,
    setDepartment,
    setType,
    setSearch,
    departmentOptions,
    typeOptions,
    dateFilteredLeaves,
    fullyFilteredLeaves,
    dateFilteredCount: dateFilteredLeaves.length,
    fullyFilteredCount: fullyFilteredLeaves.length,
    pendingCount,
    hasActiveFilters,
    reset,
    exportMetadata,
  };
}
