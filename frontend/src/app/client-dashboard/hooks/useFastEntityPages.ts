import { FastScope } from "../services/performanceApi";
import { useServerPage } from "./useServerPage";

export function useFastStaffPage(scope: FastScope = {}) {
  return useServerPage<any>({ entity: "staff", ...scope, initialPageSize: 50, initialSortBy: "name" });
}

export function useFastAttendancePage(scope: FastScope = {}) {
  return useServerPage<any>({ entity: "attendance", ...scope, initialPageSize: 50, initialSortBy: "created_at", initialSortDir: "desc" });
}

export function useFastPayrollPage(scope: FastScope = {}) {
  return useServerPage<any>({ entity: "payroll", ...scope, initialPageSize: 50, initialSortBy: "created_at", initialSortDir: "desc" });
}

export function useFastLeavesPage(scope: FastScope = {}) {
  return useServerPage<any>({ entity: "leaves", ...scope, initialPageSize: 50, initialSortBy: "created_at", initialSortDir: "desc" });
}

export function useFastBranchesPage(scope: FastScope = {}) {
  return useServerPage<any>({ entity: "branches", ...scope, initialPageSize: 50, initialSortBy: "name" });
}
