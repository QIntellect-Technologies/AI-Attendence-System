/**
 * modules/attendance/hooks/useAttendanceData.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical attendance read hook.
 *
 * UUID / tenant-safety notes:
 * - This hook resolves UI branch ids to backend/Supabase branch UUIDs through
 *   resolveTenantScope before making any API call.
 * - Components consume this hook only; they should not call attendance endpoints
 *   directly.
 * - Fallback data used for logs is normalized into AttendanceLog[] so TypeScript
 *   and runtime shapes stay consistent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { resolveTenantScope } from "../../../utils/tenantScope";
import {
  getAttendanceLogs,
  getAttendanceStats,
  getAttendanceToday,
  type AttendanceLog,
  type AttendanceQueryParams,
  type AttendanceStats,
  type AttendanceTimingFields,
  type TodayAttendanceRecord,
} from "../api/attendanceApi";

export interface UseAttendanceDataOptions extends AttendanceQueryParams {
  autoRefresh?: boolean;
  refreshMs?: number;
  logsLimit?: number;
}

export interface UseAttendanceDataResult {
  today: TodayAttendanceRecord[];
  logs: AttendanceLog[];
  stats: AttendanceStats | null;
  totalUsers: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  refresh: () => Promise<void>;
  reload: () => Promise<void>;
}

const EMPTY_STATS: AttendanceStats = {
  totalUsers: 0,
  total_users: 0,
  totalStaff: 0,
  total_staff: 0,
  attendanceUsers: 0,
  attendance_users: 0,
  enrolledUsers: 0,
  enrolled_users: 0,
  presentToday: 0,
  present_today: 0,
  absentToday: 0,
  absent_today: 0,
  lateToday: 0,
  late_today: 0,
  todayAttendance: 0,
  today_attendance: 0,
  uniqueUsersToday: 0,
  unique_users_today: 0,
  totalLogs: 0,
  total_logs: 0,
  avgConfidence: 0,
  avg_confidence: 0,
  averageConfidence: 0,
  recentEntries: [],
  recent_entries: [],
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function textOrEmpty(value: unknown): string {
  return textOrNull(value) ?? "";
}

function idOrFallback(
  value: unknown,
  fallback: string | number = "",
): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = textOrNull(value);
  if (!text) return fallback;
  const numeric = Number(text);
  return Number.isFinite(numeric) && String(numeric) === text ? numeric : text;
}

function identity(row: Record<string, unknown>): string {
  return String(
    row.staffId ?? row.staff_id ?? row.userId ?? row.user_id ?? row.id ?? "",
  ).trim();
}

function uniqueStaffCount(
  rows: Array<TodayAttendanceRecord | AttendanceLog>,
): number {
  const ids = new Set<string>();

  rows.forEach((row) => {
    const id = identity(row as unknown as Record<string, unknown>);
    if (id) ids.add(id);
  });

  return ids.size;
}

/**
 * Carries the check-in/check-out timing classification through this hook's
 * own re-normalization step. Both toAttendanceLog and toTodayRecord rebuild
 * a fresh object from `raw` and would otherwise silently re-drop these
 * fields even after attendanceApi.ts's mapLog/mapTodayRecord already
 * preserved them — this is the second of the two places that needed fixing.
 */
function readTimingFields(
  raw: Record<string, unknown>,
): AttendanceTimingFields {
  const checkInStatus =
    textOrNull(raw.checkInStatus ?? raw.check_in_status) ?? null;
  const checkOutStatus =
    textOrNull(raw.checkOutStatus ?? raw.check_out_status) ?? null;
  const checkOutConfidenceRaw =
    raw.checkOutConfidence ?? raw.check_out_confidence;
  const checkOutCameraId =
    textOrNull(raw.checkOutCameraId ?? raw.check_out_camera_id) ?? null;
  const notes = textOrNull(raw.notes) ?? null;
  const checkOutHoldReasonRaw = textOrNull(
    raw.checkOutHoldReason ?? raw.check_out_hold_reason,
  );
  const checkOutHoldReason =
    checkOutHoldReasonRaw === "early" || checkOutHoldReasonRaw === "late"
      ? checkOutHoldReasonRaw
      : null;
  const captureChannelRaw = textOrNull(
    raw.captureChannel ?? raw.capture_channel,
  );
  const captureChannel =
    captureChannelRaw === "local_node" ||
    captureChannelRaw === "cloud" ||
    captureChannelRaw === "mobile_app" ||
    captureChannelRaw === "manual"
      ? captureChannelRaw
      : null;
  const workDuration = textOrNull(raw.workDuration ?? raw.work_duration);
  const durationMinutesRaw = raw.durationMinutes ?? raw.duration_minutes;
  const dayStatus = textOrNull(raw.dayStatus ?? raw.day_status);
  const checkOutPayrollDecisionRaw = textOrNull(
    raw.checkOutPayrollDecision ?? raw.check_out_payroll_decision,
  );
  const checkOutPayrollDecision =
    checkOutPayrollDecisionRaw === "include" ||
    checkOutPayrollDecisionRaw === "exclude"
      ? checkOutPayrollDecisionRaw
      : null;
  const checkInPayrollDecisionRaw = textOrNull(
    raw.checkInPayrollDecision ?? raw.check_in_payroll_decision,
  );
  const checkInPayrollDecision =
    checkInPayrollDecisionRaw === "include" ||
    checkInPayrollDecisionRaw === "exclude"
      ? checkInPayrollDecisionRaw
      : null;

  return {
    checkInStatus,
    check_in_status: checkInStatus,
    dayStatus,
    day_status: dayStatus,
    checkOutPayrollDecision,
    check_out_payroll_decision: checkOutPayrollDecision,
    checkInPayrollDecision,
    check_in_payroll_decision: checkInPayrollDecision,
    checkOutStatus,
    check_out_status: checkOutStatus,
    checkOutConfidence:
      checkOutConfidenceRaw !== undefined && checkOutConfidenceRaw !== null
        ? Number(checkOutConfidenceRaw)
        : null,
    check_out_confidence:
      checkOutConfidenceRaw !== undefined && checkOutConfidenceRaw !== null
        ? Number(checkOutConfidenceRaw)
        : null,
    checkOutCameraId,
    check_out_camera_id: checkOutCameraId,
    notes,
    checkOutHoldReason,
    check_out_hold_reason: checkOutHoldReason,
    captureChannel,
    capture_channel: captureChannel,
    workDuration,
    work_duration: workDuration,
    durationMinutes:
      durationMinutesRaw !== undefined && durationMinutesRaw !== null
        ? Number(durationMinutesRaw)
        : null,
    duration_minutes:
      durationMinutesRaw !== undefined && durationMinutesRaw !== null
        ? Number(durationMinutesRaw)
        : null,
  };
}

function toAttendanceLog(
  row: AttendanceLog | TodayAttendanceRecord | unknown,
): AttendanceLog {
  const raw = asRecord(row);

  const timestamp =
    textOrNull(raw.timestamp) ??
    textOrNull(raw.checkIn) ??
    textOrNull(raw.check_in) ??
    textOrNull(raw.createdAt) ??
    textOrNull(raw.created_at) ??
    textOrNull(raw.logDate) ??
    textOrNull(raw.log_date) ??
    "";

  return {
    ...readTimingFields(raw),
    id: idOrFallback(raw.id),
    userId: (raw.userId ??
      raw.user_id ??
      raw.staffId ??
      raw.staff_id ??
      null) as number | string | null,
    userName:
      textOrNull(raw.userName) ??
      textOrNull(raw.user_name) ??
      textOrNull(raw.staffName) ??
      textOrNull(raw.staff_name) ??
      textOrNull(raw.name) ??
      "Unknown",
    detectedName:
      textOrNull(raw.detectedName ?? raw.detected_name) ?? undefined,
    confidence: Number(raw.confidence ?? 0),
    source: textOrNull(raw.source),
    timestamp,
    status: textOrNull(raw.status) ?? undefined,
    branchId: (raw.branchId ?? raw.branch_id ?? null) as number | string | null,
    branchName: textOrNull(raw.branchName ?? raw.branch_name),
    department: textOrNull(raw.department),
  };
}

function toTodayRecord(
  row: TodayAttendanceRecord | AttendanceLog | unknown,
): TodayAttendanceRecord {
  const raw = asRecord(row);
  const checkIn =
    textOrNull(raw.checkIn) ??
    textOrNull(raw.check_in) ??
    textOrNull(raw.timestamp) ??
    textOrNull(raw.createdAt) ??
    textOrNull(raw.created_at) ??
    null;

  const logDate =
    textOrNull(raw.logDate) ??
    textOrNull(raw.log_date) ??
    textOrNull(raw.attendanceDate) ??
    textOrNull(raw.attendance_date) ??
    (checkIn ? checkIn.slice(0, 10) : new Date().toISOString().slice(0, 10));

  return {
    ...readTimingFields(raw),
    id: idOrFallback(raw.id),
    userId: (raw.userId ??
      raw.user_id ??
      raw.staffId ??
      raw.staff_id ??
      null) as number | string | null,
    userName:
      textOrNull(raw.userName) ??
      textOrNull(raw.user_name) ??
      textOrNull(raw.staffName) ??
      textOrNull(raw.staff_name) ??
      textOrNull(raw.name) ??
      "Unknown",
    confidence: Number(raw.confidence ?? 0),
    source: textOrNull(raw.source),
    checkIn,
    checkOut: textOrNull(raw.checkOut ?? raw.check_out),
    status: textOrNull(raw.status) ?? "PRESENT",
    logDate,
    createdAt: textOrNull(raw.createdAt ?? raw.created_at) ?? checkIn,
    branchId: (raw.branchId ?? raw.branch_id ?? null) as number | string | null,
    branchName: textOrNull(raw.branchName ?? raw.branch_name),
    department: textOrNull(raw.department),
  };
}

function recordDayKey(value: unknown): string {
  const raw = asRecord(value);
  return (
    textOrNull(raw.logDate) ??
    textOrNull(raw.log_date) ??
    textOrNull(raw.attendanceDate) ??
    textOrNull(raw.attendance_date) ??
    textOrNull(raw.timestamp)?.slice(0, 10) ??
    textOrNull(raw.checkIn)?.slice(0, 10) ??
    textOrNull(raw.check_in)?.slice(0, 10) ??
    textOrNull(raw.createdAt)?.slice(0, 10) ??
    textOrNull(raw.created_at)?.slice(0, 10) ??
    ""
  );
}

function uniqueTodayRows(
  rows: TodayAttendanceRecord[],
): TodayAttendanceRecord[] {
  const byUser = new Map<string, TodayAttendanceRecord>();

  rows.forEach((row) => {
    const raw = row as unknown as Record<string, unknown>;
    const key = identity(raw) || String(row.id);
    if (!key) return;

    const existing = byUser.get(key);
    if (!existing) {
      byUser.set(key, row);
      return;
    }

    const existingTime = String(existing.checkIn ?? existing.createdAt ?? "");
    const nextTime = String(row.checkIn ?? row.createdAt ?? "");
    if (nextTime > existingTime) byUser.set(key, row);
  });

  return Array.from(byUser.values());
}

export function useAttendanceData(
  options: UseAttendanceDataOptions = {},
): UseAttendanceDataResult {
  const {
    organizationId: contextOrganizationId,
    activeBranchId,
    cfg,
  } = useOrg();
  const {
    autoRefresh = false,
    refreshMs = 30_000,
    logsLimit = 500,
    organizationId,
    organization_id,
    org_id,
    branchId,
    branch_id,
    backendBranchId,
    backend_branch_id,
    branchUuid,
    branch_uuid,
    date,
    log_date,
    peopleType,
    people_type,
  } = options;

  const [today, setToday] = useState<TodayAttendanceRecord[]>([]);
  const [logs, setLogs] = useState<AttendanceLog[]>([]);
  const [stats, setStats] = useState<AttendanceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const query = useMemo<AttendanceQueryParams>(() => {
    const rawOrg =
      organization_id ?? organizationId ?? org_id ?? contextOrganizationId;
    const rawBranch =
      backend_branch_id ??
      backendBranchId ??
      branch_uuid ??
      branchUuid ??
      branch_id ??
      branchId ??
      activeBranchId;

    const scope = resolveTenantScope(
      {
        organizationId: rawOrg,
        branchId: rawBranch,
      },
      cfg.branches,
    );

    return {
      organizationId: scope.organizationId,
      branchId: scope.apiBranchId,
      date,
      log_date,
      peopleType: peopleType ?? people_type ?? undefined,
    };
  }, [
    activeBranchId,
    backendBranchId,
    backend_branch_id,
    branchId,
    branchUuid,
    branch_id,
    branch_uuid,
    cfg.branches,
    contextOrganizationId,
    date,
    log_date,
    org_id,
    organizationId,
    organization_id,
    peopleType,
    people_type,
  ]);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);

    try {
      const [todayRows, logRows, statsRow] = await Promise.all([
        getAttendanceToday(query),
        getAttendanceLogs({ ...query, limit: logsLimit }),
        getAttendanceStats(query).catch(() => EMPTY_STATS),
      ]);

      if (!mounted.current) return;

      const statsLogs = [
        ...(statsRow.recentEntries ?? []),
        ...(statsRow.recent_entries ?? []),
      ].map(toAttendanceLog);

      const nextLogs: AttendanceLog[] = logRows.length
        ? logRows.map(toAttendanceLog)
        : statsLogs.length
          ? statsLogs
          : todayRows.map(toAttendanceLog);

      const requestedDay =
        textOrNull(query.date) ??
        textOrNull(query.log_date) ??
        new Date().toISOString().slice(0, 10);

      const todayFromLogs = nextLogs
        .filter((row) => recordDayKey(row) === requestedDay)
        .map(toTodayRecord);

      const nextTodayRows = uniqueTodayRows([
        ...todayRows.map(toTodayRecord),
        ...todayFromLogs,
      ]);

      setToday(nextTodayRows);
      setLogs(nextLogs);
      setStats(statsRow);
    } catch (err) {
      if (!mounted.current) return;
      setError(
        err instanceof Error ? err.message : "Failed to load attendance data",
      );
      setToday([]);
      setLogs([]);
      setStats(EMPTY_STATS);
    } finally {
      if (!mounted.current) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, [logsLimit, query]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const interval = window.setInterval(
      () => void load(),
      Math.max(5_000, refreshMs),
    );
    return () => window.clearInterval(interval);
  }, [autoRefresh, load, refreshMs]);

  const totalUsers = useMemo(() => {
    const statTotal =
      stats?.totalUsers ??
      stats?.total_users ??
      stats?.totalStaff ??
      stats?.total_staff ??
      stats?.attendanceUsers ??
      stats?.attendance_users ??
      0;

    return statTotal > 0 ? statTotal : uniqueStaffCount([...today, ...logs]);
  }, [logs, stats, today]);

  return {
    today,
    logs,
    stats,
    totalUsers,
    loading,
    refreshing,
    error,
    refetch: load,
    refresh: load,
    reload: load,
  };
}