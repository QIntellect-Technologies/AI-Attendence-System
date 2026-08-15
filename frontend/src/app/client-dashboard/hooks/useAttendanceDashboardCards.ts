import { useMemo } from "react";

import { useOrg, useOrgMasterData } from "../contexts/OrgConfigContext";
import type {
  AttendanceLog,
  TodayAttendanceRecord,
} from "../pages/Attendance/api/attendanceApi";
import { useAttendanceData } from "../pages/attendance/hooks/useAttendanceData";

export interface UseAttendanceDashboardCardsOptions {
  branchId?: number | string | null;
  totalUsersOverride?: number;
}

export interface AttendanceDashboardLiveLogItem {
  id: string;
  name: string;
  status: "Present" | "Late" | "Absent";
  branchName: string;
  department: string;
  time: string;
}

export interface TodayStatusCardItem {
  name: "Present" | "Late" | "Absent";
  value: number;
}

export interface WeeklyAttendanceCardItem {
  day: string;
  count: number;
}

export interface AttendancePerformanceCardItem {
  month: string;
  "On Time": number;
  Late: number;
  Absent: number;
}

export interface BranchWeeklyAttendanceSeries {
  branchId: number;
  branchName: string;
  data: WeeklyAttendanceCardItem[];
}

export interface BranchAttendancePerformanceSeries {
  branchId: number;
  branchName: string;
  avgAttendance: number;
  data: AttendancePerformanceCardItem[];
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return "—";

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function identityKey(...values: unknown[]): string | null {
  for (const value of values) {
    const raw = text(value);
    if (raw && raw !== "0" && raw.toLowerCase() !== "undefined") {
      return raw;
    }
  }
  return null;
}

function getStatusFromText(
  value: string | null | undefined,
): "Present" | "Late" | "Absent" {
  const raw = String(value ?? "").toLowerCase();

  if (raw.includes("late")) return "Late";
  if (raw.includes("absent")) return "Absent";

  return "Present";
}

function getLogStatus(log: AttendanceLog): "Present" | "Late" | "Absent" {
  return getStatusFromText((log as any).status);
}

function getTodayStatus(
  record: TodayAttendanceRecord,
): "Present" | "Late" | "Absent" {
  return getStatusFromText((record as any).status);
}

function branchCandidates(record: Record<string, unknown>): string[] {
  return [
    record.branchId,
    record.branch_id,
    record.backendBranchId,
    record.backend_branch_id,
    record.branchUuid,
    record.branch_uuid,
  ]
    .map((value) => text(value))
    .filter(Boolean);
}

type BranchIdentity = {
  id?: number | string | null;
  name?: string;
  backendBranchId?: string | null;
  backend_branch_id?: string | null;
  branchUuid?: string | null;
  branch_uuid?: string | null;
};

function branchIdentityValues(branch?: BranchIdentity | null): string[] {
  if (!branch) return [];
  return [
    branch.id,
    branch.backendBranchId,
    branch.backend_branch_id,
    branch.branchUuid,
    branch.branch_uuid,
  ]
    .map((value) => text(value))
    .filter(Boolean);
}

function resolveBranchIdentity(
  branchId: number | string | null | undefined,
  branches: BranchIdentity[],
): {
  uiBranchId?: number | string;
  apiBranchId?: string;
  branch?: BranchIdentity;
} {
  const expected = text(branchId);
  if (!expected) return {};

  const branch = branches.find((item) =>
    branchIdentityValues(item).some((candidate) => candidate === expected),
  );

  if (!branch) {
    return { uiBranchId: branchId ?? undefined, apiBranchId: expected };
  }

  const apiBranchId =
    text(branch.backendBranchId) ||
    text(branch.backend_branch_id) ||
    text(branch.branchUuid) ||
    text(branch.branch_uuid) ||
    text(branch.id);

  return {
    uiBranchId: branch.id ?? branchId ?? undefined,
    apiBranchId,
    branch,
  };
}

function belongsToBranch(
  record: Record<string, unknown>,
  branchId?: number | string | null,
  apiBranchId?: string | null,
): boolean {
  const expected = [branchId, apiBranchId]
    .map((value) => text(value))
    .filter(Boolean);
  if (!expected.length) return true;

  const candidates = branchCandidates(record);
  return expected.some((value) => candidates.includes(value));
}

function countUniquePeople(
  rows: Array<AttendanceLog | TodayAttendanceRecord>,
): number {
  const ids = new Set<string>();

  rows.forEach((row) => {
    const record = row as unknown as Record<string, unknown>;
    const id = identityKey(
      record.userId,
      record.user_id,
      record.staffId,
      record.staff_id,
      record.id,
    );

    if (id) ids.add(id);
  });

  return ids.size;
}

function getLastSevenDays(): Date[] {
  const today = new Date();

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    return date;
  });
}

function getLastSixMonths(): Date[] {
  const today = new Date();

  return Array.from({ length: 6 }, (_, index) => {
    return new Date(today.getFullYear(), today.getMonth() - (5 - index), 1);
  });
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}`;
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString([], {
    month: "short",
  });
}

function buildWeeklyAttendance(
  logs: AttendanceLog[],
): WeeklyAttendanceCardItem[] {
  const days = getLastSevenDays();
  const usersByDate = new Map<string, Set<string>>();

  days.forEach((date) => {
    usersByDate.set(dateKey(date), new Set());
  });

  logs.forEach((log) => {
    const date = parseDate((log as any).timestamp);
    if (!date) return;

    const key = dateKey(date);
    const bucket = usersByDate.get(key);
    if (!bucket) return;

    const id = identityKey(
      (log as any).userId,
      (log as any).user_id,
      (log as any).staffId,
      (log as any).staff_id,
      log.id,
    );
    if (id) bucket.add(id);
  });

  return days.map((date) => ({
    day: date.toLocaleDateString([], { weekday: "short" }),
    count: usersByDate.get(dateKey(date))?.size ?? 0,
  }));
}

function buildAttendancePerformance(
  logs: AttendanceLog[],
  absentCount = 0,
): AttendancePerformanceCardItem[] {
  const months = getLastSixMonths();
  const buckets = new Map<string, AttendancePerformanceCardItem>();

  months.forEach((date) => {
    buckets.set(monthKey(date), {
      month: monthLabel(date),
      "On Time": 0,
      Late: 0,
      Absent: 0,
    });
  });

  logs.forEach((log) => {
    const date = parseDate((log as any).timestamp);
    if (!date) return;

    const bucket = buckets.get(monthKey(date));
    if (!bucket) return;

    const status = getLogStatus(log);

    if (status === "Late") bucket.Late += 1;
    else if (status === "Absent") bucket.Absent += 1;
    else bucket["On Time"] += 1;
  });

  const currentMonth = buckets.get(monthKey(new Date()));
  if (currentMonth) {
    currentMonth.Absent = absentCount;
  }

  return Array.from(buckets.values());
}

function isSameCalendarDay(
  value: string | null | undefined,
  target = new Date(),
): boolean {
  const date = parseDate(value);
  if (!date) return false;
  return dateKey(date) === dateKey(target);
}

type TodayPresenceBuckets = {
  presentIds: Set<string>;
  lateIds: Set<string>;
};

function collectTodayPresence(
  todayRows: TodayAttendanceRecord[],
  logRows: AttendanceLog[],
): TodayPresenceBuckets {
  const presentIds = new Set<string>();
  const lateIds = new Set<string>();

  todayRows.forEach((record) => {
    const row = record as unknown as Record<string, unknown>;
    const id = identityKey(
      row.userId,
      row.user_id,
      row.staffId,
      row.staff_id,
      row.id,
    );
    if (!id) return;

    const status = getTodayStatus(record);
    if (status === "Absent") return;

    presentIds.add(id);
    if (status === "Late") lateIds.add(id);
  });

  logRows.forEach((log) => {
    const row = log as unknown as Record<string, unknown>;
    const timestamp =
      text(row.timestamp) ||
      text(row.created_at) ||
      text(row.checkIn) ||
      text(row.check_in);
    if (!isSameCalendarDay(timestamp)) return;

    const id = identityKey(
      row.userId,
      row.user_id,
      row.staffId,
      row.staff_id,
      row.id,
    );
    if (!id) return;

    const status = getLogStatus(log);
    if (status === "Absent") return;

    presentIds.add(id);
    if (status === "Late") lateIds.add(id);
  });

  return { presentIds, lateIds };
}

function groupLogsByBranch(logs: AttendanceLog[], branches: BranchIdentity[]) {
  const groups = new Map<
    number,
    {
      branchId: number;
      branchName: string;
      logs: AttendanceLog[];
    }
  >();

  logs.forEach((log) => {
    const record = log as unknown as Record<string, unknown>;
    const candidates = branchCandidates(record);
    if (!candidates.length) return;

    const branch = branches.find((item) =>
      branchIdentityValues(item).some((candidate) =>
        candidates.includes(candidate),
      ),
    );

    const numericId = Number(branch?.id ?? record.branchId ?? record.branch_id);
    if (!Number.isFinite(numericId)) return;

    const branchName =
      text(branch?.name) ||
      text((log as any).branchName) ||
      text((log as any).branch_name) ||
      `Branch ${numericId}`;

    const existing = groups.get(numericId);

    if (existing) {
      existing.logs.push(log);
    } else {
      groups.set(numericId, {
        branchId: numericId,
        branchName,
        logs: [log],
      });
    }
  });

  return Array.from(groups.values());
}

export function useAttendanceDashboardCards(
  options: UseAttendanceDashboardCardsOptions = {},
) {
  const { branchId, totalUsersOverride } = options;
  const masterData = useOrgMasterData();
  const { organizationId } = useOrg();

  const resolvedBranch = useMemo(
    () =>
      resolveBranchIdentity(branchId, masterData.branches as BranchIdentity[]),
    [branchId, masterData.branches],
  );

  const attendance = useAttendanceData({
    autoRefresh: true,
    refreshMs: 10_000,
    logsLimit: 500,
    // Backend APIs/local node rows are keyed by the Supabase branch UUID.
    // UI routes still use numeric branch ids, so resolve before fetching.
    organizationId,
    branchId: resolvedBranch.apiBranchId ?? branchId,
  });

  const scopedToday = useMemo(() => {
    return attendance.today.filter((record) =>
      belongsToBranch(
        record as unknown as Record<string, unknown>,
        resolvedBranch.uiBranchId ?? branchId,
        resolvedBranch.apiBranchId,
      ),
    );
  }, [
    attendance.today,
    branchId,
    resolvedBranch.apiBranchId,
    resolvedBranch.uiBranchId,
  ]);

  const scopedLogs = useMemo(() => {
    return attendance.logs.filter((record) =>
      belongsToBranch(
        record as unknown as Record<string, unknown>,
        resolvedBranch.uiBranchId ?? branchId,
        resolvedBranch.apiBranchId,
      ),
    );
  }, [
    attendance.logs,
    branchId,
    resolvedBranch.apiBranchId,
    resolvedBranch.uiBranchId,
  ]);

  const todayPresence = useMemo(
    () => collectTodayPresence(scopedToday, scopedLogs),
    [scopedLogs, scopedToday],
  );

  const presentUserIds = todayPresence.presentIds;

  const scopedKnownUserCount = useMemo(() => {
    return countUniquePeople([...scopedToday, ...scopedLogs]);
  }, [scopedLogs, scopedToday]);

  const overrideTotal = Number(totalUsersOverride ?? 0);
  const attendanceTotal = Number(attendance.totalUsers ?? 0);

  /**
   * Total staff is a tenant/branch scoped count, not an attendance-event count.
   * The branch page may pass totalUsersOverride from older overview data; if that
   * source is still empty because it used the numeric UI branch id, do not let a
   * stale 0 hide real UUID-scoped attendance/staff data.
   */
  const totalUsers = Math.max(
    Number.isFinite(overrideTotal) && overrideTotal > 0 ? overrideTotal : 0,
    Number.isFinite(attendanceTotal) && attendanceTotal > 0
      ? attendanceTotal
      : 0,
    scopedKnownUserCount,
    presentUserIds.size,
  );

  const presentCount = presentUserIds.size;
  const lateCount = todayPresence.lateIds.size;
  const absentCount = Math.max(0, totalUsers - presentCount);
  const avgAttendance =
    totalUsers > 0 ? Math.round((presentCount / totalUsers) * 100) : 0;

  const latestLogs = useMemo(() => scopedLogs.slice(0, 10), [scopedLogs]);

  const liveLogs = useMemo<AttendanceDashboardLiveLogItem[]>(() => {
    return latestLogs.map((log) => ({
      id: String(log.id),
      name:
        (log as any).userName ??
        (log as any).user_name ??
        (log as any).staffName ??
        (log as any).staff_name ??
        "Unknown",
      status: getLogStatus(log),
      branchName: (log as any).branchName ?? (log as any).branch_name ?? "—",
      department: (log as any).department ?? "",
      time: formatTime((log as any).timestamp),
    }));
  }, [latestLogs]);

  const todayStatus = useMemo<TodayStatusCardItem[]>(() => {
    const presentOnTime = Math.max(0, presentCount - lateCount);

    return [
      { name: "Present", value: presentOnTime },
      { name: "Late", value: lateCount },
      { name: "Absent", value: absentCount },
    ];
  }, [absentCount, lateCount, presentCount]);

  const weeklyAttendance = useMemo<WeeklyAttendanceCardItem[]>(() => {
    return buildWeeklyAttendance(scopedLogs);
  }, [scopedLogs]);

  const attendancePerformance = useMemo<AttendancePerformanceCardItem[]>(() => {
    return buildAttendancePerformance(scopedLogs, absentCount);
  }, [absentCount, scopedLogs]);

  const branchWeeklyAttendance = useMemo<BranchWeeklyAttendanceSeries[]>(() => {
    return groupLogsByBranch(
      attendance.logs,
      masterData.branches as BranchIdentity[],
    ).map((branch) => ({
      branchId: branch.branchId,
      branchName: branch.branchName,
      data: buildWeeklyAttendance(branch.logs),
    }));
  }, [attendance.logs, masterData.branches]);

  const branchAttendancePerformance = useMemo<
    BranchAttendancePerformanceSeries[]
  >(() => {
    return groupLogsByBranch(
      attendance.logs,
      masterData.branches as BranchIdentity[],
    ).map((branch) => ({
      branchId: branch.branchId,
      branchName: branch.branchName,
      avgAttendance: 0,
      data: buildAttendancePerformance(branch.logs),
    }));
  }, [attendance.logs, masterData.branches]);

  return {
    ...attendance,

    scopedToday,
    scopedLogs,

    totalUsers,
    presentCount,
    absentCount,
    lateCount,
    avgAttendance,

    /**
     * Backward-compatible names for DashboardOverviewTab.
     */
    attendanceRate: avgAttendance,
    lateToday: lateCount,

    liveLogs,
    todayStatus,
    weeklyAttendance,
    attendancePerformance,

    branchWeeklyAttendance,
    branchAttendancePerformance,
  };
}
