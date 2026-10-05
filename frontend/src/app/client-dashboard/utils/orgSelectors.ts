// src/app/utils/orgSelectors.ts
// Tenant/UUID-safe shared selectors.
// Important: never coerce branch IDs with Number(...). Supabase branch IDs are UUIDs,
// while the UI may still use numeric branch IDs. Compare normalized string values.

export type IdLike = string | number | null | undefined;

export function normalizeId(value: IdLike): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function idsEqual(a: IdLike, b: IdLike): boolean {
  const left = normalizeId(a);
  const right = normalizeId(b);
  return Boolean(left && right && left === right);
}

export function filterByBranch<
  T extends { branchId?: IdLike; branch_id?: IdLike },
>(rows: T[], branchId?: IdLike): T[] {
  const target = normalizeId(branchId);
  if (!target) return rows;

  return rows.filter((row) =>
    idsEqual(row.branchId ?? row.branch_id ?? null, target),
  );
}

export function countBy<T>(
  rows: T[],
  getKey: (row: T) => string | undefined | null,
) {
  const map = new Map<string, number>();

  rows.forEach((row) => {
    const key = getKey(row)?.trim() || "General";
    map.set(key, (map.get(key) ?? 0) + 1);
  });

  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function getUniqueDepartments(
  departments: Record<number | string, { name: string }[]>,
) {
  const map = new Map<string, { name: string }>();

  Object.values(departments)
    .flat()
    .forEach((dept) => {
      const key = dept.name.trim().toLowerCase();
      if (key) map.set(key, dept);
    });

  return Array.from(map.values());
}
