/**
 * hooks/useOrgReady.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Ensures organization configuration is fully hydrated before dependent code runs.
 *
 * Problem it solves:
 *   OrgConfigContext initializes asynchronously via /api/client/bootstrap.
 *   Child components must NOT call APIs that depend on organizationId, branches,
 *   terminology, etc. until isOrgReady=true. Without this, race conditions cause
 *   cascading failures: API 400 → missing cfg → undefined terminology.
 *
 * Usage:
 *   const { isReady, organizationId, cfg } = useOrgReady();
 *
 *   useEffect(() => {
 *     if (!isReady) return;  // Wait until ready
 *     loadStaffData(organizationId);
 *   }, [isReady, organizationId]);
 *
 * Guarantees:
 *   ✓ organizationId is a valid non-null number or string
 *   ✓ cfg is fully normalized with all collections populated
 *   ✓ All branch-scoped lookups (departments, roles, etc.) are available
 *   ✓ No cascading failures from premature API calls
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useMemo } from "react";
import { useOrg } from "../contexts/OrgConfigContext";

export interface OrgReadyState {
  /**
   * True only when organizationId is loaded AND cfg is fully hydrated.
   * Safe to call organizationId-dependent APIs only when true.
   */
  isReady: boolean;

  /** Guaranteed non-null when isReady=true. */
  organizationId: number | string | null;

  /** Guaranteed fully normalized when isReady=true. */
  cfg: ReturnType<typeof useOrg>["cfg"];

  /** User-friendly reason why org is not ready (if not ready). */
  readyReason: "loading" | "no_org" | "ready";
}

/**
 * Guarantees that organizationId and cfg are both available before returning ready=true.
 * Prevents race conditions where child components call APIs before org context is hydrated.
 */
export function useOrgReady(): OrgReadyState {
  const { organizationId, isOrgReady, cfg } = useOrg();

  return useMemo(
    () => ({
      isReady: isOrgReady && Boolean(organizationId),
      organizationId,
      cfg,
      readyReason:
        !isOrgReady
          ? ("loading" as const)
          : !organizationId
            ? ("no_org" as const)
            : ("ready" as const),
    }),
    [isOrgReady, organizationId, cfg],
  );
}
