import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toastSuccess, toastError } from "../utils/notifications";
import { useAuth } from "../contexts/useAuth";
import {
  Mail,
  Lock,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
} from "lucide-react";
import {
  A,
  SplitAuthLayout,
  BrandPanel,
  AuthCard,
  AuthLabel,
  AuthInput,
  AuthButton,
  AuthError,
} from "../components/auth/AuthShared";

interface AuthUser {
  id?: number | string;
  role?: string;
  branchId?: number | string | null;
  branch_id?: number | string | null;
  organizationId?: number | string | null;
  organization_id?: number | string | null;
  organizationStatus?: string | null;
  organization_status?: string | null;
  dashboardReady?: boolean;
  dashboard_ready?: boolean;
  requiresOnboarding?: boolean;
  requires_onboarding?: boolean;
}

interface AuthContextValue {
  user?: AuthUser | null;
  login: (
    email: string,
    password: string,
  ) => Promise<{
    success: boolean;
    user?: AuthUser | null;
    message?: string;
    dashboard_ready?: boolean;
    requires_onboarding?: boolean;
  }>;
  logout?: () => void;
}

const BULLETS = [
  "GPS Field Staff Tracking",
  "Real-time Attendance Logs",
  "Role-based Access Control",
  "Payroll & Leave Management",
  "Real-time Reports & Analytics",
];

// ── Auth routing helpers ──────────────────────────────────────────────────────
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

function boolFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (["1", "true", "yes", "ready", "active", "launched"].includes(raw)) {
      return true;
    }
    if (["0", "false", "no", "missing", "pending", "draft"].includes(raw)) {
      return false;
    }
  }
  return null;
}

function isAdminPendingOnboarding(user?: AuthUser | null): boolean {
  if (!user || String(user.role ?? "").toLowerCase() !== "admin") return false;

  const explicitRequires = boolFlag(
    user.requires_onboarding ?? user.requiresOnboarding,
  );
  if (explicitRequires === true) return true;
  if (explicitRequires === false) return false;

  const explicitDashboardReady = boolFlag(
    user.dashboard_ready ?? user.dashboardReady,
  );
  if (explicitDashboardReady === true) return false;

  const organizationId = toIdOrNull(
    user.organizationId ?? user.organization_id,
  );
  const organizationStatus = String(
    user.organizationStatus ?? user.organization_status ?? "missing",
  )
    .trim()
    .toLowerCase();

  if (
    organizationId &&
    ["active", "launched", "trial"].includes(organizationStatus)
  ) {
    return false;
  }

  return (
    !organizationId ||
    ["", "missing", "pending", "draft"].includes(organizationStatus)
  );
}

function dashboardFor(user?: AuthUser | null): string {
  const role = String(user?.role ?? "").toLowerCase();

  // client_users is admin-only now (the HR co-admin tier was removed —
  // see role_permissions.py). This also covers any pre-migration row that
  // still has the old role='hr' value in the database, so it keeps working
  // during the rollout window instead of dead-ending at /login.
  if (role === "admin" || role === "hr") {
    return isAdminPendingOnboarding(user) ? "/onboarding" : "/admin";
  }

  if (role === "staff") {
    const branchId = toIdOrNull(user?.branchId ?? user?.branch_id);
    return branchId ? `/admin/branch/${branchId}` : "/login";
  }

  return "/staff";
}

// ─────────────────────────────────────────────────────────────────────────────
const Login: React.FC = () => {
  const navigate = useNavigate();
  const { login, user, logout } = useAuth() as AuthContextValue;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [loginRequiresOnboarding, setLoginRequiresOnboarding] = useState(false);

  const storedUserNeedsOnboarding = isAdminPendingOnboarding(user);
  const showManualOnboarding =
    storedUserNeedsOnboarding || loginRequiresOnboarding;

  const continueOnboarding = () => {
    navigate("/onboarding", { replace: true });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess(false);
    setLoginRequiresOnboarding(false);
    setLoading(true);

    // login() always resolves — returns { success, user?, message? }
    const result = await login(email, password);

    if (result.success) {
      const needsOnboarding = isAdminPendingOnboarding(result.user);
      setSuccess(true);
      setLoginRequiresOnboarding(needsOnboarding);

      toastSuccess("Logged in successfully.");

      setTimeout(
        () => {
          navigate(dashboardFor(result.user), { replace: true });
        },
        needsOnboarding ? 1200 : 900,
      );
    } else {
      const message =
        result.message || "Invalid email or password. Please try again.";
      setError(message);
      toastError(message);
    }

    setLoading(false);
  };

  return (
    <SplitAuthLayout
      left={<BrandPanel bullets={BULLETS} />}
      right={
        <AuthCard>
          {/* Heading */}
          <div
            className="auth-fade"
            style={{
              animationDelay: "0.12s",
              marginBottom: 24,
              textAlign: "center",
            }}
          >
            <h2
              style={{
                fontFamily: "var(--font-heading)",
                fontSize: 28,
                fontWeight: 800,
                color: A.primaryDarker,
                margin: "0 0 10px",
                letterSpacing: -0.7,
              }}
            >
              {success
                ? loginRequiresOnboarding
                  ? "Continue setup"
                  : "Welcome back! 👋"
                : storedUserNeedsOnboarding
                  ? "Organization setup pending"
                  : "Sign in to your account"}
            </h2>
            <p style={{ fontSize: 14, color: A.textSub, lineHeight: 1.7 }}>
              {success
                ? loginRequiresOnboarding
                  ? "Your account is verified. Finish onboarding to launch your organization."
                  : "Redirecting to your dashboard…"
                : storedUserNeedsOnboarding
                  ? "This account has not launched an organization yet. Continue setup when you are ready."
                  : "Enter your credentials"}
            </p>
          </div>

          {/* Manual onboarding recovery option — only pending admin accounts */}
          {storedUserNeedsOnboarding && !success && (
            <div
              className="auth-fade"
              style={{
                animationDelay: "0.15s",
                background: "#fffbeb",
                border: "1px solid #fde68a",
                borderRadius: 16,
                padding: "14px 14px",
                marginBottom: 18,
              }}
            >
              <div
                style={{ display: "flex", gap: 10, alignItems: "flex-start" }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 10,
                    background: "#fef3c7",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <ClipboardList size={17} color="#b45309" strokeWidth={2.4} />
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 800,
                      color: "#92400e",
                      marginBottom: 4,
                    }}
                  >
                    Organization setup is incomplete
                  </div>
                  <p
                    style={{
                      fontSize: 12,
                      color: "#92400e",
                      lineHeight: 1.6,
                      margin: "0 0 12px",
                    }}
                  >
                    You can continue onboarding manually. The dashboard will
                    unlock only after your organization is configured and
                    launched.
                  </p>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={continueOnboarding}
                      style={{
                        border: "none",
                        borderRadius: 10,
                        padding: "9px 12px",
                        background: A.primary,
                        color: "#fff",
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      Continue Organization Setup
                    </button>
                    {logout && (
                      <button
                        type="button"
                        onClick={logout}
                        style={{
                          border: "1px solid #fde68a",
                          borderRadius: 10,
                          padding: "9px 12px",
                          background: "#fff",
                          color: "#92400e",
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        Use another account
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Success banner */}
          {success && (
            <div
              style={{
                background: loginRequiresOnboarding ? "#fffbeb" : "#f0fdfa",
                border: loginRequiresOnboarding
                  ? "1px solid #fde68a"
                  : "1px solid #99f6e4",
                borderRadius: 14,
                padding: "12px 14px",
                fontSize: 13,
                color: loginRequiresOnboarding ? "#92400e" : A.success,
                fontWeight: 500,
                marginBottom: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <CheckCircle2 size={16} />{" "}
                {loginRequiresOnboarding
                  ? "Login successful — organization setup is pending."
                  : "Login successful — redirecting…"}
              </span>
              {loginRequiresOnboarding && (
                <button
                  type="button"
                  onClick={continueOnboarding}
                  style={{
                    border: "none",
                    borderRadius: 9,
                    padding: "7px 10px",
                    background: A.primary,
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    whiteSpace: "nowrap",
                  }}
                >
                  Open setup
                </button>
              )}
            </div>
          )}

          {error && <AuthError message={error} />}

          {/* Form */}
          <form
            onSubmit={handleSubmit}
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
          >
            <div className="auth-fade" style={{ animationDelay: "0.18s" }}>
              <AuthLabel>Work Email</AuthLabel>
              <AuthInput
                type="email"
                value={email}
                required
                placeholder="name@company.com"
                leftIcon={<Mail size={16} color={A.textMuted} />}
                maxLength={254}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setSuccess(false);
                  setLoginRequiresOnboarding(false);
                }}
              />
            </div>

            <div className="auth-fade" style={{ animationDelay: "0.24s" }}>
              <AuthLabel>Password</AuthLabel>
              <AuthInput
                type={showPw ? "text" : "password"}
                value={password}
                required
                placeholder="••••••••"
                leftIcon={<Lock size={16} color={A.textMuted} />}
                maxLength={128}
                rightToggle={{
                  show: showPw,
                  onToggle: () => setShowPw((v) => !v),
                }}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setSuccess(false);
                  setLoginRequiresOnboarding(false);
                }}
              />
            </div>

            <div className="auth-fade" style={{ animationDelay: "0.30s" }}>
              <AuthButton
                loading={loading || success}
                loadingLabel={
                  success
                    ? loginRequiresOnboarding
                      ? "Opening setup…"
                      : "Redirecting…"
                    : "Signing in…"
                }
              >
                {success ? (
                  <>
                    <CheckCircle2 size={16} />{" "}
                    {loginRequiresOnboarding ? "Opening Setup" : "Signed In"}
                  </>
                ) : (
                  <>
                    <span>Sign In</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </AuthButton>
            </div>
          </form>
        </AuthCard>
      }
    />
  );
};

export default Login;