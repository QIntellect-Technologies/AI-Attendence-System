/**
 * GroupedBarChartCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable bar chart — extracted from the original WeeklyAttendanceCard design.
 *
 * Two display modes (scope-aware, same as before)
 * ─────────────────────────────────────────────────
 * 1. Single-series  (branch scope OR global with one branch selected)
 *    Data shape: { label: string; value: number }[]
 *    → one teal/navy gradient + striped bar per category (original style)
 *
 * 2. Multi-series   (global scope, "All Branches" selected)
 *    Data shape: { name: string; data: { label, value }[] }[]
 *    → grouped flat-color bars, one colour per series, legend shown.
 *
 * Visuals are byte-for-byte identical to the original WeeklyAttendanceCard
 * chart — only the data prop names / shape have been generalised so this can
 * be reused anywhere (weekly attendance, or any other category → value chart).
 *
 * This component renders ONLY the chart (+ legend when multi). It does not
 * provide the DashboardCard shell — wrap it yourself, or use
 * WeeklyAttendanceCard which does that for this specific use case.
 */

import React, { useLayoutEffect, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import ChartTooltip from "../../dashboard/overview/ChartTooltip";
import { T } from "../theme";

// ─── Palette ──────────────────────────────────────────────────────────────────
// Enough distinct colours for up to 10 series/branches. Teal is intentionally
// reserved as the "single series / total" colour (used in single mode only).

export const GROUPED_BAR_COLORS = [
  "#063862", // deep navy
  "#0B9286", // teal
  "#BAE2DD", // soft mint
  "#2B4D65", // muted navy
  "#6F909A", // blue gray
  "#A2B6C8", // soft steel blue
  "#1A7A6E", // deep teal
  "#3D6B8C", // slate blue
  "#5BA3A0", // muted aqua
  "#8FBCBB", // light teal
  "#0E4D6B", // ocean
  "#4A8FA8", // cerulean
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BarDataPoint {
  label: string;
  value: number;
}

export interface BarSeries {
  id: string | number;
  name: string;
  data: BarDataPoint[]; // one entry per label, same label order across series
}

interface GroupedBarChartCardProps {
  /** Single-series data (branch scope or filtered global) */
  data?: BarDataPoint[];
  /** Multi-series data for "All Branches" / multi-entity view */
  series?: BarSeries[];
  /** Chart height for single-series mode (default 235) */
  singleHeight?: number;
  /** Chart height for multi-series mode (default 210) */
  multiHeight?: number;
  /** Show legend above chart in multi-series mode (default true) */
  showLegend?: boolean;
}



// ─── Safe chart frame ────────────────────────────────────────────────────────
// Recharts warns when ResponsiveContainer mounts while a tab/grid is still
// width 0. Measure first, then render the chart with numeric dimensions.
const MeasuredChartFrame: React.FC<{
  height: number;
  children: React.ReactElement;
}> = ({ height, children }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const measure = () => {
      setWidth(Math.max(0, Math.floor(node.getBoundingClientRect().width)));
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{
        height,
        minHeight: height,
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      {width > 0 && height > 0 ? (
        <ResponsiveContainer width={width} height={height} debounce={50}>
          {children}
        </ResponsiveContainer>
      ) : null}
    </div>
  );
};

// ─── Single-bar shape (original style — gradient fill + navy top stripe) ──────

interface CustomBarProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  value?: number;
}

const SingleBar: React.FC<CustomBarProps> = ({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  value,
}) => {
  const stripHeight = 7;
  const radius = 0;

  return (
    <g>
      <text
        x={x + width / 2}
        y={y - 8}
        textAnchor="middle"
        fill={T.navy700}
        fontSize={12}
        fontWeight={700}
        fontFamily="'DM Sans', sans-serif"
      >
        {value?.toLocaleString()}
      </text>

      <defs>
        <linearGradient id={`singleBarGrad_${x}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={T.teal100} stopOpacity={0.95} />
          <stop offset="100%" stopColor={T.teal50} stopOpacity={0.2} />
        </linearGradient>
      </defs>

      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={radius}
        ry={radius}
        fill={`url(#singleBarGrad_${x})`}
      />

      <rect
        x={x}
        y={y}
        width={width}
        height={stripHeight}
        rx={radius}
        ry={radius}
        fill={T.navy700}
      />
      <rect
        x={x}
        y={y + stripHeight / 2}
        width={width}
        height={stripHeight / 2}
        fill={T.navy700}
      />
    </g>
  );
};

// ─── Multi-series legend ──────────────────────────────────────────────────────

export const GroupedBarLegend: React.FC<{ series: BarSeries[] }> = ({
  series,
}) => (
  <div
    style={{
      display: "flex",
      flexWrap: "wrap",
      gap: "6px 14px",
      marginBottom: 10,
      marginTop: 2,
    }}
  >
    {series.map((s, i) => (
      <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: 0,
            background: GROUPED_BAR_COLORS[i % GROUPED_BAR_COLORS.length],
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 11,
            color: T.muted,
            fontFamily: "'DM Sans', sans-serif",
            fontWeight: 500,
            whiteSpace: "nowrap",
          }}
        >
          {s.name}
        </span>
      </div>
    ))}
  </div>
);

// ─── Main component ───────────────────────────────────────────────────────────

const GroupedBarChartCard: React.FC<GroupedBarChartCardProps> = ({
  data,
  series,
  singleHeight = 235,
  multiHeight = 210,
  showLegend = true,
}) => {
  const isMulti = Array.isArray(series) && series.length > 0;

  // ── Multi-series: merge into one array keyed by label ────────────────────
  const multiChartData = React.useMemo(() => {
    if (!isMulti) return [];

    const labels = series![0].data.map((d) => d.label);

    return labels.map((label, idx) => {
      const entry: Record<string, string | number> = { label };
      series!.forEach((s) => {
        entry[s.name] = s.data[idx]?.value ?? 0;
      });
      return entry;
    });
  }, [isMulti, series]);

  const chartHeight = isMulti ? multiHeight : singleHeight;

  return (
    <>
      {isMulti && showLegend && <GroupedBarLegend series={series!} />}

      <MeasuredChartFrame height={chartHeight}>
        {isMulti ? (
            /* ── Grouped multi-series bars ── */
            <BarChart
              data={multiChartData}
              barCategoryGap="28%"
              barGap={2}
              margin={{ top: 10, right: 12, left: 0, bottom: 4 }}
            >
              <CartesianGrid
                vertical={false}
                stroke={T.slate100}
                strokeWidth={1}
              />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{
                  fontSize: 12,
                  fill: T.muted,
                  fontFamily: "'DM Sans', sans-serif",
                }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{
                  fontSize: 11,
                  fill: T.muted,
                  fontFamily: "'DM Sans', sans-serif",
                }}
              />
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ fill: "rgba(0,0,0,0.04)" }}
              />
              {series!.map((s, i) => (
                <Bar
                  key={s.id}
                  dataKey={s.name}
                  fill={GROUPED_BAR_COLORS[i % GROUPED_BAR_COLORS.length]}
                  radius={[5, 5, 0, 0]}
                  maxBarSize={28}
                />
              ))}
            </BarChart>
          ) : (
            /* ── Single-series bar (original gradient + stripe style) ── */
            <BarChart
              data={data ?? []}
              barCategoryGap="32%"
              margin={{ top: 28, right: 12, left: 0, bottom: 4 }}
            >
              <CartesianGrid
                vertical={false}
                stroke={T.slate100}
                strokeWidth={1}
              />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{
                  fontSize: 12,
                  fill: T.muted,
                  fontFamily: "'DM Sans', sans-serif",
                }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{
                  fontSize: 11,
                  fill: T.muted,
                  fontFamily: "'DM Sans', sans-serif",
                }}
              />
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ fill: "transparent" }}
              />
              <Bar dataKey="value" shape={<SingleBar />} maxBarSize={72} />
            </BarChart>
        )}
      </MeasuredChartFrame>
    </>
  );
};

export default React.memo(GroupedBarChartCard);
