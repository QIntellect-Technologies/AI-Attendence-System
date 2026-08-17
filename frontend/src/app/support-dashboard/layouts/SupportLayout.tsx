/**
 * src/app/support-dashboard/layouts/SupportLayout.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Authenticated shell for the Support Dashboard.
 *
 * The navigation below only points to routes that exist in support-dashboard/routes.tsx.
 * Organization-specific branch/module/billing operations remain available inside
 * /support/organizations/:orgId, while these global pages give Support quick entry
 * points for branch tokens, invoices, module entitlements, and node health.
 */

import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  Activity,
  Building2,
  GitBranch,
  Grid3X3,
  LogOut,
  Receipt,
  Shield,
  Users,
  ChevronRight,
} from "lucide-react";
import { useSupportAuth } from "../contexts/SupportAuthContext";

const T = {
  navy900: "#0a2540",
  navy800: "#0f2f50",
  teal600: "#0d9488",
  teal400: "#2dd4bf",
  white: "#ffffff",
  textMuted: "#94a3b8",
  bgPage: "#f5f6fa",
} as const;

interface NavItem {
  to: string;
  icon: React.ReactNode;
  label: string;
  roles?: string[];
}

const NAV_ITEMS: NavItem[] = [
  {
    to: "/support/organizations",
    icon: <Building2 size={15} />,
    label: "Organizations",
  },
  {
    to: "/support/branches",
    icon: <GitBranch size={15} />,
    label: "Branches",
    roles: ["super_admin"],
  },
  {
    to: "/support/invoices",
    icon: <Receipt size={15} />,
    label: "Invoices",
  },
  {
    to: "/support/modules",
    icon: <Grid3X3 size={15} />,
    label: "Modules",
    roles: ["super_admin"],
  },
  {
    to: "/support/node-health",
    icon: <Activity size={15} />,
    label: "Node Health",
    roles: ["super_admin"],
  },
  {
    to: "/support/internal-users",
    icon: <Users size={15} />,
    label: "Internal Users",
    roles: ["super_admin"],
  },
];

const Sidebar: React.FC = () => {
  const { user, logout } = useSupportAuth();
  // Fallback must name a REAL role: "support" no longer exists, and an
  // unknown role resolves to an empty capability set.
  const role = user?.role || "billing";
  const canSee = (item: NavItem) => !item.roles || item.roles.includes(role);

  return (
    <aside
      style={{
        width: 220,
        minHeight: "100vh",
        background: T.navy900,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        position: "sticky",
        top: 0,
      }}
    >
      <div
        style={{
          padding: "20px 20px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: T.teal600,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Shield size={15} color={T.white} />
          </div>
          <div>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                fontWeight: 900,
                color: T.white,
                letterSpacing: "-0.01em",
              }}
            >
              QIntellect
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 9,
                color: T.textMuted,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Support Portal
            </p>
          </div>
        </div>
      </div>

      <nav style={{ flex: 1, padding: "12px 10px" }}>
        {NAV_ITEMS.filter(canSee).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            style={({ isActive }) => ({
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "9px 12px",
              borderRadius: 9,
              marginBottom: 2,
              textDecoration: "none",
              background: isActive ? "rgba(13,148,136,0.18)" : "transparent",
              color: isActive ? T.teal400 : T.textMuted,
              fontSize: 12,
              fontWeight: isActive ? 800 : 600,
              transition: "all 0.12s",
            })}
          >
            {({ isActive }) => (
              <>
                <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  {item.icon}
                  {item.label}
                </span>
                {isActive && (
                  <ChevronRight size={11} style={{ opacity: 0.6 }} />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div
        style={{
          padding: "12px 10px",
          borderTop: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 9,
            background: T.navy800,
            marginBottom: 6,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 11,
              fontWeight: 700,
              color: T.white,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {user?.full_name ?? user?.email}
          </p>
          <p
            style={{
              margin: "2px 0 0",
              fontSize: 9,
              color: T.teal400,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.07em",
            }}
          >
            {user?.role?.replace("_", " ")}
          </p>
        </div>

        <button
          type="button"
          onClick={logout}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 8,
            background: "transparent",
            border: "none",
            color: T.textMuted,
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <LogOut size={13} />
          Sign out
        </button>
      </div>
    </aside>
  );
};

const SupportLayout: React.FC = () => (
  <div
    style={{
      display: "flex",
      minHeight: "100vh",
      fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      background: T.bgPage,
    }}
  >
    <Sidebar />
    <main style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
      <Outlet />
    </main>
  </div>
);

export default SupportLayout;
