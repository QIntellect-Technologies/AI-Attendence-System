import { useCallback, useMemo, useState } from "react";
import { useServerPage } from "./useServerPage";
import { branchesPageApi, type GlobalBranchRow } from "../api/branchesApi";

export function useBranchesPage() {
  const [status, setStatus] = useState("all");
  const extra = useMemo(() => ({ status }), [status]);
  const loader = useCallback((query: Record<string, string | number | undefined>) => branchesPageApi.list(query), []);
  const page = useServerPage<GlobalBranchRow>(loader, extra);
  return { ...page, status, setStatus };
}
