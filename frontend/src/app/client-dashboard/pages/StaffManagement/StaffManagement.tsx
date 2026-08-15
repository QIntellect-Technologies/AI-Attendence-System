/**
 * modules/staff/StaffManagement.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Staff Directory — container component.
 * Scope-aware: global shows all branches, branch shows only that branch.
 *
 * Features:
 *   • Search across name / person code
 *   • Filter by status, branch (global only), department
 *   • Add/Edit modal with full form + module access checklist
 *   • Profile drawer (right-side panel with full details)
 *   • Bulk selection
 *   • CSV export
 *   • Profile image upload for Local Node attendance UI
 *
 * Presentational pieces live in ./components, pure helpers in ./utils and
 * ./types. This file keeps the data fetching, filtering/sorting, and the
 * save/delete/restore orchestration.
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
import {
  confirmDialog,
  toastError,
  toastInfo,
  toastSuccess,
} from "../../utils/notifications";
import { useParams, useSearchParams } from "react-router-dom";
import {
  ArchiveRestore,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  MapPin,
  Plus,
  Users,
} from "lucide-react";
import { type StaffMember as ModuleStaffMember } from "../../contexts/ModuleContext";
import { useAuth } from "../../contexts/useAuth";
import { type OrgUserRecord, useOrg } from "../../contexts/OrgConfigContext";
import { EmptyState, ModuleShell } from "../engine/ModuleShell";
import RefreshButton from "../../components/ui/RefreshButton";
import { T } from "../../components/ui/theme";
import DynamicFilterToolbar, {
  type DynamicFilterSection,
} from "../../components/ui/DynamicFilterToolbar";
import ExportButton from "../../components/ui/ExportButton";
import JellyButton from "../../components/ui/JellyButton";
import { FastPagination } from "../../components/common/FastPagination";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import {
  getBackendBranchId,
  resolveApiBranchId,
  resolveBranchFromList,
} from "../../utils/tenantScope";
import {
  configItemClassName as renderConfigItemClassName,
  configItemFamily as renderConfigItemFamily,
  configItemName as renderConfigItemName,
  configItemSectionName as renderConfigItemSectionName,
  resolveModulePeopleTypes,
  resolvePeopleRenderingModel,
} from "../../utils/templateRendering";
import {
  resolveTemplateFilters,
  resolveTemplateRenderingModel,
  type TemplateFilter,
} from "../../utils/templateColumns";
import { useStaffRecords } from "./hooks/useStaffRecords";
import VisitPlansTab, { type VisitPlansTabHandle } from "./VisitPlansTab";
import {
  getStaffRecord,
  setStaffDashboardScope,
  uploadStaffPhoto,
} from "./api/staffApi";
import { assignManager, setLinkedAccount } from "./api/hierarchyApi";
import { peopleCodeModel } from "./types/types";
import { ProfileDrawer } from "./components/ProfileDrawer";
import { ShiftAllocationTab } from "./components/ShiftAllocationTab";
import { StaffCredentialsModal } from "./components/StaffCredentialsModal";
import { StaffModal } from "./components/StaffModal";
import { StaffRow } from "./components/StaffRow";
import { StaffStats } from "./components/StaffStats";
import { type StaffFormData, type StaffMediaFiles } from "./types/staffForm";
import { type StaffDirectoryTab, type StaffMember } from "./types/staffTypes";
import {
  buildStaffCredentials,
  credentialsToUserRecord,
  type StaffLoginCredentials,
} from "./utils/staffCredentials";
import { backendUserId, toStaffMember } from "./utils/staffMapping";
import { buildStaffApiPayload } from "./utils/staffPayload";
import {
  resolveEffectiveShift,
  shiftText,
  staffTypeText,
} from "./utils/staffShifts";
import { STATUS_META } from "./utils/staffStatus";
import {
  columnSortKey,
  getColumnAlign,
  getPeopleTableColumns,
  staffColumnText,
  staffGridTemplate,
} from "./utils/staffTable";

// ─── Main component ───────────────────────────────────────────────────────────

const StaffDirectory: FC = () => {
  const { branchId: routeBranchId } = useParams<{ branchId?: string }>();
  const [searchParams] = useSearchParams();
  const {
    cfg,
    updateCfg,
    activeBranchId,
    organizationId,
    isOrgReady,
    organizationName,
  } = useOrg();

  const [selectedPeopleType, setSelectedPeopleType] = useState<string | null>(
    null,
  );

  // Scope priority (highest → lowest):
  //   1. routeBranchId — explicit route param (branch dashboard pages)
  //   2. activeBranchId — sidebar-selected branch (OrgConfigContext)
  //   3. undefined — global view (all branches, super admin)
  // Moved above the people-rendering models below: they need this branch
  // scope as an input to the module-entitlement lookup.
  const effectiveBranchId: number | undefined = routeBranchId
    ? Number(routeBranchId)
    : activeBranchId !== null
      ? activeBranchId
      : undefined;
  const isBranchDashboard = effectiveBranchId !== undefined;
  const isGlobalDashboard = !isBranchDashboard;

  // Support-owned entitlement: which people types the "employees" module
  // (this page) is enabled for, per branch (cfg.modulePeopleTypesByBranch,
  // edited from OrgDetail.tsx). Mirrors AttendanceView.tsx's own
  // resolveModulePeopleTypes("attendance", ...) call, keyed to this page's
  // module instead. branchId omitted (global dashboard) unions every
  // branch's entitlement, matching resolveModulePeopleTypes' documented
  // global-view behavior.
  const employeesPeopleTypeRestriction = useMemo(
    () =>
      resolveModulePeopleTypes(
        cfg as unknown as Record<string, unknown>,
        "employees",
        isGlobalDashboard ? null : effectiveBranchId,
      ),
    [cfg, isGlobalDashboard, effectiveBranchId],
  );

  const peopleModel = useMemo(
    () =>
      resolvePeopleRenderingModel(
        cfg as unknown as Record<string, unknown>,
        selectedPeopleType,
        employeesPeopleTypeRestriction,
      ),
    [cfg, selectedPeopleType, employeesPeopleTypeRestriction],
  );

  const templateColumnModel = useMemo(
    () =>
      resolveTemplateRenderingModel(
        cfg as unknown as Record<string, unknown>,
        peopleModel.peopleType,
        employeesPeopleTypeRestriction,
      ),
    [cfg, peopleModel.peopleType, employeesPeopleTypeRestriction],
  );

  const templateFilters = useMemo(
    () =>
      resolveTemplateFilters(
        cfg as unknown as Record<string, unknown>,
        peopleModel.peopleType,
        employeesPeopleTypeRestriction,
      ),
    [cfg, peopleModel.peopleType, employeesPeopleTypeRestriction],
  );

  const templateFilterByKey = useMemo(() => {
    const entries = templateFilters.map(
      (filter) => [filter.key, filter] as const,
    );
    return new Map<string, TemplateFilter>(entries);
  }, [templateFilters]);

  const groupFilterTemplate =
    templateFilterByKey.get("class") ?? templateFilterByKey.get("department");
  const subgroupFilterTemplate =
    templateFilterByKey.get("section") ??
    templateFilterByKey.get("designation");

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    StaffMember["status"] | "all"
  >("all");
  const [branchFilter, setBranchFilter] = useState<string | "all">("all");
  const [deptFilter, setDeptFilter] = useState<string | "all">("all");
  const [roleFilter, setRoleFilter] = useState<string | "all">("all");
  const [sortKey, setSortKey] = useState<keyof StaffMember>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [activeTab, setActiveTab] = useState<StaffDirectoryTab>("directory");
  const debouncedQuery = useDebouncedValue(query, 250);

  const peopleTableColumns = useMemo(
    () =>
      getPeopleTableColumns(
        templateColumnModel.peopleColumns,
        isGlobalDashboard,
        peopleModel.peopleType,
        cfg.modules,
      ),
    [
      cfg.modules,
      isGlobalDashboard,
      peopleModel.peopleType,
      templateColumnModel.peopleColumns,
    ],
  );
  const peopleTableGridTemplate = useMemo(
    () => staffGridTemplate(peopleTableColumns),
    [peopleTableColumns],
  );
  const visibleBranches = isBranchDashboard
    ? cfg.branches.filter((branch) => branch.id === effectiveBranchId)
    : cfg.branches;
  const selectedBranch = useMemo(
    () =>
      branchFilter === "all"
        ? null
        : resolveBranchFromList(cfg.branches, branchFilter),
    [branchFilter, cfg.branches],
  );
  const selectedBranchId = selectedBranch?.id ?? null;
  const selectedBackendBranchId = selectedBranch
    ? (getBackendBranchId(selectedBranch) ?? String(selectedBranch.id))
    : null;
  const serverBranchId = isBranchDashboard
    ? effectiveBranchId !== undefined
      ? String(effectiveBranchId)
      : null
    : branchFilter === "all"
      ? null
      : (selectedBackendBranchId ?? branchFilter);

  const {
    staff,
    archivedStaff,
    currentUserId,
    createStaff,
    updateStaff,
    assignShift,
    assignDepartment,
    archiveStaff,
    restoreStaff,
    deleteArchivedStaff,
    bulkDeleteArchivedStaff,
    refreshStaff,
    refreshArchivedStaff,
    isLoadingStaff,
    staffTotal,
    staffPage,
    staffPageSize,
    setStaffPage,
    setStaffPageSize,
  } = useStaffRecords({
    branchId: serverBranchId,
    search: debouncedQuery,
    sortBy: String(sortKey),
    sortDir,
    peopleType: peopleModel.peopleType,
    status: statusFilter,
    department: deptFilter,
    loadArchived: activeTab === "archived",
  });

  // Session's real user — used below purely to gate "add"/"delete" for a
  // 'team'-scoped manager (see `can()`). Not related to the staff records
  // above; useStaffRecords/useAuth are independent hooks.
  const { user } = useAuth();

  // Visit Plans tab has its own data source (visit_plans/visit_plan_stops/
  // visits) separate from useStaffRecords above, so the shared header
  // "Refresh" button needs an imperative handle into it rather than being
  // able to piggyback on refreshStaff/refreshArchivedStaff.
  const visitPlansRef = useRef<VisitPlansTabHandle>(null);

  useEffect(() => {
    setStaffPage(1);
  }, [
    debouncedQuery,
    serverBranchId,
    statusFilter,
    deptFilter,
    roleFilter,
    peopleModel.peopleType,
    setStaffPage,
  ]);

  // Real value only — never read `user.dashboardScope` (camelCase) here,
  // that's an unrelated branch/global dashboard-shell field that gets
  // hardcoded per role in AuthContext.normaliseUser and no longer reflects
  // what the backend sent. `dashboard_scope` (snake_case) is untouched and
  // is undefined for client_users/admin logins (they have no such column).
  const isTeamScopedManager =
    (user as { dashboard_scope?: string } | null)?.dashboard_scope === "team";

  // Who may toggle another person's admin access from this form — mirrors
  // the backend gate exactly (role_permissions.py / support_db_staff.py's
  // granted_by_is_admin check). There are only two account tiers now
  // (admin/staff — the old hr/manager/employee presets are gone, see
  // role_permissions.py), and only an existing admin session may grant
  // admin to someone else. Read straight off the session's own role
  // (client_users, always admin; or a client_staff row already promoted to
  // admin) — never inferred from isTeamScopedManager, which answers a
  // different question (row visibility, not the admin-grant privilege).
  const sessionRole = String((user as { role?: string } | null)?.role || "")
    .trim()
    .toLowerCase();
  const canGrantAdmin = sessionRole === "admin";

  // Mirrors the backend exactly (see app.py's api_add_staff and the
  // matching DELETE/archive routes): creating and archiving/offboarding
  // staff are HR/admin (or branch-scoped manager) actions — a
  // 'team'-scoped manager's session is rejected server-side for both, so
  // the UI must not offer either action. "edit" is intentionally NOT
  // gated here: a team-scoped manager's staff list (GET /api/staff) is
  // already narrowed to their own reporting chain, so every row they can
  // see is one they're allowed to edit.
  const can = (action: "add" | "edit" | "delete" | string): boolean => {
    if (isTeamScopedManager && (action === "add" || action === "delete")) {
      return false;
    }
    return true;
  };
  const highlightedStaffId = searchParams.get("highlight");
  const setTrainingOverlay = (_state: unknown): void => undefined;
  const trainingProgressForPhase = (_phase: string): number => 100;

  const [selectedArchived, setSelectedArchived] = useState<Set<string>>(
    new Set(),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refreshingPage, setRefreshingPage] = useState(false);
  const [viewMember, setViewMember] = useState<StaffMember | null>(null);
  const [overrideTargetStaffId, setOverrideTargetStaffId] =
    useState<string>("");
  const [editMember, setEditMember] = useState<StaffMember | null | "new">(
    null,
  );
  // Which row's Edit button is currently fetching fresh details (see
  // openEditModal below) — used to disable that row's button and avoid a
  // double-fetch, not to block the rest of the UI.
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  const [credentialPreview, setCredentialPreview] =
    useState<StaffLoginCredentials | null>(null);

  // cfg.staffShiftDefinitions is already normalized at the OrgConfigContext
  // storage boundary — no re-normalization needed here. "Custom" is
  // filtered out: it is no longer a company-wide shift (some orgs may still
  // have a legacy "custom" row saved from before this change) — it only
  // exists as a per-person override entered inline in the staff modal, and
  // must never appear in "Company Shift Timings" or in this dropdown as a
  // shared option.
  const shiftDefinitions = cfg.staffShiftDefinitions.filter(
    (shift) => shift.id !== "custom" && shift.label !== "Custom",
  );

  // Admin page starts from all staff. Branch dashboard is locked to the route branch.
  const scopedStaffItems = useMemo<StaffMember[]>(() => {
    const allStaffItems = staff.items.map(toStaffMember);

    if (isBranchDashboard && effectiveBranchId) {
      return allStaffItems.filter(
        (member) => member.branchId === effectiveBranchId,
      );
    }

    return allStaffItems;
  }, [effectiveBranchId, isBranchDashboard, staff.items]);

  const archivedStaffItems = useMemo<StaffMember[]>(() => {
    const allArchived = archivedStaff.map(toStaffMember);

    if (isBranchDashboard && effectiveBranchId) {
      return allArchived.filter(
        (member) => member.branchId === effectiveBranchId,
      );
    }

    return allArchived;
  }, [archivedStaff, effectiveBranchId, isBranchDashboard]);

  const branchScopedItems = useMemo(() => {
    if (
      !isGlobalDashboard ||
      branchFilter === "all" ||
      selectedBranchId == null
    )
      return scopedStaffItems;
    return scopedStaffItems.filter(
      (member) => member.branchId === selectedBranchId,
    );
  }, [branchFilter, isGlobalDashboard, scopedStaffItems, selectedBranchId]);

  const branchOptions = useMemo(
    () => [
      {
        value: "all",
        label: "All Branches",
        count: scopedStaffItems.length,
      },
      ...visibleBranches.map((branch) => ({
        value: getBackendBranchId(branch) ?? String(branch.id),
        label: branch.name,
        count: scopedStaffItems.filter(
          (member) => member.branchId === branch.id,
        ).length,
      })),
    ],
    [scopedStaffItems, visibleBranches],
  );

  const departmentOptions = useMemo(() => {
    const groupCounts = new Map<string, number>();

    branchScopedItems.forEach((member) => {
      const group = member.department || "Unassigned";
      groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
    });

    const sourceBranchIds =
      isGlobalDashboard && branchFilter === "all"
        ? visibleBranches.map((branch) => branch.id)
        : [
            isGlobalDashboard && branchFilter !== "all"
              ? branchFilter
              : effectiveBranchId,
          ].filter((id): id is number => typeof id === "number");

    const configuredGroupNames = sourceBranchIds.flatMap((branchId) => {
      const items = cfg.departments[branchId] ?? [];
      if (peopleModel.isStudent) {
        return items
          .filter((item) => renderConfigItemFamily(item) === "student")
          .map(renderConfigItemClassName)
          .filter((name) => Boolean(name.trim()));
      }
      return items
        .filter((item) => renderConfigItemFamily(item) === "workforce")
        .map(renderConfigItemName)
        .filter((name) => Boolean(name.trim()));
    });

    const groupNames = new Set<string>([
      ...configuredGroupNames,
      ...groupCounts.keys(),
    ]);

    return [
      {
        value: "all",
        label: peopleModel.groupFilterAllLabel,
        count: branchScopedItems.length,
      },
      ...Array.from(groupNames)
        .sort((a, b) => a.localeCompare(b))
        .map((group) => ({
          value: group,
          label: group,
          count: groupCounts.get(group) ?? 0,
        })),
    ];
  }, [
    branchFilter,
    branchScopedItems,
    cfg.departments,
    effectiveBranchId,
    isGlobalDashboard,
    peopleModel,
    visibleBranches,
  ]);

  const roleOptions = useMemo(() => {
    const roleCounts = new Map<string, number>();

    branchScopedItems.forEach((member) => {
      const role = member.role || "Unassigned";
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    });

    const sourceBranchIds =
      isGlobalDashboard && branchFilter === "all"
        ? visibleBranches.map((branch) => branch.id)
        : [
            isGlobalDashboard && branchFilter !== "all"
              ? branchFilter
              : effectiveBranchId,
          ].filter((id): id is number => typeof id === "number");

    const configuredRoleNames = sourceBranchIds.flatMap((branchId) => {
      if (peopleModel.isStudent) {
        return (cfg.departments[branchId] ?? [])
          .filter((item) => renderConfigItemFamily(item) === "student")
          .filter(
            (item) =>
              deptFilter === "all" ||
              renderConfigItemClassName(item) === String(deptFilter),
          )
          .map(renderConfigItemSectionName)
          .filter((name) => Boolean(name.trim()));
      }
      return (cfg.roles[branchId] ?? [])
        .filter((item) => renderConfigItemFamily(item) === "workforce")
        .map(renderConfigItemName)
        .filter((name) => Boolean(name.trim()));
    });

    const roleNames = new Set<string>([
      ...configuredRoleNames,
      ...roleCounts.keys(),
    ]);

    return [
      {
        value: "all",
        label: peopleModel.isStudent
          ? peopleModel.subgroupFilterAllLabel
          : `All ${peopleModel.rolePlural}`,
        count: branchScopedItems.length,
      },
      ...Array.from(roleNames)
        .sort((a, b) => a.localeCompare(b))
        .map((role) => ({
          value: role,
          label: role,
          count: roleCounts.get(role) ?? 0,
        })),
    ];
  }, [
    branchFilter,
    branchScopedItems,
    cfg.departments,
    cfg.roles,
    deptFilter,
    effectiveBranchId,
    isGlobalDashboard,
    peopleModel,
    visibleBranches,
  ]);

  const statusOptions = useMemo(
    () =>
      (["all", "active", "inactive", "pending"] as const).map((status) => ({
        value: status,
        label:
          status === "all"
            ? peopleModel.statusFilterAllLabel
            : STATUS_META[status].label,
        count:
          status === "all"
            ? branchScopedItems.length
            : branchScopedItems.filter((member) => member.status === status)
                .length,
      })),
    [branchScopedItems],
  );

  const sortOptions = useMemo(
    () =>
      peopleTableColumns
        .filter(
          (column) => column.sortable !== false && column.key !== "training",
        )
        .map((column) => ({
          value: String(columnSortKey(column)),
          label: column.label,
        })),
    [peopleTableColumns],
  );

  const sortDirectionOptions = useMemo(
    () => [
      { value: "asc", label: "Ascending", description: "A → Z / Low → High" },
      { value: "desc", label: "Descending", description: "Z → A / High → Low" },
    ],
    [],
  );

  const resetFilters = useCallback(() => {
    setQuery("");
    setStatusFilter("all");
    setBranchFilter("all");
    setDeptFilter("all");
    setRoleFilter("all");
    setSortKey("name");
    setSortDir("asc");
    setSelected(new Set());
  }, []);

  // branchName is the only lookup needed — stored as id on staff, name on branch config
  const branchName = useCallback(
    (id: number) =>
      cfg.branches.find((branch) => branch.id === Number(id))?.name ?? "—",
    [cfg.branches],
  );

  // ── Filtered + sorted list ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = scopedStaffItems;

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          (m.personCode ?? "").toLowerCase().includes(q) ||
          (m.registrationNumber ?? "").toLowerCase().includes(q) ||
          (m.employeeId ?? "").toLowerCase().includes(q) ||
          (m.phone ?? "").toLowerCase().includes(q) ||
          (m.department ?? "").toLowerCase().includes(q) ||
          (m.role ?? "").toLowerCase().includes(q) ||
          (m.branchName ?? "").toLowerCase().includes(q) ||
          staffTypeText(m).toLowerCase().includes(q) ||
          shiftText(m).toLowerCase().includes(q),
      );
    }

    if (statusFilter !== "all") {
      list = list.filter((m) => m.status === statusFilter);
    }

    if (
      isGlobalDashboard &&
      branchFilter !== "all" &&
      selectedBranchId != null
    ) {
      list = list.filter((m) => m.branchId === selectedBranchId);
    }

    if (deptFilter !== "all") {
      list = list.filter((m) => m.department === deptFilter);
    }

    if (roleFilter !== "all") {
      list = list.filter((m) => m.role === roleFilter);
    }

    return [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];

      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }

      return sortDir === "asc"
        ? String(av ?? "").localeCompare(String(bv ?? ""), undefined, {
            numeric: true,
            sensitivity: "base",
          })
        : String(bv ?? "").localeCompare(String(av ?? ""), undefined, {
            numeric: true,
            sensitivity: "base",
          });
    });
  }, [
    scopedStaffItems,
    query,
    statusFilter,
    isGlobalDashboard,
    branchFilter,
    deptFilter,
    roleFilter,
    sortKey,
    sortDir,
  ]);

  useEffect(() => {
    if (!highlightedStaffId) return;

    const frameId = requestAnimationFrame(() => {
      const row = document.getElementById(`staff-row-${highlightedStaffId}`);

      if (row) {
        row.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });

    return () => cancelAnimationFrame(frameId);
  }, [highlightedStaffId, filtered]);

  const staffFilterSections = useMemo<DynamicFilterSection[]>(
    () => [
      ...(templateFilterByKey.has("peopleType") &&
      peopleModel.hasMultiplePeopleTypes
        ? ([
            {
              id: "peopleType",
              type: "select",
              label:
                templateFilterByKey.get("peopleType")?.label ?? "People Type",
              value: peopleModel.peopleType,
              options: peopleModel.selectablePeopleTypes,
              minWidth: 180,
              onChange: (value: string) => {
                setSelectedPeopleType(value);
                setDeptFilter("all");
                setRoleFilter("all");
                setSelected(new Set());
              },
            },
          ] as DynamicFilterSection[])
        : []),
      {
        id: "branch",
        type: "select",
        label: templateFilterByKey.get("branchId")?.label ?? "Branch",
        hidden: !isGlobalDashboard,
        value: String(branchFilter),
        options: branchOptions,
        minWidth: 190,
        onChange: (value: string) => {
          setBranchFilter(value === "all" ? "all" : value);
          setDeptFilter("all");
          setSelected(new Set());
        },
      },
      {
        id: "department",
        type: "select",
        label: groupFilterTemplate?.label ?? peopleModel.groupLabel,
        hidden: !groupFilterTemplate,
        value: deptFilter,
        options: departmentOptions,
        minWidth: 210,
        onChange: (value: string) => {
          setDeptFilter(value as string | "all");
          setRoleFilter("all");
          setSelected(new Set());
        },
      },
      {
        id: "role",
        type: "select",
        label:
          subgroupFilterTemplate?.label ??
          (peopleModel.isStudent
            ? peopleModel.subgroupLabel
            : peopleModel.roleLabel),
        hidden: !subgroupFilterTemplate,
        value: roleFilter,
        options: roleOptions,
        minWidth: 190,
        onChange: (value: string) => {
          setRoleFilter(value as string | "all");
          setSelected(new Set());
        },
      },
      {
        id: "status",
        type: "select",
        label: templateFilterByKey.get("status")?.label ?? "Status",
        value: statusFilter,
        options: statusOptions,
        minWidth: 150,
        onChange: (value: string) => {
          setStatusFilter(value as StaffMember["status"] | "all");
          setSelected(new Set());
        },
      },
      {
        id: "sortBy",
        type: "select",
        label: "Sort By",
        value: String(sortKey),
        options: sortOptions,
        minWidth: 150,
        onChange: (value: string) => setSortKey(value as keyof StaffMember),
      },
      {
        id: "sortDirection",
        type: "select",
        label: "Sort Direction",
        value: sortDir,
        options: sortDirectionOptions,
        minWidth: 170,
        onChange: (value: string) => setSortDir(value as "asc" | "desc"),
      },
      {
        id: "search",
        type: "search",
        value: query,
        onChange: setQuery,
        placeholder:
          templateFilterByKey.get("search")?.placeholder ??
          peopleModel.searchPlaceholder,
        grow: true,
        minWidth: 280,
      },
      {
        id: "reset",
        type: "reset",
        label: "Clear",
        onClick: resetFilters,
      },
    ],
    [
      branchFilter,
      peopleModel,
      templateColumnModel.peopleTypeOptions,
      templateFilterByKey,
      groupFilterTemplate,
      subgroupFilterTemplate,
      branchOptions,
      departmentOptions,
      roleOptions,
      deptFilter,
      roleFilter,
      query,
      resetFilters,
      isGlobalDashboard,
      sortDir,
      sortDirectionOptions,
      sortKey,
      sortOptions,
      statusFilter,
      statusOptions,
    ],
  );

  const selectedBranchLabel = useMemo(() => {
    if (isBranchDashboard && effectiveBranchId)
      return branchName(effectiveBranchId);
    if (branchFilter === "all") return "All Branches";
    return selectedBranch?.name ?? branchName(Number(branchFilter));
  }, [
    branchFilter,
    branchName,
    effectiveBranchId,
    isBranchDashboard,
    selectedBranch,
  ]);

  const selectedDepartmentLabel =
    deptFilter === "all" ? peopleModel.groupFilterAllLabel : deptFilter;
  const selectedRoleLabel =
    roleFilter === "all"
      ? peopleModel.isStudent
        ? peopleModel.subgroupFilterAllLabel
        : `All ${peopleModel.rolePlural}`
      : roleFilter;
  const selectedStatusLabel =
    statusFilter === "all"
      ? peopleModel.statusFilterAllLabel
      : STATUS_META[statusFilter].label;

  const exportColumns = useMemo(
    () =>
      peopleTableColumns
        .filter(
          (column) =>
            column.exportable !== false &&
            String(column.key).toLowerCase() !== "branch",
        )
        .map((column) => ({
          header: column.label,
          accessor: (member: StaffMember) =>
            staffColumnText(member, column, branchName),
        })),
    [branchName, peopleTableColumns],
  );

  const exportOrganization = useMemo(
    () => ({
      name: organizationName || cfg.orgName || undefined,
      logoUrl: cfg.logo || undefined,
    }),
    [organizationName, cfg.orgName, cfg.logo],
  );

  const exportReportPeriod = useMemo(() => {
    const now = new Date();
    return `Report Date: ${now.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    })}`;
  }, []);

  const exportFilters = useMemo(
    () => ({
      module: peopleModel.exportModuleLabel,
      scope: isBranchDashboard ? "Branch Dashboard" : "Admin / All Branches",
      branch: selectedBranchLabel,
      [peopleModel.groupLabel.toLowerCase()]: selectedDepartmentLabel,
      [peopleModel.isStudent
        ? peopleModel.subgroupLabel.toLowerCase()
        : peopleModel.roleLabel.toLowerCase()]: selectedRoleLabel,
      status: selectedStatusLabel,
      search: query.trim() || "All",
      sort: `${String(sortKey)} ${sortDir}`,
      records: filtered.length,
    }),
    [
      deptFilter,
      filtered.length,
      isBranchDashboard,
      query,
      selectedBranchLabel,
      selectedDepartmentLabel,
      selectedRoleLabel,
      selectedStatusLabel,
      sortDir,
      sortKey,
    ],
  );

  const toggleSort = (key: keyof StaffMember) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // ── CRUD ──────────────────────────────────────────────────────────────────
  const upsertUserRecord = useCallback(
    (record: OrgUserRecord) => {
      const nextUsers = [
        ...cfg.users.filter(
          (user) => user.id !== record.id && user.staffId !== record.staffId,
        ),
        record,
      ];
      updateCfg({ users: nextUsers });
    },
    [cfg, updateCfg],
  );

  const updateExistingUserAccess = useCallback(
    (member: StaffMember, data: StaffFormData) => {
      const existingUser = cfg.users.find(
        (user) => user.id === member.userId || user.staffId === member.id,
      );
      if (!existingUser) return;

      const selectedBranch = cfg.branches.find(
        (branch) => branch.id === data.branchId,
      );
      const selectedBranchName = selectedBranch?.name ?? "";
      const now = new Date().toISOString();

      const nextRecord: OrgUserRecord = {
        ...existingUser,
        staffId: member.id,
        name: data.name,
        email: data.email ?? existingUser.email ?? "",
        status: data.status,
        branchId: data.branchId,
        branchName: selectedBranchName,
        staffType: data.staffType,
        allowedBranchIds: [data.branchId],
        allowedModules: data.moduleAccess,
        role: "staff",
        portalAccess: {
          desktopDashboard: true,
          flutterStaffPortal: true,
        },
        dashboardScope: "branch",
        updatedAt: now,
      };

      upsertUserRecord(nextRecord);
    },
    [cfg, upsertUserRecord],
  );

  // ── CRUD ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(
    async (data: StaffFormData, files?: StaffMediaFiles) => {
      const shift = resolveEffectiveShift(shiftDefinitions, data);
      const selectedBranch = cfg.branches.find(
        (branch) => branch.id === data.branchId,
      );
      const selectedBranchName = selectedBranch?.name ?? "";
      // /api/staff (create/update) tolerates a UI ordinal id as a fallback
      // (support_db._resolve_client_branch is dual-capable), unlike the
      // shift/department endpoints — but resolve the real UUID first
      // regardless, via the one canonical resolver, rather than keeping a
      // second, divergent fallback chain here.
      const selectedBackendBranchId =
        resolveApiBranchId(organizationId, data.branchId, cfg.branches) ??
        data.branchId;
      const now = new Date().toISOString();
      const hasProfileImage = Boolean(files?.profileImageFile);

      try {
        if (!organizationId) {
          throw new Error(
            "Organization is not loaded yet. Please refresh the dashboard after login and try again.",
          );
        }

        if (editMember && editMember !== "new") {
          const userId = backendUserId(editMember);

          if (!userId) {
            throw new Error(
              "This staff record is missing a valid backend user id.",
            );
          }

          const updatedStaff = (await updateStaff(
            userId,
            buildStaffApiPayload(
              data,
              organizationId,
              selectedBranchName,
              selectedBackendBranchId,
              shift,
              currentUserId,
              undefined,
              peopleModel.peopleType,
            ),
          )) as unknown as StaffMember;

          if (files?.profileImageFile) {
            setTrainingOverlay({
              open: true,
              title: "Uploading profile photo",
              employeeName: data.name,
              phase: "Saving profile photo to the backend...",
              currentPhase: "photo",
              progressPercent: trainingProgressForPhase("photo"),
            });
            await uploadStaffPhoto(userId, files.profileImageFile);
          }

          updateExistingUserAccess(
            updatedStaff ??
              ({
                ...editMember,
                ...data,
                branchName: selectedBranchName,
                position: data.role,
                shift: shift.id,
                shiftId: shift.id,
                shiftLabel: shift.label,
                shiftStart: shift.start,
                shiftEnd: shift.end,
                accessModules: data.moduleAccess,
                benefits: data.benefits,
                updatedAt: now,
                // `data` (StaffFormData) keeps these as raw input strings
                // so the lat/lng/radius text fields can be typed into
                // freely; StaffMember stores them as number | null. The
                // spread above pulls in the string versions, so they need
                // to be re-parsed here rather than left as-is.
                geofenceLat: data.geofenceLat.trim()
                  ? Number(data.geofenceLat)
                  : null,
                geofenceLng: data.geofenceLng.trim()
                  ? Number(data.geofenceLng)
                  : null,
                geofenceRadiusMeters: data.geofenceRadiusMeters.trim()
                  ? Number(data.geofenceRadiusMeters)
                  : null,
              } as StaffMember),
            data,
          );

          await refreshStaff?.();
        } else {
          const overlayTitle = "Creating profile";

          if (hasProfileImage) {
            setTrainingOverlay({
              open: true,
              title: overlayTitle,
              employeeName: data.name,
              phase: "Creating profile...",
              currentPhase: "profile",
              progressPercent: trainingProgressForPhase("profile"),
            });
          }

          const result = await createStaff(
            buildStaffApiPayload(
              data,
              organizationId,
              selectedBranchName,
              selectedBackendBranchId,
              shift,
              currentUserId,
              // No client-generated password: buildStaffApiPayload only
              // spreads `password` into the request when it's truthy, so
              // leaving this undefined means the backend always mints the
              // credential itself (secrets.choice-based, not Math.random)
              // instead of the frontend's weaker one winning.
              undefined,
              peopleModel.peopleType,
            ),
            files,
            {
              onProgress: () => undefined,
            },
          );

          if (result.mediaErrors.length > 0) {
            const mediaIssueText = result.mediaErrors
              .map((item) => `• ${item.phase}: ${item.message}`)
              .join("\n");

            setTrainingOverlay({
              open: true,
              title: "Profile created, media needs attention",
              employeeName: data.name,
              phase: "",
              currentPhase: "failed",
              progressPercent: 100,
              error: mediaIssueText,
            });

            alert(
              `Staff created, but profile media sync had issues:\n\n${mediaIssueText}`,
            );
          }

          // The shift dropdown in the create form can't PATCH a staff_id
          // that doesn't exist yet — apply it now that createStaff has
          // returned the real backend user id. Reuses the exact same
          // assignShift() endpoint the edit-mode dropdown already calls
          // (support_db_shifts.assign_staff_shift), so there is exactly
          // one code path that ever assigns a shift. Non-fatal: the staff
          // record itself was already created successfully.
          if (data.liveShiftId) {
            try {
              await assignShift(result.user.id, data.liveShiftId);
            } catch (shiftAssignError) {
              alert(
                `Staff created, but assigning the selected shift failed: ` +
                  `${
                    shiftAssignError instanceof Error
                      ? shiftAssignError.message
                      : "Unknown error"
                  }\n\nYou can assign it again by editing this staff member ` +
                  `or from the Shift Allocation tab.`,
              );
            }
          }

          // Reporting Hierarchy — same reasoning as the shift assignment
          // just above: the Add modal's manager/linked-account/visibility
          // pickers can't PATCH a staff_id that didn't exist yet, so those
          // choices were only staged on `data`. Apply them now that
          // createStaff has returned the real backend id. Each call is
          // independent and non-fatal — the staff record itself is already
          // created, so a failure here should never look like the whole
          // save failed; it just means that one setting needs to be
          // re-applied from the Edit modal.
          const hierarchyIssues: string[] = [];

          if (data.managerId) {
            try {
              await assignManager(
                organizationId,
                String(result.user.id),
                data.managerId || null,
              );
            } catch (managerAssignError) {
              hierarchyIssues.push(
                `Manager: ${
                  managerAssignError instanceof Error
                    ? managerAssignError.message
                    : "Unknown error"
                }`,
              );
            }
          }

          if (data.linkedClientUserId) {
            try {
              await setLinkedAccount(
                organizationId,
                String(result.user.id),
                data.linkedClientUserId || null,
              );
            } catch (linkedAccountError) {
              hierarchyIssues.push(
                `Linked dashboard account: ${
                  linkedAccountError instanceof Error
                    ? linkedAccountError.message
                    : "Unknown error"
                }`,
              );
            }
          }

          if (data.dashboardScope && data.dashboardScope !== "branch") {
            try {
              await setStaffDashboardScope(
                String(result.user.id),
                organizationId,
                data.dashboardScope,
              );
            } catch (scopeError) {
              hierarchyIssues.push(
                `Dashboard visibility: ${
                  scopeError instanceof Error
                    ? scopeError.message
                    : "Unknown error"
                }`,
              );
            }
          }

          if (hierarchyIssues.length > 0) {
            alert(
              `Staff created, but some Reporting Hierarchy settings failed ` +
                `to apply:\n\n${hierarchyIssues.join(
                  "\n",
                )}\n\nYou can set these again by editing this staff member.`,
            );
          }

          const generatedCredentials = buildStaffCredentials(
            data,
            String(result.user.id),
            String(result.user.id),
            selectedBranchName,
          );

          if (!result.credentials?.password) {
            // Should never happen — api_add_staff always returns a
            // generated password when none was sent — but surfacing this
            // loudly beats silently showing an empty password field.
            throw new Error(
              "Server did not return a generated password for this account.",
            );
          }

          const credentials: StaffLoginCredentials = {
            ...generatedCredentials,
            username:
              result.credentials?.email?.trim() ||
              generatedCredentials.username,
            password: result.credentials.password,
            createdAt: result.user.created_at ?? now,
          };

          upsertUserRecord(credentialsToUserRecord(credentials, data.status));
          setCredentialPreview(credentials);
        }

        setEditMember(null);
        try {
          // Notify other pages (e.g. Branches) that org data changed so they
          // can refresh derived summaries immediately.
          window.dispatchEvent(new Event("orgDataChanged"));
        } catch {
          // ignore environments where window is not present
        }

        toastSuccess(
          editMember && editMember !== "new"
            ? "Record updated successfully."
            : "Record added successfully.",
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to save staff member. Please try again.";

        if (hasProfileImage) {
          setTrainingOverlay({
            open: true,
            title: "Save failed",
            employeeName: data.name,
            phase: "",
            currentPhase: "failed",
            progressPercent: 100,
            error: message,
          });
        }

        const lower = message.toLowerCase();

        if (lower.includes("already") || lower.includes("exists")) {
          alert(
            `${message}\n\nIf this employee was archived, open the Archived Employees tab and click Restore instead of creating a duplicate.`,
          );
          return;
        }

        alert(message);
      }
    },
    [
      editMember,
      cfg.branches,
      shiftDefinitions,
      updateExistingUserAccess,
      upsertUserRecord,
      organizationId,
      currentUserId,
      createStaff,
      updateStaff,
      assignShift,
      assignManager,
      setLinkedAccount,
      refreshStaff,
    ],
  );

  // Row and Profile-Drawer "Edit" both funnel through here. `member` is
  // built from the fast paginated list (/api/v2/staff/page), which is
  // optimized for table display and doesn't select every column — WiFi
  // SSID/BSSIDs, reporting-hierarchy fields, geofence, and CNIC/guardian
  // details can be configured and saved correctly yet still come back
  // blank here simply because the fast list never fetched them. Re-fetch
  // the single full record (GET /api/staff/<id>, which does return every
  // field) before opening the modal so it always shows what's actually
  // saved. Falls back to the row's cached data if the re-fetch fails, so
  // Edit still opens rather than being blocked entirely.
  const openEditModal = useCallback(async (member: StaffMember) => {
    setViewMember(null);

    const userId = backendUserId(member);
    if (!userId) {
      setEditMember(member);
      return;
    }

    setPendingEditId(member.id);
    try {
      const fresh = await getStaffRecord(userId);
      setEditMember(toStaffMember(fresh as unknown as ModuleStaffMember));
    } catch (error) {
      setEditMember(member);
      toastError(
        error instanceof Error
          ? `Couldn't refresh the latest details (${error.message}) — showing cached data.`
          : "Couldn't refresh the latest details; showing cached data.",
      );
    } finally {
      setPendingEditId(null);
    }
  }, []);

  const handleDelete = async (id: string) => {
    const removedMember = staff.items
      .map(toStaffMember)
      .find((member) => member.id === id);

    const userId = removedMember ? backendUserId(removedMember) : null;
    const employeeName = removedMember?.name ?? "this employee";

    const confirmed = await confirmDialog({
      title: `Archive ${employeeName}?`,
      text: "This will remove the record from the active directory and disable local attendance recognition for this person.",
      icon: "warning",
      confirmButtonText: "Archive",
      cancelButtonText: "Cancel",
    });

    if (!confirmed.isConfirmed) return;

    try {
      if (userId) {
        await archiveStaff(userId, id, {
          reason: "Archived from Staff Management",
        });
      } else {
        staff.remove(id);
      }

      if (removedMember) {
        const remainingUsers = cfg.users.filter(
          (user) =>
            user.staffId !== removedMember.id &&
            user.id !== removedMember.userId,
        );
        updateCfg({ users: remainingUsers });
      }

      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });

      setViewMember(null);

      toastSuccess("Record archived successfully.");
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : "Failed to archive staff member. Please try again.",
      );
    }
  };

  const handleRestore = async (member: StaffMember) => {
    const userId = backendUserId(member);

    if (!userId) {
      toastError("This archived employee is missing a valid backend user id.");
      return;
    }

    const confirmed = await confirmDialog({
      title: `Restore ${member.name}?`,
      text: "This will return the employee to the active Staff Directory.\n\nBiometric embeddings were deleted during archive, so the employee must be trained again before live attendance recognition works.",
      icon: "warning",
      confirmButtonText: "Restore",
      cancelButtonText: "Cancel",
    });

    if (!confirmed.isConfirmed) return;

    try {
      await restoreStaff(userId, {
        organizationId,
        restoredBy: currentUserId,
      });

      await refreshStaff?.();
      await refreshArchivedStaff?.();
      setSelectedArchived((previous) => {
        const next = new Set(previous);
        next.delete(member.id);
        return next;
      });

      toastSuccess("Record restored successfully.");
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : "Failed to restore archived employee.",
      );
    }
  };

  const handlePermanentDeleteArchived = async (member: StaffMember) => {
    const userId = backendUserId(member);

    if (!userId) {
      toastError("This archived employee is missing a valid backend user id.");
      return;
    }

    const confirmed = await confirmDialog({
      title: `Permanently delete ${member.name}?`,
      text: "This will delete the archived employee's HR profile, salary config, attendance logs, leave/overtime records, profile photo, and remaining biometric data from the database.\n\nThis cannot be undone.",
      icon: "warning",
      confirmButtonText: "Delete Permanently",
      cancelButtonText: "Cancel",
    });

    if (!confirmed.isConfirmed) return;

    try {
      await deleteArchivedStaff(userId);
      setSelectedArchived((previous) => {
        const next = new Set(previous);
        next.delete(member.id);
        return next;
      });

      const remainingUsers = cfg.users.filter(
        (user) => user.staffId !== member.id && user.id !== member.userId,
      );
      updateCfg({ users: remainingUsers });

      await refreshArchivedStaff?.();

      toastSuccess("Record deleted permanently.");
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : "Failed to permanently delete archived employee.",
      );
    }
  };

  const handleBulkPermanentDeleteArchived = async () => {
    const selectedMembers = archivedStaffItems.filter((member) =>
      selectedArchived.has(member.id),
    );

    if (selectedMembers.length === 0) {
      toastInfo("Select archived employees first.");
      return;
    }

    const confirmed = await confirmDialog({
      title: `Permanently delete ${selectedMembers.length} archived employee${
        selectedMembers.length === 1 ? "" : "s"
      }?`,
      text: "This will remove their archived HR profiles and linked records from the database. This cannot be undone.",
      icon: "warning",
      confirmButtonText: "Delete Permanently",
      cancelButtonText: "Cancel",
    });

    if (!confirmed.isConfirmed) return;

    try {
      const userIds = selectedMembers
        .map((member) => backendUserId(member))
        .filter((id): id is number | string => Boolean(id));

      const result = await bulkDeleteArchivedStaff(userIds);
      const deletedIds = new Set(
        (result.deleted_user_ids ?? userIds).map((id: number | string) =>
          String(id),
        ),
      );

      const remainingUsers = cfg.users.filter((user) => {
        const matchedArchivedMember = selectedMembers.find(
          (member) => user.staffId === member.id || user.id === member.userId,
        );

        if (!matchedArchivedMember) return true;

        const matchedUserId = backendUserId(matchedArchivedMember);
        return matchedUserId ? !deletedIds.has(String(matchedUserId)) : false;
      });

      updateCfg({ users: remainingUsers });
      setSelectedArchived(new Set());
      await refreshArchivedStaff?.();

      toastSuccess(
        `Deleted ${result.deleted_count ?? deletedIds.size} archived employee${
          (result.deleted_count ?? deletedIds.size) === 1 ? "" : "s"
        } permanently.`,
      );
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : "Failed to permanently delete selected archived employees.",
      );
    }
  };

  const toggleArchivedSelection = (memberId: string) => {
    setSelectedArchived((previous) => {
      const next = new Set(previous);
      if (next.has(memberId)) {
        next.delete(memberId);
      } else {
        next.add(memberId);
      }
      return next;
    });
  };

  const selectAllArchived = () => {
    setSelectedArchived(new Set(archivedStaffItems.map((member) => member.id)));
  };

  const clearArchivedSelection = () => {
    setSelectedArchived(new Set());
  };

  const applyShift = useCallback(
    async (target: {
      scope: "branch" | "department" | "individual";
      branchId: number;
      department?: string;
      staffId?: string;
      shiftId: string;
    }) => {
      const targetMembers = scopedStaffItems.filter((member) => {
        if (member.branchId !== target.branchId) return false;
        if (target.scope === "individual") return member.id === target.staffId;
        if (target.scope === "department") {
          return !!target.department && member.department === target.department;
        }
        return isGlobalDashboard;
      });

      if (targetMembers.length === 0) return;

      // Each assignment is a real PATCH /api/client/staff/:id/shift against
      // the shifts table (see support_db_shifts.assign_staff_shift) — no
      // local-only mutation. assignShift already patches the ModuleContext
      // record on success, so a re-render reflects it without a page
      // refresh, and — unlike the old staff.update() path — a page refresh
      // reflects it too, because it was actually persisted.
      const results = await Promise.allSettled(
        targetMembers.map((member) =>
          assignShift(member.userId, target.shiftId || null),
        ),
      );

      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      if (failures.length > 0) {
        throw new Error(
          failures.length === targetMembers.length
            ? `Failed to assign shift for all ${targetMembers.length} staff member(s).`
            : `Assigned shift for ${targetMembers.length - failures.length} of ${targetMembers.length} staff member(s); ${failures.length} failed.`,
        );
      }
    },
    [isGlobalDashboard, scopedStaffItems, assignShift],
  );

  const SortIcon = ({ k }: { k: keyof StaffMember }) =>
    sortKey === k ? (
      sortDir === "asc" ? (
        <ChevronUp size={11} />
      ) : (
        <ChevronDown size={11} />
      )
    ) : null;

  // Table header columns — "department" is the correct keyof StaffMember
  const tabItems = useMemo<
    Array<{ key: StaffDirectoryTab; label: string; Icon: React.ElementType }>
  >(
    () => [
      { key: "directory", label: peopleModel.directoryTitle, Icon: Users },
      ...(peopleModel.showShiftAllocation
        ? ([
            { key: "shifts", label: "Shift Allocation", Icon: CalendarClock },
          ] as Array<{
            key: StaffDirectoryTab;
            label: string;
            Icon: React.ElementType;
          }>)
        : []),
      ...(scopedStaffItems.some((s) => s.staffType === "field")
        ? ([{ key: "visits", label: "Visit Plans", Icon: MapPin }] as Array<{
            key: StaffDirectoryTab;
            label: string;
            Icon: React.ElementType;
          }>)
        : []),
      {
        key: "archived",
        label: peopleModel.archivedPluralLabel,
        Icon: ArchiveRestore,
      },
    ],
    [
      peopleModel.archivedPluralLabel,
      peopleModel.directoryTitle,
      peopleModel.showShiftAllocation,
      scopedStaffItems,
    ],
  );

  const headerCols = peopleTableColumns;

  return (
    <div
      style={{
        background: "#f5f6fa",
        minHeight: "100vh",
        padding: "24px 24px 48px",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      <ModuleShell
        title={peopleModel.directoryTitle}
        Icon={Users}
        total={activeTab === "directory" ? staffTotal : filtered.length}
        stats={
          <StaffStats
            staff={scopedStaffItems}
            peopleModel={peopleModel}
            purchasedModules={cfg.modules}
          />
        }
        actions={
          <>
            {selected.size > 0 && (
              <span style={{ fontSize: 12, color: T.teal600, fontWeight: 600 }}>
                {selected.size} selected
              </span>
            )}
            <ExportButton
              data={filtered}
              filename={`${peopleModel.exportFilenamePrefix}_${selectedBranchLabel}_${selectedDepartmentLabel}_${selectedRoleLabel}_${selectedStatusLabel}`}
              organization={exportOrganization}
              csv={{
                columns: exportColumns,
                filters: exportFilters,
                includeFilterMeta: true,
              }}
              pdf={{
                title: `${peopleModel.exportModuleLabel} Report`,
                reportPeriod: exportReportPeriod,
                summary: [
                  { label: "Total Records", value: String(filtered.length) },
                  { label: "Branch", value: selectedBranchLabel },
                  { label: "Status", value: selectedStatusLabel },
                ],
                columns: exportColumns,
              }}
              emptyMessage={peopleModel.exportEmptyMessage}
              style={{
                background: T.card,
                border: `1px solid ${T.border}`,
                color: T.head,
                boxShadow:
                  "0 1px 3px rgba(15,45,74,0.06),0 1px 2px rgba(15,45,74,0.04)",
              }}
            />
            <RefreshButton
              variant="secondary"
              size="md"
              loading={refreshingPage}
              onClick={async () => {
                if (refreshingPage) return;
                setRefreshingPage(true);
                try {
                  if (activeTab === "archived") {
                    await refreshArchivedStaff?.();
                  } else if (activeTab === "visits") {
                    await visitPlansRef.current?.refresh();
                  } else {
                    await refreshStaff?.();
                  }
                } finally {
                  setRefreshingPage(false);
                }
              }}
              ariaLabel="Refresh staff list"
            />
            {can("add") && (
              <JellyButton
                type="button"
                variant="primary"
                leftIcon={<Plus size={14} />}
                onClick={() => setEditMember("new")}
              >
                {peopleModel.addButtonLabel}
              </JellyButton>
            )}
          </>
        }
      >
        <div
          style={{
            display: "flex",
            gap: 4,
            background: T.slate50,
            border: `1px solid ${T.border}`,
            borderRadius: 14,
            padding: 4,
            marginBottom: 16,
            width: "fit-content",
          }}
        >
          {tabItems.map((tab) => (
            <JellyButton
              key={tab.key}
              type="button"
              variant={activeTab === tab.key ? "primary" : "ghost"}
              size="sm"
              leftIcon={<tab.Icon size={13} />}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </JellyButton>
          ))}
        </div>

        {activeTab === "directory" && (
          <>
            <DynamicFilterToolbar
              sections={staffFilterSections}
              bordered
              style={{
                width: "100%",
                marginBottom: 16,
                padding: 16,
              }}
            />

            {filtered.length === 0 ? (
              <EmptyState
                Icon={Users}
                title={peopleModel.emptyTitle}
                sub={
                  query
                    ? "Try adjusting your search or filters"
                    : peopleModel.emptySubtitle
                }
                action={
                  can("add")
                    ? {
                        label: peopleModel.addRecordLabel,
                        onClick: () => setEditMember("new"),
                      }
                    : undefined
                }
              />
            ) : (
              <div
                style={{
                  background: T.card,
                  border: `1px solid ${T.border}`,
                  borderRadius: 12,
                  overflow: "hidden",
                }}
              >
                {/* Table header */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: peopleTableGridTemplate,
                    gap: 12,
                    padding: "10px 16px",
                    background: T.teal50,
                    borderBottom: `1px solid ${T.border}`,
                  }}
                >
                  {headerCols.map((column) => {
                    const align = getColumnAlign(column);
                    return (
                      <div
                        key={column.key}
                        onClick={() =>
                          column.sortable !== false &&
                          toggleSort(columnSortKey(column))
                        }
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          color: T.muted,
                          textTransform: "uppercase",
                          letterSpacing: ".07em",
                          cursor:
                            column.sortable !== false ? "pointer" : "default",
                          display: "flex",
                          alignItems: "center",
                          justifyContent:
                            align === "right"
                              ? "flex-end"
                              : align === "center"
                                ? "center"
                                : "flex-start",
                          gap: 4,
                          userSelect: "none",
                          width: "100%",
                          // Mirrors the padding rule in StaffRow.renderCell so a
                          // header label lines up with its column's values
                          // pixel-for-pixel, not just by CSS justify-content.
                          paddingLeft:
                            align === "center" ? 8 : align === "left" ? 4 : 0,
                          paddingRight:
                            align === "center" || align === "right" ? 8 : 0,
                        }}
                      >
                        {column.label}
                        {column.sortable !== false && (
                          <SortIcon k={columnSortKey(column)} />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Rows */}
                {filtered.map((member) => (
                  <StaffRow
                    key={member.id}
                    domId={`staff-row-${member.userId || member.id}`}
                    member={member}
                    onView={() => setViewMember(member)}
                    onEdit={() => {
                      void openEditModal(member);
                    }}
                    editLoading={pendingEditId === member.id}
                    onDelete={() => handleDelete(member.id)}
                    onOverride={() => {
                      setActiveTab("shifts");
                      setOverrideTargetStaffId(member.id);
                    }}
                    canDelete={can("delete")}
                    branchName={branchName}
                    peopleModel={peopleModel}
                    columns={peopleTableColumns}
                    gridTemplateColumns={peopleTableGridTemplate}
                    highlighted={
                      Boolean(highlightedStaffId) &&
                      (String(member.userId) === highlightedStaffId ||
                        String(member.id) === highlightedStaffId)
                    }
                  />
                ))}
              </div>
            )}

            <FastPagination
              page={staffPage}
              pageSize={staffPageSize}
              total={staffTotal}
              onPageChange={setStaffPage}
              onPageSizeChange={setStaffPageSize}
              disabled={isLoadingStaff}
            />
          </>
        )}

        {peopleModel.showShiftAllocation && activeTab === "shifts" && (
          <ShiftAllocationTab
            staffRows={scopedStaffItems}
            visibleBranches={visibleBranches}
            departmentsByBranch={cfg.departments}
            organizationId={organizationId}
            branchName={branchName}
            isGlobalDashboard={isGlobalDashboard}
            effectiveBranchId={effectiveBranchId}
            peopleModel={peopleModel}
            onApplyShift={applyShift}
            overrideStaffId={overrideTargetStaffId}
          />
        )}
        {activeTab === "visits" && (
          <VisitPlansTab
            ref={visitPlansRef}
            staffRows={scopedStaffItems.map((s) => ({
              id: s.id,
              name: s.name,
              branchId: s.branchId,
              branchName: s.branchName,
              staffType: s.staffType,
            }))}
            visibleBranches={visibleBranches}
            organizationId={organizationId}
            effectiveBranchId={effectiveBranchId}
            currentAdminId={
              (user as { id?: string | number } | null)?.id?.toString() ?? null
            }
          />
        )}

        {activeTab === "archived" && (
          <div
            style={{
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "14px 18px",
                borderBottom: `1px solid ${T.border}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 14,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 900, color: T.head }}>
                  Archived Employees
                </div>
                <div style={{ fontSize: 12, color: T.muted, marginTop: 3 }}>
                  HR records retained by policy. Biometrics were deleted at
                  archive time. Use permanent delete only when you intentionally
                  want to remove archived data from the database.
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  disabled={archivedStaffItems.length === 0}
                  onClick={selectAllArchived}
                  style={{
                    border: `1px solid ${T.teal200}`,
                    background: T.teal50,
                    color: T.teal700,
                    borderRadius: 8,
                    padding: "8px 10px",
                    cursor:
                      archivedStaffItems.length === 0
                        ? "not-allowed"
                        : "pointer",
                    fontSize: 12,
                    fontWeight: 900,
                    fontFamily: "inherit",
                    opacity: archivedStaffItems.length === 0 ? 0.55 : 1,
                  }}
                >
                  Select All
                </button>

                <button
                  type="button"
                  disabled={selectedArchived.size === 0}
                  onClick={clearArchivedSelection}
                  style={{
                    border: `1px solid ${T.border}`,
                    background: T.card,
                    color: T.muted,
                    borderRadius: 8,
                    padding: "8px 10px",
                    cursor:
                      selectedArchived.size === 0 ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 900,
                    fontFamily: "inherit",
                    opacity: selectedArchived.size === 0 ? 0.55 : 1,
                  }}
                >
                  Clear
                </button>

                <button
                  type="button"
                  disabled={selectedArchived.size === 0}
                  onClick={handleBulkPermanentDeleteArchived}
                  style={{
                    border: "none",
                    background:
                      selectedArchived.size === 0 ? T.slate50 : "#e11d48",
                    color: selectedArchived.size === 0 ? T.muted : "#fff",
                    borderRadius: 8,
                    padding: "8px 12px",
                    cursor:
                      selectedArchived.size === 0 ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 900,
                    fontFamily: "inherit",
                  }}
                >
                  Bulk Delete
                  {selectedArchived.size > 0
                    ? ` (${selectedArchived.size})`
                    : ""}
                </button>

                <RefreshButton
                  variant="ghost"
                  size="md"
                  loading={false}
                  onClick={async () => {
                    await refreshArchivedStaff?.();
                  }}
                  ariaLabel="Refresh archived staff"
                />
              </div>
            </div>

            {archivedStaffItems.length === 0 ? (
              <EmptyState
                Icon={ArchiveRestore}
                title="No archived employees"
                sub="Archived employees will appear here until their retention period expires."
              />
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "36px 1.4fr 1.1fr 1fr 1fr .9fr 1fr 210px",
                    gap: 12,
                    padding: "10px 16px",
                    background: T.teal50,
                    borderBottom: `1px solid ${T.border}`,
                    fontSize: 10,
                    fontWeight: 800,
                    color: T.muted,
                    textTransform: "uppercase",
                    letterSpacing: ".07em",
                    alignItems: "center",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={
                      archivedStaffItems.length > 0 &&
                      selectedArchived.size === archivedStaffItems.length
                    }
                    onChange={(event) => {
                      if (event.target.checked) {
                        selectAllArchived();
                      } else {
                        clearArchivedSelection();
                      }
                    }}
                    style={{ cursor: "pointer", accentColor: T.teal600 }}
                  />
                  <div>Name</div>
                  <div>{peopleCodeModel(peopleModel.peopleType).label}</div>
                  <div>Branch</div>
                  <div>Department</div>
                  <div>Status</div>
                  <div>Biometrics</div>
                  <div>Actions</div>
                </div>

                {archivedStaffItems.map((member) => {
                  const isSelected = selectedArchived.has(member.id);

                  return (
                    <div
                      key={member.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "36px 1.4fr 1.1fr 1fr 1fr .9fr 1fr 210px",
                        gap: 12,
                        padding: "12px 16px",
                        borderBottom: `1px solid ${T.teal50}`,
                        alignItems: "center",
                        fontSize: 12,
                        background: isSelected ? T.teal50 : "transparent",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleArchivedSelection(member.id)}
                        style={{ cursor: "pointer", accentColor: T.teal600 }}
                      />

                      <div>
                        <strong style={{ color: T.head }}>{member.name}</strong>
                        <div style={{ fontSize: 11, color: T.muted }}>
                          {member.personCode || member.employeeId || "—"}
                        </div>
                      </div>

                      <div style={{ color: T.muted }}>
                        {member.personCode || member.employeeId || "—"}
                      </div>

                      <div style={{ color: T.navy600, fontWeight: 700 }}>
                        {branchName(member.branchId)}
                      </div>

                      <div style={{ color: T.head }}>
                        {member.department || "—"}
                      </div>

                      <div style={{ color: T.amber, fontWeight: 800 }}>
                        Archived
                      </div>

                      <div style={{ color: "#e11d48", fontWeight: 800 }}>
                        Import Required
                      </div>

                      <div
                        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                      >
                        <button
                          type="button"
                          onClick={() => handleRestore(member)}
                          style={{
                            border: `1px solid ${T.teal200}`,
                            background: T.teal50,
                            color: T.teal700,
                            borderRadius: 8,
                            padding: "7px 10px",
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: 900,
                            fontFamily: "inherit",
                          }}
                        >
                          Restore
                        </button>

                        <button
                          type="button"
                          onClick={() => handlePermanentDeleteArchived(member)}
                          style={{
                            border: "1px solid #fecdd3",
                            background: "#fff1f2",
                            color: "#e11d48",
                            borderRadius: 8,
                            padding: "7px 10px",
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: 900,
                            fontFamily: "inherit",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </ModuleShell>

      {/* Profile Drawer */}
      {viewMember && (
        <ProfileDrawer
          member={viewMember}
          onClose={() => setViewMember(null)}
          onEdit={() => {
            void openEditModal(viewMember);
          }}
          onDelete={() => handleDelete(viewMember.id)}
          canDelete={can("delete")}
          branchName={branchName}
          peopleModel={peopleModel}
        />
      )}

      {/* Add / Edit Modal */}
      {editMember !== null && (
        <StaffModal
          initial={editMember === "new" ? undefined : editMember}
          onSave={handleSave}
          onClose={() => setEditMember(null)}
          scope={isBranchDashboard ? "branch" : "global"}
          branchId={effectiveBranchId}
          shiftDefinitions={shiftDefinitions}
          peopleModel={peopleModel}
          templateFormFields={templateColumnModel.formFields}
          onAssignShift={assignShift}
          onAssignDepartment={assignDepartment}
          onHierarchyChanged={() => refreshStaff().then(() => undefined)}
          canGrantAdmin={canGrantAdmin}
        />
      )}

      {credentialPreview && (
        <StaffCredentialsModal
          credentials={credentialPreview}
          onClose={() => setCredentialPreview(null)}
        />
      )}
    </div>
  );
};

export default StaffDirectory;
