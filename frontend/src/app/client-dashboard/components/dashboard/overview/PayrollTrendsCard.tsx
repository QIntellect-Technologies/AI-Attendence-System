/**
 * PayrollTrendsCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Refactored to use the shared LineChartCard component.
 *
 * Two display modes — automatically selected based on props:
 *
 *   1. Single-series  (branch scope OR global with one branch selected)
 *      Props: `data` only → teal Payroll area
 *
 *   2. Global "All Branches"
 *      Props: `branchSeries` → one area per branch, BRANCH_COLORS palette
 *
 * All chart rendering is now delegated to LineChartCard.
 * This file only handles data-shape translation + the DashboardCard wrapper.
 */

import React from "react";
import DashboardCard from "./DashboardCard";
import LineChartCard from "../../ui/charts/LineChartCard";
import { T } from "../../ui/theme";
import type {
  PayrollTrendItem,
  BranchPayrollSeries,
} from "../../../hooks/useDashboardOverviewData";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PayrollTrendsCardProps {
  data: PayrollTrendItem[];
  branchSeries?: BranchPayrollSeries[];
  action?: React.ReactNode;
}

// ─── Y-axis / tooltip formatter ───────────────────────────────────────────────

const fmtPayroll = (v: number): string =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
      ? `${Math.round(v / 1_000)}K`
      : v.toLocaleString();

// ─── Main component ───────────────────────────────────────────────────────────

const PayrollTrendsCard: React.FC<PayrollTrendsCardProps> = ({
  data,
  branchSeries,
  action,
}) => {
  const isGlobal = Array.isArray(branchSeries) && branchSeries.length > 0;

  // ── Single-series shape ───────────────────────────────────────────────────
  // PayrollTrendItem[] → LineChartDataPoint[]
  const singleData = data.map((d) => ({
    label: d.month,
    value: d.Payroll,
  }));

  // ── Multi-series shape ────────────────────────────────────────────────────
  // BranchPayrollSeries[] → LineChartSeries[]
  const multiSeries = isGlobal
    ? branchSeries!.map((b) => ({
        name: b.branchName,
        data: b.data.map((d) => ({
          label: d.month,
          value: d.Payroll,
        })),
      }))
    : undefined;

  return (
    <DashboardCard
      title="Payroll Trends"
      action={action}
      height={300}
      bodyStyle={{ minHeight: 220, minWidth: 0, width: "100%" }}
    >
      {isGlobal && (
        <p
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: T.muted,
            fontFamily: "'DM Sans', sans-serif",
            marginBottom: 6,
            letterSpacing: "0.02em",
          }}
        >
          All Branches · Payroll per branch
        </p>
      )}

      {/* LineChartCard renders the chart + legend — no title since DashboardCard owns the header */}
      <LineChartCard
        data={isGlobal ? undefined : singleData}
        series={multiSeries}
        color={T.teal600}
        height={isGlobal ? 190 : 220}
        formatY={fmtPayroll}
        formatTooltip={fmtPayroll}
        showGrid
        showArea
        showDots={false}
        strokeWidth={2.5}
      />
    </DashboardCard>
  );
};

export default React.memo(PayrollTrendsCard);
