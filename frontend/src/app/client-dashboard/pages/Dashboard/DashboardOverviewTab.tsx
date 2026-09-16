/**
 * DashboardOverviewTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Super Admin / Global dashboard overview.
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
} from "lucide-react";

import useDashboardOverviewData from "../../hooks/useDashboardOverviewData";
import { useBranchSelector } from "../../hooks/useBranchSelector";
import { useOrg, useOrgMasterData } from "../../contexts/OrgConfigContext";
import { useAuth } from "../../contexts/useAuth";
import { T } from "../../components/ui/theme";
import {
  resolveActivePeopleTypes,
  resolvePeopleRenderingModel,
} from "../../utils/templateRendering";
import {
  activeModulesFromConfig,
  isDashboardModuleVisible,
} from "../../utils/moduleAccess";

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

const money = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${Math.round(value / 1_000)}K`
      : value.toLocaleString();

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

const DashboardOverviewTab: React.FC = () => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { cfg } = useOrg();
  const masterData = useOrgMasterData();
  const { user } = useAuth();

  const enabledModules = activeModulesFromConfig(masterData.modules);
  const hasPurchasedModule = enabledModules.length > 0;

  const branch = useBranchSelector("filter", undefined, true);
  const selectedBranchId = branch.selectedBranchId as
    | string
    | number
    | undefined;

  const activePeopleTypes = resolveActivePeopleTypes(cfg);
  const selectedPeopleType =
    activePeopleTypes.length > 0 ? activePeopleTypes[0] : undefined;
  const peopleModel = resolvePeopleRenderingModel(
    cfg,
    selectedPeopleType ?? undefined,
  );

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
  const totalPeopleTitle = peopleModel.statsTotalLabel;
  const totalPeopleSub = isAllBranches
    ? "Across all branches"
    : "In this branch";

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", width: "100%" }}>
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

      {(showAttendanceModule || showPayrollModule || showLeaveModule || showCctvDashboard) && (
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
