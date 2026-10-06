/**
 * BranchOverviewTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Branch-scoped Overview tab.
 */

import React, { useMemo, useState, useRef, useEffect, lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { TrendingUp, UserCheck, Users, UserX } from "lucide-react";
import DateFilterBar from "../../components/ui/DateFilterBar";
import { useDateFilter, formatDate } from "../../hooks/useDateFilter";
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
import { resolveApiBranchId } from "../../utils/tenantScope";
import { getModulePath, getBranchModulePath } from "../../config/moduleRegistry";
import type { DashboardLiveLogItem } from "../../hooks/useDashboardOverviewData";
import { getAttendanceLogs } from "../../pages/attendance_temp/api/attendanceApi";
import useBranchAttendanceAnalytics from "../../hooks/useBranchAttendanceAnalytics";
import usePaidPayrollTrends from "../../hooks/usePaidPayrollTrends";
import { DEPT_COLORS } from "../../components/dashboard/overview/KpiDropdown";
import type { KpiDeptRow } from "../../components/dashboard/overview/KpiDropdown";

import KpiDropdown from "../../components/dashboard/overview/KpiDropdown";
import { StatCard } from "../../components/dashboard/overview";
import AttendancePerformanceCard from "../../components/dashboard/overview/AttendancePerformanceCard";
import CctvStatusCard from "../../components/dashboard/overview/CctvStatusCard";
import DepartmentPayrollCard from "../../components/dashboard/overview/DepartmentPayrollCard";
import PayrollTrendsCard from "../../components/dashboard/overview/PayrollTrendsCard";
import PendingLeavesCard from "../../components/dashboard/overview/PendingLeavesCard";
import ShiftDistributionCard from "../../components/dashboard/overview/ShiftDistributionCard";
import TodayStatusCard from "../../components/dashboard/overview/TodayStatusCard";
import WeeklyAttendanceCard from "../../components/dashboard/overview/WeeklyAttendanceCard";
import LiveLogCard from "../../components/dashboard/overview/LiveLogCard";

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
  const { cfg, visibleBranches, organizationId } = useOrg();
  const liveLogBackendBranchId = resolveApiBranchId(
    organizationId,
    branchId,
    cfg.branches,
  );
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

  const isInitialLoading = Boolean(data.loading && !data.error && !data.stats?.totalStaff);
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

  const dateFilter = useDateFilter("daily");

  useEffect(() => {
    if (!showAttendanceModule) return;
    let active = true;
    setFetchedLogs([]);
    if (!liveLogBackendBranchId) {
      setFetchedLogs([]);
      return () => {
        active = false;
      };
    }
    const fetchLogs = () => {
      getAttendanceLogs({
        limit: 2000,
        backendBranchId: liveLogBackendBranchId,
        peopleType: effectivePeopleType,
        start: dateFilter.range.startDate,
        end: dateFilter.range.endDate,
      })
        .then((logs) => {
          if (active) setFetchedLogs(logs);
        })
        .catch(() => {});
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [
    branchId,
    effectivePeopleType,
    liveLogBackendBranchId,
    showAttendanceModule,
    dateFilter.range.startDate,
    dateFilter.range.endDate,
  ]);

  // ── All configured department names (source of truth) ─────────────────────
  const cfgDeptNames = useMemo<string[]>(() => {
    const names = new Set<string>();
    Object.values(cfg.departments).forEach((depts) =>
      depts.forEach((d) => { if (d.name) names.add(d.name); })
    );
    return Array.from(names).sort();
  }, [cfg.departments]);

  const filteredLogs = useMemo(() => {
    if (!fetchedLogs || !fetchedLogs.length) return [];
    if (!dateFilter.range || !dateFilter.range.startDate || !dateFilter.range.endDate) return fetchedLogs;
    const { startDate, endDate } = dateFilter.range;
    return fetchedLogs.filter((log) => {
      let dStr = "";
      const rawDate = log.work_date || log.workDate || log.log_date || log.logDate || log.date || log.timestamp || log.created_at || log.check_in || log.time;
      if (rawDate) {
        const val = String(rawDate);
        if (val.length === 10 && val.includes("-")) {
          dStr = val;
        } else if (val.includes("T") || val.includes("-")) {
          try {
            const d = new Date(val);
            if (!isNaN(d.getTime())) {
              dStr = formatDate(d);
            }
          } catch {}
        }
      }
      if (!dStr) return false;
      return dStr >= startDate && dStr <= endDate;
    });
  }, [fetchedLogs, dateFilter.range]);

  const filterPeriodLabel = useMemo(() => {
    const todayStrVal = formatDate(new Date());
    const yesterdayStrVal = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return formatDate(d); })();
    if (dateFilter.mode === "monthly") return "This Month";
    if (dateFilter.mode === "custom") return "Selected Period";
    if (dateFilter.selectedDate === yesterdayStrVal) return "Yesterday";
    if (dateFilter.selectedDate === todayStrVal) return "Today";
    return dateFilter.label || "Period";
  }, [dateFilter.mode, dateFilter.selectedDate, dateFilter.label]);

  const deptPresentRows = useMemo<KpiDeptRow[]>(() => {
    const presentLogs = filteredLogs.filter((log) => {
      const status = (log.status || "").toLowerCase();
      return status === "present" || status === "late" || status === "checked_in" || status === "checked_out" || status === "half_day" || status === "on_time";
    });
    const uniqueStaffPresent = new Map<string, string>();
    for (const log of presentLogs) {
      const id = String(log.staffId || log.userId || log.staff_id || log.user_id);
      if (id && !uniqueStaffPresent.has(id)) {
        uniqueStaffPresent.set(id, log.department || log.department_name || "General");
      }
    }
    const deptCounts = new Map<string, number>();
    uniqueStaffPresent.forEach((dept) => {
      deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
    });

    if (deptCounts.size === 0) return [];
    return Array.from(deptCounts.entries()).map(([dept, count], i) => ({
      name: dept,
      count,
      subtitle: `${count} staff`,
      color: DEPT_COLORS[i % DEPT_COLORS.length],
    }));
  }, [filteredLogs]);

  // The analytics hook owns the branch and people-type scoped roster fetch.
  const branchStaff = analytics.staff ?? [];

  const deptAbsentRows = useMemo<KpiDeptRow[]>(() => {
    const presentIds = new Set(
      filteredLogs
        .filter((log) => {
          const status = (log.status || "").toLowerCase();
          return status === "present" || status === "late" || status === "checked_in" || status === "checked_out" || status === "half_day" || status === "on_time";
        })
        .map((log) => String(log.staffId || log.userId || log.staff_id || log.user_id))
    );
    const absentStaff = branchStaff.filter((s) => !presentIds.has(String(s.id)));
    const deptCounts = new Map<string, number>();
    absentStaff.forEach((s) => {
      const dept = s.department_name || s.department || "General";
      deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
    });

    if (deptCounts.size === 0) return [];
    return Array.from(deptCounts.entries()).map(([dept, count], i) => ({
      name: dept,
      count,
      subtitle: `${count} staff`,
      color: DEPT_COLORS[i % DEPT_COLORS.length],
    }));
  }, [filteredLogs, branchStaff]);

  const effectiveLiveLog = useMemo(() => {
    if (!filteredLogs || filteredLogs.length === 0) return [];

    const presentLogs = filteredLogs.filter((log) =>
      [
        "present",
        "late",
        "on_time",
        "checked_in",
        "checked_out",
        "half_day",
      ].includes(String(log.status || "").toLowerCase()),
    );
    const sorted = [...presentLogs].sort((a: any, b: any) => {
      const timeA = new Date(a.time || a.timestamp || a.date || a.created_at || 0).getTime();
      const timeB = new Date(b.time || b.timestamp || b.date || b.created_at || 0).getTime();
      if (timeA && timeB) return timeB - timeA;
      return 0;
    });

    const unique: any[] = [];
    const seen = new Set<string>();

    for (const log of sorted) {
      const sid = String(log.staffId || log.userId || log.staff_id || log.user_id || log.name || log.userName || "");
      const timeStr = String(log.time || log.timestamp || log.checkIn || log.check_in || log.created_at || "");
      const datePart = timeStr.split("T")[0] || timeStr;
      const key = `${sid}_${datePart}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(log);
      }
    }

    return unique.map((log: any, index: number) => {
      const rawStatus = (log.status || log.arrival_status || "present").toString().toLowerCase();
      let status: "Present" | "Late" | "Absent" = "Present";
      if (rawStatus.includes("absent")) status = "Absent";
      else if (rawStatus.includes("late")) status = "Late";

      const timeStr = log.time || log.timestamp || log.checkIn || log.check_in || log.created_at || "09:00 AM";
      let formattedTime = timeStr;
      try {
        if (timeStr.includes("T") || timeStr.includes("-")) {
          const d = new Date(timeStr);
          if (!isNaN(d.getTime())) {
            formattedTime = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        }
      } catch {}

      return {
        id: String(log.id || log.staffId || index),
        name: log.userName || log.staffName || log.name || log.user_name || "Staff Member",
        department: log.department || log.department_name || "General",
        branchName: activeBranch?.name || log.branchName || log.branch_name || "Main Branch",
        status,
        time: formattedTime,
      };
    });
  }, [filteredLogs, activeBranch?.name]);

  const realTimeStats = useMemo(() => {
    const presentLogs = filteredLogs.filter((log) => {
      const status = (log.status || "").toLowerCase();
      return status === "present" || status === "late" || status === "checked_in" || status === "checked_out" || status === "half_day";
    });
    const uniquePresentIds = new Set(
      presentLogs.map((log) => String(log.staffId || log.userId || log.staff_id || log.user_id))
    );
    const presentToday = uniquePresentIds.size;
    const totalStaff = analytics.staff?.length ?? data.stats.totalStaff;
    const absentToday = Math.max(0, totalStaff - presentToday);
    const avgAttendance = totalStaff > 0 ? Math.round((presentToday / totalStaff) * 100) : 0;
    const lateToday = presentLogs.filter((l) => (l.status || "").toLowerCase().includes("late")).length;

    return {
      presentToday,
      absentToday,
      totalStaff,
      avgAttendance,
      lateToday,
    };
  }, [filteredLogs, analytics.staff, data.stats]);

  const realTimeTodayStatus = useMemo(() => [
    { name: "Present" as const, value: realTimeStats.presentToday },
    { name: "Absent" as const, value: realTimeStats.absentToday },
    { name: "Late" as const, value: realTimeStats.lateToday },
  ], [realTimeStats]);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const promises: Promise<any>[] = [
        data.refresh?.() || Promise.resolve(),
        analytics.refresh(),
        payrollTrend.refresh(),
      ];
      if (showAttendanceModule) {
        if (liveLogBackendBranchId) {
          promises.push(
            getAttendanceLogs({
              limit: 2000,
              backendBranchId: liveLogBackendBranchId,
              peopleType: effectivePeopleType,
              start: dateFilter.range.startDate,
              end: dateFilter.range.endDate,
            })
              .then(setFetchedLogs)
              .catch(() => {}),
          );
        } else {
          setFetchedLogs([]);
        }
      }
      await Promise.all(promises);
    } finally {
      setIsRefreshing(false);
    }
  };

  const headerActions = (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <DateFilterBar filter={dateFilter} compact />
      {activePeopleTypes.length > 1 && (
        <PeopleTypeSelector
          options={peopleTypeOptions}
          value={effectivePeopleType ?? defaultType ?? activePeopleTypes[0]}
          onChange={(value) => setSelectedPeopleType(value)}
          ariaLabel="People type"
          minWidth={150}
        />
      )}
      <RefreshButton variant="secondary" size="md" loading={isRefreshing} onClick={handleRefresh} />
    </div>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f5f6fa",
        padding: "24px",
        boxSizing: "border-box",
        width: "100%",
        borderRadius: 16,
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 18,
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 800,
              color: "#0F172A",
              letterSpacing: "-0.5px",
              fontFamily: "'DM Sans', 'Inter', sans-serif",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <TrendingUp size={22} color={T.teal600} />
            Attendance Overview
          </h1>
          <p style={{ margin: "4px 0 0 0", fontSize: 12, fontWeight: 500, color: "#64748B", fontFamily: "'DM Sans', 'Inter', sans-serif" }}>
            {formattedToday}
          </p>
        </div>
        {headerActions}
      </div>

      {(showPeopleCountCard || showAttendanceModule) && (
        <Suspense fallback={<WidgetLoader />}>
          <div style={gridAuto(220)}>
            {showPeopleCountCard && (
              <div style={{ position: "relative" }}>
                {isInitialLoading ? <WidgetLoader /> : (
                  <StatCard
                    title={totalPeopleTitle}
                    value={statValue(realTimeStats.totalStaff)}
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
                    title={`Present ${filterPeriodLabel}`}
                    value={statValue(realTimeStats.presentToday)}
                    sub={statSub(`${realTimeStats.avgAttendance}% attendance`)}
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
                    title={`Absent ${filterPeriodLabel}`}
                    value={statValue(realTimeStats.absentToday)}
                    sub={statSub(`${realTimeStats.lateToday} late`)}
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
                  value={statValue(`${realTimeStats.avgAttendance}%`)}
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gridAutoRows: "390px", gap: 14, marginBottom: 20, alignItems: "stretch" }}>
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
                  data={realTimeTodayStatus}
                  presentToday={realTimeStats.presentToday}
                  totalStaff={realTimeStats.totalStaff}
                  peopleType={effectivePeopleType}
                  isStudent={peopleModel.isStudent}
                  groupLabel={peopleModel.groupLabel}
                  groupPlural={peopleModel.groupPlural}
                  subgroupLabel={peopleModel.subgroupLabel}
                  subgroupPlural={peopleModel.subgroupPlural}
                  staff={analytics.staff}
                  records={analytics.todayRecords}
                />
              )}
            </Suspense>
          )}
          {showAttendanceModule && (
            <Suspense fallback={<WidgetLoader />}>
              {isInitialLoading ? <WidgetLoader /> : (
                <LiveLogCard
                  items={effectiveLiveLog}
                  height="100%"
                  listHeight="310px"
                  showBranchName={false}
                  onViewAll={() => navigateToModule("attendance")}
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