import { useCallback } from "react";
import { FastScope, FastSummaryResponse, getTenantFastSummary } from "../services/performanceApi";
import { useFastQuery } from "./useFastQuery";

const EMPTY_SUMMARY: FastSummaryResponse = {
  success: true,
  cards: {
    totalStaff: 0,
    activeStaff: 0,
    totalBranches: 0,
    presentToday: 0,
    absentToday: 0,
    lateToday: 0,
    pendingLeaves: 0,
    payrollThisMonth: 0,
  },
};

export function useFastTenantSummary(scope: FastScope = {}) {
  const fetcher = useCallback(() => getTenantFastSummary(scope), [scope.clientId, scope.orgId, scope.branchId, scope.today]);

  return useFastQuery<FastSummaryResponse>(["tenant-fast-summary", scope], fetcher, {
    ttlMs: 6000,
    keepPreviousData: true,
    fallbackData: EMPTY_SUMMARY,
  });
}
