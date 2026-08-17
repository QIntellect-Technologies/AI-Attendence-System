/**
 * src/app/support-dashboard/modules/organizations/OrgDetail.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Organization detail page with lazy tab loading.
 *
 * Performance:
 * - Initial load: organization + vertical template cache only.
 * - Modules load only when Modules tab is opened.
 * - Branches load only when Branches tab is opened.
 * - Billing loads only when Billing tab is opened.
 * - Node health loads only when Monitoring tab is opened.
 *
 * Tenant/UUID safety:
 * - All ids stay as strings.
 * - Every child API call is scoped by orgId or branchId from the server row.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  UserPlus,
  X,
  Archive,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  branchesApi,
  extractApiError,
  invoicesApi,
  modulesApi,
  MODULE_DEFINITIONS,
  nodeHealthApi,
  organizationsApi,
} from "./api/organizationsApi";
import {
  useUpdateOrganizationTemplate,
  useUpdateOrganizationStaffTypeScope,
  useVerticalTemplates,
} from "./hooks/useOrganizations";
import BusinessTemplateSelect from "./components/BusinessTemplateSelect";
import AttendanceScopeSelector from "./components/AttendanceScopeSelector";
import InvoiceActions from "./components/InvoiceActions";
import { useInstallToken } from "../../hooks/useInstallToken";
import { useSupportAuth } from "../../contexts/SupportAuthContext";
import type {
  Branch,
  BusinessType,
  Invoice,
  NodeHealth,
  Organization,
  OrganizationModule,
  UpdateOrganizationPayload,
  PeopleType,
  PeopleTypeStructure,
  UpdateBranchPayload,
} from "../../packages/shared-types/src/organization";
import InstallTokenModal from "../../components/InstallTokenModal";
import {
  getModulePeopleTypesForBranch,
  normalizePeopleType,
} from "../../../client-dashboard/utils/templateRendering";
import TimezoneSelect from "./components/TimezoneSelect";

type Tab =
  | "overview"
  | "modules"
  | "branches"
  | "billing"
  | "monitoring"
  | "data_access"
  | "invite";

type LoadState<T> = {
  data: T;
  isLoading: boolean;
  error: string | null;
  loaded: boolean;
};

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "modules", label: "Module Entitlements" },
  { key: "branches", label: "Branches" },
  { key: "billing", label: "Billing" },
  { key: "monitoring", label: "Live Monitoring" },
  { key: "data_access", label: "Data & Access" },
  { key: "invite", label: "Invite Client" },
];

const T = {
  teal600: "#0d9488",
  teal50: "#f0fdfa",
  navy700: "#134471",
  blue50: "#eff6ff",
  slate50: "#f8fafc",
  slate100: "#f1f5f9",
  border: "#e2e8f0",
  bgPage: "#f5f6fa",
  bgCard: "#ffffff",
  textHeading: "#1a699f",
  text: "#334155",
  textMuted: "#64748b",
  textLight: "#94a3b8",
  red: "#ef4444",
  red50: "#fef2f2",
  green: "#16a34a",
  green50: "#f0fdf4",
  amber: "#d97706",
  amber50: "#fffbeb",
  shadow: "0 1px 3px rgba(15,45,74,0.07)",
} as const;

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 38,
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: "0 12px",
  outline: "none",
  color: T.text,
  fontSize: 12,
  fontWeight: 600,
  boxSizing: "border-box",
  background: T.bgCard,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  fontWeight: 900,
  color: T.textMuted,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 6,
};

function emptyState<T>(data: T): LoadState<T> {
  return { data, isLoading: false, error: null, loaded: false };
}

function statusChip(status?: string) {
  const normalized = String(status ?? "unknown").toLowerCase();
  const color = ["active", "paid", "online", "ok"].includes(normalized)
    ? T.green
    : ["pending", "grace_period"].includes(normalized)
      ? T.amber
      : [
            "inactive",
            "suspended",
            "overdue",
            "offline",
            "failed",
            "error",
          ].includes(normalized)
        ? T.red
        : T.textMuted;
  const bg =
    color === T.green
      ? T.green50
      : color === T.amber
        ? T.amber50
        : color === T.red
          ? T.red50
          : T.slate100;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 8px",
        borderRadius: 999,
        background: bg,
        color,
        fontSize: 10,
        fontWeight: 900,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {normalized}
    </span>
  );
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function formatCurrency(value: number | string): string {
  const amount = Number(value || 0);
  return Number.isFinite(amount)
    ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : String(value);
}

function unitLabel(
  labels: Record<string, string> | undefined,
  value?: string,
): string {
  if (!value) return "—";
  return (
    labels?.[value] ||
    value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

function structureText(
  labels: Record<string, string> | undefined,
  structure: PeopleTypeStructure,
): string {
  return (
    [structure.unit_1, structure.unit_2]
      .filter(Boolean)
      .map((unit) => unitLabel(labels, unit))
      .join(" → ") || "Custom"
  );
}

function SectionCard({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: 16,
        background: T.bgCard,
        boxShadow: T.shadow,
        padding: 18,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 14,
        }}
      >
        <h3
          style={{
            margin: 0,
            color: T.textHeading,
            fontSize: 15,
            fontWeight: 900,
          }}
        >
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 12px",
        borderRadius: 12,
        background: T.red50,
        color: T.red,
        fontSize: 12,
        fontWeight: 800,
      }}
    >
      <AlertCircle size={15} /> {message}
    </div>
  );
}

function LoadingBox({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        minHeight: 160,
        color: T.textMuted,
        fontSize: 13,
        fontWeight: 800,
      }}
    >
      <Loader2 size={18} className="spin" /> {label}
    </div>
  );
}

function TemplateSummary({ org }: { org: Organization }) {
  const config = org.vertical_config || {};
  const labels = config.labels || {};
  const structures = config.structures || {};

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        <Meta
          label="Business Type"
          value={unitLabel(labels, org.business_type)}
        />
        <Meta
          label="Primary People Type"
          value={unitLabel(labels, org.primary_people_type)}
        />
        <Meta
          label="Enabled People Types"
          value={
            (org.enabled_people_types || [])
              .map((type) => unitLabel(labels, type))
              .join(", ") || "—"
          }
        />
        <Meta
          label="Attendance Enabled For"
          value={
            (
              org.attendance_people_types ||
              org.vertical_config?.attendance_people_types ||
              org.enabled_people_types ||
              []
            )
              .map((type) => unitLabel(labels, type))
              .join(", ") || "—"
          }
        />
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {Object.entries(structures).map(([peopleType, structure]) => (
          <div
            key={peopleType}
            style={{
              padding: 10,
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              background: T.slate50,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <strong style={{ color: T.text, fontSize: 12 }}>
              {unitLabel(labels, peopleType)}
            </strong>
            <span style={{ color: T.textMuted, fontSize: 12, fontWeight: 700 }}>
              {structureText(labels, structure)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 12,
        background: T.slate50,
        border: `1px solid ${T.border}`,
      }}
    >
      <div style={{ ...labelStyle, marginBottom: 5 }}>{label}</div>
      <div
        style={{
          color: T.text,
          fontSize: 13,
          fontWeight: 800,
          overflowWrap: "anywhere",
        }}
      >
        {value || "—"}
      </div>
    </div>
  );
}

function OverviewTab({
  org,
  onOrgUpdated,
  branchesState,
  setBranchesState,
}: {
  org: Organization;
  onOrgUpdated: (org: Organization) => void;
  branchesState: LoadState<Branch[]>;
  setBranchesState: React.Dispatch<React.SetStateAction<LoadState<Branch[]>>>;
}) {
  const { templates, isLoading: templatesLoading } = useVerticalTemplates();
  const { updateOrganizationTemplate, isUpdatingTemplate } =
    useUpdateOrganizationTemplate();
  const { updateOrganizationStaffTypeScope, isUpdatingStaffTypeScope } =
    useUpdateOrganizationStaffTypeScope();
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [isEditingTemplate, setIsEditingTemplate] = useState(false);
  const [isEditingStaffTypeScope, setIsEditingStaffTypeScope] = useState(false);
  const [deleteReason, setDeleteReason] = useState(org.delete_reason || "");
  const [enabledStaffTypes, setEnabledStaffTypes] = useState<
    ("office" | "field")[]
  >(
    Array.isArray(org.enabled_staff_types) && org.enabled_staff_types.length
      ? org.enabled_staff_types
      : ["office", "field"],
  );
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState({
    name: org.name || "",
    contact_email: org.contact_email || "",
    contact_phone: org.contact_phone || "",
    org_type: org.org_type || "",
    attendance_mode: org.attendance_mode || "cloud",
    node_offline_threshold_seconds: Number(
      org.node_offline_threshold_seconds || 600,
    ),
    max_branches: Number(org.max_branches || 1),
  });
  const [businessType, setBusinessType] = useState<BusinessType>(
    org.business_type || "company",
  );
  const [attendancePeopleTypes, setAttendancePeopleTypes] = useState<
    PeopleType[]
  >(
    org.attendance_people_types ||
      org.vertical_config?.attendance_people_types ||
      org.enabled_people_types ||
      [],
  );
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [pendingProfilePayload, setPendingProfilePayload] =
    useState<UpdateOrganizationPayload | null>(null);
  const [dropSelection, setDropSelection] = useState<string[]>([]);
  const [dropReason, setDropReason] = useState(
    "Branch limit decreased from Support Dashboard",
  );
  const [dropCandidateBranches, setDropCandidateBranches] = useState<Branch[]>(
    [],
  );

  const selectedTemplate = useMemo(
    () =>
      templates.find(
        (template) => String(template.business_type) === String(businessType),
      ),
    [templates, businessType],
  );

  const templateLabels = useMemo(
    () =>
      selectedTemplate?.labels ||
      selectedTemplate?.vertical_config?.labels ||
      org.vertical_config?.labels ||
      {},
    [selectedTemplate, org.vertical_config],
  );

  const enabledPeopleTypes = useMemo<PeopleType[]>(() => {
    const enabled =
      selectedTemplate?.enabled_people_types ||
      selectedTemplate?.vertical_config?.enabled_people_types ||
      org.enabled_people_types ||
      org.vertical_config?.enabled_people_types ||
      [];

    return Array.from(
      new Set(
        enabled
          .map((type) => String(type).trim().toLowerCase())
          .filter(Boolean),
      ),
    ) as PeopleType[];
  }, [selectedTemplate, org.enabled_people_types, org.vertical_config]);

  useEffect(() => {
    setProfile({
      name: org.name || "",
      contact_email: org.contact_email || "",
      contact_phone: org.contact_phone || "",
      org_type: org.org_type || "",
      attendance_mode: org.attendance_mode || "cloud",
      node_offline_threshold_seconds: Number(
        org.node_offline_threshold_seconds || 600,
      ),
      max_branches: Number(org.max_branches || 1),
    });
    setBusinessType(org.business_type || "company");
    setAttendancePeopleTypes(
      org.attendance_people_types ||
        org.vertical_config?.attendance_people_types ||
        org.enabled_people_types ||
        [],
    );
  }, [org]);

  const persistProfile = async (payload: UpdateOrganizationPayload) => {
    const updated = await organizationsApi.update(payload);
    onOrgUpdated(updated);
    setIsEditingProfile(false);
    return updated;
  };

  const selectedDropCount = dropSelection.length;
  const requiredDropCount = pendingProfilePayload?.max_branches
    ? Math.max(
        0,
        dropCandidateBranches.length -
          Number(pendingProfilePayload.max_branches),
      )
    : 0;

  const saveProfile = async () => {
    setIsSavingProfile(true);
    setError(null);
    try {
      const nextMaxBranches = Number(profile.max_branches || 1);
      const payload: UpdateOrganizationPayload = {
        id: org.id,
        name: profile.name.trim(),
        contact_email: profile.contact_email.trim().toLowerCase(),
        contact_phone: profile.contact_phone.trim() || null,
        org_type: profile.org_type.trim() || null,
        attendance_mode: profile.attendance_mode,
        node_offline_threshold_seconds:
          profile.attendance_mode === "local"
            ? Number(profile.node_offline_threshold_seconds || 600)
            : null,
        max_branches: nextMaxBranches,
      };

      const activeBranches = branchesState.loaded
        ? branchesState.data
        : await branchesApi.list(org.id);

      if (!branchesState.loaded) {
        setBranchesState({
          data: activeBranches,
          isLoading: false,
          error: null,
          loaded: true,
        });
      }

      const requiredDrops = activeBranches.length - nextMaxBranches;
      if (requiredDrops > 0) {
        setPendingProfilePayload(payload);
        setDropCandidateBranches(activeBranches);
        setDropSelection([]);
        setDropReason("Branch limit decreased from Support Dashboard");
        return;
      }

      await persistProfile(payload);
    } catch (err) {
      setError(extractApiError(err, "Failed to update organization profile"));
    } finally {
      setIsSavingProfile(false);
    }
  };

  const toggleDropSelection = (branchId: string) => {
    setDropSelection((current) => {
      if (current.includes(branchId)) {
        return current.filter((item) => item !== branchId);
      }
      if (current.length >= requiredDropCount) return current;
      return [...current, branchId];
    });
  };

  const cancelBranchDrop = () => {
    setPendingProfilePayload(null);
    setDropCandidateBranches([]);
    setDropSelection([]);
    setDropReason("Branch limit decreased from Support Dashboard");
  };

  const confirmBranchDropAndSave = async () => {
    if (!pendingProfilePayload) return;
    if (selectedDropCount !== requiredDropCount) {
      setError(`Select exactly ${requiredDropCount} branch(es) to drop.`);
      return;
    }

    setIsSavingProfile(true);
    setError(null);
    try {
      const updated = await persistProfile({
        ...pendingProfilePayload,
        drop_branch_ids: dropSelection,
        branch_limit_drop_reason:
          dropReason.trim() || "Branch limit decreased from Support Dashboard",
      });
      const activeBranches = await branchesApi.list(org.id);
      setBranchesState({
        data: activeBranches,
        isLoading: false,
        error: null,
        loaded: true,
      });
      cancelBranchDrop();
      onOrgUpdated(updated);
    } catch (err) {
      setError(extractApiError(err, "Failed to decrease branch limit"));
    } finally {
      setIsSavingProfile(false);
    }
  };

  const toggleAttendancePeopleType = (peopleType: PeopleType) => {
    setAttendancePeopleTypes((current) => {
      const key = String(peopleType).trim().toLowerCase() as PeopleType;
      const exists = current.includes(key);
      const next = exists
        ? current.filter((item) => item !== key)
        : [...current, key];
      return next.length ? next : current;
    });
  };

  const saveTemplate = async () => {
    setError(null);
    try {
      const allowed = enabledPeopleTypes.length
        ? enabledPeopleTypes
        : attendancePeopleTypes;
      const scopedAttendance = attendancePeopleTypes.filter((type) =>
        allowed.includes(type),
      );
      const finalAttendanceScope = scopedAttendance.length
        ? scopedAttendance
        : allowed;

      const updated = await updateOrganizationTemplate(
        org.id,
        businessType,
        finalAttendanceScope,
      );

      onOrgUpdated(updated);
      setIsEditingTemplate(false);
    } catch (err) {
      setError(extractApiError(err, "Failed to update business template"));
    }
  };

  const saveStaffTypeScope = async () => {
    setError(null);
    try {
      const updated = await updateOrganizationStaffTypeScope(
        org.id,
        enabledStaffTypes,
      );
      onOrgUpdated(updated);
      setIsEditingStaffTypeScope(false);
    } catch (err) {
      setError(extractApiError(err, "Failed to update staff type scope"));
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {error && <ErrorBox message={error} />}

      {pendingProfilePayload && (
        <SectionCard title="Select Branches to Drop">
          <div style={{ display: "grid", gap: 12 }}>
            <div
              style={{
                padding: 12,
                borderRadius: 12,
                background: T.amber50,
                color: T.amber,
                fontSize: 12,
                fontWeight: 800,
                lineHeight: 1.5,
              }}
            >
              The new branch limit is {pendingProfilePayload.max_branches}.
              Select exactly {requiredDropCount} branch(es) to drop from the
              Client Dashboard. Historical data is preserved and active node
              keys for dropped branches are revoked.
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {dropCandidateBranches.map((branch) => {
                const checked = dropSelection.includes(branch.id);
                return (
                  <label
                    key={branch.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: 12,
                      borderRadius: 12,
                      border: `1px solid ${checked ? T.red : T.border}`,
                      background: checked ? T.red50 : T.bgCard,
                      cursor: isSavingProfile ? "not-allowed" : "pointer",
                    }}
                  >
                    <span>
                      <strong style={{ color: T.text, fontSize: 13 }}>
                        {branch.name}
                      </strong>
                      <div style={{ color: T.textMuted, fontSize: 11 }}>
                        {branch.location || "No location"} · Capacity{" "}
                        {branch.max_staff_capacity}
                      </div>
                    </span>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isSavingProfile}
                      onChange={() => toggleDropSelection(branch.id)}
                      style={{ accentColor: T.red }}
                    />
                  </label>
                );
              })}
            </div>

            <label>
              <span style={labelStyle}>Drop Reason</span>
              <input
                value={dropReason}
                onChange={(event) => setDropReason(event.target.value)}
                style={inputStyle}
              />
            </label>

            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <button
                type="button"
                onClick={cancelBranchDrop}
                disabled={isSavingProfile}
                style={secondaryButton()}
              >
                <X size={14} /> Cancel
              </button>
              <button
                type="button"
                onClick={confirmBranchDropAndSave}
                disabled={
                  isSavingProfile || selectedDropCount !== requiredDropCount
                }
                style={{
                  ...primaryButton(),
                  background:
                    selectedDropCount === requiredDropCount
                      ? T.red
                      : T.textLight,
                }}
              >
                <Trash2 size={14} /> Drop {requiredDropCount} Branch(es)
              </button>
            </div>
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Organization Profile"
        action={
          isEditingProfile ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setIsEditingProfile(false)}
                style={secondaryButton()}
              >
                <X size={14} /> Cancel
              </button>
              <button
                type="button"
                onClick={saveProfile}
                disabled={isSavingProfile}
                style={primaryButton()}
              >
                <Save size={14} /> Save
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditingProfile(true)}
              style={secondaryButton()}
            >
              <Pencil size={14} /> Edit
            </button>
          )
        }
      >
        {isEditingProfile ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 12,
            }}
          >
            <EditField
              label="Name"
              value={profile.name}
              onChange={(name) => setProfile((p) => ({ ...p, name }))}
            />
            <EditField
              label="Contact Email"
              value={profile.contact_email}
              onChange={(contact_email) =>
                setProfile((p) => ({ ...p, contact_email }))
              }
            />
            <EditField
              label="Contact Phone"
              value={profile.contact_phone}
              onChange={(contact_phone) =>
                setProfile((p) => ({ ...p, contact_phone }))
              }
            />
            <EditField
              label="Org Type"
              value={profile.org_type}
              onChange={(org_type) => setProfile((p) => ({ ...p, org_type }))}
            />
            <label>
              <span style={labelStyle}>Attendance Mode</span>
              <select
                value={profile.attendance_mode}
                onChange={(e) =>
                  setProfile((p) => ({
                    ...p,
                    attendance_mode: e.target.value as "cloud" | "local",
                  }))
                }
                style={inputStyle}
              >
                <option value="cloud">Cloud</option>
                <option value="local">Local</option>
              </select>
            </label>

            <EditField
              label="Max Branches"
              type="number"
              value={String(profile.max_branches)}
              onChange={(max_branches) =>
                setProfile((p) => ({
                  ...p,
                  max_branches: Math.min(
                    1000,
                    Math.max(1, Number(max_branches) || 1),
                  ),
                }))
              }
            />
            {profile.attendance_mode === "local" && (
              <>
                <EditField
                  label="Node Offline Threshold (seconds)"
                  type="number"
                  value={String(profile.node_offline_threshold_seconds)}
                  onChange={(node_offline_threshold_seconds) =>
                    setProfile((p) => ({
                      ...p,
                      node_offline_threshold_seconds:
                        Number(node_offline_threshold_seconds) || 600,
                    }))
                  }
                />
              </>
            )}
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 12,
            }}
          >
            <Meta label="Name" value={org.name} />
            <Meta label="Contact Email" value={org.contact_email} />
            <Meta label="Contact Phone" value={org.contact_phone || "—"} />
            <Meta label="Org Type" value={org.org_type || "—"} />
            <Meta
              label="Attendance Mode"
              value={String(org.attendance_mode || "—").toUpperCase()}
            />
            <Meta label="Max Branches" value={org.max_branches} />
            <Meta
              label="Node Offline Threshold (sec)"
              value={org.node_offline_threshold_seconds ?? "Cloud mode"}
            />

            <Meta label="Status" value={statusChip(org.status)} />
            <Meta label="Created" value={formatDate(org.created_at)} />
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Organization Template"
        action={
          isEditingTemplate ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setBusinessType(org.business_type || "company");
                  setAttendancePeopleTypes(
                    org.attendance_people_types ||
                      org.vertical_config?.attendance_people_types ||
                      org.enabled_people_types ||
                      [],
                  );
                  setIsEditingTemplate(false);
                }}
                style={secondaryButton()}
              >
                <X size={14} /> Cancel
              </button>
              <button
                type="button"
                onClick={saveTemplate}
                disabled={isUpdatingTemplate}
                style={primaryButton()}
              >
                <Save size={14} /> Save Template
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditingTemplate(true)}
              style={secondaryButton()}
            >
              <Pencil size={14} /> Change Template
            </button>
          )
        }
      >
        {isEditingTemplate ? (
          <div style={{ display: "grid", gap: 12 }}>
            <BusinessTemplateSelect
              value={businessType}
              templates={templates}
              disabled={templatesLoading || isUpdatingTemplate}
              onChange={(nextBusinessType) => {
                setBusinessType(nextBusinessType);
                const nextTemplate = templates.find(
                  (template) =>
                    String(template.business_type) === String(nextBusinessType),
                );
                const nextEnabled =
                  nextTemplate?.enabled_people_types ||
                  nextTemplate?.vertical_config?.enabled_people_types ||
                  [];
                const nextAttendanceScope =
                  nextTemplate?.attendance_people_types ||
                  nextTemplate?.vertical_config?.attendance_people_types ||
                  nextEnabled;
                setAttendancePeopleTypes(
                  Array.from(
                    new Set(
                      nextAttendanceScope
                        .map((type) => String(type).trim().toLowerCase())
                        .filter(Boolean),
                    ),
                  ) as PeopleType[],
                );
              }}
              helper="Changing the template updates support-owned vertical fields only. It does not touch modules, billing, branches, or attendance mode."
            />

            <div style={{ display: "grid", gap: 8 }}>
              <div style={labelStyle}>Attendance Enabled For</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {enabledPeopleTypes.map((peopleType) => {
                  const checked = attendancePeopleTypes.includes(peopleType);
                  return (
                    <label
                      key={peopleType}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "9px 12px",
                        borderRadius: 12,
                        border: `1px solid ${checked ? T.teal600 : T.border}`,
                        background: checked ? T.teal50 : T.bgCard,
                        color: checked ? T.teal600 : T.text,
                        fontSize: 12,
                        fontWeight: 900,
                        cursor:
                          templatesLoading || isUpdatingTemplate
                            ? "not-allowed"
                            : "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={templatesLoading || isUpdatingTemplate}
                        onChange={() => toggleAttendancePeopleType(peopleType)}
                        style={{ accentColor: T.teal600 }}
                      />
                      {unitLabel(templateLabels, peopleType)}
                    </label>
                  );
                })}
              </div>
              <div
                style={{ color: T.textMuted, fontSize: 11, lineHeight: 1.5 }}
              >
                Choose who biometric attendance is enabled for. For a school,
                select Students only, Staff only, or both. This does not remove
                staff/student records; it only controls attendance scope.
              </div>
            </div>

            <div
              style={{
                padding: 12,
                borderRadius: 12,
                background: T.amber50,
                color: T.amber,
                fontSize: 12,
                fontWeight: 800,
              }}
            >
              Template change is support-only. Client Dashboard can read the
              resulting tenant config but cannot modify it.
            </div>
          </div>
        ) : (
          <TemplateSummary org={org} />
        )}
      </SectionCard>

      <SectionCard
        title="Staff Type Scope"
        action={
          isEditingStaffTypeScope ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setEnabledStaffTypes(
                    Array.isArray(org.enabled_staff_types) &&
                      org.enabled_staff_types.length
                      ? org.enabled_staff_types
                      : ["office", "field"],
                  );
                  setIsEditingStaffTypeScope(false);
                }}
                style={secondaryButton()}
              >
                <X size={14} /> Cancel
              </button>
              <button
                type="button"
                onClick={saveStaffTypeScope}
                disabled={isUpdatingStaffTypeScope}
                style={primaryButton()}
              >
                <Save size={14} /> Save Scope
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditingStaffTypeScope(true)}
              style={secondaryButton()}
            >
              <Pencil size={14} /> Change Scope
            </button>
          )
        }
      >
        {isEditingStaffTypeScope ? (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={labelStyle}>Staff Attendance Enabled For</div>
              <AttendanceScopeSelector
                availablePeopleTypes={["office", "field"]}
                value={enabledStaffTypes}
                onChange={(next) =>
                  setEnabledStaffTypes(next as ("office" | "field")[])
                }
                labels={{ office: "Office Staff", field: "Field Staff" }}
                disabled={isUpdatingStaffTypeScope}
              />
            </div>

            <div
              style={{
                padding: 12,
                borderRadius: 12,
                background: T.amber50,
                color: T.amber,
                fontSize: 12,
                fontWeight: 800,
                lineHeight: 1.5,
              }}
            >
              Commercial, Support-owned scope based on what this client is
              paying for. It controls which staff work types (Office/Field) the
              Client Dashboard's Staff Management can add — separate from
              biometric attendance scope above, and from module entitlements on
              the Modules tab.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {(Array.isArray(org.enabled_staff_types) &&
            org.enabled_staff_types.length
              ? org.enabled_staff_types
              : ["office", "field"]
            ).map((type) => (
              <span
                key={type}
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: T.teal50,
                  color: T.teal600,
                  fontSize: 12,
                  fontWeight: 900,
                }}
              >
                {type === "field" ? "Field Staff" : "Office Staff"}
              </span>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function EditField({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label>
      <span style={labelStyle}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        style={inputStyle}
      />
    </label>
  );
}

function primaryButton(): React.CSSProperties {
  return {
    height: 38,
    border: "none",
    borderRadius: 10,
    background: T.teal600,
    color: "white",
    fontSize: 12,
    fontWeight: 900,
    padding: "0 13px",
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    cursor: "pointer",
  };
}

function secondaryButton(): React.CSSProperties {
  return {
    height: 38,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    background: T.bgCard,
    color: T.textMuted,
    fontSize: 12,
    fontWeight: 900,
    padding: "0 13px",
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    cursor: "pointer",
  };
}

function ModulesTab({
  orgId,
  org,
  branches,
  state,
  setState,
}: {
  orgId: string;
  org: Organization;
  branches: Branch[];
  state: LoadState<OrganizationModule[]>;
  setState: React.Dispatch<
    React.SetStateAction<LoadState<OrganizationModule[]>>
  >;
}) {
  const [modulePeopleTypes, setModulePeopleTypes] = useState<
    Record<string, Record<string, string[]>>
  >({});
  const [branchConfigLoaded, setBranchConfigLoaded] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingPeopleTypeKey, setSavingPeopleTypeKey] = useState<string | null>(
    null,
  );
  const active = useMemo(
    () =>
      new Set(
        state.data
          .filter((m) => m.status === "active")
          .map((m) => String(m.module_name)),
      ),
    [state.data],
  );

  const availablePeopleTypes = useMemo(() => {
    const fromOrg = Array.isArray(org?.enabled_people_types)
      ? org.enabled_people_types.filter(Boolean)
      : [];
    const fromVertical = Array.isArray(
      (org?.vertical_config as Record<string, unknown> | null)
        ?.enabled_people_types,
    )
      ? (
          (org?.vertical_config as Record<string, unknown> | null)
            ?.enabled_people_types as unknown[]
        ).filter(Boolean)
      : [];
    const combined = [...fromOrg, ...fromVertical]
      .map((value) => normalizePeopleType(value))
      .filter(Boolean);

    if (combined.length) {
      return Array.from(new Set(combined));
    }

    const fallback = normalizePeopleType(org?.primary_people_type || "staff");
    return fallback ? [fallback] : ["staff"];
  }, [
    org?.enabled_people_types,
    org?.primary_people_type,
    org?.vertical_config,
  ]);

  useEffect(() => {
    let cancelled = false;

    const loadBranchConfigs = async () => {
      if (!branches.length) {
        if (!cancelled) {
          setModulePeopleTypes({});
          setBranchConfigLoaded(true);
        }
        return;
      }

      const next: Record<string, Record<string, string[]>> = {};
      for (const branch of branches) {
        try {
          const config = await branchesApi.getModulePeopleTypes(
            orgId,
            branch.id,
          );
          if (!cancelled) {
            next[branch.id] = config ?? {};
          }
        } catch {
          if (!cancelled) {
            next[branch.id] = {};
          }
        }
      }

      if (!cancelled) {
        setModulePeopleTypes(next);
        setBranchConfigLoaded(true);
      }
    };

    setBranchConfigLoaded(false);
    void loadBranchConfigs();

    return () => {
      cancelled = true;
    };
  }, [branches, orgId]);

  const toggle = async (key: string) => {
    setSavingKey(key);
    try {
      const module = await modulesApi.toggle({
        org_id: orgId,
        module_name: key,
        status: active.has(key) ? "inactive" : "active",
      });
      setState((current) => ({
        ...current,
        data: [
          ...current.data.filter((m) => m.module_name !== module.module_name),
          module,
        ],
      }));
    } finally {
      setSavingKey(null);
    }
  };

  const toggleBranchPeopleType = async (
    branchId: string,
    moduleKey: string,
    peopleType: string,
  ) => {
    const currentBranchConfig = modulePeopleTypes[branchId] ?? {};
    const currentTypes = currentBranchConfig[moduleKey] ?? [];
    const nextTypes = currentTypes.includes(peopleType)
      ? currentTypes.filter((value) => value !== peopleType)
      : [...currentTypes, peopleType];

    setSavingPeopleTypeKey(`${branchId}:${moduleKey}`);
    try {
      const nextConfig = await branchesApi.setModulePeopleTypes(
        orgId,
        branchId,
        {
          ...(currentBranchConfig as Record<string, string[]>),
          [moduleKey]: nextTypes,
        },
      );
      setModulePeopleTypes((current) => ({
        ...current,
        [branchId]: {
          ...(current[branchId] ?? {}),
          [moduleKey]: nextConfig?.[moduleKey] ?? nextTypes,
        },
      }));
    } finally {
      setSavingPeopleTypeKey(null);
    }
  };

  if (state.isLoading) return <LoadingBox label="Loading modules…" />;
  if (state.error) return <ErrorBox message={state.error} />;

  return (
    <SectionCard title="Module Entitlements">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 12,
        }}
      >
        {MODULE_DEFINITIONS.map((definition) => {
          const isActive = active.has(definition.key);
          return (
            <div
              key={definition.key}
              style={{
                border: `1px solid ${isActive ? T.teal600 : T.border}`,
                borderRadius: 14,
                padding: 14,
                background: isActive ? T.teal50 : T.bgCard,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  alignItems: "flex-start",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ color: T.text, fontSize: 13, fontWeight: 900 }}>
                    {definition.label}
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      color: T.textMuted,
                      fontSize: 11,
                      lineHeight: 1.5,
                    }}
                  >
                    {definition.description}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void toggle(definition.key)}
                  disabled={savingKey === definition.key}
                  style={isActive ? primaryButton() : secondaryButton()}
                >
                  {savingKey === definition.key ? (
                    <Loader2 size={14} />
                  ) : isActive ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <Plus size={14} />
                  )}
                  {isActive ? "Active" : "Enable"}
                </button>
              </div>

              {isActive && branches.length > 0 && (
                <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                  <div
                    style={{
                      color: T.textMuted,
                      fontSize: 10,
                      fontWeight: 900,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Branch visibility
                  </div>
                  {branches.map((branch) => {
                    const branchTypes =
                      modulePeopleTypes[branch.id]?.[definition.key] ?? [];
                    const isSaving =
                      savingPeopleTypeKey === `${branch.id}:${definition.key}`;
                    return (
                      <div
                        key={branch.id}
                        style={{
                          border: `1px solid ${T.border}`,
                          borderRadius: 10,
                          padding: 10,
                          background: T.bgCard,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 900,
                            color: T.text,
                            marginBottom: 7,
                          }}
                        >
                          {branch.name || `Branch ${branch.id}`}
                        </div>
                        <div
                          style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
                        >
                          {availablePeopleTypes.map((peopleType) => {
                            const selected = branchTypes.includes(peopleType);
                            return (
                              <button
                                key={`${branch.id}-${peopleType}`}
                                type="button"
                                onClick={() =>
                                  void toggleBranchPeopleType(
                                    branch.id,
                                    definition.key,
                                    peopleType,
                                  )
                                }
                                disabled={isSaving}
                                style={{
                                  border: `1px solid ${selected ? T.teal600 : T.border}`,
                                  borderRadius: 999,
                                  background: selected ? T.teal50 : T.bgCard,
                                  color: selected ? T.teal600 : T.textMuted,
                                  padding: "4px 8px",
                                  fontSize: 10,
                                  fontWeight: 900,
                                  cursor: "pointer",
                                }}
                              >
                                {peopleType}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {!branchConfigLoaded && (
                    <div style={{ fontSize: 11, color: T.textMuted }}>
                      Loading branch visibility…
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

const isLocalAttendanceMode = (value?: string | null): boolean =>
  String(value || "")
    .trim()
    .toLowerCase() === "local";

function BranchesTab({
  org,
  state,
  setState,
}: {
  org: Organization;
  state: LoadState<Branch[]>;
  setState: React.Dispatch<React.SetStateAction<LoadState<Branch[]>>>;
}) {
  const [draft, setDraft] = useState({
    name: "",
    location: "",
    max_staff_capacity: 50,
    timezone: "UTC",
  });
  const [isSaving, setIsSaving] = useState(false);
  const {
    token,
    isGenerating,
    error: tokenError,
    generate,
    clear,
  } = useInstallToken((orgId, branchId) =>
    branchesApi.createInstallToken(orgId, branchId),
  );
  const [generatingBranchId, setGeneratingBranchId] = useState<string | null>(
    null,
  );
  const [branchError, setBranchError] = useState<string | null>(null);
  const [editingBranchId, setEditingBranchId] = useState<string | null>(null);
  const [savingBranchId, setSavingBranchId] = useState<string | null>(null);
  const [branchDraft, setBranchDraft] = useState({
    name: "",
    location: "",
    max_staff_capacity: 1,
    timezone: "UTC",
  });
  const limitReached = state.data.length >= Number(org.max_branches || 0);
  const localAttendance = isLocalAttendanceMode(org.attendance_mode);

  const createBranch = async () => {
    if (!draft.name.trim() || limitReached) return;
    setIsSaving(true);
    setBranchError(null);
    try {
      const branch = await branchesApi.create(org.id, {
        name: draft.name.trim(),
        location: draft.location.trim() || undefined,
        max_staff_capacity: Number(draft.max_staff_capacity || 50),
        timezone: draft.timezone,
      });
      setState((current) => ({ ...current, data: [...current.data, branch] }));
      setDraft({
        name: "",
        location: "",
        max_staff_capacity: 50,
        timezone: "UTC",
      });
    } catch (err) {
      setBranchError(extractApiError(err, "Failed to create branch"));
    } finally {
      setIsSaving(false);
    }
  };

  const startEditBranch = (branch: Branch) => {
    setBranchError(null);
    setEditingBranchId(branch.id);
    setBranchDraft({
      name: branch.name || "",
      location: branch.location || "",
      max_staff_capacity: Number(branch.max_staff_capacity || 1),
      timezone: branch.timezone || "UTC", // ← new
    });
  };

  const cancelEditBranch = () => {
    setEditingBranchId(null);
    setSavingBranchId(null);
    setBranchDraft({
      name: "",
      location: "",
      max_staff_capacity: 1,
      timezone: "UTC",
    });
  };

  const saveBranch = async (branchId: string) => {
    if (!branchDraft.name.trim()) {
      setBranchError("Branch name is required.");
      return;
    }

    const nextCapacity = Number(branchDraft.max_staff_capacity || 0);
    if (!Number.isFinite(nextCapacity) || nextCapacity < 1) {
      setBranchError("Branch capacity must be at least 1.");
      return;
    }

    setSavingBranchId(branchId);
    setBranchError(null);
    try {
      const updated = await branchesApi.update(org.id, branchId, {
        name: branchDraft.name.trim(),
        location: branchDraft.location.trim() || null,
        max_staff_capacity: nextCapacity,
        timezone: branchDraft.timezone,
      });
      setState((current) => ({
        ...current,
        data: current.data.map((branch) =>
          branch.id === branchId ? updated : branch,
        ),
      }));
      cancelEditBranch();
    } catch (err) {
      setBranchError(extractApiError(err, "Failed to update branch"));
    } finally {
      setSavingBranchId(null);
    }
  };

  const handleGenerateToken = async (branch: Branch) => {
    if (!localAttendance) return;
    setGeneratingBranchId(branch.id);
    await generate(org.id, branch.id);
    setGeneratingBranchId(null);
  };

  if (state.isLoading) return <LoadingBox label="Loading branches…" />;
  if (state.error) return <ErrorBox message={state.error} />;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <SectionCard
        title={`Branches (${state.data.length}/${org.max_branches})`}
      >
        {tokenError && (
          <div style={{ marginBottom: 12 }}>
            <ErrorBox message={tokenError} />
          </div>
        )}
        {branchError && (
          <div style={{ marginBottom: 12 }}>
            <ErrorBox message={branchError} />
          </div>
        )}
        <div style={{ display: "grid", gap: 10 }}>
          {state.data.map((branch) => {
            const generating = generatingBranchId === branch.id && isGenerating;
            const isEditing = editingBranchId === branch.id;
            const saving = savingBranchId === branch.id;

            if (isEditing) {
              return (
                <div
                  key={branch.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: localAttendance
                      ? "1.2fr 1.2fr 160px auto auto"
                      : "1.2fr 1.2fr 160px auto",
                    gap: 10,
                    alignItems: "end",
                    padding: 12,
                    border: `1px solid ${T.border}`,
                    borderRadius: 12,
                    background: T.slate50,
                  }}
                >
                  <EditField
                    label="Branch Name"
                    value={branchDraft.name}
                    onChange={(name) =>
                      setBranchDraft((current) => ({ ...current, name }))
                    }
                  />
                  <EditField
                    label="Location"
                    value={branchDraft.location}
                    onChange={(location) =>
                      setBranchDraft((current) => ({ ...current, location }))
                    }
                  />
                  <EditField
                    label="Capacity"
                    type="number"
                    value={String(branchDraft.max_staff_capacity)}
                    onChange={(value) =>
                      setBranchDraft((current) => ({
                        ...current,
                        max_staff_capacity: Math.min(
                          100000,
                          Math.max(1, Number(value) || 1),
                        ),
                      }))
                    }
                  />
                  <TimezoneSelect
                    value={branchDraft.timezone}
                    onChange={(timezone) =>
                      setBranchDraft((current) => ({ ...current, timezone }))
                    }
                    label="Timezone"
                  />
                  <button
                    type="button"
                    onClick={() => void saveBranch(branch.id)}
                    disabled={saving}
                    style={primaryButton()}
                  >
                    {saving ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Save size={14} />
                    )}{" "}
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditBranch}
                    disabled={saving}
                    style={secondaryButton()}
                  >
                    <X size={14} /> Cancel
                  </button>
                </div>
              );
            }

            return (
              <div
                key={branch.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: localAttendance
                    ? "1fr 1fr 150px 110px auto auto"
                    : "1fr 1fr 160px 120px auto",
                  gap: 10,
                  alignItems: "center",
                  padding: 12,
                  border: `1px solid ${T.border}`,
                  borderRadius: 12,
                  background: T.slate50,
                }}
              >
                <strong style={{ color: T.text, fontSize: 13 }}>
                  {branch.name}
                </strong>
                <span style={{ color: T.textMuted, fontSize: 12 }}>
                  {branch.location || "—"}
                </span>
                <span style={{ color: T.textMuted, fontSize: 11 }}>
                  {branch.timezone || "—"}
                </span>
                <span style={{ color: T.text, fontSize: 12, fontWeight: 800 }}>
                  Capacity: {branch.max_staff_capacity}
                </span>
                {statusChip(branch.fallback_active ? "fallback" : "normal")}
                {localAttendance && (
                  <button
                    type="button"
                    onClick={() => void handleGenerateToken(branch)}
                    disabled={generating || Boolean(editingBranchId)}
                    style={generating ? secondaryButton() : primaryButton()}
                    title="Generate a Local Node install token for this branch"
                  >
                    {generating ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <KeyRound size={14} />
                    )}
                    {generating ? "Generating…" : "Install Token"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => startEditBranch(branch)}
                  disabled={Boolean(editingBranchId)}
                  style={secondaryButton()}
                >
                  <Pencil size={14} /> Edit
                </button>
              </div>
            );
          })}
        </div>
        {localAttendance && (
          <div
            style={{
              marginTop: 10,
              color: T.textMuted,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            Install tokens are branch-scoped, single-use, and generated only
            when clicked. Send the token to the client — they activate the Local
            Node from the Client Dashboard, not from here.
          </div>
        )}
        <div
          style={{
            marginTop: 8,
            color: T.textMuted,
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          Branch capacity can be increased or decreased. The backend only blocks
          a decrease if it would go below the currently active people in that
          branch.
        </div>
      </SectionCard>

      <SectionCard title="Add Branch">
        <div
          style={{
            marginBottom: 12,
            color: limitReached ? T.amber : T.textMuted,
            fontSize: 12,
            fontWeight: 800,
          }}
        >
          Branches: {state.data.length} / {Number(org.max_branches || 0)}
        </div>
        {branchError && (
          <div style={{ marginBottom: 12 }}>
            <ErrorBox message={branchError} />
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 180px auto",
            gap: 10,
            alignItems: "end",
          }}
        >
          <EditField
            label="Branch Name"
            value={draft.name}
            onChange={(name) => setDraft((d) => ({ ...d, name }))}
          />
          <EditField
            label="Location"
            value={draft.location}
            onChange={(location) => setDraft((d) => ({ ...d, location }))}
          />
          <EditField
            label="Capacity"
            type="number"
            value={String(draft.max_staff_capacity)}
            onChange={(value) =>
              setDraft((d) => ({
                ...d,
                max_staff_capacity: Math.min(
                  100000,
                  Math.max(1, Number(value) || 1),
                ),
              }))
            }
          />
          <button
            type="button"
            onClick={() => void createBranch()}
            disabled={limitReached || isSaving}
            style={limitReached ? secondaryButton() : primaryButton()}
          >
            {isSaving ? <Loader2 size={14} /> : <Plus size={14} />} Add
          </button>
        </div>
        {limitReached && (
          <div
            style={{
              marginTop: 10,
              color: T.amber,
              fontSize: 12,
              fontWeight: 800,
            }}
          >
            Branch limit reached. Change max branches in Overview after
            commercial approval. Existing branches are preserved if the limit is
            decreased.
          </div>
        )}
      </SectionCard>
      {token && <InstallTokenModal token={token} onClose={clear} />}
    </div>
  );
}

function BillingTab({
  orgId,
  state,
  setState,
}: {
  orgId: string;
  state: LoadState<Invoice[]>;
  setState: React.Dispatch<React.SetStateAction<LoadState<Invoice[]>>>;
}) {
  const [draft, setDraft] = useState({
    amount: 0,
    due_date: new Date().toISOString().slice(0, 10),
    grace_period_days: 7,
    notes: "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const createInvoice = async () => {
    if (draft.amount <= 0 || !draft.due_date) {
      setError("Amount and due date are required.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const invoice = await invoicesApi.create(orgId, draft);
      setState((current) => ({ ...current, data: [invoice, ...current.data] }));
      setDraft({
        amount: 0,
        due_date: new Date().toISOString().slice(0, 10),
        grace_period_days: 7,
        notes: "",
      });
      setSuccess("Invoice created successfully.");
    } catch (err) {
      setError(extractApiError(err, "Failed to create invoice"));
    } finally {
      setIsSaving(false);
    }
  };

  const markPaid = async (invoiceId: string) => {
    setPayingId(invoiceId);
    setError(null);
    setSuccess(null);
    try {
      const invoice = await invoicesApi.markPaid(
        invoiceId,
        "Marked paid from Support Dashboard.",
      );
      setState((current) => ({
        ...current,
        data: current.data.map((item) =>
          item.id === invoice.id ? invoice : item,
        ),
      }));
      setSuccess("Invoice marked paid successfully.");
    } catch (err) {
      setError(extractApiError(err, "Failed to mark invoice paid"));
    } finally {
      setPayingId(null);
    }
  };

  const updateInvoiceLocal = (updated: Invoice) => {
    setState((current) => ({
      ...current,
      data: current.data.map((item) =>
        item.id === updated.id ? updated : item,
      ),
    }));
  };

  if (state.isLoading) return <LoadingBox label="Loading invoices…" />;
  if (state.error) return <ErrorBox message={state.error} />;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {error && <ErrorBox message={error} />}
      {success && (
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            background: T.green50,
            color: T.green,
            fontSize: 12,
            fontWeight: 900,
          }}
        >
          {success}
        </div>
      )}

      <SectionCard title="Invoices">
        <div style={{ display: "grid", gap: 10 }}>
          {state.data.map((invoice) => (
            <div
              key={invoice.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 135px 120px 115px 120px auto",
                gap: 10,
                alignItems: "center",
                padding: 12,
                border: `1px solid ${T.border}`,
                borderRadius: 12,
                background: T.slate50,
              }}
            >
              <div>
                <strong style={{ color: T.text, fontSize: 13 }}>
                  {formatCurrency(invoice.amount)}
                </strong>
                <div style={{ marginTop: 3, color: T.textMuted, fontSize: 11 }}>
                  {invoice.notes || invoice.invoice_number || "—"}
                </div>
              </div>
              <span style={{ color: T.textMuted, fontSize: 12 }}>
                Due {formatDate(invoice.due_date)}
              </span>
              <span style={{ color: T.textMuted, fontSize: 12 }}>
                Grace {invoice.grace_period_days}d
              </span>
              {statusChip(invoice.status)}
              <span style={{ color: T.textMuted, fontSize: 12 }}>
                {invoice.sent_at
                  ? `Sent ${formatDate(invoice.sent_at)}`
                  : "Not sent"}
              </span>
              <InvoiceActions
                invoice={invoice}
                payingId={payingId}
                onMarkPaid={markPaid}
                onInvoiceUpdated={updateInvoiceLocal}
                onError={(message) => setError(message)}
              />
            </div>
          ))}
          {!state.data.length && (
            <div style={{ color: T.textMuted, fontSize: 13 }}>
              No invoices yet.
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Create Invoice">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "160px 160px 160px 1fr auto",
            gap: 10,
            alignItems: "end",
          }}
        >
          <EditField
            label="Amount"
            type="number"
            value={String(draft.amount)}
            onChange={(amount) =>
              setDraft((d) => ({ ...d, amount: Number(amount) || 0 }))
            }
          />
          <EditField
            label="Due Date"
            type="date"
            value={draft.due_date}
            onChange={(due_date) => setDraft((d) => ({ ...d, due_date }))}
          />
          <EditField
            label="Grace Days"
            type="number"
            value={String(draft.grace_period_days)}
            onChange={(grace_period_days) =>
              setDraft((d) => ({
                ...d,
                grace_period_days: Number(grace_period_days) || 0,
              }))
            }
          />
          <EditField
            label="Notes"
            value={draft.notes}
            onChange={(notes) => setDraft((d) => ({ ...d, notes }))}
          />
          <button
            type="button"
            onClick={() => void createInvoice()}
            disabled={isSaving}
            style={primaryButton()}
          >
            {isSaving ? <Loader2 size={14} /> : <Plus size={14} />} Create
          </button>
        </div>
      </SectionCard>
    </div>
  );
}

function MonitoringTab({ state }: { state: LoadState<NodeHealth[]> }) {
  if (state.isLoading) return <LoadingBox label="Loading node health…" />;
  if (state.error) return <ErrorBox message={state.error} />;
  return (
    <SectionCard title="Node Health">
      <div style={{ display: "grid", gap: 10 }}>
        {state.data.map((node) => (
          <div
            key={node.branch_id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 120px 1fr 140px",
              gap: 10,
              alignItems: "center",
              padding: 12,
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              background: T.slate50,
            }}
          >
            <strong style={{ color: T.text, fontSize: 13 }}>
              {node.branch_name}
            </strong>
            {statusChip(node.status)}
            <span style={{ color: T.textMuted, fontSize: 12 }}>
              {node.node_label || node.hostname || node.node_id || "No node"}
            </span>
            <span style={{ color: T.textMuted, fontSize: 12 }}>
              {node.last_seen_at ? formatDate(node.last_seen_at) : "Never seen"}
            </span>
          </div>
        ))}
        {!state.data.length && (
          <div style={{ color: T.textMuted, fontSize: 13 }}>
            No node data yet.
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function DataAccessTab({
  org,
  onOrgUpdated,
  onDeleted,
}: {
  org: Organization;
  onOrgUpdated: (org: Organization) => void;
  onDeleted: () => void;
}) {
  const [archiveReason, setArchiveReason] = useState(org.archive_reason || "");
  const [deleteReason, setDeleteReason] = useState(org.delete_reason || "");
  const [retentionYears, setRetentionYears] = useState<number>(
    Number(
      org.organization_retention_years || org.employee_retention_years || 5,
    ),
  );
  const [confirmName, setConfirmName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const normalizedStatus = String(org.status || "").toLowerCase();
  const isArchived =
    Boolean(org.archived_at) || normalizedStatus === "archived";
  const isDeleted = Boolean(org.deleted_at) || normalizedStatus === "deleted";
  const isSuspended = normalizedStatus === "suspended";
  const isGracePeriod = normalizedStatus === "grace_period";
  const retentionOptions = [1, 3, 5, 7, 10];

  const [blockingInvoice, setBlockingInvoice] = useState<Invoice | null>(null);
  const [isLoadingInvoice, setIsLoadingInvoice] = useState(false);
  const [isRestoringAccess, setIsRestoringAccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!isSuspended && !isGracePeriod) {
      setBlockingInvoice(null);
      return undefined;
    }
    setIsLoadingInvoice(true);
    invoicesApi
      .list(org.id)
      .then((rows) => {
        if (cancelled) return;
        const latest = [...rows].sort(
          (a, b) =>
            new Date(b.created_at || 0).getTime() -
            new Date(a.created_at || 0).getTime(),
        )[0];
        const stillUnpaid =
          latest &&
          !["paid", "cancelled"].includes(String(latest.status).toLowerCase());
        setBlockingInvoice(stillUnpaid ? latest : null);
      })
      .catch(() => {
        if (!cancelled) setBlockingInvoice(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingInvoice(false);
      });
    return () => {
      cancelled = true;
    };
  }, [org.id, isSuspended, isGracePeriod]);

  const restoreAccessViaInvoice = async () => {
    if (!blockingInvoice) return;
    setIsRestoringAccess(true);
    setError(null);
    setSuccess(null);
    try {
      await invoicesApi.markPaid(
        blockingInvoice.id,
        "Marked paid from Support Dashboard to restore suspended access.",
      );
      const refreshedOrg = await organizationsApi.getById(org.id);
      onOrgUpdated(refreshedOrg);
      setBlockingInvoice(null);
      setSuccess("Invoice marked paid. Organization access restored.");
    } catch (err) {
      setError(extractApiError(err, "Failed to restore access"));
    } finally {
      setIsRestoringAccess(false);
    }
  };

  const runOrgAction = async (
    action: () => Promise<Organization>,
    successMessage: string,
  ) => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await action();
      onOrgUpdated(updated);
      setSuccess(successMessage);
    } catch (err) {
      setError(extractApiError(err, "Organization lifecycle action failed"));
    } finally {
      setIsSaving(false);
    }
  };

  const archiveOrg = () =>
    runOrgAction(
      () =>
        organizationsApi.archive(org.id, {
          reason: archiveReason.trim() || undefined,
          retention_years: retentionYears,
        }),
      "Organization archived. Client dashboard and node sync are blocked while data is retained.",
    );

  const restoreOrg = () =>
    runOrgAction(
      () => organizationsApi.restore(org.id),
      "Organization restored. Access is still controlled by the latest invoice status.",
    );

  const updateRetention = () =>
    runOrgAction(
      () =>
        organizationsApi.updateRetentionPolicy(org.id, {
          retention_years: retentionYears,
        }),
      "Retention policy updated successfully.",
    );

  const requestDelete = () =>
    runOrgAction(
      () =>
        organizationsApi.requestDelete(org.id, {
          reason: deleteReason.trim() || undefined,
        }),
      "Permanent delete request recorded. No data has been deleted yet.",
    );

  const auth = useSupportAuth();
  const isSuperAdmin =
    String(auth.user?.role || "")
      .trim()
      .toLowerCase() === "super_admin";

  const permanentDelete = async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await organizationsApi.permanentlyDelete(org.id, {
        confirm_name: confirmName.trim(),
        reason: deleteReason.trim() || undefined,
      });
      setSuccess("Organization data permanently deleted.");
      onDeleted();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      setError(
        status === 403
          ? "Permanent deletion requires super_admin approval. Use 'Request Delete' above to submit this organization for review."
          : extractApiError(err, "Permanent delete failed"),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {error && <ErrorBox message={error} />}
      {success && (
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            background: T.green50,
            color: T.green,
            fontSize: 12,
            fontWeight: 900,
          }}
        >
          {success}
        </div>
      )}

      <SectionCard title="Access Lifecycle">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 12,
          }}
        >
          <Meta label="Computed Access" value={statusChip(org.status)} />
          <Meta label="Archived At" value={formatDate(org.archived_at)} />
          <Meta
            label="Retention Until"
            value={formatDate(org.retention_until)}
          />
          <Meta
            label="Delete Requested"
            value={formatDate(org.deletion_requested_at)}
          />
        </div>
      </SectionCard>

      {(isSuspended || isGracePeriod) && (
        <SectionCard
          title={isSuspended ? "Suspended Access" : "Billing Grace Period"}
        >
          <p
            style={{
              margin: "0 0 12px",
              color: T.textMuted,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {isSuspended
              ? "This organization's most recent invoice went unpaid past its grace period, so the Client Dashboard and node sync are blocked. Restoring access here marks that invoice paid."
              : "This organization has an unpaid invoice still inside its grace period. Access is currently allowed, but it will be suspended automatically once the deadline passes."}
          </p>

          {isLoadingInvoice ? (
            <div style={{ color: T.textLight, fontSize: 12 }}>
              Loading the blocking invoice…
            </div>
          ) : blockingInvoice ? (
            <>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  alignItems: "center",
                  marginBottom: 12,
                  padding: 10,
                  borderRadius: 10,
                  background: T.slate50,
                  border: `1px solid ${T.border}`,
                }}
              >
                <strong style={{ color: T.text, fontSize: 13 }}>
                  {formatCurrency(blockingInvoice.amount)}
                </strong>
                <span style={{ color: T.textMuted, fontSize: 12 }}>
                  Due {formatDate(blockingInvoice.due_date)}
                </span>
                <span style={{ color: T.textMuted, fontSize: 12 }}>
                  Grace {blockingInvoice.grace_period_days}d
                </span>
                {statusChip(blockingInvoice.status)}
              </div>
              <button
                type="button"
                onClick={() => void restoreAccessViaInvoice()}
                disabled={isRestoringAccess || isDeleted}
                style={{
                  ...secondaryButton(),
                  color: isSuspended ? T.red : T.amber,
                  borderColor: isSuspended ? T.red : T.amber,
                }}
              >
                <RotateCcw size={14} />
                {isRestoringAccess
                  ? "Restoring…"
                  : isSuspended
                    ? "Mark Paid & Restore Access"
                    : "Mark Paid Now"}
              </button>
            </>
          ) : (
            <div style={{ color: T.textLight, fontSize: 12 }}>
              No unpaid invoice found. Refresh the organization — access may
              already be restored.
            </div>
          )}
        </SectionCard>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 16,
        }}
      >
        <SectionCard title="Archive Organization">
          <p
            style={{
              margin: "0 0 12px",
              color: T.textMuted,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            Archive blocks client dashboard access and node sync without
            deleting tenant data.
          </p>
          <label>
            <span style={labelStyle}>Archive Reason</span>
            <textarea
              value={archiveReason}
              onChange={(event) => setArchiveReason(event.target.value)}
              disabled={isDeleted}
              style={{
                ...inputStyle,
                minHeight: 86,
                paddingTop: 10,
                resize: "vertical",
              }}
            />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            {isArchived ? (
              <button
                type="button"
                onClick={() => void restoreOrg()}
                disabled={isSaving || isDeleted}
                style={secondaryButton()}
              >
                <RotateCcw size={14} /> Restore
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void archiveOrg()}
                disabled={isSaving || isDeleted}
                style={secondaryButton()}
              >
                <Archive size={14} /> Archive
              </button>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Retention Policy">
          <p
            style={{
              margin: "0 0 12px",
              color: T.textMuted,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            Choose how long archived organization data should be retained before
            cleanup review.
          </p>
          <label>
            <span style={labelStyle}>Retention Years</span>
            <select
              value={retentionYears}
              onChange={(event) =>
                setRetentionYears(Number(event.target.value))
              }
              disabled={isDeleted}
              style={inputStyle}
            >
              {retentionOptions.map((years) => (
                <option key={years} value={years}>
                  {years} year{years !== 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void updateRetention()}
            disabled={isSaving || isDeleted}
            style={{ ...primaryButton(), marginTop: 12 }}
          >
            <Save size={14} /> Save Retention
          </button>
        </SectionCard>
      </div>

      <section
        style={{
          border: `1px solid ${T.red}`,
          borderRadius: 16,
          background: T.red50,
          padding: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            marginBottom: 14,
          }}
        >
          <ShieldAlert size={18} color={T.red} />
          <div>
            <h3
              style={{ margin: 0, color: T.red, fontSize: 15, fontWeight: 900 }}
            >
              Danger Zone
            </h3>
            <p
              style={{
                margin: "4px 0 0",
                color: T.textMuted,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Permanent delete removes tenant-owned rows from the database and
              cannot be undone. Use archive first unless a real deletion is
              approved.
            </p>
          </div>
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
        >
          <label>
            <span style={labelStyle}>Delete Reason</span>
            <textarea
              value={deleteReason}
              onChange={(event) => setDeleteReason(event.target.value)}
              disabled={isDeleted}
              style={{
                ...inputStyle,
                minHeight: 88,
                paddingTop: 10,
                resize: "vertical",
              }}
            />
          </label>
          {org.deletion_requested_at && (
            <div
              style={{
                gridColumn: "1 / -1",
                padding: 12,
                borderRadius: 10,
                background: T.amber50,
                border: `1px solid ${T.amber}`,
                fontSize: 12,
                color: T.textBody,
              }}
            >
              <div style={{ fontWeight: 900, marginBottom: 6 }}>
                Deletion requested — pending super_admin review
              </div>
              <div>Requested: {formatDate(org.deletion_requested_at)}</div>
              <div>
                Requested by:{" "}
                {org.deletion_requested_by_name ||
                  org.deletion_requested_by ||
                  "—"}
              </div>
              <div style={{ marginTop: 6 }}>
                Reason: {org.delete_reason || "No reason given"}
              </div>
            </div>
          )}
          <label>
            <span style={labelStyle}>
              Type organization name to permanently delete
            </span>
            <input
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              placeholder={org.name}
              disabled={isDeleted}
              style={inputStyle}
            />
            <span
              style={{
                display: "block",
                marginTop: 6,
                color: T.textMuted,
                fontSize: 11,
              }}
            >
              Exact required text: <strong>{org.name}</strong>
            </span>
          </label>
        </div>

        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}
        >
          <button
            type="button"
            onClick={() => void requestDelete()}
            disabled={isSaving || isDeleted}
            style={secondaryButton()}
          >
            <ShieldAlert size={14} /> Request Delete
          </button>
          <button
            type="button"
            onClick={() => void permanentDelete()}
            disabled={
              !isSuperAdmin ||
              isSaving ||
              isDeleted ||
              confirmName.trim() !== org.name
            }
            title={
              !isSuperAdmin
                ? "Permanent delete is restricted to super_admin. Use Request Delete instead."
                : undefined
            }
            style={{
              ...secondaryButton(),
              borderColor: T.red,
              color: T.red,
              opacity:
                !isSuperAdmin ||
                isSaving ||
                isDeleted ||
                confirmName.trim() !== org.name
                  ? 0.55
                  : 1,
            }}
          >
            {isSaving ? <Loader2 size={14} /> : <Trash2 size={14} />}
            Permanent Delete
          </button>
          {!isSuperAdmin && (
            <span
              style={{
                display: "block",
                width: "100%",
                marginTop: 8,
                color: T.textMuted,
                fontSize: 11,
              }}
            >
              Permanent delete is restricted to super_admin. Use{" "}
              <strong>Request Delete</strong> to submit this organization for
              review.
            </span>
          )}
        </div>
      </section>
    </div>
  );
}

function InviteTab({ org }: { org: Organization }) {
  const [email, setEmail] = useState(org.contact_email || "");
  const [fullName, setFullName] = useState(`${org.name} Admin`);
  // client_users is admin-only — there is no HR/co-admin invite tier
  // anymore. Any narrower, per-person access is a client_staff row managed
  // from that org's own Staff Management module picker, not something
  // Support provisions here.
  const [invite, setInvite] = useState<Awaited<
    ReturnType<typeof organizationsApi.inviteClient>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const message = useMemo(() => {
    if (!invite) return "";
    if (invite.message?.trim()) return invite.message.trim();
    if (invite.invite_message?.trim()) return invite.invite_message.trim();
    return [
      `Dear ${invite.full_name || "Client"},`,
      "",
      "Welcome to QIntellect AttendAI.",
      "",
      "Your organization dashboard has been created according to the agreed setup and commercial configuration.",
      "",
      "Login Details",
      `Dashboard URL: ${invite.login_url}`,
      `Email: ${invite.email}`,
      `Temporary Password: ${invite.temporary_password}`,
      "",
      "For security, please change your password after your first login.",
      "",
      `Organization Name: ${org.name}`,
      "",
      "Regards,",
      "QIntellect Support Team",
    ].join("\n");
  }, [invite, org.name]);

  const createInvite = async () => {
    setIsSaving(true);
    setError(null);
    setInvite(null);
    try {
      const createdInvite = await organizationsApi.inviteClient(org.id, {
        email: email.trim(),
        full_name: fullName.trim(),
      });
      setInvite(createdInvite);
    } catch (err) {
      setError(extractApiError(err, "Failed to create invite"));
    } finally {
      setIsSaving(false);
    }
  };

  const copyInvite = async () => {
    if (!message) return;
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      // Dev browsers may block clipboard. User can still copy from textarea.
    }
  };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <SectionCard title="Invite Client Admin">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr auto",
            gap: 10,
            alignItems: "end",
          }}
        >
          <EditField label="Email" value={email} onChange={setEmail} />
          <EditField
            label="Full Name"
            value={fullName}
            onChange={setFullName}
          />
          <button
            type="button"
            onClick={() => void createInvite()}
            disabled={isSaving || !email.trim() || !fullName.trim()}
            style={primaryButton()}
          >
            {isSaving ? <Loader2 size={14} /> : <UserPlus size={14} />} Create
          </button>
        </div>
        {error && (
          <div style={{ marginTop: 12 }}>
            <ErrorBox message={error} />
          </div>
        )}
      </SectionCard>

      {invite && (
        <SectionCard title="Generated Invite Message">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              gap: "10px 0",
              marginBottom: 12,
            }}
          >
            <strong style={labelStyle}>Login URL</strong>
            <span style={{ color: T.text, fontSize: 12, fontWeight: 800 }}>
              {invite.login_url}
            </span>
            <strong style={labelStyle}>Email</strong>
            <span style={{ color: T.text, fontSize: 12, fontWeight: 800 }}>
              {invite.email}
            </span>
            <strong style={labelStyle}>Temporary Password</strong>
            <code
              style={{ color: T.textHeading, fontSize: 12, fontWeight: 900 }}
            >
              {invite.temporary_password}
            </code>
          </div>
          <textarea
            readOnly
            value={message}
            style={{
              width: "100%",
              minHeight: 380,
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              padding: 12,
              color: T.text,
              fontSize: 12,
              lineHeight: 1.55,
              boxSizing: "border-box",
              background: T.slate50,
              marginBottom: 10,
            }}
          />
          <button
            type="button"
            onClick={() => void copyInvite()}
            style={secondaryButton()}
          >
            <CheckCircle2 size={14} /> Copy Invite Text
          </button>
        </SectionCard>
      )}
    </div>
  );
}

export default function OrgDetail() {
  // Billing may read an organization (an invoice is meaningless without
  // knowing whose it is) but not its structural or lifecycle config. The
  // backend enforces this per-route via require_capability; hiding the tabs
  // just stops a billing user walking into a 403.
  const auth = useSupportAuth();
  const isSuperAdmin =
    String(auth.user?.role || "")
      .trim()
      .toLowerCase() === "super_admin";
  const visibleTabs = useMemo(
    () =>
      isSuperAdmin
        ? TABS
        : TABS.filter((tab) => tab.key === "overview" || tab.key === "billing"),
    [isSuperAdmin],
  );

  const params = useParams<{ orgId?: string; id?: string }>();
  const navigate = useNavigate();
  const orgId = String(params.orgId || params.id || "");

  const [org, setOrg] = useState<Organization | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [isLoadingOrg, setIsLoadingOrg] = useState(true);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [modules, setModules] = useState<LoadState<OrganizationModule[]>>(
    emptyState([]),
  );
  const [branches, setBranches] = useState<LoadState<Branch[]>>(emptyState([]));
  const [invoices, setInvoices] = useState<LoadState<Invoice[]>>(
    emptyState([]),
  );
  const [nodeHealth, setNodeHealth] = useState<LoadState<NodeHealth[]>>(
    emptyState([]),
  );

  const loadOrg = useCallback(async () => {
    if (!orgId) return;
    setIsLoadingOrg(true);
    setOrgError(null);
    try {
      setOrg(await organizationsApi.getById(orgId));
    } catch (err) {
      setOrgError(extractApiError(err, "Failed to load organization"));
    } finally {
      setIsLoadingOrg(false);
    }
  }, [orgId]);

  useEffect(() => {
    void loadOrg();
  }, [loadOrg]);

  // A billing user deep-linking to ?tab=branches would otherwise render a
  // tab their token can't load.
  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.key === activeTab)) {
      setActiveTab("overview");
    }
  }, [visibleTabs, activeTab]);

  useEffect(() => {
    if (!orgId) return;
    if (activeTab === "modules" && !modules.loaded && !modules.isLoading) {
      setModules((s) => ({ ...s, isLoading: true, error: null }));
      modulesApi
        .list(orgId)
        .then((data) =>
          setModules({ data, isLoading: false, error: null, loaded: true }),
        )
        .catch((err) =>
          setModules((s) => ({
            ...s,
            isLoading: false,
            error: extractApiError(err, "Failed to load modules"),
            loaded: true,
          })),
        );
    }
    if (
      (activeTab === "branches" || activeTab === "modules") &&
      !branches.loaded &&
      !branches.isLoading
    ) {
      setBranches((s) => ({ ...s, isLoading: true, error: null }));
      branchesApi
        .list(orgId)
        .then((data) =>
          setBranches({ data, isLoading: false, error: null, loaded: true }),
        )
        .catch((err) =>
          setBranches((s) => ({
            ...s,
            isLoading: false,
            error: extractApiError(err, "Failed to load branches"),
            loaded: true,
          })),
        );
    }
    if (activeTab === "billing" && !invoices.loaded && !invoices.isLoading) {
      setInvoices((s) => ({ ...s, isLoading: true, error: null }));
      invoicesApi
        .list(orgId)
        .then((data) =>
          setInvoices({ data, isLoading: false, error: null, loaded: true }),
        )
        .catch((err) =>
          setInvoices((s) => ({
            ...s,
            isLoading: false,
            error: extractApiError(err, "Failed to load invoices"),
            loaded: true,
          })),
        );
    }
    if (
      activeTab === "monitoring" &&
      !nodeHealth.loaded &&
      !nodeHealth.isLoading
    ) {
      setNodeHealth((s) => ({ ...s, isLoading: true, error: null }));
      nodeHealthApi
        .list(orgId)
        .then((data) =>
          setNodeHealth({ data, isLoading: false, error: null, loaded: true }),
        )
        .catch((err) =>
          setNodeHealth((s) => ({
            ...s,
            isLoading: false,
            error: extractApiError(err, "Failed to load node health"),
            loaded: true,
          })),
        );
    }
  }, [
    activeTab,
    orgId,
    modules.loaded,
    modules.isLoading,
    branches.loaded,
    branches.isLoading,
    invoices.loaded,
    invoices.isLoading,
    nodeHealth.loaded,
    nodeHealth.isLoading,
  ]);

  if (isLoadingOrg)
    return (
      <div style={{ minHeight: "70vh", background: T.bgPage }}>
        <LoadingBox label="Loading organization…" />
      </div>
    );
  if (orgError || !org)
    return (
      <div style={{ padding: 24, background: T.bgPage }}>
        <ErrorBox message={orgError || "Organization not found"} />
      </div>
    );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bgPage,
        padding: 24,
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      <style>{`.spin{animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div
        style={{ maxWidth: 1240, margin: "0 auto", display: "grid", gap: 16 }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button
              type="button"
              onClick={() => navigate(-1)}
              style={secondaryButton()}
            >
              <ArrowLeft size={16} /> Back
            </button>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 15,
                background: T.teal50,
                color: T.teal600,
                display: "grid",
                placeItems: "center",
              }}
            >
              <Building2 size={22} />
            </div>
            <div>
              <h1
                style={{
                  margin: 0,
                  color: T.textHeading,
                  fontSize: 24,
                  fontWeight: 900,
                }}
              >
                {org.name}
              </h1>
              <p
                style={{
                  margin: "4px 0 0",
                  color: T.textMuted,
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {org.contact_email} ·{" "}
                {String(org.attendance_mode).toUpperCase()} mode ·{" "}
                {org.max_branches} branch limit · {statusChip(org.status)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadOrg()}
            style={secondaryButton()}
          >
            <RefreshCw size={15} /> Refresh Org
          </button>
        </div>

        {(() => {
          const normalizedStatus = String(org.status || "").toLowerCase();
          if (
            normalizedStatus !== "suspended" &&
            normalizedStatus !== "grace_period"
          ) {
            return null;
          }
          const isSuspended = normalizedStatus === "suspended";
          return (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                padding: "12px 16px",
                borderRadius: 14,
                background: isSuspended ? T.red50 : T.amber50,
                border: `1px solid ${isSuspended ? T.red : T.amber}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <ShieldAlert size={18} color={isSuspended ? T.red : T.amber} />
                <div>
                  <div
                    style={{
                      color: isSuspended ? T.red : T.amber,
                      fontSize: 12,
                      fontWeight: 900,
                    }}
                  >
                    {isSuspended
                      ? "Organization access is suspended"
                      : "Organization is in its billing grace period"}
                  </div>
                  <div
                    style={{ color: T.textMuted, fontSize: 11, marginTop: 2 }}
                  >
                    {isSuspended
                      ? "An invoice is unpaid past its grace period, so the Client Dashboard and node sync are blocked. Mark the overdue invoice paid in Billing to restore access."
                      : "An invoice is unpaid but still within its grace period. Access will be suspended automatically if it isn't paid before the deadline."}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("billing")}
                style={{
                  ...primaryButton(),
                  background: isSuspended ? T.red : T.amber,
                }}
              >
                <RotateCcw size={14} />
                {isSuspended ? "Restore Access" : "Review Invoice"}
              </button>
            </div>
          );
        })()}

        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            background: T.bgCard,
            border: `1px solid ${T.border}`,
            borderRadius: 16,
            padding: 8,
          }}
        >
          {visibleTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              style={{
                height: 36,
                border: "none",
                borderRadius: 11,
                background: activeTab === tab.key ? T.teal600 : "transparent",
                color: activeTab === tab.key ? "white" : T.textMuted,
                fontSize: 12,
                fontWeight: 900,
                padding: "0 14px",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "overview" && (
          <OverviewTab
            org={org}
            onOrgUpdated={setOrg}
            branchesState={branches}
            setBranchesState={setBranches}
          />
        )}
        {activeTab === "modules" && (
          <ModulesTab
            orgId={org.id}
            org={org}
            branches={branches.data}
            state={modules}
            setState={setModules}
          />
        )}
        {activeTab === "branches" && (
          <BranchesTab org={org} state={branches} setState={setBranches} />
        )}
        {activeTab === "billing" && (
          <BillingTab orgId={org.id} state={invoices} setState={setInvoices} />
        )}
        {activeTab === "monitoring" && <MonitoringTab state={nodeHealth} />}
        {activeTab === "data_access" && (
          <DataAccessTab
            org={org}
            onOrgUpdated={setOrg}
            onDeleted={() => navigate("/support/organizations")}
          />
        )}
        {activeTab === "invite" && <InviteTab org={org} />}
      </div>
    </div>
  );
}
