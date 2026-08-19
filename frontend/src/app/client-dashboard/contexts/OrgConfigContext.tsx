/**
 * OrgConfigContext.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for organization master/configuration data.
 *
 * Owns:
 *   branches, departments, roles, enabled modules, cameras, users,
 *   staff shift definitions, employee profile overrides.
 *
 * Does NOT own:
 *   transactional/module entity rows such as staff, leave, payroll, attendance.
 *   Those live in ModuleContext and backend/module APIs.
 *
 * Backend source of truth:
 *   Client dashboard configuration is loaded from Flask → Supabase via
 *   /api/client/bootstrap. localStorage is used only for auth/session state,
 *   never as the permanent source for organization configuration.
 *
 * Fixes applied:
 *   [Fix-3] cameraToCctvDevice — camera.location is now preferred over camera.name
 *           for CctvDevice.location. camera.name is exposed as a separate field so
 *           no information is lost. This matches OrgCamera semantics where `name`
 *           is the human label ("Main Entrance") and `location` is the physical
 *           placement ("Ground Floor"). Previously the adapter silently discarded
 *           `location` by mapping only `camera.name`.
 *
 *   [Fix-4] CctvScopedStore — replaces the ScopedStore<CctvDevice> alias used in
 *           ModuleContext. Omits `reset` because CCTV data lives in cfg.cameras
 *           and must be updated via updateCfg({ cameras }). A silent no-op `reset`
 *           would cause invisible data-loss bugs during backend migration.
 *           Consumers that need CCTV reset must call updateCfg directly.
 *
 *   [Fix-6] normalizeOrgConfig no longer auto-seeds default CCTV cameras for
 *           every branch. CCTV is now configuration-driven: branches without
 *           cameras remain empty and dashboard CCTV widgets stay hidden.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCurrentOrganization } from "../api/api";
import { useAuth } from "./useAuth";
import { resolvePeopleTypesFromBizType } from "../utils/templateRendering";
import {
  isSessionExpiryHandled,
  handleSessionExpired,
} from "../api/sessionExpired";
import { ApiRequestError } from "../api/apiClient";

// ─── Master data types ────────────────────────────────────────────────────────

export interface OrgBranch {
  id: number;
  name: string;
  city?: string;
  timezone?: string;
  backendBranchId?: string | null;
}

export interface OrgDepartment {
  id?: number;
  name: string;
  className?: string;
  sectionName?: string;
  personFamily?: "student" | "workforce";
  peopleType?: string;
  itemKind?: "group" | "class_section";
}

export interface OrgRole {
  id?: number;
  name: string;
  level?: number;
  personFamily?: "student" | "workforce";
  peopleType?: string;
}

export interface OrgCamera {
  id: string;
  branchId: number;
  /** Human label, e.g. "Main Entrance". Shown in UI lists and dropdowns. */
  name: string;
  /**
   * Physical placement, e.g. "Ground Floor" or "Basement".
   * Falls back to `name` when not provided during normalization.
   * Always prefer this field for location display in tracking views.
   */
  location: string;
  rtspUrl: string;
  /** Absent/legacy rows are treated as "nvr" wherever this is read. */
  cameraType?: "nvr" | "dvr" | "ip_camera" | "webcam";
  status?: "Normal" | "Alert" | "Offline";
  lastSeen?: string;
  streamPath?: string;
}

export type StaffWorkType = "office" | "field";
export type ShiftKey = "morning" | "evening" | "night" | "custom";

export interface ShiftDefinition {
  id: ShiftKey;
  label: string;
  start: string;
  end: string;
}

export interface OrgUserRecord {
  id: string;
  staffId: string;
  name: string;
  email: string;
  username: string;
  password?: string;

  /** Dashboard/admin profile media. Backend can later return permanent URLs. */
  profileImageUrl?: string;
  avatarUrl?: string;
  profileImageName?: string;

  role: "staff" | "branch_admin" | "admin";
  status: "active" | "inactive" | "pending";
  branchId: number;
  branchName: string;
  staffType: StaffWorkType;
  allowedBranchIds: number[];
  allowedModules: string[];
  portalAccess: {
    desktopDashboard: boolean;
    flutterStaffPortal: boolean;
  };
  dashboardScope: "global" | "branch";
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeProfileOverride {
  /** Must match DummyStaffMember.id, userId, or employeeId. */
  employeeId: string;
  userId?: string;
  name?: string;
  email?: string;
  phone?: string;
  profileImageUrl?: string;
  profileImageName?: string;
  /** Password is never stored here. Only metadata is stored. */
  passwordChangedAt?: string;
  mustChangePassword?: boolean;
  updatedAt: string;
}

/**
 * Mirrors AllowanceType in pages/Payroll/api/payrollApi.ts. Duplicated
 * here (rather than imported) because that module sits under
 * pages/Payroll, and OrgConfigContext is a much lower-level provider
 * that a lot of non-payroll code also imports — pulling the payroll API
 * module in here would drag its whole dependency surface along with it.
 * Keep these two shapes in lockstep by hand.
 */
export type PayrollAllowanceMode = "fixed" | "percent" | "none";
export interface PayrollAllowanceType {
  label: string;
  mode: PayrollAllowanceMode;
  value: number;
}

export interface PayrollPolicy {
  /**
   * PKR rate applied per overtime hour across all branches.
   * Default: 500. Validated by normalizePayrollPolicy — always a positive number.
   */
  otRatePerHour: number;

  /**
   * Fallback base salary used when a staff record has no salary configured.
   * Default: 50_000. Validated by normalizePayrollPolicy — always a positive number.
   */
  defaultSalary: number;

  /**
   * Org-wide catalog of named allowance types (Transport, Housing, ...),
   * keyed by lowercase slug. Read-only here — the Payroll Rules modal in
   * PayrollModule.tsx is the only editor; OrgConfigContext just carries
   * whatever the backend returns through to consumers like the per-staff
   * Allowances checklist. Defaults to {} so orgs with no allowances
   * configured yet don't need a null-check at every call site.
   */
  allowanceTypes: Record<string, PayrollAllowanceType>;
}

export interface OrgConfig {
  bizType: string | null;
  businessType: string | null;
  primaryPeopleType: string;
  enabledPeopleTypes: string[];
  attendancePeopleTypes: string[];
  shiftEnabledPeopleTypes?: string[];
  modulePeopleTypesByBranch: Record<string, Record<string, string[]>>;
  module_people_types_by_branch: Record<string, Record<string, string[]>>;
  /**
   * Support-owned commercial scope (Organization.enabled_staff_types):
   * which staff work types ("office" | "field") this org is entitled to
   * add in the Client Dashboard's Add/Edit Staff form. Defaults to both
   * so pre-existing orgs (and legacy/offline bootstraps) are never
   * over-restricted client-side — the backend remains the hard enforcer
   * via _clip_access_modules/create_client_staff either way.
   */
  enabledStaffTypes: StaffWorkType[];
  enabled_staff_types: StaffWorkType[];
  verticalConfig: Record<string, unknown>;
  terminologyOverrides: Record<string, unknown>;
  orgName: string;
  tagline: string;
  address: string;
  size: string;
  logo: string | null;

  /** Support-owned commercial/runtime limits. */
  attendanceMode: "cloud" | "local" | string | null;
  attendance_mode: "cloud" | "local" | string | null;
  maxBranches: number;
  max_branches: number;

  /** Master/configured data. */
  branches: OrgBranch[];
  departments: Record<number, OrgDepartment[]>;
  roles: Record<number, OrgRole[]>;
  modules: string[];
  cameras: Record<number, OrgCamera[]>;
  staffShiftDefinitions: ShiftDefinition[];

  /**
   * Live CCTV data source.
   * "mock" = derive from cfg.cameras deterministically (default, no network).
   * "api"  = fetch from LIVE_CCTV_ENDPOINT at runtime.
   *
   * [Fix-5] Moving this from a bundle-time env constant into org config makes
   * it runtime-configurable per org/deployment without a rebuild. The env var
   * VITE_LIVE_CCTV_SOURCE is still read as the *initial* value so existing
   * deployments are unaffected.
   */
  liveCctvSource: "mock" | "api";

  /** Auth/profile metadata kept with org config until backend migration. */
  users: OrgUserRecord[];
  employeeProfiles: Record<string, EmployeeProfileOverride>;

  /** Org-wide payroll calculation rules. */
  payrollPolicy: PayrollPolicy;
}

// ─── Fix-3: CctvDevice — location is now the physical placement, not the label ─

export interface CctvDevice {
  id: string;
  branchId: number;
  branchName: string;
  branchCity?: string;
  cameraType?: "nvr" | "dvr" | "ip_camera" | "webcam";
  /**
   * Human label / camera name, e.g. "Main Entrance".
   * Previously this was silently mapped into `location`, discarding the actual
   * `location` field from OrgCamera. Now both fields are preserved.
   */
  cameraName: string;
  /**
   * Physical placement, e.g. "Ground Floor" or "Basement".
   * Preferred over cameraName for location display — see
   * cameraToCctvDevice below.
   */
  location: string;
  status?: "Normal" | "Alert" | "Offline";
  lastSeen?: string;
}

// ─── Fix-4: CctvScopedStore — no silent reset ────────────────────────────────

/**
 * Narrower store interface for CCTV devices.
 *
 * `reset` is intentionally omitted. CCTV data is derived from cfg.cameras,
 * which is master config data owned by OrgConfigContext. To reset or replace
 * cameras, call `updateCfg({ cameras: newCamerasRecord })` directly.
 *
 * A silent no-op `reset` (the previous behaviour) breaks the Liskov
 * substitution principle and would cause invisible data-loss bugs when a
 * backend migration tries to hydrate CCTV data via the store interface.
 */
export interface CctvScopedStore {
  /** Scoped to active branch, or all when activeBranchId is null. */
  items: CctvDevice[];
  /** Entire device list across all branches. */
  allItems: CctvDevice[];
  add: (draft: Omit<CctvDevice, "id" | "createdAt" | "updatedAt">) => void;
  update: (id: string, patch: Partial<CctvDevice>) => void;
  remove: (id: string) => void;
}

export interface OrgMasterData {
  bizType: string | null;
  branches: OrgBranch[];
  departmentsByBranch: Record<number, OrgDepartment[]>;
  rolesByBranch: Record<number, OrgRole[]>;
  modules: string[];
  camerasByBranch: Record<number, OrgCamera[]>;
  staffShiftDefinitions: ShiftDefinition[];
  users: OrgUserRecord[];
  liveCctvSource: "mock" | "api";

  getBranch: (id: number) => OrgBranch | undefined;
  getBranchName: (id: number) => string;
  getDepartments: (branchId: number) => OrgDepartment[];
  getRoles: (branchId: number) => OrgRole[];
  getCameras: (branchId: number) => OrgCamera[];
}

export interface OrgContextValue {
  cfg: OrgConfig;

  organizationId: number | string | null;
  organizationSlug: string | null;
  organizationName: string | null;
  isOrgReady: boolean;

  masterData: OrgMasterData;
  updateCfg: (patch: Partial<OrgConfig>) => void;
  refreshOrgConfig: () => Promise<void>;
  isRefreshingOrgConfig: boolean;

  activeBranchId: number | null;
  setActiveBranchId: (id: number | null) => void;

  cameras: OrgCamera[];
  allCameras: OrgCamera[];
  allCctvDevices: CctvDevice[];
  visibleBranches: OrgBranch[];
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_SHIFT_DEFINITIONS: ShiftDefinition[] = [
  { id: "morning", label: "Morning", start: "09:00", end: "17:00" },
  { id: "evening", label: "Evening", start: "14:00", end: "22:00" },
  { id: "night", label: "Night", start: "22:00", end: "06:00" },
  { id: "custom", label: "Custom", start: "10:00", end: "18:00" },
];

/**
 * [Fix-5] Read the initial liveCctvSource from the env var so existing
 * deployments that set VITE_LIVE_CCTV_SOURCE=api are unaffected. Once the org
 * config is persisted the stored value takes precedence.
 */
const ENV_LIVE_CCTV_SOURCE: "mock" | "api" =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_LIVE_CCTV_SOURCE === "api"
    ? "api"
    : "mock";

const DEFAULT_ORG_CONFIG: OrgConfig = {
  bizType: null,
  businessType: null,
  primaryPeopleType: "staff",
  enabledPeopleTypes: ["staff"],
  attendancePeopleTypes: ["staff"],
  shiftEnabledPeopleTypes: [],
  modulePeopleTypesByBranch: {},
  module_people_types_by_branch: {},
  enabledStaffTypes: ["office", "field"],
  enabled_staff_types: ["office", "field"],
  verticalConfig: {},
  terminologyOverrides: {},
  orgName: "",
  tagline: "",
  address: "",
  size: "",
  logo: null,
  attendanceMode: null,
  attendance_mode: null,
  maxBranches: 0,
  max_branches: 0,
  branches: [],
  departments: {},
  roles: {},
  modules: [],
  cameras: {},
  staffShiftDefinitions: DEFAULT_SHIFT_DEFINITIONS,
  liveCctvSource: ENV_LIVE_CCTV_SOURCE,
  users: [],
  employeeProfiles: {},
  payrollPolicy: {
    otRatePerHour: 500,
    defaultSalary: 50_000,
    allowanceTypes: {},
  },
};

const DEFAULT_CAMERA_TEMPLATES: Array<{ name: string; location: string }> = [
  { name: "Main Entrance", location: "Ground Floor" },
  { name: "Reception", location: "Ground Floor" },
  { name: "Server Room Door", location: "Basement" },
];

const STORAGE_KEY = "orgConfig";

// ─── Generic utilities ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqStrings(values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

/** Returns the first non-empty string among candidates, trimmed. */
function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function seededNumber(key: string, range: number): number {
  if (range <= 0) return 0;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % range;
}

// ─── CCTV helpers ────────────────────────────────────────────────────────────

export function buildStreamUrl(camera: OrgCamera): string {
  if (!camera.rtspUrl) return "";
  return `/api/stream/${encodeURIComponent(camera.id)}?url=${encodeURIComponent(camera.rtspUrl)}`;
}

export function buildDefaultCamerasForBranch(branchId: number): OrgCamera[] {
  return DEFAULT_CAMERA_TEMPLATES.map((tpl, i) => ({
    id: `cam_${branchId}_${i + 1}`,
    branchId,
    name: tpl.name,
    location: tpl.location,
    rtspUrl: "",
  }));
}

const SEEDED_STATUSES: Array<CctvDevice["status"]> = [
  "Normal",
  "Normal",
  "Normal",
  "Normal",
  "Normal",
  "Normal",
  "Offline",
  "Offline",
  "Alert",
];

const LAST_SEEN_OPTIONS = [
  "Just Now",
  "12s ago",
  "28s ago",
  "45s ago",
  "1m ago",
  "2m ago",
  "3m ago",
];

/**
 * [Fix-3] cameraToCctvDevice
 *
 * Previous behaviour: `location: camera.name` — always used the camera label
 * ("Main Entrance") as the location, silently discarding `camera.location`
 * ("Ground Floor"). This caused LiveCCTVTracking to show camera names in
 * the Location column instead of physical placements.
 *
 * Fixed behaviour:
 *   - `cameraName` = camera.name   (the human label, e.g. "Main Entrance")
 *   - `location`   = camera.location || camera.name
 *                    (physical placement preferred; label as fallback)
 */

export function cameraToCctvDevice(
  camera: OrgCamera,
  branches: OrgBranch[],
): CctvDevice {
  const branch = branches.find((b) => b.id === camera.branchId);
  return {
    id: camera.id,
    branchId: camera.branchId,
    branchName: branch?.name ?? `Branch ${camera.branchId}`,
    branchCity: branch?.city,
    cameraType: camera.cameraType ?? "nvr",
    cameraName: camera.name,
    location: camera.location || camera.name,
    status:
      camera.status ??
      SEEDED_STATUSES[seededNumber(camera.id, SEEDED_STATUSES.length)],
    lastSeen:
      camera.lastSeen ??
      LAST_SEEN_OPTIONS[
        seededNumber(camera.id + "_ls", LAST_SEEN_OPTIONS.length)
      ],
  };
}

// ─── Normalizers: storage/API boundary ───────────────────────────────────────

function normalizeBranch(value: unknown): OrgBranch | null {
  if (!isRecord(value)) return null;
  const id = Number(value.id);
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!Number.isFinite(id) || !name) return null;

  // Preserve the real Supabase branch UUID the backend already sends.
  // Previously this function only copied id/name/city, silently dropping
  // the field resolveTenantScope/getBackendBranchId depend on — the exact
  // cause of the Aukara filtering bug.
  const backendBranchId = pickString(
    value.backendBranchId,
    value.backend_branch_id,
    value.branchUuid,
    value.branch_uuid,
  );

  return {
    id,
    name,
    ...(typeof value.city === "string" && value.city.trim()
      ? { city: value.city.trim() }
      : {}),
    ...(typeof value.timezone === "string" && value.timezone.trim()
      ? { timezone: value.timezone.trim() }
      : {}),
    ...(backendBranchId ? { backendBranchId } : {}),
  };
}

function normalizeDepartment(value: unknown): OrgDepartment | null {
  if (!isRecord(value)) return null;
  const className =
    typeof value.className === "string"
      ? value.className.trim()
      : typeof value.class_name === "string"
        ? value.class_name.trim()
        : "";
  const sectionName =
    typeof value.sectionName === "string"
      ? value.sectionName.trim()
      : typeof value.section_name === "string"
        ? value.section_name.trim()
        : "";
  const name =
    typeof value.name === "string" && value.name.trim()
      ? value.name.trim()
      : [className, sectionName].filter(Boolean).join(" - ");
  if (!name) return null;

  const rawFamily =
    typeof value.personFamily === "string"
      ? value.personFamily
      : typeof value.person_family === "string"
        ? value.person_family
        : undefined;
  const itemKind =
    value.itemKind === "class_section" ||
    value.item_kind === "class_section" ||
    className ||
    sectionName
      ? "class_section"
      : "group";

  return {
    ...(Number.isFinite(Number(value.id)) ? { id: Number(value.id) } : {}),
    name,
    ...(className ? { className } : {}),
    ...(sectionName ? { sectionName } : {}),
    personFamily:
      rawFamily === "student" || itemKind === "class_section"
        ? "student"
        : "workforce",
    peopleType:
      typeof value.peopleType === "string"
        ? value.peopleType
        : typeof value.people_type === "string"
          ? value.people_type
          : undefined,
    itemKind,
  };
}

function normalizeRole(value: unknown): OrgRole | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;

  const rawFamily =
    typeof value.personFamily === "string"
      ? value.personFamily
      : typeof value.person_family === "string"
        ? value.person_family
        : undefined;

  return {
    ...(Number.isFinite(Number(value.id)) ? { id: Number(value.id) } : {}),
    name,
    ...(Number.isFinite(Number(value.level))
      ? { level: Number(value.level) }
      : {}),
    personFamily: rawFamily === "student" ? "student" : "workforce",
    peopleType:
      typeof value.peopleType === "string"
        ? value.peopleType
        : typeof value.people_type === "string"
          ? value.people_type
          : undefined,
  };
}

function normalizeCamera(
  value: unknown,
  fallbackBranchId?: number,
): OrgCamera | null {
  if (!isRecord(value)) return null;

  const branchId = Number(value.branchId ?? fallbackBranchId);
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  /**
   * [Fix-3] Normalize location separately from name.
   * If `location` is provided and non-empty, use it. Otherwise fall back to
   * `name` so the field is always populated. This preserves the distinction
   * between camera label and physical placement throughout the system.
   */
  const location =
    typeof value.location === "string" && value.location.trim()
      ? value.location.trim()
      : name;

  if (!Number.isFinite(branchId) || !id || !name) return null;

  const status = value.status;
  const normalizedStatus =
    status === "Normal" || status === "Alert" || status === "Offline"
      ? status
      : undefined;

  const rawCameraType =
    typeof value.cameraType === "string"
      ? value.cameraType
      : typeof value.camera_type === "string"
        ? value.camera_type
        : undefined;
  const normalizedCameraType =
    rawCameraType === "nvr" ||
    rawCameraType === "dvr" ||
    rawCameraType === "ip_camera" ||
    rawCameraType === "webcam"
      ? rawCameraType
      : undefined;

  return {
    id,
    branchId,
    name,
    location,
    rtspUrl: typeof value.rtspUrl === "string" ? value.rtspUrl : "",
    ...(normalizedCameraType ? { cameraType: normalizedCameraType } : {}),
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
    ...(typeof value.lastSeen === "string" ? { lastSeen: value.lastSeen } : {}),
    ...(typeof value.streamPath === "string"
      ? { streamPath: value.streamPath }
      : {}),
  };
}

function normalizeRecordArray<T>(
  value: unknown,
  normalizer: (item: unknown, numericKey: number) => T | null,
): Record<number, T[]> {
  if (!isRecord(value)) return {};

  const output: Record<number, T[]> = {};
  Object.entries(value).forEach(([key, rawItems]) => {
    const numericKey = Number(key);
    if (!Number.isFinite(numericKey)) return;

    output[numericKey] = (Array.isArray(rawItems) ? rawItems : [])
      .map((item) => normalizer(item, numericKey))
      .filter((item): item is T => item !== null);
  });

  return output;
}

function normalizeShiftDefinitions(value: unknown): ShiftDefinition[] {
  if (!Array.isArray(value)) return DEFAULT_SHIFT_DEFINITIONS;

  return DEFAULT_SHIFT_DEFINITIONS.map((fallback) => {
    const found = value.find(
      (item) => isRecord(item) && item.id === fallback.id,
    );
    if (!isRecord(found)) return fallback;

    return {
      id: fallback.id,
      label:
        typeof found.label === "string" && found.label.trim()
          ? found.label.trim()
          : fallback.label,
      start:
        typeof found.start === "string" && found.start.trim()
          ? found.start.trim()
          : fallback.start,
      end:
        typeof found.end === "string" && found.end.trim()
          ? found.end.trim()
          : fallback.end,
    };
  });
}

function normalizeUsers(value: unknown): OrgUserRecord[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value)
      : [];

  return values
    .map((raw): OrgUserRecord | null => {
      if (!isRecord(raw)) return null;

      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      const staffId = typeof raw.staffId === "string" ? raw.staffId.trim() : "";
      const name = typeof raw.name === "string" ? raw.name.trim() : "";
      const email = typeof raw.email === "string" ? raw.email.trim() : "";
      const username =
        typeof raw.username === "string" ? raw.username.trim() : "";
      const branchId = Number(raw.branchId);

      if (!id || !staffId || !name || !email || !username) return null;
      if (!Number.isFinite(branchId)) return null;

      const role =
        raw.role === "admin" ||
        raw.role === "branch_admin" ||
        raw.role === "staff"
          ? raw.role
          : "staff";
      const status =
        raw.status === "inactive" || raw.status === "pending"
          ? raw.status
          : "active";
      const staffType = raw.staffType === "field" ? "field" : "office";
      const dashboardScope =
        raw.dashboardScope === "global" ? "global" : "branch";

      const portalAccess = isRecord(raw.portalAccess) ? raw.portalAccess : {};

      return {
        id,
        staffId,
        name,
        email,
        username,
        ...(typeof raw.password === "string" ? { password: raw.password } : {}),
        role,
        status,
        branchId,
        branchName:
          typeof raw.branchName === "string" ? raw.branchName.trim() : "",
        staffType,
        allowedBranchIds: Array.isArray(raw.allowedBranchIds)
          ? raw.allowedBranchIds
              .map(Number)
              .filter((item) => Number.isFinite(item))
          : [branchId],
        allowedModules: uniqStrings(
          Array.isArray(raw.allowedModules) ? raw.allowedModules : [],
        ),
        portalAccess: {
          desktopDashboard: Boolean(portalAccess.desktopDashboard),
          flutterStaffPortal: portalAccess.flutterStaffPortal !== false,
        },
        dashboardScope,
        createdAt:
          typeof raw.createdAt === "string"
            ? raw.createdAt
            : new Date().toISOString(),
        updatedAt:
          typeof raw.updatedAt === "string"
            ? raw.updatedAt
            : new Date().toISOString(),
      };
    })
    .filter((user): user is OrgUserRecord => user !== null);
}

function normalizeEmployeeProfiles(
  value: unknown,
): Record<string, EmployeeProfileOverride> {
  if (!isRecord(value)) return {};

  const output: Record<string, EmployeeProfileOverride> = {};
  Object.entries(value).forEach(([key, rawProfile]) => {
    if (!isRecord(rawProfile)) return;

    const employeeId =
      typeof rawProfile.employeeId === "string" && rawProfile.employeeId.trim()
        ? rawProfile.employeeId.trim()
        : key;

    output[key] = {
      employeeId,
      ...(typeof rawProfile.userId === "string"
        ? { userId: rawProfile.userId }
        : {}),
      ...(typeof rawProfile.name === "string" ? { name: rawProfile.name } : {}),
      ...(typeof rawProfile.email === "string"
        ? { email: rawProfile.email }
        : {}),
      ...(typeof rawProfile.phone === "string"
        ? { phone: rawProfile.phone }
        : {}),
      ...(typeof rawProfile.profileImageUrl === "string"
        ? { profileImageUrl: rawProfile.profileImageUrl }
        : {}),
      ...(typeof rawProfile.profileImageName === "string"
        ? { profileImageName: rawProfile.profileImageName }
        : {}),
      ...(typeof rawProfile.passwordChangedAt === "string"
        ? { passwordChangedAt: rawProfile.passwordChangedAt }
        : {}),
      ...(typeof rawProfile.mustChangePassword === "boolean"
        ? { mustChangePassword: rawProfile.mustChangePassword }
        : {}),
      updatedAt:
        typeof rawProfile.updatedAt === "string"
          ? rawProfile.updatedAt
          : new Date().toISOString(),
    };
  });

  return output;
}

function normalizeModulePeopleTypesByBranch(
  value: unknown,
): Record<string, Record<string, string[]>> {
  if (!isRecord(value)) return {};
  const result: Record<string, Record<string, string[]>> = {};
  for (const [branchId, branchValue] of Object.entries(value)) {
    if (!isRecord(branchValue)) continue;
    const moduleEntries: Record<string, string[]> = {};
    for (const [moduleKey, peopleTypes] of Object.entries(branchValue)) {
      if (Array.isArray(peopleTypes)) {
        moduleEntries[moduleKey] = uniqStrings(peopleTypes);
      }
    }
    if (Object.keys(moduleEntries).length) {
      result[branchId] = moduleEntries;
    }
  }
  return result;
}

/**
 * Mirrors support_db.py's _normalize_staff_type_scope: restrict to the
 * known "office"/"field" values and dedupe, but never collapse to an
 * empty scope — an empty/garbage value means "not configured," which is
 * treated as unrestricted (both), the same open-by-default posture as
 * DEFAULT_ORG_CONFIG.enabledStaffTypes.
 */
function normalizeStaffWorkTypes(value: unknown): StaffWorkType[] {
  const valid: StaffWorkType[] = ["office", "field"];
  if (!Array.isArray(value)) return valid;
  const cleaned = uniqStrings(value).filter((item): item is StaffWorkType =>
    valid.includes(item as StaffWorkType),
  );
  return cleaned.length ? cleaned : valid;
}

const VALID_ALLOWANCE_MODES: PayrollAllowanceMode[] = [
  "fixed",
  "percent",
  "none",
];

function normalizeAllowanceTypes(
  value: unknown,
): Record<string, PayrollAllowanceType> {
  if (!isRecord(value)) return {};
  const result: Record<string, PayrollAllowanceType> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label) continue;
    const mode = VALID_ALLOWANCE_MODES.includes(
      entry.mode as PayrollAllowanceMode,
    )
      ? (entry.mode as PayrollAllowanceMode)
      : "fixed";
    const numericValue = Number(entry.value);
    result[key] = {
      label,
      mode,
      value:
        mode === "none" || !Number.isFinite(numericValue) ? 0 : numericValue,
    };
  }
  return result;
}

function normalizePayrollPolicy(value: unknown): PayrollPolicy {
  const raw = isRecord(value) ? value : {};

  const otRatePerHour = Number(raw.otRatePerHour);
  const defaultSalary = Number(raw.defaultSalary);

  return {
    otRatePerHour:
      Number.isFinite(otRatePerHour) && otRatePerHour > 0 ? otRatePerHour : 500,
    defaultSalary:
      Number.isFinite(defaultSalary) && defaultSalary > 0
        ? defaultSalary
        : 50_000,
    allowanceTypes: normalizeAllowanceTypes(raw.allowanceTypes),
  };
}

/**
 * Normalizes localStorage/API/partial patch data into a complete OrgConfig.
 * All consumers can safely call .map/.filter/.flatMap on cfg collections.
 */
export function normalizeOrgConfig(input: unknown): OrgConfig {
  const raw = isRecord(input) ? input : {};

  const branches = Array.isArray(raw.branches)
    ? raw.branches
        .map(normalizeBranch)
        .filter((branch): branch is OrgBranch => branch !== null)
    : [];

  const departments = normalizeRecordArray<OrgDepartment>(
    raw.departments,
    (item) => normalizeDepartment(item),
  );

  const roles = normalizeRecordArray<OrgRole>(raw.roles, (item) =>
    normalizeRole(item),
  );

  const cameras = normalizeRecordArray<OrgCamera>(
    raw.cameras,
    (item, branchId) => normalizeCamera(item, branchId),
  );

  branches.forEach((branch) => {
    departments[branch.id] ??= [];
    roles[branch.id] ??= [];

    /*
     * CCTV must be purely configuration-driven.
     *
     * Do not seed default/mock cameras here. If Support has not configured CCTV
     * cameras for a branch, that branch must have an empty camera list so the
     * dashboard can hide CCTV widgets instead of showing fake devices.
     */
    cameras[branch.id] = Array.isArray(cameras[branch.id])
      ? cameras[branch.id]
      : [];
  });

  // [Fix-5] Persist liveCctvSource in org config so it is runtime-configurable.
  const rawSource = raw.liveCctvSource;
  const liveCctvSource: "mock" | "api" =
    rawSource === "api"
      ? "api"
      : rawSource === "mock"
        ? "mock"
        : ENV_LIVE_CCTV_SOURCE;

  return {
    bizType:
      typeof raw.bizType === "string"
        ? raw.bizType
        : typeof raw.businessType === "string"
          ? raw.businessType
          : typeof raw.business_type === "string"
            ? raw.business_type
            : null,
    businessType:
      typeof raw.businessType === "string"
        ? raw.businessType
        : typeof raw.business_type === "string"
          ? raw.business_type
          : typeof raw.bizType === "string"
            ? raw.bizType
            : null,
    primaryPeopleType:
      typeof raw.primaryPeopleType === "string"
        ? raw.primaryPeopleType
        : typeof raw.primary_people_type === "string"
          ? raw.primary_people_type
          : "staff",
    enabledPeopleTypes: uniqStrings(
      Array.isArray(raw.enabledPeopleTypes)
        ? raw.enabledPeopleTypes
        : Array.isArray(raw.enabled_people_types)
          ? raw.enabled_people_types
          : [
              typeof raw.primaryPeopleType === "string"
                ? raw.primaryPeopleType
                : typeof raw.primary_people_type === "string"
                  ? raw.primary_people_type
                  : "staff",
            ],
    ),
    attendancePeopleTypes: uniqStrings(
      Array.isArray(raw.attendancePeopleTypes)
        ? raw.attendancePeopleTypes
        : Array.isArray(raw.attendance_people_types)
          ? raw.attendance_people_types
          : Array.isArray(raw.enabledPeopleTypes)
            ? raw.enabledPeopleTypes
            : Array.isArray(raw.enabled_people_types)
              ? raw.enabled_people_types
              : [
                  typeof raw.primaryPeopleType === "string"
                    ? raw.primaryPeopleType
                    : typeof raw.primary_people_type === "string"
                      ? raw.primary_people_type
                      : "staff",
                ],
    ),
    shiftEnabledPeopleTypes: uniqStrings(
      Array.isArray(raw.shiftEnabledPeopleTypes)
        ? raw.shiftEnabledPeopleTypes
        : Array.isArray(raw.shift_enabled_people_types)
          ? raw.shift_enabled_people_types
          : [],
    ),
    modulePeopleTypesByBranch: isRecord(raw.modulePeopleTypesByBranch)
      ? normalizeModulePeopleTypesByBranch(raw.modulePeopleTypesByBranch)
      : isRecord(raw.module_people_types_by_branch)
        ? normalizeModulePeopleTypesByBranch(raw.module_people_types_by_branch)
        : {},
    module_people_types_by_branch: isRecord(raw.module_people_types_by_branch)
      ? normalizeModulePeopleTypesByBranch(raw.module_people_types_by_branch)
      : isRecord(raw.modulePeopleTypesByBranch)
        ? normalizeModulePeopleTypesByBranch(raw.modulePeopleTypesByBranch)
        : {},
    enabledStaffTypes: normalizeStaffWorkTypes(
      raw.enabledStaffTypes ?? raw.enabled_staff_types,
    ),
    enabled_staff_types: normalizeStaffWorkTypes(
      raw.enabledStaffTypes ?? raw.enabled_staff_types,
    ),
    verticalConfig: isRecord(raw.verticalConfig)
      ? raw.verticalConfig
      : isRecord(raw.vertical_config)
        ? raw.vertical_config
        : {},
    terminologyOverrides: isRecord(raw.terminologyOverrides)
      ? raw.terminologyOverrides
      : isRecord(raw.terminology_overrides)
        ? raw.terminology_overrides
        : {},
    orgName: typeof raw.orgName === "string" ? raw.orgName : "",
    tagline: typeof raw.tagline === "string" ? raw.tagline : "",
    address: typeof raw.address === "string" ? raw.address : "",
    size: typeof raw.size === "string" ? raw.size : "",
    logo: typeof raw.logo === "string" ? raw.logo : null,
    attendanceMode:
      typeof raw.attendanceMode === "string"
        ? raw.attendanceMode
        : typeof raw.attendance_mode === "string"
          ? raw.attendance_mode
          : null,
    attendance_mode:
      typeof raw.attendance_mode === "string"
        ? raw.attendance_mode
        : typeof raw.attendanceMode === "string"
          ? raw.attendanceMode
          : null,
    maxBranches: Number.isFinite(Number(raw.maxBranches))
      ? Number(raw.maxBranches)
      : Number.isFinite(Number(raw.max_branches))
        ? Number(raw.max_branches)
        : branches.length,
    max_branches: Number.isFinite(Number(raw.max_branches))
      ? Number(raw.max_branches)
      : Number.isFinite(Number(raw.maxBranches))
        ? Number(raw.maxBranches)
        : branches.length,
    branches,
    departments,
    roles,
    modules: uniqStrings(Array.isArray(raw.modules) ? raw.modules : []),
    cameras,
    staffShiftDefinitions: normalizeShiftDefinitions(raw.staffShiftDefinitions),
    liveCctvSource,
    users: normalizeUsers(raw.users),
    employeeProfiles: normalizeEmployeeProfiles(raw.employeeProfiles),
    payrollPolicy: normalizePayrollPolicy(raw.payrollPolicy),
  };
}

// ─── Backend hydration helpers ───────────────────────────────────────────────

const LEGACY_STORAGE_KEY = STORAGE_KEY;

function readCurrentUser(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem("currentUser");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clearLegacyOrgConfig(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ignore storage errors. Backend/Supabase is the source of truth.
  }
}

function toStableId(value: unknown): number | string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0 && String(numeric) === raw) {
    return numeric;
  }
  return raw;
}

function mergeCurrentUserOrganization(org: {
  id?: number | string;
  slug?: string;
  name?: string;
  status?: string;
}): void {
  try {
    const currentUser = readCurrentUser();
    if (!currentUser) return;

    localStorage.setItem(
      "currentUser",
      JSON.stringify({
        ...currentUser,
        organization_id: org.id,
        organizationId: org.id,
        organization_slug: org.slug,
        organization_name: org.name,
        organization_status:
          org.status ?? currentUser.organization_status ?? "active",
        organizationStatus:
          org.status ?? currentUser.organizationStatus ?? "active",
      }),
    );
  } catch {
    /* ignore storage errors */
  }
}

// Same storage key as apiClient.ts/staffApi.ts/clintApi.ts's
// dashboardAuthToken. /api/client/bootstrap is now wrapped in
// @require_client_dashboard_auth server-side, so a request with no
// Authorization header 401s unconditionally, every time, regardless of
// organizationId — this was a bare, un-authed fetch() left over from
// before that decorator was added, and it's the one actually driving
// /admin's initial load (see refreshOrgConfig below), unlike the two
// other bootstrap call sites (clientBootstrapApi.ts, clintApi.ts) which
// already send the token. Duplicated as a plain constant rather than
// imported for the same dependency-isolation reason apiClient.ts gives —
// grep "dashboardAuthToken" before renaming any of them.
function getClientBootstrapAuthHeaders(): HeadersInit {
  try {
    const token = localStorage.getItem("dashboardAuthToken");
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function getClientBootstrap(
  organizationId: number | string,
): Promise<any> {
  // A logout/redirect is already in flight — don't issue more requests
  // during the dialog's countdown.
  if (isSessionExpiryHandled()) {
    throw new ApiRequestError("Session ended", 401);
  }

  const res = await fetch(
    `/api/client/bootstrap?organization_id=${encodeURIComponent(String(organizationId))}`,
    {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...getClientBootstrapAuthHeaders(),
      },
    },
  );
  const data = await res.json().catch(() => ({}));

  // A 401 here is terminal, not transient: the token is absent or invalid
  // and no amount of re-fetching will change that. Without this, every
  // re-render re-issues the request and the tab hammers the server
  // indefinitely while still believing it is authenticated.
  if (res.status === 401) {
    handleSessionExpired(
      data?.message || "Session expired. Please log in again.",
    );
    throw new ApiRequestError(data?.message || "Unauthorized", 401);
  }

  // ORG_ACCESS_BLOCKED is terminal in the same way a 401 is: the org is
  // archived/suspended/deleted and no amount of retrying changes that.
  // Without this the provider re-fires bootstrap on every render and the
  // tab hammers the server indefinitely while still believing it is
  // authenticated.
  if (res.status === 403 && data?.code === "ORG_ACCESS_BLOCKED") {
    handleSessionExpired(
      data?.error ||
        data?.message ||
        "This organization is no longer active. Contact QIntellect Support.",
    );
    throw new ApiRequestError(data?.error || "Organization inactive", 403);
  }

  if (!res.ok || data?.success === false) {
    throw new Error(
      data?.message || data?.error || "Failed to load client bootstrap.",
    );
  }
  return data;
}

function getUserOrganizationId(
  user: {
    organization_id?: string | number | null;
    organizationId?: string | number | null;
  } | null,
): number | string | null {
  return toStableId(user?.organization_id ?? user?.organizationId);
}
// ─── Context ─────────────────────────────────────────────────────────────────

const OrgConfigContext = createContext<OrgContextValue | null>(null);

export function OrgConfigProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth() as {
    user: {
      id?: string | number;
      organization_id?: string | number | null;
      organizationId?: string | number | null;
      dashboard_ready?: boolean;
      dashboardReady?: boolean;
      requires_onboarding?: boolean;
      requiresOnboarding?: boolean;
      source?: string;
    } | null;
    isAuthenticated: boolean;
  };

  const userOrgId = getUserOrganizationId(user);

  // Render probe — dev builds only. This was previously unguarded and shipped
  // to production, logging the signed-in user's id to the browser console on
  // every render. Kept (rather than deleted) because the render count it
  // exposes is still unexplained: production showed 150+ renders of this
  // provider in a single page view. import.meta.env.DEV is statically false
  // in a production build, so the block is dropped at bundle time.
  const renderCount = useRef(0);
  renderCount.current++;
  if (import.meta.env.DEV) {
    console.log("OrgConfigProvider render", renderCount.current, {
      isAuthenticated,
      userId: user?.id,
      userOrgId,
    });
  }

  const [organizationId, setOrganizationId] = useState<number | string | null>(
    null,
  );
  const [organizationSlug, setOrganizationSlug] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [isOrgReady, setIsOrgReady] = useState(false);
  const [cfg, setCfgRaw] = useState<OrgConfig>(DEFAULT_ORG_CONFIG);
  const [activeBranchIdRaw, setActiveBranchIdRaw] = useState<number | null>(
    null,
  );

  const [isRefreshingOrgConfig, setIsRefreshingOrgConfig] = useState(false);
  const refreshRequestIdRef = useRef(0);

  const refreshOrgConfig = useCallback(
    async (opts?: { silent?: boolean }) => {
      const requestId = ++refreshRequestIdRef.current;
      const isStale = () => requestId !== refreshRequestIdRef.current;

      if (!isAuthenticated || !user?.id) {
        setOrganizationId(null);
        setOrganizationSlug(null);
        setOrganizationName(null);
        setCfgRaw(DEFAULT_ORG_CONFIG);
        clearLegacyOrgConfig();
        setIsOrgReady(false);
        return;
      }

      // A silent refresh (triggered by tab focus / visibility, not the
      // initial mount) must never flip isOrgReady back to false — that
      // would blank already-rendered screens for a moment on every
      // alt-tab back into the app.
      if (!opts?.silent) {
        setIsOrgReady(false);
      }
      setIsRefreshingOrgConfig(true);

      try {
        const result = userOrgId
          ? await getClientBootstrap(userOrgId)
          : await getCurrentOrganization(user.id);

        if (isStale()) return;

        const orgId = toStableId(result?.organization?.id);

        if (!result?.organization || !orgId || !result?.config) {
          setOrganizationId(null);
          setOrganizationSlug(null);
          setOrganizationName(null);
          setCfgRaw(DEFAULT_ORG_CONFIG);
          clearLegacyOrgConfig();
          return;
        }

        // Derive people types from support-owned bizType to enforce single source of truth
        const sourceBizType =
          result.organization?.biz_type ??
          result.organization?.business_type ??
          result.organization?.org_type ??
          null;
        const derivedPeopleTypes = resolvePeopleTypesFromBizType(sourceBizType);

        // Prefer authoritative organization-level collections when available
        const orgLevel = isRecord(result.organization)
          ? result.organization
          : {};
        const cfgSource = isRecord(result.config) ? result.config : {};

        const next = normalizeOrgConfig({
          // Start with config bundle, then overlay organization-level authoritative values
          ...cfgSource,
          branches: orgLevel.branches ?? cfgSource.branches,
          departments: orgLevel.departments ?? cfgSource.departments,
          roles: orgLevel.roles ?? cfgSource.roles,
          cameras: orgLevel.cameras ?? cfgSource.cameras,
          maxBranches:
            orgLevel.max_branches ??
            orgLevel.maxBranches ??
            cfgSource.maxBranches ??
            cfgSource.max_branches,
          attendanceMode:
            orgLevel.attendance_mode ??
            orgLevel.attendanceMode ??
            cfgSource.attendanceMode ??
            cfgSource.attendance_mode,

          bizType: sourceBizType,
          businessType:
            result.organization?.business_type ??
            result.organization?.biz_type ??
            result.organization?.org_type,
          // Prefer explicit organization-level people-type settings when provided
          // Fall back to bizType-derived defaults only when org does not specify values
          primaryPeopleType:
            orgLevel.primaryPeopleType ??
            orgLevel.primary_people_type ??
            cfgSource.primaryPeopleType ??
            cfgSource.primary_people_type ??
            derivedPeopleTypes[0] ??
            "staff",
          enabledPeopleTypes:
            orgLevel.enabledPeopleTypes ??
            orgLevel.enabled_people_types ??
            cfgSource.enabledPeopleTypes ??
            cfgSource.enabled_people_types ??
            derivedPeopleTypes,
          attendancePeopleTypes:
            orgLevel.attendancePeopleTypes ??
            orgLevel.attendance_people_types ??
            cfgSource.attendancePeopleTypes ??
            cfgSource.attendance_people_types ??
            derivedPeopleTypes,
          // Organization.enabled_staff_types (orgLevel, from get_organization's
          // raw row) is the commercial source of truth; config.enabledStaffTypes
          // (cfgSource, from _build_client_config) is a derived echo of the
          // same column and only used as a fallback if orgLevel is absent.
          enabledStaffTypes:
            orgLevel.enabledStaffTypes ??
            orgLevel.enabled_staff_types ??
            cfgSource.enabledStaffTypes ??
            cfgSource.enabled_staff_types,
          verticalConfig:
            result.organization?.vertical_config ??
            result.organization?.verticalConfig ??
            (isRecord(result.config)
              ? (result.config.verticalConfig ?? result.config.vertical_config)
              : undefined),
          terminologyOverrides:
            result.organization?.terminology_overrides ??
            result.organization?.terminologyOverrides ??
            (isRecord(result.config)
              ? (result.config.terminologyOverrides ??
                result.config.terminology_overrides)
              : undefined),
        });
        setCfgRaw(next);

        setOrganizationId(orgId);
        setOrganizationSlug(
          typeof result.organization.slug === "string"
            ? result.organization.slug
            : null,
        );
        setOrganizationName(
          typeof result.organization.name === "string"
            ? result.organization.name
            : null,
        );

        mergeCurrentUserOrganization(result.organization);
      } catch (error) {
        if (isStale()) return;
        // A silent background refresh failing must not nuke an already
        // working session's config — only the initial hydration treats a
        // failure as "this account has no org yet".
        if (!opts?.silent) {
          setOrganizationId(null);
          setOrganizationSlug(null);
          setOrganizationName(null);
          setCfgRaw(DEFAULT_ORG_CONFIG);
          clearLegacyOrgConfig();
        }
      } finally {
        if (!isStale()) {
          setIsOrgReady(true);
          setIsRefreshingOrgConfig(false);
        }
      }
    },
    [isAuthenticated, user?.id, userOrgId],
  );

  useEffect(() => {
    void refreshOrgConfig();
  }, [
    isAuthenticated,
    user?.id,
    userOrgId,
    user?.dashboard_ready,
    user?.dashboardReady,
    user?.requires_onboarding,
    user?.requiresOnboarding,
  ]);

  // Support-dashboard changes (e.g. flipping a branch's people_type) are
  // made from a different session entirely, so there's no push channel that
  // tells an already-open client tab its cfg is stale. Re-pull tenant config
  // whenever the tab regains focus/visibility — cheap (one request), and
  // keeps "single source of truth" meaningfully true for a tab that's been
  // sitting open instead of only being true on next login/reload.
  useEffect(() => {
    if (!isAuthenticated) return;

    function handleFocusOrVisible() {
      if (document.visibilityState === "hidden") return;
      void refreshOrgConfig({ silent: true });
    }

    window.addEventListener("focus", handleFocusOrVisible);
    document.addEventListener("visibilitychange", handleFocusOrVisible);

    return () => {
      window.removeEventListener("focus", handleFocusOrVisible);
      document.removeEventListener("visibilitychange", handleFocusOrVisible);
    };
  }, [isAuthenticated, refreshOrgConfig]);

  const updateCfg = useCallback((patch: Partial<OrgConfig>) => {
    // Runtime-only patch for screens that optimistically update master data.
    // Permanent org configuration must be saved through Flask APIs so Supabase
    // remains the source of truth.
    setCfgRaw((prev) => normalizeOrgConfig({ ...prev, ...patch }));
  }, []);

  const setActiveBranchId = useCallback((id: number | null) => {
    setActiveBranchIdRaw(id === null ? null : Number(id));
  }, []);

  const activeBranchId = useMemo(() => {
    if (activeBranchIdRaw === null) return null;
    return cfg.branches.some((branch) => branch.id === activeBranchIdRaw)
      ? activeBranchIdRaw
      : null;
  }, [activeBranchIdRaw, cfg.branches]);

  const allCameras = useMemo<OrgCamera[]>(
    () => cfg.branches.flatMap((branch) => cfg.cameras[branch.id] ?? []),
    [cfg.branches, cfg.cameras],
  );

  const visibleBranches = useMemo<OrgBranch[]>(() => {
    const max =
      Number.isFinite(Number(cfg.maxBranches)) && cfg.maxBranches > 0
        ? cfg.maxBranches
        : cfg.branches.length;
    return cfg.branches.slice(0, max);
  }, [cfg.branches, cfg.maxBranches]);

  const cameras = useMemo<OrgCamera[]>(
    () =>
      activeBranchId === null
        ? allCameras
        : (cfg.cameras[activeBranchId] ?? []),
    [activeBranchId, allCameras, cfg.cameras],
  );

  const allCctvDevices = useMemo<CctvDevice[]>(
    () => allCameras.map((cam) => cameraToCctvDevice(cam, cfg.branches)),
    [allCameras, cfg.branches],
  );

  const masterData = useMemo<OrgMasterData>(() => {
    const getBranch = (id: number) =>
      visibleBranches.find((branch) => branch.id === id) ||
      cfg.branches.find((branch) => branch.id === id);
    const getBranchName = (id: number) => getBranch(id)?.name ?? "—";

    return {
      bizType: cfg.bizType,
      branches: visibleBranches,
      departmentsByBranch: cfg.departments,
      rolesByBranch: cfg.roles,
      modules: cfg.modules,
      camerasByBranch: cfg.cameras,
      staffShiftDefinitions: cfg.staffShiftDefinitions,
      users: cfg.users,
      liveCctvSource: cfg.liveCctvSource,
      getBranch,
      getBranchName,
      getDepartments: (branchId: number) => cfg.departments[branchId] ?? [],
      getRoles: (branchId: number) => cfg.roles[branchId] ?? [],
      getCameras: (branchId: number) => cfg.cameras[branchId] ?? [],
    };
  }, [cfg]);

  const value = useMemo<OrgContextValue>(
    () => ({
      cfg,

      organizationId,
      organizationSlug,
      organizationName,
      isOrgReady,

      masterData,
      updateCfg,
      refreshOrgConfig,
      isRefreshingOrgConfig,
      activeBranchId,
      setActiveBranchId,
      cameras,
      allCameras,
      allCctvDevices,
      visibleBranches,
    }),
    [
      cfg,
      organizationId,
      organizationSlug,
      organizationName,
      isOrgReady,
      masterData,
      updateCfg,
      refreshOrgConfig,
      isRefreshingOrgConfig,
      activeBranchId,
      setActiveBranchId,
      cameras,
      allCameras,
      allCctvDevices,
      visibleBranches,
    ],
  );

  return (
    <OrgConfigContext.Provider value={value}>
      {children}
    </OrgConfigContext.Provider>
  );
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgConfigContext);
  if (!ctx) throw new Error("useOrg must be used inside OrgConfigProvider");
  return ctx;
}

export function useOrgMasterData(): OrgMasterData {
  return useOrg().masterData;
}