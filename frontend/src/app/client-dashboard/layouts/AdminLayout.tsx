/**
 * AdminLayout.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Shell layout for the Admin and Staff dashboards.
 *
 * All sidebar UI is delegated to the reusable <Sidebar> component.
 * This file only owns:
 *   - Data wiring (user, org config, module registry)
 *   - Building the SidebarGroup[] config from domain data
 *   - The sticky header (page title, notifications, user chip)
 *
 * To reuse for Support Dashboard:
 *   Copy the <Sidebar> usage, swap the `groups` config and logo.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  Building2,
  Fingerprint,
  LayoutDashboard,
  MapPin,
  Settings,
  UserCircle2,
} from "lucide-react";
import {
  getFirstPaintModuleKeys,
  isStaffUser,
  getUserAllowedModules,
} from "../utils/moduleAccess";
import { useAuth } from "../contexts/useAuth";
import { OrgBranch, useOrg } from "../contexts/OrgConfigContext";
import { T } from "../components/ui/theme";
import { resolvePeopleRenderingModel } from "../utils/templateRendering";
import { useAuthenticatedImageUrl } from "../hooks/useAuthenticatedImageUrl";
import { getEnabledModules, MODULE_REGISTRY } from "../config/moduleRegistry";
import DashboardTabBar from "../components/ui/DashboardTabBar";
import { getUnreadNotificationCount } from "../pages/Notifications/api/notificationApi";
import {
  Sidebar,
  SidebarGroup,
  SidebarItem,
  SidebarHamburger,
} from "../components/ui/Sidebar";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS (layout-level only — sidebar tokens live in Sidebar.tsx)
// ─────────────────────────────────────────────────────────────────────────────

const HEADER_HEIGHT = 64;
const TRANSITION = "all 280ms cubic-bezier(0.4, 0, 0.2, 1)";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface AuthUser {
  id?: string | number;
  staffId?: string;
  username?: string;
  name?: string;
  email?: string;
  role?: string;
  companyLogo?: string | null;
  profileImageUrl?: string;
  avatarUrl?: string;
  organizationId?: string | number | null;
  organization_id?: string | number | null;
  branchId?: string | number | null;
  branch_id?: string | number | null;
  allowedBranchIds?: Array<string | number>;
  allowedModules?: string[] | string;
  accessModules?: string[] | string;
  moduleAccess?: string[] | string;
  access_modules?: string[] | string;
}

type HeaderUserRecord = {
  id?: string;
  staffId?: string;
  username?: string;
  name?: string;
  email?: string;
  role?: string;
  companyLogo?: string | null;
  profileImageUrl?: string;
  avatarUrl?: string;
};

type NavModule = {
  key?: string;
  label?: string;
  fullPath?: string;
  path?: string;
  branchPath?: (branchId: number) => string;
  Icon?: React.ComponentType<{ size?: number; color?: string }>;
  icon?: React.ComponentType<{ size?: number; color?: string }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

const GLOBAL_SCOPE = "global" as const;
const BRANCH_SCOPE = "branch" as const;

type TenantId = string | number;

function toNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toTenantId(value: unknown): TenantId | null {
  if (value === undefined || value === null) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const text = String(value).trim();
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0 && String(numeric) === text) {
    return numeric;
  }

  return text;
}

function getUserBranchId(user: AuthUser | null): number | null {
  const direct = toNumberOrNull(user?.branchId ?? user?.branch_id);
  if (direct) return direct;
  const allowed = Array.isArray(user?.allowedBranchIds)
    ? user.allowedBranchIds
    : [];
  return toNumberOrNull(allowed[0]);
}

function getUserAllowedBranchIds(user: AuthUser | null): number[] {
  const explicit = Array.isArray(user?.allowedBranchIds)
    ? user.allowedBranchIds
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (explicit.length > 0) return [...new Set(explicit)];
  const branchId = getUserBranchId(user);
  return branchId ? [branchId] : [];
}

/**
 * FIX #2: Staff module privilege escalation guard.
 *
 * Previous behaviour:
 *   if (isStaffDashboard && sessionModules.length === 0) return orgModules;
 *   → Staff with no allowedModules on their token would see every module the
 *     org has, leaking pages they should never access.
 *
 * Fixed behaviour:
 *   Staff always receive only their own sessionModules.
 *   If the token contains no modules, we return [] — the caller treats an
 *   empty result as "show nothing / skeleton" rather than "show everything".
 *   Admins still fall through to orgModules (the Supabase-owned source of truth).
 */

function resolveAdminRecord(
  records: HeaderUserRecord[],
  user: AuthUser | null,
): HeaderUserRecord | null {
  const admins = records.filter((r) => r.role === "admin");
  if (!admins.length) return null;

  if (user?.id) {
    const match = admins.find((r) => String(r.id ?? "") === String(user.id));
    if (match) return match;
  }
  if (user?.staffId) {
    const match = admins.find((r) => r.staffId === user.staffId);
    if (match) return match;
  }
  if (user?.username) {
    const match = admins.find(
      (r) =>
        String(r.username ?? "").toLowerCase() === user.username!.toLowerCase(),
    );
    if (match) return match;
  }
  if (user?.email) {
    const match = admins.find(
      (r) => String(r.email ?? "").toLowerCase() === user.email!.toLowerCase(),
    );
    if (match) return match;
  }
  return admins.length === 1 ? admins[0] : null;
}

function toAdminPath(item: NavModule): string {
  if (item.fullPath) return item.fullPath;
  if (item.path?.startsWith("/")) return item.path;
  if (item.path) return `/admin/${item.path.replace(/^\/+/, "")}`;
  if (item.key) return `/admin/${item.key}`;
  return "/admin";
}

function getModuleLabel(item: NavModule): string {
  return item.label ?? item.key ?? "Module";
}

function branchIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/admin\/branch\/(\d+)/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

function modulePathForScope(
  item: NavModule,
  staffBranchId: number | null,
): string {
  if (staffBranchId && item.branchPath) return item.branchPath(staffBranchId);
  return toAdminPath(item);
}

// ─────────────────────────────────────────────────────────────────────────────
// SIDEBAR GROUP BUILDER
// ─────────────────────────────────────────────────────────────────────────────

interface BuildGroupsParams {
  navModules: NavModule[];
  isStaffDashboard: boolean;
  staffBranchId: number | null;
  dashboardPath: string;
  visibleBranches: Array<{ id: number; name: string }>;
  peopleManagementLabel: string;
}

function buildSidebarGroups({
  navModules,
  isStaffDashboard,
  staffBranchId,
  dashboardPath,
  visibleBranches,
  peopleManagementLabel,
}: BuildGroupsParams): SidebarGroup[] {
  // Main nav items
  const mainItems: SidebarItem[] = [
    {
      key: "dashboard",
      label: "Dashboard",
      path: dashboardPath,
      icon: LayoutDashboard,
      tooltip: "Dashboard",
    },
  ];

  // Dynamic module items (from moduleRegistry)
  navModules
    .filter((item) => {
      const path = modulePathForScope(
        item,
        isStaffDashboard ? staffBranchId : null,
      );
      return path !== dashboardPath;
    })
    .forEach((item) => {
      const path = modulePathForScope(
        item,
        isStaffDashboard ? staffBranchId : null,
      );
      const Icon = (item.Icon ?? item.icon) as React.ComponentType<{
        size: number;
        color: string;
      }>;
      if (!Icon) return;

      mainItems.push({
        key: item.key ?? path,
        label:
          item.key === "employees"
            ? peopleManagementLabel
            : getModuleLabel(item),
        path,
        icon: Icon,
        tooltip:
          item.key === "employees"
            ? peopleManagementLabel
            : getModuleLabel(item),
      });
    });

  const groups: SidebarGroup[] = [{ id: "main", items: mainItems }];

  // Branches group
  if (visibleBranches.length > 0) {
    const branchItems: SidebarItem[] = visibleBranches.map((branch) => ({
      key: `branch-${branch.id}`,
      label: branch.name,
      path: `/admin/branch/${branch.id}`,
      icon: MapPin,
      tooltip: branch.name,
    }));

    groups.push({
      id: "branches",
      label: isStaffDashboard ? "My Branch" : "Branches",
      items: branchItems,
      divider: true,
    });
  }

  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// USER AVATAR CHIP
// ─────────────────────────────────────────────────────────────────────────────

interface UserChipProps {
  name: string;
  email: string;
  image: string;
  role: string;
}

const UserChip: React.FC<UserChipProps> = ({ name, email, image, role }) => {
  const initial = name.trim().charAt(0).toUpperCase() || "A";
  // Photo routes require an Authorization header the browser can't attach
  // to a plain <img src> — see useAuthenticatedImageUrl's docstring.
  const photoSrc = useAuthenticatedImageUrl(image || null);

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 9, paddingLeft: 8 }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: T.teal100,
          color: T.teal700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 900,
          fontSize: 13,
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        {photoSrc ? (
          <img
            src={photoSrc}
            alt={name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          initial
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 800,
            color: T.head,
            maxWidth: 140,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {name}
        </p>
        <p
          style={{
            margin: "2px 0 0",
            fontSize: 11,
            color: T.muted,
            maxWidth: 140,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {email || role || "Administrator"}
        </p>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION BELL
// ─────────────────────────────────────────────────────────────────────────────

interface NotificationBellProps {
  count: number;
  onClick: () => void;
}

const NotificationBell: React.FC<NotificationBellProps> = ({
  count,
  onClick,
}) => (
  <button
    type="button"
    aria-label={`Notifications${count > 0 ? `, ${count} unread` : ""}`}
    onClick={onClick}
    style={{
      width: 38,
      height: 38,
      borderRadius: 10,
      border: `1px solid ${T.border}`,
      background: "#fff",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      position: "relative",
    }}
  >
    <Bell size={17} color={T.muted} />
    {count > 0 && (
      <span
        style={{
          position: "absolute",
          top: -5,
          right: -5,
          minWidth: 17,
          height: 17,
          padding: "0 4px",
          borderRadius: 999,
          background: "#e11d48",
          color: "#fff",
          fontSize: 9,
          fontWeight: 900,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "2px solid #fff",
        }}
      >
        {count > 99 ? "99+" : count}
      </span>
    )}
  </button>
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function AdminLayout() {
  const { user: rawUser, logout: rawLogout } = useAuth() as {
    user?: AuthUser | null;
    logout?: () => void;
  };
  const user = rawUser ?? null;
  const logout = rawLogout ?? (() => undefined);

  const navigate = useNavigate();
  const location = useLocation();
  const {
    cfg,
    activeBranchId,
    setActiveBranchId,
    organizationId,
    isOrgReady,
    visibleBranches: orgVisibleBranches,
  } = useOrg();

  // Mobile sidebar toggle
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // FIX #3: Close the mobile sidebar on every route change.
  // Without this, navigating via a sidebar link leaves the overlay open
  // because useState persists across renders regardless of URL changes.
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  const isStaffDashboard = isStaffUser(user);
  const staffBranchId = getUserBranchId(user);

  const allowedBranchIds = useMemo(() => getUserAllowedBranchIds(user), [user]);

  const visibleBranches = useMemo<OrgBranch[]>(() => {
    if (!isOrgReady) return [];
    if (!isStaffDashboard) return orgVisibleBranches;
    const allowed = new Set(allowedBranchIds);
    return orgVisibleBranches.filter((b) => allowed.has(b.id));
  }, [allowedBranchIds, orgVisibleBranches, isStaffDashboard, isOrgReady]);

  const dashboardPath =
    isStaffDashboard && staffBranchId
      ? `/admin/branch/${staffBranchId}`
      : "/admin";

  // Sync URL branch param → context
  useEffect(() => {
    const branchId = branchIdFromPath(location.pathname);
    if (branchId !== activeBranchId) setActiveBranchId(branchId);
  }, [location.pathname, activeBranchId, setActiveBranchId]);

  // Build module nav items from registry.
  // Best-practice first paint:
  // - During bootstrap, use the authenticated session's module snapshot.
  // - After bootstrap, reconcile to Supabase-owned cfg.modules.
  // - Never call getEnabledModules() with an empty enabledKeys array because
  //   moduleRegistry treats empty as "show all modules".
  const navModules = useMemo<NavModule[]>(() => {
    const enabledKeys = getFirstPaintModuleKeys(
      user,
      cfg.modules,
      isOrgReady,
      isStaffDashboard,
    );

    if (enabledKeys.length === 0) return [];

    const resolvedModules = getEnabledModules({
      enabledKeys,
      bizType: cfg.bizType ?? undefined,
      scope: isStaffDashboard ? BRANCH_SCOPE : GLOBAL_SCOPE,
    }) as NavModule[];

    if (!isStaffDashboard) {
      const branchesModule = MODULE_REGISTRY.find(
        (module) => module.key === "branches",
      );
      if (
        branchesModule &&
        !resolvedModules.some((module) => module.key === "branches")
      ) {
        return [branchesModule as unknown as NavModule, ...resolvedModules];
      }
    }

    return resolvedModules;
  }, [user, cfg.modules, cfg.bizType, isStaffDashboard, isOrgReady]);

  const peopleRenderingModel = useMemo(
    () =>
      resolvePeopleRenderingModel(cfg as unknown as Record<string, unknown>),
    [cfg],
  );

  // Build sidebar groups
  const sidebarGroups = useMemo(
    () =>
      buildSidebarGroups({
        navModules,
        isStaffDashboard,
        staffBranchId,
        dashboardPath,
        visibleBranches,
        peopleManagementLabel: peopleRenderingModel.pageTitle,
      }),
    [
      navModules,
      isStaffDashboard,
      staffBranchId,
      dashboardPath,
      visibleBranches,
      peopleRenderingModel.pageTitle,
    ],
  );

  // Page title
  const currentLabel = useMemo(() => {
    if (!isOrgReady) return "Dashboard";

    const branchMatch = location.pathname.match(/\/admin\/branch\/(\d+)/);
    if (branchMatch) {
      const id = Number(branchMatch[1]);
      return cfg.branches.find((b) => b.id === id)?.name ?? "Branch Dashboard";
    }
    const active = navModules.find((item) => {
      const p = toAdminPath(item);
      return location.pathname === p || location.pathname.startsWith(`${p}/`);
    });
    return active
      ? active.key === "employees"
        ? peopleRenderingModel.pageTitle
        : getModuleLabel(active)
      : "Dashboard";
  }, [
    location.pathname,
    navModules,
    cfg.branches,
    isOrgReady,
    peopleRenderingModel.pageTitle,
  ]);

  // User display info
  const adminRecord = useMemo(
    () =>
      isStaffDashboard
        ? null
        : resolveAdminRecord(cfg.users as HeaderUserRecord[], user),
    [cfg.users, isStaffDashboard, user],
  );

  const displayName = adminRecord?.name || user?.name || "User";
  const displayEmail = adminRecord?.email || user?.email || "";
  const displayImage =
    user?.profileImageUrl ||
    user?.avatarUrl ||
    adminRecord?.profileImageUrl ||
    adminRecord?.avatarUrl ||
    "";
  const brandName = cfg.orgName || "OrgFlow ERP";
  const brandLogo = user?.companyLogo || cfg.logo || null;

  // Notifications
  const currentUserId = toTenantId(user?.id);
  const currentOrgId =
    toTenantId(user?.organizationId ?? user?.organization_id) ??
    toTenantId(organizationId);

  const [unreadCount, setUnreadCount] = useState(0);

  const fetchNotificationCount = useCallback(async () => {
    if (!currentUserId) {
      setUnreadCount(0);
      return;
    }
    try {
      const count = await getUnreadNotificationCount({
        userId: currentUserId,
        organizationId: currentOrgId ?? undefined,
      });
      setUnreadCount(count);
    } catch {
      // Non-fatal — keep previous count
    }
  }, [currentUserId, currentOrgId]);

  useEffect(() => {
    void fetchNotificationCount();
    const timer = window.setInterval(
      () => void fetchNotificationCount(),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, [fetchNotificationCount]);

  // Gate: gear icon only reachable when this user is actually allowed into
  // Settings — admins always are; staff only with the "settings" module
  // grant (the toggle added in StaffModal's Dashboard Module Access list).
  // Deliberately uses getUserAllowedModules(user) directly, NOT
  // getFirstPaintModuleKeys/navModules — those intersect with cfg.modules
  // (the org's *purchased* set), which would wrongly strip "settings" back
  // out, since it's intentionally exempt from that gate (see moduleRegistry.ts).
  const canAccessSettings =
    !isStaffDashboard || getUserAllowedModules(user).includes("settings");

  // Logo element
  const logoElement = brandLogo ? (
    <img
      src={brandLogo}
      alt="Organization logo"
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        objectFit: "contain",
        background: "#fff",
        border: `1px solid ${T.border}`,
        flexShrink: 0,
      }}
    />
  ) : (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        background: `linear-gradient(135deg, ${T.teal600}, ${T.teal700})`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Fingerprint size={18} color="#fff" />
    </div>
  );

  const handleLogout = () => {
    logout();
    navigate("/");
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: T.bg,
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      {/* ── REUSABLE SIDEBAR ── */}
      <Sidebar
        groups={sidebarGroups}
        logo={logoElement}
        brandName={brandName}
        brandSubtext={isStaffDashboard ? "Staff Panel" : "Admin Panel"}
        onLogout={handleLogout}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />

      {/* ── MAIN CONTENT ── */}
      <div
        style={{
          minWidth: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Sticky header */}
        <header
          style={{
            height: HEADER_HEIGHT,
            minHeight: HEADER_HEIGHT,
            flexShrink: 0,
            background: "#fff",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 22px",
            position: "sticky",
            top: 0,
            zIndex: 30,
          }}
        >
          {/* Left: hamburger (mobile only) + title */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
            }}
          >
            {/* Hamburger — visible only on mobile via CSS */}
            <div
              style={{
                display: "none",
                // Shown via media query — we use inline style hack below
              }}
              className="mobile-hamburger"
            >
              <SidebarHamburger onClick={() => setMobileSidebarOpen(true)} />
            </div>

            <div style={{ minWidth: 0 }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: 18,
                  fontWeight: 900,
                  color: T.head,
                  letterSpacing: "-0.4px",
                }}
              >
                {currentLabel}
              </h1>
              <p style={{ margin: "3px 0 0", fontSize: 12, color: T.muted }}>
                {isStaffDashboard
                  ? "Staff branch dashboard"
                  : activeBranchId === null
                    ? "Global view"
                    : "Branch view"}
              </p>
            </div>
          </div>

          {/* Right: notification bell, settings, user chip */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <NotificationBell
              count={unreadCount}
              onClick={() => navigate("/admin/notifications")}
            />

            {canAccessSettings && (
              <button
                type="button"
                aria-label="Settings"
                onClick={() => navigate("/admin/settings")}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  border: `1px solid ${T.border}`,
                  background: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
              >
                <Settings size={17} color={T.muted} />
              </button>
            )}

            {/* "My Account" — always visible, unlike the Settings gear
                above, which is gated behind the org-level "settings"
                module grant. Personal account actions (change my own
                password, etc.) are a "who am I" concern, not an
                organization-configuration one — every authenticated
                dashboard user reaches AccountSettings.tsx through here,
                regardless of module access. See routes.tsx's
                account-settings route and AccountSettings.tsx's file-level
                note for the full reasoning. */}
            <button
              type="button"
              aria-label="My Account"
              onClick={() => navigate("/admin/account-settings")}
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                border: `1px solid ${T.border}`,
                background: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              <UserCircle2 size={18} color={T.muted} />
            </button>

            <UserChip
              name={displayName}
              email={displayEmail}
              image={displayImage}
              role={user?.role ?? ""}
            />
          </div>
        </header>

        {/* Page content — only this area scrolls */}
        <main style={{ minWidth: 0, flex: 1, overflow: "auto", padding: 22 }}>
          <DashboardTabBar />
          <Outlet />
        </main>
      </div>

      {/*
       * Mobile hamburger visibility hack.
       * We use a <style> tag rather than a CSS file import to keep this
       * self-contained. If you have a global CSS file, move this there.
       */}
      <style>{`
        @media (max-width: 768px) {
          .mobile-hamburger {
            display: block !important;
          }
        }
      `}</style>
    </div>
  );
}
