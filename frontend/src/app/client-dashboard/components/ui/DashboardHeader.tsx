/**
 * DashboardHeader.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Scope-switch header for branch-scoped dashboard routes.
 *
 * Behavior:
 * - Multi-branch org:
 *   Shows Super Admin back button and branch selector.
 *
 * - Single-branch org:
 *   Hides Super Admin back button.
 *   Hides branch selector dropdown.
 *   Shows branch-scoped Installer button when organization is local-mode.
 *
 * Performance:
 * - Uses already-loaded OrgConfigContext.
 * - No additional API calls on render.
 * - Installer API is called only when user clicks the button.
 *
 * Tenant safety:
 * - Branch ids are compared as opaque string values.
 * - Installer download uses backendBranchId/backend_branch_id when available.
 * - Frontend never sends organization_id for installer authorization.
 * - Backend must validate user, organization, branch ownership, module access,
 *   org status, and attendance mode.
 */

import React, { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, Download, Loader2 } from "lucide-react";
import { T } from "./theme";
import { Badge } from "./DashboardComponents";
import { BranchSelector } from "./BranchSelector";
import { useOrg } from "../../contexts/OrgConfigContext";
import { useModule } from "../../contexts/ModuleContext";
import { useAuth } from "../../contexts/useAuth";
import { useBranchSelector } from "../../hooks/useBranchSelector";
import { downloadClientNodeInstaller } from "../../pages/Branches/api/clientNodeInstallerApi";

type BranchRouteParams = {
  branchId?: string;
};

type AuthUserLike = {
  id?: number | string | null;
  userId?: number | string | null;
  user_id?: number | string | null;
};

type BranchLike = {
  id?: number | string | null;
  name?: string | null;
  city?: string | null;
  location?: string | null;
  backendBranchId?: number | string | null;
  backend_branch_id?: number | string | null;
};

type ConfigLike = {
  branches?: BranchLike[];
  modules?: string[];
  attendanceMode?: string | null;
  attendance_mode?: string | null;
  organizationStatus?: string | null;
  organization_status?: string | null;
};

const sameId = (a: unknown, b: unknown): boolean => String(a) === String(b);

function toBranchSelectorId(value: string): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function cleanId(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function isLocalAttendanceMode(cfg: ConfigLike): boolean {
  return normalizeKey(cfg.attendanceMode ?? cfg.attendance_mode) === "local";
}

function isOrgAllowedForInstaller(cfg: ConfigLike): boolean {
  const status = normalizeKey(
    cfg.organizationStatus ?? cfg.organization_status ?? "active",
  );

  return ["active", "grace_period", "trial", "launched"].includes(status);
}

function isAttendanceModuleEnabled(cfg: ConfigLike): boolean {
  const modules = Array.isArray(cfg.modules) ? cfg.modules : [];

  return modules
    .map((moduleName) => normalizeKey(moduleName))
    .includes("attendance");
}

function resolveBackendBranchId(branch: BranchLike): string {
  return cleanId(
    branch.backendBranchId ?? branch.backend_branch_id ?? branch.id,
  );
}

function resolveUserId(user: AuthUserLike | null | undefined): string {
  return cleanId(user?.id ?? user?.userId ?? user?.user_id);
}

function installerDisabledReason({
  cfg,
  branch,
  userId,
}: {
  cfg: ConfigLike;
  branch: BranchLike;
  userId: string;
}): string | null {
  if (!isLocalAttendanceMode(cfg)) {
    return "Installer is available only for local attendance mode.";
  }

  if (!isOrgAllowedForInstaller(cfg)) {
    return "Installer is unavailable because organization access is not active.";
  }

  if (!isAttendanceModuleEnabled(cfg)) {
    return "Installer requires the Attendance module to be active.";
  }

  if (!resolveBackendBranchId(branch)) {
    return "Backend branch id is missing.";
  }

  if (!userId) {
    return "User session is missing.";
  }

  return null;
}

function iconButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    height: 34,
    border: `1px solid ${disabled ? T.border : T.teal200}`,
    borderRadius: 9,
    padding: "0 12px",
    background: disabled ? T.slate50 : T.teal600,
    color: disabled ? T.muted : "#ffffff",
    fontSize: 12,
    fontWeight: 800,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    opacity: disabled ? 0.75 : 1,
  };
}

export const DashboardHeader: React.FC = () => {
  const navigate = useNavigate();
  const { cfg } = useOrg();
  const modules = useModule();
  const { user } = useAuth() as { user?: AuthUserLike | null };
  const { branchId: branchIdParam } = useParams<BranchRouteParams>();
  const [isDownloadingInstaller, setIsDownloadingInstaller] = useState(false);
  const [installerError, setInstallerError] = useState<string | null>(null);

  const routeBranchId = String(branchIdParam ?? "").trim();
  const safeCfg = cfg as ConfigLike;

  const { visibleBranches } = useOrg();
  const activeBranches = useMemo<BranchLike[]>(
    () => (Array.isArray(visibleBranches) ? visibleBranches : []),
    [visibleBranches],
  );

  const isSingleBranchOrg = activeBranches.length === 1;

  const activeBranch = useMemo(
    () => activeBranches.find((branch) => sameId(branch.id, routeBranchId)),
    [activeBranches, routeBranchId],
  );

  const branchSelector = useBranchSelector(
    "navigate",
    toBranchSelectorId(routeBranchId),
    true,
  );

  const branchStats = useMemo(() => {
    const staffCount = modules.staff.allItems.filter((member) =>
      sameId(member.branchId, routeBranchId),
    ).length;

    const attendanceRows = modules.attendance.allItems.filter((record) =>
      sameId(record.branchId, routeBranchId),
    );

    const presentCount = attendanceRows.filter((record) => {
      const status = String(record.status || "").toLowerCase();
      return status === "present" || status === "late" || status === "half_day";
    }).length;

    const attendanceRate = staffCount
      ? Math.round((presentCount / staffCount) * 100)
      : 0;

    return { staffCount, attendanceRate };
  }, [modules.staff.allItems, modules.attendance.allItems, routeBranchId]);

  if (!activeBranch) return null;

  const userId = resolveUserId(user);
  const backendBranchId = resolveBackendBranchId(activeBranch);
  const shouldShowSingleBranchInstaller =
    isSingleBranchOrg && isLocalAttendanceMode(safeCfg);

  const disabledReason = installerDisabledReason({
    cfg: safeCfg,
    branch: activeBranch,
    userId,
  });

  const installerDisabled =
    Boolean(disabledReason) || isDownloadingInstaller || !backendBranchId;

  const subtitle = `${branchStats.staffCount} staff · ${branchStats.attendanceRate}% attendance${
    activeBranch.city || activeBranch.location
      ? ` · ${activeBranch.city || activeBranch.location}`
      : ""
  }`;

  const handleDownloadInstaller = async (): Promise<void> => {
    if (installerDisabled || !backendBranchId) return;

    setInstallerError(null);
    setIsDownloadingInstaller(true);

    try {
      await downloadClientNodeInstaller({
        branchId: backendBranchId,
        userId,
        nodeLabel: `${activeBranch.name || "Branch"} Attendance Node`,
        ttlDays: 7,
        packageType: "exe",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to download branch installer.";
      setInstallerError(message);
    } finally {
      setIsDownloadingInstaller(false);
    }
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {!isSingleBranchOrg && (
            <button
              type="button"
              onClick={() => navigate("/admin")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: T.teal50,
                border: `1px solid ${T.teal200}`,
                color: T.teal600,
                borderRadius: 8,
                padding: "5px 12px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <ChevronLeft size={13} /> Super Admin
            </button>
          )}

          <h2
            style={{
              fontSize: 20,
              fontWeight: 800,
              color: T.head,
              letterSpacing: "-.5px",
              margin: 0,
            }}
          >
            {activeBranch.name}
          </h2>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {shouldShowSingleBranchInstaller && (
            <button
              type="button"
              onClick={() => void handleDownloadInstaller()}
              disabled={installerDisabled}
              title={
                disabledReason ?? "Download Windows attendance node installer"
              }
              aria-label="Download branch attendance node installer"
              style={iconButtonStyle(installerDisabled)}
            >
              {isDownloadingInstaller ? (
                <Loader2 size={14} />
              ) : (
                <Download size={14} />
              )}
              {isDownloadingInstaller ? "Preparing…" : "Installer"}
            </button>
          )}

          {!isSingleBranchOrg && (
            <BranchSelector
              branches={branchSelector.selectorBranches}
              selected={branchSelector.selected}
              onChange={branchSelector.onChange}
            />
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginTop: 6,
        }}
      >
        <p style={{ fontSize: 12, color: T.muted, margin: 0 }}>{subtitle}</p>
        <Badge variant="teal">Branch dashboard</Badge>
      </div>

      {installerError && (
        <div
          role="alert"
          style={{
            marginTop: 10,
            border: "1px solid #fecdd3",
            background: "#fff1f2",
            color: "#be123c",
            borderRadius: 10,
            padding: "9px 11px",
            fontSize: 12,
            fontWeight: 700,
            lineHeight: 1.45,
          }}
        >
          {installerError}
        </div>
      )}
    </div>
  );
};

export default DashboardHeader;
