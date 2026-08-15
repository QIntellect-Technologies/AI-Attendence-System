/**
 * TodayStatusCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders today's attendance breakdown (Present / Absent / Late) as a donut
 * via AppDonutChart, plus a semantically-coloured legend below it.
 *
 * Hardening notes (root-cause fix for the "Cannot read properties of
 * undefined (reading 'filter')" crash):
 *   • `data` is now optional and defaults to [] — this component is shared
 *     across AdminLayout / dashboard overview tabs which may render before
 *     OrgConfigContext finishes hydrating.
 *   • AppDonutChart itself (DonutChart.tsx) also normalizes its `data` prop
 *     via normalizeDonutData(), so this guard + the chart's guard together
 *     make the whole pipeline safe regardless of which consumer renders first.
 *   • totalForLegend avoids divide-by-zero without relying on `|| 1` against
 *     a value that could be NaN.
 */

import React, { useMemo } from "react";
import DashboardCard from "./DashboardCard";
import AppDonutChart from "../../ui/charts/DonutChart";
import { T } from "../../ui/theme";
import type { TodayStatusItem } from "../../../hooks/useDashboardOverviewData";

// ─── Status colour map ────────────────────────────────────────────────────────
// Used for the legend rows — independent of the donut slice colours.
const STATUS_COLOR: Record<string, string> = {
  Present: T.teal600,
  Late: "#1a699f",
  Absent: "#E11D48",
};

function statusColor(name: string): string {
  return STATUS_COLOR[name] ?? T.muted;
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface TodayStatusCardProps {
  /** Optional — defaults to []. May be empty/undefined during initial load. */
  data?: TodayStatusItem[];
  presentToday: number;
}

// ─── Component ────────────────────────────────────────────────────────────────
const TodayStatusCard: React.FC<TodayStatusCardProps> = ({
  data,
  presentToday,
}) => {
  const items = data ?? [];

  // TodayStatusItem is already compatible with DonutChartItem (name + value).
  // AppDonutChart normalizes + sorts by value descending internally.
  const donutData = useMemo(
    () =>
      items.map((item) => ({
        id: item.name,
        name: item.name,
        value: item.value,
      })),
    [items],
  );

  const legendTotal = useMemo(
    () => items.reduce((sum, item) => sum + item.value, 0),
    [items],
  );

  return (
    <DashboardCard title="Today's Status" height="100%">
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* ── Donut ── */}
        <div style={{ flex: 1, minHeight: 0 }}>
          <AppDonutChart
            data={donutData}
            height={220}
            showLegend={false}
            showTotalInCenter
            valueLabel="Present"
            formatCenterValue={() => String(presentToday)}
            formatValue={(value: number) => value.toLocaleString()}
            sliceGapDegrees={5}
            roundedSlices
          />
        </div>

        {/* ── Legend rows (semantically coloured) ── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 14,
            flexShrink: 0,
          }}
        >
          {items.map((item) => {
            const color = statusColor(item.name);
            const pct =
              legendTotal > 0
                ? Math.round((item.value / legendTotal) * 100)
                : 0;

            return (
              <div
                key={item.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "7px 12px",
                  background: T.slate50,
                  borderRadius: 10,
                  border: `1px solid ${T.border}`,
                }}
              >
                {/* Left: dot + label */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      background: color,
                      flexShrink: 0,
                      display: "inline-block",
                    }}
                  />
                  <span
                    style={{
                      fontSize: 12,
                      color: T.muted,
                      fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
                    {item.name}
                  </span>
                </div>

                {/* Right: value + percentage pill */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: T.head,
                      fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
                    {item.value.toLocaleString()}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color,
                      background: `${color}18`,
                      padding: "2px 7px",
                      borderRadius: 20,
                      fontFamily: "'DM Sans', sans-serif",
                    }}
                  >
                    {pct}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </DashboardCard>
  );
};

export default React.memo(TodayStatusCard);
