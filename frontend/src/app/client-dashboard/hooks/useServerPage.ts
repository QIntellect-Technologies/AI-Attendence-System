import { useCallback, useMemo, useState } from "react";
import { FastPageRequest, FastPageResponse, FastScope, getFastPage } from "../services/performanceApi";
import { useDebouncedValue } from "./useDebouncedValue";
import { useFastQuery } from "./useFastQuery";

type Entity = FastPageRequest["entity"];

type UseServerPageOptions = FastScope & {
  entity: Entity;
  initialPageSize?: number;
  initialSortBy?: string;
  initialSortDir?: "asc" | "desc";
};

export function useServerPage<T = any>(options: UseServerPageOptions) {
  const { entity, initialPageSize = 50, initialSortBy, initialSortDir = "asc", ...scope } = options;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(initialPageSize);
  const [search, setSearchState] = useState("");
  const [sortBy, setSortBy] = useState<string | undefined>(initialSortBy);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSortDir);
  const debouncedSearch = useDebouncedValue(search, 250);

  const request: FastPageRequest = useMemo(
    () => ({ entity, ...scope, page, pageSize, search: debouncedSearch, sortBy, sortDir }),
    [entity, scope.clientId, scope.orgId, scope.branchId, scope.today, page, pageSize, debouncedSearch, sortBy, sortDir],
  );

  const fetcher = useCallback(() => getFastPage<T>(request), [request]);

  const query = useFastQuery<FastPageResponse<T>>(["server-page", request], fetcher, {
    ttlMs: 3500,
    keepPreviousData: true,
    fallbackData: {
      success: true,
      entity,
      rows: [],
      total: 0,
      page,
      pageSize,
      offset: (page - 1) * pageSize,
      hasMore: false,
    },
  });

  const setPageSize = useCallback((next: number) => {
    setPageSizeState(next);
    setPage(1);
  }, []);

  const setSearch = useCallback((next: string) => {
    setSearchState(next);
    setPage(1);
  }, []);

  const setSort = useCallback((column: string) => {
    setSortBy((currentColumn) => {
      if (currentColumn === column) {
        setSortDir((currentDir) => (currentDir === "asc" ? "desc" : "asc"));
        return currentColumn;
      }
      setSortDir("asc");
      return column;
    });
    setPage(1);
  }, []);

  return {
    ...query,
    rows: query.data?.rows ?? [],
    total: query.data?.total ?? 0,
    page,
    pageSize,
    search,
    sortBy,
    sortDir,
    hasMore: Boolean(query.data?.hasMore),
    setPage,
    setPageSize,
    setSearch,
    setSort,
    refetch: query.refetch,
  };
}
