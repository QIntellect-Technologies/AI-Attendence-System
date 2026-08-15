/**
 * createEntityStore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic CRUD store factory. Every module entity (Staff, Leave, Payroll, …)
 * uses this — zero per-module state boilerplate.
 *
 * Tenant-safety rules:
 *   • localStorage is organization-scoped.
 *   • branchId is opaque: legacy numbers and Supabase UUID/string ids both work.
 *   • the old default "global" bucket is no longer used for real module data.
 *     If a caller forgets to pass storageScope, we derive it from currentUser's
 *     organization id and fall back to a clearly isolated unscoped bucket.
 *
 * Important: this is only frontend cache isolation. Backend queries must still
 * enforce organization_id/tenant ownership on every request.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useCallback, useMemo, useEffect } from "react";

export type BranchId = string | number;

// ─── Base constraint every entity must satisfy ────────────────────────────────
export interface BaseEntity {
  id: string;
  branchId: BranchId;
  createdAt: string;
  updatedAt: string;
}

// ─── Store shape returned to consumers ───────────────────────────────────────
export interface EntityStore<T extends BaseEntity> {
  /** All items regardless of branch */
  items: T[];
  /** Items filtered to a specific branch */
  byBranch: (branchId: BranchId) => T[];
  /** Single item lookup */
  byId: (id: string) => T | undefined;
  /** Add a new item — id + timestamps injected automatically */
  add: (draft: Omit<T, "id" | "createdAt" | "updatedAt">) => T;
  /** Patch an existing item — updatedAt refreshed automatically */
  update: (id: string, patch: Partial<Omit<T, "id" | "createdAt">>) => void;
  /** Hard delete */
  remove: (id: string) => void;
  /** Bulk replace (used by import / API hydration / seed reset) */
  reset: (items: T[]) => void;
}

// ─── ID generator ─────────────────────────────────────────────────────────────
let _seq = Date.now();
const uid = () => `${(++_seq).toString(36)}`;

// ─── Storage helpers ──────────────────────────────────────────────────────────

const sameId = (a: unknown, b: unknown): boolean => String(a) === String(b);

const safeScope = (scope: string): string =>
  scope
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "missing-org-scope";

const storageKeyFor = (baseKey: string, scope: string): string =>
  `${baseKey}_${safeScope(scope)}`;

function readOrganizationScopeFromCurrentUser(): string | null {
  try {
    const user = JSON.parse(localStorage.getItem("currentUser") || "null") as {
      organization_id?: string | number | null;
      organizationId?: string | number | null;
      organization_slug?: string | null;
    } | null;

    const organizationId = user?.organization_id ?? user?.organizationId;
    if (
      organizationId !== null &&
      organizationId !== undefined &&
      organizationId !== ""
    ) {
      return `org-${String(organizationId)}`;
    }

    if (user?.organization_slug) {
      return `org-${user.organization_slug}`;
    }
  } catch {
    // Ignore malformed localStorage and fall through to isolated fallback.
  }

  return null;
}

function resolveStorageScope(
  storageScope: string | number | null | undefined,
): string {
  const explicitScope = String(storageScope ?? "").trim();
  if (explicitScope && explicitScope.toLowerCase() !== "global") {
    return explicitScope;
  }

  const derivedScope = readOrganizationScopeFromCurrentUser();
  if (derivedScope) return derivedScope;

  // Last-resort fallback for login/onboarding gaps. It is intentionally not
  // called "global", so accidental module data does not mix with old buckets.
  return "missing-org-scope";
}

function loadFromStorage<T>(key: string): T[] | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : null;
  } catch {
    return null;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────
/**
 * @param storageKey  localStorage key — prefix with entity name, e.g. "staff"
 * @param seed        Called when localStorage is empty — returns initial rows
 *
 * Returns a React hook. Call it once per entity inside ModuleProvider.
 * storageScope should be organization_id / organization_slug from auth context.
 */
export function createEntityStore<T extends BaseEntity>(
  storageKey: string,
  seed: () => T[],
) {
  const BASE_LS_KEY = `erp_${storageKey}_v1`;

  function load(scope: string): T[] {
    const key = storageKeyFor(BASE_LS_KEY, scope);

    const scopedData = loadFromStorage<T>(key);
    if (scopedData) return scopedData;

    const initial = seed();
    localStorage.setItem(key, JSON.stringify(initial));
    return initial;
  }

  function save(scope: string, items: T[]): void {
    localStorage.setItem(
      storageKeyFor(BASE_LS_KEY, scope),
      JSON.stringify(items),
    );
  }

  /** The hook — call this inside a Provider component */
  function useEntityStore(
    storageScope?: string | number | null,
  ): EntityStore<T> {
    const scope = useMemo(
      () => safeScope(resolveStorageScope(storageScope)),
      [storageScope],
    );

    const [items, setItems] = useState<T[]>(() => load(scope));

    // When the active organization changes, switch to that organization's
    // isolated localStorage bucket.
    useEffect(() => {
      setItems(load(scope));
    }, [scope]);

    const byBranch = useCallback(
      (branchId: BranchId) => items.filter((i) => sameId(i.branchId, branchId)),
      [items],
    );

    const byId = useCallback(
      (id: string) => items.find((i) => i.id === id),
      [items],
    );

    const add = useCallback(
      (draft: Omit<T, "id" | "createdAt" | "updatedAt">): T => {
        const now = new Date().toISOString();
        const item = {
          ...draft,
          id: uid(),
          createdAt: now,
          updatedAt: now,
        } as T;

        setItems((prev) => {
          const next = [...prev, item];
          save(scope, next);
          return next;
        });

        return item;
      },
      [scope],
    );

    const update = useCallback(
      (id: string, patch: Partial<Omit<T, "id" | "createdAt">>) => {
        setItems((prev) => {
          const next = prev.map((item) =>
            item.id === id
              ? { ...item, ...patch, updatedAt: new Date().toISOString() }
              : item,
          );
          save(scope, next);
          return next;
        });
      },
      [scope],
    );

    const remove = useCallback(
      (id: string) => {
        setItems((prev) => {
          const next = prev.filter((i) => i.id !== id);
          save(scope, next);
          return next;
        });
      },
      [scope],
    );

    const reset = useCallback(
      (incoming: T[]) => {
        setItems(incoming);
        save(scope, incoming);
      },
      [scope],
    );

    return useMemo(
      () => ({ items, byBranch, byId, add, update, remove, reset }),
      [items, byBranch, byId, add, update, remove, reset],
    );
  }

  return useEntityStore;
}
