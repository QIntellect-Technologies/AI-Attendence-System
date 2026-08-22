import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Building2,
  Camera,
  CheckCircle2,
  GitBranch,
  GraduationCap,
  Loader2,
  Network,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { useAuth } from "../../contexts/useAuth";
import { fetchClientJson, loadClientBootstrap } from "../../services/clintApi";
import { AttendanceSettingsScreens } from "../attendance_temp/settings/AttendanceSettingsScreens";
import { validateRtspUrl, findInvalidCameraRtspUrl } from "../../utils/rtspValidation";
// ─── Access gate helpers ────────────────────────────────────────────────────
// Mirrors AdminLayout.tsx's isStaffUser/getUserAllowedModules exactly (kept
// as small local copies rather than a shared import, since AdminLayout.tsx
// doesn't currently export them). Admins always reach Settings; staff only
// when their session carries the "settings" module grant — the same grant
// toggled in StaffModal's Dashboard Module Access checklist and exempted
// from the purchased-module gate in moduleRegistry.ts.
function isStaffAccount(user: { role?: string } | null | undefined): boolean {
  return String(user?.role ?? "").toLowerCase() === "staff";
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function getAccountAllowedModules(
  user:
    | {
        allowedModules?: string[] | string;
        accessModules?: string[] | string;
        moduleAccess?: string[] | string;
        access_modules?: string[] | string;
      }
    | null
    | undefined,
): string[] {
  return Array.from(
    new Set(
      toStringArray(
        user?.allowedModules ??
          user?.accessModules ??
          user?.moduleAccess ??
          user?.access_modules,
      ).map((s) => s.trim()),
    ),
  );
}

type Branch = {
  id: string;
  name: string;
  location?: string | null;
  max_staff_capacity?: number | null;
  maxStaffCapacity?: number | null;
};

type BootstrapOrganization = {
  id: string;
  name: string;
  contact_phone?: string | null;
  org_type?: string | null;
  business_type?: string | null;
  biz_type?: string | null;
  primary_people_type?: string | null;
  primaryPeopleType?: string | null;
  enabled_people_types?: string[];
  enabledPeopleTypes?: string[];
  attendance_people_types?: string[];
  attendancePeopleTypes?: string[];
  vertical_config?: Record<string, unknown> | null;
  verticalConfig?: Record<string, unknown> | null;
  terminology_overrides?: Record<string, unknown> | null;
  terminologyOverrides?: Record<string, unknown> | null;
  attendance_mode?: string;
  attendanceMode?: string;
  status?: string;
};

type BootstrapResponse = {
  success?: boolean;
  message?: string;
  organization?: BootstrapOrganization;
  branches?: Branch[];
  active_modules?: string[];
  activeModules?: string[];
  config?: Partial<OperationalConfig> & Record<string, unknown>;
  onboarding_config?: Partial<OperationalConfig> & Record<string, unknown>;
  onboardingConfig?: Partial<OperationalConfig> & Record<string, unknown>;
};

type AuthUser = {
  id?: string | number;
  organization_id?: string | null;
  organizationId?: string | null;
  role?: string;
  allowedModules?: string[] | string;
  accessModules?: string[] | string;
  moduleAccess?: string[] | string;
  access_modules?: string[] | string;
};

type AuthContext = {
  user?: AuthUser | null;
  refreshUser?: (userId: string | number) => Promise<unknown> | unknown;
};

type PersonFamily = "student" | "workforce";

type CompanyProfile = {
  address: string;
  city: string;
  publicContactPhone: string;
  timezone: string;
  logoDataUrl: string;
  logoFileName: string;
};

type GroupItem = {
  id: string;
  name: string;
  className?: string;
  sectionName?: string;
  itemKind: "class_section" | "group";
  personFamily: PersonFamily;
};

type DesignationItem = {
  id: string;
  name: string;
  level:
    | "admin"
    | "manager"
    | "staff"
    | "teacher"
    | "student"
    | "worker"
    | "custom";
  personFamily: "workforce";
};

type CameraItem = {
  id: string;
  name: string;
  location: string;
  rtspUrl: string;
  channel: string;
  type: "nvr" | "dvr" | "ip_camera" | "webcam";
};

type NetworkConfig = {
  publicIp: string;
  nvrDvrIp: string;
  rtspUsername: string;
  rtspPassword: string;
  rtspPort: string;
};

type OperationalConfig = {
  company_profile: CompanyProfile;
  departments: Record<string, GroupItem[]>;
  roles: Record<string, DesignationItem[]>;
  cameras: Record<string, CameraItem[]>;
  network: NetworkConfig;
  shiftEnabledPeopleTypes?: string[];
};

type Terminology = {
  organizationLabel: string;
  branchLabel: string;
  studentGroupLabel: string;
  studentGroupPlural: string;
  studentSubgroupLabel: string;
  workforceGroupLabel: string;
  workforceGroupPlural: string;
  designationLabel: string;
  designationPlural: string;
  cameraLabel: string;
  cameraPlural: string;
  studentPlural: string;
  workforcePlural: string;
};

type OperationalPlan = {
  hasStudentSetup: boolean;
  hasWorkforceSetup: boolean;
  isAcademic: boolean;
  isFactory: boolean;
};

export const C = {
  primary: "#1a699f",
  primaryDark: "#155580",
  bg: "#eef8fc",
  card: "#ffffff",
  border: "#dbe8f0",
  text: "#0f172a",
  textSub: "#475569",
  textMuted: "#94a3b8",
  danger: "#dc2626",
  success: "#16a34a",
  tealPale: "#f0f8fc",
  tealLight: "#e6f3f9",
} as const;

// UX-only guard; support_db_client_users.py's _validate_group_item_name is
// the real boundary that stops an oversized paste from being persisted.
const GROUP_NAME_MAX_LENGTH = 100;

// UX-only guards for the network/camera/company-profile fields below — the
// real boundary is the length caps applied server-side in
// support_db_settings.py so a direct API call can't bypass these.
const IP_MAX_LENGTH = 45; // fits IPv4, IPv6 and hostnames
const PORT_MAX_LENGTH = 6;
const CREDENTIAL_MAX_LENGTH = 128;
const CAMERA_NAME_MAX_LENGTH = 100;
const CAMERA_LOCATION_MAX_LENGTH = 150;
const CAMERA_CHANNEL_MAX_LENGTH = 20;
const RTSP_URL_MAX_LENGTH = 500;
const ADDRESS_MAX_LENGTH = 255;
const CITY_MAX_LENGTH = 100;
const PHONE_MAX_LENGTH = 20;

const WORKFORCE_TYPES = new Set([
  "staff",
  "employee",
  "employees",
  "teacher",
  "teachers",
  "faculty",
  "admin",
  "administration",
  "administrator",
  "worker",
  "workers",
  "supervisor",
  "supervisors",
  "doctor",
  "doctors",
  "nurse",
  "nurses",
  "personnel",
]);

function normalizeKey(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}
function titleCase(value: string): string {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

// Persists which branch the Attendance Configuration section is showing via
// a URL query param, so navigating away from Settings and back (which fully
// unmounts this component while the bootstrap reloads — see the
// `isLoading` early return below) doesn't silently reset selectedBranchId
// back to branches[0]. Without this, any manual instruction / capture
// setting saved under a non-first branch looked like it "disappeared" on
// return, when it was actually still saved — just filtered out by the
// branch that got re-selected by default.
//
// The URL (not localStorage, not a Supabase-backed preference) is the right
// place for this: it's plain view state, not application data, so it
// doesn't need a round trip, a table, or a migration to remember — and
// unlike localStorage it also makes the current view shareable/bookmarkable
// and survives a hard refresh or opening the page in a new tab.
const ATTENDANCE_BRANCH_PARAM = "branch";

function readBranchIdFromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get(
      ATTENDANCE_BRANCH_PARAM,
    );
  } catch {
    return null;
  }
}

function writeBranchIdToUrl(branchId: string): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set(ATTENDANCE_BRANCH_PARAM, branchId);
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    // Non-browser environment or URL API unavailable — selection just
    // won't survive a remount.
  }
}

function makeId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readStringList(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      const items = value.map(normalizeKey).filter(Boolean);
      if (items.length) return items;
    }
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          const items = parsed.map(normalizeKey).filter(Boolean);
          if (items.length) return items;
        }
      } catch {
        const items = value.split(",").map(normalizeKey).filter(Boolean);
        if (items.length) return items;
      }
    }
  }
  return [];
}

function labelFromOverride(
  overrides: Record<string, unknown>,
  keys: string[],
  fallback: string,
): string {
  for (const key of keys) {
    const value = overrides[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function resolveOperationalPlan(
  data: BootstrapResponse | null,
): OperationalPlan {
  const org = data?.organization;
  const verticalConfig = asRecord(org?.vertical_config || org?.verticalConfig);
  const businessType = normalizeKey(
    org?.business_type ||
      org?.biz_type ||
      org?.org_type ||
      verticalConfig.business_type ||
      "company",
  );
  const primaryPeopleType = normalizeKey(
    org?.primary_people_type ||
      org?.primaryPeopleType ||
      verticalConfig.primary_people_type ||
      "staff",
  );
  const enabledTypes = readStringList(
    org?.enabled_people_types,
    org?.enabledPeopleTypes,
    verticalConfig.enabled_people_types,
  );
  const attendanceTypes = readStringList(
    org?.attendance_people_types,
    org?.attendancePeopleTypes,
    verticalConfig.attendance_people_types,
  );
  const peopleScope = attendanceTypes.length
    ? attendanceTypes
    : enabledTypes.length
      ? enabledTypes
      : [primaryPeopleType];

  const isAcademic =
    businessType.includes("school") ||
    businessType.includes("college") ||
    businessType.includes("university") ||
    businessType.includes("academy") ||
    peopleScope.some((type) => type.includes("student"));

  const isFactory =
    businessType.includes("factory") ||
    businessType.includes("manufacturing") ||
    businessType.includes("plant") ||
    peopleScope.some((type) => type.includes("worker"));

  const hasStudentSetup = peopleScope.some((type) => type.includes("student"));
  const hasWorkforceSetup = peopleScope.some(
    (type) => WORKFORCE_TYPES.has(type) || !type.includes("student"),
  );

  return {
    hasStudentSetup,
    hasWorkforceSetup:
      hasWorkforceSetup || (!hasStudentSetup && peopleScope.length > 0),
    isAcademic,
    isFactory,
  };
}

function buildTerminology(
  data: BootstrapResponse | null,
  plan: OperationalPlan,
): Terminology {
  const org = data?.organization;
  const verticalConfig = asRecord(org?.vertical_config || org?.verticalConfig);
  const overrides = asRecord(
    org?.terminology_overrides || org?.terminologyOverrides,
  );

  const studentGroupFallback = plan.isAcademic ? "Class" : "Group";
  const studentGroupPluralFallback = plan.isAcademic
    ? "Classes & Sections"
    : "Groups";
  const workforceGroupFallback = plan.isFactory
    ? "Department / Unit"
    : "Department";
  const workforceGroupPluralFallback = plan.isFactory
    ? "Departments / Units"
    : "Departments";

  return {
    organizationLabel: labelFromOverride(
      overrides,
      ["organization", "organizationLabel", "org_label"],
      "Organization",
    ),
    branchLabel: labelFromOverride(
      overrides,
      ["branch", "branchLabel", "branch_label"],
      "Branch",
    ),
    studentGroupLabel: labelFromOverride(
      overrides,
      ["class", "classLabel", "studentGroup", "studentGroupLabel"],
      studentGroupFallback,
    ),
    studentGroupPlural: labelFromOverride(
      overrides,
      ["classes", "classPlural", "studentGroups", "studentGroupPlural"],
      studentGroupPluralFallback,
    ),
    studentSubgroupLabel: labelFromOverride(
      overrides,
      ["section", "sectionLabel", "studentSubgroup", "studentSubgroupLabel"],
      "Section",
    ),
    workforceGroupLabel: labelFromOverride(
      overrides,
      [
        "department",
        "departmentLabel",
        "unit",
        "unitLabel",
        "group",
        "groupLabel",
      ],
      workforceGroupFallback,
    ),
    workforceGroupPlural: labelFromOverride(
      overrides,
      [
        "departments",
        "departmentPlural",
        "units",
        "unitPlural",
        "groups",
        "groupPlural",
      ],
      workforceGroupPluralFallback,
    ),
    designationLabel: labelFromOverride(
      overrides,
      ["designation", "designationLabel", "role", "roleLabel"],
      "Designation",
    ),
    designationPlural: labelFromOverride(
      overrides,
      ["designations", "designationPlural", "roles", "rolePlural"],
      "Designations",
    ),
    cameraLabel: labelFromOverride(
      overrides,
      ["camera", "cameraLabel"],
      "Camera",
    ),
    cameraPlural: labelFromOverride(
      overrides,
      ["cameras", "cameraPlural"],
      "Cameras",
    ),
    studentPlural: labelFromOverride(
      overrides,
      ["students", "studentPlural"],
      "Students",
    ),
    workforcePlural: labelFromOverride(
      overrides,
      [
        "staff",
        "employees",
        "workers",
        "teachers",
        "workforce",
        "workforcePlural",
      ],
      plan.isFactory
        ? "Workers / Staff"
        : plan.isAcademic
          ? "Staff / Teachers / Administration"
          : "People",
    ),
  };
}

function emptyConfig(branches: Branch[]): OperationalConfig {
  const departments: Record<string, GroupItem[]> = {};
  const roles: Record<string, DesignationItem[]> = {};
  const cameras: Record<string, CameraItem[]> = {};

  branches.forEach((branch) => {
    departments[String(branch.id)] = [];
    roles[String(branch.id)] = [];
    cameras[String(branch.id)] = [];
  });

  return {
    company_profile: {
      address: "",
      city: "",
      publicContactPhone: "",
      timezone: "Asia/Karachi",
      logoDataUrl: "",
      logoFileName: "",
    },
    departments,
    roles,
    cameras,
    network: {
      publicIp: "",
      nvrDvrIp: "",
      rtspUsername: "",
      rtspPassword: "",
      rtspPort: "554",
    },
  };
}

function branchKeyMap(
  data: BootstrapResponse,
  branches: Branch[],
): Record<string, string> {
  const map: Record<string, string> = {};
  branches.forEach((branch, index) => {
    map[String(branch.id)] = String(branch.id);
    map[String(index + 1)] = String(branch.id);
  });

  asArray<Record<string, unknown>>(data.config?.branches).forEach((branch) => {
    const backendKey = cleanText(
      branch.backend_branch_id || branch.backendBranchId || branch.branch_uuid,
    );
    const uiKey = cleanText(
      branch.id || branch.branchId || branch.branch_ui_id || branch.branchUiId,
    );
    if (backendKey) map[backendKey] = backendKey;
    if (uiKey && backendKey) map[uiKey] = backendKey;
  });

  return map;
}

function normalizeGroupItem(
  raw: Record<string, unknown>,
  fallbackFamily: PersonFamily,
): GroupItem | null {
  const className = cleanText(raw.className || raw.class_name);
  const sectionName = cleanText(raw.sectionName || raw.section_name);
  const personFamily =
    cleanText(raw.personFamily || raw.person_family) === "student" ||
    className ||
    sectionName
      ? "student"
      : fallbackFamily;
  const itemKind: GroupItem["itemKind"] =
    personFamily === "student" ? "class_section" : "group";
  const name =
    cleanText(raw.name) || [className, sectionName].filter(Boolean).join(" - ");
  if (!name) return null;

  return {
    id: cleanText(raw.id) || makeId("group"),
    name,
    className: className || undefined,
    sectionName: sectionName || undefined,
    itemKind,
    personFamily,
  };
}

function normalizeDesignationItem(
  raw: Record<string, unknown>,
): DesignationItem | null {
  const name = cleanText(raw.name);
  if (!name) return null;

  const rawLevel = cleanText(
    raw.level,
  ).toLowerCase() as DesignationItem["level"];
  const allowed: DesignationItem["level"][] = [
    "admin",
    "manager",
    "staff",
    "teacher",
    "student",
    "worker",
    "custom",
  ];

  return {
    id: cleanText(raw.id) || makeId("designation"),
    name,
    level: allowed.includes(rawLevel) ? rawLevel : "custom",
    personFamily: "workforce",
  };
}

function normalizeCameraItem(raw: Record<string, unknown>): CameraItem | null {
  const name = cleanText(raw.name || raw.camera_name || raw.cameraName);
  const rtspUrl = cleanText(raw.rtspUrl || raw.rtsp_url);
  const channel = cleanText(raw.channel) || "1";
  if (!name && !rtspUrl && !channel) return null;

  const rawType = cleanText(raw.type).toLowerCase();
  const type: CameraItem["type"] =
    rawType === "dvr" ||
    rawType === "ip_camera" ||
    rawType === "webcam" ||
    rawType === "nvr"
      ? rawType
      : "nvr";

  return {
    id: cleanText(raw.id) || makeId("camera"),
    name: name || "Camera",
    location: cleanText(raw.location),
    rtspUrl,
    channel,
    type,
  };
}

function normalizeBranchRecord<T extends { id: string }>(
  value: unknown,
  branches: Branch[],
  keyMap: Record<string, string>,
  normalize: (item: Record<string, unknown>) => T | null,
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  branches.forEach((branch) => {
    result[String(branch.id)] = [];
  });

  Object.entries(asRecord(value)).forEach(([rawBranchId, rawItems]) => {
    const branchId = keyMap[String(rawBranchId)] || String(rawBranchId);
    if (!Object.prototype.hasOwnProperty.call(result, branchId)) return;
    result[branchId] = asArray<Record<string, unknown>>(rawItems)
      .map(normalize)
      .filter((item): item is T => item !== null);
  });

  return result;
}

function configFromBootstrap(
  data: BootstrapResponse,
  branches: Branch[],
): OperationalConfig {
  const base = emptyConfig(branches);
  const saved = asRecord(
    data.onboarding_config || data.onboardingConfig || data.config || {},
  );
  const profile = asRecord(saved.company_profile || saved.companyProfile);
  const network = asRecord(
    saved.network || data.config?.network || data.config?.networkConfig,
  );
  const keyMap = branchKeyMap(data, branches);

  return {
    company_profile: {
      address:
        cleanText(profile.address ?? data.config?.address) ||
        base.company_profile.address,
      city:
        cleanText(profile.city ?? data.config?.city) ||
        base.company_profile.city,
      publicContactPhone:
        cleanText(
          profile.publicContactPhone ||
            profile.public_contact_phone ||
            data.config?.publicContactPhone,
        ) ||
        cleanText(data.organization?.contact_phone) ||
        base.company_profile.publicContactPhone,
      timezone:
        cleanText(profile.timezone ?? data.config?.timezone) ||
        base.company_profile.timezone,
      logoDataUrl:
        cleanText(profile.logoDataUrl || profile.logo || data.config?.logo) ||
        base.company_profile.logoDataUrl,
      logoFileName:
        cleanText(profile.logoFileName || profile.logo_file_name) ||
        base.company_profile.logoFileName,
    },
    departments: normalizeBranchRecord<GroupItem>(
      saved.departments ||
        data.config?.departments ||
        data.config?.groups ||
        data.config?.classes,
      branches,
      keyMap,
      (item) => normalizeGroupItem(item, "workforce"),
    ),
    roles: normalizeBranchRecord<DesignationItem>(
      saved.roles || data.config?.roles || data.config?.designations,
      branches,
      keyMap,
      normalizeDesignationItem,
    ),
    cameras: normalizeBranchRecord<CameraItem>(
      saved.cameras || data.config?.cameras,
      branches,
      keyMap,
      normalizeCameraItem,
    ),
    network: {
      publicIp: cleanText(network.publicIp || network.public_ip),
      nvrDvrIp: cleanText(
        network.nvrDvrIp ||
          network.nvr_dvr_ip ||
          network.nvrLocalIp ||
          network.nvr_local_ip,
      ),
      rtspUsername: cleanText(network.rtspUsername || network.rtsp_username),
      rtspPassword: cleanText(network.rtspPassword || network.rtsp_password),
      rtspPort: cleanText(network.rtspPort || network.rtsp_port) || "554",
    },
    shiftEnabledPeopleTypes: readStringList(
      (saved.shiftEnabledPeopleTypes as unknown) ||
        saved.shift_enabled_people_types ||
        data.config?.shiftEnabledPeopleTypes ||
        data.config?.shift_enabled_people_types,
    ),
  };
}

async function saveOperationalConfig(payload: {
  user_id: string | number;
  organization_id: string | number;
  config: OperationalConfig;
}): Promise<BootstrapResponse> {
  return fetchClientJson<BootstrapResponse>("/api/client/onboarding/complete", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function totalItems<T>(
  record: Record<string, T[]>,
  filter?: (item: T) => boolean,
): number {
  return Object.values(record).reduce(
    (sum, items) => sum + (filter ? items.filter(filter).length : items.length),
    0,
  );
}

export function inputStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 42,
    border: `1.5px solid ${C.border}`,
    borderRadius: 10,
    background: C.card,
    padding: "0 12px",
    fontFamily: "inherit",
    fontSize: 13,
    color: C.text,
    outline: "none",
    ...extra,
  };
}

export function cardStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    background: C.card,
    border: `1.5px solid ${C.border}`,
    borderRadius: 16,
    boxShadow: "0 8px 26px rgba(15,45,74,.07)",
    ...extra,
  };
}

export function buttonStyle(
  variant: "primary" | "secondary" | "danger" = "primary",
): React.CSSProperties {
  const primary = variant === "primary";
  const danger = variant === "danger";
  return {
    minHeight: 42,
    border: primary || danger ? "none" : `1.5px solid ${C.border}`,
    borderRadius: 10,
    padding: "0 14px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    background: danger ? C.danger : primary ? C.primary : C.card,
    color: primary || danger ? "#fff" : C.textSub,
    fontSize: 13,
    fontWeight: 900,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };
}

export function sectionTitle(): React.CSSProperties {
  return {
    margin: 0,
    fontSize: 12,
    color: C.primaryDark,
    fontWeight: 950,
    textTransform: "uppercase",
    letterSpacing: ".08em",
  };
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span
        style={{
          fontSize: 11,
          color: C.textSub,
          fontWeight: 850,
          textTransform: "uppercase",
          letterSpacing: ".05em",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function BranchTabs({
  branches,
  activeBranchId,
  onChange,
}: {
  branches: Branch[];
  activeBranchId: string;
  onChange: (branchId: string) => void;
}) {
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}
    >
      {branches.map((branch) => {
        const active = branch.id === activeBranchId;
        return (
          <button
            key={branch.id}
            type="button"
            onClick={() => onChange(branch.id)}
            style={{
              ...buttonStyle("secondary"),
              borderColor: active ? C.primary : C.border,
              background: active ? C.tealLight : C.card,
              color: active ? C.primaryDark : C.textSub,
              minHeight: 34,
            }}
          >
            <GitBranch size={13} /> {branch.name}
          </button>
        );
      })}
    </div>
  );
}

function StudentStructureEditor({
  branches,
  groups,
  setGroups,
  terminology,
}: {
  branches: Branch[];
  groups: Record<string, GroupItem[]>;
  setGroups: React.Dispatch<React.SetStateAction<Record<string, GroupItem[]>>>;
  terminology: Terminology;
}) {
  const [activeBranchId, setActiveBranchId] = useState(branches[0]?.id || "");
  const [className, setClassName] = useState("");
  const [sectionName, setSectionName] = useState("");
  const list = (groups[activeBranchId] || []).filter(
    (item) => item.personFamily === "student",
  );

  const add = () => {
    const cleanClass = className.trim();
    const cleanSection = sectionName.trim();
    if (!activeBranchId || !cleanClass) return;
    const name = cleanSection ? `${cleanClass} - ${cleanSection}` : cleanClass;
    setGroups((prev) => ({
      ...prev,
      [activeBranchId]: [
        ...(prev[activeBranchId] || []),
        {
          id: makeId("class_section"),
          name,
          className: cleanClass,
          sectionName: cleanSection || undefined,
          itemKind: "class_section",
          personFamily: "student",
        },
      ],
    }));
    setClassName("");
    setSectionName("");
  };

  return (
    <ConfigCard
      icon={<GraduationCap size={18} />}
      title={terminology.studentGroupPlural}
    >
      <BranchTabs
        branches={branches}
        activeBranchId={activeBranchId}
        onChange={setActiveBranchId}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr auto",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <input
          value={className}
          onChange={(event) => setClassName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
          style={inputStyle()}
          maxLength={GROUP_NAME_MAX_LENGTH}
          placeholder={`${terminology.studentGroupLabel} name`}
        />
        <input
          value={sectionName}
          onChange={(event) => setSectionName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
          style={inputStyle()}
          maxLength={GROUP_NAME_MAX_LENGTH}
          placeholder={`${terminology.studentSubgroupLabel} name`}
        />
        <button type="button" onClick={add} style={buttonStyle("primary")}>
          <Plus size={15} /> Add
        </button>
      </div>
      <ChipList
        items={list}
        empty={`No ${terminology.studentGroupPlural.toLowerCase()} configured for this branch.`}
        onRemove={(id) =>
          setGroups((prev) => ({
            ...prev,
            [activeBranchId]: (prev[activeBranchId] || []).filter(
              (item) => item.id !== id,
            ),
          }))
        }
      />
    </ConfigCard>
  );
}

function WorkforceStructureEditor({
  branches,
  groups,
  setGroups,
  designations,
  setDesignations,
  terminology,
}: {
  branches: Branch[];
  groups: Record<string, GroupItem[]>;
  setGroups: React.Dispatch<React.SetStateAction<Record<string, GroupItem[]>>>;
  designations: Record<string, DesignationItem[]>;
  setDesignations: React.Dispatch<
    React.SetStateAction<Record<string, DesignationItem[]>>
  >;
  terminology: Terminology;
}) {
  const [activeBranchId, setActiveBranchId] = useState(branches[0]?.id || "");
  const [groupName, setGroupName] = useState("");
  const [designationName, setDesignationName] = useState("");
  const groupList = (groups[activeBranchId] || []).filter(
    (item) => item.personFamily === "workforce",
  );
  const designationList = designations[activeBranchId] || [];

  const addGroup = () => {
    const name = groupName.trim();
    if (!activeBranchId || !name) return;
    setGroups((prev) => ({
      ...prev,
      [activeBranchId]: [
        ...(prev[activeBranchId] || []),
        {
          id: makeId("department"),
          name,
          itemKind: "group",
          personFamily: "workforce",
        },
      ],
    }));
    setGroupName("");
  };

  const addDesignation = () => {
    const name = designationName.trim();
    if (!activeBranchId || !name) return;
    setDesignations((prev) => ({
      ...prev,
      [activeBranchId]: [
        ...(prev[activeBranchId] || []),
        {
          id: makeId("designation"),
          name,
          level: "custom",
          personFamily: "workforce",
        },
      ],
    }));
    setDesignationName("");
  };

  return (
    <ConfigCard
      icon={<Users size={18} />}
      title={`${terminology.workforceGroupPlural} & ${terminology.designationPlural}`}
    >
      <BranchTabs
        branches={branches}
        activeBranchId={activeBranchId}
        onChange={setActiveBranchId}
      />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <div>
          <h3 style={sectionTitle()}>{terminology.workforceGroupPlural}</h3>
          <div style={{ display: "flex", gap: 10, margin: "12px 0 14px" }}>
            <input
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && addGroup()}
              style={inputStyle()}
              maxLength={GROUP_NAME_MAX_LENGTH}
              placeholder={`Add ${terminology.workforceGroupLabel.toLowerCase()}`}
            />
            <button
              type="button"
              onClick={addGroup}
              style={buttonStyle("primary")}
            >
              <Plus size={15} /> Add
            </button>
          </div>
          <ChipList
            items={groupList}
            empty={`No ${terminology.workforceGroupPlural.toLowerCase()} configured for this branch.`}
            onRemove={(id) =>
              setGroups((prev) => ({
                ...prev,
                [activeBranchId]: (prev[activeBranchId] || []).filter(
                  (item) => item.id !== id,
                ),
              }))
            }
          />
        </div>
        <div>
          <h3 style={sectionTitle()}>{terminology.designationPlural}</h3>
          <div style={{ display: "flex", gap: 10, margin: "12px 0 14px" }}>
            <input
              value={designationName}
              onChange={(event) => setDesignationName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && addDesignation()}
              style={inputStyle()}
              maxLength={GROUP_NAME_MAX_LENGTH}
              placeholder={`Add ${terminology.designationLabel.toLowerCase()}`}
            />
            <button
              type="button"
              onClick={addDesignation}
              style={buttonStyle("primary")}
            >
              <Plus size={15} /> Add
            </button>
          </div>
          <ChipList
            items={designationList}
            empty={`No ${terminology.designationPlural.toLowerCase()} configured for this branch.`}
            onRemove={(id) =>
              setDesignations((prev) => ({
                ...prev,
                [activeBranchId]: (prev[activeBranchId] || []).filter(
                  (item) => item.id !== id,
                ),
              }))
            }
          />
        </div>
      </div>
    </ConfigCard>
  );
}

function ShiftSchedulingEditor({
  activePeopleTypes,
  shiftEnabledPeopleTypes,
  setShiftEnabledPeopleTypes,
  terminology,
}: {
  activePeopleTypes: string[];
  shiftEnabledPeopleTypes: string[] | undefined;
  setShiftEnabledPeopleTypes: (
    updater: React.SetStateAction<string[] | undefined>,
  ) => void;
  terminology: Terminology;
}) {
  const current = shiftEnabledPeopleTypes || [];

  const toggle = (peopleType: string) => {
    const normalized = normalizeKey(peopleType);
    setShiftEnabledPeopleTypes((prev) => {
      const existing = prev || [];
      return existing.includes(normalized)
        ? existing.filter((v) => v !== normalized)
        : [...existing, normalized];
    });
  };

  if (!activePeopleTypes || activePeopleTypes.length === 0) return null;

  return (
    <ConfigCard icon={<ShieldCheck size={18} />} title="Shift Scheduling">
      <p style={{ margin: "6px 0 12px", color: C.textSub }}>
        Enable shift-based attendance for the people types below. These settings
        are saved as part of the onboarding config and are template-aware.
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        {activePeopleTypes.map((pt) => {
          const normalized = normalizeKey(pt);
          return (
            <label
              key={pt}
              style={{ display: "flex", alignItems: "center", gap: 10 }}
            >
              <input
                type="checkbox"
                checked={current.includes(normalized)}
                onChange={() => toggle(pt)}
              />
              <span style={{ fontSize: 14 }}>{titleCase(pt)}</span>
            </label>
          );
        })}
      </div>
    </ConfigCard>
  );
}

function CameraSettingsEditor({
  branches,
  cameras,
  setCameras,
  network,
  setNetwork,
  terminology,
  organization,
}: {
  branches: Branch[];
  cameras: Record<string, CameraItem[]>;
  setCameras: React.Dispatch<
    React.SetStateAction<Record<string, CameraItem[]>>
  >;
  network: NetworkConfig;
  setNetwork: React.Dispatch<React.SetStateAction<NetworkConfig>>;
  terminology: Terminology;
  organization?: BootstrapOrganization;
}) {
  const [activeBranchId, setActiveBranchId] = useState(branches[0]?.id || "");
  const list = cameras[activeBranchId] || [];

  const addCamera = () => {
    if (!activeBranchId) return;
    setCameras((prev) => ({
      ...prev,
      [activeBranchId]: [
        ...(prev[activeBranchId] || []),
        {
          id: makeId("camera"),
          name: "",
          location: "",
          rtspUrl: "",
          channel: "1",
          type: "nvr",
        },
      ],
    }));
  };

  const patchCamera = (cameraId: string, patch: Partial<CameraItem>) => {
    setCameras((prev) => {
      const list = prev[activeBranchId] || [];
      return {
        ...prev,
        [activeBranchId]: list.map((camera) => {
          if (camera.id !== cameraId) return camera;
          const next = { ...camera, ...patch };
          // Switching a camera to webcam: seed a sensible default device
          // index (0, 1, 2...) based on how many webcams already exist on
          // this branch. Stays editable afterward for the multi-webcam
          // case. Mirrors OnboardingWizard.tsx's patchCamera exactly.
          if (patch.type === "webcam" && camera.type !== "webcam") {
            const webcamIndex = list.filter(
              (c) => c.type === "webcam" && c.id !== cameraId,
            ).length;
            next.channel = String(webcamIndex);
          }
          return next;
        }),
      };
    });
  };

  return (
    <ConfigCard
      icon={<Camera size={18} />}
      title={`Network & ${terminology.cameraPlural}`}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 14,
          marginBottom: 18,
        }}
      >
        <Field label="Public IP / Static IP">
          <input
            value={network.publicIp}
            onChange={(event) =>
              setNetwork((prev) => ({ ...prev, publicIp: event.target.value }))
            }
            style={inputStyle()}
            maxLength={IP_MAX_LENGTH}
          />
        </Field>
        <Field label="NVR / DVR Local IP">
          <input
            value={network.nvrDvrIp}
            onChange={(event) =>
              setNetwork((prev) => ({ ...prev, nvrDvrIp: event.target.value }))
            }
            style={inputStyle()}
            maxLength={IP_MAX_LENGTH}
          />
        </Field>
        <Field label="RTSP Port">
          <input
            value={network.rtspPort}
            onChange={(event) =>
              setNetwork((prev) => ({ ...prev, rtspPort: event.target.value }))
            }
            style={inputStyle()}
            maxLength={PORT_MAX_LENGTH}
          />
        </Field>
        <Field label="RTSP Username">
          <input
            value={network.rtspUsername}
            onChange={(event) =>
              setNetwork((prev) => ({
                ...prev,
                rtspUsername: event.target.value,
              }))
            }
            style={inputStyle()}
            maxLength={CREDENTIAL_MAX_LENGTH}
          />
        </Field>
        <Field label="RTSP Password">
          <input
            type="password"
            value={network.rtspPassword}
            onChange={(event) =>
              setNetwork((prev) => ({
                ...prev,
                rtspPassword: event.target.value,
              }))
            }
            maxLength={CREDENTIAL_MAX_LENGTH}
            style={inputStyle()}
          />
        </Field>
      </div>

      <BranchTabs
        branches={branches}
        activeBranchId={activeBranchId}
        onChange={setActiveBranchId}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <h3 style={sectionTitle()}>
          {terminology.branchLabel} {terminology.cameraPlural}
        </h3>
        <button
          type="button"
          onClick={addCamera}
          style={buttonStyle("primary")}
        >
          <Plus size={15} /> Add {terminology.cameraLabel}
        </button>
      </div>
      {list.length === 0 ? (
        <EmptyText
          text={`No ${terminology.cameraPlural.toLowerCase()} configured for this branch.`}
        />
      ) : null}
      <div style={{ display: "grid", gap: 10 }}>
        {list.map((camera) => (
          <div
            key={camera.id}
            style={cardStyle({ padding: 12, boxShadow: "none" })}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 92px 118px auto",
                gap: 8,
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <input
                value={camera.name}
                onChange={(event) =>
                  patchCamera(camera.id, { name: event.target.value })
                }
                style={inputStyle()}
                placeholder={`${terminology.cameraLabel} name`}
                maxLength={CAMERA_NAME_MAX_LENGTH}
              />
              <input
                value={camera.location}
                onChange={(event) =>
                  patchCamera(camera.id, { location: event.target.value })
                }
                style={inputStyle()}
                placeholder="Location / zone"
                maxLength={CAMERA_LOCATION_MAX_LENGTH}
              />
              <input
                value={camera.channel}
                onChange={(event) =>
                  patchCamera(camera.id, { channel: event.target.value })
                }
                style={inputStyle()}
                placeholder={camera.type === "webcam" ? "Device index" : "Ch."}
                maxLength={CAMERA_CHANNEL_MAX_LENGTH}
              />
              <select
                value={camera.type}
                onChange={(event) =>
                  patchCamera(camera.id, {
                    type: event.target.value as CameraItem["type"],
                  })
                }
                style={inputStyle()}
              >
                <option value="nvr">NVR</option>
                <option value="dvr">DVR</option>
                <option value="ip_camera">IP Camera</option>
                {organization?.attendance_mode === "local" && (
                  <option value="webcam">Webcam (USB/built-in)</option>
                )}
              </select>
              <button
                type="button"
                aria-label={`Remove ${camera.name || terminology.cameraLabel}`}
                onClick={() =>
                  setCameras((prev) => ({
                    ...prev,
                    [activeBranchId]: (prev[activeBranchId] || []).filter(
                      (item) => item.id !== camera.id,
                    ),
                  }))
                }
                style={buttonStyle("danger")}
              >
                <Trash2 size={15} />
              </button>
            </div>
            {camera.type !== "webcam" && (
              <>
                <input
                  value={camera.rtspUrl}
                  onChange={(event) =>
                    patchCamera(camera.id, { rtspUrl: event.target.value })
                  }
                  style={inputStyle({
                    fontFamily: "monospace",
                    fontSize: 12,
                    ...(validateRtspUrl(camera.rtspUrl)
                      ? { borderColor: C.danger }
                      : null),
                  })}
                  placeholder="Optional full RTSP URL. Leave empty when network + channel is enough."
                  spellCheck={false}
                  maxLength={RTSP_URL_MAX_LENGTH}
                  aria-invalid={Boolean(validateRtspUrl(camera.rtspUrl))}
                />
                {validateRtspUrl(camera.rtspUrl) && (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      color: C.danger,
                    }}
                  >
                    {validateRtspUrl(camera.rtspUrl)}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </ConfigCard>
  );
}

function ProfileSettingsEditor({
  organization,
  branches,
  config,
  setConfig,
  terminology,
}: {
  organization?: BootstrapOrganization;
  branches: Branch[];
  config: OperationalConfig;
  setConfig: React.Dispatch<React.SetStateAction<OperationalConfig>>;
  terminology: Terminology;
}) {
  return (
    <ConfigCard
      icon={<Building2 size={18} />}
      title={`${terminology.organizationLabel} Profile`}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 18,
        }}
      >
        <ReadOnlyLine
          label={terminology.organizationLabel}
          value={organization?.name || "—"}
        />
        <ReadOnlyLine label="Status" value={organization?.status || "—"} />
        <ReadOnlyLine
          label="Attendance Mode"
          value={(
            organization?.attendance_mode ||
            organization?.attendanceMode ||
            "—"
          ).toUpperCase()}
        />
        <ReadOnlyLine
          label="Support-created branches"
          value={String(branches.length)}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="Address">
          <input
            value={config.company_profile.address}
            onChange={(event) =>
              setConfig((prev) => ({
                ...prev,
                company_profile: {
                  ...prev.company_profile,
                  address: event.target.value,
                },
              }))
            }
            style={inputStyle()}
            maxLength={ADDRESS_MAX_LENGTH}
          />
        </Field>
        <Field label="City">
          <input
            value={config.company_profile.city}
            onChange={(event) =>
              setConfig((prev) => ({
                ...prev,
                company_profile: {
                  ...prev.company_profile,
                  city: event.target.value,
                },
              }))
            }
            style={inputStyle()}
            maxLength={CITY_MAX_LENGTH}
          />
        </Field>
        <Field label="Public Contact Phone">
          <input
            value={config.company_profile.publicContactPhone}
            onChange={(event) =>
              setConfig((prev) => ({
                ...prev,
                company_profile: {
                  ...prev.company_profile,
                  publicContactPhone: event.target.value,
                },
              }))
            }
            style={inputStyle()}
            maxLength={PHONE_MAX_LENGTH}
          />
        </Field>
        <Field label="Timezone">
          <select
            value={config.company_profile.timezone}
            onChange={(event) =>
              setConfig((prev) => ({
                ...prev,
                company_profile: {
                  ...prev.company_profile,
                  timezone: event.target.value,
                },
              }))
            }
            style={inputStyle()}
          >
            <option value="Asia/Karachi">Asia/Karachi</option>
            <option value="Asia/Dubai">Asia/Dubai</option>
            <option value="UTC">UTC</option>
          </select>
        </Field>
      </div>
    </ConfigCard>
  );
}

export function ConfigCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={cardStyle({ padding: 18 })}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 16,
        }}
      >
        <span style={{ color: C.primary }}>{icon}</span>
        <h2 style={sectionTitle()}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function ReadOnlyLine({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: C.tealPale,
        border: `1px solid ${C.border}`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 850,
          color: C.textSub,
          textTransform: "uppercase",
          letterSpacing: ".05em",
        }}
      >
        {label}
      </div>
      <div
        style={{ fontSize: 14, fontWeight: 900, color: C.text, marginTop: 4 }}
      >
        {value}
      </div>
    </div>
  );
}

function ChipList<T extends { id: string; name: string }>({
  items,
  empty,
  onRemove,
}: {
  items: T[];
  empty: string;
  onRemove: (id: string) => void;
}) {
  if (!items.length) return <EmptyText text={empty} />;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
      {items.map((item) => (
        <span
          key={item.id}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 11px",
            borderRadius: 999,
            background: C.tealPale,
            border: `1px solid ${C.border}`,
            color: C.primaryDark,
            fontSize: 13,
            fontWeight: 800,
          }}
        >
          {item.name}
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            onClick={() => onRemove(item.id)}
            style={{
              border: "none",
              background: "transparent",
              color: C.textMuted,
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            <Trash2 size={13} />
          </button>
        </span>
      ))}
    </div>
  );
}

function EmptyText({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 13,
        color: C.textMuted,
        fontStyle: "italic",
        padding: "10px 0",
      }}
    >
      {text}
    </div>
  );
}

export default function Settings() {
  const auth = useAuth() as unknown as AuthContext;
  const { user, refreshUser } = auth;
  const organizationId = user?.organization_id || user?.organizationId;

  // Access gate: staff without the "settings" module grant never reach this
  // screen, even by typing /admin/settings directly — the gear icon in
  // AdminLayout.tsx already hides for them, this is the defense-in-depth
  // backstop. Admins/branch-admins (any non-"staff" role) always pass.
  const isRestrictedStaff =
    isStaffAccount(user) &&
    !getAccountAllowedModules(user).includes("settings");

  if (isRestrictedStaff) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 320,
          gap: 10,
          textAlign: "center",
          padding: 24,
        }}
      >
        <AlertCircle size={28} color="#94a3b8" />
        <p
          style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#334155" }}
        >
          You don't have access to Settings
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "#64748b", maxWidth: 360 }}>
          Ask your admin to grant the Settings module from Staff Management if
          you need to configure departments, capture settings, or timing
          overrides.
        </p>
      </div>
    );
  }

  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [config, setConfig] = useState<OperationalConfig>(() =>
    emptyConfig([]),
  );
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<string>("");

  const hasInvalidCameraRtspUrl = useMemo(
    () => findInvalidCameraRtspUrl(config.cameras) !== null,
    [config.cameras],
  );

  // Keep the selected branch valid as soon as branches load or change,
  // preferring whichever branch is named in the URL over always falling
  // back to branches[0]. This component remounts from scratch every time
  // the user navigates back to Settings (see the `isLoading` early return
  // further down), so without restoring the prior selection, the Attendance
  // Configuration section — and the manual instructions / capture settings
  // scoped to it — would silently flip back to the first branch and look
  // empty, even though the data for the previously-selected branch was
  // never touched.
  useEffect(() => {
    if (!branches.length) return;
    if (branches.some((b) => b.id === selectedBranchId)) return;
    const fromUrl = readBranchIdFromUrl();
    const restored =
      fromUrl && branches.some((b) => b.id === fromUrl)
        ? fromUrl
        : branches[0].id;
    setSelectedBranchId(restored);
  }, [branches, selectedBranchId]);

  // Keep the URL in sync so the restore effect above (and a page refresh,
  // or a shared link) can find the current selection again.
  useEffect(() => {
    if (selectedBranchId) {
      writeBranchIdToUrl(selectedBranchId);
    }
  }, [selectedBranchId]);

  const load = useCallback(async () => {
    if (!organizationId) {
      setError(
        "Organization is missing from the logged-in user. Please log in again.",
      );
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const data = await loadClientBootstrap<BootstrapResponse>(organizationId);
      const nextBranches = data.branches || [];
      setBootstrap(data);
      setBranches(nextBranches);
      setConfig(configFromBootstrap(data, nextBranches));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load dashboard setup.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const plan = useMemo(() => resolveOperationalPlan(bootstrap), [bootstrap]);
  const terminology = useMemo(
    () => buildTerminology(bootstrap, plan),
    [bootstrap, plan],
  );

  const activePeopleTypes = useMemo(() => {
    const org = bootstrap?.organization;
    const vertical = asRecord(org?.vertical_config || org?.verticalConfig);
    const enabled = readStringList(
      org?.enabled_people_types,
      org?.enabledPeopleTypes,
      vertical.enabled_people_types,
      vertical.enabledPeopleTypes,
    );
    const attendance = readStringList(
      org?.attendance_people_types,
      org?.attendancePeopleTypes,
      vertical.attendance_people_types,
      vertical.attendancePeopleTypes,
    );
    const primary = normalizeKey(
      org?.primary_people_type ||
        org?.primaryPeopleType ||
        vertical.primary_people_type ||
        "staff",
    );
    const scope = attendance.length
      ? attendance
      : enabled.length
        ? enabled
        : [primary];
    return scope;
  }, [bootstrap]);

  const save = async () => {
    if (!user?.id || !organizationId) {
      setError("User or organization is missing. Please log in again.");
      return;
    }

    const rtspError = findInvalidCameraRtspUrl(config.cameras);
    if (rtspError) {
      setError(rtspError);
      return;
    }

    try {
      setIsSaving(true);
      setError(null);
      setSavedMessage(null);
      const data = await saveOperationalConfig({
        user_id: user.id,
        organization_id: organizationId,
        config,
      });
      const nextBranches = data.branches || branches;
      setBootstrap(data);
      setBranches(nextBranches);
      setConfig(configFromBootstrap(data, nextBranches));
      if (refreshUser && user.id) await refreshUser(user.id);
      setSavedMessage(
        "Operational setup saved. Dashboard pages will read the updated config from bootstrap.",
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save dashboard setup.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: 360,
          display: "grid",
          placeItems: "center",
          color: C.primaryDark,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontWeight: 900,
          }}
        >
          <Loader2
            size={20}
            style={{ animation: "spin .8s linear infinite" }}
          />{" "}
          Loading settings…
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100%",
        background: C.bg,
        padding: 28,
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 18,
            marginBottom: 22,
          }}
        >
          <div>
            <h1
              style={{
                margin: "0 0 8px",
                fontSize: 28,
                color: C.primary,
                fontWeight: 950,
                letterSpacing: "-.03em",
              }}
            >
              Dashboard Setup
            </h1>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={isSaving || hasInvalidCameraRtspUrl}
            style={{
              ...buttonStyle("primary"),
              minWidth: 150,
              opacity: isSaving || hasInvalidCameraRtspUrl ? 0.7 : 1,
            }}
          >
            {isSaving ? (
              <Loader2
                size={17}
                style={{ animation: "spin .8s linear infinite" }}
              />
            ) : (
              <Save size={17} />
            )}
            {isSaving ? "Saving…" : "Save Setup"}
          </button>
        </div>

        {error ? (
          <div
            style={cardStyle({
              borderColor: "#fecaca",
              background: "#fef2f2",
              padding: 14,
              marginBottom: 18,
              color: C.danger,
              fontSize: 13,
              fontWeight: 800,
            })}
          >
            <AlertCircle
              size={16}
              style={{ verticalAlign: "middle", marginRight: 6 }}
            />{" "}
            {error}
          </div>
        ) : null}

        {savedMessage ? (
          <div
            style={cardStyle({
              borderColor: "#bbf7d0",
              background: "#f0fdf4",
              padding: 14,
              marginBottom: 18,
              color: C.success,
              fontSize: 13,
              fontWeight: 800,
            })}
          >
            <CheckCircle2
              size={16}
              style={{ verticalAlign: "middle", marginRight: 6 }}
            />{" "}
            {savedMessage}
          </div>
        ) : null}

        <div style={{ display: "grid", gap: 18 }}>
          <ProfileSettingsEditor
            organization={bootstrap?.organization}
            branches={branches}
            config={config}
            setConfig={setConfig}
            terminology={terminology}
          />

          {plan.hasStudentSetup ? (
            <StudentStructureEditor
              branches={branches}
              groups={config.departments}
              setGroups={(updater) =>
                setConfig((prev) => ({
                  ...prev,
                  departments:
                    typeof updater === "function"
                      ? updater(prev.departments)
                      : updater,
                }))
              }
              terminology={terminology}
            />
          ) : null}

          {plan.hasWorkforceSetup ? (
            <WorkforceStructureEditor
              branches={branches}
              groups={config.departments}
              setGroups={(updater) =>
                setConfig((prev) => ({
                  ...prev,
                  departments:
                    typeof updater === "function"
                      ? updater(prev.departments)
                      : updater,
                }))
              }
              designations={config.roles}
              setDesignations={(updater) =>
                setConfig((prev) => ({
                  ...prev,
                  roles:
                    typeof updater === "function"
                      ? updater(prev.roles)
                      : updater,
                }))
              }
              terminology={terminology}
            />
          ) : null}

          <ShiftSchedulingEditor
            activePeopleTypes={activePeopleTypes}
            shiftEnabledPeopleTypes={config.shiftEnabledPeopleTypes}
            setShiftEnabledPeopleTypes={(updater) =>
              setConfig((prev) => ({
                ...prev,
                shiftEnabledPeopleTypes:
                  typeof updater === "function"
                    ? (updater(prev.shiftEnabledPeopleTypes) as string[])
                    : (updater as string[]),
              }))
            }
            terminology={terminology}
          />

          <CameraSettingsEditor
            branches={branches}
            organization={bootstrap?.organization}
            cameras={config.cameras}
            setCameras={(updater) =>
              setConfig((prev) => ({
                ...prev,
                cameras:
                  typeof updater === "function"
                    ? updater(prev.cameras)
                    : updater,
              }))
            }
            network={config.network}
            setNetwork={(updater) =>
              setConfig((prev) => ({
                ...prev,
                network:
                  typeof updater === "function"
                    ? updater(prev.network)
                    : updater,
              }))
            }
            terminology={terminology}
          />
        </div>
      </div>
    </div>
  );
}