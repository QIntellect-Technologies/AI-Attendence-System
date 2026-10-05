/**
 * usePaidPayrollTrends.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Monthly paid-payroll history for the Dashboard Overview "Payroll Trends" card.
 *
 * Why this exists: the overview used to plot `payrollTrends` from the
 * /api/v2/dashboard/overview snapshot, which does not read the paid payroll
 * snapshots the Payroll page uses — so the card stayed flat at 0 even after
 * payroll had been processed. This hook calls the SAME endpoint as the Payroll
 * page's trend card (`/payroll/monthly-trends`, via getPaidPayrollMonthlyTrends)
 * with the same branch-id resolution, so both pages always show the same numbers.
 *
 * The window is whatever the endpoint returns for the anchor month (the current
 * month). Months with no paid payroll are kept as 0 so the x-axis stays stable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../contexts/OrgConfigContext";
import { getBackendBranchId, getUiBranchId } from "../utils/tenantScope";
import {
    getPaidPayrollMonthlyTrends,
    type PaidPayrollMonthlyTrends,
} from "../pages/Payroll/api/payrollApi";
import type {
    BranchPayrollSeries,
    PayrollTrendItem,
} from "./useDashboardOverviewData";

function currentMonthKey(now: Date = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
    return new Date(`${month}-01T00:00:00`).toLocaleDateString("en-US", {
        month: "short",
    });
}

export function usePaidPayrollTrends(args: {
    /** UI branch id; omit / null for "All branches". */
    branchId?: number | string | null;
    peopleType?: string | null;
    enabled?: boolean;
}) {
    const { branchId, peopleType, enabled = true } = args;
    const { cfg, organizationId } = useOrg();

    const [trend, setTrend] = useState<PaidPayrollMonthlyTrends | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const reqId = useRef(0);

    const anchorMonth = currentMonthKey();

    // Identical resolution to PayrollModule's `trendBranchId`.
    const trendBranchId = useMemo<string | null>(() => {
        if (branchId === undefined || branchId === null || branchId === "") {
            return null;
        }
        const branch = cfg.branches.find(
            (item) => Number(item.id) === Number(branchId),
        );
        return branch
            ? (getBackendBranchId(branch) ?? String(branch.id))
            : String(branchId);
    }, [cfg.branches, branchId]);

    const load = useCallback(async () => {
        if (!enabled || !organizationId) return;
        const id = ++reqId.current;
        setLoading(true);
        try {
            const response = await getPaidPayrollMonthlyTrends({
                organizationId,
                anchorMonth,
                branchId: trendBranchId,
                peopleType: peopleType || null,
            });
            if (id !== reqId.current) return;
            setTrend(response);
            setError(null);
        } catch (err) {
            if (id !== reqId.current) return;
            setTrend(null);
            setError(
                err instanceof Error ? err.message : "Unable to load payroll trends.",
            );
        } finally {
            if (id === reqId.current) setLoading(false);
        }
    }, [enabled, organizationId, anchorMonth, trendBranchId, peopleType]);

    useEffect(() => {
        void load();
        const onChange = () => void load();
        window.addEventListener("orgDataChanged", onChange);
        return () => window.removeEventListener("orgDataChanged", onChange);
    }, [load]);

    const { totals, byBranch } = useMemo(() => {
        if (!trend) {
            return {
                totals: [] as PayrollTrendItem[],
                byBranch: [] as BranchPayrollSeries[],
            };
        }

        const months = [...trend.months].sort();

        // branch_id → month → payroll (summed, in case a branch has >1 row/month)
        const perBranch = new Map<string, Map<string, number>>();
        for (const row of trend.rows) {
            const key = String(row.branch_id);
            let monthsMap = perBranch.get(key);
            if (!monthsMap) perBranch.set(key, (monthsMap = new Map()));
            monthsMap.set(
                row.month,
                (monthsMap.get(row.month) ?? 0) + Number(row.payroll || 0),
            );
        }

        const totals: PayrollTrendItem[] = months.map((month) => {
            let sum = 0;
            for (const monthsMap of perBranch.values()) {
                sum += monthsMap.get(month) ?? 0;
            }
            return { month: monthLabel(month), Payroll: sum, Overtime: 0 };
        });

        const byBranch: BranchPayrollSeries[] = Array.from(perBranch.entries()).map(
            ([id, monthsMap], index) => {
                const branch = cfg.branches.find(
                    (item) => (getBackendBranchId(item) ?? String(item.id)) === id,
                );
                const data: PayrollTrendItem[] = months.map((month) => ({
                    month: monthLabel(month),
                    Payroll: monthsMap.get(month) ?? 0,
                    Overtime: 0,
                }));
                return {
                    branchId: getUiBranchId(branch) ?? index + 1,
                    branchName:
                        branch?.name ?? (id === "unknown" ? "Other" : `Branch ${id}`),
                    totalPayroll: data.reduce((sum, item) => sum + item.Payroll, 0),
                    data,
                };
            },
        );

        return { totals, byBranch };
    }, [trend, cfg.branches]);

    return {
        /** True once a response has been received (even if every month is 0). */
        ready: trend !== null,
        /** True before the first response while a request is expected/in flight. */
        pending: enabled && Boolean(organizationId) && trend === null && !error,
        loading,
        error,
        /** One point per month, all branches summed — for the single-series chart. */
        totals,
        /** One series per branch that has paid payroll — for the "All Branches" chart. */
        byBranch,
        refresh: load,
    };
}

export default usePaidPayrollTrends;