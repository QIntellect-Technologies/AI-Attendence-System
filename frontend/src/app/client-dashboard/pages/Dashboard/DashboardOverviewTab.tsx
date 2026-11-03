/**
 * DashboardOverviewTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Super Admin / Global dashboard overview.
 */

import React, { useMemo, useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
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
import { BranchSelector } from "../../components/ui/BranchSelector";
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
import { getModulePath, getBranchModulePath } from "../../config/moduleRegistry";
import { getAttendanceLogs } from "../../pages/attendance_temp/api/attendanceApi";
import { listStaffRecords } from "../../pages/StaffManagement/api/staffApi";
import KpiDropdown, { DEPT_COLORS } from "../../components/dashboard/overview/KpiDropdown";
import type { KpiDeptRow } from "../../components/dashboard/overview/KpiDropdown";

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

  const [selectedPeopleType, setSelectedPeopleType] = useState<string | null>(
    null,
  );
  const activePeopleTypes = resolveActivePeopleTypes(cfg);
  const defaultPeopleType =
    activePeopleTypes.length > 0 ? activePeopleTypes[0] : undefined;
  const effectivePeopleType =
    selectedPeopleType ?? defaultPeopleType ?? activePeopleTypes[0] ?? null;
  const peopleModel = resolvePeopleRenderingModel(
    cfg,
    effectivePeopleType ?? undefined,
  );

  // Keep the selection in sync with what's actually available: pick a
  // default once types load, and fall back if the previously selected type
  // drops out of the active set (e.g. after a module/config change).
  useMemo(() => {
    if (!activePeopleTypes.length) return;
    if (!selectedPeopleType && defaultPeopleType) {
      setSelectedPeopleType(defaultPeopleType);
    }
    if (
      selectedPeopleType &&
      !activePeopleTypes.includes(selectedPeopleType)
    ) {
      setSelectedPeopleType(defaultPeopleType ?? activePeopleTypes[0]);
    }
  }, [activePeopleTypes, defaultPeopleType, selectedPeopleType]);

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
    showPeopleModule &&
    peopleModel.supportsShift &&
    (hasRealShiftData(data.shiftDistribution) || !peopleModel.isStudent);
  const totalPeopleTitle = peopleModel.statsTotalLabel;
  const totalPeopleSub = isAllBranches
    ? "Across all branches"
    : "In this branch";


  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await data.refresh?.();
    } finally {
      setIsRefreshing(false);
    }
  };

  const navigate = useNavigate();
  const navigateToModule = (moduleKey: string) => {
    if (selectedBranchId && !isAllBranches) {
      navigate(getBranchModulePath(moduleKey, Number(selectedBranchId)));
    } else {
      navigate(getModulePath(moduleKey));
    }
  };

  // ── KPI Department Dropdown ────────────────────────────────────────────────
  const [kpiDropdown, setKpiDropdown] = useState<"present" | "absent" | null>(null);
  const presentCardRef = useRef<HTMLDivElement>(null);
  const absentCardRef = useRef<HTMLDivElement>(null);
  const [fetchedLogs, setFetchedLogs] = useState<any[]>([]);
  const [allStaff, setAllStaff] = useState<any[]>([]);

  useEffect(() => {
    if (!showAttendanceModule) return;
    getAttendanceLogs(500).then(setFetchedLogs).catch(() => {});
    if (user?.org_id || user?.organization_id) {
      listStaffRecords({ organizationId: user?.org_id || user?.organization_id }).then(setAllStaff).catch(() => {});
    }
  }, [showAttendanceModule, user?.org_id, user?.organization_id]);

  // ── All configured department names (source of truth) ─────────────────────
  const cfgDeptNames = useMemo<string[]>(() => {
    const names = new Set<string>();
    Object.values(cfg.departments).forEach((depts) =>
      depts.forEach((d) => { if (d.name) names.add(d.name); })
    );
    return Array.from(names).sort();
  }, [cfg.departments]);

  const deptPresentRows = useMemo<KpiDeptRow[]>(() => {
    const presentLogs = fetchedLogs.filter((log) => {
      const status = (log.status || "").toLowerCase();
      return status === "present" || status === "late" || status === "checked_in" || status === "checked_out" || status === "half_day";
    });
    const unique = [];
    const seen = new Set();
    for (const log of presentLogs) {
      const id = log.staffId || log.userId || log.staff_id || log.user_id;
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(log);
        if (unique.length === 5) break;
      }
    }
    return unique.map((log, i) => ({
      name: log.userName || log.staffName || "Unknown",
      subtitle: log.department || "No Department",
      color: DEPT_COLORS[i % DEPT_COLORS.length]
    }));
  }, [fetchedLogs]);

  const deptAbsentRows = useMemo<KpiDeptRow[]>(() => {
    const presentIds = new Set(
      fetchedLogs
        .filter((log) => {
          const status = (log.status || "").toLowerCase();
          return status === "present" || status === "late" || status === "checked_in" || status === "checked_out" || status === "half_day";
        })
        .map((log) => String(log.staffId || log.userId || log.staff_id || log.user_id))
    );
    const absentStaff = allStaff.filter((s) => !presentIds.has(String(s.id)));
    return absentStaff.slice(0, 5).map((s, i) => ({
      name: s.name || "Unknown",
      subtitle: s.department_name || s.department || "No Department",
      color: DEPT_COLORS[i % DEPT_COLORS.length]
    }));
  }, [fetchedLogs, allStaff]);

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: T.head, letterSpacing: "-0.5px" }}>
          Attendance Overview
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {branch.hasMultipleBranches && (
            <BranchSelector branches={branch.selectorBranches} selected={branch.selected} onChange={branch.onChange} />
          )}
          {activePeopleTypes.length > 1 && (
            <PeopleTypeSelector
              options={peopleTypeOptions}
              value={effectivePeopleType ?? defaultPeopleType ?? activePeopleTypes[0]}
              onChange={(value) => setSelectedPeopleType(value)}
              ariaLabel="People type"
              minWidth={150}
            />
          )}

          <RefreshButton
            size="md"
            loading={isRefreshing}
            onClick={handleRefresh}
            ariaLabel="Refresh dashboard overview"
          />
        </div>
      </div>
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
          <div style={{ position: "relative" }}>
            <StatCard
              title={totalPeopleTitle}
              value={statValue(data.stats.totalStaff)}
              sub={totalPeopleSub}
              icon={Users}
              iconBg="#E0F2FE"
              iconColor="#1A699F"
              onClick={() => navigateToModule("employees")}
            />
          </div>
        )}

        {showAttendanceModule && (
          <div ref={presentCardRef} style={{ position: "relative" }}>
            <StatCard
              title="Present Today"
              value={statValue(data.stats.presentToday)}
              sub={statSub(`${data.stats.avgAttendance}% attendance`)}
              icon={UserCheck}
              iconBg="#ECFDF5"
              iconColor="#16A34A"
              onClick={() => setKpiDropdown(kpiDropdown === "present" ? null : "present")}
            />
            <KpiDropdown
              open={kpiDropdown === "present"}
              label="Present by Department"
              rows={deptPresentRows}
              triggerRef={presentCardRef as React.RefObject<HTMLElement | null>}
              onClose={() => setKpiDropdown(null)}
              onNavigate={() => { setKpiDropdown(null); navigateToModule("attendance"); }}
            />
          </div>
        )}

        {showAttendanceModule && (
          <div ref={absentCardRef} style={{ position: "relative" }}>
            <StatCard
              title="Absent Today"
              value={statValue(data.stats.absentToday)}
              sub={statSub(`${data.stats.lateToday} late`)}
              icon={UserX}
              iconBg="#FFF1F2"
              iconColor="#E11D48"
              onClick={() => setKpiDropdown(kpiDropdown === "absent" ? null : "absent")}
            />
            <KpiDropdown
              open={kpiDropdown === "absent"}
              label="Absent by Department"
              rows={deptAbsentRows}
              triggerRef={absentCardRef as React.RefObject<HTMLElement | null>}
              onClose={() => setKpiDropdown(null)}
              onNavigate={() => { setKpiDropdown(null); navigateToModule("attendance"); }}
            />
          </div>
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

      {(showAttendanceModule || showShiftDistribution) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gridAutoRows: "620px", gap: 14, marginBottom: 20, alignItems: "stretch" }}>
          {showShiftDistribution && (
            <ShiftDistributionCard shifts={data.shiftDistribution} />
          )}
          {showAttendanceModule && (
            <TodayStatusCard
              data={data.todayStatus}
              presentToday={data.stats.presentToday}
              totalStaff={data.stats.totalStaff}
            />
          )}
        </div>
      )}

      {(showAttendanceModule || showLeaveModule || showCctvDashboard) && (
        <div style={equalSummaryWidgetGrid(300)}>
          {showAttendanceModule && (
            <WeeklyAttendanceCard
              height={SUMMARY_WIDGET_CARD_HEIGHT}
              listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
              title="Attendance"
              data={isAllBranches ? undefined : data.weeklyAttendance}
              fetchedLogs={fetchedLogs}
              allStaff={allStaff}
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
