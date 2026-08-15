/**
 * DashboardTabBar.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Route-driven tab bar shared by global admin and branch/staff dashboards.
 *
 * Performance:
 * - No API calls are made here.
 * - Tabs are derived from already-loaded auth/session + org bootstrap state.
 * - Route location is the source of truth.
 * - Branch IDs are treated as opaque IDs, so UUID branches also work.
 */

import React, { useMemo } from "react";
import { Link, matchPath, useLocation } from "react-router-dom";
import { Building2, LayoutGrid } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { T } from "./theme";
import { useAuth } from "../../contexts/useAuth";
import { useOrg } from "../../contexts/OrgConfigContext";
import { getEnabledModules } from "../../config/moduleRegistry";
import { resolvePeopleRenderingModel } from "../../utils/templateRendering";
import { getFirstPaintModuleKeys, isStaffUser } from "../../utils/moduleAccess";

export interface DashboardTabDef {
  id: string;
  label: string;
  Icon: LucideIcon;
  to: string;
}

interface AuthUser {
  role?: string;
  branchId?: number | string | null;
  branch_id?: number | string | null;
  allowedBranchIds?: Array<number | string>;
  allowedModules?: string[] | string;
  accessModules?: string[] | string;
  moduleAccess?: string[] | string;
  access_modules?: string[] | string;
}

function isSubrouteActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

function toIdOrNull(value: unknown): number | string | null {
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

function toRouteBranchNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function staffBranchId(
  user: AuthUser | null | undefined,
): number | string | null {
  const direct = toIdOrNull(user?.branchId ?? user?.branch_id);
  if (direct) return direct;

  const firstAllowed = Array.isArray(user?.allowedBranchIds)
    ? user.allowedBranchIds[0]
    : null;

  return toIdOrNull(firstAllowed);
}

function normalizeModuleIdentity(value?: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isPeopleDirectoryModule(key?: string, label?: string): boolean {
  const normalizedKey = normalizeModuleIdentity(key);
  const normalizedLabel = normalizeModuleIdentity(label);

  return (
    [
      "staff",
      "employee",
      "employees",
      "people",
      "peoplemanagement",
      "staffmanagement",
      "staffdirectory",
      "employeemanagement",
      "employeesmanagement",
    ].includes(normalizedKey) ||
    [
      "peoplemanagement",
      "staffmanagement",
      "employeesmanagement",
      "studentsmanagement",
      "workersmanagement",
    ].includes(normalizedLabel)
  );
}

function moduleDisplayLabel(
  key: string | undefined,
  label: string | undefined,
  peopleManagementLabel: string,
): string {
  return isPeopleDirectoryModule(key, label)
    ? peopleManagementLabel
    : String(label || key || "Module");
}

function isBranchesModule(key?: string, label?: string): boolean {
  return (
    normalizeModuleIdentity(key) === "branches" ||
    normalizeModuleIdentity(label) === "branches"
  );
}

function LoadingModuleHint() {
  return (
    <span
      aria-label="Loading dashboard modules"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 14px",
        borderRadius: 7,
        color: T.muted,
        fontWeight: 600,
        fontSize: 12,
        fontFamily: "inherit",
        whiteSpace: "nowrap",
        opacity: 0.75,
      }}
    >
      <span
        style={{
          width: 56,
          height: 8,
          borderRadius: 999,
          background: "linear-gradient(90deg, #e2e8f0, #f8fafc, #e2e8f0)",
          display: "inline-block",
        }}
      />
    </span>
  );
}

export const DashboardTabBar: React.FC = () => {
  const location = useLocation();
  const { cfg, isOrgReady } = useOrg();
  const { user: rawUser } = useAuth() as { user?: AuthUser | null };

  const user = rawUser ?? null;
  const isStaffDashboard = isStaffUser(user);
  const ownBranchId = staffBranchId(user);

  const safeModuleKeys = useMemo(
    () =>
      getFirstPaintModuleKeys(user, cfg.modules, isOrgReady, isStaffDashboard),
    [user, cfg.modules, isOrgReady, isStaffDashboard],
  );
  const isResolvingModules = !isOrgReady && safeModuleKeys.length === 0;

  const peopleModel = useMemo(
    () =>
      resolvePeopleRenderingModel(cfg as unknown as Record<string, unknown>),
    [cfg],
  );

  const routeBranchId = useMemo(() => {
    const match = matchPath(
      { path: "/admin/branch/:branchId", end: false },
      location.pathname,
    );

    return toIdOrNull(match?.params.branchId);
  }, [location.pathname]);

  const tabs = useMemo<DashboardTabDef[]>(() => {
    if (isStaffDashboard) {
      if (!ownBranchId) return [];

      const branchBase = `/admin/branch/${ownBranchId}`;
      const ownBranchNumber = toRouteBranchNumber(ownBranchId);

      const moduleTabs =
        ownBranchNumber && safeModuleKeys.length > 0
          ? getEnabledModules({
              scope: "branch",
              bizType: cfg.bizType ?? undefined,
              enabledKeys: safeModuleKeys,
            })
              .filter((module) => !isBranchesModule(module.key, module.label))
              .map((module) => ({
                id: module.key,
                label: moduleDisplayLabel(
                  module.key,
                  module.label,
                  peopleModel.pageTitle,
                ),
                Icon: module.Icon,
                to: module.branchPath(ownBranchNumber),
              }))
          : [];

      return [
        {
          id: "overview",
          label: "Overview",
          Icon: LayoutGrid,
          to: branchBase,
        },
        ...moduleTabs,
      ];
    }

    if (routeBranchId === null) {
      const moduleTabs =
        safeModuleKeys.length > 0
          ? getEnabledModules({
              scope: "global",
              bizType: cfg.bizType ?? undefined,
              enabledKeys: safeModuleKeys,
            })
              .filter((module) => !isBranchesModule(module.key, module.label))
              .map((module) => ({
                id: module.key,
                label: moduleDisplayLabel(
                  module.key,
                  module.label,
                  peopleModel.pageTitle,
                ),
                Icon: module.Icon,
                to: module.fullPath,
              }))
          : [];

      return [
        {
          id: "overview",
          label: "Overview",
          Icon: LayoutGrid,
          to: "/admin",
        },
        {
          id: "branches",
          label: "Branches",
          Icon: Building2,
          to: "/admin/branches",
        },
        ...moduleTabs,
      ];
    }

    const branchBase = `/admin/branch/${routeBranchId}`;
    const routeBranchNumber = toRouteBranchNumber(routeBranchId);

    const moduleTabs =
      routeBranchNumber && safeModuleKeys.length > 0
        ? getEnabledModules({
            scope: "branch",
            bizType: cfg.bizType ?? undefined,
            enabledKeys: safeModuleKeys,
          })
            .filter((module) => !isBranchesModule(module.key, module.label))
            .map((module) => ({
              id: module.key,
              label: moduleDisplayLabel(
                module.key,
                module.label,
                peopleModel.pageTitle,
              ),
              Icon: module.Icon,
              to: module.branchPath(routeBranchNumber),
            }))
        : [];

    return [
      {
        id: "overview",
        label: "Overview",
        Icon: LayoutGrid,
        to: branchBase,
      },
      ...moduleTabs,
    ];
  }, [
    cfg.bizType,
    isStaffDashboard,
    ownBranchId,
    routeBranchId,
    safeModuleKeys,
    peopleModel.pageTitle,
  ]);

  if (tabs.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 2,
        background: T.slate50,
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        padding: 3,
        width: "fit-content",
        marginBottom: 22,
      }}
    >
      {tabs.map((tab) => {
        const isRoot = tab.id === "overview";
        const active = isRoot
          ? location.pathname === tab.to
          : isSubrouteActive(location.pathname, tab.to);

        return (
          <Link
            key={tab.id}
            to={tab.to}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 14px",
              borderRadius: 7,
              textDecoration: "none",
              background: active ? T.card : "transparent",
              color: active ? T.teal600 : T.muted,
              fontWeight: active ? 700 : 500,
              fontSize: 12,
              fontFamily: "inherit",
              boxShadow: active ? "0 1px 4px rgba(0,0,0,0.08)" : "none",
              transition: "all .15s",
              whiteSpace: "nowrap",
            }}
          >
            <tab.Icon size={13} strokeWidth={active ? 2.2 : 1.8} />
            {tab.label}
          </Link>
        );
      })}

      {isResolvingModules && <LoadingModuleHint />}
    </div>
  );
};

export default DashboardTabBar;
