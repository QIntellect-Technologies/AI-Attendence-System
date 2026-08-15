/**
 * BranchOverviewTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Branch-scoped Overview tab.
 *
 * Backend-connected sources:
 * - Attendance/payroll/summary values come from one overview summary request.
 * - PendingLeavesCard may still load its own detailed leave list, but stat
 *   values do not wait for it.
 *
 * Tenant-safety notes:
 * - branchId is intentionally UUID/string-safe. It must remain opaque from the
 *   route through dashboard data hooks so Supabase branch UUIDs are not cast to
 *   Number or reduced to NaN.
 *
 * FIX (this revision): isDashboardModuleVisible takes `user` (the full
 * ModuleAccessUser, so accountAllowsModule can also check user.role), not a
 * bare accountModuleKeys string[] — a string[] alone can't tell a staff
 * account from an admin one, which is exactly the distinction FIX #2 exists
 * to preserve. Passing accountModuleKeys here would have silently disabled
 * the staff per-account restriction for every card on this tab. See
 * moduleAccess.ts's DashboardModuleVisibilityArgs for the authoritative
 * signature.
 */

import React, { useState } from "react";
import { RefreshCcw, TrendingUp, UserCheck, Users, UserX } from "lucide-react";
import RefreshButton from "../../components/ui/RefreshButton";
import SegmentedControl from "../../components/ui/SegmentedControl";
import useDashboardOverviewData from "../../hooks/useDashboardOverviewData";
import usePeopleTypeSelector from "../../hooks/usepeopletypeselector ";
import useManagerTeamView from "../../hooks/useManagerTeamView";
import { useOrg, useOrgMasterData } from "../../contexts/OrgConfigContext";
import { useAuth } from "../../contexts/useAuth";
import { T } from "../../components/ui/theme";
import PeopleTypeSelector from "../../components/ui/PeopleTypeSelector";
import {
  resolveActivePeopleTypes,
  resolvePeopleRenderingModel,
} from "../../utils/templateRendering";
import {
  activeModulesFromConfig,
  isDashboardModuleVisible,
} from "../../utils/moduleAccess";

import {
  AttendancePerformanceCard,
  CctvStatusCard,
  PayrollTrendsCard,
  PendingLeavesCard,
  ShiftDistributionCard,
  StatCard,
  TodayStatusCard,
  WeeklyAttendanceCard,
} from "../../components/dashboard/overview";

export type BranchOverviewBranchId = number | string;

interface BranchOverviewTabProps {
  branchId: BranchOverviewBranchId;
}

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
// people-type/per-branch gating) now lives in utils/moduleAccess.ts as one
// shared resolver — see isDashboardModuleVisible import above. This mirrors
// DashboardTabBar.tsx's userAllowedModules contract exactly (byte-for-byte
// "can this account see module X"), plus adds the people-type dimension
// that file doesn't need.

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

const BranchOverviewTab: React.FC<BranchOverviewTabProps> = ({ branchId }) => {
  const { cfg } = useOrg();
  const masterData = useOrgMasterData();
  const { user } = useAuth();
  const enabledModules = activeModulesFromConfig(masterData.modules);
  const hasPurchasedModule = enabledModules.length > 0;

  // ── People type: single vs. selectable ─────────────────────────────────
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
      branchId,
    });

  const showPeopleModule = moduleVisibleFor("people");
  const showAttendanceModule = moduleVisibleFor("attendance");
  const showLeaveModule =
    peopleModel.supportsLeave && moduleVisibleFor("leave");
  const showPayrollModule =
    peopleModel.supportsPayroll && moduleVisibleFor("payroll");
  const showCctvModule = moduleVisibleFor("cctv");

  // ── Manager portal: My Team / Whole Branch ──────────────────────────────
  const teamView = useManagerTeamView();

  const data = useDashboardOverviewData({
    scope: "branch",
    branchId,
    peopleType: selectedPeopleType,
    teamView: teamView.eligible ? teamView.teamView : null,
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  const isInitialLoading = Boolean(data.loading && !data.error);
  const statValue = (value: number | string): number | string =>
    isInitialLoading ? "—" : value;
  const statSub = (value: string): string =>
    isInitialLoading ? "Loading…" : value;
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

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);

    try {
      await runRefresh(data as Refreshable);
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div
      style={{
        fontFamily: "'DM Sans', sans-serif",
        width: "100%",
      }}
    >
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
            {showAttendanceModule ? "Attendance Overview" : "Branch Overview"}
          </h2>

          <p
            style={{
              fontSize: 12,
              color: T.muted,
              marginTop: 2,
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            {data.branchName}
            {data.branchCity ? ` · ${data.branchCity}` : ""} ·{" "}
            {new Date().toLocaleDateString("en-US", {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        </div>

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

          {teamView.eligible && !teamView.locked && (
            <SegmentedControl
              ariaLabel="My team or whole branch"
              size="sm"
              options={[
                { value: "team", label: "My Team" },
                { value: "branch", label: "Whole Branch" },
              ]}
              value={teamView.teamView}
              onChange={teamView.setTeamView}
            />
          )}

          <RefreshButton
            size="md"
            variant="secondary"
            loading={isRefreshing}
            onClick={handleRefresh}
            ariaLabel="Refresh overview"
          />
        </div>
      </div>

      {(showPeopleCountCard || showAttendanceModule) && (
        <div style={gridAuto(220)}>
          {showPeopleCountCard && (
            <StatCard
              title={totalPeopleTitle}
              value={statValue(data.stats.totalStaff)}
              sub="Active records"
              icon={Users}
              iconBg={T.teal100}
              iconColor={T.teal600}
            />
          )}

          {showAttendanceModule && (
            <StatCard
              title="Present Today"
              value={statValue(data.stats.presentToday)}
              sub={statSub(`${data.stats.avgAttendance}% attendance`)}
              icon={UserCheck}
              iconBg="#134E6320"
              iconColor={T.navy700}
            />
          )}

          {showAttendanceModule && (
            <StatCard
              title="Absent Today"
              value={statValue(data.stats.absentToday)}
              icon={UserX}
              iconBg="#FFF1F2"
              iconColor="#E11D48"
            />
          )}

          {showAttendanceModule && (
            <StatCard
              title="Avg Attendance"
              value={statValue(`${data.stats.avgAttendance}%`)}
              sub={statSub(`${data.stats.lateToday} late`)}
              icon={TrendingUp}
              iconBg={T.amberBg}
              iconColor={T.amber}
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
              data={data.weeklyAttendance}
              title="Weekly Attendance"
              showBranchDropdown={false}
            />
          )}

          {showLeaveModule && (
            <PendingLeavesCard
              branchId={branchId}
              showBranchName={false}
              height={SUMMARY_WIDGET_CARD_HEIGHT}
              listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
            />
          )}

          {showCctvDashboard && (
            <CctvStatusCard
              height={SUMMARY_WIDGET_CARD_HEIGHT}
              listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
              items={cctvItems}
              showBranchName={false}
              hideWhenEmpty
            />
          )}
        </div>
      )}

      {(showAttendanceModule || showPayrollModule) && (
        <div style={gridAuto(360)}>
          {showAttendanceModule && (
            <AttendancePerformanceCard data={data.attendancePerformance} />
          )}

          {showPayrollModule && <PayrollTrendsCard data={data.payrollTrends} />}
        </div>
      )}
    </div>
  );
};

export default React.memo(BranchOverviewTab);