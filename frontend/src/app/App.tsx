import { RouterProvider } from "react-router-dom";
import type { ReactNode } from "react";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { AuthProvider } from "../app/client-dashboard/contexts/AuthContext";
import { TenantConfigProvider } from "../app/client-dashboard/contexts/TenantConfigContext";
import { useAuth } from "../app/client-dashboard/contexts/useAuth";
import { router } from "../app/client-dashboard/routes";

/**
 * Bridges AuthContext -> TenantConfigProvider.
 *
 * TenantConfigProvider needs the authenticated user's organization_id, but it
 * is mounted inside AuthProvider, so it cannot read auth state via props from
 * App() directly — useAuth() only works below AuthProvider in the tree. This
 * connector is the single place that reads user.organization_id and forwards
 * it, so TenantConfigProvider itself stays decoupled from AuthContext and
 * remains reusable/testable with any orgId source.
 */
function AuthenticatedTenantConfig({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return (
    <TenantConfigProvider orgId={user?.organization_id ?? undefined}>
      {children}
    </TenantConfigProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastContainer position="top-right" />
      <AuthenticatedTenantConfig>
        <RouterProvider router={router} />
      </AuthenticatedTenantConfig>
    </AuthProvider>
  );
}
