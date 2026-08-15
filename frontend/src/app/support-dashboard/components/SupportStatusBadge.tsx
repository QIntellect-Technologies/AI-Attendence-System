import React from "react";
import { supportTheme } from "./SupportPageShell";

const COLORS: Record<string, { bg: string; fg: string }> = {
  active: { bg: "#dcfce7", fg: "#16a34a" },
  paid: { bg: "#dcfce7", fg: "#16a34a" },
  online: { bg: "#dcfce7", fg: "#16a34a" },
  grace_period: { bg: "#fff7ed", fg: "#f97316" },
  pending: { bg: "#fef3c7", fg: "#d97706" },
  suspended: { bg: "#fee2e2", fg: "#dc2626" },
  overdue: { bg: "#fee2e2", fg: "#dc2626" },
  offline: { bg: "#fee2e2", fg: "#dc2626" },
  archived: { bg: "#e2e8f0", fg: "#475569" },
  inactive: { bg: "#e2e8f0", fg: "#475569" },
  never_connected: { bg: "#f1f5f9", fg: "#64748b" },
  local: { bg: "#f3e8ff", fg: "#7c3aed" },
  cloud: { bg: "#dbeafe", fg: "#2563eb" },
};

function label(value: string): string {
  return String(value || "—").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export const SupportStatusBadge: React.FC<{ value?: string | null }> = ({ value }) => {
  const key = String(value || "unknown").trim().toLowerCase();
  const c = COLORS[key] || { bg: "#f1f5f9", fg: supportTheme.muted };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, borderRadius: 999, padding: "4px 8px", background: c.bg, color: c.fg, fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.03em", whiteSpace: "nowrap" }}>
      {label(key)}
    </span>
  );
};
