import React, { useState } from "react";
import type { InternalUserRow } from "../api/internalUsersApi";

const T = { border: "#dbe4ef", text: "#334155", muted: "#64748b", teal: "#0d9488", red: "#ef4444", page: "rgba(15, 23, 42, 0.35)" } as const;

interface Props {
  open: boolean;
  user: InternalUserRow | null;
  isSaving?: boolean;
  onClose: () => void;
  onSubmit: (password: string) => Promise<void> | void;
}

export default function ResetPasswordModal({ open, user, isSaving, onClose, onSubmit }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open || !user) return null;

  const submit = async () => {
    if (password.trim().length < 8) return setError("Password must be at least 8 characters.");
    setError(null);
    await onSubmit(password.trim());
    setPassword("");
  };

  return <div style={overlayStyle}>
    <div style={modalStyle}>
      <h2 style={{ margin: 0, color: "#1a699f", fontSize: 18 }}>Reset Password</h2>
      <p style={{ color: T.muted, fontSize: 12 }}>Set a new password for <strong>{user.email}</strong>.</p>
      <label style={labelStyle}>New Password</label>
      <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} style={inputStyle} />
      {error && <p style={{ color: T.red, fontSize: 12, fontWeight: 800 }}>{error}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" onClick={onClose} style={secondaryButton}>Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={isSaving} style={primaryButton}>{isSaving ? "Saving…" : "Reset Password"}</button>
      </div>
    </div>
  </div>;
}

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, background: T.page, display: "grid", placeItems: "center", zIndex: 50, padding: 20 };
const modalStyle: React.CSSProperties = { width: "min(480px, 100%)", background: "white", border: `1px solid ${T.border}`, borderRadius: 16, padding: 18, boxShadow: "0 18px 60px rgba(15, 23, 42, 0.18)" };
const labelStyle: React.CSSProperties = { display: "block", color: T.muted, fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 };
const inputStyle: React.CSSProperties = { width: "100%", height: 38, border: `1px solid ${T.border}`, borderRadius: 10, padding: "0 12px", boxSizing: "border-box", color: T.text, fontSize: 12, fontWeight: 700, outline: "none" };
const primaryButton: React.CSSProperties = { border: "none", background: T.teal, color: "white", borderRadius: 10, padding: "9px 13px", fontSize: 12, fontWeight: 900, cursor: "pointer" };
const secondaryButton: React.CSSProperties = { border: `1px solid ${T.border}`, background: "white", color: T.text, borderRadius: 10, padding: "9px 13px", fontSize: 12, fontWeight: 900, cursor: "pointer" };
