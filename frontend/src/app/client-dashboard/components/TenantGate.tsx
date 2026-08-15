import React from "react";
import { Navigate } from "react-router-dom";
import { useOrg } from "../contexts/OrgConfigContext";

const ALLOWED_CLIENT_STATUSES = new Set(["active", "grace_period", "trial", "launched"]);

function statusLabel(status: string | null): string {
  if (!status) return "not ready";
  return status.replace(/_/g, " ");
}

const GateLoader: React.FC = () => (
  <div style={{ minHeight: "55vh", display: "grid", placeItems: "center", color: "#64748b", fontSize: 14 }}>
    Loading dashboard configuration…
  </div>
);

const BlockedTenant: React.FC<{ status: string | null }> = ({ status }) => (
  <div style={{ minHeight: "70vh", display: "grid", placeItems: "center", padding: 24, background: "#f8fafc" }}>
    <div style={{ maxWidth: 560, width: "100%", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 18, padding: 28, boxShadow: "0 18px 60px rgba(15, 23, 42, 0.08)" }}>
      <h1 style={{ margin: 0, fontSize: 22, color: "#0f172a" }}>Dashboard access is blocked</h1>
      <p style={{ margin: "10px 0 0", color: "#64748b", lineHeight: 1.6 }}>
        This organization is currently <strong>{statusLabel(status)}</strong>. Support Dashboard controls organization access, modules, attendance mode, branch limits, and billing status.
      </p>
      <p style={{ margin: "14px 0 0", color: "#64748b", lineHeight: 1.6 }}>
        Client-side pages are intentionally blocked to prevent stale data access or tenant leakage.
      </p>
    </div>
  </div>
);

export const TenantGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isOrgReady, organizationId, accessStatus, organizationStatus, requiresOnboarding } = useOrg();

  if (!isOrgReady) return <GateLoader />;

  if (!organizationId || requiresOnboarding) {
    return <Navigate to="/onboarding" replace />;
  }

  const status = String(accessStatus || organizationStatus || "").trim().toLowerCase();
  if (status && !ALLOWED_CLIENT_STATUSES.has(status)) {
    return <BlockedTenant status={status} />;
  }

  return <>{children}</>;
};

export default TenantGate;
