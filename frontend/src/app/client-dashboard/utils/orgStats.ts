/**
 * orgStats.ts
 * Small shared org-level aggregation helpers used by dashboard headers/pages.
 */

export function uniqueConfiguredRoleCount(
  roles: Record<number | string, Array<{ name: string }>>,
): number {
  const map = new Map<string, true>();

  Object.values(roles)
    .flat()
    .forEach((role) => {
      const key = role.name.trim().toLowerCase();
      if (key) map.set(key, true);
    });

  return map.size;
}
