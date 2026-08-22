/**
 * AttendanceView.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Dynamic, scope-aware attendance module.
 *
 * Architecture:
 *   OrgConfigContext.masterData  → configured/master data (branches, bizType)
 *   ModuleContext                → mutable entity data (staff, attendance)
 *   useAttendanceSources()       → single source boundary for this component
 *   useAttendanceBranchSummaries → extracted aggregation hook (shared/testable)
 *
 * Scope:
 *   Route param :branchId → branch-scoped view (branch admin).
 *   No param               → global view (org admin, all branches visible).
 *
 * Backend migration:
 *   - hydrate masterData from OrgConfigContext API
 *   - hydrate staff/attendance stores from ModuleContext API
 *  *   - keep this UI almost unchanged
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Swal from "sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";
import { toastSuccess, toastError, toastInfo } from "../../utils/notifications";
import { useNavigate, useParams } from "react-router-dom";
import { listStaffPage } from "../StaffManagement/api/staffApi";
import {
  getTodayAttendance as getTodayNodeAttendance,
  type AttendanceRecord as NodeAttendanceRecord,
} from "./api/attendanceEventsApi";
import {
  markAttendanceAbsent,
  updateAttendanceRecord,
  type AttendanceRecordEdit,
} from "./api/attendanceApi";
import { useOrg } from "../../contexts/OrgConfigContext";
import { useModule } from "../../contexts/ModuleContext";
import {
  useAttendanceBranchSummaries,
  type BranchAttendanceSummary,
} from "../../hooks/useAttendanceBranchSummaries";

import { useDateFilter, parseLocalDate } from "../../hooks/useDateFilter";
import DateFilterBar from "../../components/ui/DateFilterBar";
import DynamicFilterToolbar, {
  type DynamicFilterSection,
} from "../../components/ui/DynamicFilterToolbar";
import ExportButton from "../../components/ui/ExportButton";
import type { ExportExcelColumn } from "../../components/ui/ExportExcelButton";
import RefreshButton from "../../components/ui/RefreshButton";
import { FastPagination } from "../../components/common/FastPagination";
import { useStatefulPagination } from "../LeaveManagement/shared/hooks/usePagination";
import PeopleTypeSelector, {
  type PeopleTypeOption,
} from "../../components/ui/PeopleTypeSelector";
import {
  resolveTemplateRenderingModel,
  readColumnValue,
  type TemplateColumn,
} from "../../utils/templateColumns";
import { resolveModulePeopleTypes } from "../../utils/templateRendering";

import {
  DAY_STATUS_LABELS,
  derivePayrollDecisionBadge,
  resolvePayrollDecision,
} from "./utils/dayStatusLabels";

import {
  Clock,
  CheckCircle,
  UserX,
  Users,
  AlertCircle,
  MapPin,
  ArrowUpRight,
  ClipboardCheck,
  Pencil,
  Check,
  X,
} from "lucide-react";

import {
  resolveBranchFromList,
  getBackendBranchId,
  getUiBranchId,
  cleanId,
} from "../../utils/tenantScope";

// ─── Design Tokens ───────────────────────────────────────────────────

const T = {
  teal600: "#0d9488",
  teal50: "#f0fdfa",
  teal100: "#ccfbf1",
  navy700: "#134471",
  slate50: "#f8fafc",
  slate100: "#f1f5f9",
  slate200: "#e2e8f0",
  green600: "#16a34a",
  green100: "#f0fdf4",
  red600: "#e11d48",
  red100: "#fff1f2",
  amber600: "#d97706",
  amber100: "#fffbeb",
  bgPage: "#f5f6fa",
  bgCard: "#ffffff",
  border: "#e2e8f0",
  textHeading: "#1a699f",
  textBody: "#334155",
  textMuted: "#64748b",
  textLight: "#94a3b8",
  shadow: "0 1px 3px rgba(15,45,74,0.07),0 1px 2px rgba(15,45,74,0.04)",
} as const;

// ─── Dynamic label helpers ───────────────────────────────────────────────────

const FALLBACK_ENTITY_LABELS: Record<string, string> = {
  student: "Students",
  staff: "Staff",
  employee: "Employees",
  worker: "Workers",
  personnel: "Personnel",
};

function normalizeKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function readPeopleType(masterData: unknown): string {
  const record = masterData as Record<string, unknown>;
  const verticalConfig = (record.verticalConfig ??
    record.vertical_config ??
    {}) as Record<string, unknown>;
  const attendancePeopleTypes =
    record.attendancePeopleTypes ??
    record.attendance_people_types ??
    verticalConfig.attendance_people_types ??
    verticalConfig.attendancePeopleTypes;

  if (
    Array.isArray(attendancePeopleTypes) &&
    attendancePeopleTypes.length === 1
  ) {
    return normalizeKey(attendancePeopleTypes[0]) || "staff";
  }

  return (
    normalizeKey(record.primaryPeopleType) ||
    normalizeKey(record.primary_people_type) ||
    normalizeKey(verticalConfig.primary_people_type) ||
    "staff"
  );
}

function readEntityLabel(masterData: unknown, peopleType: string): string {
  const record = masterData as Record<string, unknown>;
  const verticalConfig = (record.verticalConfig ??
    record.vertical_config ??
    {}) as Record<string, unknown>;
  const labels = (verticalConfig.labels ?? record.labels ?? {}) as Record<
    string,
    unknown
  >;
  const pluralKey = `${peopleType}_plural`;
  const label =
    labels[pluralKey] ??
    labels[peopleType] ??
    FALLBACK_ENTITY_LABELS[peopleType];
  return String(label ?? "Staff");
}

// ─── Types ────────────────────────────────────────────────────────────────────

type BranchLike = {
  id: number;
  name: string;
  city?: string;
  timezone?: string;
  backendBranchId?: string | null;
};
type AttendanceStatusFilter = "all" | "present" | "absent" | "late" | "onTime";

interface AttendanceStaff {
  id: string | number;
  name: string;
  email?: string;
  phone?: string;
  branchId?: number;
  department?: string;
  designation?: string;
  role?: string;
  jobTitle?: string;
  empId?: string;
  userId?: string | number;
  shiftStart?: string;
  shiftEnd?: string;
  [key: string]: unknown;
}

interface ApiAttendance {
  [key: string]: unknown;
  id?: string | number;
  user_id?: string | number;
  user_name: string;
  confidence?: number;
  source?: string;
  date?: string;
  time?: string | null;
  outTime?: string | null;
  check_in?: string | null;
  check_out?: string | null;
  workDuration?: string | null;
  status: string;
  arrival_status?: string;
  /** Real, timing-aware classification from resolve_check_in_status /
   *  resolve_check_out_status — 'on_time' | 'late' | 'early' | 'unscheduled'.
   *  This is what actually drives the Late badge; `status` stays a
   *  presence flag ('PRESENT'/'ABSENT') and never carries lateness. */
  check_in_status?: string | null;
  check_out_status?: string | null;
  /** Day-level outcome — 'present' | 'half_day' | 'short_leave' | 'late' |
   *  'overtime'. Set by both the local-node hold-resolution actions and the
   *  mobile/office-staff exceptions flow, so unlike arrival_status this is
   *  reliable across both capture channels. See deriveDayStatusBadge. */
  day_status?: string | null;
  dayStatus?: string | null;
  /** 'include' | 'exclude' | null — admin payroll decision for an already-
   *  classified local-node row. Null for mobile-sourced rows today (that
   *  path doesn't write this field yet) and for ordinary present days
   *  (nothing to decide). See derivePayrollDecisionBadge. */
  check_out_payroll_decision?: string | null;
  checkOutPayrollDecision?: string | null;
  /** 'include' | 'exclude' | null — same admin decision as above, but for
   *  a day_status='late' row specifically. set_local_node_payroll_decision
   *  writes 'late' decisions here instead of check_out_payroll_decision —
   *  see resolvePayrollDecision (dayStatusLabels.ts), which is the only
   *  place that should read this alongside check_out_payroll_decision. */
  check_in_payroll_decision?: string | null;
  checkInPayrollDecision?: string | null;
  /** Operator-facing context, currently only ever set for a check-in
   *  confirmed after its shift window closed but originally sighted
   *  earlier — see attendanceApi.ts's AttendanceTimingFields. */
  notes?: string | null;
  /** local_node | cloud | mobile_app | null — see attendanceApi.ts's
   *  AttendanceTimingFields for the shared definition/migration note. */
  capture_channel?: "local_node" | "cloud" | "mobile_app" | null;
  captureChannel?: "local_node" | "cloud" | "mobile_app" | null;
  branchId?: number;
  branch_id?: number | string;
  staffId?: string | number;
  staffName?: string;
}

/**
 * Resolves a UI branch id (1..N, local to this dashboard session) to the
 * real Supabase branch UUID for tenant-scoped API calls. Delegates to the
 * same resolver useStaffRecords/useAttendanceData use, so staff and
 * attendance can never diverge on branch resolution again.
 */
function backendBranchIdForUi(
  branches: BranchLike[],
  uiBranchId?: number | null,
): string | number | null {
  if (!uiBranchId) return null;
  const branch = resolveBranchFromList(branches, uiBranchId);
  return getBackendBranchId(branch) ?? branch?.id ?? null;
}

function resolveUiBranchIdFromBackend(
  branches: BranchLike[],
  rawBranchId: number | string | null | undefined,
): number | undefined {
  const raw = String(rawBranchId ?? "").trim();
  if (!raw) return undefined;

  const branch = resolveBranchFromList(branches, rawBranchId);
  const uiId = getUiBranchId(branch);
  if (uiId !== null) return uiId;

  // Preserve original pass-through behavior for a raw numeric id that
  // doesn't match any loaded branch yet (e.g. route param before
  // masterData.branches has hydrated).
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function readRecordValue(row: unknown, ...keys: string[]): unknown {
  if (!row || typeof row !== "object") return undefined;
  const record = row as Record<string, unknown>;

  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }

  return undefined;
}

function readNullableText(row: unknown, ...keys: string[]): string | null {
  const value = readRecordValue(row, ...keys);
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function readIdValue(
  row: unknown,
  ...keys: string[]
): string | number | undefined {
  const value = readRecordValue(row, ...keys);

  if (typeof value === "string") {
    const text = value.trim();
    return text || undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return undefined;
}

function normalizeDateString(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const dateMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return dateMatch[1];

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toISOString().slice(0, 10);
}

function nodeAttendanceToView(
  row: NodeAttendanceRecord,
  branches: BranchLike[],
): ApiAttendance {
  // `row` is NOT a raw, unshaped backend row -- attendanceEventsApi.ts's
  // getTodayAttendance is a thin pass-through over attendanceApi.ts's own
  // getAttendanceToday, which already runs every record through
  // mapLog/mapTimingFields/mapTodayRecord. staffId, dayStatus,
  // checkOutPayrollDecision, backendBranchId/branchUuid, checkOutHoldReason,
  // workDuration -- all of it is already correctly typed and populated on
  // `row` by the time it reaches this function.
  //
  // Spreading it (rather than hand-picking each field via readNullableText
  // against a guessed list of possible raw key names, as this function used
  // to) means any field the canonical mapper adds in the future flows
  // through automatically. The previous approach was solving a "raw row"
  // problem that doesn't exist at this call site -- it just silently
  // dropped whatever field it forgot to re-list by hand. day_status/
  // short_leave was the field that bit us; there was nothing structurally
  // stopping the next one.
  const staffId = row.staffId ?? row.staff_id ?? row.userId ?? undefined;
  const userId = row.userId ?? row.user_id ?? staffId ?? undefined;
  const name =
    row.userName ||
    row.user_name ||
    row.staffName ||
    row.staff_name ||
    String(staffId ?? userId ?? "Unknown");

  // The real Supabase branch UUID -- mapLog preserves this distinctly from
  // `branchId`/`branch_id` (which, on an already-mapped record, is already
  // a UI ordinal in practice). Resolving off the UUID here is the
  // unambiguous source of truth rather than assuming branchId's shape.
  const backendId =
    row.backendBranchId ??
    row.backend_branch_id ??
    row.branchUuid ??
    row.branch_uuid ??
    row.branchId ??
    row.branch_id ??
    null;
  const uiBranchId = resolveUiBranchIdFromBackend(
    branches,
    backendId as string | number | null,
  );

  return {
    ...row,
    id: row.id,
    user_id: userId,
    user_name: name,
    staffId,
    staffName: name,
    confidence: Number.isFinite(row.confidence) ? row.confidence : 0,
    source: row.source ?? "camera",
    capture_channel: (row.capture_channel ??
      row.captureChannel ??
      "local_node") as "local_node" | "cloud" | "mobile_app",
    date: row.logDate ?? row.log_date ?? String(row.checkIn ?? "").slice(0, 10),
    time: row.checkIn ?? row.check_in ?? null,
    check_in: row.checkIn ?? row.check_in ?? null,
    check_out: row.checkOut ?? row.check_out ?? null,
    outTime: row.checkOut ?? row.check_out ?? null,
    status: row.status ?? "PRESENT",
    // Backward-compatible display label, driven by the real timing
    // classification. 'unscheduled' (no shift/capture-settings/override
    // configured) intentionally reads as On-Time rather than Late --
    // absence of a schedule isn't lateness.
    arrival_status: deriveArrivalStatus({
      check_in_status: row.checkInStatus ?? row.check_in_status ?? undefined,
      status: row.status ?? "PRESENT",
    }),
    branch_id: uiBranchId,
    branchId: uiBranchId,
  };
}

interface AttendanceExportRow {
  code: string;
  name: string;
  designation: string;
  branch: string;
  department: string;
  arrival: string;
  month: number;
  year: number;
  totalDays: number;
  present: number;
  onTime: number;
  late: number;
  leaves: number;
  absents: number;
  offDays: number;
  restDays: number;
  attendanceRate: string;
  firstCheckIn: string;
  lastCheckOut: string;
  totalWorkDuration: string;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const KPICard: React.FC<{
  label: string;
  value: string | number;
  sub: string;
  accent?: boolean;
}> = ({ label, value, sub, accent }) => (
  <div
    className={`rounded-2xl p-5 border shadow-sm ${
      accent
        ? "bg-teal-700 text-white border-teal-600"
        : "bg-white border-gray-100"
    }`}
  >
    <p
      className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
        accent ? "text-teal-200" : "text-gray-400"
      }`}
    >
      {label}
    </p>
    <p
      className={`text-3xl font-bold ${accent ? "text-white" : "text-gray-900"}`}
    >
      {value}
    </p>
    <p className={`text-xs mt-1 ${accent ? "text-teal-300" : "text-gray-400"}`}>
      {sub}
    </p>
  </div>
);

const BranchCard: React.FC<{
  branch: BranchAttendanceSummary;
  isActive: boolean;
  onSelect: () => void;
  onView: () => void;
  entityLabel: string;
}> = ({ branch, isActive, onSelect, onView, entityLabel }) => (
  <div
    onClick={onSelect}
    className={`shrink-0 w-52 rounded-2xl p-4 border cursor-pointer transition-all ${
      isActive
        ? "bg-teal-700 border-teal-600 text-white"
        : "bg-white border-gray-100 hover:border-teal-300"
    }`}
  >
    <div className="flex items-start justify-between mb-3">
      <div>
        <p
          className={`text-xs font-bold truncate max-w-30 ${
            isActive ? "text-teal-200" : "text-gray-400"
          }`}
        >
          {branch.branchName}
        </p>
        {branch.city && (
          <p
            className={`text-[10px] mt-0.5 flex items-center gap-0.5 ${
              isActive ? "text-teal-300" : "text-gray-400"
            }`}
          >
            <MapPin className="w-2.5 h-2.5" />
            {branch.city}
          </p>
        )}
      </div>
    </div>
    <p
      className={`text-2xl font-black mb-1 ${
        isActive ? "text-white" : "text-gray-900"
      }`}
    >
      {branch.attendanceRate}%
    </p>
    <p
      className={`text-[10px] mb-2 ${
        isActive ? "text-teal-300" : "text-gray-400"
      }`}
    >
      {branch.primaryCount.toLocaleString()} {entityLabel}
    </p>
    <div
      className={`h-1 rounded-full mb-3 ${
        isActive ? "bg-teal-600" : "bg-gray-100"
      }`}
    >
      <div
        className={`h-full rounded-full ${
          isActive ? "bg-teal-200" : "bg-teal-500"
        }`}
        style={{ width: `${branch.attendanceRate}%`, transition: "width .5s" }}
      />
    </div>
    <button
      onClick={(e) => {
        e.stopPropagation();
        onView();
      }}
      className={`flex items-center gap-1 text-[10px] font-semibold transition-colors ${
        isActive
          ? "text-teal-200 hover:text-white"
          : "text-teal-600 hover:text-teal-700"
      }`}
    >
      View Branch <ArrowUpRight className="w-3 h-3" />
    </button>
  </div>
);

// ─── Safe helpers ─────────────────────────────────────────────────────────────

const countByName = <T,>(items: T[], getName: (item: T) => unknown) => {
  const counts = new Map<string, number>();
  items.forEach((item) => {
    const name = String(getName(item) ?? "Unassigned").trim() || "Unassigned";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

const getStaffCode = (staffMember: AttendanceStaff): string => {
  const value = readRecordValue(
    staffMember,
    "studentId",
    "student_id",
    "rollNo",
    "roll_no",
    "admissionNo",
    "admission_no",
    "employeeId",
    "employee_id",
    "personCode",
    "person_code",
    "empCode",
    "employeeCode",
    "code",
    "empId",
  );

  const text = String(value ?? "").trim();
  return text || "—";
};

const getStaffDesignation = (staffMember: AttendanceStaff): string =>
  String(
    (staffMember as any).designation ??
      (staffMember as any).position ??
      (staffMember as any).role ??
      (staffMember as any).jobTitle ??
      "-",
  );

const getAttendanceGroupValue = (staffMember: AttendanceStaff): string =>
  String(
    (staffMember as any).className ??
      (staffMember as any).class_name ??
      (staffMember as any).groupName ??
      (staffMember as any).group_name ??
      (staffMember as any).department ??
      (staffMember as any).dept ??
      "Unassigned",
  );

const getAttendanceSubgroupValue = (staffMember: AttendanceStaff): string =>
  String(
    (staffMember as any).sectionName ??
      (staffMember as any).section_name ??
      (staffMember as any).subgroupName ??
      (staffMember as any).subgroup_name ??
      (staffMember as any).section ??
      (staffMember as any).designation ??
      (staffMember as any).position ??
      (staffMember as any).role ??
      "Unassigned",
  );

type AttendanceTemplateColumn = TemplateColumn<Record<string, unknown>>;

type AttendanceCellContext = {
  member: AttendanceStaff;
  record?: {
    id?: string | number;
    inTime?: string;
    outTime?: string;
    workDuration?: string;
    status?: string;
    arrivalStatus?: string;
    notes?: string | null;
    isPresent?: boolean;
    isLate?: boolean;
  };
  getBranchName: (branchId: number) => string;
  /**
   * Required, not optional. This used to be `branches?: BranchLike[]`, and
   * one call site (the generic/fallback cell renderer) silently omitted it.
   * getBranchTimezone() then returned undefined and formatTimeForDisplay()
   * defaulted to "UTC" — check-out timestamps rendered hours off from the
   * branch's actual local time with no error, no warning, nothing.
   * Making this required turns that class of bug into a TS compile error
   * instead of a silent runtime one.
   */
  branches: BranchLike[];
};

/**
 * Uncommitted values for one row's edit session. Populated from the row's
 * current record when Edit is clicked, mutated locally as the admin types,
 * and only sent to the backend as a single combined PATCH when Save is
 * clicked -- see saveRowEdit. checkIn/checkOut are held as datetime-local
 * strings (branch wall-clock time, matching toDatetimeLocalValue) since
 * that's the native input format; they're converted back to UTC ISO via
 * fromDatetimeLocalValue only at save time.
 */
interface AttendanceRowDraft {
  checkIn: string;
  checkOut: string;
  arrivalStatus: string;
  notes: string;
}

/**
 * Renders a stored UTC/ISO timestamp in a specific IANA timezone.
 *
 * `timeZone` is intentionally required (no `?`, no default param) — see the
 * note on AttendanceCellContext.branches. A missing timezone must fail loud
 * at the call site, not be quietly papered over here with "UTC". The one
 * legitimate "UTC" case — a branch that truly has no timezone configured —
 * is resolved by getBranchTimezone()/the backend's own default, not by this
 * function guessing.
 */
/**
 * Offset (in minutes) between a given IANA timezone's wall-clock reading and
 * true UTC, at a specific instant. Positive means the zone is ahead of UTC
 * (e.g. +300 for UTC+5). Computed by asking Intl what the wall-clock time
 * would read in that zone for this instant, then diffing against the
 * instant itself -- this is the standard technique zoned-time libraries use
 * since JS has no native "getTimezoneOffset(zone, date)".
 */
function getTimezoneOffsetMinutes(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

/**
 * Converts an ISO timestamp to the value a `<input type="datetime-local">`
 * expects ("YYYY-MM-DDTHH:mm"), rendered as wall-clock time in the given
 * BRANCH timezone -- not the admin's browser timezone. This matches how
 * formatTimeForDisplay already shows check-in/check-out elsewhere in this
 * table, so the value shown in edit mode is the same clock time the admin
 * was just looking at, not a silently different one.
 */
function toDatetimeLocalValue(
  value: string | null | undefined,
  timeZone: string,
): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf
    .formatToParts(parsed)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * Inverse of toDatetimeLocalValue -- takes the "YYYY-MM-DDTHH:mm" wall-clock
 * value the admin typed (meant as a time IN THE BRANCH'S TIMEZONE) and
 * returns the true UTC ISO instant to send to the backend. "" (cleared
 * input) becomes null so a checkout can be explicitly unset rather than
 * sent as an invalid date.
 *
 * One offset lookup is enough for virtually every edit (branch timezones
 * changing UTC offset mid-edit, i.e. a DST transition falling exactly in
 * the minute being edited, is not worth a second iteration here).
 */
function fromDatetimeLocalValue(
  value: string,
  timeZone: string,
): string | null {
  if (!value) return null;
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return null;
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  if ([year, month, day, hour, minute].some((n) => Number.isNaN(n)))
    return null;

  // First guess: treat the typed wall-clock numbers as if they were UTC,
  // then find out how far the branch's timezone actually sits from UTC at
  // that moment, and correct for it.
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMinutes = getTimezoneOffsetMinutes(
    timeZone,
    new Date(guessUtcMs),
  );
  const utcMs = guessUtcMs - offsetMinutes * 60_000;
  const result = new Date(utcMs);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}

function formatTimeForDisplay(
  value: string | null | undefined,
  timeZone: string,
): string {
  if (!value) return "—";

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);

  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).format(parsed);
  } catch {
    // Defends only against a genuinely invalid IANA name reaching here
    // (e.g. stale frontend build); a missing/blank value is already
    // handled by getBranchTimezone() below, never by this catch.
    return String(value);
  }
}

/**
 * "UTC" here is not a display fallback (that bug is fixed — see
 * AttendanceCellContext.branches) — it mirrors _DEFAULT_TZ in
 * support_db_attendance_gate.py / the 'UTC' default in
 * _validate_branch_timezone, for a branch row whose `timezone` column is
 * genuinely unset in Supabase. Keeping this single default in one place
 * means "no timezone configured" renders identically to how the backend
 * itself would classify that event, instead of two independently-guessed
 * fallbacks silently drifting apart.
 */
const FALLBACK_TIMEZONE = "UTC";

/**
 * Duration is derived entirely on the client from inTime/outTime — neither
 * app.py nor support_db.py ever compute or persist a work_duration value
 * (checked: no such column/field exists anywhere in the attendance write
 * path), so a record's backend-supplied `workDuration` is always empty.
 * Previously that meant the Duration column showed "Counting..." forever,
 * even hours after checkout, because nothing ever replaced the fallback
 * string. This is the single source of truth for that calculation — both
 * the Daily Attendance table (attendanceColumnText) and the monthly rollup
 * (dateRecords → totalWorkDuration) read the same value.
 *
 * Returns null (not "Counting...") when there is no checkout yet, so the
 * caller decides the in-progress copy; null is also returned for a missing/
 * invalid checkIn or a checkOut that is not after checkIn (defensive against
 * clock skew or bad data — never render a negative duration).
 */
function isTimeOnly(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim();
  return /^\\d{1,2}:\\d{2}(?::\\d{2})?$/.test(text);
}

function parseAttendanceTimestamp(
  value: string | null | undefined,
): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = isTimeOnly(raw)
    ? `1970-01-01T${raw}`
    : raw.replace(/ /g, "T");
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function calculateWorkDuration(
  checkIn: string | null | undefined,
  checkOut: string | null | undefined,
): string | null {
  if (!checkIn || !checkOut) return null;

  const start = parseAttendanceTimestamp(checkIn);
  const end = parseAttendanceTimestamp(checkOut);
  if (!start || !end) return null;

  let diffMs = end.getTime() - start.getTime();
  if (diffMs <= 0 && isTimeOnly(checkIn) && isTimeOnly(checkOut)) {
    diffMs += 24 * 60 * 60 * 1000;
  }
  if (diffMs <= 0) return null;

  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes <= 0) return null;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function getBranchTimezone(branchId: number, branches: BranchLike[]): string {
  return (
    branches.find((branch) => Number(branch.id) === Number(branchId))
      ?.timezone || FALLBACK_TIMEZONE
  );
}

function attendanceColumnText(
  column: AttendanceTemplateColumn,
  context: AttendanceCellContext,
): string {
  const { member, record, getBranchName } = context;
  const branchId = Number((member as any).branchId);
  const branchTimezone = getBranchTimezone(branchId, context.branches ?? []);

  if (column.key === "code") return getStaffCode(member);
  if (column.key === "name") return String(member.name ?? "—");
  if (column.key === "branch") return getBranchName(branchId);
  if (column.key === "class" || column.key === "department") {
    return getAttendanceGroupValue(member) || "—";
  }
  if (column.key === "section" || column.key === "designation") {
    return getAttendanceSubgroupValue(member) || "—";
  }
  if (column.key === "checkIn")
    return formatTimeForDisplay(record?.inTime, branchTimezone);
  if (column.key === "checkOut")
    return formatTimeForDisplay(record?.outTime, branchTimezone);
  if (column.key === "duration") {
    if (!record?.isPresent) return "—";
    return (
      calculateWorkDuration(record?.inTime, record?.outTime) ??
      record?.workDuration ??
      "Counting..."
    );
  }
  if (column.key === "arrival") return record?.arrivalStatus || "—";
  if (column.key === "notes") return record?.notes || "—";

  const value = readColumnValue(member as Record<string, unknown>, column);
  return value === undefined || value === null || value === ""
    ? "—"
    : String(value);
}

function primitiveCellValue(
  row: Record<string, unknown>,
  key: string,
): string | number | boolean | null | undefined {
  const value = row[key];

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value;
  }

  return String(value);
}

function attendanceExportColumnValue(
  row: Record<string, unknown>,
  column: AttendanceTemplateColumn,
): string | number | boolean | null | undefined {
  if (column.key === "class" || column.key === "department")
    return primitiveCellValue(row, "department");
  if (column.key === "section" || column.key === "designation")
    return primitiveCellValue(row, "designation");
  if (column.key === "branch") return primitiveCellValue(row, "branch");
  if (column.key === "checkIn") return primitiveCellValue(row, "firstCheckIn");
  if (column.key === "checkOut") return primitiveCellValue(row, "lastCheckOut");
  if (column.key === "duration")
    return primitiveCellValue(row, "totalWorkDuration");
  if (column.key === "arrival") return primitiveCellValue(row, "arrival");
  return readColumnValue(row, column);
}

function buildAttendancePeopleModel(
  config: Record<string, unknown>,
  selectedPeopleType?: string | null,
  restrictToPeopleTypes?: string[],
) {
  const model = resolveTemplateRenderingModel(
    config,
    selectedPeopleType,
    restrictToPeopleTypes,
  );
  return {
    ...model,
    peopleType: model.selectedPeopleType,
    personPlural: model.labels.plural,
    personSingular: model.labels.singular,
    personCodeLabel: model.labels.code,
    branchLabel: model.labels.branch,
    groupLabel: model.labels.group,
    subgroupLabel: model.isStudentScope
      ? model.labels.subGroup
      : model.labels.designation,
    groupFilterAllLabel: `All ${model.labels.groupPlural}`,
    subgroupFilterAllLabel: model.isStudentScope
      ? `All ${model.labels.subGroupPlural}`
      : `All ${model.labels.designationPlural}`,
    statsTotalLabel: `Total ${model.labels.plural}`,
    searchPlaceholder:
      model.filters.find((filter) => filter.key === "search")?.placeholder ??
      `Search ${model.labels.singular.toLowerCase()} name...`,
  };
}

function resolveStaffUiBranchId(
  member: Record<string, unknown>,
  branches: BranchLike[],
): number {
  const directUiBranchId = readIdValue(
    member,
    "branch_ui_id",
    "branchUiId",
    "ui_branch_id",
    "uiBranchId",
  );

  if (directUiBranchId !== undefined) {
    const numeric = Number(directUiBranchId);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }

  const rawBranchId = readIdValue(
    member,
    "branchId",
    "branch_id",
    "backend_branch_id",
    "backendBranchId",
    "branch_uuid",
    "branchUuid",
    "branch",
  );

  return resolveUiBranchIdFromBackend(branches, rawBranchId) ?? 0;
}

const normalizeStaffForAttendance = (
  member: any,
  branches: BranchLike[] = [],
): AttendanceStaff => {
  const record =
    member && typeof member === "object"
      ? (member as Record<string, unknown>)
      : {};
  const backendId = readIdValue(
    record,
    "id",
    "userId",
    "user_id",
    "staffId",
    "staff_id",
  );
  const externalCode = getStaffCode(record as AttendanceStaff);
  const resolvedBranchId = resolveStaffUiBranchId(record, branches);
  const groupValue = String(
    member.className ??
      member.class_name ??
      member.groupName ??
      member.group_name ??
      member.department ??
      member.dept ??
      "",
  );
  const subgroupValue = String(
    member.sectionName ??
      member.section_name ??
      member.subGroupName ??
      member.sub_group_name ??
      member.section ??
      member.designation ??
      member.position ??
      member.role ??
      "",
  );

  return {
    ...member,
    id: String(backendId ?? externalCode ?? ""),
    employeeId: externalCode,
    studentId:
      readNullableText(record, "studentId", "student_id") ?? externalCode,
    rollNo: readNullableText(record, "rollNo", "roll_no") ?? undefined,
    code: externalCode,
    name: String(
      member.name ?? member.staffName ?? member.fullName ?? "Unknown",
    ),
    branchId: resolvedBranchId,
    branchName: String(member.branchName ?? member.branch_name ?? ""),
    department: groupValue || "Unassigned",
    className: groupValue,
    sectionName: subgroupValue,
    peopleType: String(
      member.peopleType ??
        member.people_type ??
        member.personType ??
        member.person_type ??
        "staff",
    ),
    role:
      subgroupValue ||
      String(member.role ?? member.position ?? member.designation ?? "Staff"),
    designation:
      subgroupValue ||
      String(
        member.designation ??
          member.position ??
          member.role ??
          member.jobTitle ??
          "Staff",
      ),
    jobTitle: member.jobTitle ?? member.position ?? member.designation,
    empId: externalCode,
    userId:
      member.userId ??
      member.user_id ??
      member.id ??
      member.staffId ??
      member.staff_id,
    shiftStart: String(
      member.shiftStart ?? member.shift_start ?? member.duty_start ?? "09:00",
    ),
    shiftEnd: String(
      member.shiftEnd ?? member.shift_end ?? member.duty_end ?? "17:00",
    ),
  };
};

/**
 * [Fix-5] normalizeApiStaffForAttendance has been removed.
 *
 * It was: `(member: ApiUser) => normalizeStaffForAttendance(member as any)`
 * — a zero-value wrapper that only obscured what was happening. All callers
 * now use normalizeStaffForAttendance directly. The cast is at the call site
 * (apiStaff.map(normalizeStaffForAttendance)) where it is visible and honest.
 */

/**
 * Derives the "Late" / "On-Time" display label from the real, timing-aware
 * classification (check_in_status) when available, falling back to the old
 * status-literal guess only for rows that predate the timing engine.
 * Extracted to its own function (rather than inlined as a nested ternary)
 * to avoid mixing `??` with `?:` — that combination is easy to get wrong,
 * since `??` binds tighter than `?:` and silently produces the wrong value.
 */
function deriveArrivalStatus(record: {
  arrival_status?: string;
  arrivalStatus?: string;
  check_in_status?: string | null;
  checkInStatus?: string | null;
  status?: string;
}): string | undefined {
  if (record.arrival_status) return record.arrival_status;
  if (record.arrivalStatus) return record.arrivalStatus;

  const timingStatus = record.check_in_status ?? record.checkInStatus;
  if (timingStatus) return timingStatus === "late" ? "Late" : "On-Time";

  const legacyStatus = String(record.status ?? "").toLowerCase();
  if (legacyStatus === "late") return "Late";
  if (legacyStatus === "present") return "On-Time";
  return undefined;
}

const TIMING_STATUS_LABELS: Record<
  "on_time" | "late",
  { label: string; className: string }
> = {
  on_time: {
    label: "On Time",
    className: "bg-teal-50 text-teal-700 border-teal-100",
  },
  late: {
    label: "Late",
    className: "bg-orange-50 text-orange-600 border-orange-100",
  },
};

/**
 * Unified Day Status badge for a row, sourced from two different backend
 * fields depending on which pipeline wrote it:
 *  - day_status ('half_day' | 'short_leave' | 'late' | 'overtime') — an
 *    explicit operator classification, from either the local-node hold
 *    resolution actions or resolve_attendance_exception. Always wins when
 *    present, since it's a deliberate decision, not a computed guess.
 *  - check_in_status ('on_time' | 'late' | 'early' | 'unscheduled') — the
 *    timing-engine classification, used as a fallback for the (majority)
 *    case of an ordinary day with no operator override.
 * A row that's absent for the day has neither and returns null; the caller
 * renders the same "—" every other empty cell in this table uses.
 */
function deriveDayStatusBadge(record: {
  isPresent?: boolean;
  dayStatus?: string | null;
  checkInStatus?: string | null;
}): { label: string; className: string } | null {
  if (!record.isPresent) return null;

  const dayStatus = (record.dayStatus ?? "").toLowerCase();
  if (dayStatus && dayStatus !== "present") {
    const known =
      DAY_STATUS_LABELS[dayStatus as keyof typeof DAY_STATUS_LABELS];
    if (known) return known;
  }

  const timingStatus = (record.checkInStatus ?? "on_time").toLowerCase();
  return (
    TIMING_STATUS_LABELS[timingStatus as keyof typeof TIMING_STATUS_LABELS] ??
    TIMING_STATUS_LABELS.on_time
  );
}

/**
 * Display label + badge color for the capture_channel column. Kept as a
 * plain lookup (not a switch) so an unrecognized/future value falls
 * through to the same "—" the rest of this table already uses for
 * missing data, rather than throwing or rendering "undefined".
 */
const CAPTURE_CHANNEL_LABELS: Record<
  "local_node" | "cloud" | "mobile_app",
  { label: string; className: string }
> = {
  local_node: {
    label: "Local Node",
    className: "bg-indigo-50 text-indigo-600 border-indigo-100",
  },
  cloud: {
    label: "Cloud",
    className: "bg-sky-50 text-sky-600 border-sky-100",
  },
  mobile_app: {
    label: "Mobile App",
    className: "bg-teal-50 text-teal-700 border-teal-100",
  },
};

function captureChannelBadge(
  value: string | null | undefined,
): { label: string; className: string } | null {
  if (!value) return null;
  return (
    CAPTURE_CHANNEL_LABELS[value as keyof typeof CAPTURE_CHANNEL_LABELS] ?? null
  );
}

const normalizeAttendanceForView = (
  record: any,
  branches: BranchLike[] = [],
): ApiAttendance => ({
  ...record,
  id: record.id ?? record.attendance_id ?? record.log_id,
  user_id:
    record.user_id ??
    record.userId ??
    record.staff_id ??
    record.staffId ??
    record.id,
  user_name: String(
    record.user_name ??
      record.staffName ??
      record.name ??
      record.fullName ??
      "",
  ),
  date: normalizeDateString(
    record.date ??
      record.attendanceDate ??
      record.logDate ??
      record.log_date ??
      record.created_at?.slice?.(0, 10) ??
      record.checkIn ??
      record.check_in ??
      record.time ??
      record.check_out ??
      record.outTime ??
      record.checkOut,
  ),
  time:
    record.time ??
    record.inTime ??
    record.check_in ??
    record.created_at ??
    null,
  outTime: record.outTime ?? record.check_out ?? null,
  check_in: record.check_in ?? record.inTime ?? record.time ?? null,
  check_out: record.check_out ?? record.outTime ?? null,
  workDuration: record.workDuration ?? record.work_duration ?? null,
  status: String(record.status || "").toUpperCase(),
  check_in_status: record.check_in_status ?? record.checkInStatus ?? null,
  check_out_status: record.check_out_status ?? record.checkOutStatus ?? null,
  notes: record.notes ?? null,
  capture_channel: record.capture_channel ?? record.captureChannel ?? null,
  day_status: record.day_status ?? record.dayStatus ?? null,
  dayStatus: record.day_status ?? record.dayStatus ?? null,
  check_out_payroll_decision:
    record.check_out_payroll_decision ?? record.checkOutPayrollDecision ?? null,
  checkOutPayrollDecision:
    record.check_out_payroll_decision ?? record.checkOutPayrollDecision ?? null,
  // Same normalization as check_out_payroll_decision above, for the
  // check-IN-side decision column ('late' rows only -- see
  // resolvePayrollDecision in dayStatusLabels.ts). Without this, a record
  // shape that only carries one casing variant would silently lose the
  // decision the same way check_out_payroll_decision did before this
  // pairing existed for it.
  check_in_payroll_decision:
    record.check_in_payroll_decision ?? record.checkInPayrollDecision ?? null,
  checkInPayrollDecision:
    record.check_in_payroll_decision ?? record.checkInPayrollDecision ?? null,
  arrival_status: deriveArrivalStatus(record),
  branchId:
    resolveUiBranchIdFromBackend(
      branches,
      record.branchId ??
        record.branch_id ??
        record.backend_branch_id ??
        record.backendBranchId ??
        record.branch_uuid ??
        record.branchUuid,
    ) ?? undefined,
  branch_id:
    resolveUiBranchIdFromBackend(
      branches,
      record.branch_id ?? record.branchId ?? record.backend_branch_id,
    ) ?? undefined,
  staffId: record.staffId ?? record.staff_id ?? record.user_id ?? record.userId,
  staffName:
    record.staffName ??
    record.staff_name ??
    record.user_name ??
    record.userName,
});

const toMonthNumber = (date: string): number => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getMonth() + 1;
};

const toYearNumber = (date: string): number => {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getFullYear();
};

// ─── Single source boundary ──────────────────────────────────────────────────

/**
 * [Fix-1] useOrg() is now used without a cast.
 * [Fix-2] masterData.branches is used directly — no cfg fallback.
 * [Fix-3] Branch summaries are computed via useAttendanceBranchSummaries hook.
 */
function useAttendanceSources(args: {
  branchIdParam?: string;
  apiStaff: AttendanceStaff[];
  apiAttendance: ApiAttendance[];
  useRealApi: boolean;
  selectedPeopleType?: string | null;
}) {
  const {
    branchIdParam,
    apiStaff,
    apiAttendance,
    useRealApi,
    selectedPeopleType,
  } = args;
  const moduleCtx = useModule();

  // [Fix-1] No `as any` cast — useOrg() is fully typed.
  const { cfg, masterData } = useOrg();

  // [Fix-2] masterData.branches is the authoritative list.
  // We do NOT fall back to cfg.branches — masterData IS derived from cfg,
  // so the two are always identical. The previous fallback was misleading.
  const branches: BranchLike[] = masterData.branches;

  // Branch scope must be known BEFORE the people model is built, since
  // Attendance's people-type options are now gated per-branch via
  // modulePeopleTypesByBranch instead of the org-wide list.
  const routeBranchId = branchIdParam ? Number(branchIdParam) : undefined;
  const scopedBranchId = Number.isFinite(routeBranchId)
    ? routeBranchId
    : undefined;
  const isGlobal = scopedBranchId === undefined;

  const attendancePeopleTypeRestriction = resolveModulePeopleTypes(
    cfg as unknown as Record<string, unknown>,
    "attendance",
    isGlobal ? null : scopedBranchId,
  );

  const peopleModel = buildAttendancePeopleModel(
    cfg as unknown as Record<string, unknown>,
    selectedPeopleType ?? readPeopleType(cfg),
    attendancePeopleTypeRestriction,
  );
  const peopleType = selectedPeopleType === "all" ? "" : peopleModel.peopleType;
  const entityLabel =
    selectedPeopleType === "all" ? "People" : peopleModel.personPlural;

  const getBranchName = useCallback(
    (branchId: number): string => masterData.getBranchName(branchId),
    [masterData],
  );

  const visibleBranches = useMemo(
    () =>
      isGlobal
        ? branches
        : branches.filter(
            (branch) => Number(branch.id) === Number(scopedBranchId),
          ),
    [branches, isGlobal, scopedBranchId],
  );

  const moduleStaff = moduleCtx.staff.allItems ?? moduleCtx.staff.items ?? [];
  const moduleAttendance =
    moduleCtx.attendance.allItems ?? moduleCtx.attendance.items ?? [];

  // [Fix-5] normalizeApiStaffForAttendance removed — call normalizeStaffForAttendance directly.
  const staff = useMemo<AttendanceStaff[]>(
    () =>
      useRealApi
        ? apiStaff.map((member) =>
            normalizeStaffForAttendance(member, branches),
          )
        : moduleStaff.map((member) =>
            normalizeStaffForAttendance(member, branches),
          ),
    [apiStaff, branches, moduleStaff, useRealApi],
  );

  const attendance = useMemo<ApiAttendance[]>(
    () =>
      useRealApi
        ? apiAttendance.map((record) =>
            normalizeAttendanceForView(record, branches),
          )
        : moduleAttendance.map((record) =>
            normalizeAttendanceForView(record, branches),
          ),
    [apiAttendance, branches, moduleAttendance, useRealApi],
  );

  // [Fix-3] Aggregation delegated to the extracted shared hook.
  const branchSummaries = useAttendanceBranchSummaries(
    branches,
    staff,
    attendance as unknown as Parameters<typeof useAttendanceBranchSummaries>[2],
  );

  return {
    masterData,
    branches,
    visibleBranches,
    currentBranch: visibleBranches[0],
    isGlobal,
    scopedBranchId,
    peopleType,
    entityLabel,
    peopleModel,
    staff,
    attendance,
    data: { branches: branchSummaries },
    getBranchName,
  };
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function AttendanceView() {
  const navigate = useNavigate();
  const { branchId: branchIdParam } = useParams<{ branchId?: string }>();
  // Support-created organizations have UUID ids and live Supabase attendance.
  // Always use the real API for them, even if VITE_USE_REAL_API was left false.
  //
  // organizationId comes from OrgConfigContext, not localStorage: it is the
  // one value hydrateFromBackend() clears to null when the backend hasn't
  // confirmed a tenant for this account (e.g. onboarding incomplete, or a
  // 404/400 from /api/client/bootstrap). Reading localStorage directly here
  // would silently ignore that guard and risk showing stale/other-tenant data.
  const { organizationId, cfg } = useOrg();
  const organizationIdForApi = organizationId ? cleanId(organizationId) : null;
  const useRealApi =
    Boolean(organizationIdForApi) ||
    (import.meta as any).env?.VITE_USE_REAL_API === "true";

  const [apiStaff, setApiStaff] = useState<AttendanceStaff[]>([]);
  const [apiAttendance, setApiAttendance] = useState<ApiAttendance[]>([]);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [loadingRefresh, setLoadingRefresh] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeBranchId, setActiveBranchId] = useState<number | null>(null);
  const [activeDept, setActiveDept] = useState<string | null>(null);
  const [activeSubgroup, setActiveSubgroup] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] =
    useState<AttendanceStatusFilter>("all");
  // Default is "staff" per product requirement: the "All Attendance People"
  // option has been removed from this dropdown entirely, so there is no
  // valid "null/all" state to fall back to here anymore.
  const [selectedPeopleType, setSelectedPeopleType] = useState<string | null>(
    "staff",
  );

  const filter = useDateFilter("daily");

  const sources = useAttendanceSources({
    branchIdParam,
    apiStaff,
    apiAttendance,
    useRealApi,
    selectedPeopleType,
  });

  const {
    branches,
    visibleBranches,
    currentBranch,
    isGlobal,
    scopedBranchId,
    peopleType,
    entityLabel,
    peopleModel,
    staff,
    attendance,
    data,
    getBranchName,
  } = sources;

  // The "All Attendance People" entry is an aggregate view, not a real
  // person type — this dropdown should only ever offer concrete types
  // (Staff, Worker, etc). Filtered here rather than in the shared
  // peopleTypeOptions builder so other consumers of that model are unaffected.
  const peopleTypeSelectorOptions = useMemo<PeopleTypeOption[]>(
    () =>
      (peopleModel.peopleTypeOptions ?? []).filter(
        (option) => option.value !== "all",
      ),
    [peopleModel.peopleTypeOptions],
  );

  // Safety net: the initial "staff" default may not exist for every org's
  // configured people types (e.g. school verticals). If so, fall back to
  // the first available option rather than leaving the selector empty.
  useEffect(() => {
    if (!peopleTypeSelectorOptions.length) return;
    const isValidSelection = peopleTypeSelectorOptions.some(
      (option) => option.value === selectedPeopleType,
    );
    if (!isValidSelection) {
      setSelectedPeopleType(peopleTypeSelectorOptions[0].value);
    }
  }, [peopleTypeSelectorOptions, selectedPeopleType]);

  const attendanceTemplateColumns = useMemo(
    () =>
      peopleModel.attendanceColumns.map(
        (column) => column as AttendanceTemplateColumn,
      ),
    [peopleModel.attendanceColumns],
  );

  const attendanceTemplateFilters = useMemo(
    () => peopleModel.filters,
    [peopleModel.filters],
  );

  const attendanceFilterByKey = useMemo(() => {
    const entries = attendanceTemplateFilters.map(
      (filter) => [filter.key, filter] as const,
    );
    return new Map(entries);
  }, [attendanceTemplateFilters]);

  const attendanceGroupFilter =
    attendanceFilterByKey.get("class") ??
    attendanceFilterByKey.get("department");
  const attendanceSubgroupFilter =
    attendanceFilterByKey.get("section") ??
    attendanceFilterByKey.get("designation");

  const dailyAttendanceColumns = useMemo(
    () => attendanceTemplateColumns,
    [attendanceTemplateColumns],
  );

  // Action (Edit/Save/Mark Absent) is rendered as its own fixed last column
  // instead of wherever it happens to sit in attendanceTemplateColumns, so
  // this excludes it from the config-driven pass and it's appended manually
  // after Notes/Channel in the table markup below.
  const visibleDailyAttendanceColumns = useMemo(
    () => dailyAttendanceColumns.filter((column) => column.key !== "action"),
    [dailyAttendanceColumns],
  );

  const rangeAttendanceColumns = useMemo(
    () =>
      attendanceTemplateColumns.filter(
        (column) =>
          !["checkIn", "checkOut", "duration", "arrival", "action"].includes(
            column.key,
          ),
      ),
    [attendanceTemplateColumns],
  );

  const attendanceDateParams = useMemo(() => {
    if (filter.mode === "daily") {
      return { date: filter.selectedDate };
    }
    const firstDate = filter.dates[0] ?? filter.selectedDate;
    const lastDate = filter.dates[filter.dates.length - 1] ?? firstDate;
    return {
      start: firstDate,
      end: lastDate,
    };
  }, [filter.mode, filter.dates, filter.selectedDate]);

  const fetchAttendance = useCallback(async () => {
    try {
      if (!organizationIdForApi) {
        // No confirmed tenant yet (OrgConfigContext still hydrating, or this
        // account hasn't launched an org). Show nothing rather than fetching
        // an unscoped/legacy-fallback result — never guess the tenant.
        setApiAttendance([]);
        return;
      }

      const selectedUiBranchId = scopedBranchId ?? activeBranchId ?? null;
      const backendBranchId = backendBranchIdForUi(
        branches,
        selectedUiBranchId,
      );

      const nodeAttendance = await getTodayNodeAttendance({
        organizationId: organizationIdForApi,
        branchId: backendBranchId,
        peopleType,
        ...attendanceDateParams,
      });

      setApiAttendance(
        nodeAttendance.records
          .map((record) => nodeAttendanceToView(record, branches))
          .map((record) => normalizeAttendanceForView(record, branches)),
      );
    } catch (error) {
      setApiError(
        error instanceof Error
          ? error.message
          : "Failed to load attendance records.",
      );
      setApiAttendance([]);
    }
  }, [
    activeBranchId,
    branches,
    attendanceDateParams,
    organizationIdForApi,
    peopleType,
    scopedBranchId,
  ]);

  useEffect(() => {
    if (!useRealApi) return;

    const loadInitialData = async () => {
      try {
        if (!organizationIdForApi) {
          setApiStaff([]);
          setApiAttendance([]);
          return;
        }

        const selectedUiBranchId = scopedBranchId ?? activeBranchId ?? null;
        const backendBranchId = backendBranchIdForUi(
          branches,
          selectedUiBranchId,
        );

        const [staffPage, nodeAttendance] = await Promise.all([
          listStaffPage({
            organizationId: organizationIdForApi,
            branchId: backendBranchId ?? undefined,
            role: "staff",
            peopleType,
            page: 1,
            pageSize: 500,
            sortBy: "name",
            sortDir: "asc",
          }),
          getTodayNodeAttendance({
            organizationId: organizationIdForApi,
            branchId: backendBranchId,
            peopleType,
            ...attendanceDateParams,
          }),
        ]);

        setApiStaff(
          (staffPage.rows as any[]).map((row) =>
            normalizeStaffForAttendance(row, branches),
          ),
        );

        setApiAttendance(
          (nodeAttendance.records ?? [])
            .map((record) => nodeAttendanceToView(record, branches))
            .map((record) => normalizeAttendanceForView(record, branches)),
        );
        setApiError(null);
      } catch (error) {
        setApiError(
          error instanceof Error
            ? error.message
            : "Failed to load attendance module data.",
        );
        setApiStaff([]);
        setApiAttendance([]);
      }
    };

    loadInitialData();
    const interval = window.setInterval(fetchAttendance, 30000);
    return () => window.clearInterval(interval);
  }, [fetchAttendance, useRealApi]);

  // Shared "YYYY-MM-DD" -> "12 Aug 2026" formatter. Single source of truth
  // for this so markAsAbsent's confirm/toast copy and formatExportPeriod
  // (further below) can't drift into two slightly different date formats.
  const formatDateForDisplay = (date?: string | null): string | null => {
    if (!date) return null;
    const parsed = parseLocalDate(date);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  // `targetDate` is the specific day being viewed (e.g. `todayRecord.date`
  // for the row the button was clicked on), NOT necessarily today. Without
  // it, markAttendanceAbsent silently falls back to the server's current
  // UTC date (see _dashboard_day_window_utc's default), so marking a staff
  // member absent while looking at a previous date would clear/record
  // *today's* attendance instead of the date on screen -- the row you were
  // looking at never changes, and a different (often uninvolved) day does.
  // Always pass the row's own date explicitly so the mutation and the view
  // agree on which day is being edited.
  const markAsAbsent = async (staffName: string, targetDate: string) => {
    if (!useRealApi) {
      toastInfo(
        "Demo attendance is generated from module store data. Use the real API mode to change attendance records.",
      );
      return;
    }
    if (!targetDate) {
      toastError("Could not determine which date to mark absent.");
      return;
    }
    const hasRecord = attendance.some(
      (item) =>
        item.user_name?.toLowerCase().trim() === staffName.toLowerCase().trim() &&
        item.date === targetDate,
    );
    const formattedDate = formatDateForDisplay(targetDate) ?? targetDate;
    const confirm = await Swal.fire({
      icon: "warning",
      title: `Mark "${staffName}" as absent on ${formattedDate}?`,
      text: hasRecord
        ? `Their existing check-in for ${formattedDate} will be cleared and the day recorded as absent.`
        : `${formattedDate} will be recorded as absent for this person.`,
      showCancelButton: true,
      confirmButtonText: "Mark Absent",
      cancelButtonText: "Cancel",
      focusCancel: true,
    });

    if (!confirm.isConfirmed) return;

    setLoadingAction(staffName);
    try {
      const record = attendance.find(
        (item) =>
          item.user_name?.toLowerCase().trim() ===
            staffName.toLowerCase().trim() && item.date === targetDate,
      );
      const userId =
        record?.user_id ||
        staff.find(
          (item) =>
            item.name?.toLowerCase().trim() === staffName.toLowerCase().trim(),
        )?.id;
      if (!userId) {
        toastError("Could not find a matching user to mark absent.");
        return;
      }
      await markAttendanceAbsent(userId, {
        organizationId: organizationIdForApi ?? undefined,
        branchId:
          backendBranchIdForUi(
            branches,
            scopedBranchId ?? activeBranchId ?? null,
          ) ?? undefined,
        peopleType,
        date: targetDate,
      });
      toastSuccess(`${staffName} has been marked as absent on ${formattedDate}.`);
      await fetchAttendance();
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : "Server error. Please check your connection.",
      );
    } finally {
      setLoadingAction(null);
    }
  };

  // Row-level edit mode. `editingRowId` is the staff member's id (unique per
  // row) currently in edit mode; `rowDraft` holds the uncommitted check-in,
  // check-out, arrival status, and notes values for that row while the
  // admin edits them. Replaces the old per-cell click-to-edit pattern
  // (single field, saved on blur) with an explicit Edit button that reveals
  // all four editable fields at once, and a Save button that commits them
  // together as one PATCH — so a row can never end up half-saved because
  // the admin tabbed away mid-edit.
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [rowDraft, setRowDraft] = useState<AttendanceRowDraft | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);

  const startRowEdit = (
    member: AttendanceStaff,
    todayRecord: AttendanceCellContext["record"] | undefined,
    branchTimezone: string,
  ) => {
    if (!useRealApi) {
      alert(
        "Demo attendance is generated from module store data. Use the real API mode to edit attendance records.",
      );
      return;
    }
    if (!todayRecord?.id) {
      alert(
        "❌ There's no attendance record for this day yet — nothing to edit.",
      );
      return;
    }

    setEditingRowId(String(member.id));
    setRowDraft({
      checkIn: toDatetimeLocalValue(todayRecord.inTime, branchTimezone),
      checkOut: toDatetimeLocalValue(todayRecord.outTime, branchTimezone),
      arrivalStatus: (todayRecord as any)?.checkInStatus ?? "unscheduled",
      notes: todayRecord.notes ?? "",
    });
  };

  const cancelRowEdit = () => {
    setEditingRowId(null);
    setRowDraft(null);
  };

  const saveRowEdit = async (
    recordId: string | number | undefined,
    staffId: string,
    branchTimezone: string,
  ) => {
    if (!recordId || !rowDraft) return;

    setSavingRowId(staffId);
    try {
      const edit: AttendanceRecordEdit = {
        checkIn: fromDatetimeLocalValue(rowDraft.checkIn, branchTimezone),
        checkOut: fromDatetimeLocalValue(rowDraft.checkOut, branchTimezone),
        arrivalStatus: rowDraft.arrivalStatus,
        notes: rowDraft.notes,
      };
      await updateAttendanceRecord(recordId, edit, {
        organizationId: organizationIdForApi ?? undefined,
        branchId:
          backendBranchIdForUi(
            branches,
            scopedBranchId ?? activeBranchId ?? null,
          ) ?? undefined,
        peopleType,
      });
      await fetchAttendance();
      toastSuccess("Attendance record updated.");
      setEditingRowId(null);
      setRowDraft(null);
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : "Server error. Please check your connection.",
      );
    } finally {
      setSavingRowId(null);
    }
  };

  const scopedStaff = useMemo(() => {
    return staff.filter((member) => {
      const memberPeopleType = normalizeKey(
        (member as any).peopleType ??
          (member as any).people_type ??
          (member as any).personType ??
          (member as any).person_type,
      );
      if (
        peopleType &&
        memberPeopleType &&
        memberPeopleType !== normalizeKey(peopleType)
      ) {
        return false;
      }

      const staffBranchId = Number((member as any).branchId);
      if (!isGlobal && scopedBranchId) return staffBranchId === scopedBranchId;
      if (isGlobal && activeBranchId) return staffBranchId === activeBranchId;
      return true;
    });
  }, [activeBranchId, isGlobal, peopleType, scopedBranchId, staff]);

  const groupCounts = useMemo(
    () => countByName(scopedStaff, getAttendanceGroupValue),
    [scopedStaff],
  );

  const subgroupCounts = useMemo(
    () => countByName(scopedStaff, getAttendanceSubgroupValue),
    [scopedStaff],
  );

  const attendanceRows = useMemo(() => {
    if (!scopedStaff.length) return [];
    const normalizedSearch = searchQuery.toLowerCase().trim();

    const rows = scopedStaff
      .filter((member) => {
        if (!normalizedSearch) return true;
        const haystack = [
          member.name,
          getStaffCode(member),
          getAttendanceGroupValue(member),
          getAttendanceSubgroupValue(member),
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedSearch);
      })
      .filter(
        (member) =>
          !activeDept || getAttendanceGroupValue(member) === activeDept,
      )
      .filter(
        (member) =>
          !activeSubgroup ||
          getAttendanceSubgroupValue(member) === activeSubgroup,
      )
      .map((staffMember) => {
        const staffBranchId = Number((staffMember as any).branchId);
        const dateRecords = filter.dates.map((date) => {
          const realRecord = attendance.find((record) => {
            const sameName =
              record.user_name?.toLowerCase().trim() ===
              staffMember.name?.toLowerCase().trim();
            const sameId =
              String((record as any).staffId ?? record.user_id ?? "") ===
              String(staffMember.id);
            const sameDate = record.date === date;
            return (sameName || sameId) && sameDate;
          });

          if (realRecord) {
            const normalizedStatus = String(realRecord.status).toUpperCase();
            // _attendance_row_for_dashboard (support_db.py) only ever sends
            // 'CHECKED_IN' | 'CHECKED_OUT' | 'HALF_DAY' as the top-level
            // status — 'PRESENT'/'COMPLETED'/'LATE' were a prior contract
            // that no longer exists on the backend. Comparing against the
            // old enum meant isPresent was always false for every real row,
            // which silently zeroed out both the Duration column (short-
            // circuited below) and every present-count stat card, even
            // though the person genuinely checked in. Half-day still counts
            // as present for the day (matches status_label's own treatment
            // of day_status='half_day' elsewhere in this codebase, not
            // absent).
            const isPresent = [
              "CHECKED_IN",
              "CHECKED_OUT",
              "HALF_DAY",
            ].includes(normalizedStatus);
            const isLate =
              realRecord.arrival_status?.includes("Late") ||
              normalizedStatus === "LATE";
            return {
              id: realRecord.id,
              date,
              status: normalizedStatus,
              arrivalStatus:
                realRecord.arrival_status ?? (isLate ? "Late" : "On-Time"),
              checkInStatus: realRecord.check_in_status ?? null,
              inTime: realRecord.time ?? realRecord.check_in ?? "",
              outTime: realRecord.outTime ?? realRecord.check_out ?? "",
              workDuration:
                calculateWorkDuration(
                  realRecord.time ?? realRecord.check_in,
                  realRecord.outTime ?? realRecord.check_out,
                ) ??
                realRecord.workDuration ??
                "",
              notes: realRecord.notes ?? null,
              captureChannel: realRecord.capture_channel ?? null,
              dayStatus: realRecord.day_status ?? null,
              // Which column holds the decision depends on BOTH day_status
              // and capture_channel -- only a mobile-sourced 'late' row is
              // decided on check_in_payroll_decision; every other case
              // (including a local_node 'late') uses
              // check_out_payroll_decision. See resolvePayrollDecision's
              // doc comment for the full rationale and why checking
              // day_status alone would misroute local_node 'late' rows.
              payrollDecision: resolvePayrollDecision({
                dayStatus: realRecord.day_status,
                captureChannel: realRecord.capture_channel,
                checkInPayrollDecision: realRecord.check_in_payroll_decision,
                checkOutPayrollDecision: realRecord.check_out_payroll_decision,
              }),
              isPresent,
              isLate,
            };
          }

          return {
            id: undefined,
            date,
            status: "ABSENT",
            arrivalStatus: "Absent",
            checkInStatus: null,
            inTime: "",
            outTime: "",
            workDuration: "",
            notes: null,
            captureChannel: null,
            dayStatus: null,
            payrollDecision: null,
            isPresent: false,
            isLate: false,
          };
        });

        const presentDays = dateRecords.filter(
          (record) => record.isPresent,
        ).length;
        const lateDays = dateRecords.filter((record) => record.isLate).length;
        const absentDays = dateRecords.length - presentDays;

        return {
          staff: staffMember,
          records: dateRecords,
          summary: {
            totalDays: dateRecords.length,
            presentDays,
            lateDays,
            absentDays,
            attendanceRate:
              dateRecords.length > 0
                ? Math.round((presentDays / dateRecords.length) * 100)
                : 0,
          },
        };
      });

    if (activeStatus === "all") return rows;

    return rows.filter(({ records, summary }) => {
      const firstRecord = records[0];
      const presentDays = summary.presentDays;
      const lateDays = summary.lateDays;
      const onTimeDays = Math.max(0, presentDays - lateDays);

      if (activeStatus === "present") return presentDays > 0;
      if (activeStatus === "absent") {
        return filter.mode === "daily"
          ? !firstRecord?.isPresent
          : summary.absentDays > 0;
      }
      if (activeStatus === "late") return lateDays > 0;
      if (activeStatus === "onTime") return onTimeDays > 0;
      return true;
    });
  }, [
    scopedStaff,
    attendance,
    searchQuery,
    activeDept,
    activeSubgroup,
    activeStatus,
    filter.dates,
    filter.mode,
  ]);

  const exportDateRange = useMemo(() => {
    const firstDate = filter.dates[0] ?? filter.selectedDate;
    const lastDate = filter.dates[filter.dates.length - 1] ?? firstDate;
    return { from: firstDate, to: lastDate };
  }, [filter.dates, filter.selectedDate]);

  const attendanceExportRows = useMemo<AttendanceExportRow[]>(() => {
    return attendanceRows.map(({ staff: member, records, summary }) => {
      const branchId = Number((member as any).branchId);
      const selectedDayRecord = records[0];
      const onTimeDays = records.filter(
        (record) => record.isPresent && !record.isLate,
      ).length;
      const leaveDays = records.filter((record) =>
        String(record.status).toUpperCase().includes("LEAVE"),
      ).length;
      const offDays = records.filter((record) =>
        String(record.status).toUpperCase().includes("OFF"),
      ).length;
      const restDays = records.filter((record) =>
        String(record.status).toUpperCase().includes("REST"),
      ).length;

      const branchTimezone = getBranchTimezone(branchId, branches);
      return {
        code: getStaffCode(member),
        name: member.name ?? "-",
        designation: getAttendanceSubgroupValue(member),
        branch: getBranchName(branchId),
        department: getAttendanceGroupValue(member),
        arrival: selectedDayRecord?.arrivalStatus || "—",
        month: toMonthNumber(exportDateRange.from),
        year: toYearNumber(exportDateRange.from),
        totalDays: summary.totalDays,
        present: summary.presentDays,
        onTime: onTimeDays,
        late: summary.lateDays,
        leaves: leaveDays,
        absents: summary.absentDays,
        offDays,
        restDays,
        attendanceRate: `${summary.attendanceRate}%`,
        firstCheckIn: selectedDayRecord?.inTime
          ? formatTimeForDisplay(selectedDayRecord.inTime, branchTimezone)
          : "",
        lastCheckOut: selectedDayRecord?.outTime
          ? formatTimeForDisplay(selectedDayRecord.outTime, branchTimezone)
          : "",
        totalWorkDuration: selectedDayRecord?.workDuration || "",
      };
    });
  }, [attendanceRows, exportDateRange.from, getBranchName]);

  const shouldHideTimeColumns = useMemo(
    () => filter.mode !== "daily",
    [filter.mode],
  );

  const attendanceExportColumns = useMemo<
    ExportExcelColumn<AttendanceExportRow>[]
  >(
    () => [
      ...attendanceTemplateColumns
        .filter((column) => {
          const isDetailTimingColumn =
            column.key === "checkIn" ||
            column.key === "checkOut" ||
            column.key === "duration";
          return (
            column.exportable !== false &&
            column.key !== "action" &&
            column.key !== "branch" &&
            column.key !== "uuid" &&
            !(shouldHideTimeColumns && isDetailTimingColumn)
          );
        })
        .map((column) => ({
          header: column.label,
          accessor: (row: AttendanceExportRow) =>
            attendanceExportColumnValue(
              row as unknown as Record<string, unknown>,
              column,
            ),
        })),
      { header: "Month", key: "month" as keyof AttendanceExportRow },
      { header: "Year", key: "year" as keyof AttendanceExportRow },
      { header: "Total Days", key: "totalDays" as keyof AttendanceExportRow },
      { header: "Present", key: "present" as keyof AttendanceExportRow },
      { header: "On-Time", key: "onTime" as keyof AttendanceExportRow },
      { header: "Late", key: "late" as keyof AttendanceExportRow },
      { header: "Leaves", key: "leaves" as keyof AttendanceExportRow },
      { header: "Absents", key: "absents" as keyof AttendanceExportRow },
      { header: "Off Days", key: "offDays" as keyof AttendanceExportRow },
      { header: "Rest Days", key: "restDays" as keyof AttendanceExportRow },
      {
        header: "Attendance Rate",
        key: "attendanceRate" as keyof AttendanceExportRow,
      },
    ],
    [attendanceTemplateColumns, shouldHideTimeColumns],
  );

  const formatExportPeriod = (date?: string | null): string =>
    formatDateForDisplay(date) ?? "";

  const attendanceExportFilters = useMemo(
    () => ({
      Period:
        exportDateRange.from === exportDateRange.to
          ? formatExportPeriod(exportDateRange.from)
          : `${formatExportPeriod(exportDateRange.from)} – ${formatExportPeriod(
              exportDateRange.to,
            )}`,
    }),
    [exportDateRange.from, exportDateRange.to],
  );

  const isRangeMode =
    filter.mode === "weekly" ||
    filter.mode === "monthly" ||
    filter.mode === "custom";

  const totalStaff = scopedStaff.length;
  const rawPresentDays = attendanceRows.reduce(
    (sum, row) => sum + row.summary.presentDays,
    0,
  );
  const rawLateDays = attendanceRows.reduce(
    (sum, row) => sum + row.summary.lateDays,
    0,
  );
  const rawAbsentDays = attendanceRows.reduce(
    (sum, row) => sum + row.summary.absentDays,
    0,
  );

  // Pagination for attendance rows (client-side). Page size default is 25
  // with options to switch to 50/100 etc. useStatefulPagination manages
  // the page state and slices items efficiently.
  const [pageSize, setPageSize] = useState<number>(25);
  const attendancePager = useStatefulPagination({
    items: attendanceRows,
    itemsPerPage: pageSize,
  });
  const paginatedAttendanceRows = attendancePager.paginatedItems;
  const daysInRange = Math.max(filter.dates.length, 1);

  const presentCount = isRangeMode
    ? Math.round(rawPresentDays / daysInRange)
    : rawPresentDays;
  const lateCount = isRangeMode
    ? Math.round(rawLateDays / daysInRange)
    : rawLateDays;
  const absentCount = isRangeMode
    ? Math.round(rawAbsentDays / daysInRange)
    : rawAbsentDays;
  const onTimeCount = Math.max(0, presentCount - lateCount);

  const presentPct =
    totalStaff > 0 ? Math.round((presentCount / totalStaff) * 100) : 0;
  const onTimePct =
    presentCount > 0 ? Math.round((onTimeCount / presentCount) * 100) : 0;
  const latePct =
    presentCount > 0 ? Math.round((lateCount / presentCount) * 100) : 0;
  const absentPct =
    totalStaff > 0 ? Math.round((absentCount / totalStaff) * 100) : 0;

  const kpiPresentLabel = isRangeMode ? "Avg Present / Day" : "Present Today";
  const kpiAbsentLabel = isRangeMode ? "Avg Absent / Day" : "Absent Today";
  const kpiPresentSub = isRangeMode
    ? `${presentPct}% avg rate · ${daysInRange} days`
    : `${presentPct}% of total`;
  const kpiAbsentSub = isRangeMode
    ? `${absentPct}% avg rate`
    : `${absentPct}% of total`;
  const kpiOnTimeSub = isRangeMode
    ? `${lateCount} avg late / day`
    : `${lateCount} arrived late`;

  const branchFilterOptions = useMemo(() => {
    const countForBranch = (branchId: number): number =>
      staff.filter((member) => {
        const memberPeopleType = normalizeKey(
          (member as any).peopleType ??
            (member as any).people_type ??
            (member as any).personType ??
            (member as any).person_type,
        );
        if (
          peopleType &&
          memberPeopleType &&
          memberPeopleType !== normalizeKey(peopleType)
        ) {
          return false;
        }
        return Number((member as any).branchId) === Number(branchId);
      }).length;

    const totalCount = visibleBranches.reduce(
      (sum, branch) => sum + countForBranch(Number(branch.id)),
      0,
    );

    return [
      {
        value: "all",
        label: "All Branches",
        description: `${totalCount.toLocaleString()} ${entityLabel.toLowerCase()}`,
      },
      ...visibleBranches.map((branch) => {
        const count = countForBranch(Number(branch.id));
        const summary = data.branches.find(
          (item) => Number(item.branchId) === Number(branch.id),
        );
        return {
          value: String(branch.id),
          label: branch.name,
          description: `${count.toLocaleString()} ${entityLabel.toLowerCase()} · ${summary?.attendanceRate ?? 0}% rate`,
        };
      }),
    ];
  }, [data.branches, entityLabel, peopleType, staff, visibleBranches]);

  const groupFilterOptions = useMemo(
    () => [
      {
        value: "all",
        label: peopleModel.groupFilterAllLabel,
        description: `${totalStaff.toLocaleString()} ${entityLabel.toLowerCase()}`,
      },
      ...groupCounts.map((item) => ({
        value: item.name,
        label: item.name,
        description: `${item.count.toLocaleString()} ${entityLabel.toLowerCase()}`,
      })),
    ],
    [entityLabel, groupCounts, peopleModel.groupFilterAllLabel, totalStaff],
  );

  const subgroupFilterOptions = useMemo(
    () => [
      {
        value: "all",
        label: peopleModel.subgroupFilterAllLabel,
        description: `${totalStaff.toLocaleString()} ${entityLabel.toLowerCase()}`,
      },
      ...subgroupCounts.map((item) => ({
        value: item.name,
        label: item.name,
        description: `${item.count.toLocaleString()} ${entityLabel.toLowerCase()}`,
      })),
    ],
    [
      entityLabel,
      peopleModel.subgroupFilterAllLabel,
      subgroupCounts,
      totalStaff,
    ],
  );

  const statusFilterOptions = useMemo(
    () => [
      { value: "all", label: "All Statuses", description: "Show every record" },
      {
        value: "present",
        label: "Present",
        description: "Present in selected range",
      },
      {
        value: "onTime",
        label: "On-Time",
        description: "Present without late mark",
      },
      { value: "late", label: "Late", description: "Late arrival records" },
      {
        value: "absent",
        label: "Absent",
        description: "Absent in selected range",
      },
    ],
    [],
  );

  const resetAttendanceFilters = useCallback(() => {
    setSearchQuery("");
    if (isGlobal) setActiveBranchId(null);
    setActiveDept(null);
    setActiveSubgroup(null);
    setActiveStatus("all");
    filter.setMode("daily");
  }, [filter, isGlobal]);

  const attendanceTitle = isGlobal
    ? activeBranchId
      ? `${data.branches.find((branch) => branch.branchId === activeBranchId)?.branchName} · Attendance`
      : `All Branches · ${peopleModel.personPlural} Attendance`
    : `${currentBranch?.name ?? ""} · Attendance`;

  const attendanceFilterSections = useMemo<DynamicFilterSection[]>(
    () => [
      {
        id: "branch",
        type: "select",
        label:
          attendanceFilterByKey.get("branchId")?.label ??
          peopleModel.branchLabel,
        value: activeBranchId ? String(activeBranchId) : "all",
        options: branchFilterOptions,
        onChange: (value: string) => {
          setActiveBranchId(value === "all" ? null : Number(value));
          setActiveDept(null);
          setActiveSubgroup(null);
        },
        hidden: !isGlobal,
        minWidth: 190,
      },
      ...(attendanceFilterByKey.has("peopleType")
        ? ([
            {
              id: "peopleType",
              type: "custom",
              render: (
                <PeopleTypeSelector
                  options={peopleTypeSelectorOptions}
                  value={selectedPeopleType ?? peopleType}
                  onChange={(nextValue) => {
                    setSelectedPeopleType(nextValue);
                    setActiveDept(null);
                    setActiveSubgroup(null);
                  }}
                  ariaLabel={
                    attendanceFilterByKey.get("peopleType")?.label ??
                    "Attendance Scope"
                  }
                  minWidth={210}
                />
              ),
            },
          ] as DynamicFilterSection[])
        : []),
      {
        id: "date",
        type: "custom",
        render: <DateFilterBar filter={filter} compact />,
      },
      {
        id: "group",
        type: "select",
        label: attendanceGroupFilter?.label ?? peopleModel.groupLabel,
        hidden: !attendanceGroupFilter,
        value: activeDept ?? "all",
        options: groupFilterOptions,
        onChange: (value: string) => {
          setActiveDept(value === "all" ? null : value);
          setActiveSubgroup(null);
        },
        minWidth: 220,
      },
      {
        id: "subgroup",
        type: "select",
        label: attendanceSubgroupFilter?.label ?? peopleModel.subgroupLabel,
        hidden: !attendanceSubgroupFilter,
        value: activeSubgroup ?? "all",
        options: subgroupFilterOptions,
        onChange: (value: string) =>
          setActiveSubgroup(value === "all" ? null : value),
        minWidth: 190,
      },
      {
        id: "status",
        type: "select",
        label: attendanceFilterByKey.get("status")?.label ?? "Status",
        value: activeStatus,
        options: statusFilterOptions,
        onChange: (value: string) =>
          setActiveStatus(value as AttendanceStatusFilter),
        minWidth: 170,
      },
      {
        id: "search",
        type: "search",
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder:
          attendanceFilterByKey.get("search")?.placeholder ??
          peopleModel.searchPlaceholder,
        grow: true,
        minWidth: 260,
      },
      {
        id: "reset",
        type: "reset",
        label: "Clear",
        onClick: resetAttendanceFilters,
      },
    ],
    [
      activeBranchId,
      activeDept,
      activeSubgroup,
      activeStatus,
      branchFilterOptions,
      attendanceFilterByKey,
      attendanceGroupFilter,
      attendanceSubgroupFilter,
      groupFilterOptions,
      peopleModel.branchLabel,
      peopleModel.groupLabel,
      peopleTypeSelectorOptions,
      peopleType,
      selectedPeopleType,
      peopleModel.searchPlaceholder,
      peopleModel.subgroupLabel,
      filter,
      isGlobal,
      resetAttendanceFilters,
      searchQuery,
      statusFilterOptions,
      subgroupFilterOptions,
    ],
  );

  return (
    <div
      style={{ fontFamily: "'DM Sans', 'Inter', sans-serif" }}
      className="min-h-screen bg-[#f5f6fa] p-6"
    >
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1
            className="flex items-center gap-2 text-2xl font-bold"
            style={{ color: "#1a699f" }}
          >
            <ClipboardCheck
              className="h-6 w-6"
              strokeWidth={2.25}
              size={22}
              color={T.teal600}
            />
            Attendance
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <RefreshButton
            size="md"
            loading={loadingRefresh}
            onClick={async () => {
              if (loadingRefresh) return;
              setLoadingRefresh(true);
              try {
                await fetchAttendance();
              } finally {
                setLoadingRefresh(false);
              }
            }}
            ariaLabel="Refresh attendance"
          />
          <ExportButton
            data={attendanceExportRows}
            filename={`Attendance_${filter.mode}_${exportDateRange.from}_${exportDateRange.to}`}
            organization={{
              name: cfg.orgName || undefined,
              logoUrl: cfg.logo || undefined,
            }}
            excel={{
              columns: attendanceExportColumns,
            }}
            pdf={{
              title: "Attendance Report",
              reportPeriod:
                exportDateRange.from === exportDateRange.to
                  ? `Period: ${formatExportPeriod(exportDateRange.from)}`
                  : `Period: ${formatExportPeriod(exportDateRange.from)} – ${formatExportPeriod(
                      exportDateRange.to,
                    )}`,
              meta: attendanceExportFilters,
              columns: attendanceExportColumns,
            }}
            label="Export"
          />
        </div>
      </div>

      {apiError && (
        <div
          className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
        >
          {apiError}
        </div>
      )}

      <div className="grid grid-cols-4 gap-4 mb-6">
        <KPICard
          label={peopleModel.statsTotalLabel}
          value={totalStaff}
          sub="registered"
        />
        <KPICard
          label={kpiPresentLabel}
          value={presentCount}
          sub={kpiPresentSub}
        />
        <KPICard
          label={kpiAbsentLabel}
          value={absentCount}
          sub={kpiAbsentSub}
        />
        <KPICard
          label="On-Time Rate"
          value={`${onTimePct}%`}
          sub={kpiOnTimeSub}
        />
      </div>

      <DynamicFilterToolbar
        sections={attendanceFilterSections}
        bordered
        style={{ marginBottom: 24 }}
      />

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold" style={{ color: "#1a699f" }}>
          {attendanceTitle}
        </h2>
        <span className="text-xs text-gray-400">
          {filter.label} · {attendanceRows.length} records
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold" style={{ color: "#1a699f" }}>
              {peopleModel.personPlural}
            </p>
            <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center">
              <Users className="w-4 h-4 text-gray-500" />
            </div>
          </div>
          <p className="text-3xl font-bold text-gray-900">{presentCount}</p>
          <p className="text-xs text-gray-400 mt-1">{presentPct}% present</p>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold" style={{ color: "#1a699f" }}>
              On-Time
            </p>
            <CheckCircle className="w-5 h-5 text-teal-600" />
          </div>
          <p className="text-3xl font-bold text-gray-900">{onTimeCount}</p>
          <p className="text-xs text-gray-400 mt-1">
            {onTimePct}% on-time rate
          </p>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold" style={{ color: "#1a699f" }}>
              Late / Absent
            </p>
            <AlertCircle className="w-5 h-5 text-orange-500" />
          </div>
          <p className="text-3xl font-bold text-gray-900">
            {lateCount} / {absentCount}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {latePct}% late · {absentPct}% absent
          </p>
        </div>
      </div>

      {filter.mode === "daily" && (
        <>
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3
                className="text-sm font-semibold"
                style={{ color: "#1a699f" }}
              >
                Daily Attendance
              </h3>
              <span className="text-xs text-gray-400">
                {filter.selectedDate}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    {visibleDailyAttendanceColumns.map((column) => (
                      <th
                        key={column.key}
                        className="px-6 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider"
                      >
                        {column.label}
                      </th>
                    ))}
                    {/* Fixed column, not driven by peopleModel.attendanceColumns
                     * (see attendanceColumnText's "notes" case for why a
                     * config-driven entry alone wouldn't be enough) — appended
                     * here so it renders regardless of that external column
                     * config until "notes" is added there directly. */}
                    <th className="px-6 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      Notes
                    </th>
                    {/* Same "fixed column" reasoning as Notes above. Shows the
                     * day-level outcome (Late / Short Leave / Half Day /
                     * Overtime, falling back to On Time / Early / Unscheduled
                     * for an unclassified day) — see deriveDayStatusBadge.
                     * Applies identically to local-node and mobile-app rows,
                     * since day_status is written by both pipelines. */}
                    <th className="px-6 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      Day Status
                    </th>
                    {/* Fixed column — the admin payroll include/exclude call
                     * on an already-classified day, distinct from Day Status
                     * itself. See derivePayrollDecisionBadge; currently only
                     * ever populated for local-node rows. */}
                    <th className="px-6 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      Decision
                    </th>
                    {/* Same "fixed column" reasoning as Notes just above --
                     * capture_channel isn't part of peopleModel.attendanceColumns
                     * either. Shows which surface (local node / cloud / mobile
                     * app) actually captured this row. */}
                    <th className="px-6 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      Channel
                    </th>
                    {/* Action (Edit/Save/Mark Absent) is intentionally last —
                     * see visibleDailyAttendanceColumns above. */}
                    <th className="px-6 py-3 text-center text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {paginatedAttendanceRows.map(({ staff: member, records }) => {
                    const todayRecord = records[0];
                    const isPresent = todayRecord?.isPresent;
                    const isLate = todayRecord?.isLate;
                    const arrivalStatus = todayRecord?.arrivalStatus;

                    // Built once per row and reused for every column below.
                    // Previously each column call site built its own inline
                    // context object, and it was easy (and happened) for one
                    // of them to forget `branches` — which is exactly how the
                    // checkOut column ended up silently rendering UTC instead
                    // of the branch's local time. One shared object removes
                    // that failure mode structurally instead of relying on
                    // every future column author remembering to pass it.
                    const cellContext: AttendanceCellContext = {
                      member,
                      record: todayRecord,
                      getBranchName,
                      branches,
                    };

                    // Shared with startRowEdit/saveRowEdit and the notes cell
                    // below, in addition to the checkIn/checkOut cells — see
                    // cellContext's comment for why this now lives at row
                    // scope instead of being recomputed per-column.
                    const branchTimezone = getBranchTimezone(
                      Number((member as any).branchId),
                      branches,
                    );
                    const isEditingRow = editingRowId === String(member.id);
                    const isSavingRow = savingRowId === String(member.id);

                    return (
                      <tr
                        key={String(member.id)}
                        className="hover:bg-gray-50 transition-colors"
                      >
                        {visibleDailyAttendanceColumns.map((column) => {
                          if (column.key === "name") {
                            return (
                              <td key={column.key} className="px-6 py-4">
                                <div className="flex items-center gap-3">
                                  <div className="w-9 h-9 rounded-full bg-teal-50 text-teal-700 flex items-center justify-center text-xs font-bold">
                                    {member.name?.charAt(0)?.toUpperCase() ??
                                      "?"}
                                  </div>
                                  <div>
                                    <p className="text-sm font-semibold text-gray-900">
                                      {member.name}
                                    </p>
                                    <p className="text-xs text-gray-400">
                                      {getStaffCode(member)}
                                    </p>
                                  </div>
                                </div>
                              </td>
                            );
                          }

                          if (column.key === "arrival") {
                            if (isEditingRow && rowDraft) {
                              return (
                                <td
                                  key={column.key}
                                  className="px-6 py-4 text-center"
                                >
                                  <select
                                    disabled={isSavingRow}
                                    value={rowDraft.arrivalStatus}
                                    onChange={(e) => {
                                      const value = e.target.value;
                                      setRowDraft((draft) =>
                                        draft
                                          ? { ...draft, arrivalStatus: value }
                                          : draft,
                                      );
                                    }}
                                    className="text-xs font-semibold border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-200"
                                  >
                                    <option value="on_time">On Time</option>
                                    <option value="late">Late</option>
                                  </select>
                                </td>
                              );
                            }

                            return (
                              <td
                                key={column.key}
                                className="px-6 py-4 text-center"
                              >
                                {arrivalStatus ? (
                                  <span
                                    className={`inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold border ${
                                      isLate
                                        ? "bg-orange-50 text-orange-600 border-orange-100"
                                        : isPresent
                                          ? "bg-teal-50 text-teal-700 border-teal-100"
                                          : "bg-rose-50 text-rose-600 border-rose-100"
                                    }`}
                                  >
                                    {arrivalStatus}
                                  </span>
                                ) : (
                                  <span className="text-gray-300 text-sm">
                                    —
                                  </span>
                                )}
                              </td>
                            );
                          }

                          if (
                            column.key === "checkIn" ||
                            column.key === "checkOut"
                          ) {
                            const field = column.key as "checkIn" | "checkOut";

                            if (isEditingRow && rowDraft) {
                              return (
                                <td key={column.key} className="px-6 py-4">
                                  <input
                                    type="datetime-local"
                                    disabled={isSavingRow}
                                    title={`Time is in the branch's timezone (${branchTimezone})`}
                                    value={rowDraft[field]}
                                    onChange={(e) => {
                                      const value = e.target.value;
                                      setRowDraft((draft) =>
                                        draft
                                          ? { ...draft, [field]: value }
                                          : draft,
                                      );
                                    }}
                                    className="text-sm border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-200"
                                  />
                                </td>
                              );
                            }

                            return (
                              <td key={column.key} className="px-6 py-4">
                                {field === "checkIn" && isPresent ? (
                                  <div className="flex items-center gap-2 text-sm font-semibold text-teal-700">
                                    <Clock className="w-3.5 h-3.5" />
                                    {attendanceColumnText(column, cellContext)}
                                  </div>
                                ) : (
                                  <span className="text-sm text-gray-600">
                                    {attendanceColumnText(column, cellContext)}
                                  </span>
                                )}
                              </td>
                            );
                          }

                          return (
                            <td
                              key={column.key}
                              className="px-6 py-4 text-sm text-gray-600"
                            >
                              {attendanceColumnText(column, cellContext)}
                            </td>
                          );
                        })}
                        {(() => {
                          if (isEditingRow && rowDraft) {
                            return (
                              <td className="px-6 py-4 max-w-xs">
                                <input
                                  type="text"
                                  disabled={isSavingRow}
                                  value={rowDraft.notes}
                                  placeholder="Add a note..."
                                  maxLength={300}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setRowDraft((draft) =>
                                      draft
                                        ? { ...draft, notes: value }
                                        : draft,
                                    );
                                  }}
                                  className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-200"
                                />
                              </td>
                            );
                          }

                          return (
                            <td className="px-6 py-4 text-sm text-gray-600 max-w-xs whitespace-normal wrap-break-word">
                              {todayRecord?.notes || (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                          );
                        })()}
                        <td className="px-6 py-4 text-center">
                          {(() => {
                            const badge = deriveDayStatusBadge({
                              isPresent,
                              dayStatus: todayRecord?.dayStatus,
                              checkInStatus: todayRecord?.checkInStatus,
                            });
                            return badge ? (
                              <span
                                className={`inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold border ${badge.className}`}
                              >
                                {badge.label}
                              </span>
                            ) : (
                              <span className="text-gray-300 text-sm">—</span>
                            );
                          })()}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {(() => {
                            const badge = derivePayrollDecisionBadge({
                              dayStatus: todayRecord?.dayStatus,
                              payrollDecision: todayRecord?.payrollDecision,
                            });
                            return badge ? (
                              <span
                                className={`inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold border ${badge.className}`}
                              >
                                {badge.label}
                              </span>
                            ) : (
                              <span className="text-gray-300 text-sm">—</span>
                            );
                          })()}
                        </td>
                        <td className="px-6 py-4 text-center">
                          {(() => {
                            const badge = captureChannelBadge(
                              todayRecord?.captureChannel,
                            );
                            return badge ? (
                              <span
                                className={`inline-flex items-center px-3 py-1 rounded-full text-[11px] font-semibold border ${badge.className}`}
                              >
                                {badge.label}
                              </span>
                            ) : (
                              <span className="text-gray-300 text-sm">—</span>
                            );
                          })()}
                        </td>
                        {/* Action (Edit/Save/Mark Absent) is the fixed last
                         * column — see visibleDailyAttendanceColumns above. */}
                        <td className="px-6 py-4 text-center">
                          <div className="inline-flex items-center gap-2">
                            {isEditingRow ? (
                              <>
                                <button
                                  onClick={() =>
                                    saveRowEdit(
                                      todayRecord?.id,
                                      String(member.id),
                                      branchTimezone,
                                    )
                                  }
                                  disabled={isSavingRow}
                                  title="Save"
                                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-teal-50 text-teal-700 hover:bg-teal-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all border border-teal-100"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={cancelRowEdit}
                                  disabled={isSavingRow}
                                  title="Cancel"
                                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() =>
                                    startRowEdit(
                                      member,
                                      todayRecord,
                                      branchTimezone,
                                    )
                                  }
                                  disabled={!useRealApi || !todayRecord?.id}
                                  title={
                                    !useRealApi
                                      ? "Demo mode uses ModuleContext attendance"
                                      : !todayRecord?.id
                                        ? "No attendance record for this day yet"
                                        : "Edit"
                                  }
                                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-sky-50 text-sky-700 hover:bg-sky-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all border border-sky-100"
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() =>
                                    markAsAbsent(
                                      member.name,
                                      todayRecord?.date ?? filter.selectedDate,
                                    )
                                  }
                                  disabled={
                                    !useRealApi || loadingAction === member.name
                                  }
                                  title={
                                    !useRealApi
                                      ? "Demo mode uses ModuleContext attendance"
                                      : loadingAction === member.name
                                        ? "Processing..."
                                        : useRealApi
                                          ? "Mark Absent"
                                          : "Demo Data"
                                  }
                                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all border border-rose-100"
                                >
                                  <UserX className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {attendanceRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={dailyAttendanceColumns.length + 4}
                        className="px-6 py-16 text-center"
                      >
                        <div className="flex flex-col items-center gap-3 text-gray-400">
                          <Users className="w-10 h-10 opacity-30" />
                          <p className="text-sm font-medium">
                            No {entityLabel.toLowerCase()} found
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ padding: "12px 20px" }} className="mt-3">
            <FastPagination
              page={attendancePager.page}
              pageSize={pageSize}
              total={attendancePager.totalItems}
              onPageChange={attendancePager.goToPage}
              onPageSizeChange={(s) => setPageSize(s)}
              disabled={loadingRefresh}
            />
          </div>
        </>
      )}

      {(filter.mode === "weekly" ||
        filter.mode === "monthly" ||
        filter.mode === "custom") && (
        <>
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3
                className="text-sm font-semibold"
                style={{ color: "#1a699f" }}
              >
                {filter.mode === "monthly"
                  ? "Monthly Attendance"
                  : filter.mode === "weekly"
                    ? "Weekly Attendance"
                    : "Custom Date Attendance"}
              </h3>
              <span className="text-xs text-gray-400">
                {filter.label} &nbsp;·&nbsp; {filter.dates.length} day
                {filter.dates.length !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    {[
                      ...rangeAttendanceColumns.map((column) => ({
                        key: column.key,
                        label: column.label,
                      })),
                      { key: "month", label: "Month" },
                      { key: "year", label: "Year" },
                      { key: "totalDays", label: "Total Days" },
                      { key: "present", label: "Present" },
                      { key: "late", label: "Late" },
                      { key: "leaves", label: "Leaves" },
                      { key: "absents", label: "Absents" },
                      { key: "offDays", label: "Off Days" },
                      { key: "restDays", label: "Rest Days" },
                      { key: "attendanceRate", label: "Attendance Rate" },
                    ].map((column) => (
                      <th
                        key={column.key}
                        className="px-6 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wider"
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {paginatedAttendanceRows.map(
                    ({ staff: member, records, summary }) => {
                      const leaveDays = records.filter((record) =>
                        String(record.status).toUpperCase().includes("LEAVE"),
                      ).length;
                      const offDays = records.filter((record) =>
                        String(record.status).toUpperCase().includes("OFF"),
                      ).length;
                      const restDays = records.filter((record) =>
                        String(record.status).toUpperCase().includes("REST"),
                      ).length;
                      return (
                        <tr
                          key={String(member.id)}
                          className="hover:bg-gray-50 transition-colors"
                        >
                          {rangeAttendanceColumns.map((column) => (
                            <td
                              key={column.key}
                              className="px-6 py-4 text-sm text-gray-600"
                            >
                              {attendanceColumnText(column, {
                                member,
                                getBranchName,
                                branches,
                              })}
                            </td>
                          ))}
                          <td className="px-6 py-4 text-sm text-gray-600">
                            {toMonthNumber(exportDateRange.from)}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600">
                            {toYearNumber(exportDateRange.from)}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600">
                            {summary.totalDays}
                          </td>
                          <td className="px-6 py-4 text-sm font-semibold text-teal-700">
                            {summary.presentDays}
                          </td>
                          <td className="px-6 py-4 text-sm font-semibold text-orange-600">
                            {summary.lateDays}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600">
                            {leaveDays}
                          </td>
                          <td className="px-6 py-4 text-sm font-semibold text-rose-600">
                            {summary.absentDays}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600">
                            {offDays}
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-600">
                            {restDays}
                          </td>
                          <td className="px-6 py-4 text-sm font-bold text-gray-900">
                            {summary.attendanceRate}%
                          </td>{" "}
                        </tr>
                      );
                    },
                  )}
                  {attendanceRows.length === 0 && (
                    <tr>
                      <td
                        colSpan={rangeAttendanceColumns.length + 10}
                        className="px-6 py-16 text-center"
                      >
                        <div className="flex flex-col items-center gap-3 text-gray-400">
                          <Users className="w-10 h-10 opacity-30" />
                          <p className="text-sm font-medium">
                            No {entityLabel.toLowerCase()} found
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ padding: "12px 20px" }} className="mt-3">
            <FastPagination
              page={attendancePager.page}
              pageSize={pageSize}
              total={attendancePager.totalItems}
              onPageChange={attendancePager.goToPage}
              onPageSizeChange={(s) => setPageSize(s)}
              disabled={loadingRefresh}
            />
          </div>
        </>
      )}
    </div>
  );
}