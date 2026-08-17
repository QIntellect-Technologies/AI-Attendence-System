/**
 * src/app/support-dashboard/modules/organizations/components/CreateOrganizationModal.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Clean Support-owned organization creation flow.
 *
 * Creates only what the Support Dashboard owns:
 * - organization profile + vertical template
 * - purchased modules
 * - pre-created branch capacity limits
 * - optional first invoice
 *
 * No fake delays. No hardcoded company-only terminology. UUID safe.
 */

import React, { useMemo, useReducer, useState } from "react";
import { AlertCircle, Building2, Plus, Trash2, X } from "lucide-react";
import {
  branchesApi,
  invoicesApi,
  modulesApi,
  MODULE_DEFINITIONS,
  organizationsApi,
  extractApiError,
  type ClientModuleKey,
} from "../api/organizationsApi";
import { useVerticalTemplates } from "../hooks/useOrganizations";
import type {
  AttendanceMode,
  BillingCycle,
  BusinessType,
  Organization,
  PeopleKind,
  PeopleType,
  StaffWorkType,
  SupportVerticalTemplateOption,
  VerticalConfig,
} from "../../../packages/shared-types/src/organization";
import BusinessTemplateSelect from "./BusinessTemplateSelect";
import AttendanceScopeSelector from "./AttendanceScopeSelector";
import TimezoneSelect from "./TimezoneSelect";

type BranchDraft = {
  /**
   * Stable local identifier for this draft branch, independent of its index.
   * moduleScopeOverrides is keyed by this so removing/reordering branches
   * never silently reattaches one branch's overrides to a different branch.
   */
  key: string;
  name: string;
  location: string;
  max_staff_capacity: number;
  timezone: string;
};

function makeBranchKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `branch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface CreateOrganizationModalProps {
  onClose: () => void;
  onCreated: (org: Organization) => void;
}

type FormState = {
  name: string;
  contact_email: string;
  contact_phone: string;
  org_type: string;
  business_type: BusinessType;
  attendance_people_types: PeopleType[];
  enabled_staff_types: StaffWorkType[];
  people_kind: PeopleKind;
  attendance_mode: AttendanceMode;
  node_offline_threshold_seconds: number;
  max_branches: number;
  selected_modules: ClientModuleKey[];
  branches: BranchDraft[];
  /**
   * Explicit per-branch, per-module people-type customization made during
   * creation. Keyed by BranchDraft.key -> moduleKey -> selected people types.
   * A branch/module pair with NO entry here means "leave it at the backend
   * default" (all selected_modules x the template's enabled people types),
   * which is what create_branch's own auto-seed already applies — this map
   * only needs to carry deviations from that default, not the default itself.
   */
  moduleScopeOverrides: Record<string, Record<string, string[]>>;
  billing_cycle: BillingCycle;
  invoice_amount: number;
  invoice_due_date: string;
  grace_period_days: number;
  invoice_notes: string;
};

type FormAction =
  | { type: "PATCH"; patch: Partial<FormState> }
  | {
      type: "SET_TEMPLATE";
      businessType: BusinessType;
      peopleKind: PeopleKind;
      orgType: string;
      attendancePeopleTypes: PeopleType[];
    }
  | { type: "TOGGLE_ATTENDANCE_PEOPLE_TYPE"; peopleType: PeopleType }
  | { type: "TOGGLE_MODULE"; module: ClientModuleKey }
  | { type: "UPDATE_BRANCH"; index: number; patch: Partial<BranchDraft> }
  | { type: "ADD_BRANCH" }
  | { type: "REMOVE_BRANCH"; index: number }
  | { type: "SET_MAX_BRANCHES"; maxBranches: number }
  | {
      type: "TOGGLE_BRANCH_MODULE_PEOPLE_TYPE";
      branchKey: string;
      moduleKey: string;
      peopleType: PeopleType;
      /** Full available set, used as the implicit starting point the first time this branch/module pair is touched. */
      availablePeopleTypes: PeopleType[];
    };

const T = {
  teal600: "#0d9488",
  teal700: "#0f766e",
  teal50: "#f0fdfa",
  navy700: "#134471",
  slate50: "#f8fafc",
  slate100: "#f1f5f9",
  border: "#e2e8f0",
  red600: "#e11d48",
  red50: "#fff1f2",
  amber600: "#d97706",
  amber50: "#fffbeb",
  white: "#ffffff",
  textHeading: "#1a699f",
  textBody: "#334155",
  textMuted: "#64748b",
  textLight: "#94a3b8",
  shadow: "0 20px 60px rgba(15,45,74,0.25)",
} as const;

const PEOPLE_KIND_LABELS: Record<PeopleKind, string> = {
  students: "Students",
  staff: "Staff",
  workers: "Workers",
  employees: "Employees",
  personnel: "Personnel",
  members: "Members",
  volunteers: "Volunteers",
  patients: "Patients",
  both: "Students & Staff",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 10,
  fontWeight: 900,
  color: T.textBody,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 12,
  color: T.textBody,
  outline: "none",
  fontFamily: "inherit",
  background: T.white,
};

const sectionTitleStyle: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13,
  fontWeight: 900,
  color: T.navy700,
};

const Field: React.FC<{
  label: string;
  children: React.ReactNode;
  helper?: string;
}> = ({ label, children, helper }) => (
  <label style={{ display: "block" }}>
    <span style={labelStyle}>{label}</span>
    {children}
    {helper && (
      <span
        style={{
          display: "block",
          marginTop: 5,
          color: T.textLight,
          fontSize: 10,
          lineHeight: 1.4,
        }}
      >
        {helper}
      </span>
    )}
  </label>
);

function toPositiveInt(value: string | number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function periodEndForCycle(cycle: BillingCycle): string {
  const today = new Date();
  if (cycle === "quarterly") return formatDate(addMonths(today, 3));
  if (cycle === "annually") return formatDate(addMonths(today, 12));
  return formatDate(addMonths(today, 1));
}

function peopleKindForPeopleType(peopleType: PeopleType): PeopleKind {
  if (peopleType === "student") return "students";
  if (peopleType === "worker") return "workers";
  if (peopleType === "staff") return "staff";
  if (peopleType === "employee") return "employees";
  return "employees";
}

function orgTypeForBusinessType(businessType: BusinessType): string {
  if (businessType === "school") return "school";
  if (businessType === "factory") return "factory";
  if (businessType === "company") return "company";
  return String(businessType || "company");
}

function uniquePeopleTypes(values: unknown[]): PeopleType[] {
  const seen = new Set<string>();
  const out: PeopleType[] = [];

  for (const value of values) {
    const key = String(value ?? "")
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }

  return out;
}

function fallbackPeopleTypesForBusinessType(
  businessType?: BusinessType,
): PeopleType[] {
  switch (
    String(businessType || "")
      .trim()
      .toLowerCase()
  ) {
    case "school":
      return ["student", "staff"];
    case "factory":
      return ["worker", "staff"];
    case "company":
    default:
      return ["staff"];
  }
}

function templateEnabledPeopleTypes(
  template?: SupportVerticalTemplateOption,
): PeopleType[] {
  const fromBackend = uniquePeopleTypes([
    ...(template?.vertical_config?.enabled_people_types || []),
    ...(template?.enabled_people_types || []),
    template?.primary_people_type,
  ]);

  // Backward-compatible fallback for the current backend endpoint when it only
  // returns business_type, label, and primary_people_type.
  const fallback = fallbackPeopleTypesForBusinessType(template?.business_type);
  return uniquePeopleTypes([...fromBackend, ...fallback]);
}

function templateDefaultAttendancePeopleTypes(
  template?: SupportVerticalTemplateOption,
): PeopleType[] {
  const enabled = templateEnabledPeopleTypes(template);
  const requested = uniquePeopleTypes([
    ...(template?.vertical_config?.attendance_people_types || []),
    ...(template?.attendance_people_types || []),
  ]);

  const allowed = requested.filter((type) => enabled.includes(type));
  return allowed.length ? allowed : enabled;
}

function peopleTypeLabel(
  labels: Record<string, string> | undefined,
  peopleType: PeopleType,
): string {
  return (
    labels?.[peopleType] ||
    peopleType.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
  );
}

function defaultFormState(): FormState {
  return {
    name: "",
    contact_email: "",
    contact_phone: "",
    org_type: "company",
    business_type: "company",
    attendance_people_types: ["staff"],
    enabled_staff_types: ["office", "field"],
    people_kind: "staff",
    attendance_mode: "cloud",
    node_offline_threshold_seconds: 10,
    max_branches: 1,
    selected_modules: ["employees", "attendance"],
    branches: [
      {
        key: makeBranchKey(),
        name: "Main Branch",
        location: "",
        max_staff_capacity: 50,
        timezone: "UTC",
      },
    ],
    moduleScopeOverrides: {},
    billing_cycle: "monthly",
    invoice_amount: 0,
    invoice_due_date: formatDate(new Date()),
    grace_period_days: 7,
    invoice_notes: "",
  };
}

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "PATCH":
      return { ...state, ...action.patch };
    case "SET_TEMPLATE":
      return {
        ...state,
        business_type: action.businessType,
        org_type: action.orgType,
        people_kind: action.peopleKind,
        attendance_people_types: action.attendancePeopleTypes,
      };
    case "TOGGLE_ATTENDANCE_PEOPLE_TYPE": {
      const exists = state.attendance_people_types.includes(action.peopleType);
      const next = exists
        ? state.attendance_people_types.filter(
            (type) => type !== action.peopleType,
          )
        : [...state.attendance_people_types, action.peopleType];
      return { ...state, attendance_people_types: next };
    }
    case "TOGGLE_MODULE":
      return {
        ...state,
        selected_modules: state.selected_modules.includes(action.module)
          ? state.selected_modules.filter((module) => module !== action.module)
          : [...state.selected_modules, action.module],
      };
    case "UPDATE_BRANCH":
      return {
        ...state,
        branches: state.branches.map((branch, index) =>
          index === action.index ? { ...branch, ...action.patch } : branch,
        ),
      };
    case "ADD_BRANCH":
      if (state.branches.length >= state.max_branches) return state;
      return {
        ...state,
        branches: [
          ...state.branches,
          {
            key: makeBranchKey(),
            name: `Branch ${state.branches.length + 1}`,
            location: "",
            max_staff_capacity: 50,
            timezone: "UTC",
          },
        ],
      };
    case "REMOVE_BRANCH": {
      const removedKey = state.branches[action.index]?.key;
      const branches = state.branches.filter(
        (_, index) => index !== action.index,
      );
      if (branches.length === 0) return state;
      const moduleScopeOverrides = { ...state.moduleScopeOverrides };
      if (removedKey) delete moduleScopeOverrides[removedKey];
      return { ...state, branches, moduleScopeOverrides };
    }
    case "TOGGLE_BRANCH_MODULE_PEOPLE_TYPE": {
      const { branchKey, moduleKey, peopleType, availablePeopleTypes } = action;
      const currentBranchOverrides =
        state.moduleScopeOverrides[branchKey] ?? {};
      const current = currentBranchOverrides[moduleKey] ?? availablePeopleTypes;
      const next = current.includes(peopleType)
        ? current.filter((type) => type !== peopleType)
        : [...current, peopleType];
      return {
        ...state,
        moduleScopeOverrides: {
          ...state.moduleScopeOverrides,
          [branchKey]: { ...currentBranchOverrides, [moduleKey]: next },
        },
      };
    }
    case "SET_MAX_BRANCHES": {
      // Never silently discard a branch the user has already named. Lowering
      // the limit only trims unnamed placeholder rows from the end; named
      // branches are kept and validateForm() surfaces the mismatch instead.
      const named = state.branches.filter((branch) => branch.name.trim());
      const keep = Math.max(action.maxBranches, named.length, 1);
      return {
        ...state,
        max_branches: action.maxBranches,
        branches: state.branches.slice(0, keep),
      };
    }
    default:
      return state;
  }
}

function validateForm(state: FormState): string | null {
  if (!state.name.trim()) return "Organization name is required.";
  if (!state.contact_email.trim()) return "Contact email is required.";
  if (!state.contact_email.includes("@")) return "Enter a valid contact email.";
  if (!state.business_type.trim()) return "Business template is required.";
  if (!state.attendance_people_types.length) {
    return "Select who will use biometric attendance for this organization.";
  }
  if (state.attendance_mode === "local") {
    if (
      state.node_offline_threshold_seconds < 5 ||
      state.node_offline_threshold_seconds > 300
    ) {
      return "Node offline threshold must be between 5 and 300 seconds.";
    }
  }
  if (state.max_branches < 1) return "Max branches must be at least 1.";
  if (!state.selected_modules.length)
    return "Select at least one purchased module.";

  const validBranches = state.branches.filter((branch) => branch.name.trim());
  if (!validBranches.length) return "Add at least one branch.";
  if (validBranches.length > state.max_branches)
    return "Branch count cannot exceed max branches.";
  if (validBranches.some((branch) => branch.max_staff_capacity < 1)) {
    return "Every branch capacity must be at least 1.";
  }
  if (state.invoice_amount < 0) return "Invoice amount cannot be negative.";
  if (state.invoice_amount > 0 && !state.invoice_due_date)
    return "Invoice due date is required.";
  return null;
}

function formatStructure(verticalConfig?: VerticalConfig): string {
  const structures = verticalConfig?.structures || {};
  return Object.entries(structures)
    .map(([peopleType, rawStructure]) => {
      const structure = rawStructure as { unit_1?: string; unit_2?: string };
      const values = [structure.unit_1, structure.unit_2]
        .filter(Boolean)
        .join(" → ");
      return `${peopleType}: ${values || "custom"}`;
    })
    .join(" • ");
}

export const CreateOrganizationModal: React.FC<
  CreateOrganizationModalProps
> = ({ onClose, onCreated }) => {
  const [form, dispatch] = useReducer(formReducer, undefined, defaultFormState);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { templates, isLoading: templatesLoading } = useVerticalTemplates();

  const selectedTemplate = useMemo(
    () =>
      templates.find(
        (template) => template.business_type === form.business_type,
      ),
    [templates, form.business_type],
  );

  const templatePeopleTypes = useMemo(
    () => templateEnabledPeopleTypes(selectedTemplate),
    [selectedTemplate],
  );
  const templateLabels =
    selectedTemplate?.vertical_config?.labels || selectedTemplate?.labels || {};

  const primaryPeopleKind = useMemo(
    () =>
      peopleKindForPeopleType(selectedTemplate?.primary_people_type || "staff"),
    [selectedTemplate],
  );

  const peopleLabel = PEOPLE_KIND_LABELS[form.people_kind] || "People";
  const canAddBranch = form.branches.length < form.max_branches;

  const handleTemplateChange = (businessType: string) => {
    const nextTemplate = templates.find(
      (template) => template.business_type === businessType,
    );
    dispatch({
      type: "SET_TEMPLATE",
      businessType,
      peopleKind: peopleKindForPeopleType(
        nextTemplate?.primary_people_type || "staff",
      ),
      orgType: orgTypeForBusinessType(businessType),
      attendancePeopleTypes: templateDefaultAttendancePeopleTypes(nextTemplate),
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const validationError = validateForm(form);
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const org = await organizationsApi.create({
        name: form.name.trim(),
        contact_email: form.contact_email.trim().toLowerCase(),
        contact_phone: form.contact_phone.trim() || undefined,
        org_type: form.org_type.trim() || form.business_type,
        business_type: form.business_type,
        attendance_people_types: form.attendance_people_types,
        enabled_staff_types: form.enabled_staff_types,
        people_kind: primaryPeopleKind,
        attendance_mode: form.attendance_mode,
        node_offline_threshold_seconds:
          form.attendance_mode === "local"
            ? form.node_offline_threshold_seconds
            : undefined,
        max_branches: form.max_branches,
      });

      await modulesApi.setAll(org.id, form.selected_modules);

      const validBranches = form.branches.filter((branch) =>
        branch.name.trim(),
      );
      const createdBranches = await Promise.all(
        validBranches.map(async (branch) => ({
          draftKey: branch.key,
          branch: await branchesApi.create(org.id, {
            name: branch.name.trim(),
            location: branch.location.trim() || undefined,
            max_staff_capacity: branch.max_staff_capacity,
            timezone: branch.timezone, // ← new
          }),
        })),
      );

      // Only touch branches the admin actually customized above — untouched
      // branches keep whatever default create_branch's own auto-seed applied
      // (all selected_modules x templatePeopleTypes), so no redundant call.
      // set_branch_module_people_types REPLACES a branch's entire config, so
      // when we do call it, every selected module needs an entry — not just
      // the ones the admin touched — or the untouched modules would be wiped.
      await Promise.all(
        createdBranches
          .filter(({ draftKey }) => form.moduleScopeOverrides[draftKey])
          .map(({ draftKey, branch: createdBranch }) => {
            const overridesForBranch = form.moduleScopeOverrides[draftKey]!;
            const fullConfig: Record<string, string[]> = {};
            for (const moduleKey of form.selected_modules) {
              fullConfig[moduleKey] =
                overridesForBranch[moduleKey] ?? templatePeopleTypes;
            }
            return branchesApi.setModulePeopleTypes(
              org.id,
              createdBranch.id,
              fullConfig,
            );
          }),
      );

      if (form.invoice_amount > 0) {
        await invoicesApi.create(org.id, {
          amount: form.invoice_amount,
          due_date: form.invoice_due_date,
          grace_period_days: form.grace_period_days,
          notes:
            form.invoice_notes.trim() ||
            `Initial ${form.billing_cycle} invoice. Branch capacity and modules are controlled by QIntellect Support.`,
        });
      }

      onCreated(org);
    } catch (err) {
      setError(extractApiError(err, "Failed to create organization."));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,37,64,0.42)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: "min(980px, 96vw)",
          maxHeight: "92vh",
          overflowY: "auto",
          background: T.white,
          borderRadius: 18,
          boxShadow: T.shadow,
          fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 2,
            background: T.white,
            padding: "18px 22px",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: 14,
                background: T.teal50,
                color: T.teal700,
                display: "grid",
                placeItems: "center",
              }}
            >
              <Building2 size={20} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, color: T.textHeading }}>
                Create Organization
              </h2>
              <p
                style={{ margin: "3px 0 0", fontSize: 12, color: T.textMuted }}
              >
                Support-owned commercial profile, template, modules, branches,
                and first invoice.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            aria-label="Close"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: T.white,
              color: T.textMuted,
              cursor: isSaving ? "not-allowed" : "pointer",
            }}
          >
            <X size={17} />
          </button>
        </div>

        <div style={{ padding: 22, display: "grid", gap: 16 }}>
          {error && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: T.red50,
                color: T.red600,
                border: "1px solid #fecdd3",
                borderRadius: 10,
                padding: "10px 12px",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              <AlertCircle size={14} />
              {error}
            </div>
          )}

          <section
            style={{
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              padding: 16,
              background: T.slate50,
            }}
          >
            <h3 style={sectionTitleStyle}>1. Organization Identity</h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: 12,
              }}
            >
              <Field label="Organization Name">
                <input
                  value={form.name}
                  onChange={(e) =>
                    dispatch({ type: "PATCH", patch: { name: e.target.value } })
                  }
                  placeholder="Software House / School / Factory"
                  style={inputStyle}
                />
              </Field>

              <Field label="Contact Email">
                <input
                  value={form.contact_email}
                  onChange={(e) =>
                    dispatch({
                      type: "PATCH",
                      patch: { contact_email: e.target.value },
                    })
                  }
                  placeholder="admin@example.com"
                  type="email"
                  style={inputStyle}
                />
              </Field>

              <Field label="Contact Phone">
                <input
                  value={form.contact_phone}
                  onChange={(e) =>
                    dispatch({
                      type: "PATCH",
                      patch: { contact_phone: e.target.value },
                    })
                  }
                  placeholder="03001234567"
                  style={inputStyle}
                />
              </Field>

              <Field
                label="Organization Type"
                helper="Stored for compatibility; template is the main source of rendering truth."
              >
                <input
                  value={form.org_type}
                  onChange={(e) =>
                    dispatch({
                      type: "PATCH",
                      patch: { org_type: e.target.value },
                    })
                  }
                  placeholder="company, school, factory"
                  style={inputStyle}
                />
              </Field>

              <BusinessTemplateSelect
                value={form.business_type}
                templates={templates}
                disabled={isSaving || templatesLoading}
                onChange={handleTemplateChange}
                required
                helper={
                  selectedTemplate
                    ? `Primary people type: ${peopleTypeLabel(templateLabels, selectedTemplate.primary_people_type)}`
                    : undefined
                }
              />

              <div style={{ gridColumn: "1 / -1" }}>
                <Field
                  label="Attendance Enabled For"
                  helper="Choose who will use biometric attendance: Students only, Staff only, or both. This remains Support-owned and can be changed later from Organization Detail."
                >
                  <AttendanceScopeSelector
                    availablePeopleTypes={templatePeopleTypes}
                    value={form.attendance_people_types}
                    onChange={(attendancePeopleTypes) =>
                      dispatch({
                        type: "PATCH",
                        patch: {
                          attendance_people_types: attendancePeopleTypes,
                        },
                      })
                    }
                    labels={templateLabels}
                    disabled={isSaving}
                    required
                  />
                </Field>
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <Field
                  label="Staff Type Scope"
                  helper="Which staff work types this client is entitled to add in the Staff Directory: Office only, Field only, or both. Commercial/Support-owned — can be changed later from Organization Detail."
                >
                  <AttendanceScopeSelector
                    availablePeopleTypes={["office", "field"]}
                    value={form.enabled_staff_types}
                    onChange={(enabledStaffTypes) =>
                      dispatch({
                        type: "PATCH",
                        patch: {
                          enabled_staff_types:
                            enabledStaffTypes as StaffWorkType[],
                        },
                      })
                    }
                    labels={{ office: "Office Staff", field: "Field Staff" }}
                    disabled={isSaving}
                    required
                  />
                </Field>
              </div>

              <Field
                label="Attendance Mode"
                helper="Support-owned. Client cannot change it."
              >
                <select
                  value={form.attendance_mode}
                  onChange={(e) =>
                    dispatch({
                      type: "PATCH",
                      patch: {
                        attendance_mode: e.target.value as AttendanceMode,
                      },
                    })
                  }
                  style={inputStyle}
                >
                  <option value="cloud">Cloud</option>
                  <option value="local">Local</option>
                </select>
              </Field>

              <Field
                label="Max Branches"
                helper="Paid branch limit. Support can adjust this; the client cannot."
              >
                <input
                  value={form.max_branches}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_MAX_BRANCHES",
                      maxBranches: toPositiveInt(e.target.value, 1),
                    })
                  }
                  type="number"
                  min={1}
                  style={inputStyle}
                />
              </Field>

              {form.attendance_mode === "local" && (
                <Field
                  label="Node Offline Threshold Seconds"
                  helper="Fallback can activate after this heartbeat gap (5–300 seconds)."
                >
                  <input
                    value={form.node_offline_threshold_seconds}
                    onChange={(e) =>
                      dispatch({
                        type: "PATCH",
                        patch: {
                          node_offline_threshold_seconds: Math.min(
                            300,
                            Math.max(5, toPositiveInt(e.target.value, 10)),
                          ),
                        },
                      })
                    }
                    type="number"
                    min={5}
                    max={300}
                    style={inputStyle}
                  />
                </Field>
              )}
            </div>

            {selectedTemplate && (
              <div
                style={{
                  marginTop: 12,
                  fontSize: 11,
                  color: T.textMuted,
                  fontWeight: 700,
                }}
              >
                Template selected: {selectedTemplate.label}. Attendance applies
                to{" "}
                {form.attendance_people_types
                  .map((type) => peopleTypeLabel(templateLabels, type))
                  .join(", ") || "none"}
                . Backend derives full vertical_config.
              </div>
            )}
          </section>

          <section
            style={{
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              padding: 16,
            }}
          >
            <h3 style={sectionTitleStyle}>2. Purchased Modules</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {MODULE_DEFINITIONS.map((module) => {
                const active = form.selected_modules.includes(module.key);
                return (
                  <button
                    key={module.key}
                    type="button"
                    title={module.description}
                    onClick={() =>
                      dispatch({ type: "TOGGLE_MODULE", module: module.key })
                    }
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      border: `1px solid ${active ? T.teal600 : T.border}`,
                      background: active ? T.teal50 : T.white,
                      color: active ? T.teal700 : T.textMuted,
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    {module.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section
            style={{
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              padding: 16,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div>
                <h3 style={{ ...sectionTitleStyle, marginBottom: 3 }}>
                  3. Branches & Capacity
                </h3>
                <p style={{ margin: 0, fontSize: 11, color: T.textMuted }}>
                  Capacity remains stored as max_staff_capacity for
                  compatibility, but UI labels follow the template.
                </p>
              </div>
              <button
                type="button"
                onClick={() => dispatch({ type: "ADD_BRANCH" })}
                disabled={!canAddBranch}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  border: `1px solid ${canAddBranch ? T.teal600 : T.border}`,
                  background: canAddBranch ? T.teal50 : T.slate100,
                  color: canAddBranch ? T.teal700 : T.textLight,
                  borderRadius: 9,
                  padding: "8px 11px",
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: canAddBranch ? "pointer" : "not-allowed",
                }}
              >
                <Plus size={13} /> Add Branch ({form.branches.length}/
                {form.max_branches})
              </button>
              {!canAddBranch && (
                <span
                  style={{
                    marginLeft: 10,
                    color: T.amber600,
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  Branch limit reached. Increase <strong>Max Branches</strong>{" "}
                  above to add more — this is a plan limit, not a permissions
                  restriction.
                </span>
              )}
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              {form.branches.map((branch, index) => (
                <div
                  key={`branch-${index}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.1fr 1fr 1.1fr 0.7fr auto",
                    gap: 10,
                    alignItems: "end",
                    padding: 12,
                    border: `1px solid ${T.border}`,
                    borderRadius: 12,
                    background: T.slate50,
                  }}
                >
                  <Field label={`Branch ${index + 1} Name`}>
                    <input
                      value={branch.name}
                      onChange={(e) =>
                        dispatch({
                          type: "UPDATE_BRANCH",
                          index,
                          patch: { name: e.target.value },
                        })
                      }
                      placeholder="Main Branch"
                      style={inputStyle}
                    />
                  </Field>

                  <Field label="Location">
                    <input
                      value={branch.location}
                      onChange={(e) =>
                        dispatch({
                          type: "UPDATE_BRANCH",
                          index,
                          patch: { location: e.target.value },
                        })
                      }
                      placeholder="Rahim Yar Khan"
                      style={inputStyle}
                    />
                  </Field>

                  <TimezoneSelect
                    value={branch.timezone}
                    onChange={(timezone) =>
                      dispatch({
                        type: "UPDATE_BRANCH",
                        index,
                        patch: { timezone },
                      })
                    }
                  />

                  <Field label={`Max ${peopleLabel}`}>
                    <input
                      value={branch.max_staff_capacity}
                      onChange={(e) =>
                        dispatch({
                          type: "UPDATE_BRANCH",
                          index,
                          patch: {
                            max_staff_capacity: toPositiveInt(
                              e.target.value,
                              50,
                            ),
                          },
                        })
                      }
                      type="number"
                      min={1}
                      style={inputStyle}
                    />
                  </Field>

                  <button
                    type="button"
                    onClick={() => dispatch({ type: "REMOVE_BRANCH", index })}
                    disabled={form.branches.length === 1}
                    title="Remove branch"
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 9,
                      border: `1px solid ${T.border}`,
                      background:
                        form.branches.length === 1 ? T.slate100 : T.white,
                      color:
                        form.branches.length === 1 ? T.textLight : T.red600,
                      cursor:
                        form.branches.length === 1 ? "not-allowed" : "pointer",
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <div
              style={{
                marginTop: 10,
                padding: "9px 10px",
                borderRadius: 10,
                background: T.amber50,
                color: T.amber600,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              Branches are pre-created by Support. Client Dashboard reads them
              but cannot exceed max_branches.
            </div>
          </section>

          <section
            style={{
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              padding: 16,
            }}
          >
            <h3 style={{ ...sectionTitleStyle, marginBottom: 3 }}>
              4. Module &amp; People-Type Scope per Branch
            </h3>
            <p style={{ margin: "0 0 12px", fontSize: 11, color: T.textMuted }}>
              Every purchased module defaults to all of{" "}
              {templatePeopleTypes
                .map((t) => peopleTypeLabel(templateLabels, t))
                .join(" + ") || "the template's people types"}{" "}
              on every branch above — this is applied automatically, nothing to
              do here unless you want to narrow a specific branch. Only branches
              with a name are shown.
            </p>

            {templatePeopleTypes.length < 2 ? (
              <div
                style={{ fontSize: 11, color: T.textLight, fontWeight: 700 }}
              >
                This template only has one people type (
                {peopleTypeLabel(
                  templateLabels,
                  templatePeopleTypes[0] || "staff",
                )}
                ), so there is nothing to scope per module.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {form.branches
                  .filter((branch) => branch.name.trim())
                  .map((branch) => (
                    <div
                      key={branch.key}
                      style={{
                        border: `1px solid ${T.border}`,
                        borderRadius: 12,
                        padding: 12,
                        background: T.slate50,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 900,
                          color: T.textHeading,
                          marginBottom: 8,
                        }}
                      >
                        {branch.name.trim()}
                      </div>
                      <div style={{ display: "grid", gap: 8 }}>
                        {form.selected_modules.map((moduleKey) => {
                          const definition = MODULE_DEFINITIONS.find(
                            (m) => m.key === moduleKey,
                          );
                          const current =
                            form.moduleScopeOverrides[branch.key]?.[
                              moduleKey
                            ] ?? templatePeopleTypes;
                          return (
                            <div
                              key={`${branch.key}-${moduleKey}`}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                flexWrap: "wrap",
                                gap: 8,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 800,
                                  color: T.textBody,
                                  minWidth: 130,
                                }}
                              >
                                {definition?.label || moduleKey}
                              </span>
                              <div
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: 6,
                                }}
                              >
                                {templatePeopleTypes.map((peopleType) => {
                                  const selected = current.includes(peopleType);
                                  return (
                                    <button
                                      key={peopleType}
                                      type="button"
                                      onClick={() =>
                                        dispatch({
                                          type: "TOGGLE_BRANCH_MODULE_PEOPLE_TYPE",
                                          branchKey: branch.key,
                                          moduleKey,
                                          peopleType,
                                          availablePeopleTypes:
                                            templatePeopleTypes,
                                        })
                                      }
                                      style={{
                                        border: `1px solid ${selected ? T.teal600 : T.border}`,
                                        borderRadius: 999,
                                        background: selected
                                          ? T.teal50
                                          : T.white,
                                        color: selected
                                          ? T.teal700
                                          : T.textMuted,
                                        padding: "4px 10px",
                                        fontSize: 10,
                                        fontWeight: 800,
                                        cursor: "pointer",
                                      }}
                                    >
                                      {peopleTypeLabel(
                                        templateLabels,
                                        peopleType,
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                        {!form.selected_modules.length && (
                          <div style={{ fontSize: 11, color: T.textLight }}>
                            Select at least one purchased module above to scope
                            it.
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </section>

          <section
            style={{
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              padding: 16,
              background: T.slate50,
            }}
          >
            <h3 style={sectionTitleStyle}>5. First Invoice Optional</h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: 12,
              }}
            >
              <Field label="Billing Cycle">
                <select
                  value={form.billing_cycle}
                  onChange={(e) => {
                    const next = e.target.value as BillingCycle;
                    dispatch({
                      type: "PATCH",
                      patch: {
                        billing_cycle: next,
                        invoice_due_date: periodEndForCycle(next),
                      },
                    });
                  }}
                  style={inputStyle}
                >
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annually">Annually</option>
                </select>
              </Field>
              <Field label="Invoice Amount">
                <input
                  value={form.invoice_amount}
                  onChange={(e) =>
                    dispatch({
                      type: "PATCH",
                      patch: { invoice_amount: Number(e.target.value) || 0 },
                    })
                  }
                  type="number"
                  min={0}
                  step="0.01"
                  style={inputStyle}
                />
              </Field>
              <Field label="Due Date">
                <input
                  value={form.invoice_due_date}
                  onChange={(e) =>
                    dispatch({
                      type: "PATCH",
                      patch: { invoice_due_date: e.target.value },
                    })
                  }
                  type="date"
                  style={inputStyle}
                />
              </Field>
              <Field label="Grace Days">
                <input
                  value={form.grace_period_days}
                  onChange={(e) =>
                    dispatch({
                      type: "PATCH",
                      patch: {
                        grace_period_days: toPositiveInt(e.target.value, 7),
                      },
                    })
                  }
                  type="number"
                  min={0}
                  style={inputStyle}
                />
              </Field>
            </div>
            <div style={{ marginTop: 12 }}>
              <Field label="Invoice Notes">
                <textarea
                  value={form.invoice_notes}
                  onChange={(e) =>
                    dispatch({
                      type: "PATCH",
                      patch: { invoice_notes: e.target.value },
                    })
                  }
                  placeholder="Initial setup invoice including selected modules, branches, and capacity limits."
                  style={{ ...inputStyle, minHeight: 76, resize: "vertical" }}
                />
              </Field>
            </div>
          </section>
        </div>

        <div
          style={{
            position: "sticky",
            bottom: 0,
            background: T.white,
            borderTop: `1px solid ${T.border}`,
            padding: "14px 22px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 11, color: T.textLight, fontWeight: 700 }}>
            {selectedTemplate
              ? `Template: ${selectedTemplate.label}`
              : "Template will be derived by backend."}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              style={{
                border: `1px solid ${T.border}`,
                background: T.white,
                color: T.textMuted,
                borderRadius: 10,
                padding: "10px 15px",
                fontSize: 12,
                fontWeight: 800,
                cursor: isSaving ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              style={{
                border: "none",
                background: isSaving ? T.textLight : T.teal600,
                color: T.white,
                borderRadius: 10,
                padding: "10px 18px",
                fontSize: 12,
                fontWeight: 900,
                cursor: isSaving ? "not-allowed" : "pointer",
              }}
            >
              {isSaving ? "Creating…" : "Create Organization"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

export default CreateOrganizationModal;
