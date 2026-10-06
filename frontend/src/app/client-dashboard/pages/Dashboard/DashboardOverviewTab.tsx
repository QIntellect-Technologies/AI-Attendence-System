/**
 * DashboardOverviewTab.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Super Admin / Global dashboard overview.
 */

import React, { useMemo, useState, useRef, useEffect, lazy, Suspense } from "react";
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

import DateFilterBar from "../../components/ui/DateFilterBar";
import { useDateFilter, formatDate } from "../../hooks/useDateFilter";

import useDashboardOverviewData from "../../hooks/useDashboardOverviewData";
import useBranchAttendanceAnalytics from "../../hooks/useBranchAttendanceAnalytics";
import usePaidPayrollTrends from "../../hooks/usePaidPayrollTrends";
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
import { resolveApiBranchId } from "../../utils/tenantScope";
import { getModulePath, getBranchModulePath } from "../../config/moduleRegistry";
import { getAttendanceLogs } from "../../pages/attendance_temp/api/attendanceApi";
import { listStaffRecords } from "../../pages/StaffManagement/api/staffApi";
import { DEPT_COLORS } from "../../components/dashboard/overview/KpiDropdown";
import type { KpiDeptRow } from "../../components/dashboard/overview/KpiDropdown";

import KpiDropdown from "../../components/dashboard/overview/KpiDropdown";
import { StatCard } from "../../components/dashboard/overview";
import AttendancePerformanceCard from "../../components/dashboard/overview/AttendancePerformanceCard";
import CctvStatusCard from "../../components/dashboard/overview/CctvStatusCard";
import PayrollTrendsCard from "../../components/dashboard/overview/PayrollTrendsCard";
import PendingLeavesCard from "../../components/dashboard/overview/PendingLeavesCard";
import ShiftDistributionCard from "../../components/dashboard/overview/ShiftDistributionCard";
import TodayStatusCard from "../../components/dashboard/overview/TodayStatusCard";
import WeeklyAttendanceCard from "../../components/dashboard/overview/WeeklyAttendanceCard";
import LiveLogCard from "../../components/dashboard/overview/LiveLogCard";
import DepartmentPayrollCard from "../../components/dashboard/overview/DepartmentPayrollCard";

const WidgetLoader: React.FC = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: 350,
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
  const { cfg, organizationId } = useOrg();
  const masterData = useOrgMasterData();
  const { user } = useAuth();

  const enabledModules = activeModulesFromConfig(masterData.modules);
  const hasPurchasedModule = enabledModules.length > 0;

  const branch = useBranchSelector("filter", undefined, true);
  const selectedBranchId = branch.selectedBranchId as
    | string
    | number
    | undefined;
  const rosterBranchId = branch.isAllBranches ? undefined : selectedBranchId;
  const liveLogBackendBranchId = branch.isAllBranches
    ? undefined
    : resolveApiBranchId(organizationId, selectedBranchId, cfg.branches);

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
  useEffect(() => {
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

  // Attendance bars (Week / 14 Days / single day) read one scoped, date-ranged
  // fetch so every view counts the same unique-people-per-day data.
  const analytics = useBranchAttendanceAnalytics({
    branchId: selectedBranchId,
    peopleType: effectivePeopleType,
    enabled: showAttendanceModule,
    lookbackDays: 14,
  });

  // Payroll Trends reads the same paid-payroll history as the Payroll page.
  const payrollTrend = usePaidPayrollTrends({
    branchId: selectedBranchId,
    peopleType: effectivePeopleType,
    enabled: showPayrollModule,
  });

  const isInitialLoading = Boolean(data.loading && !data.error && !data.stats?.totalStaff);
  const statValue = (value: number | string): number | string => isInitialLoading ? value : value;
  const statSub = (value: string): string => isInitialLoading ? "Loading..." : value;

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
      const promises: Promise<any>[] = [
        data.refresh?.() || Promise.resolve(),
        analytics.refresh(),
        payrollTrend.refresh(),
      ];
      if (showAttendanceModule) {
        if (branch.isAllBranches || liveLogBackendBranchId) {
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
        if (user?.org_id || user?.organization_id) {
          promises.push(
            listStaffRecords({ organizationId: (user?.org_id || user?.organization_id) as string | number })
              .then(setAllStaff)
              .catch(() => {})
          );
        }
      }
      await Promise.all(promises);
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

  const dateFilter = useDateFilter("daily");

  useEffect(() => {
    if (!showAttendanceModule) return;
    let active = true;
    setFetchedLogs([]);
    setAllStaff([]);
    const fetchRealData = () => {
      if (!branch.isAllBranches && !liveLogBackendBranchId) {
        setFetchedLogs([]);
        return;
      }
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
      if (user?.org_id || user?.organization_id) {
        listStaffRecords({
          organizationId: (user?.org_id || user?.organization_id) as string | number,
          branchId: rosterBranchId,
          peopleType: effectivePeopleType,
        })
          .then((staff) => {
            if (active) setAllStaff(staff);
          })
          .catch(() => { });
      }
    };
    fetchRealData();
    const interval = setInterval(fetchRealData, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [
    showAttendanceModule,
    user?.org_id,
    user?.organization_id,
    effectivePeopleType,
    rosterBranchId,
    branch.isAllBranches,
    liveLogBackendBranchId,
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

  const deptAbsentRows = useMemo<KpiDeptRow[]>(() => {
    const presentIds = new Set(
      filteredLogs
        .filter((log) => {
          const status = (log.status || "").toLowerCase();
          return status === "present" || status === "late" || status === "checked_in" || status === "checked_out" || status === "half_day" || status === "on_time";
        })
        .map((log) => String(log.staffId || log.userId || log.staff_id || log.user_id))
    );
    const absentStaff = allStaff.filter((s) => !presentIds.has(String(s.id)));
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
  }, [filteredLogs, allStaff]);

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
        branchName: log.branchName || log.branch_name || "Main Branch",
        status,
        time: formattedTime,
      };
    });
  }, [filteredLogs]);

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

  const formattedToday = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#f5f6fa", padding: "24px", boxSizing: "border-box", width: "100%", borderRadius: 16, fontFamily: "'DM Sans', sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#0F172A", letterSpacing: "-0.5px", fontFamily: "'DM Sans', 'Inter', sans-serif", display: "flex", alignItems: "center", gap: 10 }}>
            <TrendingUp size={22} color={T.teal600} />
            Attendance Overview
          </h1>
          <p style={{ margin: "4px 0 0 0", fontSize: 12, fontWeight: 500, color: "#64748B", fontFamily: "'DM Sans', 'Inter', sans-serif" }}>
            {formattedToday}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <DateFilterBar filter={dateFilter} compact />
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
      <Suspense fallback={<WidgetLoader />}>
        {isInitialLoading ? <WidgetLoader /> : (
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
                  value={statValue(realTimeStats.totalStaff)}
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
                  title={`Present ${filterPeriodLabel}`}
                  value={statValue(realTimeStats.presentToday)}
                  sub={statSub(`${realTimeStats.avgAttendance}% attendance`)}
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
                  title={`Absent ${filterPeriodLabel}`}
                  value={statValue(realTimeStats.absentToday)}
                  sub={statSub(`${realTimeStats.lateToday} late`)}
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
        )}
      </Suspense>

      {(showAttendanceModule || showPayrollModule || showLeaveModule || showCctvDashboard) && (
        <Suspense fallback={<WidgetLoader />}>
          {isInitialLoading ? <WidgetLoader /> : (
            <div style={gridAuto(220)}>
              {showAttendanceModule && (
                <StatCard
                  title="Avg Attendance"
                  value={statValue(`${realTimeStats.avgAttendance}%`)}
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
        </Suspense>
      )}

      {(showAttendanceModule || showShiftDistribution) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gridAutoRows: "390px", gap: 14, marginBottom: 20, alignItems: "stretch" }}>
          {showShiftDistribution && (
            <Suspense fallback={<WidgetLoader />}>
              {isInitialLoading ? <WidgetLoader /> : (
                <ShiftDistributionCard
                  shifts={data.shiftDistribution}
                  onViewMore={(shiftKey) => {
                    const shift = data.shiftDistribution.find(s => s.key === shiftKey);
                    const label = shift?.label ?? shiftKey;
                    if (selectedBranchId && !isAllBranches) {
                      navigate(
                        getBranchModulePath("employees", Number(selectedBranchId)),
                        { state: { shiftFilter: label } }
                      );
                    } else {
                      navigate(
                        getModulePath("employees"),
                        { state: { shiftFilter: label } }
                      );
                    }
                  }}
                />
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
                  showBranchName={isAllBranches}
                  onViewAll={() => navigate(getModulePath("attendance"))}
                />
              )}
            </Suspense>
          )}
        </div>
      )}

      {showAttendanceModule && (
        <div className="dashboard-overview-attendance-grid" style={gridAuto(360)}>
          <Suspense fallback={<WidgetLoader />}>
            {isInitialLoading ? <WidgetLoader /> : (
              <WeeklyAttendanceCard
                height={SUMMARY_WIDGET_CARD_HEIGHT}
                listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
                title="Attendance"
                data={isAllBranches ? undefined : data.weeklyAttendance}
                fetchedLogs={analytics.records}
                allStaff={analytics.staff ?? allStaff}
                branchSeries={
                  isAllBranches ? data.branchWeeklyAttendance : undefined
                }
              />
            )}
          </Suspense>
          <Suspense fallback={<WidgetLoader />}>
            {isInitialLoading ? <WidgetLoader /> : (
              <AttendancePerformanceCard
                data={data.attendancePerformance}
                branchSeries={
                  isAllBranches ? data.branchAttendancePerformance : undefined
                }
              />
            )}
          </Suspense>
        </div>
      )}

      {showPayrollModule && (
        <div className="dashboard-overview-payroll-grid" style={gridAuto(360)}>
          <Suspense fallback={<WidgetLoader />}>
            {isInitialLoading || payrollTrend.pending ? <WidgetLoader /> : (
              <PayrollTrendsCard
                data={payrollTrend.ready ? payrollTrend.totals : data.payrollTrends}
                branchSeries={
                  isAllBranches
                    ? payrollTrend.ready
                      ? payrollTrend.byBranch
                      : data.branchPayrollTrends
                    : undefined
                }
              />
            )}
          </Suspense>
          <Suspense fallback={<WidgetLoader />}>
            {isInitialLoading ? <WidgetLoader /> : (
              <DepartmentPayrollCard
                allStaff={allStaff}
                branchId={selectedBranchId}
                peopleType={effectivePeopleType}
              />
            )}
          </Suspense>
        </div>
      )}

      {(showLeaveModule || showCctvDashboard) && (
        <div style={equalSummaryWidgetGrid(300)}>
          {showLeaveModule && (
            <Suspense fallback={<WidgetLoader />}>
              {isInitialLoading ? <WidgetLoader /> : (
                <PendingLeavesCard
                  branchId={selectedBranchId as never}
                  showBranchName={isAllBranches}
                  height={SUMMARY_WIDGET_CARD_HEIGHT}
                  listHeight={SUMMARY_WIDGET_BODY_HEIGHT}
                  items={data.pendingLeaves}
                  disableFetch
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
                  showBranchName={isAllBranches}
                  hideWhenEmpty
                />
              )}
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(DashboardOverviewTab);