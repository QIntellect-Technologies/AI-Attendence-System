import React, { useEffect, useState } from "react";
import type { CreateInternalUserPayload, InternalUserRole, InternalUserRow, UpdateInternalUserPayload } from "../api/internalUsersApi";

const T = { border: "#dbe4ef", text: "#334155", muted: "#64748b", teal: "#0d9488", bg: "#ffffff", page: "rgba(15, 23, 42, 0.35)", red: "#ef4444" } as const;

const ROLE_OPTIONS: Array<{ value: InternalUserRole; label: string }> = [
  { value: "super_admin", label: "Super Admin" },
  { value: "admin", label: "Admin" },
  { value: "support", label: "Support" },
  { value: "operations", label: "Operations" },
  { value: "billing", label: "Billing" },
];

interface Props {
  open: boolean;
  mode: "create" | "edit";
  user?: InternalUserRow | null;
  isSaving?: boolean;
  onClose: () => void;
  onSubmit: (payload: CreateInternalUserPayload | UpdateInternalUserPayload) => Promise<void> | void;
}

export default function InternalUserModal({ open, mode, user, isSaving, onClose, onSubmit }: Props) {
  const [form, setForm] = useState<CreateInternalUserPayload>({ email: "", full_name: "", role: "support", password: "", is_active: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm({
      email: user?.email || "",
      full_name: user?.full_name || "",
      role: (user?.role as InternalUserRole) || "support",
      password: "",
      is_active: user?.is_active ?? true,
    });
  }, [open, user]);

  if (!open) return null;

  const submit = async () => {
    const email = form.email.trim().toLowerCase();
    const fullName = form.full_name.trim();
    if (!email || !email.includes("@")) return setError("Valid email is required.");
    if (!fullName) return setError("Full name is required.");
    if (mode === "create" && form.password.trim().length < 8) return setError("Password must be at least 8 characters.");
    setError(null);
    if (mode === "create") {
      await onSubmit({ ...form, email, full_name: fullName, password: form.password.trim() });
    } else {
      await onSubmit({ full_name: fullName, role: form.role, is_active: form.is_active });
    }
  };

  return <div style={overlayStyle}>
    <div style={modalStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, color: "#1a699f", fontSize: 18 }}>{mode === "create" ? "Create Internal User" : "Edit Internal User"}</h2>
          <p style={{ margin: "4px 0 0", color: T.muted, fontSize: 12 }}>QIntellect support account. Not linked to a client organization.</p>
        </div>
        <button type="button" onClick={onClose} style={ghostButton}>✕</button>
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        <Field label="Full Name" value={form.full_name} onChange={(full_name) => setForm((f) => ({ ...f, full_name }))} />
        <Field label="Email" type="email" value={form.email} disabled={mode === "edit"} onChange={(email) => setForm((f) => ({ ...f, email }))} />
        <label style={labelStyle}>Role</label>
        <select value={form.role} onChange={(event) => setForm((f) => ({ ...f, role: event.target.value as InternalUserRole }))} style={inputStyle}>
          {ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
        </select>
        {mode === "create" && <Field label="Temporary Password" type="password" value={form.password} onChange={(password) => setForm((f) => ({ ...f, password }))} />}
        <label style={{ display: "flex", gap: 8, alignItems: "center", color: T.text, fontSize: 12, fontWeight: 800 }}>
          <input type="checkbox" checked={form.is_active} onChange={(event) => setForm((f) => ({ ...f, is_active: event.target.checked }))} /> Active access
        </label>
      </div>
      {error && <p style={{ color: T.red, fontSize: 12, fontWeight: 800 }}>{error}</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" onClick={onClose} style={secondaryButton}>Cancel</button>
        <button type="button" onClick={() => void submit()} disabled={isSaving} style={primaryButton}>{isSaving ? "Saving…" : "Save User"}</button>
      </div>
    </div>
  </div>;
}

function Field({ label, value, onChange, type = "text", disabled = false }: { label: string; value: string; onChange: (value: string) => void; type?: string; disabled?: boolean }) {
  return <div><label style={labelStyle}>{label}</label><input type={type} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} style={{ ...inputStyle, background: disabled ? "#f8fafc" : "#fff" }} /></div>;
}

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, background: T.page, display: "grid", placeItems: "center", zIndex: 50, padding: 20 };
const modalStyle: React.CSSProperties = { width: "min(520px, 100%)", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 16, padding: 18, boxShadow: "0 18px 60px rgba(15, 23, 42, 0.18)" };
const labelStyle: React.CSSProperties = { display: "block", color: T.muted, fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 };
const inputStyle: React.CSSProperties = { width: "100%", height: 38, border: `1px solid ${T.border}`, borderRadius: 10, padding: "0 12px", boxSizing: "border-box", color: T.text, fontSize: 12, fontWeight: 700, outline: "none" };
const primaryButton: React.CSSProperties = { border: "none", background: T.teal, color: "white", borderRadius: 10, padding: "9px 13px", fontSize: 12, fontWeight: 900, cursor: "pointer" };
const secondaryButton: React.CSSProperties = { border: `1px solid ${T.border}`, background: "white", color: T.text, borderRadius: 10, padding: "9px 13px", fontSize: 12, fontWeight: 900, cursor: "pointer" };
const ghostButton: React.CSSProperties = { border: "none", background: "transparent", color: T.muted, cursor: "pointer", fontSize: 16, fontWeight: 900 };
