/**
 * AuthContext.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for authentication state.
 *
 * Production behaviour:
 *   • Signup creates a pending admin account.
 *   • Admin dashboard access requires a launched organization.
 *   • Staff dashboard access remains branch/module scoped.
 *   • Organization cache is cleared when user/org changes so one tenant never
 *     sees another tenant's config.
 *
 * Converted from AuthContext.jsx -> .tsx so consumers (useAuth, App.tsx,
 * TenantConfigContext, etc.) get real compile-time types instead of the
 * context silently degrading to `never` after the `useAuth` null-guard.
 */

import React, {
  createContext,
  useState,
  useCallback,
  useMemo,
  ReactNode,
} from "react";
import Swal from "sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Normalized authenticated user shape.
 *
 * Fields that exist in both snake_case and camelCase are kept as explicit
 * properties (matching the dual-key normalization below) so every existing
 * call site (`user.organization_id` and `user.organizationId`) type-checks.
 * The index signature preserves pass-through backend fields (name, email,
 * department, etc.) without re-declaring the full User shape already defined
 * in `src/api.ts` — avoids duplicating that interface here.
 */
export interface AuthUser {
  id?: string | number;
  source?: string;

  role: string;

  organizationId: number | string | null;
  organization_id: number | string | null;
  organizationStatus: string;
  organization_status: string;

  dashboardReady: boolean;
  dashboard_ready: boolean;
  requiresOnboarding: boolean;
  requires_onboarding: boolean;

  branchId: number | string | null;
  branch_id: number | string | null;
  branchName: string;
  branch_name: string;

  profileImageUrl: string;
  profile_image_url: string;
  avatarUrl: string;
  photo_url: string;
  profileImageName: string;
  profile_image_name: string;

  access_modules: string[];
  allowedModules: string[];
  moduleAccess: string[];
  accessModules: string[];
  allowedBranchIds: string[];

  dashboardScope?: "branch" | "global";
  portalAccess?: {
    desktopDashboard: boolean;
    flutterStaffPortal: boolean;
  };

  // NOT the same field as `dashboardScope` above, despite the name — that
  // one is overwritten unconditionally below (branch-vs-global dashboard
  // SHELL routing) and no longer reflects what the backend sent. This
  // snake_case field is left untouched by normaliseUser, so it's the only
  // reliable client-side read of the REAL client_staff.dashboard_scope
  // value ('team' = manager sees only get_subordinate_ids(); 'branch' =
  // unrestricted, today's default). Undefined for client_users/admin
  // logins, which don't have this column. Any UI that needs to know "is
  // this session's Client Dashboard visibility narrowed to a manager's
  // own reporting team" MUST read this field, never `dashboardScope`.
  // See client_dashboard_auth.py's get_team_scope_ids docstring.
  dashboard_scope?: "branch" | "team";

  [key: string]: unknown;
}

type RawUser = Record<string, unknown> | null | undefined;

export interface AuthActionResult {
  success: boolean;
  message?: string;
  user?: AuthUser | null;
  requires_onboarding?: boolean;
  dashboard_ready?: boolean;
}

export interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<AuthActionResult>;
  signup: (
    name: string,
    email: string,
    password: string,
    companyLogo?: string | null,
  ) => Promise<AuthActionResult>;
  logout: () => void;
  refreshUser: (userId?: string | number) => Promise<AuthUser | null>;
  clearOrganizationStorage: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const STORAGE_KEY_USER = "currentUser";
const STORAGE_KEY_AUTH = "isAuthenticated";
const ORG_STORAGE_PREFIX = "orgConfig:";
const LEGACY_ORG_STORAGE_KEY = "orgConfig";

// Same storage key as modules/staff/api/staffApi.ts's
// getDashboardAuthToken/setDashboardAuthToken, src/api.ts's
// DASHBOARD_AUTH_TOKEN_KEY, and apiClient.ts's AUTH_TOKEN_STORAGE_KEY.
// Written here directly (rather than imported) since this file's actual
// location relative to modules/staff/api/ isn't known with confidence —
// apiClient.ts made the same call for the same reason. If this key ever
// changes, grep "dashboardAuthToken" and update every copy.
const DASHBOARD_AUTH_TOKEN_KEY = "dashboardAuthToken";

function persistDashboardAuthToken(token: unknown): void {
  try {
    const text = typeof token === "string" ? token.trim() : "";
    if (text) {
      localStorage.setItem(DASHBOARD_AUTH_TOKEN_KEY, text);
    } else {
      localStorage.removeItem(DASHBOARD_AUTH_TOKEN_KEY);
    }
  } catch {
    // Ignore storage access errors (private browsing, quota, etc.).
  }
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

function readStoredUserRaw(): RawUser {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clearOrganizationStorage(): void {
  try {
    localStorage.removeItem(LEGACY_ORG_STORAGE_KEY);
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith(ORG_STORAGE_PREFIX)) {
        localStorage.removeItem(key);
      }
    });
  } catch {
    // Ignore storage access errors.
  }
}

function readStoredUser(): AuthUser | null {
  return normaliseUser(readStoredUserRaw());
}

function persistUser(user: AuthUser): void {
  localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  localStorage.setItem(STORAGE_KEY_AUTH, "true");
}

function clearStorage(): void {
  localStorage.removeItem(STORAGE_KEY_USER);
  localStorage.removeItem(STORAGE_KEY_AUTH);
  clearOrganizationStorage();
  persistDashboardAuthToken(null);
}

function boolFromBackend(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    return ["1", "true", "yes", "active", "ready"].includes(
      value.trim().toLowerCase(),
    );
  }
  return fallback;
}

function normaliseUser(user: RawUser): AuthUser | null {
  if (!user) return null;

  const { password: _password, ...safe } = user as Record<string, unknown> & {
    password?: unknown;
  };

  const role = String(safe.role || "staff").toLowerCase();
  // Org-level accounts come from client_users, which is admin-only now
  // (the HR co-admin tier was removed — see role_permissions.py). 'hr' is
  // still matched here as a compatibility fallback for any client_users
  // row not yet migrated off the old value; once every row is confirmed
  // migrated to role='admin', this can drop to `role === "admin"`. Every
  // other role (staff, and a client_staff row promoted to role='admin')
  // is a client_staff-origin account, still anchored to one branch.
  const isOrgLevelRole = role === "admin" || role === "hr";
  const branchId = toIdOrNull(safe.branchId ?? safe.branch_id);
  const organizationId = toIdOrNull(
    safe.organizationId ?? safe.organization_id,
  );
  const accessModules = toStringArray(
    safe.allowedModules ??
      safe.moduleAccess ??
      safe.accessModules ??
      safe.access_modules,
  );
  const profileImageUrl = String(
    safe.profileImageUrl ??
      safe.profile_image_url ??
      safe.avatarUrl ??
      safe.photo_url ??
      "",
  );
  const profileImageName = String(
    safe.profileImageName ?? safe.profile_image_name ?? "",
  );
  const allowedBranchIds = toStringArray(safe.allowedBranchIds);

  const organizationStatus = String(
    safe.organizationStatus ?? safe.organization_status ?? "missing",
  ).toLowerCase();

  const backendDashboardReady =
    safe.dashboardReady ?? safe.dashboard_ready ?? safe.isDashboardReady;

  const inferredDashboardReady = isOrgLevelRole
    ? Boolean(
        organizationId &&
        ["active", "launched", "trial"].includes(organizationStatus),
      )
    : Boolean(organizationId && branchId);

  const dashboardReady = boolFromBackend(
    backendDashboardReady,
    inferredDashboardReady,
  );

  // Onboarding is an admin-only flow (the org's first login walks through
  // setup) — hr and every branch-anchored role join an already-onboarded
  // org, so this stays scoped to 'admin' specifically, not isOrgLevelRole.
  const requiresOnboarding =
    role === "admin"
      ? boolFromBackend(
          safe.requiresOnboarding ?? safe.requires_onboarding,
          !dashboardReady,
        )
      : false;

  const normalized: AuthUser = {
    ...safe,
    role,
    organizationId,
    organization_id: organizationId,
    organizationStatus,
    organization_status: organizationStatus,
    dashboardReady,
    dashboard_ready: dashboardReady,
    requiresOnboarding,
    requires_onboarding: requiresOnboarding,
    branchId,
    branch_id: branchId,
    branchName: String(safe.branchName ?? safe.branch_name ?? ""),
    branch_name: String(safe.branch_name ?? safe.branchName ?? ""),
    profileImageUrl,
    profile_image_url: profileImageUrl,
    avatarUrl: profileImageUrl,
    photo_url: profileImageUrl,
    profileImageName,
    profile_image_name: profileImageName,
    access_modules: accessModules,
    allowedModules: accessModules,
    moduleAccess: accessModules,
    accessModules,
    allowedBranchIds:
      allowedBranchIds.length > 0
        ? allowedBranchIds
        : branchId
          ? [String(branchId)]
          : [],
  };

  if (isOrgLevelRole) {
    // admin and hr: org-wide shell, no mobile field-staff portal. What
    // actually differs between the two (which modules hr can reach) is
    // enforced by the backend's access_modules claim, not here.
    normalized.dashboardScope = "global";
    normalized.portalAccess = {
      ...(safe.portalAccess as Record<string, unknown> | undefined),
      desktopDashboard: dashboardReady,
      flutterStaffPortal: false,
    };
  } else {
    // staff, manager, employee — and any other client_staff-origin role —
    // stay branch-anchored in the desktop shell. Real per-role permission
    // ceilings (e.g. a 'manager' promoted with dashboard_scope='team')
    // come from the backend token, not from this shell-routing flag.
    normalized.dashboardScope = "branch";
    normalized.portalAccess = {
      ...(safe.portalAccess as Record<string, unknown> | undefined),
      desktopDashboard: dashboardReady,
      flutterStaffPortal: true,
    };
  }

  return normalized;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser());
  const [isAuthenticated, setIsAuth] = useState<boolean>(() =>
    Boolean(readStoredUser()),
  );

  const _commitUser = useCallback((rawUser: RawUser): AuthUser | null => {
    const previous = readStoredUser();
    const safe = normaliseUser(rawUser);

    const userChanged =
      Boolean(previous?.id) &&
      Boolean(safe?.id) &&
      String(previous?.id) !== String(safe?.id);
    const orgChanged =
      Boolean(previous) &&
      Boolean(safe) &&
      String(previous?.organization_id ?? "") !==
        String(safe?.organization_id ?? "");

    if (!safe || userChanged || orgChanged || safe.requires_onboarding) {
      clearOrganizationStorage();
    }

    // Preserve organization_id across refresh cycles for the same user.
    // A valid session never loses org affiliation — an empty org_id in a
    // refresh response means the response is incomplete, not that the user
    // left their organization. This prevents the "Organization is not loaded
    // yet" flash on the Branches page between render cycles.
    if (
      safe &&
      previous &&
      !userChanged &&
      !safe.organization_id &&
      previous.organization_id
    ) {
      safe.organization_id = previous.organization_id;
      safe.organizationId = previous.organization_id;
    }

    setUser(safe);
    setIsAuth(Boolean(safe));

    if (safe) {
      persistUser(safe);
    } else {
      clearStorage();
    }

    return safe;
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      try {
        clearOrganizationStorage();

        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password }),
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          return {
            success: false,
            message: data.message || "Invalid credentials.",
          };
        }

        // /api/login now mints a Client Dashboard JWT alongside the user
        // payload (client_dashboard_auth.mint_dashboard_token) — persist it
        // so every subsequent request through api.ts/apiClient.ts/
        // staffApi.ts carries the Bearer token the newly-gated routes
        // (/api/staff, /api/attendance, /api/leaves, /api/overtime) require.
        // A pre-migration session has no token and will 401 on those routes
        // until this re-login happens — the agreed, one-time trade.
        persistDashboardAuthToken(data.token);

        const committed = _commitUser(data.user);
        return {
          success: true,
          user: committed,
          requires_onboarding: Boolean(committed?.requires_onboarding),
          dashboard_ready: Boolean(committed?.dashboard_ready),
          message: data.message,
        };
      } catch {
        return {
          success: false,
          message: "Cannot reach server. Is Flask running on port 5000?",
        };
      }
    },
    [_commitUser],
  );

  const signup = useCallback(
    async (
      name: string,
      email: string,
      password: string,
      companyLogo: string | null = null,
    ): Promise<AuthActionResult> => {
      try {
        clearOrganizationStorage();

        const res = await fetch("/api/staff", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            email,
            password,
            role: "admin",
            department: "",
            staff_type: "office",
            access_modules: [],
          }),
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          return {
            success: false,
            message:
              data.message ||
              "Signup failed. This email may already be registered.",
          };
        }

        const newUser = {
          ...data.user,
          dashboard_ready: false,
          dashboardReady: false,
          requires_onboarding: true,
          requiresOnboarding: true,
          organization_status: "missing",
          organizationStatus: "missing",
          ...(companyLogo ? { companyLogo } : {}),
        };
        const committed = _commitUser(newUser);
        return { success: true, user: committed, requires_onboarding: true };
      } catch {
        return {
          success: false,
          message: "Cannot reach server. Is Flask running on port 5000?",
        };
      }
    },
    [_commitUser],
  );

  const logout = useCallback((): void => {
    // Best-effort server-side revocation (session_registry.end_session)
    // BEFORE clearing local storage below -- makes the token unusable
    // immediately rather than leaving it valid until natural expiry (up to
    // 12h). Previously this function was 100% client-side: it cleared
    // localStorage but never told the backend, so a stolen/leaked token
    // stayed live regardless of the user clicking "logout". Deliberately
    // fire-and-forget: logout must never block on the network, and the
    // user is taken out of the UI below regardless of whether this call
    // succeeds -- a failed revocation is a rarer follow-up problem (the
    // token still expires naturally), not a reason to trap the user in a
    // "logging out..." state.
    try {
      const token = localStorage.getItem(DASHBOARD_AUTH_TOKEN_KEY);
      if (token) {
        void fetch("/api/client/auth/logout", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {
          // Network/server failure is not actionable here -- client-side
          // storage is cleared unconditionally below either way.
        });
      }
    } catch {
      // Ignore storage access errors (private browsing, quota, etc.).
    }

    setUser(null);
    setIsAuth(false);
    clearStorage();

    void Swal.fire({
      icon: "success",
      title: "Logged out",
      text: "You have been signed out.",
      timer: 1400,
      timerProgressBar: true,
      showConfirmButton: false,
      allowOutsideClick: false,
      allowEscapeKey: false,
      allowEnterKey: false,
    }).then(() => {
      window.location.replace("/login");
    });
  }, []);

  const refreshUser = useCallback(
    async (userId?: string | number): Promise<AuthUser | null> => {
      try {
        const current = readStoredUser();
        const source = String(current?.source || "");
        const rawId = String(userId ?? current?.id ?? "").trim();
        const isUuidLike =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            rawId,
          );

        const url =
          source === "client_users" || isUuidLike
            ? `/api/client/session/${encodeURIComponent(rawId)}`
            : `/api/users/${encodeURIComponent(rawId)}`;

        const storedToken = (() => {
          try {
            return localStorage.getItem(DASHBOARD_AUTH_TOKEN_KEY);
          } catch {
            return null;
          }
        })();

        const res = await fetch(url, {
          cache: "no-store",
          headers: {
            Accept: "application/json",
            ...(storedToken ? { Authorization: `Bearer ${storedToken}` } : {}),
          },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const updated = data?.user ?? data;
        const committed = _commitUser(updated);
        return committed;
      } catch {
        return null;
      }
    },
    [_commitUser],
  );

  // Memoised deliberately. This was a fresh object literal on every render,
  // so every useAuth() consumer in the app — and there are many, including
  // the providers wrapping the whole dashboard — was forced to re-render
  // whenever AuthProvider rendered for any reason, even when user and
  // isAuthenticated were unchanged. All the callbacks below are already
  // useCallback-stable, so this value now changes only when the auth state
  // actually changes.
  const contextValue = useMemo(
    () => ({
      user,
      isAuthenticated,
      login,
      signup,
      logout,
      refreshUser,
      clearOrganizationStorage,
    }),
    [
      user,
      isAuthenticated,
      login,
      signup,
      logout,
      refreshUser,
      clearOrganizationStorage,
    ],
  );

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  );
};

export { AuthContext };
