/**
 * modules/staff/hooks/useStaffRecords.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Staff-specific data hook.
 *
 * Responsibilities:
 *   - Resolve org/user scope safely.
 *   - Load active staff from backend.
 *   - Load archived staff from backend.
 *   - Create/update/archive/restore staff through staff-specific API.
 *   - Keep ModuleContext staff store synced.
 *
 * Production notes:
 *   - The refresh effect depends only on stable primitive scope values.
 *   - The ModuleContext staff store is accessed through a ref so staff.reset()
 *     does not recreate callback dependencies and trigger an endless reload loop.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "../../../contexts/useAuth";
import {
  useBackendStore,
  type StaffMember,
} from "../../../contexts/ModuleContext";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { resolveTenantScope } from "../../../utils/tenantScope";

import {
  archiveStaffRecord,
  createStaffRecord,
  deleteArchivedStaffRecord,
  bulkDeleteArchivedStaffRecords,
  getArchivedStaffRecords,
  restoreStaffRecord,
  listStaffPage,
  listStaffRecords,
  staffProfilePhotoUrl,
  updateStaffRecord,
  uploadStaffPhoto,
  type StaffArchiveOptions,
  type StaffMediaUploadError,
  type StaffPayload,
} from "../api/staffApi";
import { apiUserToStaffMember } from "../api/staffMappers";
import { staffSalary } from "../utils/staffMember";
import {
  assignStaffDepartment as assignStaffDepartmentApi,
  assignStaffShift as assignStaffShiftApi,
  assignStaffShifts as assignStaffShiftsApi,
} from "../api/attendanceSettingsApi";

export interface StaffMediaFiles {
  profileImageFile?: File | null;
}

export type StaffSaveProgressPhase =
  | "profile"
  | "photo"
  | "complete"
  | "failed";

export interface StaffSaveProgressEvent {
  phase: StaffSaveProgressPhase;
  message: string;
  progress: number;
}

export interface StaffSaveOptions {
  onProgress?: (event: StaffSaveProgressEvent) => void;
}

export interface UseStaffRecordsOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  branchId?: number | string | null;
  /**
   * Business/template people scope. This is intentionally separate from
   * account role so student/worker/teacher never gets inserted into
   * client_staff.role.
   */
  peopleType?: string | null;
  people_type?: string | null;
  personType?: string | null;
  person_type?: string | null;
  role?: string | null;
  status?: StaffMember["status"] | "all" | string | null;
  department?: string | null;
  designation?: string | null;
  loadArchived?: boolean;
}

/**
 * Whole-directory headcounts (every page, not just the rows on screen).
 * Scoped to organization + branch + people type only, so search / status /
 * department filters and the current page never change them.
 */
export interface StaffCounts {
  total: number;
  active: number;
  inactiveOrPending: number;
  averageSalary: number;
  loaded: boolean;
}

const EMPTY_STAFF_COUNTS: StaffCounts = {
  total: 0,
  active: 0,
  inactiveOrPending: 0,
  averageSalary: 0,
  loaded: false,
};

const STAFF_SAVE_PHASE_PROGRESS: Record<StaffSaveProgressPhase, number> = {
  profile: 20,
  photo: 70,
  complete: 100,
  failed: 100,
};

function emitStaffSaveProgress(
  options: StaffSaveOptions | undefined,
  phase: StaffSaveProgressPhase,
  message: string,
): void {
  options?.onProgress?.({
    phase,
    message,
    progress: STAFF_SAVE_PHASE_PROGRESS[phase],
  });
}

type AuthUserLike = {
  id?: unknown;
  organization_id?: unknown;
  organizationId?: unknown;
};

type StaffMemberWithBenefits = StaffMember & {
  benefits?: string[];
};

type TenantId = number | string;

function toPositiveNumber(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function toTenantId(value: unknown): TenantId | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const numeric = Number(trimmed);
    if (
      Number.isFinite(numeric) &&
      numeric > 0 &&
      String(numeric) === trimmed
    ) {
      return numeric;
    }

    return trimmed;
  }

  return null;
}

function readStoredCurrentUser(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem("currentUser");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function resolveOrganizationId(
  authUser?: AuthUserLike | null,
): TenantId | null {
  const fromAuth =
    toTenantId(authUser?.organization_id) ??
    toTenantId(authUser?.organizationId);

  if (fromAuth) return fromAuth;

  const stored = readStoredCurrentUser();

  return (
    toTenantId(stored?.organization_id) ?? toTenantId(stored?.organizationId)
  );
}

function resolveUserId(authUser?: AuthUserLike | null): TenantId | null {
  const fromAuth = toTenantId(authUser?.id);
  if (fromAuth) return fromAuth;

  const stored = readStoredCurrentUser();
  return toTenantId(stored?.id);
}

function parseBenefits(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      return value
        .split(/[,;\n]+/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return [];
}

function benefitsFromSource(source: unknown): unknown {
  if (!source || typeof source !== "object") return undefined;

  const record = source as Record<string, unknown>;
  return record.benefits ?? record.staffBenefits ?? record.staff_benefits;
}

function withBackendBenefits(
  row: StaffMember,
  source?: unknown,
): StaffMemberWithBenefits {
  return {
    ...row,
    benefits: parseBenefits(benefitsFromSource(source)),
  };
}

function isBrowserPreviewUrl(value: unknown): boolean {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return raw.startsWith("blob:") || raw.startsWith("data:");
}

function withoutBrowserPreviewMedia(payload: StaffPayload): StaffPayload {
  const next: StaffPayload = { ...payload };

  if (isBrowserPreviewUrl(next.profile_image_url)) {
    delete next.profile_image_url;
  }

  if (isBrowserPreviewUrl((next as any).profileImageUrl)) {
    delete (next as any).profileImageUrl;
  }

  return next;
}

function photoUrlFromUploadResult(
  result: Awaited<ReturnType<typeof uploadStaffPhoto>>,
  staffId: number | string,
): string {
  return (
    result.profile_image_url ||
    result.profileImageUrl ||
    result.photo_url ||
    staffProfilePhotoUrl(staffId)
  );
}

function photoNameFromUploadResult(
  result: Awaited<ReturnType<typeof uploadStaffPhoto>>,
): string {
  return result.profile_image_name || result.profileImageName || "";
}

export function useStaffRecords(options: UseStaffRecordsOptions = {}) {
  const { user } = useAuth() as { user: AuthUserLike | null };
  const staff = useBackendStore<StaffMember>();
  const {
    cfg,
    activeBranchId,
    isOrgReady,
    organizationId: contextOrganizationId,
  } = useOrg();

  /**
   * Important:
   * `staff` (from useBackendStore) is a new object after staff.reset().
   * If refreshStaff depends directly on staff, the load effect can become:
   *
   * effect → refreshStaff → staff.reset → staff object changes → callback changes
   * → effect runs again → repeat forever.
   *
   * Keep the latest store in a ref and keep callbacks dependent only on scope.
   */
  const staffStoreRef = useRef(staff);
  const staffMutationVersionRef = useRef(0);
  // Monotonic id of the newest page request. Slow, older responses are
  // ignored so they can never overwrite the rows / page the user is on.
  const staffRequestIdRef = useRef(0);

  useEffect(() => {
    staffStoreRef.current = staff;
  }, [staff]);

  const [archivedStaff, setArchivedStaff] = useState<StaffMember[]>([]);
  const [isLoadingStaff, setIsLoadingStaff] = useState(false);
  const [isLoadingArchivedStaff, setIsLoadingArchivedStaff] = useState(false);
  const [hasLoadedArchivedStaff, setHasLoadedArchivedStaff] = useState(false);
  const [isSavingStaff, setIsSavingStaff] = useState(false);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [staffTotal, setStaffTotal] = useState(0);
  const [staffCounts, setStaffCounts] =
    useState<StaffCounts>(EMPTY_STAFF_COUNTS);
  const [staffDirectoryRecords, setStaffDirectoryRecords] = useState<
    StaffMember[]
  >([]);
  const [countsVersion, setCountsVersion] = useState(0);
  const [staffPage, setStaffPage] = useState(() =>
    Math.max(1, Number(options.page || 1)),
  );
  const [staffPageSize, setStaffPageSize] = useState(() =>
    Math.max(1, Math.min(250, Number(options.pageSize || 50))),
  );

  const organizationId = useMemo(
    () => toTenantId(contextOrganizationId) ?? resolveOrganizationId(user),
    [contextOrganizationId, user],
  );
  const currentUserId = useMemo(() => resolveUserId(user), [user]);

  useEffect(() => {
    if (options.page && options.page !== staffPage) {
      setStaffPage(Math.max(1, Number(options.page)));
    }
  }, [options.page, staffPage]);

  useEffect(() => {
    if (options.pageSize && options.pageSize !== staffPageSize) {
      setStaffPageSize(Math.max(1, Math.min(250, Number(options.pageSize))));
      setStaffPage(1);
    }
  }, [options.pageSize, staffPageSize]);

  const scopedActiveBranchId = useMemo(() => {
    if (!organizationId || activeBranchId == null) return activeBranchId;
    return (
      resolveTenantScope(
        { organizationId, branchId: activeBranchId },
        cfg.branches,
      ).apiBranchId ?? activeBranchId
    );
  }, [activeBranchId, cfg.branches, organizationId]);

  const requestedBranchId = useMemo(() => {
    const explicitBranchId = options.branchId;

    if (explicitBranchId !== undefined) {
      if (!organizationId || explicitBranchId == null) {
        return explicitBranchId ?? null;
      }

      return (
        resolveTenantScope(
          { organizationId, branchId: explicitBranchId },
          cfg.branches,
        ).apiBranchId ?? explicitBranchId
      );
    }

    return scopedActiveBranchId ?? null;
  }, [cfg.branches, options.branchId, organizationId, scopedActiveBranchId]);

  const replaceStaffRecord = useCallback((next: StaffMember) => {
    const store = staffStoreRef.current;

    store.reset([
      ...store.allItems.filter((item) => item.id !== next.id),
      next,
    ]);
    setCountsVersion((version) => version + 1);
  }, []);

  const refreshStaff = useCallback(
    async (refreshOptions?: { branchId?: number | null }) => {
      const store = staffStoreRef.current;
      const refreshVersion = staffMutationVersionRef.current;

      if (!organizationId) {
        store.reset([]);
        return [];
      }

      const requestId = ++staffRequestIdRef.current;

      try {
        setIsLoadingStaff(true);
        setStaffError(null);

        const requestedPage = Math.max(
          1,
          Number(options.page || staffPage || 1),
        );
        const requestedPageSize = Math.max(
          1,
          Math.min(250, Number(options.pageSize || staffPageSize || 50)),
        );

        const pageResult = await listStaffPage({
          role: options.role ?? "staff",
          peopleType:
            options.peopleType ??
            options.people_type ??
            options.personType ??
            options.person_type ??
            null,
          organizationId,
          userId: currentUserId,
          branchId:
            refreshOptions?.branchId !== undefined
              ? (resolveTenantScope(
                { organizationId, branchId: refreshOptions.branchId },
                cfg.branches,
              ).apiBranchId ?? refreshOptions.branchId)
              : (requestedBranchId ?? undefined),
          page: requestedPage,
          pageSize: requestedPageSize,
          search: options.search,
          sortBy: options.sortBy,
          sortDir: options.sortDir,
          status: options.status,
          department: options.department,
          designation: options.designation,
        });

        // A newer request (filter change, next page click...) has started
        // since this one was sent: drop this response completely.
        if (requestId !== staffRequestIdRef.current) {
          return staffStoreRef.current.allItems;
        }

        const total = Number(pageResult.total || 0);
        setStaffTotal(total);

        // The page the user is on no longer exists (last row archived, a
        // filter shrank the result...). Step back to the last real page; the
        // page change triggers a fresh load.
        const lastPage = Math.max(1, Math.ceil(total / requestedPageSize));
        if (requestedPage > lastPage) {
          setStaffPage(lastPage);
          return staffStoreRef.current.allItems;
        }

        // NOTE: page / pageSize are owned by the UI. They are no longer
        // overwritten from the response - a backend that echoes page 1 (or a
        // late response) used to snap the pager back and break Prev / Next.

        const rows = pageResult.rows.map((user) =>
          withBackendBenefits(apiUserToStaffMember(user), user),
        );
        if (refreshVersion !== staffMutationVersionRef.current) {
          return staffStoreRef.current.allItems;
        }
        staffStoreRef.current.reset(rows);

        return rows;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load staff.";
        if (requestId === staffRequestIdRef.current) setStaffError(message);
        throw error;
      } finally {
        if (requestId === staffRequestIdRef.current) setIsLoadingStaff(false);
      }
    },
    [
      cfg.branches,
      currentUserId,
      organizationId,
      options.branchId,
      options.department,
      options.designation,
      options.page,
      options.pageSize,
      options.peopleType,
      options.people_type,
      options.personType,
      options.person_type,
      options.role,
      options.search,
      options.sortBy,
      options.sortDir,
      options.status,
      requestedBranchId,
      staffPage,
      staffPageSize,
    ],
  );

  const refreshArchivedStaff = useCallback(async () => {
    if (!organizationId) {
      setArchivedStaff([]);
      setIsLoadingArchivedStaff(false);
      setHasLoadedArchivedStaff(false);
      return [];
    }

    setIsLoadingArchivedStaff(true);
    try {
      setStaffError(null);

      const rows = await getArchivedStaffRecords({
        organizationId,
        branchId: requestedBranchId ?? undefined,
        peopleType:
          options.peopleType ??
          options.people_type ??
          options.personType ??
          options.person_type ??
          undefined,
      });

      const mappedRows = rows.map((user) =>
        withBackendBenefits(apiUserToStaffMember(user), user),
      );
      setArchivedStaff(mappedRows);
      setHasLoadedArchivedStaff(true);

      return mappedRows;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load archived employees.";
      setStaffError(message);
      throw error;
    } finally {
      setIsLoadingArchivedStaff(false);
    }
  }, [
    organizationId,
    requestedBranchId,
    options.peopleType,
    options.people_type,
    options.personType,
    options.person_type,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function loadStaffScope() {
      if (!organizationId && !currentUserId) {
        staffStoreRef.current.reset([]);
        setArchivedStaff([]);
        return;
      }

      try {
        await refreshStaff();
        if (cancelled) return;

        if (options.loadArchived !== false) {
          await refreshArchivedStaff();
        }
      } catch {
        // refreshStaff / refreshArchivedStaff already set staffError.
        // Do not rethrow from effects.
      }
    }

    void loadStaffScope();

    return () => {
      cancelled = true;
    };
  }, [
    currentUserId,
    isOrgReady,
    organizationId,
    refreshStaff,
  ]);

  useEffect(() => {
    if (options.loadArchived === false) return;

    refreshArchivedStaff().catch(() => {
      // refreshArchivedStaff already records the error in staffError.
    });
  }, [options.loadArchived, refreshArchivedStaff]);

  // ── Directory-wide headcounts for the stat cards ──────────────────────────
  // Directory stats use the full organization/branch roster, not the current
  // page or table filters. The page API supplies exact totals; salary rows are
  // paged through the same API to calculate the directory-wide average.
  const countsPeopleType =
    options.peopleType ??
    options.people_type ??
    options.personType ??
    options.person_type ??
    null;

  useEffect(() => {
    if (!organizationId) {
      setStaffCounts(EMPTY_STAFF_COUNTS);
      setStaffDirectoryRecords([]);
      return;
    }

    let cancelled = false;

    const base = {
      role: options.role ?? "staff",
      peopleType: countsPeopleType,
      organizationId,
      userId: currentUserId,
      branchId: requestedBranchId ?? undefined,
      page: 1,
      pageSize: 250,
    };

    async function loadCounts() {
      try {
        const all = await listStaffPage(base);
        const pageCount = Math.ceil(all.total / base.pageSize);
        const remainingPages = await Promise.all(
          Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) =>
            listStaffPage({ ...base, page: index + 2 }),
          ),
        );
        if (cancelled) return;

        const total = Number(all.total || 0);
        const directoryRecords = [all, ...remainingPages]
          .flatMap((page) => page.rows)
          .map((row) => withBackendBenefits(apiUserToStaffMember(row), row));
        const { active: activeCount, salaryTotal } = directoryRecords.reduce(
            (counts, member) => ({
              active:
                counts.active + (member.status === "active" ? 1 : 0),
              salaryTotal: counts.salaryTotal + staffSalary(member),
            }),
            { active: 0, salaryTotal: 0 },
          );
        setStaffDirectoryRecords(directoryRecords);
        setStaffCounts({
          total,
          active: activeCount,
          inactiveOrPending: Math.max(0, total - activeCount),
          averageSalary: total ? salaryTotal / total : 0,
          loaded: true,
        });
      } catch {
        // Keep the last known counts; the stat bar falls back to page rows
        // if nothing has ever loaded.
      }
    }

    void loadCounts();

    return () => {
      cancelled = true;
    };
  }, [
    organizationId,
    currentUserId,
    requestedBranchId,
    countsPeopleType,
    options.role,
    countsVersion,
  ]);

  const createStaff = useCallback(
    async (
      payload: StaffPayload,
      files?: StaffMediaFiles,
      options?: StaffSaveOptions,
    ) => {
      if (!organizationId) {
        throw new Error(
          "Organization is not loaded yet. Refresh after login and try again.",
        );
      }

      try {
        setIsSavingStaff(true);
        setStaffError(null);
        staffMutationVersionRef.current += 1;

        emitStaffSaveProgress(options, "profile", "Creating profile...");

        const safePayload = withoutBrowserPreviewMedia(payload);
        const created = await createStaffRecord({
          ...safePayload,
          role: "staff",
          organization_id: organizationId,
          created_by_user_id: currentUserId,
        });

        const createdUserId = String(created.user.id);
        const mediaErrors: StaffMediaUploadError[] = [];
        let finalPhotoUrl =
          created.user.profile_image_url ?? safePayload.profile_image_url ?? "";
        let finalProfileImageName = safePayload.profile_image_name ?? "";

        if (files?.profileImageFile) {
          try {
            emitStaffSaveProgress(
              options,
              "photo",
              "Uploading profile photo...",
            );
            const photoResult = await uploadStaffPhoto(
              createdUserId,
              files.profileImageFile,
            );
            finalPhotoUrl = photoUrlFromUploadResult(
              photoResult,
              createdUserId,
            );
            finalProfileImageName =
              photoNameFromUploadResult(photoResult) || finalProfileImageName;
          } catch (error) {
            mediaErrors.push({
              phase: "photo",
              message:
                error instanceof Error
                  ? error.message
                  : "Profile photo upload failed.",
            });
          }
        }

        let syncedUser = created.user;

        if (finalPhotoUrl || finalProfileImageName) {
          try {
            const synced = await updateStaffRecord(createdUserId, {
              ...safePayload,
              organization_id: organizationId,
              created_by_user_id: currentUserId,
              profile_image_url: finalPhotoUrl,
              profile_image_name: finalProfileImageName,
            });
            syncedUser = synced.user ?? created.user;
          } catch (error) {
            mediaErrors.push({
              phase: "media-sync",
              message:
                error instanceof Error
                  ? error.message
                  : "Profile image metadata sync failed.",
            });
          }
        }

        const mappedRow = apiUserToStaffMember(syncedUser);
        const mappedDesignationId =
          mappedRow.designationId ?? safePayload.designation_id ?? null;
        const mappedDesignationName =
          mappedRow.designationName || safePayload.designation_name || "";
        const payloadBranchId = Number(safePayload.branch_ui_id);
        const row = withBackendBenefits(
          {
            ...mappedRow,
            designationId: mappedDesignationId,
            designationName: mappedDesignationName,
            ...(mappedRow.branchId || !Number.isFinite(payloadBranchId)
              ? {}
              : { branchId: payloadBranchId }),
          },
          syncedUser,
        );
        replaceStaffRecord(row);

        emitStaffSaveProgress(
          options,
          "complete",
          "Profile saved successfully.",
        );

        return {
          ...created,
          user: syncedUser,
          staff: row,
          mediaErrors,
        };
      } finally {
        setIsSavingStaff(false);
      }
    },
    [currentUserId, organizationId, replaceStaffRecord],
  );

  const updateStaff = useCallback(
    async (userId: number | string, payload: StaffPayload) => {
      if (!organizationId) {
        throw new Error(
          "Organization is not loaded yet. Refresh after login and try again.",
        );
      }

      try {
        setIsSavingStaff(true);
        setStaffError(null);

        const safePayload = withoutBrowserPreviewMedia(payload);

        const result = await updateStaffRecord(userId, {
          ...safePayload,
          organization_id: organizationId,
          created_by_user_id: currentUserId,
        });

        const mappedRow = apiUserToStaffMember(result.user);
        const row = withBackendBenefits(
          {
            ...mappedRow,
            designationId:
              mappedRow.designationId ?? safePayload.designation_id ?? null,
            designationName:
              mappedRow.designationName || safePayload.designation_name || "",
          },
          result.user,
        );
        replaceStaffRecord(row);

        return row;
      } finally {
        setIsSavingStaff(false);
      }
    },
    [currentUserId, organizationId, replaceStaffRecord],
  );

  /**
   * Assigns a staff member to a real `shifts` row via
   * PATCH /api/client/staff/<id>/shift. The backend now returns the
   * fully-resolved staff row (shiftLabel/shiftStart/shiftEnd already
   * folded in from the `shifts` row via shift_id_ref — see
   * support_db_shifts.assign_staff_shift), so the local record is rebuilt
   * from that response the same way updateStaff/createStaff do, instead of
   * hand-patching only shiftIdRef/shift_id_ref. That partial patch used to
   * leave shiftLabel/shiftStart/shiftEnd — the fields the Shift Allocation
   * tab's "Current Shift Summary" and shiftText() actually read — pointing
   * at the previous shift until a full staff-list reload, most visibly
   * when applying a newly-created overnight shift (e.g. 23:00–01:00) whose
   * name/timing had no other reason to already be on the local record.
   */
  const assignShift = useCallback(
    async (userId: number | string, shiftId: string | null) => {
      if (!organizationId) {
        throw new Error(
          "Organization is not loaded yet. Refresh after login and try again.",
        );
      }

      const updatedUser = await assignStaffShiftApi(
        userId,
        shiftId,
        organizationId,
      );

      const store = staffStoreRef.current;
      const existing = store.allItems.find(
        (item) => String(item.userId ?? item.id) === String(userId),
      );

      if (existing) {
        const mapped = apiUserToStaffMember(updatedUser);
        const resolved = withBackendBenefits(
          mapped.branchId ? mapped : { ...mapped, branchId: existing.branchId },
          updatedUser,
        );
        // Shift allocation can update many people concurrently. Use the
        // store's functional update so one response cannot overwrite rows
        // updated by another response.
        store.update(existing.id, resolved);
      }

      window.dispatchEvent(new Event("orgDataChanged"));

      return shiftId;
    },
    [organizationId, replaceStaffRecord],
  );

  const assignShifts = useCallback(
    async (userIds: Array<number | string>, branchId: string, shiftId: string) => {
      if (!organizationId) {
        throw new Error(
          "Organization is not loaded yet. Refresh after login and try again.",
        );
      }
      const assignedCount = await assignStaffShiftsApi(
        userIds,
        branchId,
        shiftId,
      );
      window.dispatchEvent(new Event("orgDataChanged"));
      return assignedCount;
    },
    [organizationId],
  );

  const refreshStaffDirectoryRecords = useCallback(() => {
    setCountsVersion((version) => version + 1);
  }, []);

  /**
   * Assigns a staff member to a real `departments` row via
   * PATCH /api/client/staff/<id>/department. Additive: only writes the
   * new `departmentId`/`department_id` fields. The legacy free-text
   * `department` string (still shown/edited on the main form) is left
   * untouched.
   */
  const assignDepartment = useCallback(
    async (userId: number | string, departmentId: string | null) => {
      if (!organizationId) {
        throw new Error(
          "Organization is not loaded yet. Refresh after login and try again.",
        );
      }

      await assignStaffDepartmentApi(userId, departmentId, organizationId);

      const store = staffStoreRef.current;
      const existing = store.allItems.find(
        (item) => String(item.userId ?? item.id) === String(userId),
      );

      if (existing) {
        replaceStaffRecord({
          ...existing,
          departmentId,
          department_id: departmentId,
        } as StaffMember);
      }

      return departmentId;
    },
    [organizationId, replaceStaffRecord],
  );

  const archiveStaff = useCallback(
    async (
      userId: number | string,
      staffId: string,
      options: StaffArchiveOptions,
    ) => {
      const result = await archiveStaffRecord(userId, {
        ...options,
        archivedBy: options.archivedBy ?? currentUserId,
        organizationId: options.organizationId ?? organizationId,
      });

      staffStoreRef.current.remove(staffId);
      setCountsVersion((version) => version + 1);
      await refreshArchivedStaff();

      return result;
    },
    [currentUserId, organizationId, refreshArchivedStaff],
  );

  const restoreStaff = useCallback(
    async (
      userId: number | string,
      payload?: {
        organizationId?: number | string | null;
        restoredBy?: number | string | null;
      },
    ) => {
      const result = await restoreStaffRecord(userId, {
        organizationId: payload?.organizationId ?? organizationId,
        restoredBy: payload?.restoredBy ?? currentUserId,
      });

      await Promise.all([refreshStaff(), refreshArchivedStaff()]);
      setCountsVersion((version) => version + 1);

      return result;
    },
    [currentUserId, organizationId, refreshArchivedStaff, refreshStaff],
  );

  const deleteArchivedStaff = useCallback(
    async (userId: number | string, reason?: string) => {
      const result = await deleteArchivedStaffRecord(userId, {
        organizationId,
        deletedBy: currentUserId,
        reason,
      });

      setArchivedStaff((rows) =>
        rows.filter((row) => String(row.userId || row.id) !== String(userId)),
      );
      await refreshArchivedStaff();

      return result;
    },
    [currentUserId, organizationId, refreshArchivedStaff],
  );

  const bulkDeleteArchivedStaff = useCallback(
    async (userIds: Array<number | string>, reason?: string) => {
      const result = await bulkDeleteArchivedStaffRecords(userIds, {
        organizationId,
        deletedBy: currentUserId,
        reason,
      });

      const deletedIds = new Set(
        (result.deleted_user_ids ?? userIds).map((id: number | string) =>
          String(id),
        ),
      );

      setArchivedStaff((rows) =>
        rows.filter((row) => !deletedIds.has(String(row.userId || row.id))),
      );
      await refreshArchivedStaff();

      return result;
    },
    [currentUserId, organizationId, refreshArchivedStaff],
  );

  return {
    staff,
    archivedStaff,

    isLoadingStaff,
    isLoadingArchivedStaff,
    hasLoadedArchivedStaff,
    isSavingStaff,
    staffError,
    staffTotal,
    staffCounts,
    staffDirectoryRecords,
    refreshStaffDirectoryRecords,
    staffPage,
    staffPageSize,
    setStaffPage,
    setStaffPageSize,

    organizationId,
    currentUserId,

    createStaff,
    updateStaff,
    assignShift,
    assignShifts,
    assignDepartment,
    archiveStaff,
    restoreStaff,
    deleteArchivedStaff,
    bulkDeleteArchivedStaff,

    refreshStaff,
    refreshArchivedStaff,
  };
}