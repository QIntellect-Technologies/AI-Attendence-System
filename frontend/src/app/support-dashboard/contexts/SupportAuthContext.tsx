/**
 * src/app/support-dashboard/contexts/SupportAuthContext.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Auth context exclusively for internal QIntellect team users.
 *
 * Architecture ref: Section 1
 *   Actor: Support Dashboard | Auth: internal_users table
 *   internal_users has no organization_id — spans all orgs intentionally.
 *
 * Completely isolated from the client AuthContext:
 *   - Separate localStorage key: 'support_access_token'
 *   - Separate endpoints:        /v1/support/auth/*
 *   - Separate 401 redirect:     /support/login (never /login)
 *
 * RESPONSE SHAPES (matched to support_routes.py):
 *   POST /v1/support/auth/login → { success, user, token }   ← field is 'token'
 *   GET  /v1/support/auth/me   → { success, user }           ← unwrap .user
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getSupportToken,
  setSupportToken,
  clearSupportToken,
  supportApiClient,
} from "../api/supportApiClient";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SupportUserRole =
  | "super_admin"
  | "admin"
  | "support"
  | "support_agent"
  | "billing"
  | "billing_admin"
  | "operations";

export interface SupportUser {
  id: string;
  email: string;
  full_name: string;
  role: SupportUserRole;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

interface SupportAuthState {
  user: SupportUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

interface SupportAuthActions {
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

type SupportAuthContextValue = SupportAuthState & SupportAuthActions;

// ─── Flask response envelopes ─────────────────────────────────────────────────
// support_routes.py wraps every response in { success: bool, ...data }.

interface LoginResponse {
  success: boolean;
  token: string; // field is 'token', not 'access_token'
  user: SupportUser;
}

interface MeResponse {
  success: boolean;
  user: SupportUser; // nested under 'user', not at root
}

// ─── Context ──────────────────────────────────────────────────────────────────

const SupportAuthContext = createContext<SupportAuthContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export const SupportAuthProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<SupportUser | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  /**
   * On mount: if a token exists in localStorage, validate it by calling
   * /v1/support/auth/me. If the token is expired or invalid, the
   * supportApiClient interceptor clears it and redirects to /support/login.
   * Here we just clean up local state on any failure.
   */
  useEffect(() => {
    const token = getSupportToken();
    if (!token) {
      setIsLoading(false);
      return;
    }

    supportApiClient
      .get<MeResponse>("/v1/support/auth/me")
      .then((res) => setUser(res.data.user)) // ← unwrap nested .user
      .catch(() => {
        // Token invalid or expired — interceptor handles redirect
        clearSupportToken();
        setUser(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  /**
   * login() — called by SupportLogin.tsx on form submit.
   * Stores the JWT and sets user state.
   * Throws on failure so the login page can display the error.
   */
  const login = useCallback(async (email: string, password: string) => {
    const res = await supportApiClient.post<LoginResponse>(
      "/v1/support/auth/login",
      { email, password },
    );
    setSupportToken(res.data.token); // ← field is 'token', not 'access_token'
    setUser(res.data.user);
  }, []);

  /**
   * logout() — revokes the session server-side, then clears the token and
   * user, then hard-redirects to /support/login.
   *
   * Previously client-side only (cleared localStorage, never told the
   * backend) -- a token copied off a shared/public machine stayed valid
   * for up to 8h regardless of clicking logout. POST /v1/support/auth/logout
   * (support_routes.py) now revokes it immediately via session_registry.
   * Fire-and-forget: logout must not block on the network, and the token
   * is cleared client-side below unconditionally either way. Uses
   * supportApiClient directly rather than awaiting so a slow/failed
   * network call never delays the redirect.
   */
  const logout = useCallback(() => {
    void supportApiClient.post("/v1/support/auth/logout").catch(() => {
      // Network/server failure is not actionable here -- the token is
      // cleared client-side below regardless, and it will simply expire
      // naturally (up to 8h) if this call didn't land.
    });
    clearSupportToken();
    setUser(null);
    window.location.replace("/support/login");
  }, []);

  const value = useMemo<SupportAuthContextValue>(
    () => ({
      user,
      isAuthenticated: Boolean(user),
      isLoading,
      login,
      logout,
    }),
    [user, isLoading, login, logout],
  );

  return (
    <SupportAuthContext.Provider value={value}>
      {children}
    </SupportAuthContext.Provider>
  );
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export const useSupportAuth = (): SupportAuthContextValue => {
  const ctx = useContext(SupportAuthContext);
  if (!ctx) {
    throw new Error(
      "useSupportAuth must be used inside <SupportAuthProvider>. " +
        "Wrap your support routes with <SupportAuthProvider> in the router.",
    );
  }
  return ctx;
};
