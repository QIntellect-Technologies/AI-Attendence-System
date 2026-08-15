/**
 * usePayrollPolicy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Org-wide, client-configurable payroll policy: leave-type paid/unpaid
 * rules, late-coming policy, per-day rate basis. Backs the Payroll Rules
 * modal in PayrollModule.tsx.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import {
  getPayrollPolicy,
  savePayrollPolicy,
  DEFAULT_PAYROLL_POLICY,
  type PayrollPolicy,
  type PayrollPolicyScope,
  type PayrollId,
} from "../api/payrollApi";

export interface UsePayrollPolicyReturn {
  policy: PayrollPolicy;
  loading: boolean;
  saving: boolean;
  error: string | null;
  save: (next: PayrollPolicy) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * scope: omit for the org-wide default (unchanged behavior — the Payroll
 * Rules modal's base editor). Pass { branchId } to edit/read a branch
 * override, or { staffId } for an individual override. See
 * payrollApi.getPayrollPolicy for the individual > branch > org fallback
 * used when reading.
 */
export function usePayrollPolicy(
  scope?: PayrollPolicyScope,
): UsePayrollPolicyReturn {
  const { organizationId } = useOrg();
  const branchId: PayrollId | null | undefined = scope?.branchId;
  const staffId: PayrollId | null | undefined = scope?.staffId;
  const [policy, setPolicy] = useState<PayrollPolicy>(DEFAULT_PAYROLL_POLICY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!organizationId) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const next = await getPayrollPolicy(organizationId, { branchId, staffId });
      if (mountedRef.current) setPolicy(next);
    } catch (err) {
      if (mountedRef.current)
        setError(
          err instanceof Error ? err.message : "Failed to load payroll policy.",
        );
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [organizationId, branchId, staffId]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const save = useCallback(
    async (next: PayrollPolicy) => {
      if (!organizationId) throw new Error("organization_id is required.");
      setSaving(true);
      setError(null);
      try {
        const saved = await savePayrollPolicy(organizationId, next, {
          branchId,
          staffId,
        });
        if (mountedRef.current) setPolicy(saved);
      } catch (err) {
        if (mountedRef.current)
          setError(
            err instanceof Error
              ? err.message
              : "Failed to save payroll policy.",
          );
        throw err;
      } finally {
        if (mountedRef.current) setSaving(false);
      }
    },
    [organizationId, branchId, staffId],
  );

  return { policy, loading, saving, error, save, refresh };
}

export default usePayrollPolicy;