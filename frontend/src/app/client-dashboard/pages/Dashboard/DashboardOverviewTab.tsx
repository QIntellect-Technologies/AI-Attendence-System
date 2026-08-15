/**
 * DashboardOverviewTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Super Admin / Global dashboard overview.
 *
 * Backend-first visibility rules:
 *   • Dashboard widgets are shown only when their owning module is enabled in
 *     the organization module configuration coming from Support.
 *   • Per-account "Dashboard Module Access" further restricts a staff/manager
 *     login to their own granted subset (see moduleAccess.ts FIX #2).
 *   • Per-people-type module config further restricts a card to the people
 *     types it's actually enabled for, in the selected branch (or unioned
 *     across all branches when "All Branches" is selected).
 *   • CCTV widgets are shown only when the CCTV module is enabled AND at least
 *     one real camera is configured for the current dashboard scope.
 *   • No dummy/default CCTV rows are rendered for branches without CCTV setup.
 *
 * FIX (this revision): this file used to carry its own private copy of
 * MODULE_ALIASES/isDashboardModuleActive/accountAllowsModule, independent
 * from — and with different alias coverage than — utils/moduleAccess.ts
 * (the file BranchOverviewTab.tsx already used). Two implementations of
 * "can this account see module X" is exactly the failure mode FIX #2's own
 * history warns about (DashboardTabBar vs Sidebar drifting apart). Now
 * imports the shared resolver instead; the alias coverage this file used to
 * have locally ("people", "students", "workers", "attendance management",
 * "payroll management", ...) has been folded into moduleAccess.ts itself so
 * nothing that used to match here stops matching.
 *
 * Also new in this revision: a people-type selector, shown only when the
 * org has more than one active people type (mirrors BranchOverviewTab.tsx's
 * selector exactly — same hook, same local-state-only contract).
 */

import React, { useState } from "react";
import {
  Users,
  UserCheck,
  UserX,
  TrendingUp,
  Building2,
  Wallet,
  CalendarClock,
  ShieldAlert,
  RefreshCcw,
} from "lucide-react";

import useDashboardOverviewData from "../../hooks/useDashboardOverviewData";
import usePeopleTypeSelector from "../../hooks/usepeopletypeselector ";
import { useBranchSelector } from "../../hooks/useBranchSelector";
import { useOrg, useOrgMasterData } from "../../contexts/OrgConfigContext";
import { useAuth } from "../../contexts/useAuth";
import { T } from "../../components/ui/theme";
import { BranchSelector } from "../../components/ui/BranchSelector";
import PeopleTypeSelector from "../../components/ui/PeopleTypeSelector";

import {
  StatCard,
  TodayStatusCard,
  WeeklyAttendanceCard,
  PendingLeavesCard,
  CctvStatusCard,
  AttendancePerformanceCard,
  PayrollTrendsCard,
  ShiftDistributionCard,
} from "../../components/dashboard/overview";
import JellyButton from "../../components/ui/JellyButton";
import RefreshButton from "../../components/ui/RefreshButton";
import {
  resolveActivePeopleTypes,
  resolvePeopleRenderingModel,
} from "../../utils/templateRendering";
import {
  activeModulesFromConfig,
  isDashboardModuleVisible,
} from "../../utils/moduleAccess";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const money = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}K`
      : value.toLocaleString();

type Refreshable = {
  refetch?: () => Promise<unknown> | unknown;
  reload?: () => Promise<unknown> | unknown;
  refresh?: () => Promise<unknown> | unknown;
};

async function runRefresh(...sources: Refreshable[]): Promise<void> {
  const jobs = sources
    .map((source) => source.refetch ?? source.reload ?? source.refresh)
    .filter(
      (fn): fn is () => Promise<unknown> | unknown => typeof fn === "function",
    )
    .map((fn) => Promise.resolve(fn()));

  if (jobs.length) {
    await Promise.allSettled(jobs);
  }
}

// Module-visibility logic (org purchase + per-account restriction + per
// people-type/per-branch gating) lives in utils/moduleAccess.ts as one
// shared resolver — see isDashboardModuleVisible import above. This is the
// exact same resolver BranchOverviewTab.tsx uses, so the Super Admin and
// Branch Admin overview tabs can never again independently decide "can this
// account see module X" and disagree with each other.

function hasRealShiftData(
  shifts: Array<{ staffCount?: number; members?: unknown[] }>,
): boolean {
  return shifts.some(
    (shift) =>
      Number(shift.staffCount || 0) > 0 || (shift.members || []).length > 0,
  );
}

const gridAuto = (minWidth = 260): React.CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))`,
  gap: 14,
  marginBottom: 20,
});

const SUMMARY_WIDGET_CARD_HEIGHT = 350;
const SUMMARY_WIDGET_BODY_HEIGHT = 260;

const equalSummaryWidgetGrid = (minWidth = 300): React.CSSProperties => ({
  ...gridAuto(minWidth),
  gridAutoRows: SUMMARY_WIDGET_CARD_HEIGHT,
  alignItems: "stretch",
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const DashboardOverviewTab: React.FC = () => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { cfg } = useOrg();
  const masterData = useOrgMasterData();
  const { user } = useAuth();

  const enabledModules = activeModulesFromConfig(masterData.modules);
  const hasPurchasedModule = enabledModules.length > 0;

  // ── Branch selector (filter mode — local state only, no navigation) ───────
  // selectedBranchId === undefined  →  All Branches (accumulative)
  // selectedBranchId === string/number →  specific branch (filtered in-place)
  const branch = useBranchSelector("filter", undefined, true);

  const selectedBranchId = branch.selectedBranchId as
    | string
    | number
    | undefined;

  // ── People type: single vs. selectable ─────────────────────────────────
  // Same contract as BranchOverviewTab.tsx: local-state-only selector,
  // shown only when the org has more than one active people type. When
  // "All Branches" is selected, module-people-type gating below unions
  // across every branch's config (see resolveModulePeopleTypes's documented
  // branchId-omitted behavior) rather than restricting to one branch's set.
  const activePeopleTypes = resolveActivePeopleTypes(cfg);
  const peopleTypeOptions = activePeopleTypes.map((type) => ({
    value: type,
    label: resolvePeopleRenderingModel(cfg, type).personPlural,
  }));
  const peopleTypeSelector = usePeopleTypeSelector(peopleTypeOptions);
  const selectedPeopleType =
    activePeopleTypes.length === 1
      ? activePeopleTypes[0]
      : peopleTypeSelector.selected;
  const peopleModel = resolvePeopleRenderingModel(
    cfg,
    selectedPeopleType ?? undefined,
  );

  // ── Module cards: org purchase + account restriction + this people type ─
  const moduleVisibleFor = (
    moduleKey: Parameters<typeof isDashboardModuleVisible>[0]["moduleKey"],
  ) =>
    hasPurchasedModule &&
    isDashboardModuleVisible({
      config: cfg,
      enabledModules,
      user,
      moduleKey,
      peopleType: selectedPeopleType,
      branchId: selectedBranchId,
    });

  const showPeopleModule = moduleVisibleFor("people");
  const showAttendanceModule = moduleVisibleFor("attendance");
  const showLeaveModule =
    peopleModel.supportsLeave && moduleVisibleFor("leave");
  const showPayrollModule =
    peopleModel.supportsPayroll && moduleVisibleFor("payroll");
  const showCctvModule = moduleVisibleFor("cctv");

  // ── Data hook — driven by branch.selectedBranchId ────────────────────────
  const data = useDashboardOverviewData({
    scope: "global",
    selectedBranchId: selectedBranchId as never,
    peopleType: selectedPeopleType,
  });

  const isInitialLoading = Boolean(data.loading && !data.error);
  const statValue = (value: number | string): number | string =>
    isInitialLoading ? "—" : value;
  const statSub = (value: string): string =>
    isInitialLoading ? "Loading…" : value;

  const isAllBranches = branch.isAllBranches;
  const cctvItems = data.cctvStatus.filter((item) => Boolean(item?.id));
  const showCctvDashboard = showCctvModule && cctvItems.length > 0;
  const showPeopleCountCard = showPeopleModule || showAttendanceModule;
  const showShiftDistribution =
    showAttendanceModule &&
    peopleModel.supportsShift &&
    (hasRealShiftData(data.shiftDistribution) || !peopleModel.isStudent);
  const totalPeopleTitle =
    selectedPeopleType || activePeopleTypes.length <= 1
      ? peopleModel.statsTotalLabel
      : "Total Attendance People";
  const totalPeopleSub = isAllBranches
    ? "Across all branches"
    : "In this branch";

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);

    try {
      await runRefresh(data as Refreshable);
    } finally {
      setIsRefreshing(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", width: "100%" }}>
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 22,
        }}
      >
        <div>
          <h2
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: T.head,
              letterSpacing: "-0.4px",
              margin: 0,
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            {data.title}
          </h2>
          <p
            style={{
              fontSize: 12,
              color: T.muted,
              marginTop: 2,
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            {data.subtitle}
          </p>
        </div>

        {/* ── People type + BranchSelector + Refresh ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {peopleTypeOptions.length > 1 && (
            <PeopleTypeSelector
              ariaLabel="Select people type"
              options={peopleTypeOptions}
              value={selectedPeopleType ?? peopleTypeOptions[0].value}
              onChange={peopleTypeSelector.setSelected}
              minWidth={160}
            />
          )}

          {data.branchFilterOptions.length > 1 && (
            <BranchSelector
              branches={branch.selectorBranches}
              selected={branch.selected}
              onChange={branch.onChange}
            />
          )}

          <RefreshButton
            variant="secondary"
            size="md"
            loading={isRefreshing}
            onClick={handleRefresh}
          />
        </div>
      </div>

      {/* ── Row 1: Primary KPI cards ── */}
      <div style={gridAuto(220)}>
        <StatCard
          title={isAllBranches ? "Total Branches" : "Branch"}
          value={
            isAllBranches
              ? data.stats.totalBranches
              : (data.selectedBranchName ?? "—")
          }
          sub={isAllBranches ? "Active locations" : "Selected branch"}
          icon={Building2}
          iconBg={T.teal100}
          iconColor={T.teal600}
        />

        {showPeopleCountCard && (
          <StatCard
            title={totalPeopleTitle}
            value={statValue(data.stats.totalStaff)}
            sub={totalPeopleSub}
            icon={Users}
            iconBg="#E0F2FE"
            iconColor="#1A699F"
          />
        )}

        {showAttendanceModule && (
          <StatCard
            title="Present Today"
            value={statValue(data.stats.presentToday)}
            sub={statSub(`${data.stats.avgAttendance}% attendance`)}
            icon={UserCheck}
            iconBg="#ECFDF5"
            iconColor="#16A34A"
          />
        )}

        {showAttendanceModule && (
          <StatCard
            title="Absent Today"
            value={statValue(data.stats.absentToday)}
            sub={statSub(`${data.stats.lateToday} late`)}
            icon={UserX}
            iconBg="#FFF1F2"
            iconColor="#E11D48"
          />
        )}
      </div>

      {/* ── Row 2: Secondary KPI cards ── */}
      {(showAttendanceModule ||
        showPayrollModule ||
        showLeaveModule ||
        showCctvDashboard) && (
        <div style={gridAuto(220)}>
          {showAttendanceModule && (
            <StatCard
              title="Avg Attendance"
              value={statValue(`${data.stats.avgAttendance}%`)}
              sub={statSub(
                isAllBranches ? "Weighted global rate" : "Branch rate",
              )}
              icon={TrendingUp}
              iconBg={T.amberBg}
              iconColor={T.amber}
            />
          )}

          {showPayrollModule && (
            <StatCard
              title="Monthly Payroll"
              value={statValue(money(data.stats.monthlyPayroll))}
              sub={statSub(isAllBranches ? "All branches" : "This branch")}
              icon={Wallet}
              iconBg={T.teal100}
              iconColor={T.teal600}
            />
          )}

          {showLeaveModule && (
            <StatCard
              title="Pending Leaves"
              value={statValue(data.stats.pendingLeaves)}
              sub={statSub("Need review")}
              icon={CalendarClock}
              iconBg="#FEF3C7"
              iconColor="#D97706"
            />
          )}

          {showCctvDashboard && (
            <StatCard
              title="CCTV Alerts"
              value={statValue(data.stats.cctvAlerts)}
              sub={statSub("Security exceptions")}
              icon={ShieldAlert}
              iconBg="#FFF1F2"
              iconColor="#E11D48"
            />
          )}
        </div>
      )}

      {/* ── Row 3: Attendance widgets ── */}
      {showAttendanceModule && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gridAutoRows: "480px",
            gap: 14,
            marginBottom: 20,
            alignItems: "stretch",
          }}
        >
          {showShiftDistribution && (
            <ShiftDistributionCard shifts={data.shiftDistribution} />
          )}
          <TodayStatusCard
            data={data.todayStatus}
            presentToday={data.stats.presentToday}
          />
        </div>
      )}

      {/* ── Row 4: Attendance + Leave + CCTV widgets ── */}
      {(showAttendanceModule || showLeaveModule || showCctvDashboard) && (
        <div style={equalSummaryWidgetGrid(300)}>
          {showAttendanceModule && (
            <WeeklyAttendanceCard
              height={SUMMARY_WIDGET_CARD_HEIGHT}
              listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
              title="Attendance Overview"
              data={isAllBranches ? undefined : data.weeklyAttendance}
              branchSeries={
                isAllBranches ? data.branchWeeklyAttendance : undefined
              }
            />
          )}

          {showLeaveModule && (
            <PendingLeavesCard
              branchId={selectedBranchId as never}
              showBranchName={isAllBranches}
              height={SUMMARY_WIDGET_CARD_HEIGHT}
              listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
              items={data.pendingLeaves}
              disableFetch
            />
          )}

          {showCctvDashboard && (
            <CctvStatusCard
              height={SUMMARY_WIDGET_CARD_HEIGHT}
              listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
              items={cctvItems}
              showBranchName={isAllBranches}
              hideWhenEmpty
            />
          )}
        </div>
      )}

      {/* ── Row 5: Performance charts ── */}
      {(showAttendanceModule || showPayrollModule) && (
        <div style={gridAuto(360)}>
          {showAttendanceModule && (
            <AttendancePerformanceCard
              data={data.attendancePerformance}
              branchSeries={
                isAllBranches ? data.branchAttendancePerformance : undefined
              }
            />
          )}

          {showPayrollModule && (
            <PayrollTrendsCard
              data={data.payrollTrends}
              branchSeries={
                isAllBranches ? data.branchPayrollTrends : undefined
              }
            />
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(DashboardOverviewTab);
