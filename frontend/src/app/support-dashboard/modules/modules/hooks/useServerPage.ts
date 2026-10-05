import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

export interface PageState<T> {
  rows: T[];
  page: { page: number; page_size: number; total: number; total_pages: number; has_more: boolean };
  isLoading: boolean;
  error: string | null;
}

interface Query { page: number; page_size: number; search?: string; [key: string]: string | number | undefined }

type Action<T> =
  | { type: "START" }
  | { type: "SUCCESS"; rows: T[]; page: PageState<T>["page"] }
  | { type: "ERROR"; error: string };

export function extractMessage(error: unknown, fallback = "Request failed"): string {
  if (error && typeof error === "object") {
    const value = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
    return value.response?.data?.message || value.response?.data?.error || value.message || fallback;
  }
  return fallback;
}

export function useServerPage<T>(loader: (query: Query) => Promise<{ rows: T[]; page: PageState<T>["page"] }>, extra: Record<string, string | number | undefined> = {}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [state, dispatch] = useReducer((current: PageState<T>, action: Action<T>): PageState<T> => {
    switch (action.type) {
      case "START": return { ...current, isLoading: true, error: null };
      case "SUCCESS": return { rows: action.rows, page: action.page, isLoading: false, error: null };
      case "ERROR": return { ...current, isLoading: false, error: action.error };
      default: return current;
    }
  }, { rows: [], page: { page: 1, page_size: 25, total: 0, total_pages: 1, has_more: false }, isLoading: false, error: null });

  const extraKey = JSON.stringify(extra);
  const requestIdRef = useRef(0);
  const query = useMemo(() => ({ page, page_size: 25, search, ...extra }), [page, search, extraKey]);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    dispatch({ type: "START" });
    try {
      const result = await loader(query);
      if (requestId === requestIdRef.current) dispatch({ type: "SUCCESS", rows: result.rows, page: result.page });
    } catch (err) {
      if (requestId === requestIdRef.current) dispatch({ type: "ERROR", error: extractMessage(err) });
    }
  }, [loader, query]);

  useEffect(() => { void refresh(); }, [refresh]);
  const updateSearch = useCallback((value: string) => { setSearch(value); setPage(1); }, []);
  return { ...state, search, setSearch: updateSearch, setPage, refresh };
}
