/**
 * useHasMultipleBranches.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Whether a branch picker is worth showing at all.
 *
 * Counts REAL branches only. Every selector in the app prepends a synthetic
 * "All Branches" entry, so `options.length > 1` is true even for a one-branch
 * org — which is why several pages still showed a dropdown offering a choice
 * between "All Branches" and the only branch that exists.
 *
 * Staff users are scoped to their allowed branches, so a staff member with one
 * assigned branch correctly gets no picker either.
 */
import { useMemo } from "react";
import { useOrg } from "../contexts/OrgConfigContext";

export function useHasMultipleBranches(): boolean {
  const { cfg } = useOrg();
  return useMemo(
    () => (Array.isArray(cfg.branches) ? cfg.branches.length : 0) > 1,
    [cfg.branches],
  );
}

export default useHasMultipleBranches;
