import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  extractSupportError,
  internalUsersApi,
  type CreateInternalUserPayload,
  type InternalUserRow,
  type PageMeta,
  type UpdateInternalUserPayload,
} from "../api/internalUsersApi";

interface State {
  rows: InternalUserRow[];
  pageMeta: PageMeta | null;
  isLoading: boolean;
  isMutating: boolean;
  error: string | null;
}

type Action =
  | { type: "START" }
  | { type: "SUCCESS"; rows: InternalUserRow[]; page: PageMeta }
  | { type: "ERROR"; error: string }
  | { type: "MUTATING"; value: boolean }
  | { type: "UPSERT"; row: InternalUserRow };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "START":
      return { ...state, isLoading: true, error: null };
    case "SUCCESS":
      return { ...state, rows: action.rows, pageMeta: action.page, isLoading: false, error: null };
    case "ERROR":
      return { ...state, isLoading: false, error: action.error };
    case "MUTATING":
      return { ...state, isMutating: action.value, error: action.value ? null : state.error };
    case "UPSERT": {
      const exists = state.rows.some((row) => row.id === action.row.id);
      return { ...state, rows: exists ? state.rows.map((row) => row.id === action.row.id ? action.row : row) : [action.row, ...state.rows] };
    }
    default:
      return state;
  }
}

export function useInternalUsers() {
  const [state, dispatch] = useReducer(reducer, { rows: [], pageMeta: null, isLoading: false, isMutating: false, error: null });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("all");
  const [active, setActive] = useState("all");
  const requestIdRef = useRef(0);

  const query = useMemo(() => ({ page, page_size: 25, search, role, active }), [page, search, role, active]);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    dispatch({ type: "START" });
    try {
      const result = await internalUsersApi.list(query);
      if (requestId === requestIdRef.current) {
        dispatch({ type: "SUCCESS", rows: result.rows, page: result.page });
      }
    } catch (err) {
      if (requestId === requestIdRef.current) {
        dispatch({ type: "ERROR", error: extractSupportError(err, "Failed to load internal users") });
      }
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runMutation = useCallback(async <T,>(action: () => Promise<T>) => {
    dispatch({ type: "MUTATING", value: true });
    try {
      return await action();
    } catch (err) {
      dispatch({ type: "ERROR", error: extractSupportError(err, "Request failed") });
      throw err;
    } finally {
      dispatch({ type: "MUTATING", value: false });
    }
  }, []);

  const createUser = useCallback(async (payload: CreateInternalUserPayload) => {
    const row = await runMutation(() => internalUsersApi.create(payload));
    dispatch({ type: "UPSERT", row });
    return row;
  }, [runMutation]);

  const updateUser = useCallback(async (id: string, payload: UpdateInternalUserPayload) => {
    const row = await runMutation(() => internalUsersApi.update(id, payload));
    dispatch({ type: "UPSERT", row });
    return row;
  }, [runMutation]);

  const resetPassword = useCallback(async (id: string, password: string) => {
    const row = await runMutation(() => internalUsersApi.resetPassword(id, password));
    dispatch({ type: "UPSERT", row });
    return row;
  }, [runMutation]);

  return {
    ...state,
    page,
    setPage,
    search,
    setSearch,
    role,
    setRole,
    active,
    setActive,
    refresh,
    createUser,
    updateUser,
    resetPassword,
  };
}
