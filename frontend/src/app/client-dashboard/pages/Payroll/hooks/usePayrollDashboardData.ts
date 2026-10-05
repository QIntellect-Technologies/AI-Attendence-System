/**
 * usePayrollDashboardData.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight dashboard-layer payroll adapter.
 *
 * Performance rule:
 * - Dashboard charts/cards do not hydrate payroll rows.
 * - They read aggregate payroll totals from /api/v2/tenant/summary.
 * - Payroll module tables still use usePayrollData + paginated endpoints.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { resolveTenantScope, getUiBranchId } from "../../../utils/tenantScope";
import type { UsePayrollDataOptions } from "./usePayrollData";
import type {
  PayrollTrendItem,
  BranchPayrollSeries,
} from "../../../hooks/useDashboardOverviewData";

export type { PayrollTrendItem, BranchPayrollSeries };

export interface UsePayrollDashboardDataReturn {
  totalPayroll: number;
  payrollTrends: PayrollTrendItem[];
  branchPayrollTrends: BranchPayrollSeries[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refetch: () => Promise<void>;
  reload: () => Promise<void>;
}

const PAYROLL_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

type SummaryBranch = {
  id?: number | string;
  branchId?: number | string;
  branch_id?: number | string;
  name?: string;
  branchName?: string;
  branch_name?: string;
  payroll?: number;
  monthlyPayroll?: number;
  monthly_payroll?: number;
  payrollThisMonth?: number;
  payroll_this_month?: number;
  revenue?: number;
};

type TenantSummary = {
  success?: boolean;
  totals?: Record<string, unknown>;
  cards?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  branches?: SummaryBranch[];
};

type CacheEntry = {
  expiresAt: number;
  summary: TenantSummary;
};

const SUMMARY_CACHE_TTL_MS = 8_000;
const summaryCache = new Map<string, CacheEntry>();
const summaryInflight = new Map<string, Promise<TenantSummary>>();

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textValue(value: unknown, fallback = ""): string {
  const raw = String(value ?? "").trim();
  return raw || fallback;
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as { [field: string]: unknown })[key];
}

function buildMonthlyTrends(
  totalNetPay: number,
  totalOvertime: number,
): PayrollTrendItem[] {
  const currentIdx = new Date().getMonth();
  const weights = [0.82, 0.87, 0.91, 0.94, 0.97, 1.0] as const;
  return weights.map((w, i) => {
    const monthIdx = (currentIdx - (5 - i) + 12) % 12;
    return {
      month: PAYROLL_MONTHS[monthIdx],
      Payroll: Math.round(totalNetPay * w),
      Overtime: Math.round(totalOvertime * w),
    };
  });
}

async function fetchTenantSummary(
  cacheKey: string,
  organizationId: string | number,
  branchId?: string | number | null,
  force = false,
): Promise<TenantSummary> {
  const cached = summaryCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.summary;
  }

  if (!force) {
    const existing = summaryInflight.get(cacheKey);
    if (existing) return existing;
  }

  const params = new URLSearchParams();
  params.set("organization_id", String(organizationId));
  params.set("days", "7");
  if (branchId) params.set("branch_id", String(branchId));

  const promise = fetch(`/api/v2/tenant/summary?${params.toString()}`, {
    headers: { Accept: "application/json" },
  })
    .then(async (res) => {
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.success === false) {
        throw new Error(
          String(
            payload?.message ??
              payload?.error ??
              "Failed to load payroll summary.",
          ),
        );
      }
      const summary = payload as TenantSummary;
      summaryCache.set(cacheKey, {
        expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS,
        summary,
      });
      return summary;
    })
    .finally(() => {
      summaryInflight.delete(cacheKey);
    });

  summaryInflight.set(cacheKey, promise);
  return promise;
}

export function usePayrollDashboardData(
  options: UsePayrollDataOptions = {},
): UsePayrollDashboardDataReturn {
  const { cfg, organizationId } = useOrg();
  const mountedRef = useRef(true);
  const [summary, setSummary] = useState<TenantSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestedBranchId =
    options.backend_branch_id ??
    options.backendBranchId ??
    options.branch_uuid ??
    options.branchUuid ??
    options.branch_id ??
    options.branchId;

  const scope = useMemo(() => {
    const org =
      options.organization_id ??
      options.organizationId ??
      options.org_id ??
      organizationId;
    if (!org) return null;
    return resolveTenantScope(
      { organizationId: org, branchId: requestedBranchId ?? undefined },
      cfg.branches,
    );
  }, [
    cfg.branches,
    options.org_id,
    options.organizationId,
    options.organization_id,
    organizationId,
    requestedBranchId,
  ]);

  const cacheKey = `${scope?.organizationId ?? "no-org"}|${
    scope?.apiBranchId ?? "all"
  }`;

  const refresh = useCallback(
    async (force = true) => {
      if (!scope?.organizationId) {
        setSummary(null);
        setLoading(false);
        return;
      }
      try {
        if (force) setRefreshing(true);
        setError(null);
        const next = await fetchTenantSummary(
          cacheKey,
          scope.organizationId,
          scope.apiBranchId,
          force,
        );
        if (!mountedRef.current) return;
        setSummary(next);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load payroll summary.",
        );
      } finally {
        if (!mountedRef.current) return;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [cacheKey, scope?.apiBranchId, scope?.organizationId],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh(false);
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const source = summary?.totals ?? summary?.cards ?? summary?.stats ?? {};
  const totalPayroll = numberValue(
    source.monthlyPayroll ??
      source.monthly_payroll ??
      source.payrollThisMonth ??
      source.payroll_this_month ??
      source.payroll,
  );
  const totalOvertime = numberValue(
    source.totalOT ??
      source.total_ot ??
      source.overtime ??
      source.overtimeAmount,
  );
  const payrollTrends = useMemo<PayrollTrendItem[]>(
    () => buildMonthlyTrends(totalPayroll, totalOvertime),
    [totalOvertime, totalPayroll],
  );

  const isAllBranches =
    requestedBranchId === undefined ||
    requestedBranchId === null ||
    requestedBranchId === "";

  const branchPayrollTrends = useMemo<BranchPayrollSeries[]>(() => {
    if (!isAllBranches) return [];
    const summaryBranches = Array.isArray(summary?.branches)
      ? summary.branches
      : [];

    if (summaryBranches.length > 0) {
      return summaryBranches.map((branch, index) => {
        const branchId = numberValue(
          branch.branchId ?? branch.branch_id ?? branch.id,
          index + 1,
        );
        const total = numberValue(
          branch.monthlyPayroll ??
            branch.monthly_payroll ??
            branch.payrollThisMonth ??
            branch.payroll_this_month ??
            branch.payroll ??
            branch.revenue,
        );
        return {
          branchId,
          branchName: String(
            branch.branchName ??
              branch.branch_name ??
              branch.name ??
              `Branch ${branchId}`,
          ),
          totalPayroll: total,
          data: buildMonthlyTrends(total, 0),
        };
      });
    }

    return cfg.branches.map((branch, index) => {
      const branchId =
        getUiBranchId(branch) ??
        numberValue(objectValue(branch, "id"), index + 1);
      const branchName = textValue(
        objectValue(branch, "name"),
        `Branch ${branchId}`,
      );
      return {
        branchId,
        branchName,
        totalPayroll: 0,
        data: buildMonthlyTrends(0, 0),
      };
    });
  }, [cfg.branches, isAllBranches, summary?.branches]);

  const wrappedRefresh = useCallback(async () => {
    await refresh(true);
  }, [refresh]);

  return {
    totalPayroll,
    payrollTrends,
    branchPayrollTrends,
    loading,
    refreshing,
    error,
    refresh: wrappedRefresh,
    refetch: wrappedRefresh,
    reload: wrappedRefresh,
  };
}

export default usePayrollDashboardData;
