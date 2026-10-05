/**
 * LineChartCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable line/area chart component. Drop it anywhere by passing data.
 *
 * Three display modes — automatically selected based on props:
 *
 *   1. Single series   → pass `data` only
 *      { label: string; value: number }[]
 *
 *   2. Multi series    → pass `series` only
 *      { name: string; color?: string; data: { label: string; value: number }[] }[]
 *      Each series gets its own line + gradient area.
 *
 *   3. Wrapped in card → pass `title` to get the DashboardCard shell.
 *      Omit `title` to render the bare chart (embed inside your own Card).
 *

 */

import React, { useMemo, useState, useEffect } from "react";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { T } from "../theme";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LineChartDataPoint {
  label: string;
  value: number;
}

export interface LineChartSeries {
  name: string;
  /** Optional override — falls back to SERIES_COLORS[index] */
  color?: string;
  data: LineChartDataPoint[];
}

export interface LineChartCardProps {
  // ── Data (pass one of these) ───────────────────────────────────────────
  /** Single series data */
  data?: LineChartDataPoint[];
  /** Multi series data */
  series?: LineChartSeries[];

  // ── Card shell (optional) ──────────────────────────────────────────────
  /** If provided, wraps the chart in a titled card */
  title?: string;
  /** Subtitle shown below the title */
  sub?: string;
  /** Right-side slot in the card header (e.g. a filter button) */
  action?: React.ReactNode;

  // ── Chart appearance ───────────────────────────────────────────────────
  /** Single series line/area color. Ignored when `series` is used. */
  color?: string;
  /** Chart height in px */
  height?: number;
  /** Y-axis tick formatter */
  formatY?: (value: number) => string;
  /** Tooltip value formatter */
  formatTooltip?: (value: number, name: string) => string;
  /** Show grid lines (default: true) */
  showGrid?: boolean;
  /** Fill area under line (default: true) */
  showArea?: boolean;
  /** Show dots on data points (default: false) */
  showDots?: boolean;
  /** Stroke width (default: 2.5) */
  strokeWidth?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SERIES_COLORS = [
  "#1A7A6E", // deep teal
  "#3D6B8C", // slate blue
  "#5BA3A0", // muted aqua
  "#063862", // deep navy
  "#A2B6C8", // soft steel blue
  "#8FBCBB", // light teal
  "#0E4D6B", // ocean
  "#4A8FA8", // cerulean
  "#0B9286", // teal
  "#BAE2DD", // soft mint
  "#2B4D65", // muted navy
  "#6F909A", // blue gray
] as const;

const DEFAULT_COLOR = T.teal600;
const DEFAULT_HEIGHT = 200;
const GRADIENT_PREFIX = "lcg"; // unique SVG gradient ID prefix

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSeriesColor(series: LineChartSeries, index: number): string {
  return series.color ?? SERIES_COLORS[index % SERIES_COLORS.length];
}

/** Convert single-series data to the recharts shape { label, value } */
function toChartData(data: LineChartDataPoint[]) {
  return data.map((d) => ({ label: d.label, value: d.value }));
}

/**
 * Pivot multi-series into a single flat array recharts can consume.
 * Each row is one label; each series contributes a `val_{index}` key.
 */
function pivotSeries(
  series: LineChartSeries[],
): Record<string, string | number>[] {
  if (!series.length) return [];
  const labels = series[0].data.map((d) => d.label);
  return labels.map((label, li) => {
    const row: Record<string, string | number> = { label };
    series.forEach((s, si) => {
      row[`val_${si}`] = s.data[li]?.value ?? 0;
    });
    return row;
  });
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

interface TooltipPayloadItem {
  dataKey: string;
  value: number;
  name?: string;
}

const ChartTooltip: React.FC<{
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  series?: LineChartSeries[];
  formatTooltip?: (value: number, name: string) => string;
  singleColor?: string;
}> = ({ active, payload, label, series, formatTooltip, singleColor }) => {
  if (!active || !payload?.length) return null;

  const baseStyle: React.CSSProperties = {
    background: T.card,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: "8px 12px",
    fontSize: 12,
    fontFamily: "'DM Sans', sans-serif",
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
    minWidth: 130,
  };

  return (
    <div style={baseStyle}>
      <p
        style={{
          margin: "0 0 6px",
          fontWeight: 700,
          color: T.head,
          fontSize: 11,
        }}
      >
        {label}
      </p>
      {payload.map((p, i) => {
        // Resolve name and color for this entry
        let name = p.name ?? "Value";
        let color = singleColor ?? DEFAULT_COLOR;

        if (series) {
          const match = String(p.dataKey).match(/^val_(\d+)$/);
          if (match) {
            const idx = parseInt(match[1], 10);
            const s = series[idx];
            name = s?.name ?? name;
            color = getSeriesColor(s, idx);
          }
        }

        const displayVal = formatTooltip
          ? formatTooltip(p.value, name)
          : p.value.toLocaleString();

        return (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 3,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: color,
                flexShrink: 0,
              }}
            />
            <span style={{ color: T.muted, fontSize: 11, flex: 1 }}>
              {name}
            </span>
            <span style={{ fontWeight: 700, color: T.head, fontSize: 11 }}>
              {displayVal}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// ─── Legend ───────────────────────────────────────────────────────────────────

const SeriesLegend: React.FC<{ series: LineChartSeries[] }> = ({ series }) => (
  <div
    style={{
      display: "flex",
      flexWrap: "wrap",
      gap: "6px 14px",
      marginTop: 10,
    }}
  >
    {series.map((s, i) => {
      const color = getSeriesColor(s, i);
      return (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div
            style={{ width: 18, height: 2, borderRadius: 2, background: color }}
          />
          <span
            style={{
              fontSize: 11,
              color: T.muted,
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            {s.name}
          </span>
        </div>
      );
    })}
  </div>
);

// ─── Card shell ───────────────────────────────────────────────────────────────

const CardShell: React.FC<{
  title: string;
  sub?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, sub, action, children }) => (
  <div
    style={{
      background: T.card,
      border: `1px solid ${T.border}`,
      borderRadius: 14,
      padding: "16px 20px",
      fontFamily: "'DM Sans', sans-serif",
    }}
  >
    {/* Header */}
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: 14,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.head }}>
          {title}
        </div>
        {sub && (
          <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
            {sub}
          </div>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
    {children}
  </div>
);

// ─── Core chart ───────────────────────────────────────────────────────────────

const CoreChart: React.FC<
  Required<
    Pick<
      LineChartCardProps,
      "height" | "showGrid" | "showArea" | "showDots" | "strokeWidth"
    >
  > &
    Pick<
      LineChartCardProps,
      "data" | "series" | "color" | "formatY" | "formatTooltip"
    >
> = ({
  data,
  series,
  color,
  height,
  formatY,
  formatTooltip,
  showGrid,
  showArea,
  showDots,
  strokeWidth,
}) => {
  const isMulti = Array.isArray(series) && series.length > 0;
  const lineColor = color ?? DEFAULT_COLOR;

  // Pivot / format chart data
  const chartData = useMemo(
    () => (isMulti ? pivotSeries(series!) : toChartData(data ?? [])),
    [isMulti, series, data],
  );

  // Unique stable ID seed so multiple charts on one page don't collide
  const idSeed = useMemo(
    () => `${GRADIENT_PREFIX}_${Math.random().toString(36).slice(2, 7)}`,
    [],
  );

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const defaultFmtY = (v: number) =>
    v >= 1_000_000
      ? `${(v / 1_000_000).toFixed(1)}M`
      : v >= 1_000
        ? `${Math.round(v / 1_000)}K`
        : String(v);

  const yFmt = formatY ?? defaultFmtY;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart
        data={mounted ? chartData : []}
        margin={{ top: 10, right: 8, left: 0, bottom: 4 }}
      >
        <defs>
          {isMulti ? (
            series!.map((s, i) => {
              const c = getSeriesColor(s, i);
              return (
                <linearGradient
                  key={i}
                  id={`${idSeed}_${i}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="5%" stopColor={c} stopOpacity={0.18} />
                  <stop offset="95%" stopColor={c} stopOpacity={0} />
                </linearGradient>
              );
            })
          ) : (
            <linearGradient id={`${idSeed}_single`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={lineColor} stopOpacity={0.18} />
              <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          )}
        </defs>

        {showGrid && <CartesianGrid vertical={false} stroke={T.slate100} />}

        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={{
            fontSize: 10,
            fill: T.muted,
            fontFamily: "'DM Sans', sans-serif",
          }}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{
            fontSize: 10,
            fill: T.muted,
            fontFamily: "'DM Sans', sans-serif",
          }}
          tickFormatter={yFmt}
          width={42}
        />

        <Tooltip
          content={
            <ChartTooltip
              series={isMulti ? series : undefined}
              formatTooltip={formatTooltip}
              singleColor={isMulti ? undefined : lineColor}
            />
          }
          cursor={{ stroke: T.slate100, strokeWidth: 1 }}
        />

        {isMulti ? (
          series!.map((s, i) => {
            const c = getSeriesColor(s, i);
            return (
              <Area
                key={i}
                type="monotone"
                dataKey={`val_${i}`}
                name={s.name}
                stroke={c}
                strokeWidth={strokeWidth}
                fill={showArea ? `url(#${idSeed}_${i})` : "none"}
                dot={showDots}
                isAnimationActive={true}
                animationDuration={1000}
                animationEasing="ease-out"
              />
            );
          })
        ) : (
          <Area
            type="monotone"
            dataKey="value"
            stroke={lineColor}
            strokeWidth={strokeWidth}
            fill={showArea ? `url(#${idSeed}_single)` : "none"}
            dot={showDots}
            isAnimationActive={true}
            animationDuration={1000}
            animationEasing="ease-out"
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
};

// ─── Main export ──────────────────────────────────────────────────────────────

const LineChartCard: React.FC<LineChartCardProps> = ({
  data,
  series,
  title,
  sub,
  action,
  color,
  height = DEFAULT_HEIGHT,
  formatY,
  formatTooltip,
  showGrid = true,
  showArea = true,
  showDots = false,
  strokeWidth = 2.5,
}) => {
  const isMulti = Array.isArray(series) && series.length > 0;

  const chart = (
    <>
      <CoreChart
        data={data}
        series={series}
        color={color}
        height={height}
        formatY={formatY}
        formatTooltip={formatTooltip}
        showGrid={showGrid}
        showArea={showArea}
        showDots={showDots}
        strokeWidth={strokeWidth}
      />
      {isMulti && <SeriesLegend series={series!} />}
    </>
  );

  if (title) {
    return (
      <CardShell title={title} sub={sub} action={action}>
        {chart}
      </CardShell>
    );
  }

  return <>{chart}</>;
};

export default React.memo(LineChartCard);
