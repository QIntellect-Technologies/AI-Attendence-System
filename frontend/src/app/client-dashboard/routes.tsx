/**
 * routes.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Client Dashboard routing with lazy-loaded pages and route-level access control.
 *
 * Loading/performance rules:
 * - Only the AdminLayout shell and tenant bootstrap load for /admin routes.
 * - Heavy pages are lazy-loaded and do not render until their route is active.
 * - Page-specific API calls only run after the matched page component mounts.
 * - /admin/branches is a real route and never falls back to Dashboard.
 */

import React, { Suspense, lazy } from "react";
import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import { useAuth } from "./contexts/useAuth";
import { OrgConfigProvider, useOrg } from "./contexts/OrgConfigContext";
import { ModuleProvider } from "./contexts/ModuleContext";
import TenantGate from "./components/TenantGate";
import { isModuleEnabled } from "./components/ModuleGate";
import {
  MODULE_REGISTRY,
  BRANCH_ROUTE,
  type ModuleDef,
} from "./config/moduleRegistry";
import { supportRoutes } from "../support-dashboard/routes";
import PayrollDecisions from "./pages/attendance_temp/PayrollDecisions";

const Login = lazy(() => import("./pages/Login"));
const OnboardingWizard = lazy(
  () => import("./pages/onboarding/OnboardingWizard"),
);
const AdminLayout = lazy(() => import("./layouts/AdminLayout"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const BranchesModule = lazy(() => import("./pages/Branches"));
const AdminSettings = lazy(() => import("./pages/Settings/Settings"));
const AccountSettings = lazy(
  () => import("./pages/AccountSettings/AccountSettings"),
);
const NotificationsPage = lazy(
  () => import("./pages/Notifications/Notifications"),
);
const AttendanceExceptionsPage = lazy(
  () => import("./pages/attendance_temp/AttendanceExceptions"),
);

const PayrollDecisionsPage = lazy(
  () => import("./pages/attendance_temp/PayrollDecisions"),
);
const BranchDashboard = lazy(
  () => import("./pages/BranchDashboard/BranchDashboard"),
);
const BranchOverviewPage = lazy(() =>
  import("./pages/BranchDashboard/BranchDashboard").then((module) => ({
    default: module.BranchOverviewPage,
  })),
);

const PageLoader: React.FC = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "40vh",
      gap: 12,
      color: "var(--text-light, #94a3b8)",
    }}
  >
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: "3px solid var(--teal-100, #e6f3f9)",
        borderTopColor: "var(--teal-600, #1a699f)",
        animation: "spin .65s linear infinite",
      }}
    />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    <span style={{ fontSize: 13, fontWeight: 500 }}>Loading…</span>
  </div>
);

const suspense = (children: React.ReactNode): React.ReactElement => (
  <Suspense fallback={<PageLoader />}>{children}</Suspense>
);

interface AuthUser {
  id?: number | string;
  role?: string;
  branchId?: number | string | null;
  branch_id?: number | string | null;
  allowedBranchIds?: Array<number | string>;
  allowedModules?: string[] | string;
  accessModules?: string[] | string;
  moduleAccess?: string[] | string;
  access_modules?: string[] | string;
  dashboardReady?: boolean;
  dashboard_ready?: boolean;
  requiresOnboarding?: boolean;
  requires_onboarding?: boolean;
  organizationId?: number | string | null;
  organization_id?: number | string | null;
  organizationStatus?: string;
  organization_status?: string;
  portalAccess?: {
    desktopDashboard?: boolean;
  };
}

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles: string[];
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

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      return value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return [];
}

function authRole(user: AuthUser | null | undefined): string {
  return String(user?.role ?? "")
    .trim()
    .toLowerCase();
}

const isStaffUser = (user: AuthUser | null | undefined): user is AuthUser =>
  authRole(user) === "staff";

const isAdminUser = (user: AuthUser | null | undefined): user is AuthUser =>
  authRole(user) === "admin";

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

function activeConfigBranches(
  cfg: { branches?: Array<{ id?: number | string | null }> } | null | undefined,
): Array<{ id: number | string }> {
  if (!cfg || !Array.isArray(cfg.branches)) return [];

  return cfg.branches
    .map((branch) => ({
      id: toIdOrNull(branch?.id),
    }))
    .filter((branch): branch is { id: number | string } => branch.id !== null);
}

function normalizeModuleKey(key: unknown): string {
  const normalized = String(key ?? "")
    .trim()
    .toLowerCase();

  const aliases: Record<string, string> = {
    staff_directory: "employees",
    staff: "employees",
    people: "employees",
    people_management: "employees",
    leave_management: "leave",
    leaves: "leave",
    live_attendance: "liveattendance",
    live_attendance_monitoring: "liveattendance",
    liveattendancemonitoring: "liveattendance",
    live_cctv: "cctv",
    livecctv: "cctv",
  };

  return aliases[normalized] ?? normalized;
}

function staffAllowedModules(user: AuthUser | null | undefined): string[] {
  return Array.from(
    new Set(
      toStringArray(
        user?.allowedModules ??
          user?.accessModules ??
          user?.moduleAccess ??
          user?.access_modules,
      ).map(normalizeModuleKey),
    ),
  );
}

function isDashboardReady(user: AuthUser | null | undefined): boolean {
  if (!user) return false;

  if (typeof user.dashboard_ready === "boolean") return user.dashboard_ready;
  if (typeof user.dashboardReady === "boolean") return user.dashboardReady;

  const role = authRole(user);

  if (role === "staff") return Boolean(staffBranchId(user));

  if (role === "admin") {
    const orgId = toIdOrNull(user.organizationId ?? user.organization_id);
    const status = String(
      user.organizationStatus ?? user.organization_status ?? "missing",
    ).toLowerCase();

    return Boolean(
      orgId && ["active", "launched", "trial", "grace_period"].includes(status),
    );
  }

  return false;
}

function requiresOnboarding(user: AuthUser | null | undefined): boolean {
  if (!user || authRole(user) !== "admin") return false;

  if (typeof user.requires_onboarding === "boolean") {
    return user.requires_onboarding;
  }

  if (typeof user.requiresOnboarding === "boolean") {
    return user.requiresOnboarding;
  }

  return !isDashboardReady(user);
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  allowedRoles,
}) => {
  const { user, isAuthenticated } = useAuth() as {
    user?: AuthUser | null;
    isAuthenticated?: boolean;
  };

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (
    user &&
    allowedRoles.length > 0 &&
    !allowedRoles
      .map((role) => String(role).toLowerCase())
      .includes(String(user.role).toLowerCase())
  ) {
    return <Navigate to="/login" replace />;
  }

  if (isAdminUser(user) && requiresOnboarding(user)) {
    return <Navigate to="/onboarding" replace />;
  }

  if (isStaffUser(user) && user.portalAccess?.desktopDashboard === false) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

const AdminOnlyRoute: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { user } = useAuth() as { user?: AuthUser | null };

  if (!isAdminUser(user)) {
    const branchId = staffBranchId(user);
    return (
      <Navigate
        to={branchId ? `/admin/branch/${branchId}` : "/login"}
        replace
      />
    );
  }

  return <>{children}</>;
};

const AdminHomeRoute: React.FC = () => {
  const { user } = useAuth() as { user?: AuthUser | null };
  const { cfg, isOrgReady } = useOrg();

  if (isStaffUser(user)) {
    const branchId = staffBranchId(user);
    return (
      <Navigate
        to={branchId ? `/admin/branch/${branchId}` : "/login"}
        replace
      />
    );
  }

  if (!isOrgReady) return null;

  const branches = activeConfigBranches(cfg);

  if (branches.length === 1) {
    return <Navigate to={`/admin/branch/${branches[0].id}`} replace />;
  }

  return suspense(<Dashboard />);
};

const BranchesRoute: React.FC = () => {
  const { cfg, isOrgReady } = useOrg();

  if (!isOrgReady) return null;

  const branches = activeConfigBranches(cfg);

  if (branches.length === 1) {
    return <Navigate to={`/admin/branch/${branches[0].id}`} replace />;
  }

  return suspense(<BranchesModule />);
};

const BranchAccessRoute: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { user } = useAuth() as { user?: AuthUser | null };
  const params = useParams<{ branchId?: string }>();

  if (!isStaffUser(user)) return <>{children}</>;

  const ownBranchId = staffBranchId(user);
  const routeBranchId = toIdOrNull(params.branchId);

  if (!ownBranchId) return <Navigate to="/login" replace />;

  if (String(routeBranchId ?? "") !== String(ownBranchId)) {
    return <Navigate to={`/admin/branch/${ownBranchId}`} replace />;
  }

  return <>{children}</>;
};

const BranchSettingsRedirect: React.FC = () => {
  const params = useParams<{ branchId?: string }>();
  return <Navigate to={`/admin/branch/${params.branchId ?? ""}`} replace />;
};

const ModuleAccessRoute: React.FC<{
  moduleKey: string;
  branchScoped: boolean;
  children: React.ReactNode;
}> = ({ moduleKey, branchScoped, children }) => {
  const { user } = useAuth() as { user?: AuthUser | null };
  const { cfg, isOrgReady } = useOrg();
  const params = useParams<{ branchId?: string }>();
  const canonicalKey = normalizeModuleKey(moduleKey);

  if (!isOrgReady) return null;

  if (!isModuleEnabled(cfg.modules, canonicalKey)) {
    return (
      <Navigate
        to={branchScoped ? `/admin/branch/${params.branchId ?? ""}` : "/admin"}
        replace
      />
    );
  }

  if (!isStaffUser(user)) return <>{children}</>;

  const ownBranchId = staffBranchId(user);
  if (!ownBranchId) return <Navigate to="/login" replace />;

  const allowedModules = staffAllowedModules(user);

  if (!allowedModules.includes(canonicalKey)) {
    return <Navigate to={`/admin/branch/${ownBranchId}`} replace />;
  }

  if (!branchScoped) {
    return (
      <Navigate to={`/admin/branch/${ownBranchId}/${canonicalKey}`} replace />
    );
  }

  const routeBranchId = toIdOrNull(params.branchId);

  if (String(routeBranchId ?? "") !== String(ownBranchId)) {
    return (
      <Navigate to={`/admin/branch/${ownBranchId}/${canonicalKey}`} replace />
    );
  }

  return <>{children}</>;
};

const StaffLandingRoute: React.FC = () => {
  const { user, isAuthenticated } = useAuth() as {
    user?: AuthUser | null;
    isAuthenticated?: boolean;
  };

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (isStaffUser(user)) {
    const branchId = staffBranchId(user);
    return (
      <Navigate
        to={branchId ? `/admin/branch/${branchId}` : "/login"}
        replace
      />
    );
  }

  if (isAdminUser(user)) return <Navigate to="/admin" replace />;

  return <Navigate to="/login" replace />;
};

const StaffModuleLandingRoute: React.FC = () => {
  const { user, isAuthenticated } = useAuth() as {
    user?: AuthUser | null;
    isAuthenticated?: boolean;
  };
  const params = useParams<{ moduleKey?: string }>();

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!isStaffUser(user)) return <Navigate to="/admin" replace />;

  const branchId = staffBranchId(user);
  const rawModuleKey = params.moduleKey;

  if (!branchId) return <Navigate to="/login" replace />;

  if (!rawModuleKey) {
    return <Navigate to={`/admin/branch/${branchId}`} replace />;
  }

  const canonicalKey = normalizeModuleKey(rawModuleKey);
  const allowedModules = staffAllowedModules(user);

  if (!allowedModules.includes(canonicalKey)) {
    return <Navigate to={`/admin/branch/${branchId}`} replace />;
  }

  return <Navigate to={`/admin/branch/${branchId}/${canonicalKey}`} replace />;
};

const OnboardingRoute: React.FC = () => {
  const { user, isAuthenticated } = useAuth() as {
    user?: AuthUser | null;
    isAuthenticated?: boolean;
  };

  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (isStaffUser(user)) {
    const branchId = staffBranchId(user);
    return (
      <Navigate
        to={branchId ? `/admin/branch/${branchId}` : "/login"}
        replace
      />
    );
  }

  if (isAdminUser(user) && !requiresOnboarding(user)) {
    return <Navigate to="/admin" replace />;
  }

  return suspense(<OnboardingWizard />);
};

const routableModules = MODULE_REGISTRY.filter(
  (item: ModuleDef) =>
    item.implemented &&
    item.key !== "branches" &&
    item.key !== "settings" &&
    Boolean(item.key),
);

const moduleRoutes = routableModules.map((item: ModuleDef) => ({
  path: item.key,
  element: (
    <ModuleAccessRoute moduleKey={item.key} branchScoped={false}>
      {suspense(<item.Component />)}
    </ModuleAccessRoute>
  ),
}));

const branchModuleRoutes = routableModules.map((item: ModuleDef) => ({
  path: item.key,
  element: (
    <ModuleAccessRoute moduleKey={item.key} branchScoped>
      {suspense(<item.Component />)}
    </ModuleAccessRoute>
  ),
}));

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Navigate to="/login" replace />,
  },
  {
    path: "/login",
    element: suspense(<Login />),
  },
  {
    path: "/onboarding",
    element: <OnboardingRoute />,
  },
  {
    path: "/admin",
    element: (
      <ProtectedRoute allowedRoles={["admin", "staff"]}>
        <OrgConfigProvider>
          <TenantGate>
            <ModuleProvider>{suspense(<AdminLayout />)}</ModuleProvider>
          </TenantGate>
        </OrgConfigProvider>
      </ProtectedRoute>
    ),
    children: [
      {
        index: true,
        element: <AdminHomeRoute />,
      },
      {
        path: "branches",
        element: (
          <AdminOnlyRoute>
            <BranchesRoute />
          </AdminOnlyRoute>
        ),
      },
      {
        path: "settings",
        element: suspense(<AdminSettings />),
      },
      {
        // Personal, self-service account settings (currently: change my
        // own password). Deliberately NOT wrapped in ModuleAccessRoute —
        // this is a "who am I" screen, not an org-configuration module, so
        // it's reachable by every authenticated admin/staff session
        // regardless of the "settings" module grant. See
        // AccountSettings.tsx's file-level note for the full reasoning.
        path: "account-settings",
        element: suspense(<AccountSettings />),
      },
      {
        path: "notifications",
        element: suspense(<NotificationsPage />),
      },
      {
        // Full path: /admin/attendance/exceptions — matches the target_route
        // written by support_db_attendance_exceptions.py exactly. A staff-
        // role manager can land here from their own notification the same
        // way an admin can, same as notifications/settings above are not
        // role-gated at this level either.
        path: "attendance/exceptions",
        element: suspense(<AttendanceExceptionsPage />),
      },
      {
        // Full path: /admin/attendance/payroll-decisions — matches the
        // target_route written by support_db_attendance_exceptions.py's
        // notify_payroll_decision_pending exactly. Deliberately a sibling
        // of attendance/exceptions above, not nested under it: same
        // "still awaiting classification" vs "already classified, awaiting
        // a payroll call" split that keeps the two backend queues (and now
        // the two screens) separate — see client_payroll_decision_routes.py's
        // module docstring.
        path: "attendance/payroll-decisions",
        element: suspense(<PayrollDecisionsPage />),
      },
      {
        path: BRANCH_ROUTE.path,
        element: (
          <BranchAccessRoute>{suspense(<BranchDashboard />)}</BranchAccessRoute>
        ),
        children: [
          {
            index: true,
            element: suspense(<BranchOverviewPage />),
          },
          {
            path: "settings",
            element: <BranchSettingsRedirect />,
          },
          ...branchModuleRoutes,
        ],
      },
      ...moduleRoutes,
    ],
  },
  {
    path: "/hr",
    element: <Navigate to="/admin" replace />,
  },
  {
    path: "/staff",
    element: <StaffLandingRoute />,
  },
  {
    path: "/staff/:moduleKey",
    element: <StaffModuleLandingRoute />,
  },
  ...supportRoutes,
  {
    path: "*",
    element: <Navigate to="/login" replace />,
  },
]);
