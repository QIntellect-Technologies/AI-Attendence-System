/**
 * StackedSegmentBarChartCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable bar chart — extracted from the original AttendancePerformanceCard
 * design. Renders 3-segment stacked bars (e.g. On Time / Late / Absent) with
 * rounded-corner gapped segments.
 *
 * Two display modes (scope-aware, same as before)
 * ─────────────────────────────────────────────────
 * 1. Single mode  (branch scope OR global with one branch selected)
 *    Data shape: { label: string; segA: number; segB: number; segC: number }[]
 *    → ONE stacked bar per label, using the 3 colours passed in `colors`.
 *
 * 2. Grouped-stacked mode (global scope, "All Branches" selected)
 *    Data shape: { id, name, data: {label, segA, segB, segC}[] }[]
 *    → every series (branch) gets its own stacked trio per label group,
 *      colour-derived from a single base colour per series (segA = base,
 *      segB = lightened, segC = strongly lightened "absent" tone).
 *
 * Visuals (rounded gapped segment shapes, tooltips, legend) are byte-for-byte
 * identical to the original AttendancePerformanceCard.
 *
 * This component renders ONLY the chart + legend — wrap it in your own card
 * shell, or use AttendancePerformanceCard which does that for this specific
 * use case (segment labels "On Time" / "Late" / "Absent").
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import type { BarShapeProps } from "recharts";

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

// ─── Palette ──────────────────────────────────────────────────────────────────

export const STACKED_BAR_COLORS: string[] = [
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
];

const GAP = 3;
const RADIUS = 9;

// ─── Colour helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex: string) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function lighten(hex: string, amount: number): string {
  const clamped = Math.min(amount, 0.55);
  const { r, g, b } = hexToRgb(hex);
  const l = (c: number) => Math.round(c + (255 - c) * clamped);
  return `rgb(${l(r)},${l(g)},${l(b)})`;
}

function thirdSegmentFromBase(hex: string): string {
  // Lighten strongly toward white so it's clearly distinct but still
  // visible as a solid colour — never transparent against a white card.
  return lighten(hex, 0.68);
}

// Derive the 3 segment colours for a given base colour
function deriveSegmentColors(baseColor: string) {
  return {
    segA: baseColor,
    segB: lighten(baseColor, 0.4),
    segC: thirdSegmentFromBase(baseColor),
  };
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface StackedDataPoint {
  label: string;
  segA: number;
  segB: number;
  segC: number;
}

export interface StackedSeries {
  id: string | number;
  name: string;
  data: StackedDataPoint[]; // same label order across all series
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: any[];
  label?: string;
}

export interface SegmentLabels {
  segA: string;
  segB: string;
  segC: string;
}

export interface SegmentColors {
  segA: string;
  segB: string;
  segC: string;
}

interface StackedSegmentBarChartCardProps {
  /** Single-series data (branch scope or filtered global) */
  data?: StackedDataPoint[];
  /** Multi-series data for "All Branches" global view */
  series?: StackedSeries[];
  /** Display labels for the 3 segments (e.g. On Time / Late / Absent) */
  segmentLabels: SegmentLabels;
  /** Colours for the 3 segments in single mode */
  colors: SegmentColors;
  /** Value formatter for tooltip + nothing else (default: round + "%") */
  formatValue?: (value: number) => string;
  /** Chart height for single mode (default 220) */
  singleHeight?: number;
  /** Chart height for grouped-stacked mode (default 200) */
  multiHeight?: number;
  /** Y axis tick formatter (default: `${v}%`) */
  formatYAxis?: (value: number) => string;
  /** Y axis domain (default [0, 100]) */
  yDomain?: [number, number];
}

// ─── Grouped data pivot ────────────────────────────────────────────────────────
//
// Recharts BarChart expects ONE flat array of objects. For grouped + stacked
// bars we pivot the data so each label is one row containing every series'
// three values keyed as `s{id}_a`, `s{id}_b`, `s{id}_c`.

interface GroupedRow {
  label: string;
  [key: string]: number | string;
}

function pivotSeries(series: StackedSeries[]): GroupedRow[] {
  if (!series.length) return [];
  const labels = series[0].data.map((d) => d.label);
  return labels.map((label, li) => {
    const row: GroupedRow = { label };
    series.forEach((s) => {
      const entry = s.data[li];
      row[`s${s.id}_a`] = entry?.segA ?? 0;
      row[`s${s.id}_b`] = entry?.segB ?? 0;
      row[`s${s.id}_c`] = entry?.segC ?? 0;
    });
    return row;
  });
}

// ─── Custom rounded segment shape ─────────────────────────────────────────────

function makeSegmentShape(
  gapAbove: number,
  gapBelow: number,
  fillColor: string,
) {
  const SegmentShape = (props: BarShapeProps): React.ReactElement | null => {
    const { x, y, width, height } = props;
    if (!height || height <= 0 || !width || width <= 0) return null;

    const adjY = y + gapAbove;
    const adjH = Math.max(0, height - gapAbove - gapBelow);
    if (adjH <= 0) return null;

    const r = Math.min(RADIUS, adjH / 2, width / 2);

    return (
      <path
        fill={fillColor}
        d={`
          M ${x + r},${adjY}
          H ${x + width - r}
          Q ${x + width},${adjY} ${x + width},${adjY + r}
          V ${adjY + adjH - r}
          Q ${x + width},${adjY + adjH} ${x + width - r},${adjY + adjH}
          H ${x + r}
          Q ${x},${adjY + adjH} ${x},${adjY + adjH - r}
          V ${adjY + r}
          Q ${x},${adjY} ${x + r},${adjY}
          Z
        `}
      />
    );
  };
  SegmentShape.displayName = "SegmentShape";
  return SegmentShape;
}

// ─── Tooltips ──────────────────────────────────────────────────────────────────

const defaultFormatValue = (v: number) => `${Math.round(v)}%`;

const GroupedTooltip: React.FC<
  ChartTooltipProps & {
    series: StackedSeries[];
    segmentLabels: SegmentLabels;
    formatValue: (v: number) => string;
  }
> = ({ active, payload, label, series, segmentLabels, formatValue }) => {
  if (!active || !payload?.length) return null;

  const bySeries = new Map<
    string | number,
    { a: number; b: number; c: number; color: string; name: string }
  >();

  payload.forEach((p: any) => {
    const match = String(p.name).match(/^s(.+)_(a|b|c)$/);
    if (!match) return;
    const sid = match[1];
    const seg = match[2] as "a" | "b" | "c";
    const s = series.find((x) => String(x.id) === sid);
    if (!s) return;
    const idx = series.indexOf(s);
    const color = STACKED_BAR_COLORS[idx % STACKED_BAR_COLORS.length];
    if (!bySeries.has(s.id)) {
      bySeries.set(s.id, { a: 0, b: 0, c: 0, color, name: s.name });
    }
    const entry = bySeries.get(s.id)!;
    if (seg === "a") entry.a = p.value;
    if (seg === "b") entry.b = p.value;
    if (seg === "c") entry.c = p.value;
  });

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #E8ECF0",
        borderRadius: 10,
        padding: "8px 12px",
        fontSize: 12,
        fontFamily: "'DM Sans', sans-serif",
        boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        minWidth: 160,
      }}
    >
      <p
        style={{
          margin: "0 0 6px",
          fontWeight: 700,
          color: "#1E293B",
          fontSize: 11,
        }}
      >
        {label}
      </p>
      {Array.from(bySeries.entries()).map(([sid, info]) => (
        <div key={sid} style={{ marginBottom: 5 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              marginBottom: 2,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: info.color,
                flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 700, color: "#1E293B", fontSize: 11 }}>
              {info.name}
            </span>
          </div>
          {[
            { label: segmentLabels.segA, val: info.a, color: info.color },
            {
              label: segmentLabels.segB,
              val: info.b,
              color: lighten(info.color, 0.4),
            },
            {
              label: segmentLabels.segC,
              val: info.c,
              color: thirdSegmentFromBase(info.color),
            },
          ].map((seg) => (
            <div
              key={seg.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                paddingLeft: 13,
                marginBottom: 1,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 1,
                  background: seg.color,
                  flexShrink: 0,
                }}
              />
              <span style={{ color: "#64748B", fontSize: 11 }}>
                {seg.label}:{" "}
                <span style={{ fontWeight: 600, color: "#334155" }}>
                  {formatValue(seg.val)}
                </span>
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

const SingleTooltip: React.FC<
  ChartTooltipProps & {
    segmentLabels: SegmentLabels;
    formatValue: (v: number) => string;
  }
> = ({ active, payload, label, segmentLabels, formatValue }) => {
  if (!active || !payload?.length) return null;

  const labelMap: Record<string, string> = {
    segA: segmentLabels.segA,
    segB: segmentLabels.segB,
    segC: segmentLabels.segC,
  };

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #E8ECF0",
        borderRadius: 10,
        padding: "8px 12px",
        fontSize: 12,
        fontFamily: "'DM Sans', sans-serif",
        boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
        minWidth: 130,
      }}
    >
      <p
        style={{
          margin: "0 0 5px",
          fontWeight: 700,
          color: "#1E293B",
          fontSize: 11,
        }}
      >
        {label}
      </p>
      {payload.map((p: any) => (
        <p
          key={p.dataKey}
          style={{
            margin: "2px 0",
            color: "#475569",
            fontWeight: 600,
            fontSize: 11,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: 2,
              background: p.fill,
              marginRight: 6,
              verticalAlign: "middle",
            }}
          />
          {labelMap[p.dataKey] ?? p.dataKey}:{" "}
          <span style={{ fontWeight: 400 }}>{formatValue(p.value)}</span>
        </p>
      ))}
    </div>
  );
};

// ─── Grouped-stacked chart ──────────────────────────────────────────────────────

const GroupedStackedChart: React.FC<{
  height: number;
  series: StackedSeries[];
  segmentLabels: SegmentLabels;
  formatValue: (v: number) => string;
  formatYAxis: (v: number) => string;
  yDomain: [number, number];
}> = ({ height, series, segmentLabels, formatValue, formatYAxis, yDomain }) => {
  const chartData = useMemo(() => pivotSeries(series), [series]);

  const shapes = useMemo(() => {
    return series.map((s, idx) => {
      const color = STACKED_BAR_COLORS[idx % STACKED_BAR_COLORS.length];
      const cols = deriveSegmentColors(color);
      return {
        id: s.id,
        stackId: `s${s.id}`,
        segA: makeSegmentShape(0, GAP, cols.segA),
        segB: makeSegmentShape(GAP, GAP, cols.segB),
        segC: makeSegmentShape(GAP, 0, cols.segC),
        colors: cols,
      };
    });
  }, [series]);

  // Scale gaps with series count: more branches → tighter packing,
  // fewer branches → looser, wider bars (within sensible bounds).
  const n = series.length || 1;
  const barGap = Math.max(2, Math.min(8, 10 - n * 2));
  const barCategoryGap = n <= 2 ? "30%" : n <= 4 ? "32%" : "22%";
  const maxBarSize = n <= 2 ? 48 : n <= 4 ? 34 : 24;

  return (
    <MeasuredChartFrame height={height}>
      <BarChart
        data={chartData}
        barCategoryGap={barCategoryGap}
        barGap={barGap}
      >
        <CartesianGrid vertical={false} stroke="#F1F5F9" />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={{
            fontSize: 10,
            fill: "#94A3B8",
            fontFamily: "'DM Sans', sans-serif",
          }}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{
            fontSize: 10,
            fill: "#94A3B8",
            fontFamily: "'DM Sans', sans-serif",
          }}
          tickFormatter={formatYAxis}
          domain={yDomain}
          width={32}
        />
        <Tooltip
          content={
            <GroupedTooltip
              series={series}
              segmentLabels={segmentLabels}
              formatValue={formatValue}
            />
          }
          cursor={{ fill: "#F8FAFC" }}
        />

        {shapes.map((s) => (
          <React.Fragment key={s.id}>
            <Bar
              dataKey={`s${s.id}_a`}
              stackId={s.stackId}
              name={`s${s.id}_a`}
              fill={s.colors.segA}
              shape={s.segA}
              isAnimationActive={true}
              animationDuration={800}
              animationEasing="ease-out"
              maxBarSize={maxBarSize}
            >
              {chartData.map((_row, i) => (
                <Cell key={`a-${s.id}-${i}`} fill={s.colors.segA} />
              ))}
            </Bar>

            <Bar
              dataKey={`s${s.id}_b`}
              stackId={s.stackId}
              name={`s${s.id}_b`}
              fill={s.colors.segB}
              shape={s.segB}
              isAnimationActive={true}
              animationDuration={800}
              animationEasing="ease-out"
              maxBarSize={maxBarSize}
            >
              {chartData.map((_row, i) => (
                <Cell key={`b-${s.id}-${i}`} fill={s.colors.segB} />
              ))}
            </Bar>

            <Bar
              dataKey={`s${s.id}_c`}
              stackId={s.stackId}
              name={`s${s.id}_c`}
              fill={s.colors.segC}
              shape={s.segC}
              isAnimationActive={true}
              animationDuration={800}
              animationEasing="ease-out"
              maxBarSize={maxBarSize}
            >
              {chartData.map((_row, i) => (
                <Cell key={`c-${s.id}-${i}`} fill={s.colors.segC} />
              ))}
            </Bar>
          </React.Fragment>
        ))}
      </BarChart>
    </MeasuredChartFrame>
  );
};

// ─── Single chart ────────────────────────────────────────────────────────────

const SingleChart: React.FC<{
  height: number;
  data: StackedDataPoint[];
  colors: SegmentColors;
  segmentLabels: SegmentLabels;
  formatValue: (v: number) => string;
  formatYAxis: (v: number) => string;
  yDomain: [number, number];
}> = ({
  height,
  data,
  colors,
  segmentLabels,
  formatValue,
  formatYAxis,
  yDomain,
}) => {
  const SegAShape = useMemo(
    () => makeSegmentShape(0, GAP, colors.segA),
    [colors.segA],
  );
  const SegBShape = useMemo(
    () => makeSegmentShape(GAP, GAP, colors.segB),
    [colors.segB],
  );
  const SegCShape = useMemo(
    () => makeSegmentShape(GAP, 0, colors.segC),
    [colors.segC],
  );

  return (
    <MeasuredChartFrame height={height}>
      <BarChart data={data} barCategoryGap="35%">
        <CartesianGrid vertical={false} stroke="#F1F5F9" />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          tick={{
            fontSize: 10,
            fill: "#94A3B8",
            fontFamily: "'DM Sans', sans-serif",
          }}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{
            fontSize: 10,
            fill: "#94A3B8",
            fontFamily: "'DM Sans', sans-serif",
          }}
          tickFormatter={formatYAxis}
          domain={yDomain}
          width={32}
        />
        <Tooltip
          content={
            <SingleTooltip
              segmentLabels={segmentLabels}
              formatValue={formatValue}
            />
          }
          cursor={{ fill: "#F8FAFC" }}
        />

        <Bar
          dataKey="segA"
          stackId="a"
          fill={colors.segA}
          shape={SegAShape}
          isAnimationActive={true}
          animationDuration={800}
          animationEasing="ease-out"
        >
          {data.map((_e, i) => (
            <Cell key={`a-${i}`} fill={colors.segA} />
          ))}
        </Bar>
        <Bar
          dataKey="segB"
          stackId="a"
          fill={colors.segB}
          shape={SegBShape}
          isAnimationActive={true}
          animationDuration={800}
          animationEasing="ease-out"
        >
          {data.map((_e, i) => (
            <Cell key={`b-${i}`} fill={colors.segB} />
          ))}
        </Bar>
        <Bar
          dataKey="segC"
          stackId="a"
          fill={colors.segC}
          shape={SegCShape}
          isAnimationActive={true}
          animationDuration={800}
          animationEasing="ease-out"
        >
          {data.map((_e, i) => (
            <Cell key={`c-${i}`} fill={colors.segC} />
          ))}
        </Bar>
      </BarChart>
    </MeasuredChartFrame>
  );
};

// ─── Legend row ────────────────────────────────────────────────────────────────

export const StackedBarLegend: React.FC<{
  isGrouped: boolean;
  series?: StackedSeries[];
  segmentLabels: SegmentLabels;
  colors: SegmentColors;
}> = ({ isGrouped, series, segmentLabels, colors }) => {
  if (isGrouped && series?.length) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          flexWrap: "wrap",
        }}
      >
        {series.map((s, idx) => {
          const color = STACKED_BAR_COLORS[idx % STACKED_BAR_COLORS.length];
          return (
            <div
              key={s.id}
              style={{ display: "flex", alignItems: "center", gap: 4 }}
            >
              <span
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background: color,
                  display: "inline-block",
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  color: "#94A3B8",
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
  }

  const items = [
    { label: segmentLabels.segA, color: colors.segA },
    { label: segmentLabels.segB, color: colors.segB },
    { label: segmentLabels.segC, color: colors.segC },
  ];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      {items.map((item) => (
        <div
          key={item.label}
          style={{ display: "flex", alignItems: "center", gap: 5 }}
        >
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 2,
              background: item.color,
              display: "inline-block",
            }}
          />
          <span
            style={{
              fontSize: 11,
              color: "#94A3B8",
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
};

// ─── Main component ────────────────────────────────────────────────────────────

const StackedSegmentBarChartCard: React.FC<StackedSegmentBarChartCardProps> = ({
  data,
  series,
  segmentLabels,
  colors,
  formatValue = defaultFormatValue,
  singleHeight = 220,
  multiHeight = 200,
  formatYAxis = (v: number) => `${v}%`,
  yDomain = [0, 100],
}) => {
  const isGrouped = Array.isArray(series) && series.length > 0;
  const chartHeight = isGrouped ? multiHeight : singleHeight;

  return (
    <div
      style={{
        height: chartHeight,
        minHeight: chartHeight,
        width: "100%",
        minWidth: 0,
      }}
    >
      {isGrouped ? (
        <GroupedStackedChart
          height={chartHeight}
          series={series!}
          segmentLabels={segmentLabels}
          formatValue={formatValue}
          formatYAxis={formatYAxis}
          yDomain={yDomain}
        />
      ) : (
        <SingleChart
          height={chartHeight}
          data={data ?? []}
          colors={colors}
          segmentLabels={segmentLabels}
          formatValue={formatValue}
          formatYAxis={formatYAxis}
          yDomain={yDomain}
        />
      )}
    </div>
  );
};

export default React.memo(StackedSegmentBarChartCard);
