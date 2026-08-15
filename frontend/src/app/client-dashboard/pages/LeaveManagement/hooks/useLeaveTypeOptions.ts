/**
 * modules/leave/hooks/useLeaveTypeOptions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Effective, branch-aware leave-type configuration for the current org
 * scope. Source of truth is still support_db_payroll's PayrollPolicy
 * (edited from the Payroll Rules modal), but this hook is what the Leave
 * module actually calls — it never imports usePayrollPolicy or touches
 * salary/OT/late-coming fields it has no business reading. See
 * leaveApi.getLeaveTypeRules / support_db_payroll.get_leave_type_rules.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { resolveTenantScope } from "../../../utils/tenantScope";
import {
  getLeaveTypeAllocations,
  type LeaveTypeRules,
  type LeaveTypeQuotas,
} from "../api/leaveApi";

export interface UseLeaveTypeOptionsReturn {
  /** Raw { [leaveType]: "paid" | "unpaid" } map, keyed by config slug. */
  leaveTypeRules: LeaveTypeRules;
  /** Raw { [leaveType]: annualQuotaDays } map. A type absent here has no
   * configured quota yet (unknown, not zero) — see useLeaveHistory. */
  leaveTypeQuotas: LeaveTypeQuotas;
  /** Sorted list of configured type keys, or null when none are
   * configured yet — callers (useLeaveFilters) fall back to deriving
   * options from the actual leave rows when this is null, same contract
   * the old cfg.payrollPolicy.leaveTypeRules-derived value had. */
  leaveTypes: string[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

interface LeaveTypeAllocations {
  leaveTypeRules: LeaveTypeRules;
  leaveTypeQuotas: LeaveTypeQuotas;
}

const EMPTY_ALLOCATIONS: LeaveTypeAllocations = {
  leaveTypeRules: {},
  leaveTypeQuotas: {},
};

// Leave-type configuration changes far less often than the leave list
// itself (it's an admin setting, not day-to-day data), so this gets a
// longer TTL than useLeaveActions's 8s leave-list cache — no need to
// re-fetch it on every 10s auto-refresh tick.
const CACHE_TTL_MS = 30_000;
const rulesCache = new Map<
  string,
  { expiresAt: number; allocations: LeaveTypeAllocations }
>();
const rulesInflight = new Map<string, Promise<LeaveTypeAllocations>>();

function cacheKey(
  organizationId: string | number,
  branchId?: string | number | null,
): string {
  return `${organizationId}::${branchId ?? "org"}`;
}

async function loadLeaveTypeRulesCached(
  key: string,
  organizationId: string | number,
  branchId?: string | number | null,
): Promise<LeaveTypeAllocations> {
  const cached = rulesCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.allocations;

  const existing = rulesInflight.get(key);
  if (existing) return existing;

  const promise = getLeaveTypeAllocations({ organizationId, branchId })
    .then((allocations) => {
      rulesCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, allocations });
      return allocations;
    })
    .finally(() => {
      rulesInflight.delete(key);
    });

  rulesInflight.set(key, promise);
  return promise;
}

function invalidateLeaveTypeRulesCache(
  organizationId?: string | number | null,
): void {
  if (!organizationId) {
    rulesCache.clear();
    return;
  }
  const prefix = `${organizationId}::`;
  Array.from(rulesCache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) rulesCache.delete(key);
  });
}

/**
 * branchId: pass the branch currently in view (or null/undefined for
 * "All Branches"). This mirrors useLeaveActions's own branchId param so
 * the leave list and its type filter always resolve to the same tenant +
 * branch scope — the org-only cfg.payrollPolicy.leaveTypeRules this
 * replaced had no branch awareness at all, so a branch-level override
 * configured in Payroll Rules never reached the Leave Management filter.
 */
export function useLeaveTypeOptions(
  branchId?: number | string | null,
): UseLeaveTypeOptionsReturn {
  const { organizationId, activeBranchId, cfg } = useOrg();

  const scope = useMemo(() => {
    if (!organizationId) return null;
    return resolveTenantScope(
      {
        organizationId,
        branchId: branchId !== undefined ? branchId : activeBranchId,
      },
      cfg.branches,
    );
  }, [activeBranchId, branchId, cfg.branches, organizationId]);

  const [allocations, setAllocations] =
    useState<LeaveTypeAllocations>(EMPTY_ALLOCATIONS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // force=true invalidates the cache first — used by the public refresh()
  // (e.g. "the admin just saved new rules, re-fetch now"). The initial
  // mount / scope-change load below reads through the cache as normal.
  const load = useCallback(
    async (force = false) => {
      if (!scope?.organizationId) {
        setAllocations(EMPTY_ALLOCATIONS);
        setLoading(false);
        return;
      }
      try {
        setError(null);
        if (force) invalidateLeaveTypeRulesCache(scope.organizationId);
        const next = await loadLeaveTypeRulesCached(
          cacheKey(scope.organizationId, scope.apiBranchId),
          scope.organizationId,
          scope.apiBranchId,
        );
        if (!mountedRef.current) return;
        setAllocations(next);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(
          err instanceof Error ? err.message : "Failed to load leave types.",
        );
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [scope?.apiBranchId, scope?.organizationId],
  );

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const leaveTypes = useMemo(() => {
    const keys = Object.keys(allocations.leaveTypeRules)
      .map((type) => type.trim())
      .filter((type) => type.length > 0);
    return keys.length ? keys.sort() : null;
  }, [allocations.leaveTypeRules]);

  return {
    leaveTypeRules: allocations.leaveTypeRules,
    leaveTypeQuotas: allocations.leaveTypeQuotas,
    leaveTypes,
    loading,
    error,
    refresh,
  };
}

export default useLeaveTypeOptions;