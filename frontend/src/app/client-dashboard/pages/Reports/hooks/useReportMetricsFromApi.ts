/**
 * hooks/useReportMetricsFromApi.ts — TEMPLATE (use when backend is ready)
 * ─────────────────────────────────────────────────────────────────────────────
 * Backend-powered version of useReportMetrics hook.
 *
 * This replaces the ModuleContext-based version when your backend API is ready.
 * Copy this file, fill in the API endpoint, and swap the import in Reports.tsx.
 *
 * Expected API contract:
 *   GET /api/reports/metrics?branchId=1&period=7d
 *   Returns: { branchMetrics, departmentMetrics, totals, trendData, trends }
 *
 * Usage in Reports.tsx:
 *   // Change this line:
 *   // const metrics = useReportMetrics({ staff, leave, payroll, ... });
 *   
 *   // To this:
 *   const metrics = useReportMetricsFromApi({
 *     branchFilter,
 *     period,
 *     isGlobalDashboard,
 *     allBranches,
 *     branchLookup,
 *     selectedBranchLabel,
 *   });
 *
 *   // Note: No need to pass staff/leave/payroll anymore!
 *   // They live on the backend.
 */

import { useEffect, useMemo, useState } from "react";
import type { OrgBranch } from "../../../contexts/OrgConfigContext";
import type {
  BranchMetric,
  DepartmentMetric,
  TrendPoint,
  BranchTrendPoint,
  ReportTotals,
} from "../utils/reports.metrics";

// ─── API Response Types ───────────────────────────────────────────────────────

/**
 * What the backend API returns.
 * Adjust these to match your actual API contract.
 */
export interface ReportMetricsApiResponse {
  branchMetrics: BranchMetric[];
  departmentMetrics: DepartmentMetric[];
  totals: ReportTotals;
  trendData: TrendPoint[];
  branchTrendData: BranchTrendPoint[];
  isAllBranchAdmin: boolean;
  selectedBranchLabel: string;
  meta: {
    generatedAt: string;
    durationMs: number;
  };
}

// ─── Hook Input ──────────────────────────────────────────────────────────────

export interface UseReportMetricsFromApiInput {
  branchFilter: "all" | string;
  period: "today" | "7d" | "30d" | "month" | "all";
  isGlobalDashboard: boolean;
  allBranches: OrgBranch[];
  branchLookup: Map<number, string>;
  selectedBranchLabel: string;
}

// ─── Hook Output (same as useReportMetrics) ──────────────────────────────────

export interface UseReportMetricsFromApiOutput {
  branchMetrics: BranchMetric[];
  departmentMetrics: DepartmentMetric[];
  totals: ReportTotals;
  trendData: TrendPoint[];
  branchTrendData: BranchTrendPoint[];
  isAllBranchAdmin: boolean;
  selectedBranchLabel: string;

  // ✨ New: loading/error states (from API)
  loading: boolean;
  error: Error | null;
  retry: () => void;
}

// ─── API Client ──────────────────────────────────────────────────────────────

/**
 * Wrapper around your backend API.
 * Adjust this to match your actual backend endpoint.
 *
 * Expected endpoint:
 *   GET /api/reports/metrics
 *   Query params: ?branchId=1&period=7d
 *
 * Example curl:
 *   curl https://api.example.com/api/reports/metrics?branchId=1&period=7d \
 *     -H "Authorization: Bearer TOKEN"
 */
async function fetchReportMetrics(
  branchFilter: "all" | string,
  period: "today" | "7d" | "30d" | "month" | "all",
  isGlobalDashboard: boolean
): Promise<ReportMetricsApiResponse> {
  // ─── Build query params ────────────────────────────────────────────────────
  const params = new URLSearchParams();

  // Global dashboard: pass branchId if filtering to one branch
  if (isGlobalDashboard && branchFilter !== "all") {
    params.append("branchId", branchFilter);
  }

  // Period filter
  params.append("period", period);

  // ─── Fetch from API ───────────────────────────────────────────────────────
  const response = await fetch(`/api/reports/metrics?${params.toString()}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      // Add auth header if needed:
      // "Authorization": `Bearer ${getAuthToken()}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch report metrics: ${response.status} ${response.statusText}`
    );
  }

  const data: ReportMetricsApiResponse = await response.json();
  return data;
}

// ─── Hook Implementation ──────────────────────────────────────────────────────

/**
 * useReportMetricsFromApi — fetch metrics from backend API.
 *
 * Same interface as useReportMetrics(), but data comes from API instead of
 * ModuleContext. Includes loading/error states for UX feedback.
 *
 * Performance note:
 *   - Caches result in state
 *   - Refetches when branchFilter, period, or isGlobalDashboard changes
 *   - Debounce or add a refresh button if needed
 *
 * Error handling:
 *   - Network errors → error state
 *   - User can call retry() to refetch
 *   - Component can show error banner
 *
 * Example usage in component:
 *   const { branchMetrics, loading, error, retry } = useReportMetricsFromApi(input);
 *
 *   if (loading) return <LoadingSpinner />;
 *   if (error) return <ErrorBanner message={error.message} onRetry={retry} />;
 *
 *   return <Charts data={branchMetrics} />;
 */
export function useReportMetricsFromApi(
  input: UseReportMetricsFromApiInput
): UseReportMetricsFromApiOutput {
  const {
    branchFilter,
    period,
    isGlobalDashboard,
    allBranches,
    branchLookup,
    selectedBranchLabel,
  } = input;

  // ─── State for API response and lifecycle ──────────────────────────────────
  const [data, setData] = useState<ReportMetricsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // ─── Retry mechanism (user can trigger manual refetch) ────────────────────
  const [retryCount, setRetryCount] = useState(0);

  const retry = () => {
    setRetryCount((c) => c + 1);
  };

  // ─── Fetch data when dependencies change ───────────────────────────────────
  useEffect(() => {
    let isMounted = true;

    const fetchData = async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await fetchReportMetrics(
          branchFilter,
          period,
          isGlobalDashboard
        );

        if (isMounted) {
          setData(response);
        }
      } catch (err) {
        if (isMounted) {
          setError(
            err instanceof Error
              ? err
              : new Error("Unknown error fetching report metrics")
          );
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchData();

    // Cleanup: if component unmounts, don't update state
    return () => {
      isMounted = false;
    };
  }, [branchFilter, period, isGlobalDashboard, retryCount]);

  // ─── Return data or fallback ───────────────────────────────────────────────
  const result = useMemo<UseReportMetricsFromApiOutput>(() => {
    if (data) {
      return {
        ...data,
        loading,
        error,
        retry,
      };
    }

    // Fallback when loading or error (show empty state)
    return {
      branchMetrics: [],
      departmentMetrics: [],
      totals: {
        totalStaff: 0,
        present: 0,
        late: 0,
        absent: 0,
        attended: 0,
        attendanceRate: 0,
        monthlyPayroll: 0,
        pendingLeaves: 0,
      },
      trendData: [],
      branchTrendData: [],
      isAllBranchAdmin: isGlobalDashboard && branchFilter === "all",
      selectedBranchLabel,
      loading,
      error,
      retry,
    };
  }, [data, loading, error, isGlobalDashboard, branchFilter, selectedBranchLabel]);

  return result;
}

// ─── Integration Guide ─────────────────────────────────────────────────────

/**
 * STEP-BY-STEP: How to switch from useReportMetrics to useReportMetricsFromApi
 *
 * 1. Verify backend API is ready:
 *    GET /api/reports/metrics?branchId=1&period=7d
 *    Returns 200 with response shape matching ReportMetricsApiResponse
 *
 * 2. Add this file to hooks/useReportMetricsFromApi.ts
 *    Update fetchReportMetrics() URL if needed:
 *    const response = await fetch(`YOUR_API_BASE/reports/metrics?${params}...`);
 *
 * 3. In modules/reports/index.tsx, replace imports:
 *    // OLD:
 *    // import { useReportMetrics } from "../../hooks/useReportMetrics";
 *
 *    // NEW:
 *    import { useReportMetricsFromApi } from "../../hooks/useReportMetricsFromApi";
 *
 * 4. Replace the hook call:
 *    // OLD:
 *    const metrics = useReportMetrics({
 *      staff: scopedStaff,
 *      leave: scopedLeave,
 *      payroll: scopedPayroll,
 *      activeBranchId: effectiveBranchId,
 *      allBranches,
 *      branchLookup,
 *      branchFilter,
 *      period,
 *      isGlobalDashboard,
 *    });
 *
 *    // NEW:
 *    const { loading, error, retry, ...metrics } = useReportMetricsFromApi({
 *      branchFilter,
 *      period,
 *      isGlobalDashboard,
 *      allBranches,
 *      branchLookup,
 *      selectedBranchLabel,
 *    });
 *
 * 5. Remove ModuleContext imports:
 *    // Can remove or keep for other uses:
 *    // const { staff, leave, payroll } = useModule();
 *
 * 6. Handle loading/error states:
 *    // In component, add error banner
 *    if (error) return <ErrorBanner message={error.message} onRetry={retry} />;
 *    if (loading) return <LoadingSpinner />;
 *
 * 7. Remove scopedStaff/scopedLeave/scopedPayroll logic:
 *    // These are now on backend:
 *    // const scopedStaff = isGlobalDashboard ? staff.allItems : staff.items;
 *    // (delete these)
 *
 * That's it! Reports component is now backend-powered.
 */

// ─── Testing ──────────────────────────────────────────────────────────────────

/**
 * For testing, mock the fetchReportMetrics function:
 *
 *   import * as reportApi from './useReportMetricsFromApi';
 *
 *   jest.mock('./useReportMetricsFromApi', () => ({
 *     fetchReportMetrics: jest.fn().mockResolvedValue({
 *       branchMetrics: [
 *         {
 *           branchId: 1,
 *           branchName: 'Test Branch',
 *           totalStaff: 10,
 *           present: 8,
 *           attendanceRate: 80,
 *           // ... rest of fields
 *         }
 *       ],
 *       
 *     
 */

// ─── Caching Strategy (optional, for performance) ─────────────────────────────

/**
 * If you want to cache API responses and reduce requests:
 *
 *   const cacheKey = `${branchFilter}_${period}`;
 *   const cached = reportMetricsCache.get(cacheKey);
 *
 *   if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
 *     // Cache hit: return cached data if < 5 minutes old
 *     setData(cached.data);
 *     setLoading(false);
 *     return;
 *   }
 *
 *   // Cache miss: fetch fresh data
 *   const response = await fetchReportMetrics(...);
 *   reportMetricsCache.set(cacheKey, { data: response, timestamp: Date.now() });
 */

// ─── Progressive Enhancement (optional, for better UX) ─────────────────────

/**
 * Consider these UX improvements:
 *
 * 1. Show stale data while refetching:
 *    if (error && data) {
 *      // Show previous data + error message + retry button
 *      return <StaleDataBanner data={data} error={error} onRetry={retry} />;
 *    }
 *
 * 2. Optimistic updates for filters:
 *    When user changes filter, show loading spinner immediately
 *    Instead of loading state → data → loading state → data
 *    Make it: loading spinner (instant) → data (when ready)
 *
 * 3. Debounce rapid filter changes:
 *    If user changes period/branch multiple times quickly,
 *    only fetch once after they stop changing for 500ms
 *    (use useCallback with debounce)
 */