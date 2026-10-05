/**
 * BranchCompareChart.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Template-aware branch comparison chart.
 *
 * Business rules:
 * - Metrics are derived from TemplateRenderingModel.
 * - Payroll is hidden automatically when the active template does not support
 *   payroll, for example student-only attendance organizations.
 * - People terminology is dynamic: Staff, Students, Employees, Workers, etc.
 */

import React, { useEffect, useMemo, useState } from "react";
import { T } from "../../components/ui/theme";
import { useDateFilter } from "../../hooks/useDateFilter";
import DateFilterBar from "../../components/ui/DateFilterBar";
import GroupedBarChartCard from "../../components/ui/charts/GroupedBarChartCard";
import JellyButton from "../../components/ui/JellyButton";
import type { BarDataPoint } from "../../components/ui/charts/GroupedBarChartCard";
import type { TemplateRenderingModel } from "../../utils/templateColumns";

export type BranchMetricKey = "people" | "attendance" | "payroll" | "late";

export interface BranchCompareData {
  id?: number | string;
  branchId?: number | string;
  branch_id?: number | string;
  name?: string;
  branchName?: string;
  branch_name?: string;
  city?: string;
  branchCity?: string;

  staff?: number;
  staffCount?: number;
  activeStaff?: number;
  enrolledStaff?: number;

  presentToday?: number;
  absentToday?: number;

  attendance?: number;
  attendanceRate?: number;

  payroll?: number;
  revenue?: number;

  late?: number;
  lateCount?: number;

  pendingLeaves?: number;
  overtimeHours?: number;
}

interface BranchMetricDef {
  key: BranchMetricKey;
  label: string;
  buttonLabel: string;
  fmt: (value: number) => string;
}

interface BranchCompareChartProps {
  branches: BranchCompareData[];
  templateModel: TemplateRenderingModel;
  showPayroll: boolean;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function branchLabel(branch: BranchCompareData): string {
  return (
    branch.branchName ??
    branch.branch_name ??
    branch.name ??
    (branch.branchId !== undefined ? `Branch ${branch.branchId}` : "Branch")
  );
}

function formatCompactMoney(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

function buildBranchMetrics(
  templateModel: TemplateRenderingModel,
  showPayroll: boolean,
): BranchMetricDef[] {
  const peoplePlural = templateModel.labels.plural;

  return [
    {
      key: "attendance",
      label: "Attendance %",
      buttonLabel: "Attendance %",
      fmt: (value) => `${value}%`,
    },
    {
      key: "people",
      label: peoplePlural,
      buttonLabel: peoplePlural,
      fmt: (value) => value.toLocaleString(),
    },
    ...(showPayroll
      ? [
          {
            key: "payroll" as const,
            label: "Payroll",
            buttonLabel: "Payroll",
            fmt: formatCompactMoney,
          },
        ]
      : []),
    {
      key: "late",
      label: "Late",
      buttonLabel: "Late",
      fmt: (value) => value.toLocaleString(),
    },
  ];
}

function getRawValue(branch: BranchCompareData, key: BranchMetricKey): number {
  const peopleCount = toNumber(branch.staffCount ?? branch.staff);

  switch (key) {
    case "people":
      return peopleCount;

    case "attendance":
      return Math.round(toNumber(branch.attendanceRate ?? branch.attendance));

    case "payroll": {
      const rawPayroll = branch.payroll ?? branch.revenue;
      const value = toNumber(rawPayroll);

      return branch.payroll === undefined && value > 0 && value < 100_000
        ? value * 1000
        : value;
    }

    case "late":
      return toNumber(branch.lateCount ?? branch.late);
  }
}

function getScaledValue(
  branch: BranchCompareData,
  key: BranchMetricKey,
  mode: string,
  daysInPeriod: number,
): number {
  const raw = getRawValue(branch, key);

  if (key === "people" || key === "attendance" || key === "biometrics") {
    return raw;
  }

  const ratio = Math.min(daysInPeriod / 30, 1);

  if (mode === "daily") return Math.round(raw / 22);
  if (mode === "weekly") return Math.round(raw * 0.23);
  if (mode === "custom") return Math.round(raw * ratio);

  return raw;
}

const BranchCompareChart: React.FC<BranchCompareChartProps> = ({
  branches,
  templateModel,
  showPayroll,
}) => {
  const metrics = useMemo(
    () => buildBranchMetrics(templateModel, showPayroll),
    [templateModel, showPayroll],
  );

  const defaultMetric = metrics[0]?.key ?? "attendance";
  const [activeMetric, setActiveMetric] =
    useState<BranchMetricKey>(defaultMetric);

  const filter = useDateFilter("monthly");

  useEffect(() => {
    if (!metrics.some((metric) => metric.key === activeMetric)) {
      setActiveMetric(defaultMetric);
    }
  }, [activeMetric, defaultMetric, metrics]);

  const activeMetricMeta =
    metrics.find((metric) => metric.key === activeMetric) ?? metrics[0];

  const chartData = useMemo<BarDataPoint[]>(
    () =>
      branches.map((branch) => ({
        label: branchLabel(branch),
        value: getScaledValue(
          branch,
          activeMetric,
          filter.mode,
          filter.dates.length,
        ),
      })),
    [activeMetric, branches, filter.dates.length, filter.mode],
  );

  const totalValue = useMemo(
    () => chartData.reduce((sum, item) => sum + item.value, 0),
    [chartData],
  );

  if (!activeMetricMeta) {
    return null;
  }

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 18,
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.head }}>
            Branch Comparison
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>
            Side-by-side metrics across all branches ·{" "}
            <span style={{ color: T.teal600, fontWeight: 600 }}>
              {filter.label}
            </span>{" "}
            · Total {activeMetricMeta.label}: {activeMetricMeta.fmt(totalValue)}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <DateFilterBar filter={filter} compact />

          <div
            style={{
              width: 1,
              height: 24,
              background: T.border,
              flexShrink: 0,
            }}
          />

          {metrics.map((metric) => (
            <JellyButton
              key={metric.key}
              variant={activeMetric === metric.key ? "primary" : "ghost"}
              size="md"
              onClick={() => setActiveMetric(metric.key)}
              title={metric.fmt(getRawValue(branches[0] ?? {}, metric.key))}
            >
              {metric.buttonLabel}
            </JellyButton>
          ))}
        </div>
      </div>

      <GroupedBarChartCard data={chartData} singleHeight={280} />
    </div>
  );
};

export default BranchCompareChart;
