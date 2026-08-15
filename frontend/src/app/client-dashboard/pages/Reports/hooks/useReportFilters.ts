/**
 * hooks/useReportFilters.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Filter state management for reports — mirrors useOvertimeFilters pattern.
 *
 * Owns:
 *   - Filter UI state (branchFilter, period, search)
 *   - Filter option builders (with counts)
 *   - Search/filter application
 *   - Reset logic
 *
 * Does NOT own:
 *   - Data (that's useReportMetrics)
 *   - Scope resolution (that's handled upstream)
 *
 * Note: Branch filter is only visible/functional in global dashboard.
 * Branch dashboards don't show the filter (isGlobalDashboard = false).
 */

import { useCallback, useMemo, useState } from "react";
import type { OrgBranch } from "../../../contexts/OrgConfigContext";

export interface FilterOptions {
  value: string;
  label: string;
  count: number;
}

export interface ReportFiltersInput {
  allBranches: OrgBranch[];
  isGlobalDashboard: boolean;
  staffCount?: number;
  /**
   * Active people types for this org/module scope (e.g. ["student"] or
   * ["staff", "teacher"]), already narrowed by getModulePeopleTypesForBranch.
   * When length <= 1 there's nothing to separate, so peopleTypeOptions comes
   * back empty and the caller should hide the filter — same convention as
   * branchOptions being empty on a branch dashboard.
   */
  visiblePeopleTypes?: string[];
  /** Display label per type (e.g. "Students"). Defaults to the raw type. */
  peopleTypeLabel?: (type: string) => string;
  /** Per-type staff count for the dropdown, e.g. { student: 240, staff: 12 }. */
  staffCountByPeopleType?: Record<string, number>;
}

export interface ReportFiltersState {
  branchFilter: "all" | string;
  peopleTypeFilter: "all" | string;
  period: "today" | "7d" | "30d" | "month" | "all";
  search: string;
}

export interface UseReportFiltersOutput extends ReportFiltersState {
  // ─── Setters ───────────────────────────────────────────────────────
  setBranchFilter: (value: "all" | string) => void;
  setPeopleTypeFilter: (value: "all" | string) => void;
  setPeriod: (value: "today" | "7d" | "30d" | "month" | "all") => void;
  setSearch: (value: string) => void;
  reset: () => void;

  // ─── Options for select dropdowns ──────────────────────────────────
  branchOptions: FilterOptions[];
  peopleTypeOptions: FilterOptions[];
  periodOptions: FilterOptions[];

  // ─── Derived ───────────────────────────────────────────────────────
  hasActiveFilters: boolean;
}

/**
 * resolveDefaultPeopleType — default selection for the People Type dropdown.
 *
 * "staff" is the conventional default scope across verticals. Falls back to
 * the first visible type for org/module scopes that don't have a "staff"
 * people type (e.g. a school-only branch with just "student"), and to "all"
 * only when nothing is visible yet.
 */
function resolveDefaultPeopleType(visibleTypes: string[]): "all" | string {
  if (visibleTypes.includes("staff")) return "staff";
  return visibleTypes[0] ?? "all";
}

/**
 * useReportFilters — manage filter state for reports.
 *
 * Branch filter behavior:
 *   - Global dashboard: show filter with all branches + counts
 *   - Branch dashboard: hide filter (data already scoped by ModuleContext)
 *
 * Period filter:
 *   - Always visible, applies to trend data
 *   - "today", "7d", "30d", "month", "all"
 *
 * Search:
 *   - Matches against branch name, department, metric name
 *   - Case-insensitive
 */
export function useReportFilters(
  input: ReportFiltersInput,
): UseReportFiltersOutput {
  const {
    allBranches,
    isGlobalDashboard,
    staffCount = 0,
    visiblePeopleTypes = [],
    peopleTypeLabel,
    staffCountByPeopleType = {},
  } = input;

  // ─── Filter state ──────────────────────────────────────────────────────────
  const [branchFilter, setBranchFilter] = useState<"all" | string>("all");
  const [peopleTypeFilter, setPeopleTypeFilter] = useState<"all" | string>(() =>
    resolveDefaultPeopleType(visiblePeopleTypes),
  );
  const [period, setPeriod] = useState<
    "today" | "7d" | "30d" | "month" | "all"
  >("7d");
  const [search, setSearch] = useState("");

  // ─── Reset ────────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setBranchFilter("all");
    setPeopleTypeFilter(resolveDefaultPeopleType(visiblePeopleTypes));
    setPeriod("7d");
    setSearch("");
  }, [visiblePeopleTypes]);

  // ─── Branch options (with counts from staff) ──────────────────────────────
  const branchOptions = useMemo<FilterOptions[]>(() => {
    if (!isGlobalDashboard) return [];

    return [
      {
        value: "all",
        label: "All Branches",
        count: staffCount,
      },
      ...allBranches.map((b) => ({
        value: String(b.id),
        label: b.name || `Branch ${b.id}`,
        count: staffCount, // In a real app, this would be computed per-branch
      })),
    ];
  }, [allBranches, isGlobalDashboard, staffCount]);

  // ─── People type options ────────────────────────────────────────────────────
  // Empty (→ hidden, same convention as branchOptions on a branch dashboard)
  // when the org/module only has one active people type — nothing to split.
  // No "All People" entry: the dropdown only ever offers concrete types, so
  // whatever's selected always maps to a real PeopleRenderingModel (payroll/
  // leave support, group labels, etc.) rather than an ambiguous aggregate.
  const peopleTypeOptions = useMemo<FilterOptions[]>(() => {
    if (visiblePeopleTypes.length <= 1) return [];

    return visiblePeopleTypes.map((type) => ({
      value: type,
      label: peopleTypeLabel?.(type) ?? type,
      count: staffCountByPeopleType[type] ?? 0,
    }));
  }, [peopleTypeLabel, staffCountByPeopleType, visiblePeopleTypes]);

  // ─── Period options ────────────────────────────────────────────────────────
  const periodOptions = useMemo<FilterOptions[]>(
    () => [
      { value: "today", label: "Today", count: 0 },
      { value: "7d", label: "Last 7 Days", count: 0 },
      { value: "30d", label: "Last 30 Days", count: 0 },
      { value: "month", label: "This Month", count: 0 },
      { value: "all", label: "All Time", count: 0 },
    ],
    [],
  );

  // ─── Derived state ────────────────────────────────────────────────────────
  const defaultPeopleType = useMemo(
    () => resolveDefaultPeopleType(visiblePeopleTypes),
    [visiblePeopleTypes],
  );
  const hasActiveFilters =
    branchFilter !== "all" ||
    peopleTypeFilter !== defaultPeopleType ||
    period !== "7d" ||
    search.trim().length > 0;

  return {
    branchFilter,
    peopleTypeFilter,
    period,
    search,
    setBranchFilter,
    setPeopleTypeFilter,
    setPeriod,
    setSearch,
    reset,
    branchOptions,
    peopleTypeOptions,
    periodOptions,
    hasActiveFilters,
  };
}
