/**
 * src/app/support-dashboard/routes.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Support Dashboard route definitions.
 *
 * HOW TO USE:
 *   Import `supportRoutes` into your existing routes.tsx and spread it
 *   into the root createBrowserRouter array:
 *
 *   import { supportRoutes } from "./support-dashboard/routes";
 *
 *   export const router = createBrowserRouter([
 *     ...existingRoutes,
 *     ...supportRoutes,   // ← add this
 *   ]);
 *
 * Route tree:
 *   /support/login              → SupportLogin (no auth required)
 *   /support                   → redirect to /support/organizations
 *   /support/*                 → SupportLayout (requires support auth)
 *     /support/organizations   → OrganizationsPage
 *     /support/organizations/:id → OrgDetailPage
 *     /support/branches        → BranchesPage
 *     /support/invoices        → InvoicesPage
 *     /support/modules         → ModuleEntitlementsPage
 *     /support/node-health     → NodeHealthPage
 *     /support/internal-users  → InternalUsersPage
 */

import React, { Suspense } from "react";
import { Navigate, type RouteObject } from "react-router-dom";
import SupportLayout from "./layouts/SupportLayout";
import { SupportAuthProvider } from "./contexts/SupportAuthContext";
import { SupportProtectedRoute } from "./components/SupportProtectedRoute";
import SupportLogin from "./pages/SupportLogin";

// ─── Lazy imports — mirrors the client dashboard pattern ──────────────────────

const LazyOrganizations = React.lazy(
  () => import("./modules/organizations/index"),
);
const LazyOrgDetail = React.lazy(
  () => import("./modules/organizations/OrgDetail"),
);
const LazyBranches = React.lazy(() => import("./modules/branches/index"));
const LazyInvoices = React.lazy(() => import("./modules/invoices/index"));
const LazyModuleEntitlements = React.lazy(
  () => import("./modules/modules/index"),
);
const LazyNodeHealth = React.lazy(() => import("./modules/node-health/index"));
const LazyInternalUsers = React.lazy(
  () => import("./modules/internal-users/index"),
);

// ─── Page loader — same as client dashboard PageLoader ────────────────────────

const PageLoader: React.FC = () => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "40vh",
      gap: 12,
      color: "#94a3b8",
    }}
  >
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: "3px solid #e6f3f9",
        borderTopColor: "#1a699f",
        animation: "spin .65s linear infinite",
      }}
    />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    <span style={{ fontSize: 13, fontWeight: 500 }}>Loading…</span>
  </div>
);

const s = (el: React.ReactNode): React.ReactElement => (
  <Suspense fallback={<PageLoader />}>{el}</Suspense>
);

// ─── Route definitions ────────────────────────────────────────────────────────

export const supportRoutes: RouteObject[] = [
  // /support/login — public, no auth wrapper
  {
    path: "/support/login",
    element: (
      <SupportAuthProvider>
        <SupportLogin />
      </SupportAuthProvider>
    ),
  },

  // /support — redirect to orgs
  {
    path: "/support",
    element: <Navigate to="/support/organizations" replace />,
  },

  // /support/* — all protected, SupportAuthProvider wraps everything
  {
    path: "/support",
    element: (
      <SupportAuthProvider>
        <SupportProtectedRoute>
          <SupportLayout />
        </SupportProtectedRoute>
      </SupportAuthProvider>
    ),
    children: [
      {
        path: "organizations",
        element: (
          <SupportProtectedRoute
            allowedRoles={[
              "super_admin",
              "admin",
              "support",
              "operations",
              "billing",
            ]}
          >
            {s(<LazyOrganizations />)}
          </SupportProtectedRoute>
        ),
      },
      {
        path: "organizations/:orgId",
        element: (
          <SupportProtectedRoute
            allowedRoles={[
              "super_admin",
              "admin",
              "support",
              "operations",
              "billing",
            ]}
          >
            {s(<LazyOrgDetail />)}
          </SupportProtectedRoute>
        ),
      },
      {
        path: "branches",
        element: (
          <SupportProtectedRoute
            allowedRoles={["super_admin", "admin", "support", "operations"]}
          >
            {s(<LazyBranches />)}
          </SupportProtectedRoute>
        ),
      },
      {
        path: "invoices",
        element: (
          <SupportProtectedRoute
            allowedRoles={["super_admin", "admin", "billing"]}
          >
            {s(<LazyInvoices />)}
          </SupportProtectedRoute>
        ),
      },
      {
        path: "modules",
        element: (
          <SupportProtectedRoute allowedRoles={["super_admin", "admin"]}>
            {s(<LazyModuleEntitlements />)}
          </SupportProtectedRoute>
        ),
      },
      {
        path: "node-health",
        element: (
          <SupportProtectedRoute
            allowedRoles={["super_admin", "admin", "support", "operations"]}
          >
            {s(<LazyNodeHealth />)}
          </SupportProtectedRoute>
        ),
      },
      {
        path: "internal-users",
        element: (
          <SupportProtectedRoute allowedRoles={["super_admin"]}>
            {s(<LazyInternalUsers />)}
          </SupportProtectedRoute>
        ),
      },
    ],
  },
];
