/**
 * ModuleContext.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Production backend-first module/entity snapshot.
 *
 * Module hydration is now gated by Support-enabled modules. Inactive modules
 * are cleared from this context and are not fetched unnecessarily.
 *
 * Source of truth:
 *   Flask backend APIs
 *     → API adapters
 *     → ModuleContext read snapshot
 *     → dashboard/module UI
 *
 * Important:
 *   - No orgDummy.
 *   - No generateOrgDummyData.
 *   - No localStorage seeding.
 *   - No dummy fallback.
 *
 * Write flows should still go through module-specific backend hooks/APIs:
 *   StaffDirectory       → staffApi
 *   LeaveManagement      → leaveApi / useLeaveActions
 *   PayrollModule        → payrollApi / usePayrollData
 *   Attendance pages     → attendanceApi / useAttendanceData
 *   OvertimeManagement   → overtime API/hook
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useOrg } from "./OrgConfigContext";
import type {
  CctvDevice,
  CctvScopedStore,
  OrgCamera,
} from "./OrgConfigContext";

import { listStaffRecords } from "../pages/StaffManagement/api/staffApi";
import { apiUserToStaffMember } from "../pages/StaffManagement/api/staffMappers";
// NOTE: adjust this path if templateRendering.ts lives elsewhere in your tree —
// it's the same resolver resolvePeopleRenderingModel/StaffManagement.tsx use,
// kept as the single source of truth for "which people types actually exist
// for this org right now" so this legacy snapshot can't drift from the
// Directory's own filtering rules.
import { resolveActivePeopleTypes } from "../utils/templateRendering";

import {
  getAttendanceToday,
  type TodayAttendanceRecord,
} from "../pages/attendance_temp/api/attendanceApi";

import {
  getLeaves,
  type LeaveRequest as ApiLeaveRequest,
} from "../pages/LeaveManagement/api/leaveApi";

import {
  getSalaryConfigs,
  type PayrollSalaryConfig,
} from "../pages/Payroll/api/payrollApi";

import {
  getOvertime,
  type OvertimeRecord as ApiOvertimeRecord,
} from "../api/api";

// ─── Canonical production domain types ───────────────────────────────────────

export interface StaffMember {
  id: string;
  userId?: string | number;

  name: string;
  email?: string;
  phone?: string;

  branchId?: number | null;
  branchName?: string;
  branchCity?: string;

  department?: string;
  position?: string;
  role?: string;

  employeeId?: string;
  cnic?: string;
  salary?: number;
  joinDate?: string;

  shift?: string;
  shiftId?: string;
  shiftLabel?: string;
  dutyStart?: string;
  dutyEnd?: string;
  staffType?: string;

  status?: string;
  statusToday?: string;

  accessModules?: string[];
  profileImageUrl?: string;
  profileImageName?: string;
  trainingVideoUrl?: string;
  trainingVideoName?: string;

  createdAt?: string;
  updatedAt?: string;

  [key: string]: unknown;
}

export type LeaveRequest = ApiLeaveRequest & {
  branchId?: number | null;
  branchName?: string;
};

export type PayrollRecord = Partial<PayrollSalaryConfig> & {
  id: string;
  /** Supabase client_staff IDs are UUID strings; legacy SQLite users may still be numeric. */
  userId: string | number;
  staffId?: string | number;
  empId?: string;
  name: string;
  department: string;
  branchId?: number | string | null;
  backendBranchId?: string | number | null;
  branchName?: string;
  amount?: number;
  salary?: number;
  basicSalary: number;
  allowances: number;
  deductions: number;
  netPay: number;
  overtimeAmount: number;
  effectiveFrom?: string;
  createdAt?: string;
  updatedAt?: string;
};

export interface AttendanceRecord {
  id: string;
  /** Supabase client_staff IDs are UUID strings; legacy SQLite users may still be numeric. */
  userId: string | number;
  staffId: string;
  userName: string;
  name: string;
  /** UI branch id is numeric in the dashboard; backendBranchId preserves Supabase UUID when present. */
  branchId: number | string | null;
  backendBranchId?: string | number | null;
  branchName: string;
  department: string;
  status: "Present" | "Late" | "Absent";
  timestamp: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OvertimeRequest {
  id: string;
  /** Supabase client_staff IDs are UUID strings; legacy SQLite users may still be numeric. */
  userId: string | number;
  staffId: string;
  userName: string;
  staffName: string;
  name: string;
  branchId: number | string | null;
  backendBranchId?: string | number | null;
  branchName: string;
  department: string;
  peopleType: string;
  people_type?: string;
  /** Backend canonical date. */
  otDate: string;
  /** UI alias used by overtime filters/export. */
  date: string;
  hours: number;
  reason: string;
  task?: string;
  status: "pending" | "approved" | "rejected" | string;
  approvedBy?: string | null;
  appliedOn: string;
  rejectionNote?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type { CctvDevice, CctvScopedStore };

// ─── Store contracts ─────────────────────────────────────────────────────────

export interface ScopedStore<T> {
  items: T[];
  allItems: T[];
  add: (draft: Omit<T, "id" | "createdAt" | "updatedAt">) => void;
  update: (id: string, patch: Partial<T>) => void;
  remove: (id: string) => void;
  reset: (items: T[]) => void;
}

export interface ModuleContextValue {
  staff: ScopedStore<StaffMember>;
  leave: ScopedStore<LeaveRequest>;
  payroll: ScopedStore<PayrollRecord>;
  attendance: ScopedStore<AttendanceRecord>;
  overtime: ScopedStore<OvertimeRequest>;
  cctv: CctvScopedStore;

  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type AnyRecord = Record<string, any>;

type TenantScopeParams = {
  organizationId: string;
  organization_id: string;
  org_id: string;
};

function buildTenantScope(
  organizationId: string | number | null | undefined,
): TenantScopeParams {
  const id = String(organizationId || "").trim();
  return {
    organizationId: id,
    organization_id: id,
    org_id: id,
  };
}

type BackendModule =
  | "staff"
  | "attendance"
  | "leave"
  | "payroll"
  | "overtime"
  | "cctv";

const BACKEND_MODULE_ALIASES: Record<BackendModule, string[]> = {
  staff: [
    "staff",
    "employee",
    "employees",
    "staffdirectory",
    "staffmanagement",
    "employee management",
  ],
  attendance: [
    "attendance",
    "attendancemanagement",
    "attendance management",
    "biometricattendance",
    "biometric attendance",
  ],
  leave: ["leave", "leaves", "leavemanagement", "leave management"],
  payroll: [
    "payroll",
    "salary",
    "salaries",
    "payrollmanagement",
    "payroll management",
  ],
  overtime: ["overtime", "ot", "overtimemanagement", "overtime management"],
  cctv: [
    "cctv",
    "camera",
    "cameras",
    "livecctv",
    "live cctv",
    "cctvtracking",
    "cctv tracking",
    "security",
  ],
};

function normalizeModuleKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isBackendModuleActive(
  enabledModules: string[],
  moduleKey: BackendModule,
): boolean {
  const normalizedEnabled = new Set(enabledModules.map(normalizeModuleKey));

  if (normalizedEnabled.has("all") || normalizedEnabled.has("*")) {
    return true;
  }

  return BACKEND_MODULE_ALIASES[moduleKey].some((alias) =>
    normalizedEnabled.has(normalizeModuleKey(alias)),
  );
}

function rowBelongsToOrg(
  row: AnyRecord,
  organizationId: string | number,
): boolean {
  const rowOrgId =
    row.organizationId ??
    row.organization_id ??
    row.orgId ??
    row.org_id ??
    row.organization?.id ??
    null;

  // Some legacy endpoints do not return org fields. Keep those rows for now,
  // but drop any row that explicitly belongs to a different organization.
  if (rowOrgId == null || String(rowOrgId).trim() === "") return true;

  return String(rowOrgId) === String(organizationId);
}

function normalizeScopedRows<T extends AnyRecord>(
  rows: T[] | undefined | null,
  organizationId: string | number,
): T[] {
  return Array.isArray(rows)
    ? rows.filter((row) => rowBelongsToOrg(row, organizationId))
    : [];
}

async function getScopedLeaves(
  scope: TenantScopeParams,
): Promise<ApiLeaveRequest[]> {
  return (
    getLeaves as unknown as (
      params?: TenantScopeParams,
    ) => Promise<ApiLeaveRequest[]>
  )(scope);
}

async function getScopedAttendanceToday(
  scope: TenantScopeParams,
): Promise<TodayAttendanceRecord[]> {
  return (
    getAttendanceToday as unknown as (
      params?: TenantScopeParams,
    ) => Promise<TodayAttendanceRecord[]>
  )(scope);
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getEntityId(item: AnyRecord): string {
  return String(item.id ?? item.userId ?? item.user_id ?? crypto.randomUUID());
}

function getEntityBranchId(item: AnyRecord): number | null {
  return toOptionalNumber(item.branchId ?? item.branch_id);
}

function scopedItems<T extends AnyRecord>(
  items: T[],
  activeBranchId: number | null,
): T[] {
  if (activeBranchId == null) return items;

  return items.filter(
    (item) => Number(getEntityBranchId(item)) === Number(activeBranchId),
  );
}

function normalizeAttendanceStatus(
  status: string | null | undefined,
): "Present" | "Late" | "Absent" {
  const value = String(status ?? "").toLowerCase();

  if (value.includes("late")) return "Late";
  if (value.includes("absent")) return "Absent";

  return "Present";
}

function mapTodayAttendance(
  row: TodayAttendanceRecord | AnyRecord,
): AttendanceRecord {
  const raw = row as AnyRecord;
  const userId = raw.userId ?? raw.user_id ?? raw.staffId ?? raw.staff_id ?? "";
  const branchId = raw.branchId ?? raw.branch_id ?? null;
  const userName =
    raw.userName ?? raw.user_name ?? raw.staff_name ?? raw.name ?? "Unknown";

  return {
    id: String(raw.id ?? crypto.randomUUID()),
    userId: userId === "" ? "unknown" : userId,
    staffId: String(
      userId === "" ? (raw.staff_id ?? raw.id ?? "unknown") : userId,
    ),
    userName: String(userName),
    name: String(userName),
    branchId,
    backendBranchId:
      raw.backendBranchId ?? raw.backend_branch_id ?? raw.branch_uuid ?? null,
    branchName: String(raw.branchName ?? raw.branch_name ?? ""),
    department: String(raw.department ?? ""),
    status: normalizeAttendanceStatus(raw.status),
    timestamp: String(
      raw.checkIn ??
        raw.check_in ??
        raw.timestamp ??
        raw.createdAt ??
        raw.created_at ??
        "",
    ),
    createdAt: raw.createdAt ?? raw.created_at ?? undefined,
    updatedAt: raw.updatedAt ?? raw.updated_at ?? undefined,
  };
}

function mapPayroll(row: PayrollSalaryConfig | AnyRecord): PayrollRecord {
  const raw = row as AnyRecord;
  const userId =
    raw.userId ?? raw.user_id ?? raw.staffId ?? raw.staff_id ?? "unknown";
  const staffId = raw.staffId ?? raw.staff_id ?? userId;
  const basicSalary = Number(
    raw.basicSalary ??
      raw.basic_salary ??
      raw.baseSalary ??
      raw.base_salary ??
      0,
  );
  const allowances = Number(raw.allowances ?? raw.allowance ?? 0);
  const deductions = Number(raw.deductions ?? raw.deduction ?? 0);
  const computedNetPay = Math.max(0, basicSalary + allowances - deductions);
  const netPay = Number(raw.netPay ?? raw.net_pay ?? computedNetPay);

  return {
    ...(row as Partial<PayrollSalaryConfig>),
    id: String(raw.id ?? raw.payrollId ?? raw.payroll_id ?? staffId),
    userId,
    staffId,
    empId: String(raw.empId ?? raw.employeeId ?? raw.employee_id ?? staffId),
    name: String(
      raw.name ??
        raw.userName ??
        raw.user_name ??
        raw.staffName ??
        raw.staff_name ??
        "Unknown",
    ),
    department: String(raw.department ?? raw.dept ?? ""),
    branchId: raw.branchId ?? raw.branch_id ?? null,
    backendBranchId:
      raw.backendBranchId ?? raw.backend_branch_id ?? raw.branch_uuid ?? null,
    branchName: String(raw.branchName ?? raw.branch_name ?? ""),
    basicSalary,
    allowances,
    deductions,
    netPay,
    amount: netPay,
    salary: basicSalary,
    overtimeAmount: Number(raw.overtimeAmount ?? raw.overtime_amount ?? 0),
    effectiveFrom: raw.effectiveFrom ?? raw.effective_from ?? undefined,
    createdAt: raw.createdAt ?? raw.created_at ?? undefined,
    updatedAt: raw.updatedAt ?? raw.updated_at ?? undefined,
  };
}

function normalizeOvertimeStatus(
  status: unknown,
): "Pending" | "Approved" | "Rejected" | string {
  const value = String(status ?? "pending")
    .trim()
    .toLowerCase();
  if (value === "approved") return "Approved";
  if (value === "rejected") return "Rejected";
  if (value === "pending") return "Pending";
  return String(status ?? "Pending");
}

function mapOvertime(row: ApiOvertimeRecord | AnyRecord): OvertimeRequest {
  const raw = row as AnyRecord;
  const userId = raw.user_id ?? raw.userId ?? raw.staff_id ?? raw.staffId ?? "";
  const userName =
    raw.user_name ??
    raw.userName ??
    raw.staffName ??
    raw.staff_name ??
    raw.name ??
    "Unknown";
  const otDate = String(raw.ot_date ?? raw.otDate ?? raw.date ?? "");
  const createdAt = raw.created_at ?? raw.createdAt ?? "";
  const _rawReason = String(raw.reason ?? raw.task ?? "");
  // Remove any embedded attendance id tokens like `(attendance_id=... )`
  // or `attendance_id=...` that may have been appended by backend jobs.
  const reason = _rawReason
    .replace(/\(?\s*attendance_id\s*=\s*[\w-]+\s*\)?/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\(\s*\)/g, "")
    .trim();
  const peopleType = String(
    raw.peopleType ?? raw.people_type ?? "staff",
  ).toLowerCase();

  return {
    id: String(raw.id ?? crypto.randomUUID()),
    userId: userId === "" ? "unknown" : userId,
    staffId: String(
      userId === "" ? (raw.staff_id ?? raw.id ?? "unknown") : userId,
    ),
    userName: String(userName),
    staffName: String(userName),
    name: String(userName),
    branchId: raw.branch_id ?? raw.branchId ?? null,
    backendBranchId:
      raw.backendBranchId ?? raw.backend_branch_id ?? raw.branch_uuid ?? null,
    branchName: String(raw.branch_name ?? raw.branchName ?? ""),
    department: String(raw.department ?? ""),
    peopleType,
    people_type: peopleType,
    otDate,
    date: otDate,
    hours: Number(raw.hours ?? 0),
    reason,
    task: reason,
    status: normalizeOvertimeStatus(raw.status),
    approvedBy: raw.approved_by ?? raw.approvedBy ?? null,
    appliedOn: String(raw.appliedOn ?? createdAt ?? ""),
    rejectionNote: raw.rejectionNote ?? raw.rejection_note ?? null,
    createdAt: createdAt || undefined,
    updatedAt: raw.updated_at ?? raw.updatedAt,
  };
}

// ─── Runtime backend snapshot store ──────────────────────────────────────────

export function useBackendStore<T extends AnyRecord>(): ScopedStore<T> {
  const [rows, setRows] = useState<T[]>([]);

  const reset = useCallback((items: T[]) => {
    setRows(items);
  }, []);

  const add = useCallback(
    (draft: Omit<T, "id" | "createdAt" | "updatedAt">) => {
      const now = new Date().toISOString();
      setRows((prev) => [
        {
          ...(draft as T),
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        },
        ...prev,
      ]);
    },
    [],
  );

  const update = useCallback((id: string, patch: Partial<T>) => {
    setRows((prev) =>
      prev.map((item) =>
        getEntityId(item) === String(id)
          ? {
              ...item,
              ...patch,
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    );
  }, []);

  const remove = useCallback((id: string) => {
    setRows((prev) => prev.filter((item) => getEntityId(item) !== String(id)));
  }, []);

  return useMemo(
    () => ({
      items: rows,
      allItems: rows,
      add,
      update,
      remove,
      reset,
    }),
    [rows, add, update, remove, reset],
  );
}

function scopeStore<T extends AnyRecord>(
  store: ScopedStore<T>,
  activeBranchId: number | null,
): ScopedStore<T> {
  const items = scopedItems(store.allItems, activeBranchId);

  return {
    ...store,
    items,
  };
}

// ─── CCTV adapter: backend org config cameras → CctvScopedStore ──────────────

function useCctvStoreAdapter(args: {
  activeBranchId: number | null;
  allCctvDevices: CctvDevice[];
  camerasByBranch: Record<number, OrgCamera[]>;
  updateCameras: (cameras: Record<number, OrgCamera[]>) => void;
}): CctvScopedStore {
  const { activeBranchId, allCctvDevices, camerasByBranch, updateCameras } =
    args;

  const items = useMemo<CctvDevice[]>(
    () =>
      activeBranchId === null
        ? allCctvDevices
        : allCctvDevices.filter((device) => device.branchId === activeBranchId),
    [activeBranchId, allCctvDevices],
  );

  const add = useCallback(
    (draft: Omit<CctvDevice, "id" | "createdAt" | "updatedAt">) => {
      const branchId = Number(draft.branchId);
      const existing = camerasByBranch[branchId] ?? [];
      const index = existing.length + 1;
      const cameraId = `cam_${branchId}_${index}_${Date.now()}`;

      const newCamera: OrgCamera = {
        id: cameraId,
        branchId,
        name: draft.cameraName || draft.location,
        location: draft.location,
        rtspUrl: `rtsp://localhost/branch_${branchId}_cam${index}`,
        streamPath: `/api/stream/${cameraId}`,
        status: draft.status,
        lastSeen: draft.lastSeen,
      };

      updateCameras({
        ...camerasByBranch,
        [branchId]: [...existing, newCamera],
      });
    },
    [camerasByBranch, updateCameras],
  );

  const update = useCallback(
    (id: string, patch: Partial<CctvDevice>) => {
      const next: Record<number, OrgCamera[]> = {};

      Object.entries(camerasByBranch).forEach(([key, cameras]) => {
        next[Number(key)] = cameras.map((camera) => {
          if (camera.id !== id) return camera;

          return {
            ...camera,
            ...(patch.cameraName !== undefined
              ? { name: patch.cameraName }
              : {}),
            ...(patch.location !== undefined
              ? { location: patch.location }
              : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.lastSeen !== undefined
              ? { lastSeen: patch.lastSeen }
              : {}),
          };
        });
      });

      updateCameras(next);
    },
    [camerasByBranch, updateCameras],
  );

  const remove = useCallback(
    (id: string) => {
      const next: Record<number, OrgCamera[]> = {};

      Object.entries(camerasByBranch).forEach(([key, cameras]) => {
        next[Number(key)] = cameras.filter((camera) => camera.id !== id);
      });

      updateCameras(next);
    },
    [camerasByBranch, updateCameras],
  );

  return useMemo<CctvScopedStore>(
    () => ({
      items,
      allItems: allCctvDevices,
      add,
      update,
      remove,
    }),
    [items, allCctvDevices, add, update, remove],
  );
}

// ─── Context ─────────────────────────────────────────────────────────────────

const ModuleContext = createContext<ModuleContextValue | null>(null);

export function ModuleProvider({ children }: { children: React.ReactNode }) {
  const {
    activeBranchId,
    allCctvDevices,
    cfg,
    updateCfg,
    organizationId,
    isOrgReady,
  } = useOrg();

  const staffStore = useBackendStore<StaffMember>();
  const leaveStore = useBackendStore<LeaveRequest>();
  const payrollStore = useBackendStore<PayrollRecord>();
  const attendanceStore = useBackendStore<AttendanceRecord>();
  const overtimeStore = useBackendStore<OvertimeRequest>();

  // Keep initial paint instant. Data hydrates in the background.
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isOrgReady) {
      staffStore.reset([]);
      leaveStore.reset([]);
      payrollStore.reset([]);
      attendanceStore.reset([]);
      overtimeStore.reset([]);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }

    setRefreshing(true);
    setError(null);

    try {
      if (!organizationId) {
        staffStore.reset([]);
        leaveStore.reset([]);
        payrollStore.reset([]);
        attendanceStore.reset([]);
        overtimeStore.reset([]);
        return;
      }

      const scope = buildTenantScope(organizationId);
      const orgKey = scope.organizationId;

      const staffModuleEnabled = isBackendModuleActive(cfg.modules, "staff");
      const attendanceModuleEnabled = isBackendModuleActive(
        cfg.modules,
        "attendance",
      );
      const leaveModuleEnabled = isBackendModuleActive(cfg.modules, "leave");
      const payrollModuleEnabled = isBackendModuleActive(
        cfg.modules,
        "payroll",
      );
      const overtimeModuleEnabled = isBackendModuleActive(
        cfg.modules,
        "overtime",
      );

      /*
       * Staff records are used as base data by attendance, leave and payroll
       * dashboards too. Keep hydrating staff when any dependent module is
       * enabled, while still clearing completely inactive modules below.
       */
      const shouldHydrateStaff =
        staffModuleEnabled ||
        attendanceModuleEnabled ||
        leaveModuleEnabled ||
        payrollModuleEnabled ||
        overtimeModuleEnabled;

      const [staffRows, leaveRows, payrollRows, todayRows, overtimeRows] =
        await Promise.all([
          shouldHydrateStaff
            ? listStaffRecords({
                role: "staff",
                organizationId: orgKey,
                organization_id: orgKey,
                org_id: orgKey,
              } as any)
            : Promise.resolve([]),
          leaveModuleEnabled ? getScopedLeaves(scope) : Promise.resolve([]),
          payrollModuleEnabled
            ? getSalaryConfigs({
                organizationId: orgKey,
                organization_id: orgKey,
                org_id: orgKey,
              } as any)
            : Promise.resolve([]),
          attendanceModuleEnabled
            ? getScopedAttendanceToday(scope)
            : Promise.resolve([]),
          overtimeModuleEnabled
            ? getOvertime({
                organization_id: orgKey,
                organizationId: orgKey,
                org_id: orgKey,
              } as any)
            : Promise.resolve([]),
        ]);

      staffStore.reset(
        shouldHydrateStaff
          ? (() => {
              const activeTypes = new Set(
                resolveActivePeopleTypes(
                  cfg as unknown as Record<string, unknown>,
                ),
              );
              return normalizeScopedRows(staffRows as AnyRecord[], orgKey)
                .map((row) => apiUserToStaffMember(row as any) as StaffMember)
                .filter(
                  (member) =>
                    activeTypes.size === 0 ||
                    activeTypes.has(
                      String(
                        member.peopleType || member.people_type || "staff",
                      ).toLowerCase(),
                    ),
                );
            })()
          : [],
      );
      leaveStore.reset(
        leaveModuleEnabled
          ? (normalizeScopedRows(
              leaveRows as AnyRecord[],
              orgKey,
            ) as LeaveRequest[])
          : [],
      );
      payrollStore.reset(
        payrollModuleEnabled
          ? normalizeScopedRows(payrollRows as AnyRecord[], orgKey).map((row) =>
              mapPayroll(row as PayrollSalaryConfig),
            )
          : [],
      );
      attendanceStore.reset(
        attendanceModuleEnabled
          ? normalizeScopedRows(todayRows as AnyRecord[], orgKey).map((row) =>
              mapTodayAttendance(row as TodayAttendanceRecord),
            )
          : [],
      );
      overtimeStore.reset(
        overtimeModuleEnabled
          ? normalizeScopedRows(overtimeRows as AnyRecord[], orgKey).map(
              (row) => mapOvertime(row as ApiOvertimeRecord),
            )
          : [],
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to hydrate module data from backend.",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [
    isOrgReady,
    organizationId,
    cfg,
    staffStore.reset,
    leaveStore.reset,
    payrollStore.reset,
    attendanceStore.reset,
    overtimeStore.reset,
  ]);

  // Do not auto-hydrate every module on app/dashboard mount.
  // Module pages use their own paginated hooks; this legacy snapshot refreshes
  // only when a consumer explicitly calls module.refresh().
  useEffect(() => {
    if (!isOrgReady) {
      staffStore.reset([]);
      leaveStore.reset([]);
      payrollStore.reset([]);
      attendanceStore.reset([]);
      overtimeStore.reset([]);
    }
  }, [
    isOrgReady,
    staffStore.reset,
    leaveStore.reset,
    payrollStore.reset,
    attendanceStore.reset,
    overtimeStore.reset,
  ]);

  const updateCameras = useCallback(
    (cameras: Record<number, OrgCamera[]>) => updateCfg({ cameras }),
    [updateCfg],
  );

  const cctv = useCctvStoreAdapter({
    activeBranchId,
    allCctvDevices,
    camerasByBranch: cfg.cameras,
    updateCameras,
  });

  const value = useMemo<ModuleContextValue>(
    () => ({
      staff: scopeStore(staffStore, activeBranchId),
      leave: scopeStore(leaveStore, activeBranchId),
      payroll: scopeStore(payrollStore, activeBranchId),
      attendance: scopeStore(attendanceStore, activeBranchId),
      overtime: scopeStore(overtimeStore, activeBranchId),
      cctv,

      loading,
      refreshing,
      error,
      refresh,
    }),
    [
      staffStore,
      leaveStore,
      payrollStore,
      attendanceStore,
      overtimeStore,
      activeBranchId,
      cctv,
      loading,
      refreshing,
      error,
      refresh,
    ],
  );

  return (
    <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>
  );
}

export function useModule(): ModuleContextValue {
  const ctx = useContext(ModuleContext);
  if (!ctx) throw new Error("useModule must be used inside ModuleProvider");
  return ctx;
}
