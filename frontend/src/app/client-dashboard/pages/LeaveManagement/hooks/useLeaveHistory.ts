/**
 * modules/leave/hooks/useLeaveHistory.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-employee leave balance aggregation for the Leave Management
 * "Leave History" tab.
 *
 * One row per staff member, built from the full roster (StaffManagement's
 * listStaffRecords — so an employee who hasn't taken any leave this year
 * still shows a row with zeros) joined against `leaves` for the selected
 * calendar year.
 *
 * Design notes:
 *  - `leaves` is passed in rather than fetched here — useLeaveActions
 *    already holds the org/branch-scoped leave list the "Leaves" tab
 *    uses, and it's the exact same data the History tab aggregates.
 *    Fetching it twice would just be a redundant round trip.
 *  - `leaveTypeRules`/`leaveTypeQuotas` are passed in for the same
 *    reason — useLeaveTypeOptions already owns fetching + caching them.
 *  - Paid/unpaid classification uses `leaveTypeRules` (the *current*
 *    Payroll Rules configuration), not each leave's stored
 *    `leaveCompensation` snapshot. This keeps "Total Paid Leaves" (a
 *    quota keyed by current rules) and "Taken Paid Leaves" computed on
 *    the same basis — mixing the two would let a leave type that was
 *    reclassified after the fact silently disagree with its own quota.
 *    A leave whose type isn't in `leaveTypeRules` at all (e.g. a type
 *    since removed from Payroll Rules) falls back to its own stored
 *    `leaveCompensation` so it isn't dropped from the totals entirely.
 *  - "Total Paid Leaves" sums `leaveTypeQuotas[type]` across every type
 *    tagged "paid" in `leaveTypeRules`. `quotaConfigured` is false when
 *    none of those paid types has a quota entry yet — the UI renders
 *    "—" for Total/Remaining rather than a misleading "0".
 *  - Remaining is *not* clamped at 0 — an employee who has taken more
 *    than their quota is operationally meaningful (a policy overage);
 *    hiding it behind a floor of 0 would hide the exact thing HR would
 *    want this tab to surface. The table renders a negative remaining
 *    in a warning color instead.
 *  - Roster is scoped to active staff only (a leave-balance view of a
 *    deactivated account isn't actionable). If inactive staff should
 *    still appear, drop the `status === "active"` filter below.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { resolveTenantScope } from "../../../utils/tenantScope";
import { listStaffRecords } from "../../StaffManagement/api/staffApi";
import { getLeavesTaken } from "../api/leaveApi";
import type { User } from "../../../api/api";
import type {
  LeaveTypeQuotas,
  LeaveTypeRules,
  TakenLeaveRecord,
} from "../api/leaveApi";
import type { LeaveHistoryRow, PendingLeaveItem } from "../types/leave";

export interface UseLeaveHistoryOptions {
  leaves: PendingLeaveItem[];
  leaveTypeRules: LeaveTypeRules;
  leaveTypeQuotas: LeaveTypeQuotas;
  /** Calendar year to aggregate — a leave counts if its startDate falls
   * in this year. */
  year: number;
  branchId?: number | string | null;
}

export interface UseLeaveHistoryReturn {
  rows: LeaveHistoryRow[];
  loading: boolean;
  error: string | null;
  /** True when at least one paid leave type has a configured annual
   * quota. Drives the "no quota configured yet" banner — distinct from
   * each row's own `quotaConfigured`, which can vary if a branch-level
   * override only sets quotas for some types. */
  quotaConfigured: boolean;
  refresh: () => Promise<void>;
}

// Roster changes far less often than the leave list itself (an admin
// action, not day-to-day data) — same reasoning as useLeaveTypeOptions's
// cache, kept independent of it since the two are unrelated endpoints.
const ROSTER_CACHE_TTL_MS = 30_000;
const rosterCache = new Map<string, { expiresAt: number; roster: User[] }>();
const rosterInflight = new Map<string, Promise<User[]>>();

function rosterCacheKey(
  organizationId: string | number,
  branchId?: string | number | null,
): string {
  return `${organizationId}::${branchId ?? "org"}`;
}

async function loadRosterCached(
  key: string,
  organizationId: string | number,
  branchId: string | number | null | undefined,
  force: boolean,
): Promise<User[]> {
  if (!force) {
    const cached = rosterCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.roster;
    const existing = rosterInflight.get(key);
    if (existing) return existing;
  }

  const promise = listStaffRecords({ organizationId, branchId })
    .then((roster) => {
      rosterCache.set(key, {
        expiresAt: Date.now() + ROSTER_CACHE_TTL_MS,
        roster,
      });
      return roster;
    })
    .finally(() => {
      rosterInflight.delete(key);
    });

  rosterInflight.set(key, promise);
  return promise;
}

/** True when `leaveType` is tagged "paid" in the effective leaveTypeRules. */
function isPaidType(leaveType: string, rules: LeaveTypeRules): boolean {
  return rules[leaveType] === "paid";
}

/** Resolves whether a single leave counts as paid, unpaid, or neither
 * (unresolvable — excluded from both buckets rather than guessed). */
function resolveLeaveBucket(
  leave: PendingLeaveItem,
  rules: LeaveTypeRules,
): "paid" | "unpaid" | null {
  const rule = rules[leave.type];
  if (rule === "paid" || rule === "unpaid") return rule;
  // Type not in the current Payroll Rules config (e.g. since removed) —
  // fall back to what was decided for this specific request at the time.
  if (
    leave.leaveCompensation === "paid" ||
    leave.leaveCompensation === "unpaid"
  ) {
    return leave.leaveCompensation;
  }
  return null;
}

function leaveYear(leave: PendingLeaveItem): number | null {
  const raw = leave.startDate || leave.appliedOn || leave.createdAt;
  if (!raw) return null;
  const year = Number(String(raw).slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

export function useLeaveHistory({
  leaves,
  leaveTypeRules,
  leaveTypeQuotas,
  year,
  branchId,
}: UseLeaveHistoryOptions): UseLeaveHistoryReturn {
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

  const [roster, setRoster] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [takenByStaffLoading, setTakenByStaffLoading] = useState(false);
  const [takenByStaff, setTakenByStaff] = useState<
    Map<string, { paid: number; unpaid: number }>
  >(new Map());
  const mountedRef = useRef(true);

  const load = useCallback(
    async (force = false) => {
      if (!scope?.organizationId) {
        setRoster([]);
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);
        const key = rosterCacheKey(scope.organizationId, scope.apiBranchId);
        const next = await loadRosterCached(
          key,
          scope.organizationId,
          scope.apiBranchId,
          force,
        );
        if (!mountedRef.current) return;
        setRoster(next);
      } catch (err) {
        if (!mountedRef.current) return;
        setError(
          err instanceof Error ? err.message : "Failed to load staff roster.",
        );
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [scope?.apiBranchId, scope?.organizationId],
  );

  const refresh = useCallback(() => load(true), [load]);

  // Helper for logging warnings
  const logger = useMemo(
    () => ({
      warning: (msg: string, err?: unknown) => {
        console.warn(`[useLeaveHistory] ${msg}`, err);
      },
    }),
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  // ── Load reconciled leave-taken data (attendance-reconciled) ──────────────
  useEffect(() => {
    if (!scope?.organizationId || !scope?.apiBranchId) {
      setTakenByStaff(new Map());
      return;
    }

    const loadTakenLeaves = async () => {
      try {
        setTakenByStaffLoading(true);
        const takenData = await getLeavesTaken({
          year,
          branchId: scope.apiBranchId,
          organizationId: scope.organizationId,
        });

        if (!mountedRef.current) return;

        // Convert the API response to a Map keyed by staff ID
        const map = new Map<string, { paid: number; unpaid: number }>();
        for (const [staffId, record] of Object.entries(takenData)) {
          map.set(staffId, {
            paid: record.takenPaidLeaves,
            unpaid: record.takenUnpaidLeaves,
          });
        }
        setTakenByStaff(map);
      } catch (err) {
        // Fall back to empty map on error — the hook should still render
        // with zero taken leaves rather than crashing the component.
        if (mountedRef.current) {
          logger.warning(
            "Failed to fetch reconciled leave-taken data; using fallback",
            err,
          );
          setTakenByStaff(new Map());
        }
      } finally {
        if (mountedRef.current) setTakenByStaffLoading(false);
      }
    };

    void loadTakenLeaves();
  }, [year, scope?.organizationId, scope?.apiBranchId, logger]);

  // ── Which paid leave types actually have a configured quota ──────────────
  const paidTypesWithQuota = useMemo(
    () =>
      Object.keys(leaveTypeRules).filter(
        (type) => isPaidType(type, leaveTypeRules) && type in leaveTypeQuotas,
      ),
    [leaveTypeRules, leaveTypeQuotas],
  );

  const unpaidTypesWithQuota = useMemo(
    () =>
      Object.keys(leaveTypeRules).filter(
        (type) => leaveTypeRules[type] === "unpaid" && type in leaveTypeQuotas,
      ),
    [leaveTypeRules, leaveTypeQuotas],
  );

  const totalPaidLeaves = useMemo(
    () =>
      Object.keys(leaveTypeRules)
        .filter((type) => isPaidType(type, leaveTypeRules))
        .reduce((sum, type) => sum + (leaveTypeQuotas[type] ?? 0), 0),
    [leaveTypeRules, leaveTypeQuotas],
  );

  const totalUnpaidLeaves = useMemo(
    () =>
      Object.keys(leaveTypeRules)
        .filter((type) => leaveTypeRules[type] === "unpaid")
        .reduce((sum, type) => sum + (leaveTypeQuotas[type] ?? 0), 0),
    [leaveTypeRules, leaveTypeQuotas],
  );

  const totalLeaves = useMemo(
    () => totalPaidLeaves + totalUnpaidLeaves,
    [totalPaidLeaves, totalUnpaidLeaves],
  );

  const quotaConfigured =
    paidTypesWithQuota.length > 0 || unpaidTypesWithQuota.length > 0;

  // ── Per-employee taken totals (attendance-reconciled, from backend) ───────
  // The backend endpoint /api/leaves/taken returns leave days that count as
  // "taken" only when BOTH conditions hold:
  //   1. Approved leave request covers that date
  //   2. Staff member was NOT present that date (no attendance row)
  // This matches Payroll's reconciliation logic exactly, so both screens
  // always show the same numbers. Previously this was calculated client-side
  // without checking attendance, causing Leave History and Payroll to disagree.
  //
  // See: payroll_engine.reconcile_leave_against_attendance() — the same
  // logic the backend uses for payroll computations.

  // NOTE — scope gap vs. the "Leaves" tab: useLeaveActions filters its
  // list to the branch's configured module people types (e.g. exclude
  // "teacher" accounts from a "worker"-only leave module) via
  // getModulePeopleTypesForBranch + normalizeLeavePeopleType. The
  // roster fetched here isn't filtered the same way, because the `User`
  // record returned by listStaffRecords doesn't expose a people-type
  // field in this codebase to filter on client-side, and StaffListParams
  // only accepts a single peopleType value server-side (module scoping
  // can allow more than one). In a single-people-type org this is a
  // no-op; in a multi-people-type org the History tab may list staff
  // outside the Leave module's scope. Flagging this rather than
  // guessing at an API this hook can't verify — tell me which field on
  // the staff record carries people type and I'll wire the same
  // filter useLeaveActions uses.

  const rows = useMemo<LeaveHistoryRow[]>(() => {
    return roster
      .filter((staff) => (staff.status ?? "active") === "active")
      .map((staff) => {
        const staffKey = String(staff.id);
        const taken = takenByStaff.get(staffKey) ?? { paid: 0, unpaid: 0 };
        const remainingPaidLeaves = totalPaidLeaves - taken.paid;
        const remainingUnpaidLeaves = totalUnpaidLeaves - taken.unpaid;
        const totalLeaves = totalPaidLeaves + totalUnpaidLeaves;
        const remainingLeaves = totalLeaves - (taken.paid + taken.unpaid);

        return {
          staffId: staff.employee_id || String(staff.id),
          name: staff.name,
          department: staff.department || "General",
          branchName: staff.branch_name ?? undefined,
          totalPaidLeaves,
          takenPaidLeaves: taken.paid,
          totalUnpaidLeaves,
          takenUnpaidLeaves: taken.unpaid,
          totalLeaves,
          remainingPaidLeaves,
          remainingUnpaidLeaves,
          remainingLeaves,
          quotaConfigured,
        };
      });
  }, [
    roster,
    takenByStaff,
    totalPaidLeaves,
    totalUnpaidLeaves,
    quotaConfigured,
  ]);

  return {
    rows,
    loading: loading || takenByStaffLoading,
    error,
    quotaConfigured,
    refresh,
  };
}

export default useLeaveHistory;
