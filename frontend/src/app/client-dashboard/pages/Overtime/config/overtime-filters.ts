/**
 * src/modules/overtime/config/overtime-filters.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DRY filter configuration for OvertimeManagement.
 *
 * Mirrors leave/config/leave-filters.ts's role for the leave module:
 * the single-predicate matcher + option-builders live here, separate from
 * the stateful hook (useOvertimeFilters.ts), so the matching logic can be
 * unit-tested without React.
 */

import type { OvertimeRequest } from "../../../contexts/ModuleContext";
import type {
  BranchOption,
  OvertimeFilterOption,
  OvertimeFilterState,
} from "../types/overtime";
import {
  isWithinPeriod,
  matchesHoursFilter,
  uniqueOptions,
} from "../utils/overtime.utils";

// ─── Single predicate — true if a request passes every active filter ────────
// (branch is handled separately by the caller, since it has two distinct
// scoping rules — see useOvertimeFilters — but department/status/period/
// hours/search all live here as one composable check.)

export function overtimeMatchesFilters(
  request: OvertimeRequest,
  filters: OvertimeFilterState,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();

  const matchesQuery =
    !q ||
    request.staffName.toLowerCase().includes(q) ||
    request.staffId.toLowerCase().includes(q) ||
    request.department.toLowerCase().includes(q) ||
    request.task.toLowerCase().includes(q) ||
    request.branchName.toLowerCase().includes(q);

  return (
    matchesQuery &&
    (filters.status === "all" || request.status === filters.status) &&
    (filters.department === "all" ||
      request.department === filters.department) &&
    isWithinPeriod(
      request,
      filters.period,
      filters.customFrom,
      filters.customTo,
    ) &&
    matchesHoursFilter(request, filters.hours)
  );
}

// ─── Option builders (counts derived from the dataset passed in) ────────────

export function buildBranchFilterOptions(
  branches: BranchOption[],
  scopedRequests: OvertimeRequest[],
): OvertimeFilterOption[] {
  return [
    { value: "all", label: "All Branches", count: scopedRequests.length },
    ...branches.map((b) => ({
      value: String(b.id),
      label: b.name,
      count: scopedRequests.filter((r) => r.branchId === b.id).length,
    })),
  ];
}

export function buildDepartmentFilterOptions(
  requests: OvertimeRequest[],
): OvertimeFilterOption[] {
  const depts = uniqueOptions(
    requests.map((r) => r.department || "Unassigned"),
  );
  return [
    { value: "all", label: "All Departments", count: requests.length },
    ...depts.map((dept) => ({
      value: dept,
      label: dept,
      count: requests.filter((r) => r.department === dept).length,
    })),
  ];
}

export function buildStatusFilterOptions(
  requests: OvertimeRequest[],
): OvertimeFilterOption[] {
  return (["all", "Pending", "Approved", "Rejected"] as const).map((s) => ({
    value: s,
    label: s === "all" ? "All Status" : s,
    count:
      s === "all"
        ? requests.length
        : requests.filter((r) => r.status === s).length,
  }));
}
