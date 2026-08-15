import { useCallback, useMemo, useState } from "react";
import { useServerPage } from "./useServerPage";
import { invoicesPageApi, type GlobalInvoiceRow } from "../api/invoicesApi";

export function useInvoicesPage() {
  const [status, setStatus] = useState("all");
  const extra = useMemo(() => ({ status }), [status]);
  const loader = useCallback((query: Record<string, string | number | undefined>) => invoicesPageApi.list(query), []);
  const page = useServerPage<GlobalInvoiceRow>(loader, extra);
  return { ...page, status, setStatus };
}
