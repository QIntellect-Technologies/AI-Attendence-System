import { useCallback, useMemo, useState } from "react";
import { useServerPage } from "./useServerPage";
import { internalUsersPageApi, type InternalUserRow } from "../api/internalusersApi";

export function useInternalUsersPage() {
  const [role, setRole] = useState("all");
  const [active, setActive] = useState("all");
  const extra = useMemo(() => ({ role, active }), [role, active]);
  const loader = useCallback((query: Record<string, string | number | undefined>) => internalUsersPageApi.list(query), []);
  const page = useServerPage<InternalUserRow>(loader, extra);
  return { ...page, role, setRole, active, setActive };
}
