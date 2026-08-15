import { useCallback, useMemo, useState } from "react";
import { useServerPage } from "./useServerPage";
import { nodeHealthPageApi, type GlobalNodeHealthRow } from "../api/nodehealthApi";

export function useNodeHealthPage() {
  const [status, setStatus] = useState("all");
  const extra = useMemo(() => ({ status }), [status]);
  const loader = useCallback((query: Record<string, string | number | undefined>) => nodeHealthPageApi.list(query), []);
  const page = useServerPage<GlobalNodeHealthRow>(loader, extra);
  return { ...page, status, setStatus };
}
