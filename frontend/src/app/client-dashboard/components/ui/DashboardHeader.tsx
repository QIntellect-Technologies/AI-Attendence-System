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

import React, { useCallback, useMemo, useState } from "react";
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
  organizationStatus?: string | null;
  organization_status?: string | null;
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
  // No organizationStatus here on purpose — OrgConfigContext does not put
  // org status on cfg, it puts it on the auth user. Declaring it here is
  // what let the old status check compile while silently always passing.
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

/** Org status lives on the auth user, NOT on cfg.
 *
 * OrgConfigContext writes organizationStatus onto the stored currentUser
 * (see its persist block), and cfg has no such field. Reading it off cfg
 * meant this check hit the `?? "active"` fallback on every render and
 * therefore never blocked anything — a suspended org still got an enabled
 * button that 403s at the backend. Branches.tsx already reads it from the
 * user; this now matches.
 *
 * Allow-list is deliberately the backend's own set — support_db_core.py's
 * _org_access_allows_client() permits exactly {active, grace_period}. The
 * previous list here also allowed trial/launched, so a trial org saw an
 * enabled button that the server always rejected.
 */
function isOrgAllowedForInstaller(user: AuthUserLike | null | undefined): boolean {
  const status = normalizeKey(
    user?.organizationStatus ?? user?.organization_status ?? "active",
  );

  return ["active", "grace_period"].includes(status);
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
  user,
  userId,
}: {
  cfg: ConfigLike;
  branch: BranchLike;
  user: AuthUserLike | null | undefined;
  userId: string;
}): string | null {
  if (!isLocalAttendanceMode(cfg)) {
    return "Installer is available only for local attendance mode.";
  }

  if (!isOrgAllowedForInstaller(user)) {
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

  // routes.tsx decides "is this a single-branch org?" from cfg.branches
  // (activeConfigBranches), while visibleBranches is cfg.branches sliced to
  // cfg.maxBranches. When those two disagree — a licence cap that doesn't
  // match the real branch count — routing sends a single-branch org here
  // but this component saw 2+ and hid the Installer button, which is the
  // only way such an org can reach it (their Branches tab is redirected
  // away). Treat the org as single-branch if EITHER source says so.
  const configBranches = useMemo<BranchLike[]>(
    () => (Array.isArray(safeCfg.branches) ? safeCfg.branches : []),
    [safeCfg.branches],
  );

  const isSingleBranchOrg =
    activeBranches.length === 1 || configBranches.length === 1;

  // Look the branch up in the full config list, not the sliced one: a branch
  // trimmed off by maxBranches would otherwise return null here and blank
  // out the entire header (title, stats and installer) on a route that
  // BranchDashboard had already validated against cfg.branches.
  const activeBranch = useMemo(
    () =>
      configBranches.find((branch) => sameId(branch.id, routeBranchId)) ??
      activeBranches.find((branch) => sameId(branch.id, routeBranchId)),
    [activeBranches, configBranches, routeBranchId],
  );

  const branchSelector = useBranchSelector(
    "navigate",
    toBranchSelectorId(routeBranchId),
    true,
  );

  // Staff and attendance rows are matched on EITHER id form.
  //
  // staffMappers.toUiBranchId() coerces a branch id to a number and returns 0
  // when it can't — which is exactly what happens on Supabase tenants, where
  // branch_id is a UUID (Number(uuid) is NaN). So every staff row arrived
  // here with branchId === 0 while the route param was "1", nothing matched,
  // and the header confidently reported "0 staff · 0% attendance" next to a
  // directory listing four people. The UUID survives on backendBranchId, so
  // compare against both that and the numeric id.
  const branchMatchKeys = useMemo(() => {
    const keys = new Set<string>();
    if (routeBranchId) keys.add(routeBranchId);
    if (activeBranch) {
      const backendId = resolveBackendBranchId(activeBranch);
      if (backendId) keys.add(backendId);
      if (activeBranch.id !== null && activeBranch.id !== undefined) {
        keys.add(cleanId(activeBranch.id));
      }
    }
    keys.delete("");
    return keys;
  }, [activeBranch, routeBranchId]);

  const belongsToBranch = useCallback(
    (row: { branchId?: unknown; backendBranchId?: unknown }): boolean => {
      const uiId = cleanId(row.branchId);
      const backendId = cleanId(
        (row as { backendBranchId?: unknown; backend_branch_id?: unknown })
          .backendBranchId ??
          (row as { backend_branch_id?: unknown }).backend_branch_id,
      );

      // "0" is toUiBranchId's failure sentinel, not a real branch — ignore it
      // so it can't collide with a genuine branch whose id is 0.
      return (
        (uiId !== "" && uiId !== "0" && branchMatchKeys.has(uiId)) ||
        (backendId !== "" && branchMatchKeys.has(backendId))
      );
    },
    [branchMatchKeys],
  );

  const branchStats = useMemo(() => {
    const staffRows = modules.staff.allItems.filter(belongsToBranch);
    const attendanceRows = modules.attendance.allItems.filter(belongsToBranch);

    const presentCount = attendanceRows.filter((record) => {
      const status = String(record.status || "").toLowerCase();
      return status === "present" || status === "late" || status === "half_day";
    }).length;

    const staffCount = staffRows.length;
    const attendanceRate = staffCount
      ? Math.round((presentCount / staffCount) * 100)
      : 0;

    // The module stores hydrate in the background, so an empty store means
    // "not loaded yet", not "this branch has nobody". Reporting a hard 0
    // during that window is worse than reporting nothing.
    const hasLoaded =
      !modules.loading && modules.staff.allItems.length > 0;

    return { staffCount, attendanceRate, hasLoaded };
  }, [
    belongsToBranch,
    modules.loading,
    modules.staff.allItems,
    modules.attendance.allItems,
  ]);

  if (!activeBranch) return null;

  const userId = resolveUserId(user);
  const backendBranchId = resolveBackendBranchId(activeBranch);
  const shouldShowSingleBranchInstaller =
    isSingleBranchOrg && isLocalAttendanceMode(safeCfg);

  const disabledReason = installerDisabledReason({
    cfg: safeCfg,
    branch: activeBranch,
    user,
    userId,
  });

  const installerDisabled =
    Boolean(disabledReason) || isDownloadingInstaller || !backendBranchId;

  const branchLocation = activeBranch.city || activeBranch.location || "";
  const subtitle = [
    branchStats.hasLoaded
      ? `${branchStats.staffCount} staff · ${branchStats.attendanceRate}% attendance`
      : "",
    branchLocation,
  ]
    .filter(Boolean)
    .join(" · ");

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
                <Loader2
                  size={14}
                  style={{ animation: "spin .8s linear infinite" }}
                />
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