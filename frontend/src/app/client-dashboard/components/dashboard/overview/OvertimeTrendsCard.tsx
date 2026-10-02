/**
 * OvertimeTrendsCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders overtime cost trends across months using the shared LineChartCard.
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

interface OvertimeTrendsCardProps {
  data: PayrollTrendItem[];
  branchSeries?: BranchPayrollSeries[];
  action?: React.ReactNode;
}

// ─── Y-axis / tooltip formatter ───────────────────────────────────────────────

const fmtOvertime = (v: number): string =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
      ? `${Math.round(v / 1_000)}K`
      : v.toLocaleString();

// ─── Main component ───────────────────────────────────────────────────────────

const OvertimeTrendsCard: React.FC<OvertimeTrendsCardProps> = ({
  data,
  branchSeries,
  action,
}) => {
  const isGlobal = Array.isArray(branchSeries) && branchSeries.length > 0;

  // ── Single-series shape ───────────────────────────────────────────────────
  const singleData = data.map((d) => ({
    label: d.month,
    value: d.Overtime,
  }));

  // ── Multi-series shape ────────────────────────────────────────────────────
  const multiSeries = isGlobal
    ? branchSeries!.map((b) => ({
        name: b.branchName,
        data: b.data.map((d) => ({
          label: d.month,
          value: d.Overtime,
        })),
      }))
    : undefined;

  return (
    <DashboardCard
      title="Overtime Trends"
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
          All Branches · Overtime per branch
        </p>
      )}

      {/* Renders in Amber for contrast with the teal Payroll chart */}
      <LineChartCard
        data={isGlobal ? undefined : singleData}
        series={multiSeries}
        color={T.amber}
        height={isGlobal ? 190 : 220}
        formatY={fmtOvertime}
        formatTooltip={fmtOvertime}
        showGrid
        showArea
        showDots={false}
        strokeWidth={2.5}
      />
    </DashboardCard>
  );
};

export default React.memo(OvertimeTrendsCard);
