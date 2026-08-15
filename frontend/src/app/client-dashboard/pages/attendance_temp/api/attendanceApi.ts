/// <reference types="vite/client" />

/**
 * modules/attendance/api/attendanceApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single frontend API boundary for attendance.
 * UUID-safe and tenant-scoped. Components must not call fetch directly.
 */

import {
  appendTenantQuery,
  cleanId,
  type MaybeTenantId,
} from "../../../utils/tenantScope";

type TenantId = number | string;

export interface AttendanceQueryParams {
  organizationId?: MaybeTenantId;
  organization_id?: MaybeTenantId;
  org_id?: MaybeTenantId;
  branchId?: MaybeTenantId;
  branch_id?: MaybeTenantId;
  backendBranchId?: MaybeTenantId;
  backend_branch_id?: MaybeTenantId;
  branchUuid?: MaybeTenantId;
  branch_uuid?: MaybeTenantId;
  date?: string;
  start?: string;
  end?: string;
  log_date?: string;
  peopleType?: string | null;
  people_type?: string | null;
  personType?: string | null;
  person_type?: string | null;
  limit?: number;
}

/**
 * Real, timing-aware classification computed server-side by
 * resolve_check_in_status / resolve_check_out_status (support_db_attendance_gate.py).
 * "unscheduled" means no shift/capture-settings/override matched — not a
 * judgement of lateness, just "nothing to compare against".
 */
export type AttendanceTimingStatus =
  | "on_time"
  | "late"
  | "early"
  | "unscheduled";

/**
 * Shared check-in/check-out timing fields, present on both the log stream
 * and the "today" snapshot. Kept in one place so both interfaces and both
 * mappers (mapLog/mapTodayRecord below) stay in sync — this is exactly the
 * set of fields support_db.py's _attendance_row_for_dashboard adds
 * additively alongside the legacy 'status' key.
 */
export interface AttendanceTimingFields {
  checkInStatus?: AttendanceTimingStatus | string | null;
  check_in_status?: AttendanceTimingStatus | string | null;
  checkOutStatus?: AttendanceTimingStatus | string | null;
  check_out_status?: AttendanceTimingStatus | string | null;
  checkOutConfidence?: number | null;
  check_out_confidence?: number | null;
  checkOutCameraId?: string | null;
  check_out_camera_id?: string | null;
  /** Operator-facing context set by the local node for a check-in confirmed
   * only after its shift window closed but originally sighted earlier —
   * e.g. "Detected at 07:42, early — before the 09:00 shift start." Or, for
   * a checkout leg, the early/late hold context. Null for every other row.
   * See local_db.py's _format_early_before_shift_note /
   * _format_checkout_hold_note. */
  notes?: string | null;
  /** 'early' | 'late' | null. Non-null only if this row's checkout was
   * synced to the cloud while still held for review, before an operator
   * resolved it on the local node (see support_db.py's push_node_attendance
   * and attendance_sync_worker.py). Null for a normal confirmed checkout or
   * one resolved via half-day/leave-open. */
  checkOutHoldReason?: "early" | "late" | null;
  check_out_hold_reason?: "early" | "late" | null;
  /** local_node | cloud | mobile_app | null — coarse capture-origin label
   * written additively by support_db.py alongside the existing (more
   * granular, constraint-bound) `source` column. Null for any row written
   * before that column existed; the app must treat it as optional. See
   * support_db.py's capture_channel migration notes for the three exact
   * write sites this maps to 1:1. */
  captureChannel?: "local_node" | "cloud" | "mobile_app" | null;
  capture_channel?: "local_node" | "cloud" | "mobile_app" | null;
  /** Server-computed from timestamp/check_out_timestamp via the same
   * compute_duration() helper both the dashboard row mapper and the mobile
   * history endpoint call, so the two surfaces never disagree. Only
   * meaningfully non-null once a checkout exists (or day_status is
   * 'half_day', in which case it's literally the string "Half Day" rather
   * than a computed diff). The client also recomputes this from
   * inTime/outTime as a fallback (AttendanceView.tsx's
   * calculateWorkDuration) for older rows written before this field
   * existed — this is the authoritative value when present. */
  workDuration?: string | null;
  work_duration?: string | null;
  durationMinutes?: number | null;
  duration_minutes?: number | null;
  /**
   * Day-level outcome set by an operator decision -- 'present' | 'half_day'
   * | 'short_leave' | 'late' | 'overtime'. Written by both the local-node
   * hold-resolution actions (local_db.py's mark_held_*) and the mobile/
   * office-staff exceptions flow (resolve_attendance_exception), so this is
   * the one field that's reliable across both capture channels. A value
   * other than 'present' always wins over checkInStatus for display -- see
   * AttendanceView.tsx's deriveDayStatusBadge.
   */
  dayStatus?:
    | "present"
    | "half_day"
    | "short_leave"
    | "late"
    | "overtime"
    | string
    | null;
  day_status?:
    | "present"
    | "half_day"
    | "short_leave"
    | "late"
    | "overtime"
    | string
    | null;
  /** 'include' | 'exclude' | null. Only ever populated for a local-node row
   * already classified (dayStatus in half_day/short_leave/late/overtime) --
   * see support_db_attendance_exceptions.py's set_local_node_payroll_decision.
   * Null for every ordinary present/on_time day (nothing to decide) and,
   * for now, for every mobile-sourced row too (that path doesn't write this
   * field yet). */
  checkOutPayrollDecision?: "include" | "exclude" | null;
  check_out_payroll_decision?: "include" | "exclude" | null;
  /** Reserved for the mobile/office-staff exceptions flow -- not written by
   * the backend yet, always null today. */
  checkInPayrollDecision?: "include" | "exclude" | null;
  check_in_payroll_decision?: "include" | "exclude" | null;
}

export interface AttendanceLog extends AttendanceTimingFields {
  id: number | string;
  userId: number | string | null;
  user_id?: number | string | null;
  staffId?: number | string | null;
  staff_id?: number | string | null;
  userName: string;
  user_name?: string;
  staffName?: string;
  staff_name?: string;
  detectedName?: string;
  confidence: number;
  source: string | null;
  timestamp: string;
  checkIn?: string | null;
  check_in?: string | null;
  checkOut?: string | null;
  check_out?: string | null;
  status?: string;
  logDate?: string;
  log_date?: string;

  branchId: number | string | null;
  branch_id?: number | string | null;
  backendBranchId?: number | string | null;
  backend_branch_id?: number | string | null;
  branchUuid?: number | string | null;
  branch_uuid?: number | string | null;
  branchName: string | null;
  branch_name?: string | null;
  department: string | null;
}

export interface TodayAttendanceRecord extends AttendanceTimingFields {
  id: number | string;
  userId: number | string | null;
  user_id?: number | string | null;
  staffId?: number | string | null;
  staff_id?: number | string | null;
  userName: string;
  user_name?: string;
  staffName?: string;
  staff_name?: string;
  confidence: number;
  source: string | null;
  checkIn: string | null;
  check_in?: string | null;
  checkOut: string | null;
  check_out?: string | null;
  status: "PRESENT" | "ABSENT" | string;
  logDate: string;
  log_date?: string;
  createdAt: string | null;
  created_at?: string | null;
  timestamp?: string | null;

  branchId: number | string | null;
  branch_id?: number | string | null;
  backendBranchId?: number | string | null;
  backend_branch_id?: number | string | null;
  branchUuid?: number | string | null;
  branch_uuid?: number | string | null;
  branchName: string | null;
  branch_name?: string | null;
  department: string | null;
}

export interface AttendanceStats {
  totalUsers: number;
  total_users: number;
  totalStaff: number;
  total_staff: number;
  attendanceUsers: number;
  attendance_users: number;
  enrolledUsers: number;
  enrolled_users: number;
  presentToday: number;
  present_today: number;
  absentToday: number;
  absent_today: number;
  lateToday: number;
  late_today: number;
  todayAttendance: number;
  today_attendance: number;
  uniqueUsersToday: number;
  unique_users_today: number;
  totalLogs: number;
  total_logs: number;
  avgConfidence: number;
  avg_confidence: number;
  averageConfidence: number;
  recentEntries: AttendanceLog[];
  recent_entries: AttendanceLog[];
}

interface RawAttendanceLog extends Record<string, unknown> {}
interface RawTodayAttendance extends Record<string, unknown> {}
interface RawStatsResponse extends Record<string, unknown> {}

const API_BASE = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) || "/api"
).replace(/\/$/, "");

function normalizeBase(path: string): string {
  if (API_BASE.endsWith("/api") && path.startsWith("/api/"))
    return `${API_BASE}${path.slice(4)}`;
  return `${API_BASE}${path}`;
}

function appendAttendanceQuery(
  path: string,
  params: AttendanceQueryParams = {},
): string {
  const [pathname, existingQuery = ""] = path.split("?");
  const query = new URLSearchParams(existingQuery);
  appendTenantQuery(query, params);

  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.date) query.set("date", params.date);
  if (params.start) query.set("start", params.start);
  if (params.end) query.set("end", params.end);
  if (params.log_date) query.set("log_date", params.log_date);
  const peopleType =
    params.peopleType ??
    params.people_type ??
    params.personType ??
    params.person_type;
  if (peopleType) query.set("people_type", String(peopleType));

  const queryString = query.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

const DASHBOARD_AUTH_TOKEN_KEY = "dashboardAuthToken";

function dashboardAuthHeaders(): HeadersInit {
  try {
    const token = localStorage.getItem(DASHBOARD_AUTH_TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function requestJson<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const authHeader = dashboardAuthHeaders() as Record<string, string>;
  if (authHeader.Authorization && !headers.has("Authorization")) {
    headers.set("Authorization", authHeader.Authorization);
  }

  const response = await fetch(normalizeBase(path), {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });

  const body = await response.json().catch(() => ({}));
  if (
    !response.ok ||
    (body && typeof body === "object" && (body as any).success === false)
  ) {
    throw new Error(
      (body as any)?.message ||
        (body as any)?.error ||
        `Attendance request failed: ${response.status}`,
    );
  }
  return body as T;
}

function stableId(
  value: unknown,
  fallback: number | string = 0,
): number | string {
  const raw = value ?? fallback;
  if (typeof raw === "number") return raw;
  const text = String(raw).trim();
  const numeric = Number(text);
  return Number.isFinite(numeric) && String(numeric) === text ? numeric : text;
}

function first<T = unknown>(
  raw: Record<string, unknown>,
  ...keys: string[]
): T | undefined {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== "")
      return raw[key] as T;
  }
  return undefined;
}

/**
 * Extracts the check-in/check-out timing classification fields that
 * support_db.py's _attendance_row_for_dashboard sends additively alongside
 * the legacy 'status' key. Shared by mapLog (and therefore mapTodayRecord,
 * which spreads mapLog's result) so there is exactly one place that knows
 * the backend's key names.
 */
function mapTimingFields(raw: Record<string, unknown>): AttendanceTimingFields {
  const checkInStatus =
    (first(raw, "check_in_status", "checkInStatus") as string | undefined) ??
    null;
  const checkOutStatus =
    (first(raw, "check_out_status", "checkOutStatus") as string | undefined) ??
    null;
  const checkOutConfidenceRaw = first(
    raw,
    "check_out_confidence",
    "checkOutConfidence",
  );
  const checkOutCameraId =
    (first(raw, "check_out_camera_id", "checkOutCameraId") as
      | string
      | undefined) ?? null;
  const notes = (first(raw, "notes") as string | undefined) ?? null;
  const checkOutHoldReasonRaw = first(
    raw,
    "check_out_hold_reason",
    "checkOutHoldReason",
  ) as string | undefined;
  const checkOutHoldReason =
    checkOutHoldReasonRaw === "early" || checkOutHoldReasonRaw === "late"
      ? checkOutHoldReasonRaw
      : null;
  const captureChannelRaw = first(raw, "capture_channel", "captureChannel") as
    | string
    | undefined;
  const captureChannel =
    captureChannelRaw === "local_node" ||
    captureChannelRaw === "cloud" ||
    captureChannelRaw === "mobile_app"
      ? captureChannelRaw
      : null;
  const workDuration =
    (first(raw, "work_duration", "workDuration") as string | undefined) ?? null;
  const durationMinutesRaw = first(raw, "duration_minutes", "durationMinutes");
  const dayStatus =
    (first(raw, "day_status", "dayStatus") as string | undefined) ?? null;
  const checkOutPayrollDecisionRaw = first(
    raw,
    "check_out_payroll_decision",
    "checkOutPayrollDecision",
  ) as string | undefined;
  const checkOutPayrollDecision =
    checkOutPayrollDecisionRaw === "include" ||
    checkOutPayrollDecisionRaw === "exclude"
      ? checkOutPayrollDecisionRaw
      : null;
  const checkInPayrollDecisionRaw = first(
    raw,
    "check_in_payroll_decision",
    "checkInPayrollDecision",
  ) as string | undefined;
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
      checkOutConfidenceRaw !== undefined
        ? Number(checkOutConfidenceRaw)
        : null,
    check_out_confidence:
      checkOutConfidenceRaw !== undefined
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

function mapLog(raw: RawAttendanceLog): AttendanceLog {
  const userId = first(raw, "user_id", "userId", "staff_id", "staffId") ?? null;
  const branchId =
    first(
      raw,
      "branch_id",
      "branchId",
      "backend_branch_id",
      "backendBranchId",
      "branch_uuid",
      "branchUuid",
    ) ?? null;
  const timestamp = String(
    first(raw, "timestamp", "check_in", "checkIn", "created_at", "createdAt") ??
      "",
  );
  const userName = String(
    first(
      raw,
      "user_name",
      "userName",
      "staff_name",
      "staffName",
      "name",
      "detected_name",
    ) ?? "Unknown",
  );
  const branchName =
    (first(raw, "branch_name", "branchName") as string | undefined) ?? null;

  return {
    ...mapTimingFields(raw),
    id: stableId(raw.id),
    userId: userId as TenantId | null,
    user_id: userId as TenantId | null,
    staffId: userId as TenantId | null,
    staff_id: userId as TenantId | null,
    userName,
    user_name: userName,
    staffName: userName,
    staff_name: userName,
    detectedName: first(raw, "detected_name") as string | undefined,
    confidence: Number(raw.confidence ?? 0),
    source: (raw.source as string | undefined) ?? null,
    timestamp,
    checkIn: (first(raw, "check_in", "checkIn") as string | undefined) ?? null,
    check_in: (first(raw, "check_in", "checkIn") as string | undefined) ?? null,
    checkOut:
      (first(raw, "check_out", "checkOut") as string | undefined) ?? null,
    check_out:
      (first(raw, "check_out", "checkOut") as string | undefined) ?? null,
    status: (raw.status as string | undefined) ?? "PRESENT",
    logDate:
      (first(raw, "log_date", "logDate", "attendance_date") as
        | string
        | undefined) ?? timestamp.slice(0, 10),
    log_date:
      (first(raw, "log_date", "logDate", "attendance_date") as
        | string
        | undefined) ?? timestamp.slice(0, 10),
    branchId: branchId as TenantId | null,
    branch_id: branchId as TenantId | null,
    backendBranchId:
      (first(
        raw,
        "backend_branch_id",
        "backendBranchId",
        "branch_uuid",
        "branchUuid",
      ) as TenantId | undefined) ?? (branchId as TenantId | null),
    backend_branch_id:
      (first(
        raw,
        "backend_branch_id",
        "backendBranchId",
        "branch_uuid",
        "branchUuid",
      ) as TenantId | undefined) ?? (branchId as TenantId | null),
    branchUuid:
      (first(
        raw,
        "branch_uuid",
        "branchUuid",
        "backend_branch_id",
        "backendBranchId",
      ) as TenantId | undefined) ?? null,
    branch_uuid:
      (first(
        raw,
        "branch_uuid",
        "branchUuid",
        "backend_branch_id",
        "backendBranchId",
      ) as TenantId | undefined) ?? null,
    branchName,
    branch_name: branchName,
    department: (raw.department as string | undefined) ?? null,
  };
}

function mapTodayRecord(raw: RawTodayAttendance): TodayAttendanceRecord {
  const log = mapLog(raw);
  const checkIn = log.checkIn ?? log.timestamp ?? null;
  const logDate = String(
    first(raw, "log_date", "logDate", "attendance_date") ??
      String(checkIn ?? "").slice(0, 10),
  );
  return {
    ...log,
    checkIn,
    check_in: checkIn,
    checkOut: log.checkOut ?? null,
    check_out: log.checkOut ?? null,
    status: String(raw.status ?? "PRESENT"),
    logDate,
    log_date: logDate,
    createdAt:
      (first(raw, "created_at", "createdAt") as string | undefined) ?? checkIn,
    created_at:
      (first(raw, "created_at", "createdAt") as string | undefined) ?? checkIn,
  };
}

function rowsFromResponse<T>(
  raw:
    | T[]
    | {
        logs?: T[];
        records?: T[];
        attendance?: T[];
        recent_entries?: T[];
        recentEntries?: T[];
      },
): T[] {
  if (Array.isArray(raw)) return raw;
  return (
    raw.logs ??
    raw.records ??
    raw.attendance ??
    raw.recent_entries ??
    raw.recentEntries ??
    []
  );
}

function mapStats(raw: RawStatsResponse): AttendanceStats {
  const recentRaw = rowsFromResponse<RawAttendanceLog>({
    recent_entries: raw.recent_entries as RawAttendanceLog[] | undefined,
    recentEntries: raw.recentEntries as RawAttendanceLog[] | undefined,
  });
  const recentEntries = recentRaw.map(mapLog);
  const totalUsers = Number(
    first(
      raw,
      "total_users",
      "totalUsers",
      "total_staff",
      "totalStaff",
      "attendance_users",
      "attendanceUsers",
    ) ?? 0,
  );
  const presentToday = Number(
    first(
      raw,
      "present_today",
      "presentToday",
      "unique_users_today",
      "uniqueUsersToday",
      "today_attendance",
      "todayAttendance",
    ) ?? 0,
  );
  const absentToday = Number(
    first(raw, "absent_today", "absentToday") ??
      Math.max(0, totalUsers - presentToday),
  );
  const lateToday = Number(first(raw, "late_today", "lateToday", "late") ?? 0);
  const totalLogs = Number(
    first(raw, "total_logs", "totalLogs", "total_records", "totalRecords") ??
      recentEntries.length,
  );
  const avgConfidence = Number(
    first(raw, "avg_confidence", "avgConfidence", "averageConfidence") ?? 0,
  );
  const enrolledUsers = Number(
    first(raw, "enrolled_users", "enrolledUsers") ?? 0,
  );
  const attendanceUsers = Number(
    first(raw, "attendance_users", "attendanceUsers") ?? totalUsers,
  );
  const todayAttendance = Number(
    first(raw, "today_attendance", "todayAttendance") ?? presentToday,
  );
  const uniqueUsersToday = Number(
    first(raw, "unique_users_today", "uniqueUsersToday") ?? presentToday,
  );

  return {
    totalUsers,
    total_users: totalUsers,
    totalStaff: totalUsers,
    total_staff: totalUsers,
    attendanceUsers,
    attendance_users: attendanceUsers,
    enrolledUsers,
    enrolled_users: enrolledUsers,
    presentToday,
    present_today: presentToday,
    absentToday,
    absent_today: absentToday,
    lateToday,
    late_today: lateToday,
    todayAttendance,
    today_attendance: todayAttendance,
    uniqueUsersToday,
    unique_users_today: uniqueUsersToday,
    totalLogs,
    total_logs: totalLogs,
    avgConfidence,
    avg_confidence: avgConfidence,
    averageConfidence: avgConfidence,
    recentEntries,
    recent_entries: recentEntries,
  };
}

export async function getAttendanceToday(
  params: AttendanceQueryParams = {},
): Promise<TodayAttendanceRecord[]> {
  const raw = await requestJson<
    | RawTodayAttendance[]
    | { records?: RawTodayAttendance[]; attendance?: RawTodayAttendance[] }
  >(appendAttendanceQuery("/attendance/today", params));
  return rowsFromResponse(raw).map(mapTodayRecord);
}

export async function getAttendanceLogs(
  limitOrParams: number | AttendanceQueryParams = 200,
): Promise<AttendanceLog[]> {
  const params =
    typeof limitOrParams === "number"
      ? { limit: limitOrParams }
      : limitOrParams;
  const raw = await requestJson<
    RawAttendanceLog[] | { logs?: RawAttendanceLog[] }
  >(appendAttendanceQuery("/attendance", params));
  return rowsFromResponse(raw).map(mapLog);
}

export async function getAttendanceStats(
  params: AttendanceQueryParams = {},
): Promise<AttendanceStats> {
  const raw = await requestJson<RawStatsResponse>(
    appendAttendanceQuery("/stats", params),
  );
  return mapStats(raw);
}

export async function markAttendanceAbsent(
  userId: number | string,
  params: AttendanceQueryParams = {},
): Promise<void> {
  await requestJson<{ success: boolean }>(
    appendAttendanceQuery("/attendance/mark-absent", params),
    {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    },
  );
}

export interface AttendanceRecordEdit {
  checkIn?: string | null;
  check_in?: string | null;
  checkOut?: string | null;
  check_out?: string | null;
  /** 'on_time' | 'late' | 'early' | 'unscheduled' */
  arrivalStatus?: string | null;
  arrival_status?: string | null;
  notes?: string | null;
}

/**
 * Admin edit of one attendance row (check-in, check-out, arrival/timing
 * classification, notes) from the dashboard table. Only the fields present
 * in `edit` are changed -- see support_db.py's update_client_attendance_record
 * for the exact field contract. Returns the updated row in the same shape
 * as getAttendanceToday/getAttendanceLogs so callers can splice it straight
 * into state without a full refetch, though most callers just reload.
 */
export async function updateAttendanceRecord(
  recordId: number | string,
  edit: AttendanceRecordEdit,
  params: AttendanceQueryParams = {},
): Promise<TodayAttendanceRecord> {
  const raw = await requestJson<
    { record?: RawTodayAttendance } | RawTodayAttendance
  >(
    appendAttendanceQuery(
      `/attendance/${encodeURIComponent(String(recordId))}`,
      params,
    ),
    {
      method: "PATCH",
      body: JSON.stringify(edit),
    },
  );
  const record =
    (raw as { record?: RawTodayAttendance })?.record ??
    (raw as RawTodayAttendance);
  return mapTodayRecord(record);
}

export async function markUserPresent(
  userId: number | string,
  params: AttendanceQueryParams = {},
): Promise<void> {
  const path = `/users/${encodeURIComponent(String(userId))}/mark-present`;
  await requestJson<{ success: boolean }>(appendAttendanceQuery(path, params), {
    method: "POST",
  });
}
