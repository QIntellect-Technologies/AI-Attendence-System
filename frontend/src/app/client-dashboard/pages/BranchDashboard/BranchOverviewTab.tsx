/**
 * BranchOverviewTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Branch-scoped Overview tab.
 */

import React, { useMemo, useState, useRef, useEffect, lazy, Suspense } from "react";
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
import useBranchAttendanceAnalytics from "../../hooks/useBranchAttendanceAnalytics";
import usePaidPayrollTrends from "../../hooks/usePaidPayrollTrends";
import { DEPT_COLORS } from "../../components/dashboard/overview/KpiDropdown";
import type { KpiDeptRow } from "../../components/dashboard/overview/KpiDropdown";

const KpiDropdown = lazy(() => import("../../components/dashboard/overview/KpiDropdown"));
const StatCard = lazy(() => import("../../components/dashboard/overview").then(m => ({ default: m.StatCard })));
const AttendancePerformanceCard = lazy(() => import("../../components/dashboard/overview/AttendancePerformanceCard"));
const CctvStatusCard = lazy(() => import("../../components/dashboard/overview/CctvStatusCard"));
const DepartmentPayrollCard = lazy(() => import("../../components/dashboard/overview/DepartmentPayrollCard"));
const PayrollTrendsCard = lazy(() => import("../../components/dashboard/overview/PayrollTrendsCard"));
const PendingLeavesCard = lazy(() => import("../../components/dashboard/overview/PendingLeavesCard"));
const ShiftDistributionCard = lazy(() => import("../../components/dashboard/overview/ShiftDistributionCard"));
const TodayStatusCard = lazy(() => import("../../components/dashboard/overview/TodayStatusCard"));
const WeeklyAttendanceCard = lazy(() => import("../../components/dashboard/overview/WeeklyAttendanceCard"));

const WidgetLoader: React.FC = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: 220,
      width: "100%",
      background: T.card,
      borderRadius: 16,
      border: `1px solid ${T.border}`,
      gap: 12,
      color: T.muted,
    }}
  >
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: `3px solid ${T.teal100}`,
        borderTopColor: T.teal600,
        animation: "spin .65s linear infinite",
      }}
    />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    <span style={{ fontSize: 13, fontWeight: 500 }}>Loading…</span>
  </div>
);

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

  useEffect(() => {
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

  const analytics = useBranchAttendanceAnalytics({
    branchId,
    peopleType: effectivePeopleType,
    enabled: showAttendanceModule,
  });

  // Payroll Trends reads the same paid-payroll history as the Payroll page.
  const payrollTrend = usePaidPayrollTrends({
    branchId,
    peopleType: effectivePeopleType,
    enabled: showPayrollModule,
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

  // Show skeleton loaders on first render regardless of cache speed
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHasMounted(true), 50);
    return () => clearTimeout(timer);
  }, []);
  const isInitialLoading = !hasMounted || Boolean(data.loading && !data.error);
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
    getAttendanceLogs(500).then(setFetchedLogs).catch(() => { });
    if (user?.org_id || user?.organization_id) {
      listStaffRecords({ organizationId: (user?.org_id || user?.organization_id) as string | number }).then(setAllStaff).catch(() => { });
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

  // Branch-scoped staff for the department allocation chart. `allStaff` is
  // fetched org-wide, so narrow it to this branch when records carry a branch id.
  const branchStaff = useMemo(
    () =>
      allStaff.filter((s) => {
        const sid = s.branch_id ?? s.branchId;
        return sid === undefined || sid === null || String(sid) === String(branchId);
      }),
    [allStaff, branchId],
  );

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
      <RefreshButton variant="secondary" size="md" onClick={() => { void data.refresh?.(); }} />
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
        <Suspense fallback={<WidgetLoader />}>
          <div style={gridAuto(220)}>
            {showPeopleCountCard && (
              <div style={{ position: "relative" }}>
                {isInitialLoading ? <WidgetLoader /> : (
                  <StatCard
                    title={totalPeopleTitle}
                    value={statValue(data.stats.totalStaff)}
                    sub="Active records"
                    icon={Users}
                    iconBg={T.teal100}
                    iconColor={T.teal600}
                    onClick={() => navigateToModule("employees")}
                  />
                )}
              </div>
            )}

            {showAttendanceModule && (
              <div ref={presentCardRef} style={{ position: "relative" }}>
                {isInitialLoading ? <WidgetLoader /> : (
                  <StatCard
                    title="Present Today"
                    value={statValue(data.stats.presentToday)}
                    sub={statSub(`${data.stats.avgAttendance}% attendance`)}
                    icon={UserCheck}
                    iconBg="#134E6320"
                    iconColor={T.navy700}
                    onClick={() => setKpiDropdown(kpiDropdown === "present" ? null : "present")}
                  />
                )}
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
                {isInitialLoading ? <WidgetLoader /> : (
                  <StatCard
                    title="Absent Today"
                    value={statValue(data.stats.absentToday)}
                    sub={statSub(`${data.stats.lateToday} late`)}
                    icon={UserX}
                    iconBg="#FFF1F2"
                    iconColor="#E11D48"
                    onClick={() => setKpiDropdown(kpiDropdown === "absent" ? null : "absent")}
                  />
                )}
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
              isInitialLoading ? <WidgetLoader /> : (
                <StatCard
                  title="Avg Attendance"
                  value={statValue(`${data.stats.avgAttendance}%`)}
                  icon={TrendingUp}
                  iconBg={T.amberBg}
                  iconColor={T.amber}
                />
              )
            )}
          </div>
        </Suspense>
      )}

      {(showAttendanceModule || showShiftDistribution) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gridAutoRows: "620px", gap: 14, marginBottom: 20, alignItems: "stretch" }}>
          {showShiftDistribution && (
            <Suspense fallback={<WidgetLoader />}>
              {isInitialLoading ? <WidgetLoader /> : (
                <ShiftDistributionCard shifts={data.shiftDistribution} />
              )}
            </Suspense>
          )}
          {showAttendanceModule && (
            <Suspense fallback={<WidgetLoader />}>
              {isInitialLoading ? <WidgetLoader /> : (
                <TodayStatusCard
                  data={data.todayStatus}
                  presentToday={data.stats.presentToday}
                  totalStaff={data.stats.totalStaff}
                  staff={analytics.staff}
                  records={analytics.todayRecords}
                />
              )}
            </Suspense>
          )}
        </div>
      )}

      {(showAttendanceModule || showLeaveModule || showCctvDashboard) && (
        <div style={equalSummaryWidgetGrid(300)}>
          {showAttendanceModule && (
            <Suspense fallback={<WidgetLoader />}>
              {isInitialLoading ? <WidgetLoader /> : (
                <WeeklyAttendanceCard
                  height={SUMMARY_WIDGET_CARD_HEIGHT}
                  listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
                  data={data.weeklyAttendance}
                  fetchedLogs={analytics.records}
                  allStaff={analytics.staff}
                  title="Attendance"
                  showBranchDropdown={false}
                />
              )}
            </Suspense>
          )}

          {showAttendanceModule && (
            <Suspense fallback={<WidgetLoader />}>
              {isInitialLoading ? <WidgetLoader /> : (
                <AttendancePerformanceCard
                  data={data.attendancePerformance}
                  computedData={analytics.monthlyPerformance}
                  height={SUMMARY_WIDGET_CARD_HEIGHT}
                />
              )}
            </Suspense>
          )}

          {showLeaveModule && (
            <Suspense fallback={<WidgetLoader />}>
              {isInitialLoading ? <WidgetLoader /> : (
                <PendingLeavesCard
                  branchId={branchId}
                  showBranchName={false}
                  height={SUMMARY_WIDGET_CARD_HEIGHT}
                  listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
                />
              )}
            </Suspense>
          )}

          {showCctvDashboard && (
            <Suspense fallback={<WidgetLoader />}>
              {isInitialLoading ? <WidgetLoader /> : (
                <CctvStatusCard
                  height={SUMMARY_WIDGET_CARD_HEIGHT}
                  listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
                  items={cctvItems}
                  showBranchName={false}
                  hideWhenEmpty
                />
              )}
            </Suspense>
          )}
        </div>
      )}

      {showPayrollModule && (
        <div className="branch-overview-performance-grid" style={gridAuto(360)}>
          <Suspense fallback={<WidgetLoader />}>
            {isInitialLoading || payrollTrend.pending ? <WidgetLoader /> : (
              <PayrollTrendsCard
                data={payrollTrend.ready ? payrollTrend.totals : data.payrollTrends}
              />
            )}
          </Suspense>

          <Suspense fallback={<WidgetLoader />}>
            {isInitialLoading ? <WidgetLoader /> : (
              <DepartmentPayrollCard
                allStaff={branchStaff}
                branchId={branchId}
                peopleType={effectivePeopleType}
              />
            )}
          </Suspense>
        </div>
      )}
    </div>
  );
};

export default React.memo(BranchOverviewTab);