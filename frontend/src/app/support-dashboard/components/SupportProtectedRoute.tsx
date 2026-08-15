/**
 * src/app/support-dashboard/components/SupportProtectedRoute.tsx
 * Route guard for internal QIntellect Support Dashboard.
 */
import React from "react";
import { Navigate } from "react-router-dom";
import {
  useSupportAuth,
  type SupportUserRole,
} from "../contexts/SupportAuthContext";

interface Props {
  children: React.ReactNode;
  allowedRoles?: SupportUserRole[];
}

export const SupportProtectedRoute: React.FC<Props> = ({
  children,
  allowedRoles,
}) => {
  const { isAuthenticated, isLoading, user } = useSupportAuth();

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          background: "#0a2540",
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            border: "3px solid rgba(13,148,136,0.3)",
            borderTopColor: "#0d9488",
            animation: "spin .65s linear infinite",
          }}
        />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (!isAuthenticated) return <Navigate to="/support/login" replace />;

  if (allowedRoles?.length && (!user || !allowedRoles.includes(user.role))) {
    return (
      <div
        style={{
          padding: 32,
          fontFamily: "'DM Sans','Inter',sans-serif",
          color: "#334155",
        }}
      >
        <h1 style={{ color: "#1a699f", fontSize: 22, margin: 0 }}>
          Access denied
        </h1>
        <p style={{ color: "#64748b", fontSize: 13 }}>
          Your support role does not have permission to open this page.
        </p>
      </div>
    );
  }

  return <>{children}</>;
};
