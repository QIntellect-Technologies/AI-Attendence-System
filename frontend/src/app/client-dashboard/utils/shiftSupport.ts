/**
 * shiftSupport.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single place that decides "does this people type use shifts?".
 *
 * Settings → Shift Scheduling stores a per-people-type list. That list has THREE
 * meaningful states, which the old `list.length > 0` check collapsed into two:
 *
 *   null / undefined  never configured  -> use the legacy default (non-students)
 *   ["staff"]         configured        -> exactly these types use shifts
 *   []                configured, empty -> NO people type uses shifts
 *
 * Framework-agnostic on purpose (no React) so templateRendering.ts,
 * templateColumns.ts, OrgConfigContext.tsx and Settings.tsx all share it.
 */

const toKey = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

/**
 * Returns the first source that is an actual list (or a comma/pipe separated
 * string), normalised and de-duplicated. Returns null when no source holds a
 * list, i.e. shift enablement was never configured.
 */
export function readShiftEnabledPeopleTypes(
  ...sources: unknown[]
): string[] | null {
  for (const source of sources) {
    let items: unknown[] | null = null;
    if (Array.isArray(source)) items = source;
    else if (typeof source === "string" && source.trim())
      items = source.split(/[,|]/);
    if (items) return Array.from(new Set(items.map(toKey).filter(Boolean)));
  }
  return null;
}

/**
 * Every person is timed by a shift (personal shift, else the branch
 * default), so every people type supports shifts. The saved
 * Settings -> Shift Scheduling list no longer switches this off.
 */
export function resolveSupportsShift(
  _enabledPeopleTypes: string[] | null | undefined,
  _peopleType: string,
  _fallback: boolean,
): boolean {
  return true;
}