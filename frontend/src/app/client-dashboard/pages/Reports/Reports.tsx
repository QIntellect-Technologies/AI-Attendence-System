/**
 * modules/reports/index.tsx — REFACTORED
 * ─────────────────────────────────────────────────────────────────────────────
 * Reports & Analytics — follows OvertimeManagement architecture pattern.
 * Uses ExportButton (single Excel/PDF trigger, branded) with jelly hover
 * fill effect, and DateFilterBar (daily/weekly/monthly/custom, unbounded)
 * for the reporting range instead of a fixed 7/14-day bucket.
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

import React, { useEffect, useMemo, useRef, useState } from "react";
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
  ResponsiveContainer,
  Treemap,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ValueType,
  NameType,
} from "recharts/types/component/DefaultTooltipContent";
import type { TreemapNode } from "recharts/types/chart/Treemap";

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
import OverviewStatCard from "../../components/dashboard/overview/StatCard";
import ModernSelect from "../../components/ui/ModernSelect";
import DynamicFilterToolbar, {
  type DynamicFilterSection,
} from "../../components/ui/DynamicFilterToolbar";
import { type ExportExcelColumn } from "../../components/ui/ExportExcelButton";
// Single "Export ▾" trigger (Excel / PDF Report) — same reusable component
// PayrollModule uses, instead of two separate buttons. It reuses the
// headless build/download logic already in ExportExcelButton.tsx /
// ExportPdfButton.tsx, so this is a chrome-only addition, not new export
// logic — and it's what "the export button should also export in PDF"
// literally maps to: one button, one more format, not a second button.
import ExportButton from "../../components/ui/ExportButton";
import RefreshButton from "../../components/ui/RefreshButton";
import DateFilterBar from "../../components/ui/DateFilterBar";
import { formatDate, todayStr, useDateFilter } from "../../hooks/useDateFilter";
import { ModuleShell } from "../engine/ModuleShell";

import { useReportMetrics } from "./hooks/useReportMetrics";
import { useReportFilters } from "./hooks/useReportFilters";
import { usePayrollData } from "../Payroll/hooks/usePayrollData";

import { isModuleEnabled } from "../../utils/moduleAccess";
import { formatPKR } from "./utils/reports.metrics";

// ─── UI atoms ─────────────────────────────────────────────────────────────────

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

const ReportLoadNotice: React.FC<{
  message: string;
  onRetry: () => void;
}> = ({ message, onRetry }) => (
  <div
    role="status"
    style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 14px",
      border: `1px solid ${T.border}`,
      borderRadius: 12,
      background: T.card,
      color: T.muted,
      fontSize: 12,
    }}
  >
    <AlertCircle size={16} color={T.amber} />
    <span style={{ flex: 1 }}>{message}</span>
    <button
      type="button"
      onClick={onRetry}
      style={{
        border: 0,
        background: "transparent",
        color: T.teal600,
        font: "inherit",
        fontWeight: 800,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      Try again
    </button>
  </div>
);

const Panel: React.FC<{
  title: string;
  subtitle: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}> = ({ title, subtitle, children, right }) => (
  <div
    className="reports-panel"
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

type ReportTab = "attendance" | "payroll" | "performance" | "workforce";

interface ReportTableRow {
  branch: string;
  department: string;
  people: number;
  onTimePerDay: number;
  latePerDay: number;
  absentPerDay: number;
  attendance: string;
  payroll: string;
  pendingLeave: number;
  [key: string]: string | number;
}

// Single source of truth for tab labels — reused by the tab bar, the
// "Report" filter select, and the chart title mapping so there's exactly
// one place that knows what each tab is called.
const TAB_LABELS: Record<ReportTab, string> = {
  attendance: "Attendance Trend",
  payroll: "Payroll Analysis",
  performance: "Performance",
  workforce: "Workforce Mix",
};

const Reports: React.FC = () => {
  const params = useParams<{ branchId?: string }>();
  const { cfg, activeBranchId, isOrgReady, organizationId } = useOrg();
  const {
    staff,
    leave,
    payroll,
    refreshing,
    error: moduleError,
    refresh,
  } = useModule();
  const hydratedOrganizationRef = useRef<string | number | null>(null);
  const hydrationRetryOrganizationRef = useRef<string | number | null>(null);

  useEffect(() => {
    if (!isOrgReady || !organizationId) {
      hydratedOrganizationRef.current = null;
      hydrationRetryOrganizationRef.current = null;
      return;
    }
    if (hydratedOrganizationRef.current === organizationId) return;

    hydratedOrganizationRef.current = organizationId;
    void refresh();
  }, [isOrgReady, organizationId, refresh]);

  useEffect(() => {
    if (
      !isOrgReady ||
      !organizationId ||
      !moduleError ||
      hydratedOrganizationRef.current !== organizationId ||
      hydrationRetryOrganizationRef.current === organizationId
    ) {
      return;
    }

    const retryTimer = window.setTimeout(() => {
      hydrationRetryOrganizationRef.current = organizationId;
      void refresh();
    }, 1000);

    return () => window.clearTimeout(retryTimer);
  }, [isOrgReady, moduleError, organizationId, refresh]);

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
    search,
    setBranchFilter,
    setPeopleTypeFilter,
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

  // Real, unbounded date range — shared with Attendance/Payroll/
  // LeaveManagement (see useDateFilter.ts) instead of the old fixed
  // "today"/"7d"/"30d"/"month"/"all" bucket, which silently capped every
  // report (including "All Time") at 7-14 days with no way to override it.
  // "weekly" mirrors the previous default ("Last 7 Days").
  const dateFilter = useDateFilter("weekly");
  const reportPeriodLabel = useMemo(() => {
    const today = todayStr();
    if (dateFilter.mode === "daily" && dateFilter.selectedDate === today) {
      return "Today";
    }
    if (dateFilter.mode === "daily") {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      if (dateFilter.selectedDate === formatDate(yesterday)) return "Yesterday";
    }
    if (
      dateFilter.mode === "monthly" &&
      dateFilter.selectedMonth === today.slice(0, 7)
    ) {
      return "This Month";
    }
    return dateFilter.label;
  }, [
    dateFilter.label,
    dateFilter.mode,
    dateFilter.selectedDate,
    dateFilter.selectedMonth,
  ]);
  const isMultiDayReport = dateFilter.dates.length > 1;
  const resetAll = () => {
    reset();
    dateFilter.setMode("weekly");
  };

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
  const orgHasLeaveModule = useMemo(
    () => isModuleEnabled(cfg.modules, "leave"),
    [cfg.modules],
  );
  const showPayrollStat =
    orgHasPayrollModule && payrollPeopleTypes.includes(peopleModel.peopleType);
  const showLeaveStat = orgHasLeaveModule && peopleModel.supportsLeave;
  const reportPayrollMonth = dateFilter.range.startDate.slice(0, 7);
  const reportPayrollBranchId =
    effectiveBranchId ??
    (branchFilter !== "all" ? Number(branchFilter) : undefined);
  const reportPayroll = usePayrollData({
    enabled: showPayrollStat,
    branchId: reportPayrollBranchId,
    month: reportPayrollMonth,
    peopleType: peopleModel.peopleType,
    autoRefresh: false,
  });
  const reportPayrollMonthLabel = new Date(
    `${reportPayrollMonth}-01T00:00:00`,
  ).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  // Hide the Payroll tab for people types that don't support payroll
  // (e.g. students). This list drives the tab bar, the "Report" filter
  // select, AND the guard below — one place decides what's visible.
  const visibleTabs: ReportTab[] = useMemo(
    () =>
      showPayrollStat
        ? ["attendance", "payroll", "performance", "workforce"]
        : ["attendance", "performance", "workforce"],
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
    dateRange: dateFilter.range,
    isGlobalDashboard,
  });

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

  const workforceRows = useMemo(
    () =>
      [...departmentMetrics]
        .map((row) => ({
          name:
            isAllBranchAdmin && branchMetrics.length > 1
              ? `${row.department} · ${row.branchName}`
              : row.department,
          people: row.totalStaff,
        }))
        .sort((a, b) => b.people - a.people)
        .slice(0, 10),
    [branchMetrics.length, departmentMetrics, isAllBranchAdmin],
  );
  const attendanceStatusRows = useMemo(
    () => [
      { name: "On time", value: Math.max(0, totals.present - totals.late) },
      { name: "Late", value: totals.late },
      { name: "Absent", value: totals.absent },
    ],
    [totals],
  );
  const attendanceSubLabel = isMultiDayReport
    ? `${totals.attended} avg. of ${totals.totalStaff} per day`
    : `${totals.attended} of ${totals.totalStaff} attended`;
  const absenceSubLabel = isMultiDayReport
    ? `Avg. ${totals.absent} absent per day · ${reportPeriodLabel}`
    : `${totals.absent} absent ${reportPeriodLabel.toLowerCase()}`;

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
        id: "date",
        type: "custom",
        render: <DateFilterBar filter={dateFilter} compact />,
      },
      {
        id: "search",
        type: "search",
        value: search,
        onChange: setSearch,
        grow: true,
        minWidth: 280,
        placeholder: `Search branch or ${peopleModel.groupLabel.toLowerCase()}...`,
      },
      { id: "reset", type: "reset", label: "Clear", onClick: reset },
    ],
    [
      allBranches,
      branchFilter,
      dateFilter,
      isGlobalDashboard,
      peopleModel.groupLabel,
      peopleTypeFilter,
      peopleTypeOptions,
      reset,
      search,
      scopedStaff,
      setBranchFilter,
      setPeopleTypeFilter,
      setSearch,
      visibleTabs,
    ],
  );

  // ── Derived labels ─────────────────────────────────────────────────────────
  const tableRows = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return departmentMetrics.filter(
      (row) =>
        !query ||
        `${row.branchName} ${row.department}`
          .toLocaleLowerCase()
          .includes(query),
    );
  }, [departmentMetrics, search]);
  const payrollByDepartment = useMemo(() => {
    const totalsByGroup = new Map<string, number>();
    reportPayroll.rows.forEach((row) => {
      const key = `${row.branchId}:${row.department.trim().toLocaleLowerCase()}`;
      totalsByGroup.set(key, (totalsByGroup.get(key) ?? 0) + row.netPay);
    });
    return totalsByGroup;
  }, [reportPayroll.rows]);
  const screenRows = useMemo<ReportTableRow[]>(
    () =>
      tableRows.map((row) => {
        const groupPayroll = payrollByDepartment.get(
          `${row.branchId}:${row.department.trim().toLocaleLowerCase()}`,
        );
        const payrollUnavailable =
          reportPayroll.loading ||
          reportPayroll.refreshing ||
          Boolean(reportPayroll.error);
        return {
          branch: row.branchName,
          department: row.department,
          people: row.totalStaff,
          onTimePerDay: Math.max(0, row.present - row.late),
          latePerDay: row.late,
          absentPerDay: row.absent,
          attendance: `${row.attendanceRate}%`,
          payroll: payrollUnavailable ? "—" : formatPKR(groupPayroll ?? 0),
          pendingLeave: row.pendingLeaves,
        };
      }),
    [
      payrollByDepartment,
      reportPayroll.error,
      reportPayroll.loading,
      reportPayroll.refreshing,
      tableRows,
    ],
  );
  const exportColumns = useMemo<ExportExcelColumn<ReportTableRow>[]>(
    () => [
      { header: "Branch", key: "branch" },
      { header: peopleModel.groupLabel, key: "department" },
      { header: "People", key: "people", align: "right" },
      { header: "On time / day", key: "onTimePerDay", align: "right" },
      { header: "Late / day", key: "latePerDay", align: "right" },
      { header: "Absent / day", key: "absentPerDay", align: "right" },
      { header: "Attendance", key: "attendance", align: "right" },
      ...(showPayrollStat
        ? [
            {
              header: "Payroll",
              key: "payroll" as const,
              align: "right" as const,
            },
          ]
        : []),
      { header: "Pending leave", key: "pendingLeave", align: "right" },
    ],
    [peopleModel.groupLabel, showPayrollStat],
  );
  const tableGridColumns = showPayrollStat
    ? "1.2fr 1fr .65fr .8fr .7fr .8fr .8fr 1.1fr .8fr"
    : "1.2fr 1fr .65fr .8fr .7fr .8fr .8fr .8fr";
  const activeChartTitle = {
    payroll: "Payroll Analysis",
    performance: "Attendance Performance",
    workforce: "Workforce Mix",
    attendance: "Attendance Trend",
  }[effectiveTab];
  const activeChartSubtitle =
    effectiveTab === "workforce"
      ? `${selectedBranchLabel} · People by ${peopleModel.groupLabel.toLowerCase()}`
      : `${selectedBranchLabel} · ${dateFilter.label} · ${screenRows.length} report rows`;

  const GRADIENT_ID = "attendanceGradient";

  return (
    <div
      className="reports-page"
      style={{
        padding: "24px",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
        background: T.bgPage,
        minHeight: "100%",
        minWidth: 0,
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <ModuleShell
        title="Reports & Analytics"
        Icon={TrendingUp}
        actions={
          <>
            <DynamicFilterToolbar
              sections={filterSections}
              mobileOnly
              className="staff-management-mobile-filter"
            />
            <DateFilterBar filter={dateFilter} compact />
            <RefreshButton
              size="md"
              loading={refreshing}
              onClick={refresh}
              ariaLabel="Refresh reports data"
            />
            <ExportButton
              data={screenRows}
              filename={`Reports_${selectedBranchLabel}_${dateFilter.label}_${effectiveTab}_${new Date().toISOString().split("T")[0]}`}
              organization={{
                name: cfg.orgName || undefined,
                logoUrl: cfg.logo,
              }}
              excel={{
                columns: exportColumns,
                title: "Reports & Analytics",
                subtitle: `${selectedBranchLabel} · ${dateFilter.label}`,
                reportPeriod: dateFilter.label,
              }}
              pdf={{
                columns: exportColumns,
                title: "Reports & Analytics",
                subtitle: `${selectedBranchLabel} · ${dateFilter.label}`,
                reportPeriod: dateFilter.label,
              }}
              emptyMessage="No report data available to export."
            />
          </>
        }
        stats={
          <>
            {moduleError && (
              <ReportLoadNotice
                message="Some report data couldn't be refreshed. Showing the data currently available."
                onRetry={() => void refresh()}
              />
            )}
            {showPayrollStat && reportPayroll.error && (
              <ReportLoadNotice
                message="Payroll totals couldn't be loaded. Other report data is still available."
                onRetry={() => void reportPayroll.refresh({ force: true })}
              />
            )}
            <DynamicFilterToolbar
              sections={filterSections}
              bordered
              desktopOnly
              style={{ width: "100%" }}
            />
            <div
              className="reports-stat-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 14,
                minWidth: 0,
                width: "100%",
                marginBottom: 16,
              }}
            >
              <OverviewStatCard
                title="Attendance Rate"
                value={`${totals.attendanceRate}%`}
                sub={attendanceSubLabel}
                icon={Activity}
                iconBg="#DCFCE7"
                iconColor="#16A34A"
              />
              <OverviewStatCard
                title={peopleModel.statsTotalLabel}
                value={totals.totalStaff}
                sub={
                  isAllBranchAdmin
                    ? `${allBranches.length} branches`
                    : selectedBranchLabel
                }
                icon={Users}
                iconBg="#E0F2FE"
                iconColor="#0369A1"
              />
              {showPayrollStat ? (
                <OverviewStatCard
                  title="Total Pay-out"
                  value={
                    reportPayroll.loading ||
                    reportPayroll.refreshing ||
                    reportPayroll.error
                      ? "—"
                      : formatPKR(reportPayroll.stats.totalPayout)
                  }
                  sub={
                    reportPayroll.error
                      ? "Payroll unavailable"
                      : reportPayroll.loading || reportPayroll.refreshing
                        ? "Loading payroll"
                        : `Payroll period · ${reportPayrollMonthLabel}`
                  }
                  icon={Banknote}
                  iconBg="#FEF3C7"
                  iconColor="#D97706"
                />
              ) : showLeaveStat ? (
                <OverviewStatCard
                  title="Leave Balance"
                  value={totals.pendingLeaves}
                  sub="Pending review"
                  icon={CalendarDays}
                  iconBg={T.teal50}
                  iconColor={T.teal600}
                />
              ) : null}
              <OverviewStatCard
                title={
                  showPayrollStat
                    ? "Pending Leaves"
                    : isMultiDayReport
                      ? "Average Daily Absence"
                      : `Absent · ${reportPeriodLabel}`
                }
                value={showPayrollStat ? totals.pendingLeaves : totals.absent}
                sub={
                  showPayrollStat
                    ? absenceSubLabel
                    : `${totals.late} late arrivals`
                }
                icon={AlertCircle}
                iconBg={showPayrollStat ? "#FEF3C7" : "#FFE4E6"}
                iconColor={showPayrollStat ? "#D97706" : "#E11D48"}
              />
            </div>
          </>
        }
      >
        {/* ── Tab bar ── */}
        <div className="reports-mobile-tab-select">
          <ModernSelect
            value={effectiveTab}
            options={visibleTabs.map((tab) => ({
              value: tab,
              label: TAB_LABELS[tab],
            }))}
            onChange={(value) => setActiveTab(value as ReportTab)}
            ariaLabel="Reports section"
            width="100%"
            minWidth={0}
          />
        </div>
        <div
          className="reports-tab-list"
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
          className="reports-chart-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "1.45fr .9fr",
            gap: 16,
          }}
        >
          <Panel
            title={activeChartTitle}
            subtitle={activeChartSubtitle}
            right={<BarChart3 size={18} color={T.teal600} />}
          >
            {totals.totalStaff === 0 ? (
              <EmptyChartState message="No branch data is available for this report scope." />
            ) : effectiveTab === "payroll" && showPayrollStat ? (
              <div
                className="reports-chart"
                style={{ width: "100%", height: 340 }}
              >
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
              <div className="reports-chart" style={{ width: "100%", height: 340 }}>
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
            ) : effectiveTab === "workforce" ? (
              <div className="reports-chart" style={{ width: "100%", height: 340 }}>
                <ResponsiveContainer>
                  <Treemap
                    data={workforceRows}
                    dataKey="people"
                    nameKey="name"
                    aspectRatio={4 / 3}
                    stroke={T.card}
                    colorPanel={PALETTE}
                    content={(node: TreemapNode) => {
                      const maxLabelLength = Math.max(
                        0,
                        Math.floor((node.width - 20) / 7),
                      );
                      const label =
                        node.name.length > maxLabelLength
                          ? `${node.name.slice(0, Math.max(0, maxLabelLength - 1))}…`
                          : node.name;
                      return (
                        <g>
                          <rect
                            x={node.x}
                            y={node.y}
                            width={node.width}
                            height={node.height}
                            rx={6}
                            fill={PALETTE[node.index % PALETTE.length]}
                            stroke={T.card}
                            strokeWidth={3}
                          />
                          {node.width > 72 && node.height > 30 && (
                            <text
                              x={node.x + 10}
                              y={node.y + 20}
                              fill="white"
                              stroke="none"
                              strokeWidth={0}
                              fontSize={12}
                              fontWeight={700}
                            >
                              {label}
                            </text>
                          )}
                          {node.width > 72 && node.height > 48 && (
                            <text
                              x={node.x + 10}
                              y={node.y + 38}
                              fill="white"
                              stroke="none"
                              strokeWidth={0}
                              fontSize={11}
                            >
                              {node.value} {peopleModel.personPlural}
                            </text>
                          )}
                        </g>
                      );
                    }}
                  >
                    <Tooltip
                      formatter={(value: ValueType | undefined) => [
                        Array.isArray(value) ? value.join(", ") : (value ?? 0),
                        peopleModel.personPlural,
                      ]}
                    />
                  </Treemap>
                </ResponsiveContainer>
              </div>
            ) : (
              /* Attendance trend */
              <div className="reports-chart" style={{ width: "100%", height: 340 }}>
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
            title={`${reportPeriodLabel} Snapshot`}
            subtitle={
              isMultiDayReport
                ? "Average daily attendance distribution"
                : "Visible attendance distribution"
            }
          >
            <div style={{ display: "grid", gap: 14 }}>
              {attendanceStatusRows.map((item, i) => {
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
                  {dateFilter.label}
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
          subtitle={`One row per ${peopleModel.groupLabel.toLowerCase()} · attendance values are daily averages for ${dateFilter.label}.`}
        >
          <div
            className="reports-table-scroll"
            style={{
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              overflowX: "auto",
              overflowY: "hidden",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: tableGridColumns,
                minWidth: showPayrollStat ? 1040 : 900,
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
              <span>People</span>
              <span>On time / day</span>
              <span>Late / day</span>
              <span>Absent / day</span>
              <span>Attendance</span>
              {showPayrollStat && <span>Payroll</span>}
              <span>Pending leave</span>
            </div>
            {screenRows.length ? (
              <div style={{ maxHeight: 440, overflowY: "auto" }}>
                {screenRows.map((row) => {
                  return (
                    <div
                      key={`${row.branch}-${row.department}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: tableGridColumns,
                        minWidth: showPayrollStat ? 1040 : 900,
                        gap: 12,
                        padding: "12px 14px",
                        borderTop: `1px solid ${T.teal50}`,
                        fontSize: 12,
                        color: T.head,
                        alignItems: "center",
                      }}
                    >
                      <strong>{row.branch}</strong>
                      <span>{row.department}</span>
                      <span>{row.people}</span>
                      <span>{row.onTimePerDay}</span>
                      <span>{row.latePerDay}</span>
                      <span>{row.absentPerDay}</span>
                      <strong style={{ color: T.teal600 }}>
                        {row.attendance}
                      </strong>
                      {showPayrollStat && <span>{row.payroll}</span>}
                      <span>{row.pendingLeave}</span>
                    </div>
                  );
                })}
              </div>
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
      </ModuleShell>
    </div>
  );
};

export default Reports;
