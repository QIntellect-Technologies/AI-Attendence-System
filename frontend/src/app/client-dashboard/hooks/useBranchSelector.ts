/**
 * useBranchSelector.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for branch selection across every page.
 *
 * Production access rules:
 *   • Admin users can see/switch all configured branches.
 *   • Staff users are locked to allowedBranchIds / branch_id from AuthContext.
 *   • Staff users never receive the "All Branches" sentinel.
 *   • Staff branch switching silently ignores unauthorized branch attempts.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/useAuth";
import { useOrg } from "../contexts/OrgConfigContext";

export const ALL_BRANCHES_ID = -1;

export type BranchSelectorMode = "filter" | "navigate";

export interface SelectorBranch {
  id: number;
  name: string;
  city: string;
}

export interface UseBranchSelectorReturn {
  selectorBranches: SelectorBranch[];
  selected: SelectorBranch;
  onChange: (branch: SelectorBranch) => void;
  selectedBranchId: number | undefined;
  navigateToBranch: (branchId: number) => void;
  isAllBranches: boolean;
  reset: () => void;
}

interface AuthUser {
  role?: string;
  branchId?: number | string | null;
  branch_id?: number | string | null;
  allowedBranchIds?: Array<number | string>;
}

function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isStaffUser(user: AuthUser | null | undefined): boolean {
  return String(user?.role ?? "").toLowerCase() === "staff";
}

function authBranchId(user: AuthUser | null | undefined): number | null {
  const direct = toNumberOrNull(user?.branchId ?? user?.branch_id);
  if (direct) return direct;

  const firstAllowed = Array.isArray(user?.allowedBranchIds)
    ? user.allowedBranchIds[0]
    : null;

  return toNumberOrNull(firstAllowed);
}

function authAllowedBranchIds(user: AuthUser | null | undefined): number[] {
  const explicit = Array.isArray(user?.allowedBranchIds)
    ? user.allowedBranchIds
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0)
    : [];

  if (explicit.length > 0) return Array.from(new Set(explicit));

  const direct = authBranchId(user);
  return direct ? [direct] : [];
}

const ALL_BRANCHES_ENTRY: SelectorBranch = {
  id: ALL_BRANCHES_ID,
  name: "All Branches",
  city: "",
};

export function useBranchSelector(
  mode: BranchSelectorMode = "filter",
  initialBranchId?: number,
  showAllOption?: boolean,
): UseBranchSelectorReturn {
  const { cfg, setActiveBranchId } = useOrg();
  const { user: rawUser } = useAuth() as { user?: AuthUser | null };
  const navigate = useNavigate();

  const user = rawUser ?? null;
  const staffDashboard = isStaffUser(user);
  const allowedBranchIds = useMemo(() => authAllowedBranchIds(user), [user]);
  const allowedBranchIdSet = useMemo(
    () => new Set(allowedBranchIds),
    [allowedBranchIds],
  );

  // Staff must never see or navigate to "All Branches".
  const shouldShowAll = staffDashboard
    ? false
    : (showAllOption ?? mode === "filter");

  const rawBranches = useMemo<SelectorBranch[]>(() => {
    const normalized = (cfg.branches ?? []).map((branch) => ({
      id: Number(branch.id),
      name: branch.name,
      city: branch.city ?? "",
    }));

    if (!staffDashboard) return normalized;

    return normalized.filter((branch) => allowedBranchIdSet.has(branch.id));
  }, [allowedBranchIdSet, cfg.branches, staffDashboard]);

  const selectorBranches = useMemo<SelectorBranch[]>(() => {
    if (shouldShowAll) return [ALL_BRANCHES_ENTRY, ...rawBranches];
    return rawBranches;
  }, [rawBranches, shouldShowAll]);

  const defaultEntry = useMemo<SelectorBranch>(() => {
    if (staffDashboard) {
      const ownBranchId = authBranchId(user);
      return (
        rawBranches.find((branch) => branch.id === ownBranchId) ??
        rawBranches[0] ??
        ALL_BRANCHES_ENTRY
      );
    }

    if (initialBranchId !== undefined) {
      return (
        rawBranches.find((branch) => branch.id === initialBranchId) ??
        rawBranches[0] ??
        ALL_BRANCHES_ENTRY
      );
    }

    return shouldShowAll
      ? ALL_BRANCHES_ENTRY
      : (rawBranches[0] ?? ALL_BRANCHES_ENTRY);
  }, [initialBranchId, rawBranches, shouldShowAll, staffDashboard, user]);

  const [selected, setSelected] = useState<SelectorBranch>(defaultEntry);

  useEffect(() => {
    setSelected((current) => {
      if (selectorBranches.some((branch) => branch.id === current.id)) {
        return current;
      }
      return defaultEntry;
    });
  }, [defaultEntry, selectorBranches]);

  const selectedBranchId: number | undefined =
    selected.id === ALL_BRANCHES_ID ? undefined : selected.id;

  const navigateToBranch = useCallback(
    (branchId: number) => {
      if (staffDashboard && !allowedBranchIdSet.has(branchId)) return;
      navigate(`/admin/branch/${branchId}`);
    },
    [allowedBranchIdSet, navigate, staffDashboard],
  );

  const onChange = useCallback(
    (branch: SelectorBranch) => {
      if (staffDashboard) {
        if (branch.id === ALL_BRANCHES_ID) return;
        if (!allowedBranchIdSet.has(branch.id)) return;
      }

      setSelected(branch);

      if (mode === "navigate") {
        const newId = branch.id === ALL_BRANCHES_ID ? null : branch.id;
        setActiveBranchId(newId);

        if (branch.id === ALL_BRANCHES_ID) {
          navigate("/admin");
        } else {
          navigateToBranch(branch.id);
        }
      }
    },
    [
      allowedBranchIdSet,
      mode,
      navigate,
      navigateToBranch,
      setActiveBranchId,
      staffDashboard,
    ],
  );

  const reset = useCallback(() => {
    setSelected(defaultEntry);

    if (mode === "navigate") {
      const newId =
        defaultEntry.id === ALL_BRANCHES_ID ? null : defaultEntry.id;
      setActiveBranchId(newId);

      if (defaultEntry.id !== ALL_BRANCHES_ID) {
        navigateToBranch(defaultEntry.id);
      }
    }
  }, [defaultEntry, mode, navigateToBranch, setActiveBranchId]);

  return {
    selectorBranches,
    selected,
    onChange,
    selectedBranchId,
    navigateToBranch,
    isAllBranches: selectedBranchId === undefined,
    reset,
  };
}

export default useBranchSelector;
