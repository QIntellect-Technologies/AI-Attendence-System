/**
 * src/shared/hooks/usePagination.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic pagination hooks.
 *
 * Two exports:
 *   useStatefulPagination  — manages page state internally (primary, use this)
 *   usePagination          — stateless; caller owns page + setPage (advanced use)
 *
 * Both are generic and can be used across any module (leave, attendance, payroll).
 */

import { useCallback, useMemo, useState } from "react";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface UsePaginationState {
  page: number;
  totalPages: number;
  totalItems: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startIndex: number;
  endIndex: number;
}

export interface UsePaginationReturn<T> extends UsePaginationState {
  paginatedItems: T[];
  goToPage: (page: number) => void;
  nextPage: () => void;
  previousPage: () => void;
  resetPage: () => void;
}

// ─── useStatefulPagination (PRIMARY — manages page internally) ────────────────

export interface UseStatefulPaginationOptions<T> {
  items: T[];
  itemsPerPage?: number;
  /**
   * Reset to page 1 when the items array length changes.
   * Default: true
   */
  resetOnItemsChange?: boolean;
}

/**
 * Generic stateful pagination hook.
 *
 * Manages current page internally so callers only need to pass `items`.
 * Automatically resets to page 1 when items count changes (e.g. after filtering).
 *
 * @example
 *   const { paginatedItems, page, totalPages, goToPage } =
 *     useStatefulPagination({ items: filteredLeaves, itemsPerPage: 25 });
 */
export function useStatefulPagination<T>({
  items,
  itemsPerPage = 25,
  resetOnItemsChange = true,
}: UseStatefulPaginationOptions<T>): UsePaginationReturn<T> {
  const [currentPage, setCurrentPage] = useState(1);

  // Reset to page 1 when filtered item count changes
  const itemCount = items.length;
  useMemo(() => {
    if (resetOnItemsChange) {
      setCurrentPage(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemCount, resetOnItemsChange]);

  const totalItems = itemCount;
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  const boundedPage = Math.max(1, Math.min(currentPage, totalPages));

  const startIndex = (boundedPage - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage - 1, totalItems - 1);

  const paginatedItems = useMemo<T[]>(
    () => items.slice(startIndex, startIndex + itemsPerPage),
    [items, startIndex, itemsPerPage],
  );

  const hasNextPage = boundedPage < totalPages;
  const hasPreviousPage = boundedPage > 1;

  const goToPage = useCallback(
    (page: number) => {
      setCurrentPage(Math.max(1, Math.min(page, totalPages)));
    },
    [totalPages],
  );

  const nextPage = useCallback(() => {
    if (hasNextPage) setCurrentPage((p) => p + 1);
  }, [hasNextPage]);

  const previousPage = useCallback(() => {
    if (hasPreviousPage) setCurrentPage((p) => p - 1);
  }, [hasPreviousPage]);

  const resetPage = useCallback(() => setCurrentPage(1), []);

  return {
    paginatedItems,
    page: boundedPage,
    totalPages,
    totalItems,
    hasNextPage,
    hasPreviousPage,
    startIndex,
    endIndex,
    goToPage,
    nextPage,
    previousPage,
    resetPage,
  };
}

// ─── usePagination (ADVANCED — caller controls page state externally) ─────────

export interface UsePaginationOptions<T> {
  items: T[];
  page: number;
  onPageChange: (page: number) => void;
  itemsPerPage?: number;
}

/**
 * Stateless pagination hook for cases where the caller needs to own page state
 * (e.g. sync to URL, persist in parent component, DevTools tracking).
 *
 * @example
 *   const [page, setPage] = useState(1);
 *   const { paginatedItems, totalPages } = usePagination({
 *     items, page, onPageChange: setPage, itemsPerPage: 25,
 *   });
 */
export function usePagination<T>({
  items,
  page,
  onPageChange,
  itemsPerPage = 25,
}: UsePaginationOptions<T>): UsePaginationReturn<T> {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  const boundedPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (boundedPage - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage - 1, totalItems - 1);

  const paginatedItems = useMemo<T[]>(
    () => items.slice(startIndex, startIndex + itemsPerPage),
    [items, startIndex, itemsPerPage],
  );

  const hasNextPage = boundedPage < totalPages;
  const hasPreviousPage = boundedPage > 1;

  const goToPage = useCallback(
    (nextPage: number) => {
      onPageChange(Math.max(1, Math.min(nextPage, totalPages)));
    },
    [onPageChange, totalPages],
  );

  const nextPage = useCallback(() => {
    if (hasNextPage) onPageChange(boundedPage + 1);
  }, [boundedPage, hasNextPage, onPageChange]);

  const previousPage = useCallback(() => {
    if (hasPreviousPage) onPageChange(boundedPage - 1);
  }, [boundedPage, hasPreviousPage, onPageChange]);

  const resetPage = useCallback(() => onPageChange(1), [onPageChange]);

  return {
    paginatedItems,
    page: boundedPage,
    totalPages,
    totalItems,
    hasNextPage,
    hasPreviousPage,
    startIndex,
    endIndex,
    goToPage,
    nextPage,
    previousPage,
    resetPage,
  };
}
