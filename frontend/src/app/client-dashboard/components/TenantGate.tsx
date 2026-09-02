import React from "react";
import { Navigate } from "react-router-dom";
import { useOrg } from "../contexts/OrgConfigContext";

const ALLOWED_CLIENT_STATUSES = new Set([
  "active",
  "grace_period",
  "trial",
  "launched",
]);

function statusLabel(status: string | null): string {
  if (!status) return "not ready";
  return status.replace(/_/g, " ");
}

const GateLoader: React.FC = () => (
  <div
    style={{
      minHeight: "55vh",
      display: "grid",
      placeItems: "center",
      color: "#64748b",
      fontSize: 14,
    }}
  >
    Loading dashboard configuration…
  </div>
);

// Shown when the bootstrap/config request itself failed (network error, a
// transient 500, etc.) -- distinct from a confirmed "this account has no
// org". Previously this case wasn't distinguished from "no org" at all, so
// a mere hiccup on /api/client/bootstrap bounced an authenticated user to
// /onboarding (or a blank dashboard) instead of letting them retry.
const LoadFailed: React.FC<{ message: string; onRetry: () => void }> = ({
  message,
  onRetry,
}) => (
  <div
    style={{
      minHeight: "55vh",
      display: "grid",
      placeItems: "center",
      padding: 24,
    }}
  >
    <div style={{ maxWidth: 480, width: "100%", textAlign: "center" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 18, color: "#0f172a" }}>
        Couldn't load your dashboard
      </h2>
      <p
        style={{
          margin: "0 0 16px",
          color: "#64748b",
          lineHeight: 1.6,
          fontSize: 14,
        }}
      >
        {message ||
          "Something went wrong loading your organization. Your session is still active."}
      </p>
      <button
        type="button"
        onClick={onRetry}
        style={{
          background: "#0f172a",
          color: "#fff",
          border: "none",
          borderRadius: 10,
          padding: "10px 20px",
          fontSize: 14,
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </div>
  </div>
);

const BlockedTenant: React.FC<{ status: string | null }> = ({ status }) => (
  <div
    style={{
      minHeight: "70vh",
      display: "grid",
      placeItems: "center",
      padding: 24,
      background: "#f8fafc",
    }}
  >
    <div
      style={{
        maxWidth: 560,
        width: "100%",
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 18,
        padding: 28,
        boxShadow: "0 18px 60px rgba(15, 23, 42, 0.08)",
      }}
    >
      <h1 style={{ margin: 0, fontSize: 22, color: "#0f172a" }}>
        Dashboard access is blocked
      </h1>
      <p style={{ margin: "10px 0 0", color: "#64748b", lineHeight: 1.6 }}>
        This organization is currently <strong>{statusLabel(status)}</strong>.
        Support Dashboard controls organization access, modules, attendance
        mode, branch limits, and billing status.
      </p>
      <p style={{ margin: "14px 0 0", color: "#64748b", lineHeight: 1.6 }}>
        Client-side pages are intentionally blocked to prevent stale data access
        or tenant leakage.
      </p>
    </div>
  </div>
);

export const TenantGate: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const {
    isOrgReady,
    organizationId,
    accessStatus,
    organizationStatus,
    requiresOnboarding,
    orgLoadError,
    refreshOrgConfig,
  } = useOrg();

  if (!isOrgReady) return <GateLoader />;

  // The fetch itself failed -- do NOT treat this as "no org" and redirect
  // to onboarding. Offer a retry instead; the session/token is fine.
  if (!organizationId && orgLoadError) {
    return (
      <LoadFailed
        message={orgLoadError}
        onRetry={() => void refreshOrgConfig()}
      />
    );
  }

  if (!organizationId || requiresOnboarding) {
    return <Navigate to="/onboarding" replace />;
  }

  const status = String(accessStatus || organizationStatus || "")
    .trim()
    .toLowerCase();
  if (status && !ALLOWED_CLIENT_STATUSES.has(status)) {
    return <BlockedTenant status={status} />;
  }

  return <>{children}</>;
};

export default TenantGate;
