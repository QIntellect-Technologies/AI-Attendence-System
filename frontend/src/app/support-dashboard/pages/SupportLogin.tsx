/**
 * src/app/support-dashboard/pages/SupportLogin.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Login page for internal QIntellect team only.
 * Completely separate from the client dashboard /login page.
 * Authenticates against /v1/support/auth/login → internal_users table.
 */

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Eye, EyeOff } from "lucide-react";
import { useSupportAuth } from "../contexts/SupportAuthContext";

const T = {
  navy900: "#0a2540",
  teal600: "#0d9488",
  teal50: "#f0fdfa",
  red500: "#ef4444",
  textBody: "#334155",
  textMuted: "#64748b",
  border: "#e2e8f0",
  bgCard: "#ffffff",
} as const;

export default function SupportLogin() {
  const { login, isAuthenticated } = useSupportAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Already authenticated → redirect into support dashboard
  React.useEffect(() => {
    if (isAuthenticated) navigate("/support/organizations", { replace: true });
  }, [isAuthenticated, navigate]);

  const handleSubmit = async () => {
    if (!email.trim() || !password) return;
    setError(null);
    setIsSubmitting(true);

    try {
      await login(email.trim().toLowerCase(), password);
      navigate("/support/organizations", { replace: true });
    } catch {
      setError("Invalid credentials. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.navy900,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          background: T.bgCard,
          borderRadius: 20,
          padding: "36px 32px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
        }}
      >
        {/* Logo */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            marginBottom: 28,
            gap: 10,
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              background: T.teal50,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Shield size={24} color={T.teal600} />
          </div>
          <div style={{ textAlign: "center" }}>
            <h1
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 900,
                color: T.navy900,
              }}
            >
              Support Portal
            </h1>
            <p
              style={{
                margin: "4px 0 0",
                fontSize: 11,
                color: T.textMuted,
                fontWeight: 500,
              }}
            >
              QIntellect Internal — Authorized Access Only
            </p>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 18,
              fontSize: 12,
              color: T.red500,
              fontWeight: 600,
            }}
          >
            {error}
          </div>
        )}

        {/* Email */}
        <div style={{ marginBottom: 14 }}>
          <label
            style={{
              display: "block",
              fontSize: 11,
              fontWeight: 700,
              color: T.textBody,
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="you@qintellect.com"
            autoComplete="username"
            style={{
              width: "100%",
              padding: "10px 14px",
              fontSize: 13,
              border: `1px solid ${T.border}`,
              borderRadius: 10,
              outline: "none",
              boxSizing: "border-box",
              fontFamily: "inherit",
            }}
          />
        </div>

        {/* Password */}
        <div style={{ marginBottom: 22 }}>
          <label
            style={{
              display: "block",
              fontSize: 11,
              fontWeight: 700,
              color: T.textBody,
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Password
          </label>
          <div style={{ position: "relative" }}>
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="••••••••"
              autoComplete="current-password"
              style={{
                width: "100%",
                padding: "10px 40px 10px 14px",
                fontSize: 13,
                border: `1px solid ${T.border}`,
                borderRadius: 10,
                outline: "none",
                boxSizing: "border-box",
                fontFamily: "inherit",
              }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              style={{
                position: "absolute",
                right: 12,
                top: "50%",
                transform: "translateY(-50%)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                color: T.textMuted,
                display: "flex",
              }}
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={isSubmitting || !email || !password}
          style={{
            width: "100%",
            padding: "11px 0",
            background: isSubmitting ? T.textMuted : T.teal600,
            color: "#fff",
            border: "none",
            borderRadius: 10,
            fontSize: 13,
            fontWeight: 800,
            cursor: isSubmitting ? "not-allowed" : "pointer",
            transition: "background 0.15s",
          }}
        >
          {isSubmitting ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </div>
  );
}
