import { useCallback, useMemo, useState } from "react";
import { useServerPage } from "./useServerPage";
import { modulesPageApi, type GlobalModuleEntitlementRow } from "../api/modulesApi";

export function useModuleEntitlementsPage() {
  const [status, setStatus] = useState("all");
  const [module, setModule] = useState("all");
  const extra = useMemo(() => ({ status, module }), [status, module]);
  const loader = useCallback((query: Record<string, string | number | undefined>) => modulesPageApi.list(query), []);
  const page = useServerPage<GlobalModuleEntitlementRow>(loader, extra);
  return { ...page, status, setStatus, module, setModule };
}
