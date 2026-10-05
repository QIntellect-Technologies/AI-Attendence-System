import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  getTenantConfig,
  TenantConfigResponse,
} from "../services/tenantConfigApi";

type TenantConfigContextValue = {
  tenantConfig: TenantConfigResponse | null;
  loading: boolean;
  error: string | null;
  reloadTenantConfig: () => Promise<void>;
};

const TenantConfigContext = createContext<TenantConfigContextValue | null>(
  null,
);

export function TenantConfigProvider({
  children,
  orgId,
}: {
  children: React.ReactNode;
  orgId?: string | number;
}) {
  const [tenantConfig, setTenantConfig] = useState<TenantConfigResponse | null>(
    null,
  );
  // Start in a non-loading state: there is nothing to load until orgId exists.
  // This avoids a false "loading" flash on public/logged-out routes.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadTenantConfig = useCallback(async () => {
    // No org context yet (logged out, auth still resolving, or user has no
    // organization). Do not call the backend — /api/tenant/config requires
    // organization_id and would 400 on every call otherwise. Reset to a
    // clean "not ready" state instead of surfacing that 400 as an error.
    if (!orgId) {
      setTenantConfig(null);
      setError(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const data = await getTenantConfig(orgId);
      setTenantConfig(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load tenant configuration",
      );
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void reloadTenantConfig();
  }, [reloadTenantConfig]);

  const value = useMemo(
    () => ({
      tenantConfig,
      loading,
      error,
      reloadTenantConfig,
    }),
    [tenantConfig, loading, error, reloadTenantConfig],
  );

  return (
    <TenantConfigContext.Provider value={value}>
      {children}
    </TenantConfigContext.Provider>
  );
}

export function useTenantConfig() {
  const context = useContext(TenantConfigContext);

  if (!context) {
    throw new Error("useTenantConfig must be used inside TenantConfigProvider");
  }

  return context;
}
