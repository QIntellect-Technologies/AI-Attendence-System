/**
 * src/modules/overtime/hooks/useOvertimeFilters.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized overtime filter + sort state management.
 *
 * Important:
 * - This hook keeps ModuleContext's OvertimeRequest as the single source type.
 * - Backend/API aliases are read through a small typed adapter layer instead of
 *   adding fake fields to OvertimeRequest or using `any`.
 * - The returned arrays remain OvertimeRequest[], so existing callers are not
 *   forced to change.
 */

import { useCallback, useMemo, useState } from "react";
import type { OvertimeRequest } from "../../../contexts/ModuleContext";
import type {
  BranchOption,
  OvertimeFilterOption,
  OvertimeFilterState,
  SortDir,
  SortKey,
} from "../types/overtime";
import { OVERTIME_FILTER_DEFAULTS } from "../types/overtime";
import {
  buildBranchFilterOptions,
  buildDepartmentFilterOptions,
  buildStatusFilterOptions,
  overtimeMatchesFilters,
} from "../config/overtime-filters";

export interface UseOvertimeFiltersOptions {
  /** Requests already scoped to the active branch/route (global = unscoped) */
  scopedRequests: OvertimeRequest[];
  branches: BranchOption[];
  isGlobalDashboard: boolean;
}

export interface UseOvertimeFiltersReturn {
  // ── Filter state ─────────────────────────────────────────────────────
  filters: OvertimeFilterState;
  query: string;
  sortKey: SortKey;
  sortDir: SortDir;

  // ── Setters ──────────────────────────────────────────────────────────
  setQuery: (value: string) => void;
  setBranch: (value: string) => void;
  setStatus: (value: OvertimeFilterState["status"]) => void;
  setDepartment: (value: string) => void;
  setPeriod: (value: OvertimeFilterState["period"]) => void;
  setHours: (value: OvertimeFilterState["hours"]) => void;
  setCustomFrom: (value: string) => void;
  setCustomTo: (value: string) => void;
  setSortKey: (value: SortKey) => void;
  setSortDir: (value: SortDir) => void;

  // ── Filter options for UI dropdowns ─────────────────────────────────
  branchOptions: OvertimeFilterOption[];
  departmentOptions: OvertimeFilterOption[];
  statusOptions: OvertimeFilterOption[];

  // ── Filtering pipeline ───────────────────────────────────────────────
  /** scopedRequests narrowed by the branch dropdown (global dashboard only) */
  branchFilteredRequests: OvertimeRequest[];
  /** branchFilteredRequests + every other active filter, sorted */
  filteredRequests: OvertimeRequest[];

  hasActiveFilters: boolean;
  reset: () => void;
}

type ComparableSortValue = string | number;

type OvertimeRequestSortAliases = OvertimeRequest & {
  // canonical/backend date aliases
  date?: unknown;
  otDate?: unknown;
  ot_date?: unknown;

  // canonical/backend employee aliases
  staffName?: unknown;
  employeeName?: unknown;
  userName?: unknown;
  user_name?: unknown;
  name?: unknown;

  // canonical/backend applied/created aliases
  appliedOn?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  updatedAt?: unknown;
  updated_at?: unknown;

  // branch aliases
  branchName?: unknown;
  branch_name?: unknown;
};

function sortableSource(request: OvertimeRequest): OvertimeRequestSortAliases {
  return request as OvertimeRequestSortAliases;
}

function toText(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstText(
  request: OvertimeRequest,
  keys: Array<keyof OvertimeRequestSortAliases>,
): string {
  const source = sortableSource(request);

  for (const key of keys) {
    const value = toText(source[key]).trim();
    if (value) return value;
  }

  return "";
}

function sortValueFor(
  request: OvertimeRequest,
  key: SortKey,
): ComparableSortValue {
  const source = sortableSource(request);

  switch (key) {
    case "date":
      return firstText(request, ["date", "otDate", "ot_date"]);

    case "employee":
      return firstText(request, [
        "staffName",
        "employeeName",
        "userName",
        "user_name",
        "name",
      ]);

    case "hours":
      return toNumber(source.hours);

    case "status":
      return toText(source.status);

    case "appliedOn":
      return firstText(request, [
        "appliedOn",
        "createdAt",
        "created_at",
        "updatedAt",
        "updated_at",
      ]);

    case "branch":
      return firstText(request, ["branchName", "branch_name"]);

    default:
      return "";
  }
}

function compareOvertimeRequests(
  a: OvertimeRequest,
  b: OvertimeRequest,
  sortKey: SortKey,
  sortDir: SortDir,
): number {
  const av = sortValueFor(a, sortKey);
  const bv = sortValueFor(b, sortKey);

  if (typeof av === "number" && typeof bv === "number") {
    return sortDir === "asc" ? av - bv : bv - av;
  }

  const result = String(av).localeCompare(String(bv), undefined, {
    numeric: true,
    sensitivity: "base",
  });

  return sortDir === "asc" ? result : -result;
}

export function useOvertimeFilters({
  scopedRequests,
  branches,
  isGlobalDashboard,
}: UseOvertimeFiltersOptions): UseOvertimeFiltersReturn {
  const [filters, setFilters] = useState<OvertimeFilterState>(
    OVERTIME_FILTER_DEFAULTS,
  );
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // ── Individual setters ─────────────────────────────────────────────
  const setBranch = useCallback(
    (value: string) => setFilters((prev) => ({ ...prev, branch: value })),
    [],
  );
  const setStatus = useCallback(
    (value: OvertimeFilterState["status"]) =>
      setFilters((prev) => ({ ...prev, status: value })),
    [],
  );
  const setDepartment = useCallback(
    (value: string) => setFilters((prev) => ({ ...prev, department: value })),
    [],
  );
  const setPeriod = useCallback(
    (value: OvertimeFilterState["period"]) =>
      setFilters((prev) => ({ ...prev, period: value })),
    [],
  );
  const setHours = useCallback(
    (value: OvertimeFilterState["hours"]) =>
      setFilters((prev) => ({ ...prev, hours: value })),
    [],
  );
  const setCustomFrom = useCallback(
    (value: string) => setFilters((prev) => ({ ...prev, customFrom: value })),
    [],
  );
  const setCustomTo = useCallback(
    (value: string) => setFilters((prev) => ({ ...prev, customTo: value })),
    [],
  );

  const reset = useCallback(() => {
    setFilters(OVERTIME_FILTER_DEFAULTS);
    setQuery("");
    setSortKey("date");
    setSortDir("desc");
  }, []);

  // ── Step 1: branch dropdown narrows scopedRequests (global view only) ──
  const branchFilteredRequests = useMemo<OvertimeRequest[]>(() => {
    if (!isGlobalDashboard || filters.branch === "all") return scopedRequests;

    const selectedBranchId = Number(filters.branch);
    if (!Number.isFinite(selectedBranchId)) return scopedRequests;

    return scopedRequests.filter((request) => {
      const source = sortableSource(request);
      return toNumber(source.branchId) === selectedBranchId;
    });
  }, [scopedRequests, isGlobalDashboard, filters.branch]);

  // ── Step 2: options derived from the already-scoped data ───────────────
  const branchOptions = useMemo(
    () => buildBranchFilterOptions(branches, scopedRequests),
    [branches, scopedRequests],
  );
  const departmentOptions = useMemo(
    () => buildDepartmentFilterOptions(branchFilteredRequests),
    [branchFilteredRequests],
  );
  const statusOptions = useMemo(
    () => buildStatusFilterOptions(branchFilteredRequests),
    [branchFilteredRequests],
  );

  // ── Step 3: remaining filters + sort ────────────────────────────────────
  const filteredRequests = useMemo<OvertimeRequest[]>(() => {
    const filtered = branchFilteredRequests.filter((request) =>
      overtimeMatchesFilters(request, filters, query),
    );

    return [...filtered].sort((a, b) =>
      compareOvertimeRequests(a, b, sortKey, sortDir),
    );
  }, [branchFilteredRequests, filters, query, sortKey, sortDir]);

  // ── Step 4: active-filter flag ───────────────────────────────────────
  const hasActiveFilters = useMemo<boolean>(
    () =>
      filters.branch !== "all" ||
      filters.status !== "all" ||
      filters.department !== "all" ||
      filters.period !== "all" ||
      filters.hours !== "all" ||
      query.trim() !== "",
    [filters, query],
  );

  return {
    filters,
    query,
    sortKey,
    sortDir,
    setQuery,
    setBranch,
    setStatus,
    setDepartment,
    setPeriod,
    setHours,
    setCustomFrom,
    setCustomTo,
    setSortKey,
    setSortDir,
    branchOptions,
    departmentOptions,
    statusOptions,
    branchFilteredRequests,
    filteredRequests,
    hasActiveFilters,
    reset,
  };
}

export default useOvertimeFilters;
