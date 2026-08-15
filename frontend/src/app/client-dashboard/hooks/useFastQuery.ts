import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CacheItem<T> = {
  data: T;
  expiresAt: number;
  updatedAt: number;
};

type UseFastQueryOptions<T> = {
  enabled?: boolean;
  ttlMs?: number;
  keepPreviousData?: boolean;
  fallbackData?: T;
};

type UseFastQueryResult<T> = {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  isFetching: boolean;
  isStale: boolean;
  updatedAt: number | null;
  refetch: () => Promise<T | undefined>;
};

const cache = new Map<string, CacheItem<any>>();
const inflight = new Map<string, Promise<any>>();

function stableKey(parts: unknown[]): string {
  return JSON.stringify(parts, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (value as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return value;
  });
}

export function clearFastQueryCache() {
  cache.clear();
  inflight.clear();
}

export function useFastQuery<T>(
  keyParts: unknown[],
  fetcher: () => Promise<T>,
  options: UseFastQueryOptions<T> = {},
): UseFastQueryResult<T> {
  const { enabled = true, ttlMs = 5000, keepPreviousData = true, fallbackData } = options;
  const key = useMemo(() => stableKey(keyParts), [keyParts]);
  const previousDataRef = useRef<T | undefined>(fallbackData);

  const cached = cache.get(key) as CacheItem<T> | undefined;
  const initialData = cached?.data ?? (keepPreviousData ? previousDataRef.current : fallbackData);

  const [data, setData] = useState<T | undefined>(initialData);
  const [error, setError] = useState<Error | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(cached?.updatedAt ?? null);

  const run = useCallback(async (): Promise<T | undefined> => {
    if (!enabled) return data;

    const fresh = cache.get(key) as CacheItem<T> | undefined;
    const now = Date.now();
    if (fresh && fresh.expiresAt > now) {
      previousDataRef.current = fresh.data;
      setData(fresh.data);
      setUpdatedAt(fresh.updatedAt);
      setError(null);
      return fresh.data;
    }

    const existing = inflight.get(key) as Promise<T> | undefined;
    const promise = existing ?? fetcher();
    if (!existing) inflight.set(key, promise);

    setIsFetching(true);
    try {
      const result = await promise;
      const item: CacheItem<T> = {
        data: result,
        expiresAt: Date.now() + ttlMs,
        updatedAt: Date.now(),
      };
      cache.set(key, item);
      previousDataRef.current = result;
      setData(result);
      setUpdatedAt(item.updatedAt);
      setError(null);
      return result;
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error(String(err));
      setError(normalized);
      return undefined;
    } finally {
      inflight.delete(key);
      setIsFetching(false);
    }
  }, [data, enabled, fetcher, key, ttlMs]);

  useEffect(() => {
    if (!enabled) return;

    const fresh = cache.get(key) as CacheItem<T> | undefined;
    const now = Date.now();
    if (fresh) {
      previousDataRef.current = fresh.data;
      setData(fresh.data);
      setUpdatedAt(fresh.updatedAt);
      setError(null);
      // Stale-while-revalidate: render cached data immediately and refresh behind it.
      if (fresh.expiresAt > now) return;
    } else if (!keepPreviousData) {
      setData(fallbackData);
    }

    void run();
  }, [enabled, fallbackData, keepPreviousData, key, run]);

  const isStale = !cached || cached.expiresAt <= Date.now();
  const isLoading = enabled && !data && isFetching;

  return { data, error, isLoading, isFetching, isStale, updatedAt, refetch: run };
}
