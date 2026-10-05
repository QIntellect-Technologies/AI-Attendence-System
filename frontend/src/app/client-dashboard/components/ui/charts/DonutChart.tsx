import React, { useMemo, useState, useEffect } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type DonutChartItem = {
  id?: string | number;
  name: string;
  value: number;
};

type AppDonutChartProps = {
  title?: string;
  subtitle?: string;
  data?: ReadonlyArray<DonutChartItem>;

  height?: number;
  maxSlices?: number;
  showLegend?: boolean;
  showTotalInCenter?: boolean;

  /** Gap between donut slices in degrees. */
  sliceGapDegrees?: number;

  /** Keeps slice ends rounded. Recommended for dashboard UI. */
  roundedSlices?: boolean;

  valueLabel?: string;
  emptyText?: string;

  formatValue?: (value: number) => string;
  formatCenterValue?: (value: number) => string;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const SVG_SIZE = 180;
const CX = 90;
const CY = 90;
const RADIUS = 66;
const STROKE_WIDTH = 24;
const STROKE_ACTIVE = 30;

// ─── Color generator ──────────────────────────────────────────────────────────
// First 12 are hand-picked for the brand palette.
// Beyond that, golden angle (137.5°) guarantees maximally-distinct hues.

function generateSliceColors(count: number): string[] {
  const base = [
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

  if (count <= base.length) return base.slice(0, count);

  const colors = [...base];
  for (let i = base.length; i < count; i++) {
    const hue = Math.round((i * 137.5) % 360);
    const sat = 45 + (i % 3) * 10;
    const light = 35 + (i % 4) * 8;
    colors.push(`hsl(${hue},${sat}%,${light}%)`);
  }
  return colors;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_FORMATTER = (value: number) => value.toLocaleString();

type NormalizedDonutChartItem = Required<Pick<DonutChartItem, "name" | "value">> & {
  id: string | number;
};

function normalizeDonutData(
  input: ReadonlyArray<DonutChartItem> | undefined,
): NormalizedDonutChartItem[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item, index) => {
      const rawName = String(item?.name ?? `Item ${index + 1}`).trim();
      const name = rawName || `Item ${index + 1}`;
      const numericValue = Number(item?.value ?? 0);

      return {
        id: item?.id ?? `${name}-${index}`,
        name,
        value: numericValue,
      };
    })
    .filter((item) => Number.isFinite(item.value) && item.value > 0);
}


function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleInDegrees: number,
) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

function buildArcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    "M",
    start.x,
    start.y,
    "A",
    radius,
    radius,
    0,
    largeArcFlag,
    0,
    end.x,
    end.y,
  ].join(" ");
}

/**
 * Convert a slice's angular span (degrees) to its arc length in SVG units.
 * Used to set strokeDasharray + strokeDashoffset for the draw-on animation.
 */
function arcLength(spanDegrees: number): number {
  return (spanDegrees / 360) * 2 * Math.PI * RADIUS;
}

/**
 * useSliceMountAnimation
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns `mounted` boolean that flips to true after one requestAnimationFrame.
 *
 * The rAF is critical: without it React batches the initial render (offset =
 * full arc length) and the state update (offset = 0) into the same paint frame,
 * so the browser never sees the "from" state and the CSS transition never fires.
 *
 * With the rAF, the sequence is:
 *   Frame 0 → React renders with strokeDashoffset = fullLength  (invisible)
 *   Frame 1 → mounted flips true → strokeDashoffset transitions to 0 (draws)
 */
function useSliceMountAnimation(): boolean {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return mounted;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AppDonutChart({
  title,
  subtitle,
  data,
  height = 260,
  maxSlices = 20,
  showLegend = true,
  showTotalInCenter = true,
  sliceGapDegrees = 4,
  roundedSlices = true,
  valueLabel = "Total",
  emptyText = "No data available",
  formatValue = DEFAULT_FORMATTER,
  formatCenterValue = DEFAULT_FORMATTER,
}: AppDonutChartProps) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  // ── Animation mount flag ──────────────────────────────────────────────────
  const mounted = useSliceMountAnimation();

  // ── Data processing ───────────────────────────────────────────────────────
  const slices = useMemo<NormalizedDonutChartItem[]>(() => {
    const cleaned = normalizeDonutData(data).sort((a, b) => b.value - a.value);

    if (cleaned.length <= maxSlices) return cleaned;

    const visible = cleaned.slice(0, maxSlices - 1);
    const others = cleaned.slice(maxSlices - 1);
    const othersTotal = others.reduce((sum, item) => sum + item.value, 0);

    return [...visible, { id: "others", name: "Others", value: othersTotal }];
  }, [data, maxSlices]);

  const total = useMemo(
    () => slices.reduce((sum, item) => sum + item.value, 0),
    [slices],
  );

  const maxValue = useMemo(
    () => Math.max(...slices.map((item) => item.value), 1),
    [slices],
  );

  const sliceColors = useMemo(
    () => generateSliceColors(slices.length),
    [slices.length],
  );

  const chartSlices = useMemo(() => {
    let currentAngle = 0;
    const hasMultipleSlices = slices.length > 1;

    return slices.map((slice) => {
      const rawAngle = (slice.value / total) * 360;
      const safeGap = hasMultipleSlices
        ? Math.min(sliceGapDegrees, Math.max(rawAngle * 0.35, 0))
        : 0;

      const startAngle = currentAngle + safeGap / 2;
      const endAngle = Math.max(
        startAngle + 0.1,
        currentAngle + rawAngle - safeGap / 2,
      );

      currentAngle += rawAngle;
      return { ...slice, startAngle, endAngle };
    });
  }, [slices, sliceGapDegrees, total]);

  // ── Derived center display values ─────────────────────────────────────────
  const activeSlice = activeIdx !== null ? (slices[activeIdx] ?? null) : null;
  const centerValue = activeSlice ? activeSlice.value : total;
  const centerLabel = activeSlice ? activeSlice.name : valueLabel;

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!slices.length || total <= 0) {
    return (
      <div
        style={{
          height,
          display: "grid",
          placeItems: "center",
          color: "#6F909A",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {emptyText}
      </div>
    );
  }

  return (
    <div style={{ width: "100%" }}>
      {/* ── Title / subtitle ── */}
      {(title || subtitle) && (
        <div style={{ marginBottom: 14 }}>
          {title && (
            <h3
              style={{
                margin: 0,
                color: "#063862",
                fontSize: 16,
                fontWeight: 900,
              }}
            >
              {title}
            </h3>
          )}
          {subtitle && (
            <p
              style={{
                margin: "4px 0 0",
                color: "#6F909A",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: showLegend ? "180px 1fr" : "1fr",
          gap: 18,
          alignItems: "center",
          minHeight: height,
        }}
      >
        {/* ── SVG donut ── */}
        <div
          style={{
            position: "relative",
            width: SVG_SIZE,
            height: SVG_SIZE,
            margin: "0 auto",
          }}
        >
          <svg
            width={SVG_SIZE}
            height={SVG_SIZE}
            viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
          >
            {/* Track ring */}
            <circle
              cx={CX}
              cy={CY}
              r={RADIUS}
              fill="none"
              stroke="#EAF5F3"
              strokeWidth={STROKE_WIDTH}
            />

            {/* Animated slices */}
            {chartSlices.map((slice, idx) => {
              const isActive = activeIdx === idx;
              const sw = isActive ? STROKE_ACTIVE : STROKE_WIDTH;
              const color = sliceColors[idx];

              // Full arc length for this slice — used as the dasharray value
              // so the stroke exactly covers the arc when offset = 0.
              const span = slice.endAngle - slice.startAngle;
              const fullArcLength = arcLength(span);

              // Stagger: each slice starts 40ms after the previous one,
              // creating a sequential fan-out effect on first render.
              const staggerDelay = idx * 40;

              return (
                <g
                  key={slice.id ?? slice.name}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onMouseLeave={() => setActiveIdx(null)}
                  style={{ cursor: "pointer" }}
                >
                  <path
                    d={buildArcPath(
                      CX,
                      CY,
                      RADIUS,
                      slice.startAngle,
                      slice.endAngle,
                    )}
                    fill="none"
                    stroke={color}
                    strokeWidth={sw}
                    strokeLinecap="butt"
                    // ── Draw-on animation ──────────────────────────────────
                    // dasharray = full arc length → one dash covers the whole arc
                    // dashoffset starts at fullArcLength (nothing visible) and
                    // transitions to 0 (fully drawn) after one paint frame.
                    strokeDasharray={fullArcLength}
                    strokeDashoffset={mounted ? 0 : fullArcLength}
                    style={{
                      transition: [
                        `stroke-dashoffset 600ms cubic-bezier(0.4,0,0.2,1) ${staggerDelay}ms`,
                        `stroke-width 180ms ease`,
                      ].join(", "),
                    }}
                  />
                </g>
              );
            })}
          </svg>

          {/* ── Center label ── */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              pointerEvents: "none",
              textAlign: "center",
            }}
          >
            <div>
              <div
                style={{
                  color: "#063862",
                  fontSize: 20,
                  fontWeight: 900,
                  lineHeight: 1.1,
                }}
              >
                {showTotalInCenter
                  ? formatCenterValue(centerValue)
                  : `${Math.round((centerValue / total) * 100)}%`}
              </div>

              <div
                style={{
                  color: "#0B9286",
                  fontSize: 10,
                  fontWeight: 700,
                  marginTop: 4,
                  maxWidth: 86,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={centerLabel}
              >
                {centerLabel}
              </div>

              {activeSlice && showTotalInCenter && (
                <div
                  style={{
                    color: "#6F909A",
                    fontSize: 11,
                    fontWeight: 700,
                    marginTop: 2,
                  }}
                >
                  {Math.round((activeSlice.value / total) * 100)}%
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Legend ── */}
        {showLegend && (
          <div style={{ display: "grid", gap: 10 }}>
            {slices.map((item, idx) => (
              <div key={item.id ?? item.name}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    marginBottom: 5,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 999,
                        background: sliceColors[idx],
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        color: "#063862",
                        fontSize: 12,
                        fontWeight: 800,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={item.name}
                    >
                      {item.name}
                    </span>
                  </div>

                  <span
                    style={{
                      color: "#2B4D65",
                      fontSize: 12,
                      fontWeight: 900,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatValue(item.value)}
                  </span>
                </div>

                {/* Progress bar */}
                <div
                  style={{
                    height: 5,
                    borderRadius: 999,
                    background: "#EAF5F3",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${(item.value / maxValue) * 100}%`,
                      borderRadius: 999,
                      background: sliceColors[idx],
                      // Stagger the legend bars to match slice animation timing
                      transition: `width 600ms cubic-bezier(0.4,0,0.2,1) ${idx * 40}ms`,
                      // Start from 0 width until mounted
                      ...(mounted ? {} : { width: 0 }),
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
