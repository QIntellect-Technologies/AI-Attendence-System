/**
 * WeeklyAttendanceCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper: DashboardCard shell + data-shape translation around the
 * reusable GroupedBarChartCard. Visuals unchanged from the original.
 */

import React, { useMemo } from "react";
import DashboardCard from "./DashboardCard";
import GroupedBarChartCard, {
  type BarSeries,
} from "../../ui/charts/GroupedBarChartCard";
import type { WeeklyAttendanceItem } from "../../../hooks/useDashboardOverviewData";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BranchSeries {
  branchId: number;
  branchName: string;
  data: WeeklyAttendanceItem[]; // one entry per day
}

interface WeeklyAttendanceCardProps {
  /** Single-series data (branch scope or filtered global) */
  data?: WeeklyAttendanceItem[];
  /** Multi-series data for "All Branches" global view */
  branchSeries?: BranchSeries[];
  title?: string;
  action?: React.ReactNode;
  showBranchDropdown?: boolean; // kept for API compat, unused internally
  /** Keeps this card equal-height with PendingLeavesCard and CctvStatusCard. */
  height?: number | string;
  /** Chart body height inside the equal-height dashboard card. */
  listHeight?: number | string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function numericHeight(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ─── Main component ───────────────────────────────────────────────────────────

const WeeklyAttendanceCard: React.FC<WeeklyAttendanceCardProps> = ({
  data,
  branchSeries,
  title = "Attendance Overview",
  action,
  height = 350,
  listHeight = 260,
}) => {
  const isMulti = branchSeries && branchSeries.length > 0;
  const chartHeight = numericHeight(listHeight, 260);

  const singleData = useMemo(
    () => (data ?? []).map((d) => ({ label: d.day, value: d.count })),
    [data],
  );

  const multiSeries: BarSeries[] | undefined = useMemo(() => {
    if (!isMulti) return undefined;
    return branchSeries!.map((b) => ({
      id: b.branchId,
      name: b.branchName,
      data: b.data.map((d) => ({ label: d.day, value: d.count })),
    }));
  }, [isMulti, branchSeries]);

  return (
    <DashboardCard
      title={title}
      action={action}
      height={height}
      bodyStyle={{
        minHeight: listHeight,
        maxHeight: listHeight,
        minWidth: 0,
        width: "100%",
      }}
    >
      <GroupedBarChartCard
        data={isMulti ? undefined : singleData}
        series={multiSeries}
        singleHeight={chartHeight}
        multiHeight={Math.max(210, chartHeight - 25)}
      />
    </DashboardCard>
  );
};

export default React.memo(WeeklyAttendanceCard);
