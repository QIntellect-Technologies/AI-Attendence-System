// import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// import { useOrg } from "../../../contexts/OrgConfigContext";
// import { resolveTenantScope } from "../../../utils/tenantScope";
// import { getModulePeopleTypesForBranch } from "../../../utils/templateRendering";
// import { getStaffRecord } from "../../StaffManagement/api/staffApi";
// import {
//   getLeaves,
//   updateLeaveStatus,
//   createLeaveRequest,
//   deleteLeaveRequest,
//   isUuid,
//   type LeaveRequest,
//   type CreateLeavePayload,
// } from "../api/leaveApi";
// import type { PendingLeaveItem } from "../types/leave";
// import { normalizeLeavePeopleType } from "../utils/leave.utils";

// interface UseLeaveActionsOptions {
//   branchId?: number | string | null;
//   autoRefresh?: boolean;
//   refreshMs?: number;
//   /**
//    * Performance switch for dashboard snapshot cards. When false the hook keeps
//    * its action API but does not fetch, so parent components can pass snapshot
//    * data without causing another /api/leaves request.
//    */
//   enabled?: boolean;
// }

// export interface UseLeaveActionsReturn {
//   leaves: PendingLeaveItem[];
//   pendingLeaves: PendingLeaveItem[];
//   loading: boolean;
//   refreshing: boolean;
//   loadingId: string | null;
//   error: string | null;

//   refresh: () => Promise<void>;
//   handleLeaveAction: (
//     leaveId: string,
//     status: "Approved" | "Rejected" | "approved" | "rejected",
//   ) => Promise<void>;
//   createLeave: (
//     payload: Omit<CreateLeavePayload, "organizationId">,
//   ) => Promise<void>;
//   deleteLeave: (leaveId: string) => Promise<void>;
// }

// type CacheEntry = {
//   expiresAt: number;
//   rows: LeaveRequest[];
// };

// const LEAVE_CACHE_TTL_MS = 8_000;
// const leavesCache = new Map<string, CacheEntry>();
// const leavesInflight = new Map<string, Promise<LeaveRequest[]>>();

// function toTitleStatus(
//   status: LeaveRequest["status"],
// ): "Pending" | "Approved" | "Rejected" {
//   const raw = String(status || "pending").toLowerCase();
//   if (raw === "approved") return "Approved";
//   if (raw === "rejected") return "Rejected";
//   return "Pending";
// }

// function toActionStatus(
//   status: "Approved" | "Rejected" | "approved" | "rejected",
// ): "approved" | "rejected" {
//   return String(status).toLowerCase() === "rejected" ? "rejected" : "approved";
// }

// function optionalText(value: string | null | undefined): string | undefined {
//   if (value === null || value === undefined) return undefined;
//   const text = String(value).trim();
//   return text || undefined;
// }

// function optionalId(
//   value: string | number | null | undefined,
// ): string | number | undefined {
//   if (value === null || value === undefined || value === "") return undefined;
//   return value;
// }

// function mapToPendingLeaveItem(item: LeaveRequest): PendingLeaveItem {
//   const createdAt = optionalText(item.createdAt);
//   const updatedAt = optionalText(item.updatedAt);

//   return {
//     id: item.id,
//     userId: optionalId(item.userId),
//     staffId: item.userId ? String(item.userId) : undefined,
//     name: item.name,
//     staffName: item.name,
//     peopleType: String(item.peopleType ?? item.people_type ?? "staff")
//       .trim()
//       .toLowerCase()
//       .replace(/[\s-]+/g, "_"),
//     branchId: item.branchId ?? undefined,
//     branchName: item.branchName || "Main Branch",
//     dept: item.dept || "General",
//     department: item.dept || item.department || "General",
//     type: item.type,
//     leaveCompensation:
//       item.leaveCompensation ?? item.leave_compensation ?? "not_configured",
//     leavePayrollDecision:
//       item.leavePayrollDecision ?? item.leave_payroll_decision ?? null,
//     halfDayPeriod: item.halfDayPeriod ?? null,
//     halfDayStartTime: item.halfDayStartTime ?? null,
//     halfDayEndTime: item.halfDayEndTime ?? null,
//     days: item.days,
//     status: toTitleStatus(item.status),
//     startDate: item.startDate,
//     endDate: item.endDate,
//     reason: item.reason,
//     approvedBy: optionalText(item.approvedBy),
//     appliedOn: createdAt?.slice(0, 10),
//     createdAt,
//     updatedAt,
//   };
// }

// function leaveCacheKey(
//   organizationId: string | number,
//   branchId?: string | number | null,
// ): string {
//   return `${organizationId}::${branchId ?? "all"}`;
// }

// // ── Approver name resolution ────────────────────────────────────────────────
// // leaveApi.ts leaves `approvedById` as a raw manager user ID whenever the
// // backend hasn't resolved it to a label. We join that against the staff
// // directory here (not in leaveApi.ts, which is a pure wire-format adapter)
// // and cache the result — a manager's name/code changes rarely, so this is
// // cached far longer than the leave list itself and is never re-fetched on
// // every 10s auto-refresh once warm.
// //
// // ASSUMPTION: the exact field names for a person's display name and person
// // code on the `User` record aren't visible from these files alone, so this
// // tries every alias already in use elsewhere in this codebase (see
// // staffApi.ts's StaffPayload) in priority order. If the wrong one wins for
// // your data, adjust the key order below — the resolution strategy itself
// // doesn't need to change.
// function firstDefined<T = unknown>(
//   obj: Record<string, unknown> | null | undefined,
//   ...keys: string[]
// ): T | undefined {
//   if (!obj) return undefined;
//   for (const key of keys) {
//     const value = obj[key];
//     if (value !== undefined && value !== null && value !== "")
//       return value as T;
//   }
//   return undefined;
// }

// function formatApproverDisplay(
//   user: Record<string, unknown> | null | undefined,
// ): string | null {
//   const name = firstDefined<string>(
//     user,
//     "name",
//     "full_name",
//     "fullName",
//     "staff_name",
//     "staffName",
//     "user_name",
//     "userName",
//   );
//   if (!name) return null;
//   const code = firstDefined<string>(
//     user,
//     "person_code",
//     "personCode",
//     "employee_id",
//     "employeeId",
//     "registration_number",
//     "registrationNumber",
//     "employee_number",
//     "employeeNumber",
//     "worker_id",
//     "workerId",
//     "teacher_code",
//     "teacherCode",
//   );
//   return code ? `${name} (${code})` : name;
// }

// const APPROVER_CACHE_TTL_MS = 5 * 60_000;
// const approverDisplayCache = new Map<
//   string,
//   { expiresAt: number; display: string | null }
// >();
// const approverInflight = new Map<string, Promise<string | null>>();

// async function resolveApproverDisplay(userId: string): Promise<string | null> {
//   const cached = approverDisplayCache.get(userId);
//   if (cached && cached.expiresAt > Date.now()) return cached.display;

//   const existing = approverInflight.get(userId);
//   if (existing) return existing;

//   const promise = getStaffRecord(userId)
//     .then((user) =>
//       formatApproverDisplay(user as unknown as Record<string, unknown>),
//     )
//     // A lookup failure (deleted staff record, network hiccup, etc.) must
//     // never surface the raw UUID as a fallback — resolve to "unknown"
//     // instead of throwing, so one bad ID can't break the whole leave list.
//     .catch(() => null)
//     .then((display) => {
//       approverDisplayCache.set(userId, {
//         expiresAt: Date.now() + APPROVER_CACHE_TTL_MS,
//         display,
//       });
//       approverInflight.delete(userId);
//       return display;
//     });

//   approverInflight.set(userId, promise);
//   return promise;
// }

// /** Resolves every unresolved `approvedById` in `rows` to a display string
//  * and returns a new array with `approvedBy`/`approved_by` overwritten
//  * accordingly. Rows that are already resolved (or have no approver) pass
//  * through unchanged — no unnecessary object churn on every refresh. */
// async function withResolvedApprovers(
//   rows: LeaveRequest[],
// ): Promise<LeaveRequest[]> {
//   const idsToResolve = Array.from(
//     new Set(
//       rows
//         .map((row) => row.approvedById)
//         .filter((id): id is string => !!id && isUuid(id)),
//     ),
//   );
//   if (idsToResolve.length === 0) return rows;

//   const displays = await Promise.all(
//     idsToResolve.map((id) => resolveApproverDisplay(id)),
//   );
//   const displayById = new Map(idsToResolve.map((id, i) => [id, displays[i]]));

//   return rows.map((row) => {
//     if (!row.approvedById || !isUuid(row.approvedById)) return row;
//     const display = displayById.get(row.approvedById) ?? null;
//     return { ...row, approvedBy: display, approved_by: display };
//   });
// }

// async function loadLeavesCached(
//   key: string,
//   organizationId: string | number,
//   branchId?: string | number | null,
//   force = false,
// ): Promise<LeaveRequest[]> {
//   const cached = leavesCache.get(key);
//   if (!force && cached && cached.expiresAt > Date.now()) {
//     return cached.rows;
//   }

//   if (!force) {
//     const existing = leavesInflight.get(key);
//     if (existing) return existing;
//   }

//   const promise = getLeaves({ organizationId, branchId })
//     .then((rows) => {
//       leavesCache.set(key, {
//         expiresAt: Date.now() + LEAVE_CACHE_TTL_MS,
//         rows,
//       });
//       return rows;
//     })
//     .finally(() => {
//       leavesInflight.delete(key);
//     });

//   leavesInflight.set(key, promise);
//   return promise;
// }

// function invalidateLeaveCache(organizationId?: string | number | null): void {
//   if (!organizationId) {
//     leavesCache.clear();
//     return;
//   }
//   const prefix = `${organizationId}::`;
//   Array.from(leavesCache.keys()).forEach((key) => {
//     if (key.startsWith(prefix)) leavesCache.delete(key);
//   });
// }

// export function useLeaveActions({
//   branchId,
//   autoRefresh = true,
//   refreshMs = 10_000,
//   enabled = true,
// }: UseLeaveActionsOptions = {}): UseLeaveActionsReturn {
//   const { activeBranchId, organizationId, cfg } = useOrg();

//   const scope = useMemo(() => {
//     if (!organizationId) return null;
//     return resolveTenantScope(
//       {
//         organizationId,
//         branchId: branchId !== undefined ? branchId : activeBranchId,
//       },
//       cfg.branches,
//     );
//   }, [activeBranchId, branchId, cfg.branches, organizationId]);

//   const [rawLeaves, setRawLeaves] = useState<LeaveRequest[]>([]);
//   const [loading, setLoading] = useState(enabled);
//   const [refreshing, setRefreshing] = useState(false);
//   const [loadingId, setLoadingId] = useState<string | null>(null);
//   const [error, setError] = useState<string | null>(null);
//   const mountedRef = useRef(true);
//   const modulePeopleTypes = useMemo(
//     () => getModulePeopleTypesForBranch(cfg, scope?.apiBranchId, "leave"),
//     [cfg, scope?.apiBranchId],
//   );

//   const refresh = useCallback(async () => {
//     if (!enabled) {
//       setLoading(false);
//       setRefreshing(false);
//       return;
//     }

//     if (!scope?.organizationId) {
//       setRawLeaves([]);
//       setLoading(false);
//       return;
//     }

//     const key = leaveCacheKey(scope.organizationId, scope.apiBranchId);

//     try {
//       setRefreshing(true);
//       setError(null);
//       const nextLeaves = await loadLeavesCached(
//         key,
//         scope.organizationId,
//         scope.apiBranchId,
//       );
//       const filteredLeaves = modulePeopleTypes.length
//         ? nextLeaves.filter((leave) => {
//             const leaveRecord = leave as unknown as Record<string, unknown>;
//             const resolvedPeopleType =
//               normalizeLeavePeopleType(
//                 leaveRecord.peopleType ??
//                   leaveRecord.people_type ??
//                   leaveRecord.personType ??
//                   leaveRecord.person_type ??
//                   leaveRecord.userType ??
//                   "",
//               ) || "staff";
//             const allowedPeopleTypes =
//               modulePeopleTypes.map(normalizeLeavePeopleType);
//             return allowedPeopleTypes.includes(resolvedPeopleType);
//           })
//         : nextLeaves;
//       if (!mountedRef.current) return;
//       const resolvedLeaves = await withResolvedApprovers(filteredLeaves);
//       if (!mountedRef.current) return;
//       setRawLeaves(resolvedLeaves);
//     } catch (err) {
//       if (!mountedRef.current) return;
//       setError(
//         err instanceof Error ? err.message : "Failed to load leave requests.",
//       );
//     } finally {
//       if (mountedRef.current) {
//         setLoading(false);
//         setRefreshing(false);
//       }
//     }
//   }, [
//     cfg,
//     enabled,
//     modulePeopleTypes,
//     scope?.apiBranchId,
//     scope?.organizationId,
//   ]);

//   const handleLeaveAction = useCallback(
//     async (
//       leaveId: string,
//       status: "Approved" | "Rejected" | "approved" | "rejected",
//     ) => {
//       try {
//         setLoadingId(leaveId);
//         setError(null);
//         if (!scope?.organizationId) throw new Error("Organization not loaded");
//         await updateLeaveStatus(
//           leaveId,
//           toActionStatus(status),
//           "Admin",
//           scope.organizationId,
//         );
//         invalidateLeaveCache(scope.organizationId);
//         await refresh();
//       } catch (err) {
//         setError(
//           err instanceof Error ? err.message : "Failed to update leave status.",
//         );
//       } finally {
//         setLoadingId(null);
//       }
//     },
//     [refresh, scope?.organizationId],
//   );

//   const createLeave = useCallback(
//     async (payload: Omit<CreateLeavePayload, "organizationId">) => {
//       if (!scope?.organizationId) throw new Error("Organization not loaded");
//       await createLeaveRequest({
//         ...payload,
//         organizationId: scope.organizationId,
//         branchId: payload.branchId ?? scope.apiBranchId ?? undefined,
//       });
//       invalidateLeaveCache(scope.organizationId);
//       await refresh();
//     },
//     [refresh, scope?.apiBranchId, scope?.organizationId],
//   );

//   const deleteLeave = useCallback(
//     async (leaveId: string) => {
//       try {
//         setLoadingId(leaveId);
//         setError(null);
//         if (!scope?.organizationId) throw new Error("Organization not loaded");
//         await deleteLeaveRequest(leaveId, scope.organizationId);
//         invalidateLeaveCache(scope.organizationId);
//         await refresh();
//       } catch (err) {
//         setError(
//           err instanceof Error
//             ? err.message
//             : "Failed to delete leave request.",
//         );
//       } finally {
//         setLoadingId(null);
//       }
//     },
//     [refresh, scope?.organizationId],
//   );

//   useEffect(() => {
//     mountedRef.current = true;
//     void refresh();
//     return () => {
//       mountedRef.current = false;
//     };
//   }, [refresh]);

//   useEffect(() => {
//     if (!enabled || !autoRefresh) return undefined;
//     const id = window.setInterval(
//       () => void refresh(),
//       Math.max(10_000, refreshMs),
//     );
//     return () => window.clearInterval(id);
//   }, [autoRefresh, enabled, refresh, refreshMs]);

//   const leaves = useMemo(
//     () => rawLeaves.map(mapToPendingLeaveItem),
//     [rawLeaves],
//   );
//   const pendingLeaves = useMemo(
//     () => leaves.filter((item) => item.status === "Pending"),
//     [leaves],
//   );

//   return {
//     leaves,
//     pendingLeaves,
//     loading,
//     refreshing,
//     loadingId,
//     error,
//     refresh,
//     handleLeaveAction,
//     createLeave,
//     deleteLeave,
//   };
// }

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { resolveTenantScope } from "../../../utils/tenantScope";
import { getModulePeopleTypesForBranch } from "../../../utils/templateRendering";
import {
  getStaffRecord,
  getClientUserBasic,
} from "../../StaffManagement/api/staffApi";
import {
  getLeaves,
  updateLeaveStatus,
  createLeaveRequest,
  deleteLeaveRequest,
  isUuid,
  type LeaveRequest,
  type CreateLeavePayload,
} from "../api/leaveApi";
import type { PendingLeaveItem } from "../types/leave";
import { normalizeLeavePeopleType } from "../utils/leave.utils";

interface UseLeaveActionsOptions {
  branchId?: number | string | null;
  autoRefresh?: boolean;
  refreshMs?: number;
  /**
   * Performance switch for dashboard snapshot cards. When false the hook keeps
   * its action API but does not fetch, so parent components can pass snapshot
   * data without causing another /api/leaves request.
   */
  enabled?: boolean;
}

export interface UseLeaveActionsReturn {
  leaves: PendingLeaveItem[];
  pendingLeaves: PendingLeaveItem[];
  loading: boolean;
  refreshing: boolean;
  loadingId: string | null;
  error: string | null;

  refresh: () => Promise<void>;
  handleLeaveAction: (
    leaveId: string,
    status: "Approved" | "Rejected" | "approved" | "rejected",
  ) => Promise<void>;
  createLeave: (
    payload: Omit<CreateLeavePayload, "organizationId">,
  ) => Promise<void>;
  deleteLeave: (leaveId: string) => Promise<void>;
}

type CacheEntry = {
  expiresAt: number;
  rows: LeaveRequest[];
};

const LEAVE_CACHE_TTL_MS = 8_000;
const leavesCache = new Map<string, CacheEntry>();
const leavesInflight = new Map<string, Promise<LeaveRequest[]>>();

function toTitleStatus(
  status: LeaveRequest["status"],
): "Pending" | "Approved" | "Rejected" {
  const raw = String(status || "pending").toLowerCase();
  if (raw === "approved") return "Approved";
  if (raw === "rejected") return "Rejected";
  return "Pending";
}

function toActionStatus(
  status: "Approved" | "Rejected" | "approved" | "rejected",
): "approved" | "rejected" {
  return String(status).toLowerCase() === "rejected" ? "rejected" : "approved";
}

function optionalText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function optionalId(
  value: string | number | null | undefined,
): string | number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  return value;
}

function mapToPendingLeaveItem(item: LeaveRequest): PendingLeaveItem {
  const createdAt = optionalText(item.createdAt);
  const updatedAt = optionalText(item.updatedAt);

  return {
    id: item.id,
    userId: optionalId(item.userId),
    staffId: item.userId ? String(item.userId) : undefined,
    name: item.name,
    staffName: item.name,
    peopleType: String(item.peopleType ?? item.people_type ?? "staff")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
    branchId: item.branchId ?? undefined,
    branchName: item.branchName || "Main Branch",
    dept: item.dept || "General",
    department: item.dept || item.department || "General",
    type: item.type,
    leaveCompensation:
      item.leaveCompensation ?? item.leave_compensation ?? "not_configured",
    leavePayrollDecision:
      item.leavePayrollDecision ?? item.leave_payroll_decision ?? null,
    halfDayPeriod: item.halfDayPeriod ?? null,
    halfDayStartTime: item.halfDayStartTime ?? null,
    halfDayEndTime: item.halfDayEndTime ?? null,
    days: item.days,
    status: toTitleStatus(item.status),
    startDate: item.startDate,
    endDate: item.endDate,
    reason: item.reason,
    approvedBy: optionalText(item.approvedBy),
    appliedOn: createdAt?.slice(0, 10),
    createdAt,
    updatedAt,
  };
}

function leaveCacheKey(
  organizationId: string | number,
  branchId?: string | number | null,
): string {
  return `${organizationId}::${branchId ?? "all"}`;
}

// ── Approver name resolution ────────────────────────────────────────────────
// leaveApi.ts leaves `approvedById` as a raw manager user ID whenever the
// backend hasn't resolved it to a label. We join that against the staff
// directory here (not in leaveApi.ts, which is a pure wire-format adapter)
// and cache the result — a manager's name/code changes rarely, so this is
// cached far longer than the leave list itself and is never re-fetched on
// every 10s auto-refresh once warm.
//
// ASSUMPTION: the exact field names for a person's display name and person
// code on the `User` record aren't visible from these files alone, so this
// tries every alias already in use elsewhere in this codebase (see
// staffApi.ts's StaffPayload) in priority order. If the wrong one wins for
// your data, adjust the key order below — the resolution strategy itself
// doesn't need to change.
function firstDefined<T = unknown>(
  obj: Record<string, unknown> | null | undefined,
  ...keys: string[]
): T | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && value !== "")
      return value as T;
  }
  return undefined;
}

function formatApproverDisplay(
  user: Record<string, unknown> | null | undefined,
): string | null {
  const name = firstDefined<string>(
    user,
    "name",
    "full_name",
    "fullName",
    "staff_name",
    "staffName",
    "user_name",
    "userName",
  );
  if (!name) return null;
  const code = firstDefined<string>(
    user,
    "person_code",
    "personCode",
    "employee_id",
    "employeeId",
    "registration_number",
    "registrationNumber",
    "employee_number",
    "employeeNumber",
    "worker_id",
    "workerId",
    "teacher_code",
    "teacherCode",
  );
  return code ? `${name} (${code})` : name;
}

const APPROVER_CACHE_TTL_MS = 5 * 60_000;
const approverDisplayCache = new Map<
  string,
  { expiresAt: number; display: string | null }
>();
const approverInflight = new Map<string, Promise<string | null>>();

async function resolveApproverDisplay(userId: string): Promise<string | null> {
  const cached = approverDisplayCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.display;

  const existing = approverInflight.get(userId);
  if (existing) return existing;

  const promise = getStaffRecord(userId)
    .catch(() =>
      // approvedById is not always a client_staff row — an org admin can
      // approve leave without having an employee record. A 404 here just
      // means "try the client_users table next," not a real failure.
      getClientUserBasic(userId),
    )
    .then((user) =>
      formatApproverDisplay(user as unknown as Record<string, unknown>),
    )
    // A lookup failure in *both* tables (deleted account, network hiccup,
    // etc.) must never surface the raw UUID as a fallback — resolve to
    // "unknown" instead of throwing, so one bad ID can't break the whole
    // leave list.
    .catch(() => null)
    .then((display) => {
      approverDisplayCache.set(userId, {
        expiresAt: Date.now() + APPROVER_CACHE_TTL_MS,
        display,
      });
      approverInflight.delete(userId);
      return display;
    });

  approverInflight.set(userId, promise);
  return promise;
}

/** Resolves every unresolved `approvedById` in `rows` to a display string
 * and returns a new array with `approvedBy`/`approved_by` overwritten
 * accordingly. Rows that are already resolved (or have no approver) pass
 * through unchanged — no unnecessary object churn on every refresh. */
async function withResolvedApprovers(
  rows: LeaveRequest[],
): Promise<LeaveRequest[]> {
  const idsToResolve = Array.from(
    new Set(
      rows
        .map((row) => row.approvedById)
        .filter((id): id is string => !!id && isUuid(id)),
    ),
  );
  if (idsToResolve.length === 0) return rows;

  const displays = await Promise.all(
    idsToResolve.map((id) => resolveApproverDisplay(id)),
  );
  const displayById = new Map(idsToResolve.map((id, i) => [id, displays[i]]));

  return rows.map((row) => {
    if (!row.approvedById || !isUuid(row.approvedById)) return row;
    const display = displayById.get(row.approvedById) ?? null;
    return { ...row, approvedBy: display, approved_by: display };
  });
}

async function loadLeavesCached(
  key: string,
  organizationId: string | number,
  branchId?: string | number | null,
  force = false,
): Promise<LeaveRequest[]> {
  const cached = leavesCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.rows;
  }

  if (!force) {
    const existing = leavesInflight.get(key);
    if (existing) return existing;
  }

  const promise = getLeaves({ organizationId, branchId })
    .then((rows) => {
      leavesCache.set(key, {
        expiresAt: Date.now() + LEAVE_CACHE_TTL_MS,
        rows,
      });
      return rows;
    })
    .finally(() => {
      leavesInflight.delete(key);
    });

  leavesInflight.set(key, promise);
  return promise;
}

function invalidateLeaveCache(organizationId?: string | number | null): void {
  if (!organizationId) {
    leavesCache.clear();
    return;
  }
  const prefix = `${organizationId}::`;
  Array.from(leavesCache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) leavesCache.delete(key);
  });
}

export function useLeaveActions({
  branchId,
  autoRefresh = true,
  refreshMs = 10_000,
  enabled = true,
}: UseLeaveActionsOptions = {}): UseLeaveActionsReturn {
  const { activeBranchId, organizationId, cfg } = useOrg();

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

  const [rawLeaves, setRawLeaves] = useState<LeaveRequest[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const modulePeopleTypes = useMemo(
    () => getModulePeopleTypesForBranch(cfg, scope?.apiBranchId, "leave"),
    [cfg, scope?.apiBranchId],
  );

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (!scope?.organizationId) {
      setRawLeaves([]);
      setLoading(false);
      return;
    }

    const key = leaveCacheKey(scope.organizationId, scope.apiBranchId);

    try {
      setRefreshing(true);
      setError(null);
      const nextLeaves = await loadLeavesCached(
        key,
        scope.organizationId,
        scope.apiBranchId,
      );
      const filteredLeaves = modulePeopleTypes.length
        ? nextLeaves.filter((leave) => {
            const leaveRecord = leave as unknown as Record<string, unknown>;
            const resolvedPeopleType =
              normalizeLeavePeopleType(
                leaveRecord.peopleType ??
                  leaveRecord.people_type ??
                  leaveRecord.personType ??
                  leaveRecord.person_type ??
                  leaveRecord.userType ??
                  "",
              ) || "staff";
            const allowedPeopleTypes = modulePeopleTypes.map(
              normalizeLeavePeopleType,
            );
            return allowedPeopleTypes.includes(resolvedPeopleType);
          })
        : nextLeaves;
      if (!mountedRef.current) return;
      const resolvedLeaves = await withResolvedApprovers(filteredLeaves);
      if (!mountedRef.current) return;
      setRawLeaves(resolvedLeaves);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err instanceof Error ? err.message : "Failed to load leave requests.",
      );
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [
    cfg,
    enabled,
    modulePeopleTypes,
    scope?.apiBranchId,
    scope?.organizationId,
  ]);

  const handleLeaveAction = useCallback(
    async (
      leaveId: string,
      status: "Approved" | "Rejected" | "approved" | "rejected",
    ) => {
      try {
        setLoadingId(leaveId);
        setError(null);
        if (!scope?.organizationId) throw new Error("Organization not loaded");
        await updateLeaveStatus(
          leaveId,
          toActionStatus(status),
          "Admin",
          scope.organizationId,
        );
        invalidateLeaveCache(scope.organizationId);
        await refresh();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to update leave status.",
        );
      } finally {
        setLoadingId(null);
      }
    },
    [refresh, scope?.organizationId],
  );

  const createLeave = useCallback(
    async (payload: Omit<CreateLeavePayload, "organizationId">) => {
      if (!scope?.organizationId) throw new Error("Organization not loaded");
      await createLeaveRequest({
        ...payload,
        organizationId: scope.organizationId,
        branchId: payload.branchId ?? scope.apiBranchId ?? undefined,
      });
      invalidateLeaveCache(scope.organizationId);
      await refresh();
    },
    [refresh, scope?.apiBranchId, scope?.organizationId],
  );

  const deleteLeave = useCallback(
    async (leaveId: string) => {
      try {
        setLoadingId(leaveId);
        setError(null);
        if (!scope?.organizationId) throw new Error("Organization not loaded");
        await deleteLeaveRequest(leaveId, scope.organizationId);
        invalidateLeaveCache(scope.organizationId);
        await refresh();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to delete leave request.",
        );
      } finally {
        setLoadingId(null);
      }
    },
    [refresh, scope?.organizationId],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !autoRefresh) return undefined;
    const id = window.setInterval(
      () => void refresh(),
      Math.max(10_000, refreshMs),
    );
    return () => window.clearInterval(id);
  }, [autoRefresh, enabled, refresh, refreshMs]);

  const leaves = useMemo(
    () => rawLeaves.map(mapToPendingLeaveItem),
    [rawLeaves],
  );
  const pendingLeaves = useMemo(
    () => leaves.filter((item) => item.status === "Pending"),
    [leaves],
  );

  return {
    leaves,
    pendingLeaves,
    loading,
    refreshing,
    loadingId,
    error,
    refresh,
    handleLeaveAction,
    createLeave,
    deleteLeave,
  };
}
