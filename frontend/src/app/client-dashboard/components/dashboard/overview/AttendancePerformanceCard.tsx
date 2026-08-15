/**
 * AttendancePerformanceCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper: card shell + header + data-shape translation around the
 * reusable StackedSegmentBarChartCard. Visuals unchanged from the original.
 *
 * Global (branchSeries provided):
 *   Grouped + stacked bar chart — every branch appears as its own stacked
 *   column (On Time / Late / Absent) side-by-side within each month group.
 *
 * Branch scope (no branchSeries):
 *   Single stacked bar chart (On Time / Late / Absent per month).
 */

import React, { useMemo } from "react";
import StackedSegmentBarChartCard, {
  StackedBarLegend,
  type StackedSeries,
} from "../../ui/charts/StackedSegmentBarChartCard";
import type {
  AttendancePerformanceItem,
  BranchAttendanceSeries,
} from "../../../hooks/useDashboardOverviewData";

// ─── Default colours (single mode) ─────────────────────────────────────────────

const DEFAULT_ON_TIME = "#0F6E56";
const DEFAULT_LATE = "#1a699f";
const DEFAULT_ABSENT = "#B0C4CE";

const SEGMENT_LABELS = {
  segA: "On Time",
  segB: "Late",
  segC: "Absent",
} as const;

const SINGLE_COLORS = {
  segA: DEFAULT_ON_TIME,
  segB: DEFAULT_LATE,
  segC: DEFAULT_ABSENT,
} as const;

// ─── Types ─────────────────────────────────────────────────────────────────────

interface AttendancePerformanceCardProps {
  data: AttendancePerformanceItem[];
  branchSeries?: BranchAttendanceSeries[];
  action?: React.ReactNode;
}

// ─── Main component ────────────────────────────────────────────────────────────

const AttendancePerformanceCard: React.FC<AttendancePerformanceCardProps> = ({
  data,
  branchSeries,
  action,
}) => {
  const isGlobal = Array.isArray(branchSeries) && branchSeries.length > 0;

  const singleData = useMemo(
    () =>
      data.map((d) => ({
        label: d.month,
        segA: d["On Time"],
        segB: d.Late,
        segC: d.Absent,
      })),
    [data],
  );

  const multiSeries: StackedSeries[] | undefined = useMemo(() => {
    if (!isGlobal) return undefined;
    return branchSeries!.map((b) => ({
      id: b.branchId,
      name: b.branchName,
      data: b.data.map((d) => ({
        label: d.month,
        segA: d["On Time"],
        segB: d.Late,
        segC: d.Absent,
      })),
    }));
  }, [isGlobal, branchSeries]);

  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 16,
        border: "1px solid #EEF2F7",
        padding: "16px 18px 14px",
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 10,
        }}
      >
        <div>
          <p
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 700,
              color: "#1E293B",
            }}
          >
            Attendance Performance
          </p>
          {isGlobal && (
            <p
              style={{
                margin: "2px 0 0",
                fontSize: 10,
                fontWeight: 500,
                color: "#94A3B8",
              }}
            >
              All Branches · On Time / Late / Absent per branch
            </p>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <StackedBarLegend
            isGrouped={isGlobal}
            series={multiSeries}
            segmentLabels={SEGMENT_LABELS}
            colors={SINGLE_COLORS}
          />
          {action && <div>{action}</div>}
        </div>
      </div>

      {/* Chart */}
      <StackedSegmentBarChartCard
        data={isGlobal ? undefined : singleData}
        series={multiSeries}
        segmentLabels={SEGMENT_LABELS}
        colors={SINGLE_COLORS}
        singleHeight={220}
        multiHeight={200}
      />
    </div>
  );
};

export default React.memo(AttendancePerformanceCard);
