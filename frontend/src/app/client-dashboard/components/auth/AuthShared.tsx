/**
 * AuthShared.tsx — DRY primitives shared by Login + Signup
 * BrandPanel | SplitAuthLayout | AuthInput | AuthButton | AuthDivider
 */
import React, { type ReactNode, type InputHTMLAttributes } from "react";
import { Eye, EyeOff, Check, Fingerprint } from "lucide-react";

// ─── TOKENS (match theme.css exactly) ────────────────────────────────────────
export const A = {
  primary: "#1a699f",
  primaryDark: "#155580",
  primaryDarker: "#0d3f61",
  tealLight: "#e6f3f9",
  tealMedium: "#b8dcee",
  tealPale: "#f0f8fc",
  tealSidebar: "#d6f1e8",
  white: "#ffffff",
  text: "#0f172a",
  textSub: "#475569",
  textMuted: "#94a3b8",
  border: "#e2e8f0",
  bg: "#f0f8fc",
  success: "#0f766e",
  error: "#dc2626",
  errorLight: "#fef2f2",
} as const;

// ─── GLOBAL AUTH STYLES (inject once per page) ────────────────────────────────
export const AUTH_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=DM+Serif+Display:ital@0;1&display=swap');
  *, *::before, *::after { box-sizing: border-box; }

  @keyframes slide-in-left  { from { opacity:0; transform:translateX(-32px) } to { opacity:1; transform:translateX(0) } }
  @keyframes slide-in-right { from { opacity:0; transform:translateX(32px)  } to { opacity:1; transform:translateX(0) } }
  @keyframes fade-up        { from { opacity:0; transform:translateY(18px)  } to { opacity:1; transform:translateY(0) } }
  @keyframes spin-auth      { to   { transform:rotate(360deg) } }

  .auth-left  { animation: slide-in-left  0.65s cubic-bezier(.22,1,.36,1) both; }
  .auth-right { animation: slide-in-right 0.65s cubic-bezier(.22,1,.36,1) 0.08s both; }
  .auth-fade  { animation: fade-up 0.45s cubic-bezier(.22,1,.36,1) both; }

  .auth-input {
    width:100%; padding:13px 16px; border-radius:14px; outline:none;
    border:1.5px solid ${A.border}; font-size:14px; color:${A.text};
    background:${A.white}; transition:border-color .15s, box-shadow .15s;
    font-family:inherit;
  }
  .auth-input:focus {
    border-color:${A.primary} !important;
    box-shadow:0 0 0 3px rgba(26,105,159,.12) !important;
  }
  .auth-input::placeholder { color:${A.textMuted}; }
  .auth-input-icon { padding-left:42px !important; }

  .auth-btn {
    width:100%; padding:14px; border-radius:14px; border:none;
    background:linear-gradient(135deg, ${A.primary} 0%, ${A.primaryDark} 100%);
    color:#fff; font-size:15px; font-weight:700; cursor:pointer;
    display:flex; align-items:center; justify-content:center; gap:8px;
    transition:filter .2s, transform .15s; font-family:inherit; letter-spacing:-0.2px;
  }
  .auth-btn:hover:not(:disabled) { filter:brightness(1.06); transform:translateY(-1px); }
  .auth-btn:active:not(:disabled){ transform:translateY(0); }
  .auth-btn:disabled { opacity:0.65; cursor:not-allowed; }

  .auth-link { color:${A.primary}; font-weight:600; text-decoration:none; }
  .auth-link:hover { text-decoration:underline; }

  .auth-role-btn {
    padding:12px 14px; border-radius:12px; cursor:pointer;
    border:1.5px solid ${A.border}; background:#fff;
    text-align:left; font-family:inherit; transition:all 0.15s;
  }
  .auth-role-btn:hover { border-color:${A.primary}; background:${A.tealLight}; }

  ::-webkit-scrollbar { width:6px; }
  ::-webkit-scrollbar-thumb { background:${A.tealMedium}; border-radius:10px; }
`;

// ─── BRAND PANEL (left side — same on both pages) ─────────────────────────────
interface BrandPanelProps {
  bullets: string[];
  illustration?: ReactNode;
  footer?: ReactNode;
}
export const BrandPanel: React.FC<BrandPanelProps> = ({
  bullets,
  illustration,
  footer,
}) => (
  <div
    className="auth-left"
    style={{
      width: "48%",
      minWidth: 460,
      position: "relative",
      overflow: "hidden",
      background: `linear-gradient(180deg, ${A.tealSidebar} 0%, ${A.tealPale} 48%, ${A.tealLight} 100%)`,
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "56px 56px 42px",
      borderRight: `1px solid ${A.border}`,
    }}
  >
    {/* Decorative blobs */}
    <div
      style={{
        position: "absolute",
        width: 220,
        height: 220,
        borderRadius: "50%",
        background: "rgba(255,255,255,0.08)",
        top: -40,
        right: -40,
        pointerEvents: "none",
      }}
    />
    <div
      style={{
        position: "absolute",
        width: 110,
        height: 110,
        borderRadius: "50%",
        background: "rgba(255,255,255,0.06)",
        bottom: 18,
        left: -28,
        pointerEvents: "none",
      }}
    />

    {/* Top: wordmark + headline + bullets */}
    <div style={{ position: "relative", zIndex: 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            flexShrink: 0,
            background: `linear-gradient(135deg, ${A.primary}, ${A.primaryDark})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Fingerprint size={20} color="#fff" />
        </div>
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: A.textMuted,
            fontFamily: "var(--font-heading)",
          }}
        >
          QIntellect Technologies
        </span>
      </div>

      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 44,
          fontWeight: 800,
          lineHeight: 1.08,
          margin: 0,
          maxWidth: 430,
          letterSpacing: -1.2,
          color: A.text,
        }}
      >
        Revolutionize
        <br />
        Attendance with AI
      </h1>

      <div style={{ marginTop: 28, display: "grid", gap: 12, maxWidth: 400 }}>
        {bullets.map((text) => (
          <div
            key={text}
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                flexShrink: 0,
                background: "rgba(26,105,159,0.08)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Check size={14} color={A.primary} strokeWidth={3} />
            </div>
            <span style={{ fontSize: 15, fontWeight: 500, color: A.text }}>
              {text}
            </span>
          </div>
        ))}
      </div>
    </div>

    {/* Middle: illustration slot */}
    {illustration && (
      <div style={{ position: "relative", marginTop: 28, zIndex: 1 }}>
        {illustration}
      </div>
    )}

    {/* Bottom: footer links */}
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 18,
        color: A.textMuted,
        fontSize: 12,
        marginTop: 40,
        position: "relative",
        zIndex: 1,
      }}
    >
      {footer ?? (
        <>
          <span style={{ cursor: "pointer" }}>Terms of Service</span>
          <span style={{ cursor: "pointer" }}>Privacy Policy</span>
          <span>© QIntellect Technologies</span>
        </>
      )}
    </div>
  </div>
);

// ─── SPLIT LAYOUT WRAPPER ─────────────────────────────────────────────────────
export const SplitAuthLayout: React.FC<{
  left: ReactNode;
  right: ReactNode;
}> = ({ left, right }) => (
  <div
    style={{
      display: "flex",
      height: "100vh",
      fontFamily: "var(--font-body)",
      overflow: "hidden",
      background: A.bg,
    }}
  >
    <style>{AUTH_CSS}</style>
    {left}
    {right}
  </div>
);

// ─── FORM CARD WRAPPER ────────────────────────────────────────────────────────
export const AuthCard: React.FC<{ children: ReactNode }> = ({ children }) => (
  <div
    className="auth-right"
    style={{
      flex: 1,
      minWidth: 420,
      overflow: "auto",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#f8fbfd",
      padding: "48px 40px",
      position: "relative",
    }}
  >
    {/* Background blobs */}
    <div
      style={{
        position: "absolute",
        top: 32,
        right: 32,
        width: 160,
        height: 160,
        borderRadius: 28,
        background: "rgba(16,185,129,0.08)",
        zIndex: 0,
      }}
    />
    <div
      style={{
        position: "absolute",
        bottom: 60,
        left: 28,
        width: 120,
        height: 120,
        borderRadius: 28,
        background: "rgba(56,189,248,0.08)",
        zIndex: 0,
      }}
    />

    <div
      style={{ width: "100%", maxWidth: 420, position: "relative", zIndex: 1 }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 26,
          color: A.textSub,
          fontSize: 13,
        }}
      >
        <span style={{ fontWeight: 600 }}>QIntellect AI Attendance</span>
        <span style={{ color: A.primary, fontWeight: 600, cursor: "pointer" }}>
          Support
        </span>
      </div>

      {/* Glass card */}
      <div
        style={{
          background: "#fff",
          borderRadius: 28,
          boxShadow: "0 40px 70px rgba(15,45,74,0.08)",
          padding: "36px",
          border: `1px solid rgba(226,232,240,0.85)`,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  </div>
);

// ─── LABEL ────────────────────────────────────────────────────────────────────
export const AuthLabel: React.FC<{ children: ReactNode }> = ({ children }) => (
  <label
    style={{
      display: "block",
      fontSize: 13,
      fontWeight: 600,
      color: "#334155",
      marginBottom: 7,
    }}
  >
    {children}
  </label>
);

// ─── INPUT with optional left icon + right toggle ─────────────────────────────
interface AuthInputProps extends InputHTMLAttributes<HTMLInputElement> {
  leftIcon?: ReactNode;
  rightToggle?: { show: boolean; onToggle: () => void };
  extraRight?: ReactNode; // e.g. checkmark
}
export const AuthInput: React.FC<AuthInputProps> = ({
  leftIcon,
  rightToggle,
  extraRight,
  style,
  ...props
}) => (
  <div style={{ position: "relative" }}>
    {leftIcon && (
      <div
        style={{
          position: "absolute",
          left: 14,
          top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
          display: "flex",
        }}
      >
        {leftIcon}
      </div>
    )}
    <input
      className={`auth-input${leftIcon ? " auth-input-icon" : ""}`}
      style={{ paddingRight: rightToggle ? 44 : undefined, ...style }}
      {...props}
    />
    {extraRight && (
      <div
        style={{
          position: "absolute",
          right: rightToggle ? 44 : 12,
          top: "50%",
          transform: "translateY(-50%)",
        }}
      >
        {extraRight}
      </div>
    )}
    {rightToggle && (
      <button
        type="button"
        onClick={rightToggle.onToggle}
        style={{
          position: "absolute",
          right: 12,
          top: "50%",
          transform: "translateY(-50%)",
          background: "none",
          border: "none",
          color: A.textMuted,
          cursor: "pointer",
          padding: 4,
          display: "flex",
          alignItems: "center",
        }}
      >
        {rightToggle.show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    )}
  </div>
);

// ─── BUTTON ───────────────────────────────────────────────────────────────────
export const AuthButton: React.FC<{
  loading?: boolean;
  disabled?: boolean;
  children: ReactNode;
  loadingLabel?: string;
  type?: "submit" | "button";
}> = ({
  loading,
  disabled,
  children,
  loadingLabel = "Please wait…",
  type = "submit",
}) => (
  <button type={type} className="auth-btn" disabled={loading || disabled}>
    {loading ? (
      <>
        <div
          style={{
            width: 16,
            height: 16,
            borderRadius: "50%",
            border: "2px solid rgba(255,255,255,0.3)",
            borderTopColor: "#fff",
            animation: "spin-auth 0.7s linear infinite",
          }}
        />
        {loadingLabel}
      </>
    ) : (
      children
    )}
  </button>
);

// ─── DIVIDER ──────────────────────────────────────────────────────────────────
export const AuthDivider: React.FC<{ label?: string }> = ({
  label = "or continue with",
}) => (
  <div
    style={{ display: "flex", alignItems: "center", gap: 12, margin: "22px 0" }}
  >
    <div style={{ flex: 1, height: 1, background: A.border }} />
    <span style={{ fontSize: 12, color: A.textMuted, fontWeight: 500 }}>
      {label}
    </span>
    <div style={{ flex: 1, height: 1, background: A.border }} />
  </div>
);

// ─── ERROR BOX ────────────────────────────────────────────────────────────────
export const AuthError: React.FC<{ message: string }> = ({ message }) => (
  <div
    style={{
      background: A.errorLight,
      border: `1px solid #fca5a5`,
      borderRadius: 14,
      padding: "12px 14px",
      fontSize: 13,
      color: A.error,
      fontWeight: 500,
      marginBottom: 20,
      display: "flex",
      alignItems: "center",
      gap: 8,
    }}
  >
    <span style={{ fontSize: 16 }}>⚠️</span> {message}
  </div>
);

// ─── STRENGTH METER ───────────────────────────────────────────────────────────
export const StrengthMeter: React.FC<{ password: string }> = ({ password }) => {
  const score = (() => {
    if (!password) return 0;
    let s = 0;
    if (password.length >= 8) s++;
    if (/[A-Z]/.test(password)) s++;
    if (/[0-9]/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;
    return s;
  })();

  const label = ["", "Weak", "Fair", "Good", "Strong"][score];
  const color = ["", "#ef4444", "#f59e0b", "#3b82f6", A.success][score];

  if (!password) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: i <= score ? color : A.border,
              transition: "background .2s",
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: 11, color, fontWeight: 600 }}>{label}</span>
    </div>
  );
};
