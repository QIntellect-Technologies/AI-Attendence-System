/**
 * modules/reports/index.tsx — REFACTORED
 * ─────────────────────────────────────────────────────────────────────────────
 * Reports & Analytics — follows OvertimeManagement architecture pattern.
 * Uses ExportCsvButton with jelly hover fill effect.
 *
 * Scope resolution:
 *   - Route param :branchId + ModuleContext.activeBranchId (same as OvertimeManagement)
 *   - Admin/global dashboard: shows all branches, branch filter visible
 *   - Branch dashboard: locked to branch scope, no filter shown
 *
 * Data flow:
 *   ModuleContext (single source) → useReportMetrics hook (compute)
 *                                 → Reports component (display)
 */

import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  TrendingUp,
  Users,
  CalendarDays,
  Banknote,
  AlertCircle,
  Activity,
  Building2,
  BarChart3,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ValueType,
  NameType,
} from "recharts/types/component/DefaultTooltipContent";

import { useOrg } from "../../contexts/OrgConfigContext";
import { useModule } from "../../contexts/ModuleContext";
import {
  resolveActivePeopleTypes,
  resolvePeopleRenderingModel,
  resolveModulePeopleTypes,
  normalizePeopleType,
  peopleLabelForType,
} from "../../utils/templateRendering";
import { T } from "../../components/ui/theme";
import DynamicFilterToolbar, {
  type DynamicFilterSection,
} from "../../components/ui/DynamicFilterToolbar";
import ExportCsvButton, {
  type ExportCsvColumn,
} from "../../components/ui/ExportCsvButton";
import RefreshButton from "../../components/ui/RefreshButton";

import { useReportMetrics } from "./hooks/useReportMetrics";
import { useReportFilters } from "./hooks/useReportFilters";
import { buildExportRows, type ReportExportRow } from "./utils/reports.export";

import { isModuleEnabled } from "../../utils/moduleAccess";
import { formatPKR, periodLabel } from "./utils/reports.metrics";

// ─── UI atoms ─────────────────────────────────────────────────────────────────

const StatCard: React.FC<{
  label: string;
  value: string | number;
  sub: string;
  Icon: React.ComponentType<{ size?: number; color?: string }>;
}> = ({ label, value, sub, Icon }) => (
  <div
    style={{
      background: T.card,
      border: `1px solid ${T.border}`,
      borderRadius: 18,
      padding: 18,
      boxShadow: "0 1px 3px rgba(15,45,74,0.07),0 1px 2px rgba(15,45,74,0.04)",
      minHeight: 118,
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
    }}
  >
    <div
      style={{
        width: 38,
        height: 38,
        borderRadius: 13,
        background: T.teal50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon size={18} color={T.teal600} />
    </div>
    <div>
      <div
        style={{
          fontSize: 10,
          color: T.muted,
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: ".08em",
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 25, fontWeight: 950, color: T.navy600 }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>{sub}</div>
    </div>
  </div>
);

const TabButton: React.FC<{
  active: boolean;
  label: string;
  onClick: () => void;
}> = ({ active, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      border: "none",
      borderRadius: 10,
      padding: "9px 16px",
      fontSize: 12,
      fontWeight: 900,
      cursor: "pointer",
      fontFamily: "inherit",
      background: active ? T.navy700 : "transparent",
      color: active ? "white" : T.muted,
      boxShadow: active ? "0 1px 3px rgba(15,45,74,0.08)" : "none",
    }}
  >
    {label}
  </button>
);

const Panel: React.FC<{
  title: string;
  subtitle: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}> = ({ title, subtitle, children, right }) => (
  <div
    style={{
      background: T.card,
      border: `1px solid ${T.border}`,
      borderRadius: 18,
      padding: 18,
      boxShadow: "0 1px 3px rgba(15,45,74,0.07),0 1px 2px rgba(15,45,74,0.04)",
      marginTop: 16,
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 14,
        alignItems: "flex-start",
        marginBottom: 16,
      }}
    >
      <div>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 950, color: T.head }}>
          {title}
        </h3>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: T.muted }}>
          {subtitle}
        </p>
      </div>
      {right}
    </div>
    {children}
  </div>
);

const EmptyChartState: React.FC<{ message: string }> = ({ message }) => (
  <div
    style={{
      minHeight: 320,
      border: `1px dashed ${T.border}`,
      borderRadius: 16,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      color: T.muted,
      fontSize: 13,
      fontWeight: 800,
      background: T.slate50,
    }}
  >
    {message}
  </div>
);

// ─── Tooltip formatters ────────────────────────────────────────────────────────

const payrollFormatter = (
  value: ValueType | undefined,
  _name: NameType | undefined,
): string =>
  typeof value === "number" ? formatPKR(value) : String(value ?? "");

const percentFormatter = (
  value: ValueType | undefined,
  _name: NameType | undefined,
): string => (typeof value === "number" ? `${value}%` : String(value ?? ""));

// ─── Color palette ────────────────────────────────────────────────────────────

const PALETTE = [T.teal600, T.navy600, T.amber, "#7c3aed", "#e11d48"];

// ─── FIX: Safe branch ID resolver ─────────────────────────────────────────────
// Validates that the value is a finite positive integer before treating it as
// a real branch ID. This guards against activeBranchId = 0 (from URL sync
// before the org bootstrap completes), which would incorrectly scope the
// dashboard to a non-existent branch.
function toBranchId(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

// ─── Main component ───────────────────────────────────────────────────────────

type ReportTab = "attendance" | "payroll" | "performance" | "distribution";

// Single source of truth for tab labels — reused by the tab bar, the
// "Report" filter select, and the chart title mapping so there's exactly
// one place that knows what each tab is called.
const TAB_LABELS: Record<ReportTab, string> = {
  attendance: "Attendance Trend",
  payroll: "Payroll Analysis",
  performance: "Performance",
  distribution: "Status Distribution",
};

const Reports: React.FC = () => {
  const params = useParams<{ branchId?: string }>();
  const { cfg, activeBranchId } = useOrg();
  const { staff, leave, payroll, refreshing, refresh } = useModule();

  // ── Scope resolution (same as OvertimeManagement) ──────────────────────────
  // FIX: Use toBranchId() for both sources so that 0 (or any non-positive
  // integer) coming from activeBranchId or a malformed URL param is treated as
  // "no branch" rather than silently scoping to branch 0.
  const routeBranchId = toBranchId(
    params.branchId ? Number(params.branchId) : undefined,
  );
  const effectiveBranchId: number | null =
    toBranchId(activeBranchId) ?? routeBranchId;
  const isGlobalDashboard = effectiveBranchId === null;

  const allBranches = useMemo(() => cfg.branches ?? [], [cfg.branches]);

  const modulePeopleTypes = useMemo(
    () => resolveModulePeopleTypes(cfg, "reports", effectiveBranchId),
    [cfg, effectiveBranchId],
  );

  const payrollPeopleTypes = useMemo(
    () => resolveModulePeopleTypes(cfg, "payroll", effectiveBranchId),
    [cfg, effectiveBranchId],
  );

  // ── Branch lookup for name resolution ───────────────────────────────────────
  const branchLookup = useMemo(() => {
    const map = new Map<number, string>();

    allBranches.forEach((branch) => {
      const branchId = toBranchId(branch.id);
      if (branchId !== null) {
        map.set(branchId, branch.name);
      }
    });

    staff.allItems.forEach((member) => {
      const branchId = toBranchId(member.branchId);
      if (branchId !== null && !map.has(branchId)) {
        map.set(branchId, member.branchName ?? `Branch ${branchId}`);
      }
    });

    return map;
  }, [allBranches, staff.allItems]);

  // ── Scope data (apply branch filter in global mode only) ────────────────────
  const scopedStaff = isGlobalDashboard ? staff.allItems : staff.items;
  const scopedLeave = isGlobalDashboard ? leave.allItems : leave.items;
  const scopedPayroll = isGlobalDashboard ? payroll.allItems : payroll.items;

  const staffCountByPeopleType = useMemo(() => {
    const counts: Record<string, number> = {};
    scopedStaff.forEach((member) => {
      const type = normalizePeopleType(
        (member as unknown as { peopleType?: string; people_type?: string })
          .peopleType ??
          (member as unknown as { people_type?: string }).people_type,
      );
      counts[type] = (counts[type] ?? 0) + 1;
    });
    return counts;
  }, [scopedStaff]);

  // ── Template awareness ─────────────────────────────────────────────────────
  const activePeopleTypes = useMemo(() => resolveActivePeopleTypes(cfg), [cfg]);
  const visiblePeopleTypes = useMemo(
    () =>
      modulePeopleTypes.length
        ? modulePeopleTypes.filter((type) => activePeopleTypes.includes(type))
        : activePeopleTypes,
    [activePeopleTypes, modulePeopleTypes],
  );

  // ── Filter state ────────────────────────────────────────────────────────────
  const {
    branchFilter,
    peopleTypeFilter,
    period,
    search,
    setBranchFilter,
    setPeopleTypeFilter,
    setPeriod,
    setSearch,
    reset,
    peopleTypeOptions,
  } = useReportFilters({
    allBranches,
    isGlobalDashboard,
    staffCount: scopedStaff.length,
    visiblePeopleTypes,
    peopleTypeLabel: (type) => peopleLabelForType(type, cfg).plural,
    staffCountByPeopleType,
  });

  const [activeTab, setActiveTab] = useState<ReportTab>("attendance");

  // ── People-type-aware rendering model ──────────────────────────────────────
  // Resolved from the ACTIVE "People Type" filter selection — not the
  // org-wide type count — so stats/charts/tabs update live as the user
  // switches the dropdown. Selecting "Students" resolves supportsPayroll to
  // false (student family never has payroll); selecting "Staff" restores it.
  // `visiblePeopleTypes` scopes the model to what's actually enabled for the
  // Reports module in this branch, matching the dropdown's own options.
  // "All People" (peopleTypeFilter === "all") falls back to the module's
  // first visible type so the unfiltered view still has sensible copy.
  const peopleModel = useMemo(
    () =>
      resolvePeopleRenderingModel(
        cfg,
        peopleTypeFilter !== "all" ? peopleTypeFilter : undefined,
        visiblePeopleTypes,
      ),
    [cfg, peopleTypeFilter, visiblePeopleTypes],
  );
  const orgHasPayrollModule = useMemo(
    () => isModuleEnabled(cfg.modules, "payroll"),
    [cfg.modules],
  );
  const showPayrollStat =
  orgHasPayrollModule && payrollPeopleTypes.includes(peopleModel.peopleType);

  // Hide the Payroll tab for people types that don't support payroll
  // (e.g. students). This list drives the tab bar, the "Report" filter
  // select, AND the guard below — one place decides what's visible.
  const visibleTabs: ReportTab[] = useMemo(
    () =>
      showPayrollStat
        ? ["attendance", "payroll", "performance", "distribution"]
        : ["attendance", "performance", "distribution"],
    [showPayrollStat],
  );

  // effectiveTab: activeTab clamped to visibleTabs, read by everything
  // below instead of raw activeTab. Guarantees the title/chart/tab-bar are
  // never inconsistent for a render — even the one right after People Type
  // changes and Payroll drops out — without waiting on an effect to fire.
  const effectiveTab: ReportTab = visibleTabs.includes(activeTab)
    ? activeTab
    : "attendance";

  // Persist the clamp back into state too, so activeTab (and anything that
  // reads it directly elsewhere, e.g. the CSV filename) stays in sync
  // rather than silently diverging from what's on screen. Guards against
  // orphaned state: if the user is on Payroll and switches People Type to
  // something without payroll support, activeTab would otherwise keep
  // pointing at a hidden tab with no button highlighted.
  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab("attendance");
    }
  }, [visibleTabs, activeTab]);

  // ── Metric computation ─────────────────────────────────────────────────────
  const {
    branchMetrics,
    departmentMetrics,
    totals,
    trendData,
    branchTrendData,
    isAllBranchAdmin,
    selectedBranchLabel,
  } = useReportMetrics({
    staff: scopedStaff,
    leave: scopedLeave,
    payroll: scopedPayroll,
    activeBranchId: effectiveBranchId,
    allBranches,
    branchLookup,
    branchFilter,
    peopleType: peopleTypeFilter,
    period,
    isGlobalDashboard,
  });

  // ── Export rows ────────────────────────────────────────────────────────────
  const exportRows = useMemo<ReportExportRow[]>(
    () =>
      buildExportRows({
        branchMetrics,
        departmentMetrics,
        selectedBranchLabel,
        period,
        search,
        personPlural: peopleModel.personPlural,
        groupLabel: peopleModel.groupLabel,
        groupPlural: peopleModel.groupPlural,
        supportsPayroll: showPayrollStat,
      }),
    [
      branchMetrics,
      departmentMetrics,
      selectedBranchLabel,
      period,
      search,
      peopleModel.personPlural,
      peopleModel.groupLabel,
      peopleModel.groupPlural,
      showPayrollStat,
    ],
  );

  // ── Export columns ─────────────────────────────────────────────────────────
  const exportColumns = useMemo<ExportCsvColumn<ReportExportRow>[]>(
    () => [
      {
        header: "Branch",
        key: "branch" as keyof ReportExportRow,
      },
      {
        header: peopleModel.groupLabel,
        key: "department" as keyof ReportExportRow,
      },
      {
        header: "Metric",
        key: "metric" as keyof ReportExportRow,
      },
      {
        header: "Value",
        key: "value" as keyof ReportExportRow,
      },
      {
        header: "Period",
        key: "period" as keyof ReportExportRow,
      },
      {
        header: "Notes",
        key: "notes" as keyof ReportExportRow,
      },
    ],
    [peopleModel.groupLabel],
  );

  // ── Chart data (derived from metrics) ────────────────────────────────────────
  const performanceRows = useMemo(
    () =>
      (isAllBranchAdmin
        ? branchMetrics.map((m) => ({
            name: m.branchName,
            attendanceRate: m.attendanceRate,
            staff: m.totalStaff,
          }))
        : departmentMetrics.map((m) => ({
            name: m.department,
            attendanceRate: m.attendanceRate,
            staff: m.totalStaff,
          }))
      ).slice(0, 8),
    [branchMetrics, departmentMetrics, isAllBranchAdmin],
  );

  const payrollRows = useMemo(
    () =>
      (isAllBranchAdmin
        ? branchMetrics.map((m) => ({
            name: m.branchName,
            payroll: m.monthlyPayroll,
            staff: m.totalStaff,
          }))
        : departmentMetrics.map((m) => ({
            name: m.department,
            payroll: m.monthlyPayroll,
            staff: m.totalStaff,
          }))
      )
        .sort((a, b) => b.payroll - a.payroll)
        .slice(0, 8),
    [branchMetrics, departmentMetrics, isAllBranchAdmin],
  );

  const distributionRows = useMemo(
    () => [
      { name: "Present", value: totals.present },
      { name: "Late", value: totals.late },
      { name: "Absent", value: totals.absent },
    ],
    [totals],
  );

  // ── Filter toolbar config ──────────────────────────────────────────────────
  const filterSections = useMemo<DynamicFilterSection[]>(
    () => [
      {
        id: "branch",
        type: "select",
        label: "Branch",
        hidden: !isGlobalDashboard,
        value: branchFilter,
        minWidth: 220,
        options: [
          { value: "all", label: "All Branches", count: scopedStaff.length },
          ...allBranches.map((b) => ({
            value: String(b.id),
            label: b.name,
            count: scopedStaff.filter((m) => m.branchId === b.id).length,
          })),
        ],
        onChange: setBranchFilter,
      },
      {
        id: "peopleType",
        type: "select",
        label: "People Type",
        hidden: peopleTypeOptions.length === 0,
        value: peopleTypeFilter,
        minWidth: 180,
        options: peopleTypeOptions,
        onChange: setPeopleTypeFilter,
      },
      {
        id: "period",
        type: "select",
        label: "Period",
        value: period,
        minWidth: 155,
        options: [
          { value: "today", label: "Today" },
          { value: "7d", label: "Last 7 Days" },
          { value: "30d", label: "Last 30 Days" },
          { value: "month", label: "This Month" },
          { value: "all", label: "All Time" },
        ],
        onChange: (v) => setPeriod(v as typeof period),
      },
      {
        id: "report",
        type: "select",
        label: "Report",
        value: effectiveTab,
        minWidth: 220,
        options: visibleTabs.map((tab) => ({
          value: tab,
          label: TAB_LABELS[tab],
        })),
        onChange: (v) => setActiveTab(v as ReportTab),
      },
      {
        id: "search",
        type: "search",
        value: search,
        onChange: setSearch,
        grow: true,
        minWidth: 280,
        placeholder: `Search branch, ${peopleModel.groupLabel.toLowerCase()}, metric...`,
      },
      { id: "reset", type: "reset", label: "Clear", onClick: reset },
    ],
    [
      allBranches,
      branchFilter,
      effectiveTab,
      isGlobalDashboard,
      peopleModel.groupLabel,
      peopleTypeFilter,
      peopleTypeOptions,
      period,
      reset,
      search,
      scopedStaff,
      setBranchFilter,
      setPeopleTypeFilter,
      setPeriod,
      setSearch,
      visibleTabs,
    ],
  );

  // ── Derived labels ─────────────────────────────────────────────────────────
  const tableRows = exportRows.slice(0, 12);
  const activeChartTitle = {
    payroll: "Payroll Analysis",
    performance: "Attendance Performance",
    distribution: "Status Distribution",
    attendance: "Attendance Trend",
  }[effectiveTab];
  const activeChartSubtitle = `${selectedBranchLabel} · ${periodLabel(period)} · ${exportRows.length} export rows`;

  const GRADIENT_ID = "attendanceGradient";

  return (
    <div
      style={{
        padding: "24px 24px 48px",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
        background: T.bgPage,
        minHeight: "100%",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          alignItems: "flex-start",
          marginBottom: 18,
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              color: T.textHeading,
              fontSize: 24,
              fontWeight: 900,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <TrendingUp size={22} color={T.teal600} />
            Reports & Analytics
          </h1>
        </div>
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <RefreshButton
            size="md"
            loading={refreshing}
            onClick={refresh}
            ariaLabel="Refresh reports data"
          />
          <ExportCsvButton
            data={exportRows}
            columns={exportColumns}
            filename={`reports_${selectedBranchLabel}_${periodLabel(period)}_${effectiveTab}_${new Date().toISOString().split("T")[0]}.csv`}
            label="Export CSV"
            emptyMessage="No report data available to export."
          />
        </div>
      </div>

      <DynamicFilterToolbar
        sections={filterSections}
        bordered
        style={{ width: "100%" }}
      />

      {/* ── Stat cards ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 14,
          marginBottom: 16,
        }}
      >
        <StatCard
          Icon={Activity}
          label="Attendance Rate"
          value={`${totals.attendanceRate}%`}
          sub={`${totals.attended} of ${totals.totalStaff} attended`}
        />
        <StatCard
          Icon={Users}
          label={peopleModel.statsTotalLabel}
          value={totals.totalStaff}
          sub={
            isAllBranchAdmin
              ? `${allBranches.length} branches`
              : selectedBranchLabel
          }
        />
        {showPayrollStat ? (
          <StatCard
            Icon={Banknote}
            label="Monthly Payroll"
            value={formatPKR(totals.monthlyPayroll)}
            sub={`${totals.late} late arrivals`}
          />
        ) : (
          <StatCard
            Icon={CalendarDays}
            label="Leave Balance"
            value={totals.pendingLeaves}
            sub={`Pending review`}
          />
        )}
        <StatCard
          Icon={AlertCircle}
          label={showPayrollStat ? "Pending Leaves" : "Absent Today"}
          value={showPayrollStat ? totals.pendingLeaves : totals.absent}
          sub={
            showPayrollStat
              ? `${totals.absent} absent today`
              : `${totals.late} late arrivals`
          }
        />
      </div>

      {/* ── Tab bar ── */}
      <div
        style={{
          display: "flex",
          gap: 4,
          background: T.slate50,
          border: `1px solid ${T.border}`,
          borderRadius: 14,
          padding: 4,
          marginBottom: 16,
          width: "fit-content",
        }}
      >
        {visibleTabs.map((tab) => (
          <TabButton
            key={tab}
            active={effectiveTab === tab}
            label={TAB_LABELS[tab]}
            onClick={() => setActiveTab(tab)}
          />
        ))}
      </div>

      {/* ── Main chart + snapshot ── */}
      <div
        style={{ display: "grid", gridTemplateColumns: "1.45fr .9fr", gap: 16 }}
      >
        <Panel
          title={activeChartTitle}
          subtitle={activeChartSubtitle}
          right={<BarChart3 size={18} color={T.teal600} />}
        >
          {totals.totalStaff === 0 ? (
            <EmptyChartState message="No branch data is available for this report scope." />
          ) : effectiveTab === "payroll" && showPayrollStat ? (
            <div style={{ width: "100%", height: 340 }}>
              <ResponsiveContainer>
                <BarChart
                  data={payrollRows}
                  layout="vertical"
                  margin={{ top: 8, right: 20, left: 70, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={T.teal50} />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: T.muted }}
                    tickFormatter={(v: number) => `${Math.round(v / 1000)}K`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11, fill: T.muted }}
                    width={110}
                  />
                  <Tooltip formatter={payrollFormatter} />
                  <Bar
                    dataKey="payroll"
                    name="Payroll"
                    radius={[0, 8, 8, 0]}
                    fill={T.teal600}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : effectiveTab === "performance" ? (
            <div style={{ width: "100%", height: 340 }}>
              <ResponsiveContainer>
                <BarChart
                  data={performanceRows}
                  margin={{ top: 8, right: 20, left: 0, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={T.teal50} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: T.muted }}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: T.muted }}
                    domain={[0, 100]}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <Tooltip formatter={percentFormatter} />
                  <Bar
                    dataKey="attendanceRate"
                    name="Attendance Rate"
                    radius={[8, 8, 0, 0]}
                    fill={T.navy600}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : effectiveTab === "distribution" ? (
            <div style={{ width: "100%", height: 340 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={distributionRows}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={110}
                    paddingAngle={4}
                    label
                  >
                    {distributionRows.map((entry, i) => (
                      <Cell
                        key={entry.name}
                        fill={PALETTE[i % PALETTE.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            /* Attendance trend */
            <div style={{ width: "100%", height: 340 }}>
              <ResponsiveContainer>
                {isAllBranchAdmin ? (
                  <AreaChart
                    data={branchTrendData}
                    margin={{ top: 8, right: 20, left: 0, bottom: 8 }}
                  >
                    <defs>
                      <linearGradient
                        id={GRADIENT_ID}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor={T.teal600}
                          stopOpacity={0.28}
                        />
                        <stop
                          offset="95%"
                          stopColor={T.teal600}
                          stopOpacity={0.02}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.teal50} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: T.muted }}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: T.muted }}
                      allowDecimals={false}
                    />
                    <Tooltip />
                    {branchMetrics.map((m, i) => (
                      <Area
                        key={m.branchId}
                        type="monotone"
                        dataKey={`branch_${m.branchId}`}
                        name={m.branchName}
                        stroke={PALETTE[i % PALETTE.length]}
                        strokeWidth={2.5}
                        fill={`url(#${GRADIENT_ID})`}
                        fillOpacity={0.12}
                      />
                    ))}
                  </AreaChart>
                ) : (
                  <AreaChart
                    data={trendData}
                    margin={{ top: 8, right: 20, left: 0, bottom: 8 }}
                  >
                    <defs>
                      <linearGradient
                        id={GRADIENT_ID}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor={T.teal600}
                          stopOpacity={0.28}
                        />
                        <stop
                          offset="95%"
                          stopColor={T.teal600}
                          stopOpacity={0.02}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={T.teal50} />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11, fill: T.muted }}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: T.muted }}
                      allowDecimals={false}
                    />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="attendance"
                      name="Attendance"
                      stroke={T.teal600}
                      strokeWidth={3}
                      fill={`url(#${GRADIENT_ID})`}
                    />
                  </AreaChart>
                )}
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel
          title="Today Snapshot"
          subtitle="Visible attendance distribution"
        >
          <div style={{ display: "grid", gap: 14 }}>
            {distributionRows.map((item, i) => {
              const pct = totals.totalStaff
                ? Math.round((item.value / totals.totalStaff) * 100)
                : 0;
              return (
                <div key={item.name}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 12,
                      fontWeight: 900,
                      color: T.head,
                      marginBottom: 7,
                    }}
                  >
                    <span>{item.name}</span>
                    <span>
                      {item.value} · {pct}%
                    </span>
                  </div>
                  <div
                    style={{
                      height: 10,
                      background: T.slate100,
                      borderRadius: 999,
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        borderRadius: 999,
                        background: PALETTE[i % PALETTE.length],
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              marginTop: 18,
            }}
          >
            <div
              style={{ background: T.teal50, borderRadius: 14, padding: 12 }}
            >
              <Building2 size={15} color={T.teal600} />
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 950,
                  color: T.navy600,
                  marginTop: 8,
                }}
              >
                {isAllBranchAdmin ? branchMetrics.length : 1}
              </div>
              <div style={{ fontSize: 11, color: T.muted, fontWeight: 800 }}>
                Branches
              </div>
            </div>
            <div
              style={{ background: T.teal50, borderRadius: 14, padding: 12 }}
            >
              <CalendarDays size={15} color={T.teal600} />
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 950,
                  color: T.navy600,
                  marginTop: 8,
                }}
              >
                {periodLabel(period)}
              </div>
              <div style={{ fontSize: 11, color: T.muted, fontWeight: 800 }}>
                Period
              </div>
            </div>
          </div>
        </Panel>
      </div>

      {/* ── Report data table ── */}
      <Panel
        title="Report Data"
        subtitle="The same filtered rows are used by the CSV export button."
      >
        <div
          style={{
            border: `1px solid ${T.border}`,
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1.2fr .7fr .8fr 1.2fr",
              gap: 12,
              background: T.teal50,
              padding: "11px 14px",
              fontSize: 10,
              fontWeight: 900,
              color: T.muted,
              textTransform: "uppercase",
              letterSpacing: ".07em",
            }}
          >
            <span>Branch</span>
            <span>{peopleModel.groupLabel}</span>
            <span>Metric</span>
            <span>Value</span>
            <span>Period</span>
            <span>Notes</span>
          </div>
          {tableRows.length ? (
            tableRows.map((row, i) => (
              <div
                key={`${row.branch}-${row.department}-${row.metric}-${i}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1.2fr .7fr .8fr 1.2fr",
                  gap: 12,
                  padding: "11px 14px",
                  borderTop: `1px solid ${T.teal50}`,
                  fontSize: 12,
                  color: T.head,
                  alignItems: "center",
                }}
              >
                <strong>{row.branch}</strong>
                <span>{row.department}</span>
                <span>{row.metric}</span>
                <strong style={{ color: T.teal600 }}>{row.value}</strong>
                <span style={{ color: T.muted }}>{row.period}</span>
                <span style={{ color: T.muted }}>{row.notes}</span>
              </div>
            ))
          ) : (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: T.muted,
                fontSize: 13,
              }}
            >
              No rows match the current filters.
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
};

export default Reports;
