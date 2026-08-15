/**
 * modules/staff/components/StaffModal.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Add / Edit staff modal. Still the largest component in the module — see
 * REFACTOR_NOTES.md for the suggested next round of extraction (live
 * assignment, hierarchy, and the form sections).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, {
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MapPin, Shield, Users, X } from "lucide-react";
import {
  type ShiftDefinition,
  type StaffWorkType,
  useOrg,
} from "../../../contexts/OrgConfigContext";
import { T } from "../../../components/ui/theme";
import JellyButton from "../../../components/ui/JellyButton";
import ModernSelect from "../../../components/ui/ModernSelect";
import { useAuthenticatedImageUrl } from "../../../hooks/useAuthenticatedImageUrl";
import { getEnabledModules, getModule } from "../../../config/moduleRegistry";
import { resolveApiBranchId } from "../../../utils/tenantScope";
import {
  configItemClassName as renderConfigItemClassName,
  configItemFamily as renderConfigItemFamily,
  configItemSectionName as renderConfigItemSectionName,
  type PeopleRenderingModel,
} from "../../../utils/templateRendering";
import { type TemplateFormField } from "../../../utils/templateColumns";
import { listStaffRecords, setStaffDashboardScope } from "../api/staffApi";
import {
  assignManager,
  getDirectReports,
  getManagerChain,
  listOrgClientUsers,
  setLinkedAccount,
  type DirectReport,
  type ManagerChainLink,
  type OrgClientUser,
} from "../api/hierarchyApi";
import {
  listBranchDepartments,
  listBranchShifts,
  type DepartmentRecord,
  type ShiftRecord,
} from "../api/attendanceSettingsApi";
import { normalizePeopleType, peopleCodeModel } from "../types/types";
import {
  getSalaryConfigForStaff,
  type PayrollSalaryConfig,
} from "../../../pages/Payroll/api/payrollApi";
import {
  EMPTY_FORM,
  type StaffFormData,
  type StaffMediaFiles,
} from "../types/staffForm";
import { type NamedConfigOption, type StaffMember } from "../types/staffTypes";
import { toNamedConfigOption } from "../utils/staffMapping";
import { resolveProfileImageUrl } from "../utils/staffMedia";
import { staffModules } from "../utils/staffMember";
import { normalizeStaffShiftId } from "../utils/staffShifts";
import { validateStaffForm } from "../utils/staffValidation";

// ─── Add / Edit Modal ─────────────────────────────────────────────────────────

export const StaffModal: FC<{
  initial?: StaffMember;
  onSave: (data: StaffFormData, files: StaffMediaFiles) => void | Promise<void>;
  onClose: () => void;
  scope: "global" | "branch";
  branchId?: number;
  shiftDefinitions: ShiftDefinition[];
  peopleModel: PeopleRenderingModel;
  templateFormFields: TemplateFormField[];
  /**
   * Whether the CURRENT session (the person filling out this form, not the
   * person being added/edited) may grant admin access to someone. Mirrors
   * the backend gate exactly: only an existing admin session may promote
   * anyone to admin (see role_permissions.py / support_db_staff.py's
   * granted_by_is_admin check). There is no separate "manage roles but not
   * admin" tier anymore — the old hr/manager/employee presets are gone, so
   * this single flag both shows the toggle and controls whether it can be
   * switched on. Any other session never sees the control at all — it's
   * simply omitted, same defensive posture as the rest of this form (a
   * hidden control is a UX nicety; the backend re-checks this regardless).
   */
  canGrantAdmin?: boolean;
  /**
   * Real, backend-relational shift/department assignment — additive
   * alongside the legacy `shift`/`department` fields on this same form.
   * Only usable once the staff member already exists (initial is set),
   * since the assignment endpoints operate on an existing staff_id.
   */
  onAssignShift?: (
    userId: number | string,
    shiftId: string | null,
  ) => Promise<unknown>;
  onAssignDepartment?: (
    userId: number | string,
    departmentId: string | null,
  ) => Promise<unknown>;
  /** Called after a manager/linked-account/dashboard-scope PATCH succeeds,
   * so the parent's cached staff list is fresh the next time this modal
   * (re)initializes liveDashboardScope/liveManagerId from `initial`.
   * Without this, a successful save still redisplays the pre-save value
   * on next open because `initial` is a stale snapshot from before the
   * PATCH — the write persisted, only the redisplay was stale. */
  onHierarchyChanged?: () => void | Promise<void>;
}> = ({
  initial,
  onSave,
  onClose,
  scope,
  branchId,
  shiftDefinitions,
  peopleModel,
  templateFormFields,
  onAssignShift,
  onAssignDepartment,
  onHierarchyChanged,
  canGrantAdmin = false,
}) => {
  const { cfg, organizationId } = useOrg();
  const profileImageFileRef = useRef<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState<StaffFormData>(
    initial
      ? {
          name: initial.name,
          personCode:
            initial.personCode ||
            initial.registrationNumber ||
            initial.employeeId ||
            "",
          email: initial.email ?? "",
          phone: initial.phone ?? "",
          branchId: initial.branchId,
          department: initial.department ?? "", // string — direct
          role: initial.role ?? "", // string — direct
          accountRole: initial.accountRole || "staff",
          status: initial.status, // typed union — direct
          salary: initial.salary ?? 50000,
          benefits: [...(initial.benefits ?? [])],
          joinDate: initial.joinDate ?? new Date().toISOString().split("T")[0], // correct field name
          staffType: ((initial as any).staffType ?? "office") as StaffWorkType,
          shift: normalizeStaffShiftId(shiftDefinitions, initial),
          customShiftStart:
            normalizeStaffShiftId(shiftDefinitions, initial) === "custom"
              ? ((initial as any).shiftStart ?? "09:00")
              : "09:00",
          customShiftEnd:
            normalizeStaffShiftId(shiftDefinitions, initial) === "custom"
              ? ((initial as any).shiftEnd ?? "17:00")
              : "17:00",
          moduleAccess: [...staffModules(initial)],
          liveShiftId: String(
            (initial as any)?.shiftIdRef ??
              (initial as any)?.shift_id_ref ??
              "",
          ),
          profileImageUrl: initial.profileImageUrl ?? "",
          profileImageName: initial.profileImageName ?? "",
          geofenceLat:
            initial.geofenceLat !== undefined && initial.geofenceLat !== null
              ? String(initial.geofenceLat)
              : "",
          geofenceLng:
            initial.geofenceLng !== undefined && initial.geofenceLng !== null
              ? String(initial.geofenceLng)
              : "",
          geofenceRadiusMeters:
            initial.geofenceRadiusMeters !== undefined &&
            initial.geofenceRadiusMeters !== null
              ? String(initial.geofenceRadiusMeters)
              : "100",
          geofenceLabel: initial.geofenceLabel ?? "",
          officeSsid: initial.officeSsid ?? "",
          officeBssidList: [...(initial.officeBssidList ?? [])],
          cnic: initial.cnic ?? "",
          fatherName: initial.fatherName ?? "",
          fatherCnic: initial.fatherCnic ?? "",
          fatherPhone: initial.fatherPhone ?? "",
        }
      : {
          ...EMPTY_FORM,
          branchId: branchId ?? cfg.branches[0]?.id ?? 0,
          shift: shiftDefinitions[0]?.id ?? "morning",
        },
  );
  // Profile photo routes require a Bearer token; a plain <img src> can't
  // attach one, so the preview goes through the authenticated-fetch hook
  // instead (persisted photo URLs only — local blob/data previews from a
  // freshly-picked file pass straight through unchanged, see the hook).
  const authedFormPhotoUrl = useAuthenticatedImageUrl(
    resolveProfileImageUrl(form.profileImageUrl),
  );
  const [benefitDraft, setBenefitDraft] = useState("");
  const [bssidDraft, setBssidDraft] = useState("");
  const [isLocating, setIsLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  // Recomputed from `form` on every render rather than held as separate
  // state — there is exactly one place (validateStaffForm) that decides
  // what's wrong, so the inline messages below and the Save gate can never
  // drift out of sync with each other.
  const formErrors = useMemo(
    () => validateStaffForm(form, peopleModel.isStudent),
    [
      form.email,
      form.phone,
      form.cnic,
      form.fatherName,
      form.fatherPhone,
      form.fatherCnic,
      peopleModel.isStudent,
    ],
  );

  const formFieldKeys = useMemo(
    () => new Set(templateFormFields.map((field) => field.key)),
    [templateFormFields],
  );

  const hasField = useCallback(
    (...keys: string[]) => keys.some((key) => formFieldKeys.has(key)),
    [formFieldKeys],
  );

  const showGroupField = hasField("class", "department");
  const showSubGroupField = hasField("section", "designation");
  const showSalaryField = hasField("salary");
  const showBenefitsField = hasField("benefits");
  const showStaffTypeField = !peopleModel.isStudent && hasField("staffType");
  const showShiftField = hasField("shiftId");
  const showProfileImageField = hasField("profileImage");
  const showMediaFields = showProfileImageField;
  const showModuleAccessField = hasField("accessModules");

  // Read-only allowances lookup — same rationale as StaffProfileDrawer's
  // salaryConfig fetch: this modal has no write path into salary_configs,
  // allowances are configured org-wide (Payroll → Payroll Rules) and
  // applied per-person only from PayrollModule's own Edit Payroll modal.
  // Shown here purely so it's visible while editing a staff member instead
  // of only in the read-only profile drawer. Only fetched for an existing
  // staff member (initial set) — a new record has no salary_configs row
  // yet, and never for students, since payroll doesn't apply to them.
  const showAllowancesField = Boolean(initial) && !peopleModel.isStudent;
  const [staffSalaryConfig, setStaffSalaryConfig] =
    useState<PayrollSalaryConfig | null>(null);
  const [staffSalaryConfigLoading, setStaffSalaryConfigLoading] =
    useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!showAllowancesField || !organizationId || !initial) {
      setStaffSalaryConfig(null);
      return undefined;
    }
    setStaffSalaryConfigLoading(true);
    getSalaryConfigForStaff(initial.id, organizationId)
      .then((config) => {
        if (!cancelled) setStaffSalaryConfig(config);
      })
      .catch(() => {
        if (!cancelled) setStaffSalaryConfig(null);
      })
      .finally(() => {
        if (!cancelled) setStaffSalaryConfigLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showAllowancesField, initial, organizationId]);

  const staffAllowanceItems = staffSalaryConfig?.allowancesBreakdown ?? [];

  // Typed setter — no `unknown` escape hatch needed
  function set<K extends keyof StaffFormData>(key: K, val: StaffFormData[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  const addBenefits = (rawValue: string): void => {
    const nextBenefits = rawValue
      .split(/[\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    if (nextBenefits.length === 0) return;

    set("benefits", Array.from(new Set([...form.benefits, ...nextBenefits])));
    setBenefitDraft("");
  };

  const removeBenefit = (benefit: string): void => {
    set(
      "benefits",
      form.benefits.filter((item) => item !== benefit),
    );
  };

  const addBssid = (rawValue: string): void => {
    const nextBssids = rawValue
      .split(/[\n,;]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    if (nextBssids.length === 0) return;

    set(
      "officeBssidList",
      Array.from(new Set([...form.officeBssidList, ...nextBssids])),
    );
    setBssidDraft("");
  };

  const removeBssid = (bssid: string): void => {
    set(
      "officeBssidList",
      form.officeBssidList.filter((item) => item !== bssid),
    );
  };

  /** Reads the admin's OWN current GPS position (browser Geolocation API) as
   * a convenience for filling in a field employee's assigned geofence — e.g.
   * standing at the hospital gate while creating that employee's record.
   * This is just a form-fill shortcut; it never itself marks anyone's
   * attendance. */
  const captureCurrentLocation = (): void => {
    if (!("geolocation" in navigator)) {
      setLocateError("Geolocation isn't available in this browser.");
      return;
    }

    setIsLocating(true);
    setLocateError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setIsLocating(false);
        set("geofenceLat", position.coords.latitude.toFixed(6));
        set("geofenceLng", position.coords.longitude.toFixed(6));
      },
      (error) => {
        setIsLocating(false);
        setLocateError(error.message || "Couldn't read current location.");
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const setMediaFile = (kind: "profileImage", file?: File): void => {
    if (!file) return;

    const isImage =
      file.type.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif)$/i.test(file.name);

    if (!isImage) {
      alert(
        `Please select a valid ${peopleModel.personSingular.toLowerCase()} image file.`,
      );
      return;
    }

    profileImageFileRef.current = file;

    const objectUrl = URL.createObjectURL(file);
    set("profileImageUrl", objectUrl);
    set("profileImageName", file.name);
  };

  const hasSelectedRequiredMedia = (): boolean => {
    if (initial) return true;
    if (!showProfileImageField) return true;

    return Boolean(
      profileImageFileRef.current ||
      form.profileImageName ||
      form.profileImageUrl,
    );
  };

  const depts = useMemo(() => {
    const items = cfg.departments[form.branchId] ?? [];

    if (peopleModel.isStudent) {
      const classNames = new Map<string, NamedConfigOption>();
      items
        .filter((item) => renderConfigItemFamily(item) === "student")
        .forEach((item, index) => {
          const name = renderConfigItemClassName(item);
          if (name && !classNames.has(name)) {
            classNames.set(name, { id: String(index), name });
          }
        });
      return Array.from(classNames.values());
    }

    return items
      .filter((item) => renderConfigItemFamily(item) === "workforce")
      .map(toNamedConfigOption)
      .filter((item) => Boolean(item.name.trim()));
  }, [cfg.departments, form.branchId, peopleModel.isStudent]);

  // ─── Live shift/department assignment (real backend relations) ──────────
  // Additive to the legacy `depts`/shift dropdowns above. The shift list is
  // now fetched — and selectable — for BOTH create and edit, since picking
  // a real shift no longer requires an existing staff_id: for a new record
  // the choice is held on form.liveShiftId and applied right after
  // createStaff() resolves (see handleSave in the parent). For an existing
  // record it's still PATCHed immediately on change, same as before.
  // Departments stay assignment-only-after-creation (unchanged) since
  // nothing here asked for that to change.
  //
  // Both fetches resolve the real backend branch UUID first — form.branchId
  // is the local UI ordinal id, and every branch-scoped attendance-settings
  // endpoint 400s on anything that isn't the actual Supabase UUID (see
  // resolveApiBranchId's comment).
  const apiBranchId = useMemo(
    () => resolveApiBranchId(organizationId, form.branchId, cfg.branches),
    [organizationId, form.branchId, cfg.branches],
  );

  const [liveDepartments, setLiveDepartments] = useState<DepartmentRecord[]>(
    [],
  );
  const [liveShifts, setLiveShifts] = useState<ShiftRecord[]>([]);
  const [isLoadingLiveShifts, setIsLoadingLiveShifts] = useState(false);
  const [liveAssignedDepartmentId, setLiveAssignedDepartmentId] =
    useState<string>(
      String(
        (initial as any)?.departmentId ?? (initial as any)?.department_id ?? "",
      ),
    );
  const [isSavingLiveDepartment, setIsSavingLiveDepartment] = useState(false);
  const [isSavingLiveShift, setIsSavingLiveShift] = useState(false);
  const [liveAssignmentError, setLiveAssignmentError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!organizationId || !apiBranchId) {
      setLiveDepartments([]);
      setLiveShifts([]);
      return;
    }
    let cancelled = false;

    // Departments (Tier 3 shift defaults + staff assignment) is a
    // workforce-only concept — students are grouped via Classes & Sections
    // instead (see `depts`/renderConfigItemFamily above). Skip the fetch
    // entirely for student records rather than fetching and then hiding it.
    if (initial && peopleModel.showDepartmentDesignationFields) {
      listBranchDepartments(apiBranchId, organizationId)
        .then((rows) => {
          if (!cancelled) setLiveDepartments(rows);
        })
        .catch(() => {
          if (!cancelled) setLiveDepartments([]);
        });
    } else {
      setLiveDepartments([]);
    }

    setIsLoadingLiveShifts(true);
    listBranchShifts(apiBranchId, organizationId, peopleModel.peopleType)
      .then((rows) => {
        if (!cancelled) setLiveShifts(rows);
      })
      .catch(() => {
        if (!cancelled) setLiveShifts([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingLiveShifts(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    initial,
    organizationId,
    apiBranchId,
    peopleModel.peopleType,
    peopleModel.showDepartmentDesignationFields,
  ]);

  const handleLiveDepartmentChange = async (departmentId: string) => {
    if (!initial || !onAssignDepartment) return;
    const staffId = (initial as any).userId ?? initial.id;
    setIsSavingLiveDepartment(true);
    setLiveAssignmentError(null);
    try {
      await onAssignDepartment(staffId, departmentId || null);
      setLiveAssignedDepartmentId(departmentId);
    } catch (error) {
      setLiveAssignmentError(
        error instanceof Error ? error.message : "Failed to assign department.",
      );
    } finally {
      setIsSavingLiveDepartment(false);
    }
  };

  // Always updates form.liveShiftId (the single source of truth for the
  // dropdown's value, and what handleSave reads to assign the shift right
  // after a new staff member is created). For an existing staff member it
  // additionally PATCHes the assignment immediately, same as before.
  const handleShiftAssignmentChange = async (shiftId: string) => {
    set("liveShiftId", shiftId);
    if (!initial || !onAssignShift) return;
    const staffId = (initial as any).userId ?? initial.id;
    setIsSavingLiveShift(true);
    setLiveAssignmentError(null);
    try {
      await onAssignShift(staffId, shiftId || null);
    } catch (error) {
      setLiveAssignmentError(
        error instanceof Error ? error.message : "Failed to assign shift.",
      );
      // Revert the dropdown to the last known-good value since the PATCH
      // failed — form.liveShiftId must not silently claim a shift that
      // was never actually persisted for an existing staff member.
      set(
        "liveShiftId",
        String(
          (initial as any)?.shiftIdRef ?? (initial as any)?.shift_id_ref ?? "",
        ),
      );
    } finally {
      setIsSavingLiveShift(false);
    }
  };

  // ─── Reporting manager / notification hierarchy (real backend relation) ─
  // Same additive, PATCH-on-change pattern as the live department/shift
  // controls above, but calling hierarchyApi directly rather than going
  // through onAssignShift/onAssignDepartment — there's no existing
  // useStaffRecords hook plumbing for this yet, and these two concerns
  // (who someone reports to, and which dashboard account a manager notifies)
  // are independent mutations, not something the parent list needs to
  // optimistically patch into ModuleContext the way shift/department are.
  const staffId = initial ? String((initial as any).userId ?? initial.id) : "";

  const [managerCandidates, setManagerCandidates] = useState<
    { id: string; name: string }[]
  >([]);
  const [orgUsers, setOrgUsers] = useState<OrgClientUser[]>([]);
  const [managerChain, setManagerChain] = useState<ManagerChainLink[]>([]);
  const [directReports, setDirectReports] = useState<DirectReport[]>([]);

  const [liveManagerId, setLiveManagerId] = useState<string>(
    String((initial as any)?.managerId ?? (initial as any)?.manager_id ?? ""),
  );
  const [liveLinkedClientUserId, setLiveLinkedClientUserId] = useState<string>(
    String(
      (initial as any)?.linkedClientUserId ??
        (initial as any)?.linked_client_user_id ??
        "",
    ),
  );
  const [isSavingManager, setIsSavingManager] = useState(false);
  const [isSavingLinkedAccount, setIsSavingLinkedAccount] = useState(false);
  const [hierarchyError, setHierarchyError] = useState<string | null>(null);

  // 'branch' (default, unrestricted within their branch/org) vs 'team'
  // (this person's own Client Dashboard session, once they next log in,
  // only sees their reporting chain — never themself). Independent of
  // manager_id/linked_client_user_id above — see
  // support_db_hierarchy.set_dashboard_scope's docstring.
  const [liveDashboardScope, setLiveDashboardScope] = useState<
    "branch" | "team"
  >(
    ((initial as any)?.dashboardScope ?? (initial as any)?.dashboard_scope) ===
      "team"
      ? "team"
      : "branch",
  );
  const [isSavingDashboardScope, setIsSavingDashboardScope] = useState(false);

  const managerLabel =
    peopleModel.peopleType === "student"
      ? "Class Teacher"
      : peopleModel.peopleType === "doctor"
        ? "Department Head"
        : peopleModel.peopleType === "worker"
          ? "Supervisor"
          : "Manager";

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;

    // Manager candidates + the linked-account picker are needed on BOTH
    // modals — the Add modal lets an admin pick a manager/visibility for a
    // person who doesn't have a staff_id yet, same as the live shift
    // dropdown already does for shifts.
    //
    // role: "all" — a manager can be an admin/hr/manager-role account, not
    // just a plain 'staff' row (the Staff Directory table's own default
    // scope). Without this, someone already assigned as this person's
    // manager could be missing from the dropdown's own option list, which
    // makes a correctly saved assignment display as "No manager assigned".
    listStaffRecords({ organizationId, role: "all" })
      .then((rows) => {
        if (cancelled) return;
        setManagerCandidates(
          rows
            .map((row: any) => ({
              id: String(row.id),
              name: String(row.name ?? "Unnamed"),
            }))
            .filter((row) => row.id !== staffId),
        );
      })
      .catch(() => {
        if (!cancelled) setManagerCandidates([]);
      });

    listOrgClientUsers(organizationId)
      .then((rows) => {
        if (!cancelled) setOrgUsers(rows);
      })
      .catch(() => {
        if (!cancelled) setOrgUsers([]);
      });

    // Manager chain / direct reports only make sense once a real staff_id
    // exists — nothing to walk yet for a person still being created.
    if (!initial)
      return () => {
        cancelled = true;
      };

    getManagerChain(organizationId, staffId)
      .then((chain) => {
        if (!cancelled) setManagerChain(chain);
      })
      .catch(() => {
        if (!cancelled) setManagerChain([]);
      });

    getDirectReports(organizationId, staffId)
      .then((reports) => {
        if (!cancelled) setDirectReports(reports);
      })
      .catch(() => {
        if (!cancelled) setDirectReports([]);
      });

    return () => {
      cancelled = true;
    };
  }, [initial, organizationId, staffId]);

  const handleManagerChange = async (managerId: string) => {
    if (!initial) {
      // Add modal: no staff_id yet — stage the choice on the form itself,
      // same "apply after creation" pattern as liveShiftId.
      setLiveManagerId(managerId);
      set("managerId", managerId);
      return;
    }
    if (!organizationId) return;
    setIsSavingManager(true);
    setHierarchyError(null);
    const previous = liveManagerId;
    setLiveManagerId(managerId);
    try {
      await assignManager(organizationId, staffId, managerId || null);
      const chain = await getManagerChain(organizationId, staffId);
      setManagerChain(chain);
      await onHierarchyChanged?.();
    } catch (error) {
      setLiveManagerId(previous);
      setHierarchyError(
        error instanceof Error ? error.message : "Failed to assign manager.",
      );
    } finally {
      setIsSavingManager(false);
    }
  };

  const handleLinkedAccountChange = async (clientUserId: string) => {
    if (!initial) {
      setLiveLinkedClientUserId(clientUserId);
      set("linkedClientUserId", clientUserId);
      return;
    }
    if (!organizationId) return;
    setIsSavingLinkedAccount(true);
    setHierarchyError(null);
    const previous = liveLinkedClientUserId;
    setLiveLinkedClientUserId(clientUserId);
    try {
      await setLinkedAccount(organizationId, staffId, clientUserId || null);
      await onHierarchyChanged?.();
    } catch (error) {
      setLiveLinkedClientUserId(previous);
      setHierarchyError(
        error instanceof Error
          ? error.message
          : "Failed to set linked dashboard account.",
      );
    } finally {
      setIsSavingLinkedAccount(false);
    }
  };

  const handleDashboardScopeChange = async (scope: "branch" | "team") => {
    if (!initial) {
      setLiveDashboardScope(scope);
      set("dashboardScope", scope);
      return;
    }
    if (!organizationId) return;
    setIsSavingDashboardScope(true);
    setHierarchyError(null);
    const previous = liveDashboardScope;
    setLiveDashboardScope(scope);
    try {
      await setStaffDashboardScope(staffId, organizationId, scope);
      await onHierarchyChanged?.();
    } catch (error) {
      setLiveDashboardScope(previous);
      setHierarchyError(
        error instanceof Error
          ? error.message
          : "Failed to update dashboard visibility.",
      );
    } finally {
      setIsSavingDashboardScope(false);
    }
  };

  const roles = useMemo(() => {
    if (peopleModel.isStudent) {
      const sectionNames = new Map<string, NamedConfigOption>();
      (cfg.departments[form.branchId] ?? [])
        .filter((item) => renderConfigItemFamily(item) === "student")
        .filter(
          (item) =>
            !form.department ||
            renderConfigItemClassName(item) === form.department,
        )
        .forEach((item, index) => {
          const name = renderConfigItemSectionName(item);
          if (name && !sectionNames.has(name)) {
            sectionNames.set(name, { id: String(index), name });
          }
        });
      return Array.from(sectionNames.values());
    }

    return (cfg.roles[form.branchId] ?? [])
      .filter((item) => renderConfigItemFamily(item) === "workforce")
      .map(toNamedConfigOption)
      .filter((item) => Boolean(item.name.trim()));
  }, [
    cfg.departments,
    cfg.roles,
    form.branchId,
    form.department,
    peopleModel.isStudent,
  ]);

  // Support-owned commercial scope (Organization.enabled_staff_types, via
  // cfg.enabledStaffTypes): which of "office"/"field" this org is entitled
  // to offer at all. cfg defaults this to both when unset, so pre-existing
  // orgs are never over-restricted. The backend (create/update_client_staff)
  // remains the hard enforcer regardless of what this filters client-side.
  const staffWorkTypeOptions = useMemo(() => {
    const allowed = new Set(cfg.enabledStaffTypes ?? ["office", "field"]);
    return (
      [
        { value: "office", label: peopleModel.workTypeLabels.office },
        { value: "field", label: peopleModel.workTypeLabels.field },
      ] as const
    ).filter((option) => allowed.has(option.value));
  }, [cfg.enabledStaffTypes, peopleModel.workTypeLabels]);

  // Only render the Type field when there's an actual choice: the
  // business template must offer it (showStaffTypeField) AND the org's
  // Support-owned scope must allow more than one value. When scope has
  // narrowed to exactly one, form.staffType is force-set to it by the
  // effect below regardless of whether the field is visible.
  const effectiveShowStaffTypeField =
    showStaffTypeField && staffWorkTypeOptions.length > 1;

  // If the org's scope has narrowed to a single work type (or the current
  // value fell outside scope — e.g. Support changed it in another tab)
  // since this form's initial value was set, snap to the one allowed
  // value instead of silently submitting a staffType the backend will
  // reject/re-clip.
  useEffect(() => {
    if (
      staffWorkTypeOptions.length === 1 &&
      form.staffType !== staffWorkTypeOptions[0].value
    ) {
      set("staffType", staffWorkTypeOptions[0].value as StaffWorkType);
    }
  }, [staffWorkTypeOptions]);

  const dashboardModuleOptions = useMemo(() => {
    const purchasedModules = getEnabledModules({
      scope: "both",
      bizType: cfg.bizType ?? undefined,
      enabledKeys: cfg.modules,
    });
    // "settings" is a structural capability, not a purchasable entitlement —
    // it must never depend on cfg.modules (the org's purchased set), the
    // same way AdminLayout force-injects "branches" regardless of cfg.modules.
    const settingsModule = getModule("settings");
    const withSettings =
      settingsModule && !purchasedModules.some((mod) => mod.key === "settings")
        ? [...purchasedModules, settingsModule]
        : purchasedModules;

    // Per-branch, per-people-type entitlement (branch_module_people_types,
    // edited from OrgDetail.tsx, surfaced here as
    // cfg.modulePeopleTypesByBranch[backendBranchId][moduleKey] -> people
    // types). This mirrors resolve_allowed_access_modules in support_db.py
    // exactly: a module with NO row for this branch is unrestricted, one
    // WITH a row is allowed only for the listed people types. Keep this
    // logic identical to the backend — it's the single source of truth,
    // this is just an echo so the UI doesn't offer what will be clipped.
    const branchConfig = apiBranchId
      ? cfg.modulePeopleTypesByBranch[apiBranchId]
      : undefined;
    if (!branchConfig) return withSettings;

    const normalizedPeopleType = normalizePeopleType(peopleModel.peopleType);
    return withSettings.filter((mod) => {
      const scopedTypes = branchConfig[mod.key];
      return !scopedTypes || scopedTypes.includes(normalizedPeopleType);
    });
  }, [
    cfg.bizType,
    cfg.modules,
    cfg.modulePeopleTypesByBranch,
    apiBranchId,
    peopleModel.peopleType,
  ]);

  // Entitlement can narrow after moduleAccess was already populated (branch
  // switched, people type changed, or Support edited the scope in another
  // tab). Strip anything no longer offered so the form never submits a
  // module the backend will silently clip anyway — keeping the visible
  // checkboxes and the saved value consistent.
  useEffect(() => {
    const allowedKeys = new Set(dashboardModuleOptions.map((mod) => mod.key));
    setForm((f) => {
      const next = f.moduleAccess.filter((m) => allowedKeys.has(m));
      return next.length === f.moduleAccess.length
        ? f
        : { ...f, moduleAccess: next };
    });
  }, [dashboardModuleOptions]);

  // Admin Access implies every module — mirrors the backend enforcement in
  // create_client_staff/update_client_staff (an admin grant now always
  // forces access_modules to the org's full entitled set server-side, so
  // this is UI convenience, not the source of truth). Re-runs whenever
  // dashboardModuleOptions changes too, so switching branch/people-type
  // while Admin Access is on keeps the checklist showing "everything,"
  // not a stale snapshot from whichever set was entitled at toggle-time.
  useEffect(() => {
    if (form.accountRole !== "admin") return;
    const allKeys = dashboardModuleOptions.map((mod) => mod.key);
    const same =
      allKeys.length === form.moduleAccess.length &&
      allKeys.every((k) => form.moduleAccess.includes(k));
    if (!same) set("moduleAccess", allKeys);
  }, [form.accountRole, dashboardModuleOptions]);

  // Admin Access implies org/branch-wide dashboard visibility too, not just
  // every module — mirrors the backend enforcement in update_client_staff
  // (an admin grant now always forces dashboard_scope='branch' server-side,
  // see backfill_admin_dashboard_scope.py for why this matters: a stale
  // 'team' value left over from a pre-promotion manager account silently
  // narrows Staff/Attendance/Leave/Overtime to the old reporting tree even
  // though the account is otherwise a full admin). This effect is UI
  // convenience only, same relationship this has to the module-checklist
  // effect just above it — the source of truth is still the server-side
  // force. Skips the no-op case (already 'branch') so it doesn't fire a
  // spurious PATCH on every render for an already-correct admin row.
  useEffect(() => {
    if (form.accountRole !== "admin") return;
    if (liveDashboardScope === "branch") return;
    void handleDashboardScopeChange("branch");
  }, [form.accountRole, liveDashboardScope]);

  const toggleModule = (mod: string) =>
    set(
      "moduleAccess",
      form.moduleAccess.includes(mod)
        ? form.moduleAccess.filter((m) => m !== mod)
        : [...form.moduleAccess, mod],
    );

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "9px 12px",
    border: `1px solid ${T.border}`,
    borderRadius: 8,
    fontSize: 13,
    color: T.head,
    background: T.card,
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    color: T.muted,
    textTransform: "uppercase",
    letterSpacing: ".07em",
    display: "block",
    marginBottom: 5,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          background: T.card,
          borderRadius: 16,
          width: "100%",
          maxWidth: 580,
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "18px 24px",
            borderBottom: `1px solid ${T.border}`,
            position: "sticky",
            top: 0,
            background: T.card,
            zIndex: 1,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700, color: T.head }}>
            {initial ? peopleModel.editRecordLabel : peopleModel.addRecordLabel}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: T.muted,
              padding: 4,
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            padding: "20px 24px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {/* Name + Person Code */}
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
          >
            <div>
              <label style={labelStyle}>
                {peopleModel.personSingular} Name *
              </label>
              <input
                style={inputStyle}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Ahmed Khan"
              />
            </div>
            <div>
              <label style={labelStyle}>
                {peopleCodeModel(peopleModel.peopleType).label} *
              </label>
              <input
                style={inputStyle}
                value={form.personCode}
                onChange={(e) => set("personCode", e.target.value.trim())}
                placeholder={
                  peopleCodeModel(peopleModel.peopleType).placeholder
                }
              />
            </div>
          </div>

          {/* Phone + Email */}
          {/* Neither is individually required, but at least one must be
              present — see the save-guard in the footer below. Login
              credentials use whichever is available: email takes priority,
              phone is the fallback identifier when there's no email. */}
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
          >
            <div>
              <label style={labelStyle}>Phone</label>
              <input
                style={{
                  ...inputStyle,
                  ...(formErrors.phone ? { borderColor: "#dc2626" } : null),
                }}
                value={form.phone}
                onChange={(e) => set("phone", e.target.value.trim())}
                placeholder="0300-1234567"
                aria-invalid={Boolean(formErrors.phone)}
              />
              {formErrors.phone && (
                <p
                  style={{
                    margin: "5px 0 0",
                    fontSize: 11,
                    color: "#dc2626",
                    fontWeight: 600,
                  }}
                >
                  {formErrors.phone}
                </p>
              )}
            </div>
            <div>
              <label style={labelStyle}>Email (optional)</label>
              <input
                style={{
                  ...inputStyle,
                  ...(formErrors.email ? { borderColor: "#dc2626" } : null),
                }}
                type="email"
                value={form.email ?? ""}
                // Lower-cased at entry, not just trimmed: the backend match
                // against client_staff.email is case-sensitive, so this is
                // what actually keeps the generated login working — see
                // validateStaffForm's comment above.
                onChange={(e) =>
                  set("email", e.target.value.trim().toLowerCase())
                }
                placeholder="ahmed@company.com"
                aria-invalid={Boolean(formErrors.email)}
              />
              {formErrors.email && (
                <p
                  style={{
                    margin: "5px 0 0",
                    fontSize: 11,
                    color: "#dc2626",
                    fontWeight: 600,
                  }}
                >
                  {formErrors.email}
                </p>
              )}
            </div>
          </div>
          {formErrors.contact && (
            <p
              style={{
                margin: "-8px 0 0",
                fontSize: 12,
                color: "#dc2626",
                fontWeight: 600,
              }}
            >
              {formErrors.contact}
            </p>
          )}

          {/* CNIC — required for every non-student person. Students carry
              their father's CNIC instead (guardian block below), not their
              own. */}
          {!peopleModel.isStudent && (
            <div>
              <label style={labelStyle}>CNIC *</label>
              <input
                style={{
                  ...inputStyle,
                  ...(formErrors.cnic ? { borderColor: "#dc2626" } : null),
                }}
                value={form.cnic}
                onChange={(e) => set("cnic", e.target.value.trim())}
                placeholder="42101-1234567-1"
                aria-invalid={Boolean(formErrors.cnic)}
              />
              {formErrors.cnic && (
                <p
                  style={{
                    margin: "5px 0 0",
                    fontSize: 11,
                    color: "#dc2626",
                    fontWeight: 600,
                  }}
                >
                  {formErrors.cnic}
                </p>
              )}
            </div>
          )}

          {/* Guardian details — students only, all three required. */}
          {peopleModel.isStudent && (
            <>
              <div>
                <label style={labelStyle}>Father Name *</label>
                <input
                  style={{
                    ...inputStyle,
                    ...(formErrors.fatherName
                      ? { borderColor: "#dc2626" }
                      : null),
                  }}
                  value={form.fatherName}
                  onChange={(e) => set("fatherName", e.target.value)}
                  placeholder="Muhammad Khan"
                  aria-invalid={Boolean(formErrors.fatherName)}
                />
                {formErrors.fatherName && (
                  <p
                    style={{
                      margin: "5px 0 0",
                      fontSize: 11,
                      color: "#dc2626",
                      fontWeight: 600,
                    }}
                  >
                    {formErrors.fatherName}
                  </p>
                )}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 14,
                }}
              >
                <div>
                  <label style={labelStyle}>Father Number *</label>
                  <input
                    style={{
                      ...inputStyle,
                      ...(formErrors.fatherPhone
                        ? { borderColor: "#dc2626" }
                        : null),
                    }}
                    value={form.fatherPhone}
                    onChange={(e) => set("fatherPhone", e.target.value.trim())}
                    placeholder="0300-1234567"
                    aria-invalid={Boolean(formErrors.fatherPhone)}
                  />
                  {formErrors.fatherPhone && (
                    <p
                      style={{
                        margin: "5px 0 0",
                        fontSize: 11,
                        color: "#dc2626",
                        fontWeight: 600,
                      }}
                    >
                      {formErrors.fatherPhone}
                    </p>
                  )}
                </div>
                <div>
                  <label style={labelStyle}>Father CNIC *</label>
                  <input
                    style={{
                      ...inputStyle,
                      ...(formErrors.fatherCnic
                        ? { borderColor: "#dc2626" }
                        : null),
                    }}
                    value={form.fatherCnic}
                    onChange={(e) => set("fatherCnic", e.target.value.trim())}
                    placeholder="42101-1234567-1"
                    aria-invalid={Boolean(formErrors.fatherCnic)}
                  />
                  {formErrors.fatherCnic && (
                    <p
                      style={{
                        margin: "5px 0 0",
                        fontSize: 11,
                        color: "#dc2626",
                        fontWeight: 600,
                      }}
                    >
                      {formErrors.fatherCnic}
                    </p>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Joining Date */}
          <div>
            <label style={labelStyle}>Joining Date</label>
            <input
              style={inputStyle}
              value={form.joinDate}
              type="date"
              onChange={(e) => set("joinDate", e.target.value)}
            />
          </div>

          {/* Branch */}
          <div>
            <label style={labelStyle}>Branch *</label>
            {scope === "branch" ? (
              <div
                style={{
                  ...inputStyle,
                  background: T.teal50,
                  color: T.teal600,
                  fontWeight: 600,
                }}
              >
                {cfg.branches.find((b) => b.id === branchId)?.name ?? "Branch"}
              </div>
            ) : (
              <ModernSelect
                value={String(form.branchId)}
                onChange={(value) => set("branchId", Number(value))}
                options={cfg.branches.map((branch) => ({
                  value: String(branch.id),
                  label: `${branch.name}${branch.city ? ` — ${branch.city}` : ""}`,
                }))}
                ariaLabel="Select branch"
                width="100%"
                disabled={cfg.branches.length === 0}
              />
            )}
          </div>

          {/* Template-configured structure fields */}
          {(showGroupField || showSubGroupField) && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  showGroupField && showSubGroupField ? "1fr 1fr" : "1fr",
                gap: 14,
              }}
            >
              {showGroupField && (
                <div>
                  <label style={labelStyle}>{peopleModel.groupLabel}</label>
                  <ModernSelect
                    value={form.department}
                    onChange={(value) => set("department", value)}
                    options={[
                      { value: "", label: "Select…" },
                      ...depts.map((department) => ({
                        value: department.name,
                        label: department.name,
                      })),
                    ]}
                    ariaLabel={`Select ${peopleModel.groupLabel.toLowerCase()}`}
                    width="100%"
                  />
                </div>
              )}
              {showSubGroupField && (
                <div>
                  <label style={labelStyle}>{peopleModel.roleLabel}</label>
                  <ModernSelect
                    value={form.role}
                    onChange={(value) => set("role", value)}
                    options={[
                      { value: "", label: "Select…" },
                      ...roles.map((role) => ({
                        value: role.name,
                        label: role.name,
                      })),
                    ]}
                    ariaLabel={`Select ${peopleModel.roleLabel.toLowerCase()}`}
                    width="100%"
                  />
                </div>
              )}
            </div>
          )}

          {/* Template-configured compensation/status fields */}
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}
          >
            <div
              style={{
                display: showSalaryField ? "block" : "none",
              }}
            >
              <label style={labelStyle}>Compensation (PKR)</label>
              <input
                style={inputStyle}
                value={form.salary}
                type="number"
                onChange={(e) => set("salary", Number(e.target.value))}
              />
            </div>
            <div>
              <label style={labelStyle}>Status</label>
              <ModernSelect
                value={form.status}
                onChange={(value) =>
                  set("status", value as StaffMember["status"])
                }
                options={[
                  { value: "active", label: peopleModel.statusLabels.active },
                  {
                    value: "inactive",
                    label: peopleModel.statusLabels.inactive,
                  },
                  { value: "pending", label: peopleModel.statusLabels.pending },
                ]}
                ariaLabel="Select status"
                width="100%"
              />
            </div>
          </div>

          {/* Benefits */}
          {showBenefitsField && (
            <div>
              <label style={labelStyle}>
                {peopleModel.personSingular} Benefits
              </label>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <input
                  style={inputStyle}
                  value={benefitDraft}
                  onChange={(e) => setBenefitDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addBenefits(benefitDraft);
                    }
                  }}
                  placeholder="Medical insurance, transport, bonus, lunch..."
                />
                <JellyButton
                  type="button"
                  variant="primary"
                  size="md"
                  onClick={() => addBenefits(benefitDraft)}
                >
                  Add
                </JellyButton>
              </div>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  marginTop: 10,
                }}
              >
                {form.benefits.length ? (
                  form.benefits.map((benefit) => (
                    <button
                      key={benefit}
                      type="button"
                      onClick={() => removeBenefit(benefit)}
                      title="Remove benefit"
                      style={{
                        border: `1px solid ${T.teal200}`,
                        background: T.teal50,
                        color: T.teal700,
                        borderRadius: 20,
                        padding: "5px 10px",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: 800,
                        fontFamily: "inherit",
                      }}
                    >
                      {benefit} ×
                    </button>
                  ))
                ) : (
                  <span style={{ fontSize: 11, color: T.muted }}>
                    No benefits added yet.
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Allowances — read-only. Configured org-wide in Payroll →
              Payroll Rules, applied per-person from Payroll → Edit Payroll,
              so there's nothing to edit here; this just surfaces what's
              already applied so it isn't only visible in the profile drawer. */}
          {showAllowancesField && (
            <div>
              <label style={labelStyle}>Allowances</label>
              <div
                style={{
                  border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontSize: 12,
                  color: T.head,
                  background: T.teal50,
                }}
              >
                {staffSalaryConfigLoading ? (
                  <span style={{ color: T.muted }}>Loading…</span>
                ) : staffAllowanceItems.length ? (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    {staffAllowanceItems.map((item) => (
                      <span
                        key={item.key}
                        style={{
                          border: `1px solid ${T.teal200}`,
                          borderRadius: 20,
                          padding: "4px 10px",
                          fontWeight: 700,
                          color: T.teal700,
                          background: T.card,
                        }}
                      >
                        {item.mode === "percent"
                          ? `${item.label} (${item.value}%: PKR ${item.amount.toLocaleString()})`
                          : `${item.label} (PKR ${item.amount.toLocaleString()})`}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: T.muted }}>
                    No allowances applied yet.
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: T.muted, marginTop: 6 }}>
                Configured org-wide from Payroll → Payroll Rules, and applied
                per person from Payroll → Edit Payroll — not editable here.
              </div>
            </div>
          )}

          {/* Staff Type + Shift — Shift is a real dropdown of this branch's
              configured shifts (shifts.id, a UUID), available for both
              create and edit. For an existing staff member the choice is
              PATCHed immediately; for a new one it's applied right after
              creation (see handleSave). Never guesses/falls back to a UI
              ordinal id — see apiBranchId/resolveApiBranchId above.

              The Type field itself only renders when there's an actual
              choice to make: if Support has narrowed enabledStaffTypes to
              a single value, form.staffType is already force-set to it
              (see the effect above), so showing a disabled one-option
              dropdown here would just be noise — the person can't do
              anything with it. */}
          {(effectiveShowStaffTypeField || showShiftField) && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  effectiveShowStaffTypeField && showShiftField
                    ? "1fr 1fr"
                    : "1fr",
                gap: 14,
              }}
            >
              {effectiveShowStaffTypeField && (
                <div>
                  <label style={labelStyle}>
                    {peopleModel.personSingular} Type
                  </label>
                  <ModernSelect
                    value={form.staffType}
                    onChange={(value) =>
                      set("staffType", value as StaffWorkType)
                    }
                    options={staffWorkTypeOptions}
                    ariaLabel={`Select ${peopleModel.personSingular.toLowerCase()} type`}
                    width="100%"
                  />
                </div>
              )}
              {showShiftField && (
                <div>
                  <label style={labelStyle}>
                    Shift
                    {isSavingLiveShift && (
                      <span style={{ fontWeight: 400, textTransform: "none" }}>
                        {" "}
                        · saving…
                      </span>
                    )}
                  </label>
                  {!apiBranchId ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: T.muted,
                        padding: "10px 12px",
                        border: `1px dashed ${T.border}`,
                        borderRadius: 8,
                        background: T.slate50,
                      }}
                    >
                      Select a branch first — shifts are configured per-branch.
                    </div>
                  ) : liveShifts.length === 0 ? (
                    <div
                      style={{
                        fontSize: 12,
                        color: T.muted,
                        padding: "10px 12px",
                        border: `1px dashed ${T.border}`,
                        borderRadius: 8,
                        background: T.slate50,
                      }}
                    >
                      {isLoadingLiveShifts ? (
                        "Loading shifts…"
                      ) : (
                        <>
                          No shifts configured for this branch yet. Create one
                          (including a one-off custom shift for just this
                          person) from the <strong>Shift Allocation</strong>{" "}
                          tab's <strong>Shift Timings</strong> button — it's
                          what the local attendance node actually reads.
                        </>
                      )}
                    </div>
                  ) : (
                    <ModernSelect
                      value={form.liveShiftId || ""}
                      onChange={(value) =>
                        void handleShiftAssignmentChange(value)
                      }
                      options={[
                        { value: "", label: "Unassigned" },
                        ...liveShifts.map((shift) => ({
                          value: shift.id,
                          label: shift.name
                            ? `${shift.name} · ${shift.check_in_time ?? "?"}–${shift.check_out_time ?? "?"}`
                            : `${shift.check_in_time ?? "?"}–${shift.check_out_time ?? "?"}`,
                        })),
                      ]}
                      ariaLabel="Select shift"
                      width="100%"
                      disabled={isSavingLiveShift}
                    />
                  )}
                  {!initial && form.liveShiftId && (
                    <div style={{ fontSize: 11, color: T.muted, marginTop: 5 }}>
                      Applied automatically once this{" "}
                      {peopleModel.personSingular.toLowerCase()} is created.
                    </div>
                  )}
                  {liveAssignmentError && (
                    <div
                      style={{ fontSize: 12, color: "#e11d48", marginTop: 6 }}
                    >
                      {liveAssignmentError}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/*
            Attendance Location — the per-staff config the geofence/WiFi
            checks actually run against. Shown once staffType is known:
            - field: static-location geofence (lat/lng + radius). This is
              scenario #1 of the open/dynamic field-attendance model —
              visiting-plan and route scenarios build on top of this same
              per-staff record later, they don't replace it.
            - office: dynamic WiFi network (SSID + one or more BSSIDs),
              replacing the mobile app's previously hardcoded constants.
            Only rendered when the Staff Type field itself is in play —
            no staffType, no location config to attach it to.
          */}
          {showStaffTypeField && form.staffType === "field" && (
            <div
              style={{
                padding: 14,
                border: `1px dashed ${T.border}`,
                borderRadius: 12,
                background: T.slate50,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 900,
                  color: T.head,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <MapPin size={14} />
                Assigned Geofence Location
              </div>
              <div style={{ fontSize: 11, color: T.muted, marginTop: -6 }}>
                For a fixed-site field employee (e.g. "at Sheikh Zaid Hospital,
                10am–3pm"). Attendance is accepted within the radius below of
                this point. Leave blank if this{" "}
                {peopleModel.personSingular.toLowerCase()} follows a visiting
                plan/route instead — that's configured separately.
              </div>

              <div>
                <label style={labelStyle}>Site Label</label>
                <input
                  type="text"
                  value={form.geofenceLabel}
                  onChange={(e) => set("geofenceLabel", e.target.value)}
                  placeholder="e.g. Sheikh Zaid Hospital"
                  style={inputStyle}
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 14,
                }}
              >
                <div>
                  <label style={labelStyle}>Latitude</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.geofenceLat}
                    onChange={(e) => set("geofenceLat", e.target.value)}
                    placeholder="31.4180"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Longitude</label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.geofenceLng}
                    onChange={(e) => set("geofenceLng", e.target.value)}
                    placeholder="73.0791"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Radius (meters)</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={form.geofenceRadiusMeters}
                    onChange={(e) =>
                      set("geofenceRadiusMeters", e.target.value)
                    }
                    placeholder="100"
                    style={inputStyle}
                  />
                </div>
              </div>

              <div>
                <button
                  type="button"
                  onClick={captureCurrentLocation}
                  disabled={isLocating}
                  style={{
                    border: `1px solid ${T.teal200}`,
                    background: T.teal50,
                    color: T.teal700,
                    borderRadius: 8,
                    padding: "8px 12px",
                    cursor: isLocating ? "wait" : "pointer",
                    fontSize: 12,
                    fontWeight: 800,
                    fontFamily: "inherit",
                  }}
                >
                  {isLocating ? "Locating…" : "Use My Current Location"}
                </button>
                {locateError && (
                  <div style={{ fontSize: 11, color: "#e11d48", marginTop: 6 }}>
                    {locateError}
                  </div>
                )}
                <div style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>
                  Stand at the assigned site and tap this to auto-fill lat/lng,
                  or type coordinates in directly.
                </div>
              </div>
            </div>
          )}

          {showStaffTypeField && form.staffType === "office" && (
            <div
              style={{
                padding: 14,
                border: `1px dashed ${T.border}`,
                borderRadius: 12,
                background: T.slate50,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 900,
                  color: T.head,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <MapPin size={14} />
                Assigned Office WiFi Network
              </div>
              <div style={{ fontSize: 11, color: T.muted, marginTop: -6 }}>
                The mobile app auto-marks attendance when this employee's device
                connects to this network. Configurable per company — no longer
                hardcoded in the app. If this branch has more than one access
                point broadcasting the same name (a mesh network), add every
                BSSID below so any of them is accepted.
              </div>

              <div>
                <label style={labelStyle}>WiFi Network Name (SSID)</label>
                <input
                  type="text"
                  value={form.officeSsid}
                  onChange={(e) => set("officeSsid", e.target.value)}
                  placeholder="e.g. Qintellect_5G"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>
                  Access Point BSSID(s)
                  <span style={{ fontWeight: 400, textTransform: "none" }}>
                    {" "}
                    — one per access point
                  </span>
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="text"
                    value={bssidDraft}
                    onChange={(e) => setBssidDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addBssid(bssidDraft);
                      }
                    }}
                    placeholder="e.g. b4:0f:3b:6b:1b:75"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={() => addBssid(bssidDraft)}
                    style={{
                      border: `1px solid ${T.teal200}`,
                      background: T.teal50,
                      color: T.teal700,
                      borderRadius: 8,
                      padding: "0 14px",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 900,
                      fontFamily: "inherit",
                    }}
                  >
                    Add
                  </button>
                </div>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginTop: 10,
                  }}
                >
                  {form.officeBssidList.length ? (
                    form.officeBssidList.map((bssid) => (
                      <button
                        key={bssid}
                        type="button"
                        onClick={() => removeBssid(bssid)}
                        title="Remove BSSID"
                        style={{
                          border: `1px solid ${T.teal200}`,
                          background: T.teal50,
                          color: T.teal700,
                          borderRadius: 20,
                          padding: "5px 10px",
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: 800,
                          fontFamily: "monospace",
                        }}
                      >
                        {bssid} ×
                      </button>
                    ))
                  ) : (
                    <span style={{ fontSize: 11, color: T.muted }}>
                      No access points added yet — WiFi auto-mark won't work
                      until at least one BSSID is added.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/*
            Live, backend-synced department assignment — additive. Only
            shown when editing an existing staff member (the assignment
            endpoint requires a real staff_id) and only if the branch has
            real departments configured. The legacy `department` field
            above remains untouched and keeps working for whatever still
            reads it.
          */}
          {initial && liveDepartments.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 14,
                padding: 14,
                border: `1px dashed ${T.border}`,
                borderRadius: 12,
                background: T.slate50,
              }}
            >
              <div
                style={{
                  gridColumn: "1 / -1",
                  fontSize: 12,
                  fontWeight: 600,
                  color: T.muted,
                }}
              >
                Live Assignment (synced to attendance engine)
              </div>
              {peopleModel.showDepartmentDesignationFields && (
                <div>
                  <label style={labelStyle}>Assigned Department</label>
                  <ModernSelect
                    value={liveAssignedDepartmentId}
                    onChange={(value) => void handleLiveDepartmentChange(value)}
                    options={[
                      { value: "", label: "Unassigned" },
                      ...liveDepartments.map((department) => ({
                        value: department.id,
                        label: department.name,
                      })),
                    ]}
                    ariaLabel="Select assigned department"
                    width="100%"
                    disabled={isSavingLiveDepartment}
                  />
                </div>
              )}
              {liveAssignmentError && (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    fontSize: 12,
                    color: "#e11d48",
                  }}
                >
                  {liveAssignmentError}
                </div>
              )}
            </div>
          )}

          {!peopleModel.isStudent && (
            <div
              style={{
                gridColumn: "1 / -1",
                display: "grid",
                gap: 14,
                padding: 18,
                border: `1px solid ${T.border}`,
                borderRadius: 14,
                background: T.card,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 9,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: T.slate50,
                    color: T.head,
                    flexShrink: 0,
                  }}
                >
                  <Users size={16} />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.head }}>
                    Reporting Hierarchy
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 14,
                }}
              >
                <div>
                  <label style={labelStyle}>{managerLabel}</label>
                  <ModernSelect
                    value={liveManagerId}
                    onChange={(value) => void handleManagerChange(value)}
                    options={[
                      { value: "", label: "No manager assigned" },
                      ...managerCandidates.map((candidate) => ({
                        value: candidate.id,
                        label: candidate.name,
                      })),
                      // Defensive fallback: if the currently assigned
                      // manager isn't in managerCandidates for any reason
                      // (archived, a scope/pagination gap, a stale cache),
                      // still render them as a selectable option using the
                      // name from managerChain (a separate, unfiltered
                      // lookup by id) — otherwise the select has no
                      // <option> matching liveManagerId and silently shows
                      // as unselected even though the assignment is real
                      // and saved.
                      ...(liveManagerId &&
                      !managerCandidates.some((c) => c.id === liveManagerId)
                        ? [
                            {
                              value: liveManagerId,
                              label: managerChain[0]?.name ?? "Current manager",
                            },
                          ]
                        : []),
                    ]}
                    ariaLabel={`Select ${managerLabel.toLowerCase()}`}
                    width="100%"
                    disabled={isSavingManager}
                  />
                  {managerChain.length > 0 && (
                    <div style={{ fontSize: 11, color: T.muted, marginTop: 6 }}>
                      Chain: {managerChain.map((link) => link.name).join(" → ")}
                    </div>
                  )}
                </div>

                <div style={{ gridColumn: "1 / -1" }}>
                  <label style={labelStyle}>Dashboard Visibility</label>

                  <div
                    style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}
                  >
                    {form.accountRole === "admin"
                      ? "Admin Access grants org/branch-wide visibility automatically — nothing to pick here."
                      : "Choose whether this person's own dashboard session sees everyone, or only their reporting chain."}
                  </div>

                  <ModernSelect
                    value={liveDashboardScope}
                    onChange={(value) =>
                      void handleDashboardScopeChange(
                        value as "branch" | "team",
                      )
                    }
                    options={[
                      { value: "branch", label: "Everyone in branch/org" },
                      { value: "team", label: "My Team Only" },
                    ]}
                    ariaLabel="Select dashboard visibility scope"
                    width="100%"
                    disabled={
                      isSavingDashboardScope || form.accountRole === "admin"
                    }
                  />

                  {/* Always-visible scope summary — states plainly what this
                    person's session will actually be able to see, computed
                    from the same directReports list rendered below, so an
                    admin never has to infer visibility from the dropdown
                    value alone. Shown for both scopes, and specifically
                    calls out the 0-reports case ("team" scope with an empty
                    subtree is a real, valid state — they'll see an empty
                    list, never their own row —
                    not a sign anything is broken). */}
                  {initial && (
                    <div
                      style={{
                        gridColumn: "1 / -1",
                        marginTop: 10,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "10px 12px",
                        borderRadius: 10,
                        background:
                          liveDashboardScope === "team"
                            ? `${T.amber}12`
                            : T.slate50,
                        border: `1px solid ${
                          liveDashboardScope === "team"
                            ? `${T.amber}40`
                            : T.border
                        }`,
                      }}
                    >
                      <Shield
                        size={14}
                        color={
                          liveDashboardScope === "team" ? T.amber : T.muted
                        }
                        style={{ marginTop: 1, flexShrink: 0 }}
                      />
                      <div
                        style={{
                          fontSize: 11.5,
                          color: T.head,
                          lineHeight: 1.5,
                        }}
                      >
                        {liveDashboardScope === "team" ? (
                          <>
                            <strong>Restricted session.</strong> Once they next
                            log in, {form.name || "this person"} will see{" "}
                            <strong>
                              {directReports.length === 0
                                ? "nobody — an empty list until reports are assigned to them"
                                : `${directReports.length} direct ${
                                    directReports.length === 1
                                      ? "report"
                                      : "reports"
                                  } (plus anyone further below them in the chain)`}
                            </strong>{" "}
                            across Staff, Attendance, and Leave — never their
                            own row, and never the full branch/org list.
                          </>
                        ) : (
                          <>
                            <strong>Full visibility.</strong> This session sees
                            everyone in their branch/org, same as any admin/HR
                            account.
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {canGrantAdmin && (
                  <div style={{ gridColumn: "1 / -1" }}>
                    <label style={labelStyle}>Admin Access</label>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <JellyButton
                        type="button"
                        variant={
                          form.accountRole === "admin" ? "primary" : "ghost"
                        }
                        size="sm"
                        onClick={() =>
                          set(
                            "accountRole",
                            form.accountRole === "admin" ? "staff" : "admin",
                          )
                        }
                        style={{ borderRadius: 999 }}
                      >
                        {form.accountRole === "admin"
                          ? "Admin — full dashboard access"
                          : "Staff — no admin access"}
                      </JellyButton>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        marginTop: 10,
                        padding: "10px 12px",
                        borderRadius: 10,
                        background:
                          form.accountRole === "admin"
                            ? `${T.amber}12`
                            : T.slate50,
                        border: `1px solid ${
                          form.accountRole === "admin"
                            ? `${T.amber}40`
                            : T.border
                        }`,
                      }}
                    >
                      <Shield
                        size={14}
                        color={form.accountRole === "admin" ? T.amber : T.muted}
                        style={{ marginTop: 1, flexShrink: 0 }}
                      />
                      <div
                        style={{
                          fontSize: 11.5,
                          color: T.head,
                          lineHeight: 1.5,
                        }}
                      >
                        {form.accountRole === "admin" ? (
                          <>
                            <strong>Full dashboard access.</strong>{" "}
                            {form.name || "This person"} will be able to manage
                            every module, add and remove other staff, and grant
                            admin access to others.
                          </>
                        ) : (
                          <>
                            <strong>No admin access.</strong>{" "}
                            {form.name || "This person"} can only log into the
                            Client Dashboard if you also pick specific modules
                            for them below — otherwise they're mobile-portal
                            only.
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {directReports.length > 0 && (
                <div>
                  <label style={labelStyle}>
                    Direct Reports ({directReports.length})
                  </label>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      marginTop: 4,
                    }}
                  >
                    {directReports.map((report) => (
                      <span
                        key={report.id}
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: T.head,
                          background: T.slate50,
                          border: `1px solid ${T.border}`,
                          borderRadius: 999,
                          padding: "4px 10px",
                        }}
                      >
                        {report.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {hierarchyError && (
                <div
                  style={{
                    fontSize: 12,
                    color: "#e11d48",
                    background: "#fef2f2",
                    border: "1px solid #fecdd3",
                    borderRadius: 8,
                    padding: "8px 10px",
                  }}
                >
                  {hierarchyError}
                </div>
              )}
            </div>
          )}
          {showProfileImageField && (
            <div>
              <label style={labelStyle}>
                {peopleModel.personSingular} Profile Image
              </label>
              <div
                style={{
                  padding: 14,
                  border: `1px solid ${T.border}`,
                  borderRadius: 12,
                  background: T.slate50,
                }}
              >
                <input
                  style={inputStyle}
                  type="file"
                  accept="image/*"
                  onChange={(e) =>
                    setMediaFile("profileImage", e.target.files?.[0])
                  }
                />

                {form.profileImageUrl && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      marginTop: 10,
                    }}
                  >
                    <img
                      src={authedFormPhotoUrl ?? undefined}
                      alt={form.name || `${peopleModel.personSingular} profile`}
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                      style={{
                        width: 46,
                        height: 46,
                        borderRadius: "50%",
                        objectFit: "cover",
                        border: `2px solid ${T.teal200}`,
                      }}
                    />
                    <span style={{ fontSize: 11, color: T.muted }}>
                      {form.profileImageName || "Profile image selected"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Dashboard module access */}
          {showModuleAccessField && (
            <div>
              <label style={labelStyle}>Dashboard Module Access</label>

              <div style={{ fontSize: 11, color: T.muted, marginBottom: 8 }}>
                {form.accountRole === "admin"
                  ? "Admin Access grants every module automatically — nothing to pick here."
                  : "Select only the dashboard modules this employee can access."}
              </div>

              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  opacity: form.accountRole === "admin" ? 0.6 : 1,
                }}
              >
                {dashboardModuleOptions.map((mod) => {
                  const has = form.moduleAccess.includes(mod.key);

                  return (
                    <JellyButton
                      type="button"
                      key={mod.key}
                      variant={has ? "primary" : "ghost"}
                      size="sm"
                      disabled={form.accountRole === "admin"}
                      onClick={() => toggleModule(mod.key)}
                      style={{
                        borderRadius: 999,
                        cursor:
                          form.accountRole === "admin"
                            ? "not-allowed"
                            : "pointer",
                      }}
                    >
                      {mod.label}
                    </JellyButton>
                  );
                })}

                {dashboardModuleOptions.length === 0 && (
                  <span style={{ fontSize: 12, color: T.muted }}>
                    No dashboard modules are enabled for this organization.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "flex-end",
            padding: "16px 24px",
            borderTop: `1px solid ${T.border}`,
            position: "sticky",
            bottom: 0,
            background: T.card,
          }}
        >
          <JellyButton type="button" variant="ghost" onClick={onClose}>
            Cancel
          </JellyButton>
          <JellyButton
            type="button"
            variant="primary"
            loading={isSaving}
            onClick={async () => {
              if (isSaving) return;

              if (!form.name || !form.personCode) return;

              if (Object.keys(formErrors).length > 0) {
                // Inline messages next to Phone/Email already show what's
                // wrong; nothing further to say here.
                return;
              }

              if (!hasSelectedRequiredMedia()) {
                alert("Please upload a profile image.");
                return;
              }

              try {
                setIsSaving(true);

                await onSave(form, {
                  profileImageFile: profileImageFileRef.current,
                });
              } finally {
                setIsSaving(false);
              }
            }}
          >
            {isSaving
              ? initial
                ? "Saving..."
                : "Creating..."
              : initial
                ? "Save Changes"
                : peopleModel.addRecordLabel}
          </JellyButton>
        </div>
      </div>
    </div>
  );
};
