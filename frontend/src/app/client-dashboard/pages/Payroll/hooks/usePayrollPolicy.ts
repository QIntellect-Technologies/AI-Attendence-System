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
  type PayrollPolicyWrite,
  type PayrollPolicyScope,
  type PayrollPolicySaveOptions,
  type PayrollId,
} from "../api/payrollApi";

export interface UsePayrollPolicyReturn {
  policy: PayrollPolicy;
  loading: boolean;
  saving: boolean;
  error: string | null;
  save: (
    next: PayrollPolicyWrite,
    options?: PayrollPolicySaveOptions,
  ) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * scope: omit for the org-wide default (unchanged behavior — the Payroll
 * Rules modal's base editor). Pass { branchId } to edit/read a branch
 * override, { departmentId } for a department override, or { staffId } for
 * an individual override. Reads resolve individual > branch-department >
 * department > branch > org.
 */
export function usePayrollPolicy(
  scope?: PayrollPolicyScope,
): UsePayrollPolicyReturn {
  const { organizationId } = useOrg();
  const branchId: PayrollId | null | undefined = scope?.branchId;
  const departmentId: PayrollId | null | undefined = scope?.departmentId;
  const staffId: PayrollId | null | undefined = scope?.staffId;
  const [policy, setPolicy] = useState<PayrollPolicy>(DEFAULT_PAYROLL_POLICY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!organizationId) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const next = await getPayrollPolicy(organizationId, {
        branchId,
        departmentId,
        staffId,
      });
      if (mountedRef.current && requestId === requestIdRef.current)
        setPolicy(next);
    } catch (err) {
      if (mountedRef.current && requestId === requestIdRef.current)
        setError(
          err instanceof Error ? err.message : "Failed to load payroll policy.",
        );
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current)
        setLoading(false);
    }
  }, [organizationId, branchId, departmentId, staffId]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [refresh]);

  const save = useCallback(
    async (
      next: PayrollPolicyWrite,
      options?: PayrollPolicySaveOptions,
    ) => {
      if (!organizationId) throw new Error("organization_id is required.");
      setSaving(true);
      setError(null);
      try {
        const saved = await savePayrollPolicy(organizationId, next, {
          branchId,
          departmentId,
          staffId,
        }, options);
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
    [organizationId, branchId, departmentId, staffId],
  );

  return { policy, loading, saving, error, save, refresh };
}

export default usePayrollPolicy;