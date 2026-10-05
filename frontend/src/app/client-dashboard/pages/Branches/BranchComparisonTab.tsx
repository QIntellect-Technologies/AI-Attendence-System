/**
 * BranchComparisonTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Fully dynamic branch comparison tab for the Super Admin dashboard.
 *
 * Filter state is now managed by useDateFilter() — an isolated hook instance
 * that belongs only to this component. Changing the period here has zero
 * effect on AttendanceView (or any other page) because each page owns its own
 * hook instance with its own private React state.
 */

import React, { useState, useMemo, useCallback } from "react";
import {
  Users,
  TrendingUp,
  Wallet,
  ShieldAlert,
  Clock,
  Download,
  BarChart2,
  Star,
  ChevronUp,
  ChevronDown,
  MapPin,
  Minus,
} from "lucide-react";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";

import { T } from "../../components/ui/theme";
import { Card, SH } from "../../components/ui/DashboardComponents";
import JellyButton from "../../components/ui/JellyButton";
import useDashboardOverviewData, {
  type BranchPerformanceItem,
  type BranchPayrollSeries,
} from "../../hooks/useDashboardOverviewData";
import { useOrg } from "../../contexts/OrgConfigContext";
import {
  buildExcelWorkbook,
  downloadExcel,
} from "../../components/ui/ExportExcelButton";

// ── Shared filter hook + component (isolated per page) ──────────────────────
import { useDateFilter } from "../../hooks/useDateFilter";
import DateFilterBar from "../../components/ui/DateFilterBar";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tooltipValueToNumber(value: unknown): number {
  if (Array.isArray(value)) return Number(value[0] ?? 0);
  return Number(value ?? 0);
}

// ─── Branch colour palette ────────────────────────────────────────────────────

const BRANCH_COLORS = [
  "#1A699F",
  "#D97706",
  "#7C3AED",
  "#059669",
  "#E11D48",
  "#0891B2",
  "#CA8A04",
  "#9333EA",
  "#DC2626",
  "#0D9488",
] as const;

function branchColor(idx: number): string {
  return BRANCH_COLORS[idx % BRANCH_COLORS.length];
}

// ─── Metric definitions ───────────────────────────────────────────────────────

type MetricKey =
  | "totalStaff"
  | "avgAttendance"
  | "payroll"
  | "lateToday"
  | "cctvAlerts";

interface MetricDef {
  key: MetricKey;
  label: string;
  shortLabel: string;
  icon: React.ReactNode;
  format: (v: number) => string;
  higherIsBetter: boolean;
}

const METRICS: MetricDef[] = [
  {
    key: "totalStaff",
    label: "Total Staff",
    shortLabel: "Staff",
    icon: <Users size={13} />,
    format: (v) => v.toLocaleString(),
    higherIsBetter: true,
  },
  {
    key: "avgAttendance",
    label: "Attendance %",
    shortLabel: "Attendance",
    icon: <TrendingUp size={13} />,
    format: (v) => `${v}%`,
    higherIsBetter: true,
  },
  {
    key: "payroll",
    label: "Monthly Payroll",
    shortLabel: "Payroll",
    icon: <Wallet size={13} />,
    format: (v) =>
      v >= 1_000_000
        ? `${(v / 1_000_000).toFixed(1)}M`
        : v >= 1_000
          ? `${Math.round(v / 1_000)}K`
          : v.toLocaleString(),
    higherIsBetter: false,
  },
  {
    key: "lateToday",
    label: "Late Today",
    shortLabel: "Late",
    icon: <Clock size={13} />,
    format: (v) => v.toLocaleString(),
    higherIsBetter: false,
  },
  {
    key: "cctvAlerts",
    label: "CCTV Alerts",
    shortLabel: "Alerts",
    icon: <ShieldAlert size={13} />,
    format: (v) => v.toLocaleString(),
    higherIsBetter: false,
  },
];

// ─── Health score ─────────────────────────────────────────────────────────────

function computeHealthScore(b: BranchPerformanceItem): number {
  const attScore = Math.min(100, b.avgAttendance);
  const lateRate = b.totalStaff > 0 ? (b.lateToday / b.totalStaff) * 100 : 0;
  const latePenalty = Math.min(100, lateRate * 5);
  const alertPenalty = Math.min(100, b.cctvAlerts * 15);
  return Math.round(
    attScore * 0.5 + (100 - latePenalty) * 0.2 + (100 - alertPenalty) * 0.3,
  );
}

function healthLabel(score: number): {
  label: string;
  color: string;
  bg: string;
} {
  if (score >= 85)
    return { label: "Excellent", color: "#059669", bg: "#ECFDF5" };
  if (score >= 70) return { label: "Good", color: T.teal600, bg: T.teal100 };
  if (score >= 55) return { label: "Fair", color: "#D97706", bg: "#FEF3C7" };
  return { label: "Needs Attention", color: "#E11D48", bg: "#FFF1F2" };
}

// ─── Excel export ─────────────────────────────────────────────────────────────
// Was a hand-rolled, duplicate CSV builder that bypassed the shared export
// engine entirely (ExportExcelButton.tsx / buildExcelWorkbook) — including
// hand-rolled comma escaping that only handled commas, not quotes or
// newlines, unlike the shared engine's escaping. Rebuilt on the shared
// engine so this page gets the same branded header band, styled table, and
// number formatting as every other export in the app (DRY), and — since
// Excel workbooks support multiple tabs natively — the "full" scope's
// payroll breakdown now gets its own sheet instead of being CSV-appended
// as extra rows under a different header shape in the same table.
type BranchComparisonRow = BranchPerformanceItem & { score: number };

const BRANCH_COMPARISON_COLUMNS: Array<{
  header: string;
  accessor: (row: BranchComparisonRow) => string | number;
  align?: "left" | "right" | "center";
  numFmt?: string;
}> = [
  { header: "Branch", accessor: (b) => b.branchName },
  { header: "City", accessor: (b) => b.city ?? "" },
  { header: "Total Staff", accessor: (b) => b.totalStaff, align: "right" },
  { header: "Present Today", accessor: (b) => b.presentToday, align: "right" },
  { header: "Absent Today", accessor: (b) => b.absentToday, align: "right" },
  {
    header: "Avg Attendance %",
    accessor: (b) => b.avgAttendance,
    align: "right",
    numFmt: "0.0\"%\"",
  },
  { header: "Late Today", accessor: (b) => b.lateToday, align: "right" },
  { header: "CCTV Alerts", accessor: (b) => b.cctvAlerts, align: "right" },
  { header: "Health Score", accessor: (b) => b.score, align: "right" },
  {
    header: "Monthly Payroll",
    accessor: (b) => b.payroll,
    align: "right",
    numFmt: "#,##0",
  },
];

async function exportBranchComparisonExcel(
  branches: BranchPerformanceItem[],
  payrollSeries: BranchPayrollSeries[],
  scope: "visible" | "full",
  periodLabel: string,
  organization: { name?: string } | undefined,
) {
  const rows: BranchComparisonRow[] = branches.map((b) => ({
    ...b,
    score: computeHealthScore(b),
  }));

  const workbook = buildExcelWorkbook({
    title: "Branch Comparison",
    titleTag: scope === "full" ? "Full Report" : "Visible Period",
    reportPeriod: periodLabel,
    organization,
    sheetName: "Branch Comparison",
    data: rows,
    columns: BRANCH_COMPARISON_COLUMNS,
  });

  if (scope === "full" && payrollSeries.length) {
    const payrollRows = payrollSeries.flatMap((ps) =>
      ps.data.map((d) => ({
        branchName: ps.branchName,
        month: d.month,
        payroll: d.Payroll,
        overtime: d.Overtime,
      })),
    );
    const payrollSheetWorkbook = buildExcelWorkbook({
      title: "Monthly Payroll Breakdown",
      reportPeriod: periodLabel,
      organization,
      sheetName: "Payroll Breakdown",
      data: payrollRows,
      columns: [
        { header: "Branch", accessor: (r) => r.branchName },
        { header: "Month", accessor: (r) => r.month },
        {
          header: "Payroll",
          accessor: (r) => r.payroll,
          align: "right",
          numFmt: "#,##0",
        },
        {
          header: "Overtime",
          accessor: (r) => r.overtime,
          align: "right",
          numFmt: "#,##0",
        },
      ],
    });
    // buildExcelWorkbook always produces a single-sheet workbook — build the
    // breakdown as its own workbook, then move its one worksheet onto the
    // main workbook as a second tab, rather than teaching the shared
    // builder about a multi-table/multi-sheet shape only this page needs.
    const [payrollSheet] = payrollSheetWorkbook.worksheets;
    if (payrollSheet) {
      const clonedSheet = workbook.addWorksheet(payrollSheet.name);
      payrollSheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const targetRow = clonedSheet.getRow(rowNumber);
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const targetCell = targetRow.getCell(colNumber);
          targetCell.value = cell.value;
          targetCell.style = { ...cell.style };
        });
        targetRow.height = row.height;
      });
      payrollSheet.columns.forEach((col, i) => {
        clonedSheet.getColumn(i + 1).width = col.width;
      });
      // Re-apply merged ranges (the header band / meta lines rely on these)
      // — cell-by-cell copy above doesn't carry merge state on its own.
      const mergeRanges = (payrollSheet.model.merges ?? []) as string[];
      mergeRanges.forEach((range) => clonedSheet.mergeCells(range));
    }
  }

  await downloadExcel(`branch-comparison-${scope}-${Date.now()}`, workbook);
}

// ─── Small sub-components ─────────────────────────────────────────────────────

const AttendanceBarSparkline: React.FC<{
  data: { day: string; count: number }[];
  color: string;
}> = ({ data, color }) => (
  <ResponsiveContainer width="100%" height={36}>
    <BarChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
      <Bar dataKey="count" fill={color} maxBarSize={8} radius={[3, 3, 0, 0]} />
    </BarChart>
  </ResponsiveContainer>
);

const TrendBadge: React.FC<{ value: number; higherIsBetter: boolean }> = ({
  value,
  higherIsBetter,
}) => {
  if (value === 0)
    return (
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: T.muted,
          display: "flex",
          alignItems: "center",
          gap: 2,
        }}
      >
        <Minus size={10} /> —
      </span>
    );

  const isGood = higherIsBetter ? value > 0 : value < 0;
  const color = isGood ? "#059669" : "#E11D48";
  const bg = isGood ? "#ECFDF5" : "#FFF1F2";
  const Icon = value > 0 ? ChevronUp : ChevronDown;

  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        color,
        background: bg,
        padding: "1px 6px",
        borderRadius: 20,
        display: "inline-flex",
        alignItems: "center",
        gap: 1,
      }}
    >
      <Icon size={10} />
      {Math.abs(value)}%
    </span>
  );
};

// ─── Export modal ─────────────────────────────────────────────────────────────

const ExportModal: React.FC<{
  periodLabel: string;
  onExport: (scope: "visible" | "full") => void;
  onClose: () => void;
}> = ({ periodLabel, onExport, onClose }) => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.3)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1000,
    }}
    onClick={onClose}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 16,
        padding: 28,
        width: 360,
        boxShadow: "0 16px 40px rgba(0,0,0,0.15)",
      }}
    >
      <div
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: T.head,
          marginBottom: 6,
        }}
      >
        Export Branch Report
      </div>
      <p style={{ fontSize: 12, color: T.muted, marginBottom: 20 }}>
        Current period:{" "}
        <strong style={{ color: T.teal600 }}>{periodLabel}</strong>
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <JellyButton
          variant="primary"
          size="md"
          fullWidth
          onClick={() => {
            onExport("visible");
            onClose();
          }}
          style={{
            flexDirection: "column",
            alignItems: "flex-start",
            height: "auto",
            padding: "12px 16px",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            Export Visible Period Data
          </div>
          <div
            style={{
              fontSize: 11,
              opacity: 0.8,
              fontWeight: 400,
              marginTop: 2,
            }}
          >
            All branches · {periodLabel} · KPI snapshot
          </div>
        </JellyButton>

        <JellyButton
          variant="secondary"
          size="md"
          fullWidth
          onClick={() => {
            onExport("full");
            onClose();
          }}
          style={{
            flexDirection: "column",
            alignItems: "flex-start",
            height: "auto",
            padding: "12px 16px",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            Export Full Year Report
          </div>
          <div
            style={{
              fontSize: 11,
              color: T.muted,
              fontWeight: 400,
              marginTop: 2,
            }}
          >
            Includes monthly payroll breakdown for all branches
          </div>
        </JellyButton>
      </div>

      <JellyButton
        variant="ghost"
        size="sm"
        fullWidth
        onClick={onClose}
        style={{ marginTop: 16 }}
      >
        Cancel
      </JellyButton>
    </div>
  </div>
);

// ─── Metric chip ──────────────────────────────────────────────────────────────
// Isolated so the active/idle variants don't re-render the entire metrics strip.

const MetricChip: React.FC<{
  metric: MetricDef;
  active: boolean;
  onClick: () => void;
}> = ({ metric, active, onClick }) => (
  <JellyButton
    variant={active ? "primary" : "ghost"}
    size="sm"
    leftIcon={metric.icon}
    onClick={onClick}
  >
    {metric.shortLabel}
  </JellyButton>
);

// ─── Main component ───────────────────────────────────────────────────────────

const BranchComparisonTab: React.FC = () => {
  const dashData = useDashboardOverviewData({ scope: "global" });
  const {
    branchPerformance,
    branchWeeklyAttendance,
    branchPayrollTrends,
    branchAttendancePerformance,
  } = dashData;

  // ── Date filter — isolated to THIS component only ─────────────────────────
  const filter = useDateFilter("monthly");

  // ── Org identity for the export header band ─────────────────────────────
  const { cfg } = useOrg();
  const exportOrganization = useMemo(
    () => ({ name: cfg.orgName || undefined }),
    [cfg.orgName],
  );

  // ── Other state ───────────────────────────────────────────────────────────
  const [activeMetric, setActiveMetric] = useState<MetricKey>("avgAttendance");
  const [showExportModal, setShowExportModal] = useState(false);
  const [sortKey, setSortKey] = useState<MetricKey>("avgAttendance");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // ── Period-aware data scaling ─────────────────────────────────────────────
  const filteredBranchPerformance = useMemo<BranchPerformanceItem[]>(() => {
    if (filter.mode === "daily") {
      return branchPerformance;
    }

    if (filter.mode === "weekly") {
      return branchPerformance.map((b) => ({
        ...b,
        presentToday: Math.round(b.presentToday * 0.85),
        lateToday: Math.round(b.lateToday * 1.15),
        avgAttendance: Math.max(50, b.avgAttendance - 4),
        payroll: Math.round(b.payroll * 0.25),
        cctvAlerts: Math.round(b.cctvAlerts * 0.3),
      }));
    }

    if (filter.mode === "monthly") {
      return branchPerformance;
    }

    if (filter.mode === "custom") {
      const days = filter.dates.length;
      const ratio = Math.min(days / 30, 1);
      return branchPerformance.map((b) => ({
        ...b,
        presentToday: Math.round(b.presentToday * ratio),
        lateToday: Math.round(b.lateToday * ratio),
        avgAttendance: Math.max(
          50,
          Math.round(b.avgAttendance * (0.92 + ratio * 0.08)),
        ),
        payroll: Math.round(b.payroll * ratio),
        cctvAlerts: Math.round(b.cctvAlerts * ratio),
      }));
    }

    return branchPerformance;
  }, [branchPerformance, filter.mode, filter.dates]);

  // ── Derived data ──────────────────────────────────────────────────────────
  const sorted = useMemo(() => {
    return [...filteredBranchPerformance].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "desc" ? -diff : diff;
    });
  }, [filteredBranchPerformance, sortKey, sortDir]);

  const barData = useMemo(() => {
    const metricDef = METRICS.find((m) => m.key === activeMetric)!;
    return filteredBranchPerformance.map((b, i) => ({
      name: b.branchName.split(" ")[0],
      fullName: b.branchName,
      value: b[activeMetric],
      color: branchColor(
        branchPerformance.findIndex((bp) => bp.branchId === b.branchId) ?? i,
      ),
      formatted: metricDef.format(b[activeMetric]),
    }));
  }, [filteredBranchPerformance, activeMetric, branchPerformance]);

  const healthScores = useMemo(
    () =>
      filteredBranchPerformance.map((b) => ({
        ...b,
        score: computeHealthScore(b),
      })),
    [filteredBranchPerformance],
  );

  const handleExport = useCallback(
    (scope: "visible" | "full") => {
      void exportBranchComparisonExcel(
        filteredBranchPerformance,
        branchPayrollTrends,
        scope,
        filter.label,
        exportOrganization,
      );
    },
    [filteredBranchPerformance, branchPayrollTrends, filter.label, exportOrganization],
  );

  const handleSort = (key: MetricKey) => {
    if (key === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const stableColorIdx = (branchId: number, fallback: number) => {
    const idx = branchPerformance.findIndex((bp) => bp.branchId === branchId);
    return idx === -1 ? fallback : idx;
  };

  const activeMeta = METRICS.find((m) => m.key === activeMetric)!;

  if (branchPerformance.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          padding: "60px 0",
          color: T.muted,
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <BarChart2 size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
        <div style={{ fontWeight: 600 }}>No branches configured.</div>
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: "'DM Sans', sans-serif",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <h2
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: T.head,
              margin: 0,
              letterSpacing: "-0.3px",
            }}
          >
            Branch Comparison
          </h2>
          <p style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
            {branchPerformance.length} branches · Side-by-side metrics ·{" "}
            <span style={{ color: T.teal600, fontWeight: 600 }}>
              {filter.label}
            </span>
          </p>
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

          <JellyButton
            variant="primary"
            size="sm"
            leftIcon={<Download />}
            onClick={() => setShowExportModal(true)}
          >
            Export Excel
          </JellyButton>
        </div>
      </div>

      {/* ── KPI cards strip ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(filteredBranchPerformance.length, 4)}, minmax(0, 1fr))`,
          gap: 12,
        }}
      >
        {filteredBranchPerformance.map((b, i) => {
          const colorIdx = stableColorIdx(b.branchId, i);
          const color = branchColor(colorIdx);
          const score = computeHealthScore(b);
          const hl = healthLabel(score);
          const weekly = branchWeeklyAttendance.find(
            (w) => w.branchId === b.branchId,
          );

          return (
            <Card key={b.branchId} padding="16px 18px">
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  marginBottom: 10,
                }}
              >
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 2,
                    }}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 3,
                        background: color,
                        display: "inline-block",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: T.head,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: 130,
                      }}
                    >
                      {b.branchName}
                    </span>
                  </div>
                  {b.city && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 3,
                        fontSize: 10,
                        color: T.muted,
                      }}
                    >
                      <MapPin size={9} />
                      {b.city}
                    </div>
                  )}
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: hl.color,
                    background: hl.bg,
                    padding: "2px 8px",
                    borderRadius: 20,
                    flexShrink: 0,
                  }}
                >
                  {score}
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "6px 10px",
                  marginBottom: 10,
                }}
              >
                {[
                  { label: "Staff", value: b.totalStaff.toLocaleString() },
                  { label: "Attendance", value: `${b.avgAttendance}%` },
                  { label: "Present", value: b.presentToday },
                  { label: "Late", value: b.lateToday },
                  {
                    label: "Payroll",
                    value:
                      b.payroll >= 1_000_000
                        ? `${(b.payroll / 1_000_000).toFixed(1)}M`
                        : `${Math.round(b.payroll / 1_000)}K`,
                  },
                  { label: "CCTV Alerts", value: b.cctvAlerts },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div
                      style={{
                        fontSize: 9,
                        color: T.muted,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}
                    >
                      {label}
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 800,
                        color: T.head,
                        letterSpacing: "-0.3px",
                      }}
                    >
                      {value}
                    </div>
                  </div>
                ))}
              </div>

              {weekly && (
                <div>
                  <div
                    style={{
                      fontSize: 9,
                      color: T.muted,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      marginBottom: 3,
                    }}
                  >
                    7-day Attendance
                  </div>
                  <AttendanceBarSparkline data={weekly.data} color={color} />
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* ── Bar chart + metric toggle ── */}
      <Card>
        <SH
          title="Metric Comparison"
          sub={`${activeMeta.label} across all branches · ${filter.label}`}
          right={
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
              {METRICS.map((m) => (
                <MetricChip
                  key={m.key}
                  metric={m}
                  active={activeMetric === m.key}
                  onClick={() => setActiveMetric(m.key)}
                />
              ))}
            </div>
          }
        />

        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={barData}
              margin={{ top: 24, right: 16, left: 0, bottom: 4 }}
              barCategoryGap="28%"
            >
              <CartesianGrid vertical={false} stroke={T.slate100} />
              <XAxis
                dataKey="name"
                axisLine={false}
                tickLine={false}
                tick={{
                  fontSize: 11,
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
                tickFormatter={activeMeta.format}
              />
              <Tooltip
                formatter={(value) => [
                  activeMeta.format(tooltipValueToNumber(value)),
                  activeMeta.label,
                ]}
                labelFormatter={(label, payload) =>
                  payload?.[0]?.payload?.fullName ?? label
                }
                contentStyle={{
                  borderRadius: 10,
                  border: `1px solid ${T.border}`,
                  fontSize: 12,
                  fontFamily: "'DM Sans', sans-serif",
                }}
              />
              <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={56}>
                {barData.map((entry, i) => (
                  <Cell key={`cell-${i}`} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "6px 16px",
            marginTop: 12,
            paddingTop: 12,
            borderTop: `1px solid ${T.slate100}`,
          }}
        >
          {filteredBranchPerformance.map((b, i) => {
            const colorIdx = stableColorIdx(b.branchId, i);
            return (
              <div
                key={b.branchId}
                style={{ display: "flex", alignItems: "center", gap: 5 }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 3,
                    background: branchColor(colorIdx),
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 11, color: T.muted, fontWeight: 500 }}>
                  {b.branchName}
                </span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Attendance performance + Payroll trends ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <SH
            title="Attendance Performance"
            sub={`On-time % by branch · ${filter.label}`}
          />
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={branchAttendancePerformance
                  .flatMap((b, i) =>
                    b.data.map((d) => ({
                      ...d,
                      branchName: b.branchName,
                      color: branchColor(i),
                    })),
                  )
                  .reduce<{ month: string; [key: string]: string | number }[]>(
                    (acc, row) => {
                      const existing = acc.find((r) => r.month === row.month);
                      if (existing) existing[row.branchName] = row["On Time"];
                      else
                        acc.push({
                          month: row.month,
                          [row.branchName]: row["On Time"],
                        });
                      return acc;
                    },
                    [],
                  )}
                barCategoryGap="22%"
                barGap={2}
                margin={{ top: 10, right: 10, left: 0, bottom: 4 }}
              >
                <CartesianGrid vertical={false} stroke={T.slate100} />
                <XAxis
                  dataKey="month"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: T.muted }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: T.muted }}
                  tickFormatter={(v) => `${v}%`}
                  domain={[0, 100]}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: `1px solid ${T.border}`,
                    fontSize: 11,
                    fontFamily: "'DM Sans', sans-serif",
                  }}
                />
                {branchAttendancePerformance.map((b, i) => (
                  <Bar
                    key={b.branchId}
                    dataKey={b.branchName}
                    fill={branchColor(i)}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={20}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <SH
            title="Payroll Trends"
            sub="Monthly payroll by branch · Full year"
          />
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={
                  branchPayrollTrends[0]?.data.map((d, monthIdx) => ({
                    month: d.month,
                    ...Object.fromEntries(
                      branchPayrollTrends.map((b) => [
                        b.branchName,
                        b.data[monthIdx]?.Payroll ?? 0,
                      ]),
                    ),
                  })) ?? []
                }
                margin={{ top: 8, right: 10, left: 0, bottom: 4 }}
              >
                <defs>
                  {branchPayrollTrends.map((b, i) => (
                    <linearGradient
                      key={b.branchId}
                      id={`payGrad_${b.branchId}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor={branchColor(i)}
                        stopOpacity={0.15}
                      />
                      <stop
                        offset="95%"
                        stopColor={branchColor(i)}
                        stopOpacity={0}
                      />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid vertical={false} stroke={T.slate100} />
                <XAxis
                  dataKey="month"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: T.muted }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: T.muted }}
                  tickFormatter={(v) =>
                    v >= 1_000_000
                      ? `${(v / 1_000_000).toFixed(1)}M`
                      : `${Math.round(v / 1_000)}K`
                  }
                />
                <Tooltip
                  formatter={(value, name) => {
                    const num = tooltipValueToNumber(value);
                    return [
                      num >= 1_000_000
                        ? `${(num / 1_000_000).toFixed(1)}M`
                        : `${Math.round(num / 1_000)}K`,
                      String(name ?? ""),
                    ];
                  }}
                  contentStyle={{
                    borderRadius: 10,
                    border: `1px solid ${T.border}`,
                    fontSize: 11,
                    fontFamily: "'DM Sans', sans-serif",
                  }}
                />
                {branchPayrollTrends.map((b, i) => (
                  <Area
                    key={b.branchId}
                    type="monotone"
                    dataKey={b.branchName}
                    stroke={branchColor(i)}
                    strokeWidth={2}
                    fill={`url(#payGrad_${b.branchId})`}
                    dot={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* ── Health scores ── */}
      <Card>
        <SH
          title="Branch Health Scores"
          sub="Composite score: 50% attendance · 20% punctuality · 30% security"
          right={
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { label: "Excellent", color: "#059669", bg: "#ECFDF5" },
                { label: "Good", color: T.teal600, bg: T.teal100 },
                { label: "Fair", color: "#D97706", bg: "#FEF3C7" },
                { label: "Needs Attention", color: "#E11D48", bg: "#FFF1F2" },
              ].map((h) => (
                <span
                  key={h.label}
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: h.color,
                    background: h.bg,
                    padding: "2px 8px",
                    borderRadius: 20,
                  }}
                >
                  {h.label}
                </span>
              ))}
            </div>
          }
        />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${Math.min(filteredBranchPerformance.length, 4)}, minmax(0, 1fr))`,
            gap: 12,
          }}
        >
          {healthScores
            .slice()
            .sort((a, b) => b.score - a.score)
            .map((b, i) => {
              const hl = healthLabel(b.score);
              const rank = i + 1;
              const colorIdx = stableColorIdx(b.branchId, i);
              const color = branchColor(colorIdx);

              return (
                <div
                  key={b.branchId}
                  style={{
                    background: `${color}08`,
                    border: `1.5px solid ${color}30`,
                    borderRadius: 12,
                    padding: "14px 16px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <span
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: "50%",
                          background: color,
                          color: "#fff",
                          fontSize: 10,
                          fontWeight: 800,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        {rank}
                      </span>
                      <div>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: T.head,
                          }}
                        >
                          {b.branchName}
                        </div>
                        {b.city && (
                          <div style={{ fontSize: 10, color: T.muted }}>
                            {b.city}
                          </div>
                        )}
                      </div>
                    </div>
                    <Star
                      size={13}
                      color={rank === 1 ? "#D97706" : T.muted}
                      fill={rank === 1 ? "#D97706" : "none"}
                    />
                  </div>

                  <div
                    style={{
                      fontSize: 28,
                      fontWeight: 800,
                      color,
                      letterSpacing: "-0.5px",
                      lineHeight: 1,
                      marginBottom: 6,
                    }}
                  >
                    {b.score}
                    <span
                      style={{ fontSize: 12, fontWeight: 500, color: T.muted }}
                    >
                      /100
                    </span>
                  </div>

                  <div
                    style={{
                      height: 6,
                      background: T.slate100,
                      borderRadius: 3,
                      overflow: "hidden",
                      marginBottom: 8,
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${b.score}%`,
                        background: color,
                        borderRadius: 3,
                        transition: "width .6s ease",
                      }}
                    />
                  </div>

                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: hl.color,
                      background: hl.bg,
                      padding: "2px 8px",
                      borderRadius: 20,
                    }}
                  >
                    {hl.label}
                  </span>
                </div>
              );
            })}
        </div>
      </Card>

      {/* ── Rank table ── */}
      <Card padding={0}>
        <div style={{ padding: "16px 20px 12px" }}>
          <SH
            title="All Metrics — Rank Table"
            sub="Click column header to sort"
          />
        </div>

        <div style={{ overflowX: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}
          >
            <thead>
              <tr style={{ background: T.slate100 }}>
                <th
                  style={{
                    padding: "10px 20px",
                    textAlign: "left",
                    fontSize: 10,
                    fontWeight: 700,
                    color: T.muted,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    whiteSpace: "nowrap",
                    borderBottom: `1px solid ${T.border}`,
                  }}
                >
                  Branch
                </th>
                {METRICS.map((m) => (
                  <th
                    key={m.key}
                    onClick={() => handleSort(m.key)}
                    style={{
                      padding: "10px 16px",
                      textAlign: "right",
                      fontSize: 10,
                      fontWeight: 700,
                      color: sortKey === m.key ? T.teal600 : T.muted,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      borderBottom: `1px solid ${T.border}`,
                      userSelect: "none",
                    }}
                  >
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      {m.shortLabel}
                      {sortKey === m.key ? (
                        sortDir === "desc" ? (
                          <ChevronDown size={10} />
                        ) : (
                          <ChevronUp size={10} />
                        )
                      ) : null}
                    </div>
                  </th>
                ))}
                <th
                  style={{
                    padding: "10px 20px",
                    textAlign: "right",
                    fontSize: 10,
                    fontWeight: 700,
                    color: T.muted,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    borderBottom: `1px solid ${T.border}`,
                  }}
                >
                  Health
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((b, rowIdx) => {
                const colorIdx = stableColorIdx(b.branchId, rowIdx);
                const color = branchColor(colorIdx);
                const score = computeHealthScore(b);
                const hl = healthLabel(score);

                return (
                  <tr
                    key={b.branchId}
                    style={{
                      borderBottom: `1px solid ${T.slate100}`,
                      transition: "background .1s",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = T.slate100)
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "transparent")
                    }
                  >
                    <td style={{ padding: "12px 20px" }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 3,
                            background: color,
                            flexShrink: 0,
                            display: "inline-block",
                          }}
                        />
                        <div>
                          <div style={{ fontWeight: 700, color: T.head }}>
                            {b.branchName}
                          </div>
                          {b.city && (
                            <div style={{ fontSize: 10, color: T.muted }}>
                              {b.city}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>

                    {METRICS.map((m) => (
                      <td
                        key={m.key}
                        style={{ padding: "12px 16px", textAlign: "right" }}
                      >
                        <div
                          style={{
                            fontWeight: 700,
                            color: sortKey === m.key ? color : T.head,
                            fontSize: 13,
                          }}
                        >
                          {m.format(b[m.key])}
                        </div>
                        <TrendBadge
                          value={0}
                          higherIsBetter={m.higherIsBetter}
                        />
                      </td>
                    ))}

                    <td style={{ padding: "12px 20px", textAlign: "right" }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                          color: hl.color,
                          background: hl.bg,
                          padding: "3px 10px",
                          borderRadius: 20,
                        }}
                      >
                        {score}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {showExportModal && (
        <ExportModal
          periodLabel={filter.label}
          onExport={handleExport}
          onClose={() => setShowExportModal(false)}
        />
      )}
    </div>
  );
};

export default React.memo(BranchComparisonTab);
