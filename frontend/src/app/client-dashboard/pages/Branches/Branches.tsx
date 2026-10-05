/**
 * modules/branches/index.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Global Branches page backed by Flask.
 *
 * This page is admin-only from routes.tsx. It reads live branch metrics from
 * /api/branches/summary instead of deriving business metrics from dummy data.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  Building2,
  CalendarClock,
  CheckCircle2,
  DollarSign,
  Download,
  MapPin,
  RefreshCcw,
  Users,
} from "lucide-react";
import { isModuleEnabled } from "../../utils/moduleAccess";
import { T } from "../../components/ui/theme";
import { useAuth } from "../../contexts/useAuth";
import { useOrg } from "../../contexts/OrgConfigContext";
import BranchCompareChart from "./BranchCompareChart";
import JellyButton from "../../components/ui/JellyButton";
import ModernSelect from "../../components/ui/ModernSelect";
import RefreshButton from "../../components/ui/RefreshButton";
import {
  fetchBranchSummary,
  type BranchSummaryResponse,
  type BranchSummaryRow,
} from "./api/branchApi";
import { downloadClientNodeInstaller } from "./api/clientNodeInstallerApi";
import { resolveTemplateRenderingModel } from "../../utils/templateColumns";
import {
  peopleLabelForType,
  resolveActivePeopleTypes,
  resolveModulePeopleTypes,
} from "../../utils/templateRendering";

type AuthUserLike = {
  id?: number | string;
  organization_id?: number | string | null;
  organizationId?: number | string | null;
  organizationStatus?: string | null;
  organization_status?: string | null;
  allowedModules?: string[] | string | null;
  accessModules?: string[] | string | null;
  access_modules?: string[] | string | null;
};

type BranchRowWithAliases = BranchSummaryRow & {
  branch_id?: number | string | null;
  branchId?: number | string | null;
  id?: number | string | null;
  name?: string | null;
  branchName?: string | null;
};

type TemplateModel = ReturnType<typeof resolveTemplateRenderingModel>;

function toPositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toTenantId(value: unknown): string {
  const text = String(value ?? "").trim();
  return text && text !== "null" && text !== "undefined" ? text : "";
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item).trim().toLowerCase())
          .filter(Boolean);
      }
    } catch {
      return value
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return [];
}

function hasModule(modules: string[], key: string): boolean {
  const normalized = key.toLowerCase();
  return modules.some(
    (item) => item.replace(/[_-]/g, "") === normalized.replace(/[_-]/g, ""),
  );
}

function getBackendBranchId(branch: BranchSummaryRow): string {
  const row = branch as BranchRowWithAliases & {
    backendBranchId?: string | null;
    backend_branch_id?: string | null;
    branchUuid?: string | null;
    branch_uuid?: string | null;
  };
  return toTenantId(
    row.backendBranchId ??
      row.backend_branch_id ??
      row.branchUuid ??
      row.branch_uuid ??
      row.branch_id ??
      row.branchId ??
      row.id,
  );
}

function getBranchLocation(branch: BranchSummaryRow): string {
  const row = branch as BranchRowWithAliases;
  return String(row.branchCity ?? row.city ?? "");
}

function getBranchDashboardId(branch: BranchSummaryRow): number | null {
  const row = branch as BranchRowWithAliases;
  return toPositiveNumber(row.branchId ?? row.id ?? row.branch_id);
}

function getBranchDashboardPath(branch: BranchSummaryRow): string | null {
  const branchId = getBranchDashboardId(branch);
  return branchId ? `/admin/branch/${branchId}` : null;
}

function getBranchDisplayName(branch: BranchSummaryRow): string {
  const row = branch as BranchRowWithAliases;
  return String(row.branchName ?? row.name ?? "Branch");
}

function formatMoney(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readTemplateLabel(
  model: TemplateModel,
  key: string,
  fallback: string,
): string {
  const labels = asRecord(asRecord(model).labels);
  const value = labels[key];

  return typeof value === "string" && value.trim() ? value : fallback;
}

function templateItemKeys(items: unknown): string[] {
  if (!Array.isArray(items)) return [];

  return items
    .flatMap((item) => {
      const record = asRecord(item);
      return [record.key, record.dataKey, record.field, record.name];
    })
    .map((item) =>
      String(item ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}

function templateFeatureEnabled(
  model: TemplateModel,
  featureKey: string,
): boolean | null {
  const features = asRecord(asRecord(model).features);
  const value = features[featureKey];

  if (typeof value === "boolean") return value;

  return null;
}

function templateSupportsPayroll(model: TemplateModel): boolean {
  const explicit =
    templateFeatureEnabled(model, "payroll") ??
    templateFeatureEnabled(model, "salary") ??
    templateFeatureEnabled(model, "compensation");

  if (explicit !== null) return explicit;

  const record = asRecord(model);
  const keys = new Set([
    ...templateItemKeys(record.peopleColumns),
    ...templateItemKeys(record.formFields),
  ]);

  return [
    "salary",
    "payroll",
    "compensation",
    "basicsalary",
    "basic_salary",
    "benefits",
  ].some((key) => keys.has(key));
}

function templateSupportsBiometrics(model: TemplateModel): boolean {
  const explicit =
    templateFeatureEnabled(model, "biometrics") ??
    templateFeatureEnabled(model, "media") ??
    templateFeatureEnabled(model, "attendanceMedia");

  if (explicit !== null) return explicit;

  return true;
}

function lowerLabel(value: string): string {
  return value.trim().toLowerCase();
}

function pluralCountLabel(
  count: number,
  singular: string,
  plural: string,
): string {
  return count === 1 ? singular : plural;
}

const BRANCH_SUMMARY_CACHE_PREFIX = "branchSummary:";

function branchSummaryCacheKey(orgId: string, peopleType: string): string {
  const normalizedPeopleType = peopleType?.trim() || "staff";
  return `${BRANCH_SUMMARY_CACHE_PREFIX}${orgId}:${normalizedPeopleType}`;
}

function readCachedBranchSummary(
  orgId: string,
  peopleType: string,
): BranchSummaryResponse | null {
  if (!orgId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(
      branchSummaryCacheKey(orgId, peopleType),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BranchSummaryResponse;
    return parsed?.branches ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedBranchSummary(
  orgId: string,
  summary: BranchSummaryResponse,
  peopleType: string,
): void {
  if (!orgId || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      branchSummaryCacheKey(orgId, peopleType),
      JSON.stringify(summary),
    );
  } catch {
    // Ignore storage errors. Cache is only for instant paint.
  }
}

function statCard(
  label: string,
  value: React.ReactNode,
  sub: string,
  Icon: React.ElementType,
  tone: "blue" | "green" | "amber" | "red" | "teal" = "teal",
): React.ReactNode {
  const tones = {
    blue: { bg: "#E0F2FE", fg: "#0369A1" },
    green: { bg: "#DCFCE7", fg: "#16A34A" },
    amber: { bg: "#FEF3C7", fg: "#D97706" },
    red: { bg: "#FFE4E6", fg: "#E11D48" },
    teal: { bg: T.teal50, fg: T.teal600 },
  }[tone];

  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        padding: 18,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        minHeight: 96,
      }}
    >
      <div>
        <div style={{ fontSize: 12, color: T.muted, fontWeight: 700 }}>
          {label}
        </div>
        <div
          style={{
            fontSize: 26,
            fontWeight: 900,
            color: T.navy600,
            marginTop: 6,
          }}
        >
          {value}
        </div>
        <div style={{ fontSize: 12, color: tones.fg, marginTop: 4 }}>{sub}</div>
      </div>

      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: tones.bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon size={21} color={tones.fg} />
      </div>
    </div>
  );
}

const BranchesModule: React.FC = () => {
  const { user: rawUser } = useAuth() as { user?: AuthUserLike | null };
  const { organizationId, cfg } = useOrg();

  const activePeopleTypes = useMemo(
    () => resolveActivePeopleTypes(cfg as unknown as Record<string, unknown>),
    [cfg],
  );

  const defaultPeopleType = useMemo(
    () =>
      activePeopleTypes.includes("staff")
        ? "staff"
        : (activePeopleTypes[0] ?? "staff"),
    [activePeopleTypes],
  );

  const [selectedPeopleType, setSelectedPeopleType] = useState(
    () => defaultPeopleType,
  );

  useEffect(() => {
    if (!activePeopleTypes.includes(selectedPeopleType)) {
      setSelectedPeopleType(defaultPeopleType);
    }
  }, [activePeopleTypes, defaultPeopleType, selectedPeopleType]);

  const templateModel = useMemo(
    () =>
      resolveTemplateRenderingModel(
        cfg as unknown as Record<string, unknown>,
        selectedPeopleType,
      ),
    [cfg, selectedPeopleType],
  );

  const peopleSingular = readTemplateLabel(templateModel, "singular", "Staff");
  const peoplePlural = readTemplateLabel(templateModel, "plural", "Staff");
  const branchSingular = readTemplateLabel(templateModel, "branch", "Branch");
  const branchPlural = readTemplateLabel(
    templateModel,
    "branchPlural",
    `${branchSingular}es`,
  );

  const payrollPeopleTypes = useMemo(
    () => resolveModulePeopleTypes(cfg, "payroll", null),
    [cfg],
  );
  const showPayroll =
    templateModel.features.payroll &&
    payrollPeopleTypes.includes(selectedPeopleType);
  const showBiometrics = templateModel.features.media;

  const user = rawUser ?? null;
  const resolvedOrgId =
    toTenantId(organizationId) ||
    toTenantId(user?.organization_id) ||
    toTenantId(user?.organizationId);

  const [summary, setSummary] = useState<BranchSummaryResponse | null>(() =>
    readCachedBranchSummary(resolvedOrgId, selectedPeopleType),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>("");
  const [installerError, setInstallerError] = useState<string>("");
  const [downloadingBranchId, setDownloadingBranchId] = useState<string>("");

  useEffect(() => {
    setSummary(readCachedBranchSummary(resolvedOrgId, selectedPeopleType));
  }, [resolvedOrgId, selectedPeopleType]);

  const load = useCallback(async () => {
    if (!resolvedOrgId) {
      setSummary(null);
      setError("Organization is not loaded yet.");
      return;
    }

    try {
      setRefreshing(true);
      setError("");
      const result = await fetchBranchSummary({
        organizationId: resolvedOrgId,
        userId: user?.id ?? null,
        peopleType: selectedPeopleType,
      });
      writeCachedBranchSummary(resolvedOrgId, result, selectedPeopleType);
      setSummary(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load branch summary.",
      );
    } finally {
      setRefreshing(false);
    }
  }, [resolvedOrgId, selectedPeopleType, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handler = () => {
      void load();
    };
    window.addEventListener("orgDataChanged", handler);
    return () => window.removeEventListener("orgDataChanged", handler);
  }, [load]);

  const attendanceModuleEnabled = useMemo(
    () => isModuleEnabled(cfg.modules, "attendance"),
    [cfg.modules],
  );

  const organizationStatus = String(
    user?.organizationStatus ?? user?.organization_status ?? "active",
  ).toLowerCase();
  const isLocalAttendance =
    String(cfg.attendanceMode ?? cfg.attendance_mode ?? "")
      .trim()
      .toLowerCase() === "local";
  const organizationAllowsInstaller = ["active", "grace_period"].includes(
    organizationStatus,
  );
  const showInstallerAction = isLocalAttendance && organizationAllowsInstaller;
  const installerDisabledReason = !isLocalAttendance
    ? "Installer is available only for local attendance mode."
    : !organizationAllowsInstaller
      ? "Installer is blocked because organization access is not active."
      : !attendanceModuleEnabled
        ? "Attendance module is not active for this organization."
        : "";
  const installerEligible = showInstallerAction && attendanceModuleEnabled;

  const handleDownloadInstaller = useCallback(
    async (branch: BranchSummaryRow) => {
      const backendBranchId = getBackendBranchId(branch);
      if (!backendBranchId || !user?.id || !installerEligible) return;

      setInstallerError("");
      setDownloadingBranchId(backendBranchId);
      try {
        await downloadClientNodeInstaller({
          branchId: backendBranchId,
          userId: user.id,
          nodeLabel: `${cfg.orgName || "QIntellect"} - ${getBranchDisplayName(branch)}`,
          ttlDays: 7,
          packageType: "exe",
        });
      } catch (err) {
        setInstallerError(
          err instanceof Error
            ? err.message
            : "Failed to download node installer.",
        );
      } finally {
        setDownloadingBranchId("");
      }
    },
    [cfg.orgName, installerEligible, user?.id],
  );

  const branches = useMemo<BranchSummaryRow[]>(() => {
    if (summary?.branches) return summary.branches;

    // Very small UI fallback while backend is still loading.
    return cfg.branches.map((branch) => ({
      id: Number(branch.id),
      branchId: Number(branch.id),
      backendBranchId:
        (branch as { backendBranchId?: string; backend_branch_id?: string })
          .backendBranchId ??
        (branch as { backendBranchId?: string; backend_branch_id?: string })
          .backend_branch_id ??
        undefined,
      backend_branch_id:
        (branch as { backendBranchId?: string; backend_branch_id?: string })
          .backendBranchId ??
        (branch as { backendBranchId?: string; backend_branch_id?: string })
          .backend_branch_id ??
        undefined,
      name: branch.name,
      branchName: branch.name,
      city: branch.city ?? "",
      branchCity: branch.city ?? "",
      staff: 0,
      staffCount: 0,
      activeStaff: 0,
      enrolledStaff: 0,
      presentToday: 0,
      absentToday: 0,
      attendance: 0,
      attendanceRate: 0,
      payroll: 0,
      revenue: 0,
      late: 0,
      lateCount: 0,
      pendingLeaves: 0,
      overtimeHours: 0,
    }));
  }, [cfg.branches, summary?.branches]);

  const totals = summary?.totals ?? {
    branches: branches.length,
    staff: 0,
    activeStaff: 0,
    enrolledStaff: 0,
    presentToday: 0,
    absentToday: 0,
    payroll: 0,
    late: 0,
    pendingLeaves: 0,
    overtimeHours: 0,
    attendanceRate: 0,
  };

  const descriptionItems = useMemo(
    () => [
      `${lowerLabel(peoplePlural)} coverage`,
      "attendance",
      ...(showPayroll ? ["payroll"] : []),
      "lateness",
      "leaves",
      "overtime",
    ],
    [peoplePlural, showPayroll],
  );

  const tableGridTemplate = useMemo(
    () =>
      [
        "1.35fr",
        ".9fr",
        ".8fr",
        ".9fr",
        ...(showPayroll ? [".9fr"] : []),
        ".8fr",
        ...(showBiometrics ? [".9fr"] : []),
        "210px",
      ].join(" "),
    [showBiometrics, showPayroll],
  );

  const tableMinWidth = showPayroll || showBiometrics ? 980 : 820;

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ margin: 0, color: T.head, fontSize: 24 }}>
            {branchPlural}
          </h2>
          <div style={{ color: T.muted, fontSize: 13, marginTop: 4 }}>
            Backend-connected branch comparison, {descriptionItems.join(", ")}.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {activePeopleTypes.length > 1 ? (
            <ModernSelect
              value={selectedPeopleType}
              options={activePeopleTypes.map((type) => ({
                value: type,
                label: peopleLabelForType(type, cfg as any).plural,
              }))}
              onChange={(value) => setSelectedPeopleType(value)}
              ariaLabel="People type"
              minWidth={160}
            />
          ) : null}
          <RefreshButton
            variant="secondary"
            size="md"
            loading={refreshing}
            onClick={() => void load()}
          />
        </div>
      </div>

      {(error || installerError) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 14,
            borderRadius: 12,
            background: "#FFF1F2",
            border: "1px solid #FECDD3",
            color: "#BE123C",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          <AlertCircle size={17} />
          {error || installerError}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: showPayroll
            ? "repeat(4, minmax(180px, 1fr))"
            : "repeat(3, minmax(180px, 1fr))",
          gap: 14,
        }}
      >
        {statCard(
          `Total ${branchPlural}`,
          totals.branches,
          "Configured locations",
          Building2,
          "teal",
        )}
        {statCard(
          `Total ${peoplePlural}`,
          totals.staff,
          `${totals.activeStaff} active ${lowerLabel(
            pluralCountLabel(totals.activeStaff, peopleSingular, peoplePlural),
          )}`,
          Users,
          "blue",
        )}
        {statCard(
          "Attendance Today",
          `${Math.round(totals.attendanceRate)}%`,
          `${totals.presentToday} present · ${totals.absentToday} absent`,
          Activity,
          "green",
        )}
        {showPayroll &&
          statCard(
            "Monthly Payroll",
            formatMoney(totals.payroll),
            `Across all ${lowerLabel(branchPlural)}`,
            DollarSign,
            "amber",
          )}
      </div>

      <section
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          padding: 18,
          overflow: "hidden",
        }}
      >
        <BranchCompareChart
          branches={branches}
          templateModel={templateModel}
          showPayroll={showPayroll}
        />
      </section>

      <section
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "16px 18px",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: T.head }}>
              {branchSingular} Directory
            </div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
              Click a branch to open its scoped dashboard. Local-mode branches
              can download the Windows node installer.
            </div>
          </div>
          <div style={{ fontSize: 12, color: T.muted }}>
            {branches.length}{" "}
            {lowerLabel(
              pluralCountLabel(branches.length, branchSingular, branchPlural),
            )}
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: tableGridTemplate,
              minWidth: tableMinWidth,
              padding: "10px 18px",
              background: T.teal50,
              borderBottom: `1px solid ${T.border}`,
              fontSize: 10,
              fontWeight: 900,
              color: T.muted,
              textTransform: "uppercase",
              letterSpacing: ".08em",
            }}
          >
            <div>{branchSingular}</div>
            <div>{peoplePlural}</div>
            <div>Attendance</div>
            <div>Present</div>
            {showPayroll && <div>Payroll</div>}
            <div>Late</div>
            {showBiometrics && <div>Biometrics</div>}
            <div>Action</div>
          </div>

          {branches.map((branch, index) => {
            const branchDashboardId = getBranchDashboardId(branch);
            const branchDashboardPath = getBranchDashboardPath(branch);
            const branchName = getBranchDisplayName(branch);

            return (
              <div
                key={branchDashboardId ?? `${branchName}-${index}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: tableGridTemplate,
                  minWidth: tableMinWidth,
                  padding: "13px 18px",
                  borderBottom: `1px solid ${T.teal50}`,
                  alignItems: "center",
                  fontSize: 12,
                  color: T.head,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      background: T.teal50,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <MapPin size={16} color={T.teal600} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 900, color: T.head }}>
                      {getBranchDisplayName(branch)}
                    </div>
                    <div style={{ color: T.muted, fontSize: 11, marginTop: 2 }}>
                      {getBranchLocation(branch) || "No city set"}
                    </div>
                  </div>
                </div>
                <div>
                  <strong>{branch.staffCount}</strong>
                  <span style={{ color: T.muted }}>
                    {" "}
                    {lowerLabel(
                      pluralCountLabel(
                        branch.staffCount,
                        peopleSingular,
                        peoplePlural,
                      ),
                    )}
                  </span>
                </div>
                <div style={{ fontWeight: 900, color: T.teal600 }}>
                  {Math.round(branch.attendanceRate)}%
                </div>
                <div>
                  <strong>{branch.presentToday}</strong>
                  <span style={{ color: T.muted }}> / {branch.staffCount}</span>
                </div>
                {showPayroll && (
                  <div style={{ fontWeight: 900, color: T.navy600 }}>
                    {formatMoney(branch.payroll)}
                  </div>
                )}
                <div style={{ color: branch.lateCount ? "#D97706" : T.muted }}>
                  {branch.lateCount}
                </div>
                {showBiometrics && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      color:
                        branch.staffCount > 0 && branch.enrolledStaff === 0
                          ? "#DC2626"
                          : branch.enrolledStaff >= branch.staffCount &&
                              branch.staffCount > 0
                            ? T.teal600
                            : T.muted,
                      fontWeight: 800,
                    }}
                    title={
                      branch.staffCount > 0 && branch.enrolledStaff === 0
                        ? "No faces enrolled — recognition will silently fail at this branch until staff are enrolled."
                        : undefined
                    }
                  >
                    {branch.staffCount > 0 && branch.enrolledStaff === 0 ? (
                      <AlertCircle size={14} />
                    ) : (
                      <CheckCircle2 size={14} />
                    )}
                    {branch.enrolledStaff}/{branch.staffCount}
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {branchDashboardPath ? (
                    <Link
                      to={branchDashboardPath}
                      aria-label={`Open ${branchName} dashboard`}
                      onClick={(event) => event.stopPropagation()}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        height: 30,
                        minWidth: 82,
                        padding: "0 12px",
                        borderRadius: 8,
                        border: "1px solid transparent",
                        background: T.teal600,
                        color: "#ffffff",
                        fontSize: 12,
                        fontWeight: 800,
                        textDecoration: "none",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        lineHeight: 1,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <CalendarClock size={13} />
                      Open
                    </Link>
                  ) : (
                    <button
                      type="button"
                      disabled
                      title={`${branchSingular} id missing`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        height: 30,
                        minWidth: 82,
                        padding: "0 12px",
                        borderRadius: 8,
                        border: `1px solid ${T.border}`,
                        background: T.slate50,
                        color: T.muted,
                        fontSize: 12,
                        fontWeight: 800,
                        fontFamily: "inherit",
                        lineHeight: 1,
                        whiteSpace: "nowrap",
                        cursor: "not-allowed",
                        opacity: 0.65,
                      }}
                    >
                      <CalendarClock size={13} />
                      Open
                    </button>
                  )}

                  {showInstallerAction && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!installerEligible) return;
                        void handleDownloadInstaller(branch);
                      }}
                      disabled={
                        !installerEligible ||
                        downloadingBranchId === getBackendBranchId(branch)
                      }
                      title={
                        installerDisabledReason ||
                        `Download ${branchName} Windows node installer`
                      }
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        height: 30,
                        minWidth: 94,
                        padding: "0 12px",
                        borderRadius: 8,
                        border: `1px solid ${T.border}`,
                        background: T.card,
                        color: T.teal600,
                        fontSize: 12,
                        fontWeight: 800,
                        fontFamily: "inherit",
                        lineHeight: 1,
                        whiteSpace: "nowrap",
                        cursor: !installerEligible
                          ? "not-allowed"
                          : downloadingBranchId === getBackendBranchId(branch)
                            ? "wait"
                            : "pointer",
                        opacity: !installerEligible ? 0.65 : 1,
                      }}
                    >
                      <Download size={13} />
                      {downloadingBranchId === getBackendBranchId(branch)
                        ? "Preparing"
                        : "Installer"}
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {branches.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: T.muted }}>
              No {lowerLabel(branchPlural)} found for this organization.
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default BranchesModule;
