/**
 * BranchOverviewTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Branch-scoped Overview tab.
 */

import React, { useMemo, useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
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
import { getModulePath, getBranchModulePath } from "../../config/moduleRegistry";
import type { DashboardLiveLogItem } from "../../hooks/useDashboardOverviewData";
import { getAttendanceLogs } from "../../pages/attendance_temp/api/attendanceApi";
import { listStaffRecords } from "../../pages/StaffManagement/api/staffApi";
import KpiDropdown, { DEPT_COLORS } from "../../components/dashboard/overview/KpiDropdown";
import type { KpiDeptRow } from "../../components/dashboard/overview/KpiDropdown";

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
  const branchLocation = activeBranch?.city || "";
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
  const showShiftDistribution = showPeopleModule && peopleModel.supportsShift;
  const totalPeopleTitle = peopleModel.statsTotalLabel;

  const navigate = useNavigate();
  const navigateToModule = (moduleKey: string) => {
    navigate(getBranchModulePath(moduleKey, Number(branchId)));
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
            <div style={{ position: "relative" }}>
              <StatCard
                title={totalPeopleTitle}
                value={statValue(data.stats.totalStaff)}
                sub="Active records"
                icon={Users}
                iconBg={T.teal100}
                iconColor={T.teal600}
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
                iconBg="#134E6320"
                iconColor={T.navy700}
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

          {showAttendanceModule && (
            <StatCard
              title="Avg Attendance"
              value={statValue(`${data.stats.avgAttendance}%`)}
              icon={TrendingUp}
              iconBg={T.amberBg}
              iconColor={T.amber}
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
              data={data.weeklyAttendance}
              fetchedLogs={fetchedLogs}
              allStaff={allStaff}
              title="Attendance"
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
