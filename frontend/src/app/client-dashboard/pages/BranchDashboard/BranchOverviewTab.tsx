/**
 * BranchOverviewTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Branch-scoped Overview tab.
 */

import React, { useMemo, useState } from "react";
import { TrendingUp, UserCheck, Users, UserX } from "lucide-react";
import useDashboardOverviewData from "../../hooks/useDashboardOverviewData";
import { useOrg, useOrgMasterData } from "../../contexts/OrgConfigContext";
import { useAuth } from "../../contexts/useAuth";
import { T } from "../../components/ui/theme";
import PeopleTypeSelector, {
  type PeopleTypeOption,
} from "../../components/ui/PeopleTypeSelector";
import RefreshButton from "../../components/ui/RefreshButton";
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
  const { cfg, visibleBranches } = useOrg();
  const masterData = useOrgMasterData();
  const { user } = useAuth();
  const [selectedPeopleType, setSelectedPeopleType] = useState<string | null>(
    null,
  );
  const enabledModules = activeModulesFromConfig(masterData.modules);
  const hasPurchasedModule = enabledModules.length > 0;

  const activePeopleTypes = resolveActivePeopleTypes(cfg);
  const defaultType =
    activePeopleTypes.length > 0 ? activePeopleTypes[0] : undefined;
  const effectivePeopleType =
    selectedPeopleType ?? defaultType ?? activePeopleTypes[0] ?? null;
  const peopleModel = resolvePeopleRenderingModel(
    cfg,
    effectivePeopleType ?? undefined,
  );

  useMemo(() => {
    if (!activePeopleTypes.length) return;
    if (!selectedPeopleType && defaultType) {
      setSelectedPeopleType(defaultType);
    }
    if (selectedPeopleType && !activePeopleTypes.includes(selectedPeopleType)) {
      setSelectedPeopleType(defaultType ?? activePeopleTypes[0]);
    }
  }, [activePeopleTypes, defaultType, selectedPeopleType]);

  const peopleTypeOptions = useMemo<PeopleTypeOption[]>(
    () =>
      activePeopleTypes.map((type) => ({
        value: type,
        label:
          peopleModel.peopleType === type ? peopleModel.personPlural : type,
      })),
    [activePeopleTypes, peopleModel.personPlural, peopleModel.peopleType],
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
      peopleType: effectivePeopleType ?? undefined,
      branchId,
    });

  const showPeopleModule = moduleVisibleFor("people");
  const showAttendanceModule = moduleVisibleFor("attendance");
  const showLeaveModule =
    peopleModel.supportsLeave && moduleVisibleFor("leave");
  const showPayrollModule =
    peopleModel.supportsPayroll && moduleVisibleFor("payroll");
  const showCctvModule = moduleVisibleFor("cctv");

  const data = useDashboardOverviewData({
    scope: "branch",
    branchId,
    peopleType: effectivePeopleType ?? undefined,
    teamView: null,
  });

  const activeBranch =
    visibleBranches.find((branch) => String(branch.id) === String(branchId)) ??
    cfg.branches.find((branch) => String(branch.id) === String(branchId));
  const branchLocation = activeBranch?.city || activeBranch?.location || "";
  const formattedToday = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const isInitialLoading = Boolean(data.loading && !data.error);
  const statValue = (value: number | string): number | string =>
    isInitialLoading ? "—" : value;
  const statSub = (value: string): string =>
    isInitialLoading ? "Loading…" : value;
  const cctvItems = data.cctvStatus.filter((item) => Boolean(item?.id));
  const showCctvDashboard = showCctvModule && cctvItems.length > 0;
  const showPeopleCountCard = showPeopleModule || showAttendanceModule;
  const showShiftDistribution =
    showAttendanceModule && peopleModel.supportsShift;
  const totalPeopleTitle = peopleModel.statsTotalLabel;
  const headerActions = (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {activePeopleTypes.length > 1 && (
        <PeopleTypeSelector
          options={peopleTypeOptions}
          value={effectivePeopleType ?? defaultType ?? activePeopleTypes[0]}
          onChange={(value) => setSelectedPeopleType(value)}
          ariaLabel="People type"
          minWidth={150}
        />
      )}
      <RefreshButton variant="secondary" size="md" onClick={() => undefined} />
    </div>
  );

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
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 800,
              color: T.head,
              letterSpacing: "-0.5px",
            }}
          >
            {activeBranch?.name ?? "Main Branch"}
          </h2>
          {branchLocation && (
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: T.muted,
                lineHeight: 1.4,
              }}
            >
              {branchLocation}
            </div>
          )}
        </div>
        {headerActions}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 18,
        }}
      >
        <div>
          <h3
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 800,
              color: T.head,
              letterSpacing: "-0.4px",
            }}
          >
            Attendance Overview
          </h3>
          <div
            style={{
              marginTop: 4,
              fontSize: 12,
              color: T.muted,
              lineHeight: 1.45,
            }}
          >
            {formattedToday}
          </div>
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
        <div className="branch-overview-performance-grid" style={gridAuto(360)}>
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
