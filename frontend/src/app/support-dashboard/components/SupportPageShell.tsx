import React from "react";

export const supportTheme = {
  blue: "#1a699f",
  teal: "#0d9488",
  teal50: "#ecfdf5",
  border: "#dbe4ef",
  card: "#ffffff",
  page: "#f5f6fa",
  text: "#102a43",
  muted: "#64748b",
  light: "#94a3b8",
  danger: "#ef4444",
  warning: "#f59e0b",
  success: "#16a34a",
} as const;

interface SupportPageShellProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}

export const SupportPageShell: React.FC<SupportPageShellProps> = ({ title, subtitle, icon, action, children }) => (
  <div style={{ padding: "28px 28px 48px", fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" }}>
      <div>
        <h1 style={{ margin: 0, color: supportTheme.blue, fontSize: 22, fontWeight: 900, letterSpacing: "-0.03em", display: "flex", alignItems: "center", gap: 10 }}>
          {icon}
          {title}
        </h1>
        {subtitle && <p style={{ margin: "6px 0 0", color: supportTheme.muted, fontSize: 13, maxWidth: 760 }}>{subtitle}</p>}
      </div>
      {action}
    </div>
    {children}
  </div>
);

export const SupportCard: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <section style={{ background: supportTheme.card, border: `1px solid ${supportTheme.border}`, borderRadius: 16, boxShadow: "0 8px 24px rgba(15,23,42,0.04)", overflow: "hidden", ...style }}>
    {children}
  </section>
);
