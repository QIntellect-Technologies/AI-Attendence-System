import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  Building2,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Eye,
  GitBranch,
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
import {
  MAX_PHOTO_BYTES,
  MAX_UPLOAD_BYTES,
  checkFileSize,
} from "../../utils/uploadLimits";

type Branch = {
  id: string;
  name: string;
  location?: string | null;
  max_staff_capacity?: number | null;
};

type SupportModule = {
  id?: string;
  module_name?: string;
  status?: string;
};

type BootstrapResponse = {
  success: boolean;
  message?: string;
  organization?: {
    id: string;
    name: string;
    contact_email?: string;
    contact_phone?: string | null;
    org_type?: string | null;
    business_type?: string | null;
    biz_type?: string | null;
    primary_people_type?: string | null;
    enabled_people_types?: string[];
    enabledPeopleTypes?: string[];
    attendance_people_types?: string[];
    attendancePeopleTypes?: string[];
    vertical_config?: Record<string, unknown> | null;
    verticalConfig?: Record<string, unknown> | null;
    terminology_overrides?: Record<string, unknown> | null;
    terminologyOverrides?: Record<string, unknown> | null;
    attendance_mode?: string;
    max_branches?: number;
    status?: string;
  };
  branches?: Branch[];
  modules?: SupportModule[];
  active_modules?: string[];
  activeModules?: string[];
  config?: Partial<ConfigState> & Record<string, unknown>;
  onboarding_config?: Partial<ConfigState> & Record<string, unknown>;
  onboardingConfig?: Partial<ConfigState> & Record<string, unknown>;
};

type OnboardingAuthUser = {
  id?: string | number;
  organization_id?: string | null;
  organizationId?: string | null;
};

type OnboardingAuthContext = {
  user?: OnboardingAuthUser | null;
  refreshUser?: (userId: string | number) => Promise<unknown> | unknown;
};

type CompanyProfile = {
  address: string;
  city: string;
  publicContactPhone: string;
  timezone: string;
  logoDataUrl: string;
  logoFileName: string;
};

type PeopleFamily = "student" | "workforce";

type Department = {
  id: string;
  name: string;
  className?: string;
  sectionName?: string;
  personFamily?: PeopleFamily;
  peopleType?: string;
  itemKind?: "group" | "class_section";
};

type RoleItem = {
  id: string;
  name: string;
  personFamily?: PeopleFamily;
  peopleType?: string;
  level:
    | "admin"
    | "manager"
    | "staff"
    | "teacher"
    | "student"
    | "worker"
    | "custom";
};

type CameraItem = {
  id: string;
  name: string;
  location: string;
  rtspUrl: string;
  channel: string; // NVR channel, or local device index when type === "webcam"
  type: "nvr" | "dvr" | "ip_camera" | "webcam";
};

type NetworkConfig = {
  publicIp: string;
  nvrDvrIp: string;
  rtspUsername: string;
  rtspPassword: string;
  rtspPort: string;
};

type ConfigState = {
  company_profile: CompanyProfile;
  departments: Record<string, Department[]>;
  roles: Record<string, RoleItem[]>;
  cameras: Record<string, CameraItem[]>;
  network: NetworkConfig;
  shiftEnabledPeopleTypes?: string[];
};

type StepKey =
  | "profile"
  | "student_structure"
  | "workforce_structure"
  | "cameras"
  | "review";

type DynamicTerminology = {
  organizationLabel: string;
  branchLabel: string;
  groupLabel: string;
  groupPlural: string;
  subgroupLabel: string;
  roleLabel: string;
  rolePlural: string;
  personSingular: string;
  personPlural: string;
  personCodeLabel: string;
  cameraLabel: string;
  cameraPlural: string;
  hasAcademicSections: boolean;
};

type OnboardingPlan = {
  activePeopleTypes: string[];
  studentPeopleTypes: string[];
  workforcePeopleTypes: string[];
  showStudentStructure: boolean;
  showWorkforceStructure: boolean;
  studentGroupLabel: string;
  studentGroupPlural: string;
  studentSubgroupLabel: string;
  workforceGroupLabel: string;
  workforceGroupPlural: string;
  workforceRoleLabel: string;
  workforceRolePlural: string;
};

const C = {
  primary: "#1a699f",
  primaryDark: "#155580",
  primaryDarker: "#0d3f61",
  teal: "#0d9488",
  tealLight: "#e6f3f9",
  tealPale: "#f0f8fc",
  bg: "#eef8fc",
  card: "#ffffff",
  border: "#dbe8f0",
  text: "#0f172a",
  textSub: "#475569",
  textMuted: "#94a3b8",
  success: "#16a34a",
  danger: "#dc2626",
  amber: "#b45309",
  amberBg: "#fffbeb",
} as const;

function buildSteps(
  terminology: DynamicTerminology,
  plan: OnboardingPlan,
): { key: StepKey; label: string; icon: React.ElementType }[] {
  const steps: { key: StepKey; label: string; icon: React.ElementType }[] = [
    {
      key: "profile",
      label: `${terminology.organizationLabel} Profile`,
      icon: Building2,
    },
  ];

  if (plan.showStudentStructure) {
    steps.push({
      key: "student_structure",
      label: plan.studentGroupPlural,
      icon: Users,
    });
  }

  if (plan.showWorkforceStructure) {
    steps.push({
      key: "workforce_structure",
      label: `${plan.workforceGroupPlural} & ${plan.workforceRolePlural}`,
      icon: ShieldCheck,
    });
  }

  steps.push(
    {
      key: "cameras",
      label: `Network & ${terminology.cameraPlural}`,
      icon: Camera,
    },
    { key: "review", label: "Review & Launch", icon: ClipboardCheck },
  );

  return steps;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function normalizePeopleType(value: unknown): string {
  return String(value || "staff")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function normalizePeopleTypeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizePeopleType(item)).filter(Boolean);
}

function isStudentPeopleType(peopleType: string): boolean {
  return [
    "student",
    "students",
    "learner",
    "learners",
    "pupil",
    "pupils",
  ].includes(normalizePeopleType(peopleType));
}

function hasAnyValue(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function resolveOnboardingPlan(
  data: BootstrapResponse | null,
  terminology: DynamicTerminology,
): OnboardingPlan {
  const org = (data?.organization ?? {}) as Partial<
    NonNullable<BootstrapResponse["organization"]>
  >;
  const verticalConfig = (org.vertical_config ||
    org.verticalConfig ||
    {}) as Record<string, unknown>;
  const overrides = (org.terminology_overrides ||
    org.terminologyOverrides ||
    {}) as Record<string, unknown>;

  const enabledPeopleTypes = normalizePeopleTypeList(
    org.enabled_people_types ||
      org.enabledPeopleTypes ||
      verticalConfig.enabled_people_types ||
      verticalConfig.enabledPeopleTypes,
  );
  const attendancePeopleTypes = normalizePeopleTypeList(
    org.attendance_people_types ||
      org.attendancePeopleTypes ||
      verticalConfig.attendance_people_types ||
      verticalConfig.attendancePeopleTypes,
  );

  const fallbackPrimary = normalizePeopleType(
    org.primary_people_type || verticalConfig.primary_people_type || "staff",
  );
  const activePeopleTypes =
    attendancePeopleTypes.length > 0
      ? attendancePeopleTypes
      : enabledPeopleTypes.length > 0
        ? enabledPeopleTypes
        : [fallbackPrimary];

  const studentPeopleTypes = activePeopleTypes.filter(isStudentPeopleType);
  const workforcePeopleTypes = activePeopleTypes.filter(
    (peopleType) => !isStudentPeopleType(peopleType),
  );

  const businessType = String(
    org.business_type ||
      org.biz_type ||
      org.org_type ||
      verticalConfig.business_type ||
      "company",
  ).toLowerCase();

  const isFactory =
    businessType.includes("factory") ||
    businessType.includes("manufacturing") ||
    workforcePeopleTypes.some((peopleType) =>
      ["worker", "workers"].includes(peopleType),
    );

  const defaultWorkforceGroupLabel = isFactory
    ? "Department / Unit"
    : "Department";
  const defaultWorkforceGroupPlural = isFactory
    ? "Departments / Units"
    : "Departments";

  return {
    activePeopleTypes,
    studentPeopleTypes,
    workforcePeopleTypes,
    showStudentStructure: studentPeopleTypes.length > 0,
    showWorkforceStructure: workforcePeopleTypes.length > 0,
    studentGroupLabel: labelFromOverride(
      overrides,
      ["studentGroup", "class", "classLabel"],
      "Class",
    ),
    studentGroupPlural: labelFromOverride(
      overrides,
      ["studentGroups", "classes", "classPlural"],
      "Classes & Sections",
    ),
    studentSubgroupLabel: labelFromOverride(
      overrides,
      ["studentSubgroup", "section", "sectionLabel"],
      "Section",
    ),
    workforceGroupLabel: labelFromOverride(
      overrides,
      ["workforceGroup", "department", "unit", "departmentLabel"],
      defaultWorkforceGroupLabel,
    ),
    workforceGroupPlural: labelFromOverride(
      overrides,
      ["workforceGroups", "departments", "units", "departmentPlural"],
      defaultWorkforceGroupPlural,
    ),
    workforceRoleLabel: labelFromOverride(
      overrides,
      ["workforceRole", "designation", "role", "designationLabel"],
      "Designation",
    ),
    workforceRolePlural: labelFromOverride(
      overrides,
      ["workforceRoles", "designations", "roles", "designationPlural"],
      "Designations",
    ),
  };
}

function buildTerminology(data: BootstrapResponse | null): DynamicTerminology {
  const org = (data?.organization ?? {}) as Partial<
    NonNullable<BootstrapResponse["organization"]>
  >;
  const verticalConfig = (org.vertical_config ||
    org.verticalConfig ||
    {}) as Record<string, unknown>;
  const overrides = (org.terminology_overrides ||
    org.terminologyOverrides ||
    {}) as Record<string, unknown>;

  const businessType = String(
    org.business_type ||
      org.biz_type ||
      org.org_type ||
      verticalConfig.business_type ||
      "company",
  ).toLowerCase();

  const primaryPeopleType = normalizePeopleType(
    org.primary_people_type || verticalConfig.primary_people_type || "staff",
  );

  const academic =
    businessType.includes("school") ||
    businessType.includes("college") ||
    businessType.includes("university") ||
    businessType.includes("academy") ||
    ["student", "students", "teacher", "teachers"].includes(primaryPeopleType);

  const factory =
    businessType.includes("factory") ||
    businessType.includes("manufacturing") ||
    primaryPeopleType === "worker" ||
    primaryPeopleType === "workers";

  const personSingularFallback = academic
    ? primaryPeopleType.includes("teacher")
      ? "Teacher"
      : "Student"
    : factory
      ? "Worker"
      : primaryPeopleType === "admin" || primaryPeopleType === "administration"
        ? "Administrator"
        : "Person";

  const personPluralFallback = academic
    ? primaryPeopleType.includes("teacher")
      ? "Teachers"
      : "Students"
    : factory
      ? "Workers"
      : primaryPeopleType === "admin" || primaryPeopleType === "administration"
        ? "Administration"
        : "People";

  const groupLabelFallback = academic
    ? "Class"
    : factory
      ? "Department / Unit"
      : "Department";
  const groupPluralFallback = academic
    ? "Classes & Sections"
    : factory
      ? "Departments / Units"
      : "Departments";
  const roleLabelFallback = academic ? "Designation" : "Role / Designation";
  const rolePluralFallback = academic ? "Designations" : "Roles & Designations";

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
    groupLabel: labelFromOverride(
      overrides,
      ["group", "department", "class", "groupLabel", "departmentLabel"],
      groupLabelFallback,
    ),
    groupPlural: labelFromOverride(
      overrides,
      ["groups", "departments", "classes", "groupPlural", "departmentPlural"],
      groupPluralFallback,
    ),
    subgroupLabel: labelFromOverride(
      overrides,
      ["subgroup", "section", "subGroupLabel", "sectionLabel"],
      academic ? "Section" : "Subgroup",
    ),
    roleLabel: labelFromOverride(
      overrides,
      ["role", "designation", "roleLabel", "designationLabel"],
      roleLabelFallback,
    ),
    rolePlural: labelFromOverride(
      overrides,
      ["roles", "designations", "rolePlural", "designationPlural"],
      rolePluralFallback,
    ),
    personSingular: labelFromOverride(
      overrides,
      ["person", "personSingular", "student", "teacher", "worker", "employee"],
      personSingularFallback,
    ),
    personPlural: labelFromOverride(
      overrides,
      [
        "people",
        "personPlural",
        "students",
        "teachers",
        "workers",
        "employees",
      ],
      personPluralFallback,
    ),
    personCodeLabel: labelFromOverride(
      overrides,
      ["personCode", "personCodeLabel", "studentId", "employeeId", "staffId"],
      `${personSingularFallback} ID`,
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
    hasAcademicSections: academic,
  };
}

function formatModuleLabel(
  moduleKey: string,
  terminology: DynamicTerminology,
): string {
  const key = String(moduleKey || "")
    .trim()
    .toLowerCase();
  const labels: Record<string, string> = {
    attendance: "Attendance",
    employees: `${terminology.personPlural} Directory`,
    staff_directory: `${terminology.personPlural} Directory`,
    leave: "Leave Management",
    leave_management: "Leave Management",
    payroll: "Payroll",
    overtime: "Overtime",
    cctv: "CCTV",
    liveattendance: "Live Attendance",
    live_attendance: "Live Attendance",
    reports: "Reports",
  };
  return labels[key] || titleCase(key);
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyConfig(branches: Branch[]): ConfigState {
  const departments: Record<string, Department[]> = {};
  const roles: Record<string, RoleItem[]> = {};
  const cameras: Record<string, CameraItem[]> = {};

  branches.forEach((branch) => {
    const key = String(branch.id);
    departments[key] = [];
    roles[key] = [];
    cameras[key] = [];
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
    shiftEnabledPeopleTypes: [],
  };
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

function branchKeyMapFromBootstrap(
  data: BootstrapResponse,
  branches: Branch[],
): Record<string, string> {
  const map: Record<string, string> = {};
  branches.forEach((branch, index) => {
    const backendKey = String(branch.id);
    const uiKey = String(index + 1);
    map[backendKey] = backendKey;
    map[uiKey] = backendKey;
  });

  const configBranches = asArray<Record<string, unknown>>(
    data.config?.branches,
  );
  configBranches.forEach((branch) => {
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

function normalizeBranchRecord<T extends { id: string }>(
  value: unknown,
  branches: Branch[],
  keyMap: Record<string, string>,
  normalizeItem: (item: Record<string, unknown>) => T | null,
): Record<string, T[]> {
  const normalized: Record<string, T[]> = {};
  branches.forEach((branch) => {
    normalized[String(branch.id)] = [];
  });

  const record = asRecord(value);
  Object.entries(record).forEach(([rawKey, rawItems]) => {
    const branchKey = keyMap[String(rawKey)] || String(rawKey);
    if (!Object.prototype.hasOwnProperty.call(normalized, branchKey)) return;

    normalized[branchKey] = asArray<Record<string, unknown>>(rawItems)
      .map(normalizeItem)
      .filter((item): item is T => item !== null);
  });

  return normalized;
}

function normalizeDepartment(item: Record<string, unknown>): Department | null {
  const className = cleanText(item.className || item.class_name);
  const sectionName = cleanText(item.sectionName || item.section_name);
  const name =
    cleanText(item.name) ||
    [className, sectionName].filter(Boolean).join(" - ");
  if (!name) return null;

  const itemKind =
    cleanText(item.itemKind || item.item_kind) === "class_section" ||
    className ||
    sectionName
      ? "class_section"
      : "group";

  return {
    id: cleanText(item.id) || makeId("group"),
    name,
    className: className || undefined,
    sectionName: sectionName || undefined,
    personFamily:
      cleanText(item.personFamily || item.person_family) === "student" ||
      itemKind === "class_section"
        ? "student"
        : "workforce",
    peopleType: cleanText(item.peopleType || item.people_type) || undefined,
    itemKind,
  };
}

function normalizeRole(item: Record<string, unknown>): RoleItem | null {
  const name = cleanText(item.name);
  if (!name) return null;

  const level = cleanText(item.level).toLowerCase() as RoleItem["level"];
  const allowed: RoleItem["level"][] = [
    "admin",
    "manager",
    "staff",
    "teacher",
    "student",
    "worker",
    "custom",
  ];

  return {
    id: cleanText(item.id) || makeId("role"),
    name,
    personFamily: "workforce",
    peopleType: cleanText(item.peopleType || item.people_type) || undefined,
    level: allowed.includes(level) ? level : "custom",
  };
}

function normalizeCamera(item: Record<string, unknown>): CameraItem | null {
  const name = cleanText(item.name || item.camera_name || item.cameraName);
  const location = cleanText(item.location);
  const rtspUrl = cleanText(item.rtspUrl || item.rtsp_url);
  const channel = cleanText(item.channel) || "1";
  if (!name && !rtspUrl && !channel) return null;

  const rawType = cleanText(item.type).toLowerCase();
  const type: CameraItem["type"] =
    rawType === "dvr" ||
    rawType === "ip_camera" ||
    rawType === "nvr" ||
    rawType === "webcam"
      ? rawType
      : "nvr";

  return {
    id: cleanText(item.id) || makeId("cam"),
    name: name || "Camera",
    location,
    rtspUrl,
    channel,
    type,
  };
}

function configFromBootstrap(
  data: BootstrapResponse,
  branches: Branch[],
): ConfigState {
  const base = emptyConfig(branches);
  const rawSaved =
    data.onboarding_config || data.onboardingConfig || data.config || {};
  const saved = asRecord(rawSaved);
  const profile = asRecord(saved.company_profile || saved.companyProfile);
  const keyMap = branchKeyMapFromBootstrap(data, branches);
  const network = asRecord(
    saved.network || data.config?.network || data.config?.networkConfig,
  );
  const shiftEnabledPeopleTypes = normalizePeopleTypeList(
    saved.shiftEnabledPeopleTypes ||
      saved.shift_enabled_people_types ||
      data.config?.shiftEnabledPeopleTypes ||
      data.config?.shift_enabled_people_types,
  );

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
    departments: normalizeBranchRecord<Department>(
      saved.departments || data.config?.departments,
      branches,
      keyMap,
      normalizeDepartment,
    ),
    roles: normalizeBranchRecord<RoleItem>(
      saved.roles || data.config?.roles,
      branches,
      keyMap,
      normalizeRole,
    ),
    cameras: normalizeBranchRecord<CameraItem>(
      saved.cameras || data.config?.cameras,
      branches,
      keyMap,
      normalizeCamera,
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
    shiftEnabledPeopleTypes,
  };
}
function inputStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    width: "100%",
    height: 44,
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

function labelStyle(): React.CSSProperties {
  return {
    display: "block",
    fontSize: 11,
    color: C.textSub,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 6,
  };
}

function cardStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    background: C.card,
    border: `1.5px solid ${C.border}`,
    borderRadius: 16,
    boxShadow: "0 8px 26px rgba(15,45,74,.07)",
    ...extra,
  };
}

function totalCount<T>(record: Record<string, T[]>) {
  return Object.values(record).reduce((sum, list) => sum + list.length, 0);
}

async function completeClientOnboarding(payload: {
  user_id: string | number;
  organization_id: string | number;
  config: ConfigState;
}): Promise<{ success: boolean; message?: string; error?: string }> {
  return fetchClientJson<{
    success: boolean;
    message?: string;
    error?: string;
  }>("/api/client/onboarding/complete", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function BranchTabs({
  branches,
  activeBranchId,
  setActiveBranchId,
}: {
  branches: Branch[];
  activeBranchId: string;
  setActiveBranchId: (id: string) => void;
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
            onClick={() => setActiveBranchId(branch.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 14px",
              borderRadius: 999,
              border: `1.5px solid ${active ? C.primary : C.border}`,
              background: active ? C.tealLight : C.card,
              color: active ? C.primaryDark : C.textSub,
              fontSize: 12,
              fontWeight: active ? 800 : 650,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <GitBranch size={13} />
            {branch.name}
          </button>
        );
      })}
    </div>
  );
}

function ReadOnlyBranches({ branches }: { branches: Branch[] }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {branches.map((branch) => (
        <div
          key={branch.id}
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 14px",
            borderRadius: 12,
            background: C.tealPale,
            border: `1px solid ${C.border}`,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 900, color: C.text }}>
              {branch.name}
            </div>
            <div style={{ fontSize: 11, color: C.textSub, marginTop: 3 }}>
              {branch.location || "No location"}
            </div>
          </div>
          <div style={{ fontSize: 11, color: C.textSub, textAlign: "right" }}>
            Capacity
            <div
              style={{ fontSize: 13, fontWeight: 900, color: C.primaryDark }}
            >
              {branch.max_staff_capacity ?? "—"}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Sidebar({
  stepIndex,
  organizationName,
  branches,
  modules,
  steps,
  terminology,
}: {
  stepIndex: number;
  organizationName: string;
  branches: Branch[];
  modules: string[];
  steps: { key: StepKey; label: string; icon: React.ElementType }[];
  terminology: DynamicTerminology;
}) {
  return (
    <aside
      style={{
        width: 260,
        minHeight: "100vh",
        background: "linear-gradient(180deg,#0d3f61,#1a699f)",
        color: "#fff",
        padding: "32px 22px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 900, marginBottom: 34 }}>
        • QIntellect Technologies
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        {steps.map((step, index) => {
          const Icon = step.icon;
          const done = index < stepIndex;
          const active = index === stepIndex;
          return (
            <div
              key={step.key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                opacity: active || done ? 1 : 0.42,
              }}
            >
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: done
                    ? "#bae6fd"
                    : active
                      ? "#fff"
                      : "rgba(255,255,255,.14)",
                  color: done || active ? C.primaryDark : "#fff",
                  fontSize: 12,
                  fontWeight: 900,
                  flexShrink: 0,
                }}
              >
                {done ? <Check size={15} /> : <Icon size={14} />}
              </div>
              <span style={{ fontSize: 13, fontWeight: active ? 900 : 650 }}>
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: "auto",
          ...cardStyle({
            background: "rgba(255,255,255,.12)",
            border: "1px solid rgba(255,255,255,.18)",
            padding: 16,
          }),
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 5 }}>
          Support-created organization
        </div>
        <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 10 }}>
          {organizationName || "Organization"}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <span style={pillStyle()}>
            {branches.length} {terminology.branchLabel}
            {branches.length === 1 ? "" : "es"}
          </span>
          <span style={pillStyle()}>{modules.length} Modules</span>
        </div>
      </div>
    </aside>
  );
}

function pillStyle(): React.CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 800,
    color: "#e0f2fe",
    background: "rgba(255,255,255,.14)",
    borderRadius: 999,
    padding: "4px 9px",
  };
}

function Stepper({
  stepIndex,
  steps,
}: {
  stepIndex: number;
  steps: { key: StepKey; label: string; icon: React.ElementType }[];
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 42,
      }}
    >
      {steps.map((step, index) => {
        const Icon = step.icon;
        const active = index === stepIndex;
        const done = index < stepIndex;
        return (
          <React.Fragment key={step.key}>
            <div style={{ textAlign: "center", minWidth: 112 }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  margin: "0 auto 7px",
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: done || active ? C.primary : "transparent",
                  border: `2px solid ${done || active ? C.primary : "#bae6fd"}`,
                  color: done || active ? "#fff" : "#9cc9e5",
                }}
              >
                {done ? <Check size={18} /> : <Icon size={18} />}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: done || active ? C.primaryDark : C.textMuted,
                  fontWeight: done || active ? 900 : 700,
                }}
              >
                {step.label}
              </div>
            </div>
            {index < steps.length - 1 && (
              <div
                style={{
                  height: 2,
                  width: 115,
                  background: index < stepIndex ? C.primary : "#bae6fd",
                }}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function CompanyProfileStep({
  organization,
  branches,
  modules,
  profile,
  setProfile,
  terminology,
}: {
  organization: BootstrapResponse["organization"];
  branches: Branch[];
  modules: string[];
  profile: CompanyProfile;
  setProfile: React.Dispatch<React.SetStateAction<CompanyProfile>>;
  terminology: DynamicTerminology;
}) {
  return (
    <div>
      <h1 style={h1Style()}>
        Complete {terminology.organizationLabel.toLowerCase()} profile
      </h1>
      <p style={subStyle()}>
        Your organization, branches, purchased modules, and capacity limits are
        already locked by QIntellect Support. Add only operational profile
        details here.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.1fr .9fr",
          gap: 18,
          marginBottom: 22,
        }}
      >
        <div style={cardStyle({ padding: 18 })}>
          <div style={{ ...sectionTitle(), marginBottom: 12 }}>
            Read-only setup from QIntellect
          </div>
          <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
            <SummaryLine
              label={terminology.organizationLabel}
              value={organization?.name || "—"}
            />
            <SummaryLine label="Type" value={organization?.org_type || "—"} />
            <SummaryLine
              label="Attendance Mode"
              value={(organization?.attendance_mode || "—").toUpperCase()}
            />
            <SummaryLine label="Status" value={organization?.status || "—"} />
          </div>
          <div style={{ ...sectionTitle(), margin: "18px 0 10px" }}>
            Branches
          </div>
          <ReadOnlyBranches branches={branches} />
        </div>

        <div style={cardStyle({ padding: 18 })}>
          <div style={{ ...sectionTitle(), marginBottom: 12 }}>
            Enabled modules
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {modules.length === 0 ? (
              <span style={{ color: C.textMuted, fontSize: 13 }}>
                No active modules configured yet.
              </span>
            ) : (
              modules.map((moduleKey) => (
                <span
                  key={moduleKey}
                  style={{
                    border: `1px solid ${C.border}`,
                    borderRadius: 999,
                    padding: "6px 10px",
                    background: C.tealPale,
                    fontSize: 12,
                    fontWeight: 850,
                    color: C.primaryDark,
                  }}
                >
                  {formatModuleLabel(moduleKey, terminology)}
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      <div style={cardStyle({ padding: 18 })}>
        <div style={sectionTitle()}>Operational details</div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "130px 1fr",
            gap: 16,
            alignItems: "center",
            padding: "14px 0 18px",
            borderBottom: `1px solid ${C.border}`,
            marginBottom: 18,
          }}
        >
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 18,
              border: `1.5px dashed ${C.border}`,
              background: C.tealPale,
              display: "grid",
              placeItems: "center",
              overflow: "hidden",
            }}
          >
            {profile.logoDataUrl ? (
              <img
                src={profile.logoDataUrl}
                alt="Company logo preview"
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
              />
            ) : (
              <Building2 size={28} color={C.primary} />
            )}
          </div>

          <div>
            <label style={labelStyle()}>Company Logo</label>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const sizeError = checkFileSize(file, MAX_PHOTO_BYTES, "Logo");
                if (sizeError) {
                  alert(sizeError);
                  e.currentTarget.value = "";
                  return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                  setProfile((p) => ({
                    ...p,
                    logoDataUrl: String(reader.result || ""),
                    logoFileName: file.name,
                  }));
                };
                reader.readAsDataURL(file);
              }}
              style={inputStyle({ padding: "10px 12px", height: "auto" })}
            />
            <div style={{ marginTop: 6, fontSize: 11, color: C.textMuted }}>
              This logo will be saved with onboarding config and shown in the
              client dashboard.
              {profile.logoFileName ? ` Selected: ${profile.logoFileName}` : ""}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            marginTop: 14,
          }}
        >
          <Field label="Address">
            <input
              value={profile.address}
              onChange={(e) =>
                setProfile((p) => ({ ...p, address: e.target.value }))
              }
              style={inputStyle()}
              placeholder="Office / factory address"
            />
          </Field>
          <Field label="City">
            <input
              value={profile.city}
              onChange={(e) =>
                setProfile((p) => ({ ...p, city: e.target.value }))
              }
              style={inputStyle()}
              placeholder="e.g. Lahore"
            />
          </Field>
          <Field label="Public Contact Phone">
            <input
              value={profile.publicContactPhone}
              onChange={(e) =>
                setProfile((p) => ({
                  ...p,
                  publicContactPhone: e.target.value,
                }))
              }
              style={inputStyle()}
              placeholder="0300..."
            />
          </Field>
          <Field label="Timezone">
            <select
              value={profile.timezone}
              onChange={(e) =>
                setProfile((p) => ({ ...p, timezone: e.target.value }))
              }
              style={inputStyle()}
            >
              <option value="Asia/Karachi">Asia/Karachi</option>
              <option value="Asia/Dubai">Asia/Dubai</option>
              <option value="UTC">UTC</option>
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}

function departmentFamily(item: Department): PeopleFamily {
  if (item.personFamily) return item.personFamily;
  return item.itemKind === "class_section" || item.className || item.sectionName
    ? "student"
    : "workforce";
}

function roleFamily(item: RoleItem): PeopleFamily {
  return item.personFamily || "workforce";
}

function countDepartmentsByFamily(
  departments: Record<string, Department[]>,
  family: PeopleFamily,
): number {
  return Object.values(departments).reduce(
    (sum, list) =>
      sum + list.filter((item) => departmentFamily(item) === family).length,
    0,
  );
}

function countRolesByFamily(
  roles: Record<string, RoleItem[]>,
  family: PeopleFamily,
): number {
  return Object.values(roles).reduce(
    (sum, list) =>
      sum + list.filter((item) => roleFamily(item) === family).length,
    0,
  );
}

function removeDepartmentById(
  departments: Record<string, Department[]>,
  branchId: string,
  departmentId: string,
): Record<string, Department[]> {
  return {
    ...departments,
    [branchId]: (departments[branchId] || []).filter(
      (item) => item.id !== departmentId,
    ),
  };
}

function removeRoleById(
  roles: Record<string, RoleItem[]>,
  branchId: string,
  roleId: string,
): Record<string, RoleItem[]> {
  return {
    ...roles,
    [branchId]: (roles[branchId] || []).filter((item) => item.id !== roleId),
  };
}

function StudentStructureStep({
  branches,
  departments,
  setDepartments,
  plan,
  shiftEnabledPeopleTypes,
  setShiftEnabledPeopleTypes,
}: {
  branches: Branch[];
  departments: Record<string, Department[]>;
  setDepartments: React.Dispatch<
    React.SetStateAction<Record<string, Department[]>>
  >;
  plan: OnboardingPlan;
  shiftEnabledPeopleTypes: string[];
  setShiftEnabledPeopleTypes: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const [activeBranchId, setActiveBranchId] = useState(branches[0]?.id || "");
  const [newClassName, setNewClassName] = useState("");
  const [newSectionName, setNewSectionName] = useState("");
  const list = (departments[activeBranchId] || []).filter(
    (item) => departmentFamily(item) === "student",
  );
  const primaryStudentType = plan.studentPeopleTypes[0] || "student";
  const currentShiftTypes = shiftEnabledPeopleTypes || [];

  const toggleShiftType = (peopleType: string) => {
    const normalizedType = normalizePeopleType(peopleType);
    setShiftEnabledPeopleTypes((prev) => {
      const next = prev.includes(normalizedType)
        ? prev.filter((value) => value !== normalizedType)
        : [...prev, normalizedType];
      return next;
    });
  };

  const add = () => {
    const className = newClassName.trim();
    const sectionName = newSectionName.trim();
    if (!className || !activeBranchId) return;

    setDepartments((prev) => ({
      ...prev,
      [activeBranchId]: [
        ...(prev[activeBranchId] || []),
        {
          id: makeId("class_section"),
          name: sectionName ? `${className} - ${sectionName}` : className,
          className,
          sectionName: sectionName || undefined,
          personFamily: "student",
          peopleType: primaryStudentType,
          itemKind: "class_section",
        },
      ],
    }));
    setNewClassName("");
    setNewSectionName("");
  };

  const importCsv = (file: File | undefined) => {
    if (!file || !activeBranchId) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const rows = text
        .split(/\n/)
        .map((item) => item.trim())
        .filter(Boolean);

      if (!rows.length) return;

      setDepartments((prev) => {
        const existing = prev[activeBranchId] || [];
        const existingNames = new Set(
          existing.map((department) => department.name.trim().toLowerCase()),
        );
        const imported = rows
          .map((row) => {
            const [classRaw, sectionRaw] = row
              .split(",")
              .map((part) => part.trim());
            const className = classRaw || row;
            const sectionName = sectionRaw || "";
            const name = sectionName
              ? `${className} - ${sectionName}`
              : className;
            return { className, sectionName, name };
          })
          .filter(
            (item) => item.name && !existingNames.has(item.name.toLowerCase()),
          )
          .map(
            (item) =>
              ({
                id: makeId("class_section"),
                name: item.name,
                className: item.className,
                sectionName: item.sectionName || undefined,
                personFamily: "student",
                peopleType: primaryStudentType,
                itemKind: "class_section",
              }) satisfies Department,
          );

        return {
          ...prev,
          [activeBranchId]: [...existing, ...imported],
        };
      });
    };
    reader.readAsText(file);
  };

  return (
    <div>
      <h1 style={h1Style()}>
        Configure {plan.studentGroupPlural.toLowerCase()}
      </h1>
      <p style={subStyle()}>
        Add the academic structure used for attendance-enabled students. Staff,
        teachers, administration, workers, and other non-student people are
        configured separately when Support enables those people types.
      </p>
      <BranchTabs
        branches={branches}
        activeBranchId={activeBranchId}
        setActiveBranchId={setActiveBranchId}
      />

      <div style={cardStyle({ padding: 18 })}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr auto",
            gap: 10,
            marginBottom: 16,
          }}
        >
          <input
            value={newClassName}
            onChange={(e) => setNewClassName(e.target.value)}
            style={inputStyle({ flex: 1 })}
            placeholder={`Add ${plan.studentGroupLabel.toLowerCase()} name...`}
          />
          <input
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            style={inputStyle({ flex: 1 })}
            placeholder={`Add ${plan.studentSubgroupLabel.toLowerCase()}...`}
          />
          <button onClick={add} style={primarySmallButton()}>
            <Plus size={15} /> Add
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "10px 12px",
            borderRadius: 10,
            border: `1px dashed ${C.border}`,
            background: C.tealPale,
            marginBottom: 16,
          }}
        >
          <div>
            <div
              style={{ fontSize: 12, fontWeight: 900, color: C.primaryDark }}
            >
              Bulk upload {plan.studentGroupPlural.toLowerCase()}
            </div>
            <div style={{ fontSize: 11, color: C.textSub, marginTop: 2 }}>
              CSV format: {plan.studentGroupLabel}, {plan.studentSubgroupLabel}
            </div>
          </div>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.currentTarget.value = "";
              if (!file) return;
              const sizeError = checkFileSize(file, MAX_UPLOAD_BYTES, "CSV");
              if (sizeError) {
                alert(sizeError);
                return;
              }
              importCsv(file);
            }}
            style={{ fontSize: 12, maxWidth: 240 }}
          />
        </div>

        {plan.studentPeopleTypes.length > 0 && (
          <div style={{ ...cardStyle({ padding: 18, marginBottom: 16 }) }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={sectionTitle()}>Shift scheduling</div>
            </div>
            <p style={{ margin: "8px 0 14px", color: C.textSub, fontSize: 13 }}>
              Enable shift-based attendance for the student people types below.
            </p>
            <div style={{ display: "grid", gap: 10 }}>
              {plan.studentPeopleTypes.map((peopleType) => {
                const normalizedType = normalizePeopleType(peopleType);
                return (
                  <label
                    key={peopleType}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "12px 14px",
                      borderRadius: 12,
                      border: `1px solid ${C.border}`,
                      background: C.card,
                      cursor: "pointer",
                      fontSize: 14,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={currentShiftTypes.includes(normalizedType)}
                      onChange={() => toggleShiftType(peopleType)}
                    />
                    {titleCase(peopleType)}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <ChipList
          items={list.map((item) => ({ id: item.id, label: item.name }))}
          empty={`No ${plan.studentGroupPlural.toLowerCase()} yet for this branch.`}
          onRemove={(id) =>
            setDepartments((prev) =>
              removeDepartmentById(prev, activeBranchId, id),
            )
          }
        />
      </div>
    </div>
  );
}

function WorkforceStructureStep({
  branches,
  departments,
  setDepartments,
  roles,
  setRoles,
  plan,
  shiftEnabledPeopleTypes,
  setShiftEnabledPeopleTypes,
}: {
  branches: Branch[];
  departments: Record<string, Department[]>;
  setDepartments: React.Dispatch<
    React.SetStateAction<Record<string, Department[]>>
  >;
  roles: Record<string, RoleItem[]>;
  setRoles: React.Dispatch<React.SetStateAction<Record<string, RoleItem[]>>>;
  plan: OnboardingPlan;
  shiftEnabledPeopleTypes: string[];
  setShiftEnabledPeopleTypes: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const [activeBranchId, setActiveBranchId] = useState(branches[0]?.id || "");
  const [newDepartment, setNewDepartment] = useState("");
  const [newDesignation, setNewDesignation] = useState("");
  const departmentList = (departments[activeBranchId] || []).filter(
    (item) => departmentFamily(item) === "workforce",
  );
  const designationList = (roles[activeBranchId] || []).filter(
    (item) => roleFamily(item) === "workforce",
  );
  const primaryWorkforceType = plan.workforcePeopleTypes[0] || "staff";

  const addDepartment = () => {
    const name = newDepartment.trim();
    if (!name || !activeBranchId) return;
    setDepartments((prev) => ({
      ...prev,
      [activeBranchId]: [
        ...(prev[activeBranchId] || []),
        {
          id: makeId("workforce_group"),
          name,
          personFamily: "workforce",
          peopleType: primaryWorkforceType,
          itemKind: "group",
        },
      ],
    }));
    setNewDepartment("");
  };

  const currentShiftTypes = shiftEnabledPeopleTypes || [];

  const toggleShiftType = (peopleType: string) => {
    const normalizedType = normalizePeopleType(peopleType);
    setShiftEnabledPeopleTypes((prev) => {
      const next = prev.includes(normalizedType)
        ? prev.filter((value) => value !== normalizedType)
        : [...prev, normalizedType];
      return next;
    });
  };

  const addDesignation = () => {
    const name = newDesignation.trim();
    if (!name || !activeBranchId) return;
    setRoles((prev) => ({
      ...prev,
      [activeBranchId]: [
        ...(prev[activeBranchId] || []),
        {
          id: makeId("designation"),
          name,
          personFamily: "workforce",
          peopleType: primaryWorkforceType,
          level: "custom",
        },
      ],
    }));
    setNewDesignation("");
  };

  return (
    <div>
      <h1 style={h1Style()}>
        Configure {plan.workforceGroupPlural.toLowerCase()} and{" "}
        {plan.workforceRolePlural.toLowerCase()}
      </h1>
      <p style={subStyle()}>
        Add the operational structure used by attendance-enabled non-student
        people types such as teachers, staff, administration, workers,
        supervisors, doctors, nurses, or employees. Student classes and sections
        remain separate when students are also enabled.
      </p>
      <BranchTabs
        branches={branches}
        activeBranchId={activeBranchId}
        setActiveBranchId={setActiveBranchId}
      />

      {plan.workforcePeopleTypes.length > 0 && (
        <div style={{ ...cardStyle({ padding: 18, marginBottom: 16 }) }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={sectionTitle()}>Shift scheduling</div>
          </div>
          <p style={{ margin: "8px 0 14px", color: C.textSub, fontSize: 13 }}>
            Enable shift-based attendance for the workforce people types below.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            {plan.workforcePeopleTypes.map((peopleType) => {
              const normalizedType = normalizePeopleType(peopleType);
              return (
                <label
                  key={peopleType}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "12px 14px",
                    borderRadius: 12,
                    border: `1px solid ${C.border}`,
                    background: C.card,
                    cursor: "pointer",
                    fontSize: 14,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={shiftEnabledPeopleTypes.includes(normalizedType)}
                    onChange={() => {
                      const normalized = normalizePeopleType(peopleType);
                      setShiftEnabledPeopleTypes((prev) => {
                        const next = prev.includes(normalized)
                          ? prev.filter((value) => value !== normalized)
                          : [...prev, normalized];
                        return next;
                      });
                    }}
                  />
                  {titleCase(peopleType)}
                </label>
              );
            })}
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
        }}
      >
        <div style={cardStyle({ padding: 18 })}>
          <div style={sectionTitle()}>{plan.workforceGroupPlural}</div>
          <div style={{ display: "flex", gap: 10, margin: "12px 0 16px" }}>
            <input
              value={newDepartment}
              onChange={(e) => setNewDepartment(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDepartment()}
              style={inputStyle({ flex: 1 })}
              placeholder={`Add ${plan.workforceGroupLabel.toLowerCase()}...`}
            />
            <button onClick={addDepartment} style={primarySmallButton()}>
              <Plus size={15} /> Add
            </button>
          </div>

          <ChipList
            items={departmentList.map((department) => ({
              id: department.id,
              label: department.name,
            }))}
            empty={`No ${plan.workforceGroupPlural.toLowerCase()} yet for this branch.`}
            onRemove={(id) =>
              setDepartments((prev) =>
                removeDepartmentById(prev, activeBranchId, id),
              )
            }
          />
        </div>

        <div style={cardStyle({ padding: 18 })}>
          <div style={sectionTitle()}>{plan.workforceRolePlural}</div>
          <div style={{ display: "flex", gap: 10, margin: "12px 0 16px" }}>
            <input
              value={newDesignation}
              onChange={(e) => setNewDesignation(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addDesignation()}
              style={inputStyle({ flex: 1 })}
              placeholder={`Add ${plan.workforceRoleLabel.toLowerCase()}...`}
            />
            <button onClick={addDesignation} style={primarySmallButton()}>
              <Plus size={15} /> Add
            </button>
          </div>

          <ChipList
            items={designationList.map((role) => ({
              id: role.id,
              label: role.name,
            }))}
            empty={`No ${plan.workforceRolePlural.toLowerCase()} yet for this branch.`}
            onRemove={(id) =>
              setRoles((prev) => removeRoleById(prev, activeBranchId, id))
            }
          />
        </div>
      </div>
    </div>
  );
}

function CamerasStep({
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
  terminology: DynamicTerminology;
  organization: BootstrapResponse["organization"];
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
          id: makeId("cam"),
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
        [activeBranchId]: list.map((cam) => {
          if (cam.id !== cameraId) return cam;
          const next = { ...cam, ...patch };
          // Switching a camera to webcam: seed a sensible default device
          // index (0, 1, 2...) based on how many webcams already exist on
          // this branch. Stays editable afterward for the multi-webcam case.
          if (patch.type === "webcam" && cam.type !== "webcam") {
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
    <div>
      <h1 style={h1Style()}>
        Network and {terminology.cameraPlural.toLowerCase()} configuration
      </h1>
      <p style={subStyle()}>
        Add public IP, NVR/DVR IP, RTSP credentials, channels, and stream URLs
        for each support-created branch.
      </p>

      <div style={cardStyle({ padding: 18, marginBottom: 20 })}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            ...sectionTitle(),
          }}
        >
          <Network size={15} /> Network Settings
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 14,
            marginTop: 14,
          }}
        >
          <Field label="Public IP / Static IP">
            <input
              value={network.publicIp}
              onChange={(e) =>
                setNetwork((n) => ({ ...n, publicIp: e.target.value }))
              }
              style={inputStyle()}
              placeholder="e.g. 111.88.xx.xx"
            />
          </Field>
          <Field label="NVR / DVR Local IP">
            <input
              value={network.nvrDvrIp}
              onChange={(e) =>
                setNetwork((n) => ({ ...n, nvrDvrIp: e.target.value }))
              }
              style={inputStyle()}
              placeholder="e.g. 192.168.1.10"
            />
          </Field>
          <Field label="RTSP Port">
            <input
              value={network.rtspPort}
              onChange={(e) =>
                setNetwork((n) => ({ ...n, rtspPort: e.target.value }))
              }
              style={inputStyle()}
              placeholder="554"
            />
          </Field>
          <Field label="RTSP Username">
            <input
              value={network.rtspUsername}
              onChange={(e) =>
                setNetwork((n) => ({ ...n, rtspUsername: e.target.value }))
              }
              style={inputStyle()}
              placeholder="admin"
            />
          </Field>
          <Field label="RTSP Password">
            <input
              value={network.rtspPassword}
              onChange={(e) =>
                setNetwork((n) => ({ ...n, rtspPassword: e.target.value }))
              }
              type="password"
              style={inputStyle()}
              placeholder="••••••••"
            />
          </Field>
        </div>
      </div>

      <BranchTabs
        branches={branches}
        activeBranchId={activeBranchId}
        setActiveBranchId={setActiveBranchId}
      />

      <div style={cardStyle({ padding: 18 })}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <div style={sectionTitle()}>
            {terminology.branchLabel} {terminology.cameraPlural}
          </div>
          <button onClick={addCamera} style={primarySmallButton()}>
            <Plus size={15} /> Add {terminology.cameraLabel}
          </button>
        </div>

        {list.length === 0 && (
          <EmptyText
            text={`No ${terminology.cameraPlural.toLowerCase()} added for this branch yet.`}
          />
        )}

        <div style={{ display: "grid", gap: 10 }}>
          {list.map((cam) => (
            <div
              key={cam.id}
              style={{ ...cardStyle({ boxShadow: "none", padding: 12 }) }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 90px 115px auto",
                  gap: 8,
                  alignItems: "center",
                  marginBottom: 10,
                }}
              >
                <input
                  value={cam.name}
                  onChange={(e) =>
                    patchCamera(cam.id, { name: e.target.value })
                  }
                  style={inputStyle()}
                  placeholder={`${terminology.cameraLabel} name`}
                />
                <input
                  value={cam.location}
                  onChange={(e) =>
                    patchCamera(cam.id, { location: e.target.value })
                  }
                  style={inputStyle()}
                  placeholder="Location / zone"
                />
                <input
                  value={cam.channel}
                  onChange={(e) =>
                    patchCamera(cam.id, { channel: e.target.value })
                  }
                  style={inputStyle()}
                  placeholder={cam.type === "webcam" ? "Device index" : "Ch."}
                />
                <select
                  value={cam.type}
                  onChange={(e) =>
                    patchCamera(cam.id, {
                      type: e.target.value as CameraItem["type"],
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
                  onClick={() =>
                    setCameras((prev) => ({
                      ...prev,
                      [activeBranchId]: (prev[activeBranchId] || []).filter(
                        (c) => c.id !== cam.id,
                      ),
                    }))
                  }
                  style={iconButtonStyle()}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {cam.type !== "webcam" && (
                <input
                  value={cam.rtspUrl}
                  onChange={(e) =>
                    patchCamera(cam.id, { rtspUrl: e.target.value })
                  }
                  style={inputStyle({ fontFamily: "monospace", fontSize: 12 })}
                  placeholder="rtsp://username:password@public-ip-or-nvr-ip:554/channel"
                  spellCheck={false}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewStep({
  organization,
  branches,
  modules,
  config,
  terminology,
  plan,
}: {
  organization: BootstrapResponse["organization"];
  branches: Branch[];
  modules: string[];
  config: ConfigState;
  terminology: DynamicTerminology;
  plan: OnboardingPlan;
}) {
  const rows: [string, string][] = [
    [terminology.organizationLabel, organization?.name || "—"],
    [
      terminology.branchLabel + (branches.length === 1 ? "" : "es"),
      `${branches.length} read-only ${terminology.branchLabel.toLowerCase()}${branches.length === 1 ? "" : "es"} from Support Dashboard`,
    ],
    ...(plan.showStudentStructure
      ? ([
          [
            plan.studentGroupPlural,
            `${countDepartmentsByFamily(config.departments, "student")} ${plan.studentGroupPlural.toLowerCase()}`,
          ],
        ] as [string, string][])
      : []),
    ...(plan.showWorkforceStructure
      ? ([
          [
            plan.workforceGroupPlural,
            `${countDepartmentsByFamily(config.departments, "workforce")} ${plan.workforceGroupPlural.toLowerCase()}`,
          ],
          [
            plan.workforceRolePlural,
            `${countRolesByFamily(config.roles, "workforce")} ${plan.workforceRolePlural.toLowerCase()}`,
          ],
        ] as [string, string][])
      : []),
    [
      terminology.cameraPlural,
      `${totalCount(config.cameras)} ${terminology.cameraPlural.toLowerCase()}`,
    ],
    ["Public IP", config.network.publicIp || "—"],
    ["NVR/DVR IP", config.network.nvrDvrIp || "—"],
    [
      "Modules",
      modules.map((m) => formatModuleLabel(m, terminology)).join(", ") || "—",
    ],
  ];

  return (
    <div>
      <CheckCircle2 size={40} color={C.primary} style={{ marginBottom: 12 }} />
      <h1 style={h1Style()}>Review and launch dashboard</h1>
      <p style={subStyle()}>
        This will save client-owned operational configuration in Supabase and
        unlock the dashboard. All internal pages will read these values from the
        client bootstrap source of truth.
      </p>
      <div style={cardStyle({ overflow: "hidden" })}>
        {rows.map(([label, value], index) => (
          <div
            key={label}
            style={{
              display: "grid",
              gridTemplateColumns: "170px 1fr",
              gap: 16,
              padding: "13px 18px",
              borderBottom:
                index < rows.length - 1 ? `1px solid ${C.border}` : "none",
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 900,
                color: C.textSub,
                textTransform: "uppercase",
                letterSpacing: ".05em",
              }}
            >
              {label}
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={labelStyle()}>{label}</label>
      {children}
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <span style={{ fontSize: 12, color: C.textSub, fontWeight: 700 }}>
        {label}
      </span>
      <span
        style={{
          fontSize: 12,
          color: C.text,
          fontWeight: 900,
          textAlign: "right",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function ChipList({
  items,
  empty,
  onRemove,
}: {
  items: { id: string; label: string }[];
  empty: string;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return <EmptyText text={empty} />;
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
          {item.label}
          <button
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

function h1Style(): React.CSSProperties {
  return {
    margin: "0 0 8px",
    fontSize: 28,
    color: C.primary,
    fontWeight: 950,
    letterSpacing: "-0.03em",
  };
}

function subStyle(): React.CSSProperties {
  return {
    margin: "0 0 24px",
    fontSize: 14,
    color: C.textSub,
    lineHeight: 1.65,
  };
}

function sectionTitle(): React.CSSProperties {
  return {
    fontSize: 12,
    color: C.primaryDark,
    fontWeight: 950,
    textTransform: "uppercase",
    letterSpacing: ".08em",
  };
}

function primarySmallButton(): React.CSSProperties {
  return {
    minHeight: 42,
    border: "none",
    borderRadius: 10,
    padding: "0 14px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    background: C.primary,
    color: "#fff",
    fontSize: 13,
    fontWeight: 900,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };
}

function secondaryButton(): React.CSSProperties {
  return {
    height: 48,
    border: `1.5px solid ${C.border}`,
    borderRadius: 12,
    background: C.card,
    color: C.textSub,
    padding: "0 22px",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    fontWeight: 900,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function primaryButton(): React.CSSProperties {
  return {
    height: 48,
    border: "none",
    borderRadius: 12,
    background: C.primary,
    color: "#fff",
    padding: "0 24px",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    fontWeight: 950,
    cursor: "pointer",
    fontFamily: "inherit",
    boxShadow: "0 8px 24px rgba(26,105,159,.28)",
  };
}

function rowStyle(): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: "1fr auto auto",
    gap: 10,
    alignItems: "center",
    padding: "10px 12px",
    borderRadius: 10,
    border: `1px solid ${C.border}`,
    background: C.tealPale,
    color: C.text,
    fontSize: 13,
  };
}

function iconButtonStyle(): React.CSSProperties {
  return {
    width: 36,
    height: 36,
    border: `1px solid ${C.border}`,
    borderRadius: 9,
    background: C.card,
    color: C.danger,
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
  };
}

export default function OnboardingWizard() {
  const navigate = useNavigate();
  const auth = useAuth() as unknown as OnboardingAuthContext;
  const { user, refreshUser } = auth;
  const organizationId = user?.organization_id || user?.organizationId;

  const [stepIndex, setStepIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [organization, setOrganization] =
    useState<BootstrapResponse["organization"]>();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [config, setConfig] = useState<ConfigState>(() => emptyConfig([]));

  useEffect(() => {
    let alive = true;

    async function load() {
      if (!organizationId) {
        setError(
          "Organization is missing from the logged-in user. Please log in again from the client invite.",
        );
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);
        const data =
          await loadClientBootstrap<BootstrapResponse>(organizationId);

        if (!alive) return;
        const loadedBranches = data.branches || [];
        const activeModules = data.active_modules || data.activeModules || [];
        setBootstrap(data);
        setOrganization(data.organization);
        setBranches(loadedBranches);
        setModules(activeModules);
        setConfig(configFromBootstrap(data, loadedBranches));
      } catch (e) {
        if (!alive) return;
        setError(
          e instanceof Error ? e.message : "Failed to load onboarding setup.",
        );
      } finally {
        if (alive) setIsLoading(false);
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [organizationId]);

  const terminology = useMemo(() => buildTerminology(bootstrap), [bootstrap]);
  const onboardingPlan = useMemo(
    () => resolveOnboardingPlan(bootstrap, terminology),
    [bootstrap, terminology],
  );
  const steps = useMemo(
    () => buildSteps(terminology, onboardingPlan),
    [onboardingPlan, terminology],
  );
  const currentStep = steps[stepIndex] ?? steps[0];
  const canBack = stepIndex > 0;
  const canNext = useMemo(() => {
    if (currentStep.key === "profile") {
      return Boolean(
        config.company_profile.city.trim() ||
        config.company_profile.address.trim(),
      );
    }

    if (currentStep.key === "student_structure") {
      return countDepartmentsByFamily(config.departments, "student") > 0;
    }

    if (currentStep.key === "workforce_structure") {
      return (
        countDepartmentsByFamily(config.departments, "workforce") > 0 &&
        countRolesByFamily(config.roles, "workforce") > 0
      );
    }

    if (currentStep.key === "cameras") {
      return Boolean(
        config.network.nvrDvrIp.trim() || totalCount(config.cameras) > 0,
      );
    }

    return true;
  }, [config, currentStep.key]);

  const saveAndLaunch = async () => {
    if (!user?.id || !organizationId) {
      setError("User or organization is missing. Please log in again.");
      return;
    }

    try {
      setIsSaving(true);
      setError(null);
      await completeClientOnboarding({
        user_id: user.id,
        organization_id: organizationId,
        config,
      });

      // Supabase is the source of truth. Do not store dashboard config or
      // readiness flags manually in localStorage. Refresh the auth session from
      // Flask → Supabase, then let /admin hydrate config from /api/client/bootstrap.
      if (refreshUser && user.id) {
        await refreshUser(user.id);
      }

      navigate("/admin", { replace: true });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to complete onboarding.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const content = () => {
    if (!organization) return null;
    if (currentStep.key === "profile") {
      return (
        <CompanyProfileStep
          organization={organization}
          branches={branches}
          modules={modules}
          profile={config.company_profile}
          terminology={terminology}
          setProfile={(updater) =>
            setConfig((prev) => ({
              ...prev,
              company_profile:
                typeof updater === "function"
                  ? updater(prev.company_profile)
                  : updater,
            }))
          }
        />
      );
    }
    if (currentStep.key === "student_structure") {
      return (
        <StudentStructureStep
          branches={branches}
          departments={config.departments}
          plan={onboardingPlan}
          shiftEnabledPeopleTypes={config.shiftEnabledPeopleTypes ?? []}
          setShiftEnabledPeopleTypes={(updater) =>
            setConfig((prev) => ({
              ...prev,
              shiftEnabledPeopleTypes:
                typeof updater === "function"
                  ? updater(prev.shiftEnabledPeopleTypes ?? [])
                  : updater,
            }))
          }
          setDepartments={(updater) =>
            setConfig((prev) => ({
              ...prev,
              departments:
                typeof updater === "function"
                  ? updater(prev.departments)
                  : updater,
            }))
          }
        />
      );
    }
    if (currentStep.key === "workforce_structure") {
      return (
        <WorkforceStructureStep
          branches={branches}
          departments={config.departments}
          setDepartments={(updater) =>
            setConfig((prev) => ({
              ...prev,
              departments:
                typeof updater === "function"
                  ? updater(prev.departments)
                  : updater,
            }))
          }
          roles={config.roles}
          plan={onboardingPlan}
          shiftEnabledPeopleTypes={config.shiftEnabledPeopleTypes ?? []}
          setShiftEnabledPeopleTypes={(updater) =>
            setConfig((prev) => ({
              ...prev,
              shiftEnabledPeopleTypes:
                typeof updater === "function"
                  ? updater(prev.shiftEnabledPeopleTypes ?? [])
                  : updater,
            }))
          }
          setRoles={(updater) =>
            setConfig((prev) => ({
              ...prev,
              roles:
                typeof updater === "function" ? updater(prev.roles) : updater,
            }))
          }
        />
      );
    }
    if (currentStep.key === "cameras") {
      return (
        <CamerasStep
          branches={branches}
          cameras={config.cameras}
          setCameras={(updater) =>
            setConfig((prev) => ({
              ...prev,
              cameras:
                typeof updater === "function" ? updater(prev.cameras) : updater,
            }))
          }
          network={config.network}
          terminology={terminology}
          organization={organization}
          setNetwork={(updater) =>
            setConfig((prev) => ({
              ...prev,
              network:
                typeof updater === "function" ? updater(prev.network) : updater,
            }))
          }
        />
      );
    }
    return (
      <ReviewStep
        organization={organization}
        branches={branches}
        modules={modules}
        config={config}
        terminology={terminology}
        plan={onboardingPlan}
      />
    );
  };

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: C.bg,
          color: C.primaryDark,
          fontFamily: "'DM Sans','Inter',sans-serif",
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
          Loading onboarding…
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      </div>
    );
  }

  if (error && !organization) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: C.bg,
          fontFamily: "'DM Sans','Inter',sans-serif",
        }}
      >
        <div
          style={cardStyle({ maxWidth: 520, padding: 24, textAlign: "center" })}
        >
          <AlertCircle color={C.danger} size={34} />
          <h2 style={{ color: C.text, margin: "12px 0 6px" }}>
            Onboarding cannot start
          </h2>
          <p style={{ color: C.textSub, fontSize: 13 }}>{error}</p>
          <button
            onClick={() => navigate("/login", { replace: true })}
            style={{ ...primaryButton(), marginTop: 12 }}
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        background: C.bg,
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      <Sidebar
        stepIndex={stepIndex}
        organizationName={organization?.name || ""}
        branches={branches}
        modules={modules}
        steps={steps}
        terminology={terminology}
      />
      <main style={{ flex: 1, padding: "62px 56px 38px", overflow: "auto" }}>
        <Stepper stepIndex={stepIndex} steps={steps} />
        <div style={{ maxWidth: 1080 }}>{content()}</div>

        {error && (
          <div
            style={{
              ...cardStyle({
                borderColor: "#fecaca",
                background: "#fef2f2",
                padding: "12px 14px",
                marginTop: 20,
              }),
              color: C.danger,
              fontSize: 13,
              fontWeight: 800,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 30 }}>
          {canBack && (
            <button
              onClick={() => setStepIndex((s) => Math.max(0, s - 1))}
              style={secondaryButton()}
              disabled={isSaving}
            >
              <ChevronLeft size={17} /> Back
            </button>
          )}

          {stepIndex < steps.length - 1 ? (
            <button
              onClick={() =>
                setStepIndex((s) => Math.min(steps.length - 1, s + 1))
              }
              style={{ ...primaryButton(), opacity: canNext ? 1 : 0.45 }}
              disabled={!canNext || isSaving}
            >
              Continue <ChevronRight size={17} />
            </button>
          ) : (
            <button
              onClick={saveAndLaunch}
              style={{ ...primaryButton(), minWidth: 210 }}
              disabled={isSaving}
            >
              {isSaving ? (
                <Loader2
                  size={17}
                  style={{ animation: "spin .8s linear infinite" }}
                />
              ) : (
                <Save size={17} />
              )}
              {isSaving ? "Saving…" : "Launch Dashboard"}
            </button>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              color: C.textMuted,
              fontSize: 12,
              marginLeft: "auto",
            }}
          >
            <Eye size={14} /> Branches, modules, and limits are read-only from
            Support Dashboard.
          </div>
        </div>
      </main>
    </div>
  );
}
