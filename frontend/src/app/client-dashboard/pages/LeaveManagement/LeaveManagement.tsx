/**
 * src/modules/leave/LeaveManagement.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Leave management dashboard with request approval workflow.
 *
 * Data flow:
 *   useLeaveActions (single source of truth for leave list + CRUD)
 *       ↓
 *   useLeaveFilters (filter pipeline)
 *       ↓
 *   useStatefulPagination (page-based pagination)
 *       ↓
 *   LeaveManagement (render table + toolbar)
 *
 * KPI stats (totalStaff, presentToday, etc.) come from useDashboardOverviewData
 * which is scoped to the correct organization via OrgConfigContext.
 *
 * FIXES:
 *   - Single data source for leaves (useLeaveActions only, not useDashboardOverviewData)
 *   - Correct import path for useStatefulPagination
 *   - organizationId is always forwarded to useLeaveActions
 */

import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  CalendarDays,
  CheckCircle2,
  XCircle,
  Clock,
  Eye,
  X,
  Inbox,
  BarChart2,
} from "lucide-react";

import { useOrg } from "../../contexts/OrgConfigContext";
import { useBranchSelector } from "../../hooks/useBranchSelector";
import { useDateFilter } from "../../hooks/useDateFilter";
import useDashboardOverviewData from "../../hooks/useDashboardOverviewData";
import {
  resolvePeopleRenderingModel,
  resolveModulePeopleTypes,
} from "../../utils/templateRendering";
import { resolveTemplateFilters } from "../../utils/templateColumns";
import { useLeaveActions } from "./hooks/useLeaveActions";
import { useLeaveTypeOptions } from "./hooks/useLeaveTypeOptions";
import { useLeaveHistory } from "./hooks/useLeaveHistory";

import { BranchSelector } from "../../components/ui/BranchSelector";
import DateFilterBar from "../../components/ui/DateFilterBar";
import ExportButton from "../../components/ui/ExportButton";
import { type ExportExcelColumn } from "../../components/ui/ExportExcelButton";
import DynamicFilterToolbar, {
  type DynamicFilterSection,
} from "../../components/ui/DynamicFilterToolbar";
import JellyButton from "../../components/ui/JellyButton";
import RefreshButton from "../../components/ui/RefreshButton";

import { useLeaveFilters } from "./hooks/useLeaveFilters";
import { useLeaveExport } from "./hooks/useLeaveExport";
// Correct path: usePagination lives in the same module tree
import { useStatefulPagination } from "./shared/hooks/usePagination";
import type { PendingLeaveItem, LeaveHistoryRow } from "./types/leave";
import LeaveHistoryTable from "./LeaveHistoryTable";
import { T } from "./theme";

// ─── Design tokens ────────────────────────────────────────────────────────────
// T itself now lives in ./theme (imported above) — not declared here — so
// LeaveHistoryTable.tsx can import it without creating a circular
// dependency with this file (see theme.ts for the full explanation).
// Re-exported so any existing `import { T } from "./LeaveManagement"`
// call site keeps working.
export { T };

// ─── Status badge configuration ───────────────────────────────────────────────
const STATUS_CONFIG: Record<
  string,
  { bg: string; color: string; icon: React.ReactNode }
> = {
  Pending: { bg: T.amber100, color: T.amber600, icon: <Clock size={11} /> },
  Approved: {
    bg: T.green100,
    color: T.green600,
    icon: <CheckCircle2 size={11} />,
  },
  Rejected: { bg: T.red100, color: T.red600, icon: <XCircle size={11} /> },
};

// ─── Tab configuration ─────────────────────────────────────────────────────────
type ActiveView = "requests" | "history";

// Tab styling function (matches Payroll module design)
const tabStyle = (isActive: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 16px",
  borderRadius: 10,
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  fontFamily: "inherit",
  transition: "all 0.18s",
  background: isActive ? T.navy700 : "transparent",
  color: isActive ? "#fff" : T.textMuted,
});

// Export columns for the History tab — kept local to this file (mirrors the
// small, page-specific shape useLeaveExport.ts uses for the Leaves tab,
// but LeaveHistoryRow is a different shape so it doesn't belong in that
// PendingLeaveItem-specific hook).
function buildHistoryExportColumns(
  showBranch: boolean,
): ExportExcelColumn<LeaveHistoryRow>[] {
  return [
    { header: "Staff ID", accessor: (r) => r.staffId },
    { header: "Name", accessor: (r) => r.name },
    ...(showBranch
      ? [
          {
            header: "Branch",
            accessor: (r: LeaveHistoryRow) => r.branchName ?? "",
          },
        ]
      : []),
    { header: "Department", accessor: (r) => r.department },
    {
      header: "Total Leaves",
      accessor: (r) => (r.quotaConfigured ? r.totalLeaves : ""),
    },
    {
      header: "Remaining Leaves",
      accessor: (r) => (r.quotaConfigured ? r.remainingLeaves : ""),
    },
    {
      header: "Total Paid Leaves",
      accessor: (r) => (r.quotaConfigured ? r.totalPaidLeaves : ""),
    },
    { header: "Availed Paid Leaves", accessor: (r) => r.takenPaidLeaves },

    {
      header: "Remaining Paid Leaves",
      accessor: (r) => (r.quotaConfigured ? r.remainingPaidLeaves : ""),
    },
    {
      header: "Total Unpaid Leaves",
      accessor: (r) => (r.quotaConfigured ? r.totalUnpaidLeaves : ""),
    },
    { header: "Availed Unpaid Leaves", accessor: (r) => r.takenUnpaidLeaves },
    {
      header: "Remaining Unpaid Leaves",
      accessor: (r) => (r.quotaConfigured ? r.remainingUnpaidLeaves : ""),
    },
  ];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const StatCard: React.FC<{
  label: string;
  value: number | string;
  sub: string;
}> = ({ label, value, sub }) => (
  <div
    style={{
      background: T.bgCard,
      border: `1px solid ${T.border}`,
      borderRadius: 16,
      boxShadow: T.shadow,
      padding: "18px 20px",
    }}
  >
    <p
      style={{
        margin: 0,
        fontSize: 10,
        fontWeight: 800,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        color: T.textMuted,
      }}
    >
      {label}
    </p>
    <p
      style={{
        margin: "8px 0 0",
        fontSize: 28,
        fontWeight: 900,
        color: T.navy700,
      }}
    >
      {value}
    </p>
    <p style={{ margin: "3px 0 0", fontSize: 11, color: T.textLight }}>{sub}</p>
  </div>
);

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.Pending;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: cfg.bg,
        color: cfg.color,
        borderRadius: 7,
        padding: "4px 9px",
        fontSize: 10,
        fontWeight: 800,
        textTransform: "uppercase",
      }}
    >
      {cfg.icon}
      {status}
    </span>
  );
};

// A single label/value row inside the modal body — kept as one small
// component (DRY) rather than repeating the label/value markup per field.
const DetailRow: React.FC<{ label: string; value: React.ReactNode }> = ({
  label,
  value,
}) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      gap: 16,
      padding: "9px 0",
      borderBottom: `1px solid ${T.slate100}`,
    }}
  >
    <span
      style={{
        fontSize: 11,
        fontWeight: 800,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: T.textMuted,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
    <span
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: T.textBody,
        textAlign: "right",
      }}
    >
      {value}
    </span>
  </div>
);

// Read-only detail view for a single leave request. Self-contained (no
// dependency on a shared Modal/Dialog component, since none is imported
// elsewhere in this file) so it works regardless of what else exists in
// the codebase — swap this for a shared Modal component if one exists.
const LeaveDetailsModal: React.FC<{
  leave: PendingLeaveItem;
  branchLabel: string;
  showBranch: boolean;
  onClose: () => void;
}> = ({ leave, branchLabel, showBranch, onClose }) => {
  const normalizedStatus = String(leave.status ?? "Pending");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-details-heading"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.bgCard,
          borderRadius: 16,
          boxShadow: "0 20px 60px rgba(15,45,74,0.25)",
          width: "100%",
          maxWidth: 440,
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "16px 20px",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <h3
            id="leave-details-heading"
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 900,
              color: T.textHeading,
            }}
          >
            Leave Request Details
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: T.textMuted,
              display: "flex",
              padding: 4,
              borderRadius: 6,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "8px 20px 20px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 0 16px",
            }}
          >
            <div
              style={{
                width: 42,
                height: 42,
                borderRadius: 12,
                background: T.teal50,
                color: T.teal600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 900,
                fontSize: 16,
                flexShrink: 0,
              }}
            >
              {leave.name.charAt(0)}
            </div>
            <div>
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  fontWeight: 800,
                  color: T.textBody,
                }}
              >
                {leave.name}
              </p>
            </div>
            <div style={{ marginLeft: "auto" }}>
              <StatusBadge status={normalizedStatus} />
            </div>
          </div>

          <DetailRow label="Leave Type" value={leave.type} />
          {leave.halfDayPeriod && (
            <DetailRow
              label="Half Day"
              value={
                leave.halfDayStartTime && leave.halfDayEndTime
                  ? `${leave.halfDayPeriod} · ${leave.halfDayStartTime}–${leave.halfDayEndTime}`
                  : `${leave.halfDayPeriod}`
              }
            />
          )}
          {showBranch && (
            <DetailRow label={branchLabel} value={leave.branchName} />
          )}
          <DetailRow label="Department" value={leave.dept} />
          <DetailRow label="Start Date" value={leave.startDate} />
          <DetailRow label="End Date" value={leave.endDate} />
          <DetailRow label="Days" value={`${leave.days}d`} />
          {leave.approvedBy && (
            <DetailRow label="Approved By" value={leave.approvedBy} />
          )}
          {leave.appliedOn && (
            <DetailRow label="Applied On" value={leave.appliedOn} />
          )}

          <div style={{ marginTop: 14 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                color: T.textMuted,
              }}
            >
              Reason
            </span>
            <p
              style={{
                margin: "6px 0 0",
                fontSize: 13,
                color: T.textBody,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
              }}
            >
              {leave.reason || "—"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

export default function LeaveManagement() {
  const { branchId: branchIdParam } = useParams<{ branchId?: string }>();
  const [searchParams] = useSearchParams();
  const { cfg, organizationName } = useOrg();

  const highlightedLeaveId = searchParams.get("highlight");
  const isGlobal = !branchIdParam;
  const scopedBranchId = branchIdParam ? Number(branchIdParam) : undefined;

  // Which people types Leave is actually enabled for, in this scope —
  // per-branch when viewing a single branch, unioned across branches when
  // viewing "All Branches". Falls back to the org-wide list automatically
  // for orgs that haven't been backfilled yet (see resolveModulePeopleTypes).
  const leavePeopleTypes = useMemo(
    () =>
      resolveModulePeopleTypes(
        cfg as unknown as Record<string, unknown>,
        "leave",
        isGlobal ? null : scopedBranchId,
      ),
    [cfg, isGlobal, scopedBranchId],
  );

  const [selectedPeopleType, setSelectedPeopleType] = useState<string | null>(
    null,
  );

  // Leave currently shown in the read-only details modal (null = closed).
  const [detailsLeave, setDetailsLeave] = useState<PendingLeaveItem | null>(
    null,
  );

  // "Leaves" (pending/approved/rejected inbox — existing behavior) vs
  // "Leave History" (per-employee annual balance — new tab).
  const [activeView, setActiveView] = useState<ActiveView>("requests");

  // Year the History tab aggregates. Independent of the Leaves tab's
  // DateFilterBar (`filter` below) — a leave balance is a calendar-year
  // concept, the pending-requests inbox is not.
  const currentYear = new Date().getFullYear();
  const [historyYear, setHistoryYear] = useState<number>(currentYear);
  const historyYearOptions = useMemo(
    () => [currentYear, currentYear - 1, currentYear - 2],
    [currentYear],
  );

  const templateModel = useMemo(
    () =>
      resolvePeopleRenderingModel(
        cfg as unknown as Record<string, unknown>,
        selectedPeopleType,
        leavePeopleTypes,
      ),
    [cfg, selectedPeopleType, leavePeopleTypes],
  );

  const templateFilters = useMemo(
    () =>
      resolveTemplateFilters(
        cfg as unknown as Record<string, unknown>,
        templateModel.peopleType,
        leavePeopleTypes,
      ),
    [cfg, templateModel.peopleType, leavePeopleTypes],
  );

  // ── External filter state ──────────────────────────────────────────────────
  const filter = useDateFilter("daily");
  const branch = useBranchSelector("filter");

  // ── Single source of truth for leave data + CRUD ──────────────────────────
  // useLeaveActions reads organizationId from OrgConfigContext internally.
  // branchId scopes to the active branch when in branch view.
  const {
    leaves,
    loading: leavesLoading,
    refreshing: leavesRefreshing,
    refresh: refreshLeaves,
    handleLeaveAction,
    loadingId,
  } = useLeaveActions({
    branchId: isGlobal
      ? (branch.selectedBranchId ?? null)
      : (scopedBranchId ?? null),
  });

  // ── Dashboard stats (KPI cards only — NOT used for leave list) ────────────
  const { stats, branchFilterOptions, branchName } = useDashboardOverviewData({
    scope: isGlobal ? "global" : "branch",
    branchId: scopedBranchId,
    selectedBranchId: isGlobal ? branch.selectedBranchId : undefined,
  });

  // ── Leave filtering pipeline ───────────────────────────────────────────────
  // Tenant + branch scoped leave-type config (source of truth: Payroll
  // Rules' leaveTypeRules — see useLeaveTypeOptions). Scoped identically to
  // useLeaveActions above so the leave list and its type filter always
  // agree on which branch is in view; the previous cfg.payrollPolicy read
  // was org-wide only and silently ignored any branch-level override.
  const {
    leaveTypes: leaveTypeConfig,
    leaveTypeRules,
    leaveTypeQuotas,
    error: leaveTypeConfigError,
  } = useLeaveTypeOptions(
    isGlobal ? (branch.selectedBranchId ?? null) : (scopedBranchId ?? null),
  );

  // A failed leaveTypeRules fetch and "org has no leave types configured
  // yet" both resolve leaveTypeConfig to null, which makes the filter fall
  // back to the hardcoded PREDEFINED_LEAVE_TYPES list identically either
  // way (see buildLeaveTypeFilterOptions). Logging here is what tells the
  // two apart — check the console/network tab if the filter shows the
  // full hardcoded list instead of just what's configured in Payroll Rules.
  useEffect(() => {
    if (leaveTypeConfigError) {
      // eslint-disable-next-line no-console
      console.error(
        "[LeaveManagement] Failed to load configured leave types — filter is showing the hardcoded fallback list:",
        leaveTypeConfigError,
      );
    }
  }, [leaveTypeConfigError]);

  const leaveFilters = useLeaveFilters({
    leaves,
    dateFilter: {
      dates: filter.dates,
      mode: filter.mode as "daily" | "weekly" | "monthly" | "custom",
      label: filter.label,
      selectedDate: filter.selectedDate,
    },
    isGlobal,
    selectedBranchId: isGlobal ? branch.selectedBranchId : scopedBranchId,
    selectedPeopleType: templateModel.peopleType,
    templateFilters,
    templateConfig: cfg as unknown as Record<string, unknown>,
    leaveTypes: leaveTypeConfig,
    groupFilterAllLabel: templateModel.groupFilterAllLabel,
  });

  // ── Pagination ────────────────────────────────────────────────────────────
  const { paginatedItems, page, totalPages, totalItems, goToPage } =
    useStatefulPagination({
      items: leaveFilters.fullyFilteredLeaves,
      itemsPerPage: 25,
    });

  // ── Leave History tab: per-employee aggregation ────────────────────────────
  // Reuses `leaves` (same org/branch/people-type scope useLeaveActions
  // already resolved) and the department/search filter state already
  // owned by useLeaveFilters — one filter pipeline for both tabs, not two.
  const {
    rows: historyRowsUnfiltered,
    loading: historyLoading,
    quotaConfigured: historyQuotaConfigured,
  } = useLeaveHistory({
    leaves,
    leaveTypeRules,
    leaveTypeQuotas,
    year: historyYear,
    branchId: isGlobal
      ? (branch.selectedBranchId ?? null)
      : (scopedBranchId ?? null),
  });

  const historyRows = useMemo(() => {
    const department = leaveFilters.filters.department;
    const search = leaveFilters.filters.search.trim().toLowerCase();
    return historyRowsUnfiltered.filter((row) => {
      if (department && row.department !== department) return false;
      if (
        search &&
        !row.name.toLowerCase().includes(search) &&
        !row.department.toLowerCase().includes(search) &&
        !row.staffId.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    });
  }, [
    historyRowsUnfiltered,
    leaveFilters.filters.department,
    leaveFilters.filters.search,
  ]);

  const {
    paginatedItems: paginatedHistoryRows,
    page: historyPage,
    totalPages: historyTotalPages,
    totalItems: historyTotalItems,
    goToPage: goToHistoryPage,
  } = useStatefulPagination({ items: historyRows, itemsPerPage: 25 });

  // ── Scroll highlighted row into view ──────────────────────────────────────
  useLayoutEffect(() => {
    if (!highlightedLeaveId) return;

    const frameId = window.requestAnimationFrame(() => {
      const row = document.getElementById(`leave-row-${highlightedLeaveId}`);

      if (row) {
        row.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [highlightedLeaveId, paginatedItems]);

  // ── CSV export (Leaves tab) ─────────────────────────────────────────────────
  const exportConfig = useLeaveExport({
    items: leaveFilters.fullyFilteredLeaves,
    isGlobal,
    dateLabel: filter.label,
    branchLabel: isGlobal
      ? branch.isAllBranches
        ? "All Branches"
        : (branchFilterOptions.find((b) => b.id === branch.selectedBranchId)
            ?.name ?? "Branch")
      : (branchName ?? "Branch"),
    filterMetadata: leaveFilters.exportMetadata,
  });

  // ── CSV export (Leave History tab) ──────────────────────────────────────────
  const historyExportColumns = useMemo(
    () => buildHistoryExportColumns(false),
    [],
  );

  // ── Context label ─────────────────────────────────────────────────────────
  const contextLabel = isGlobal
    ? branch.isAllBranches
      ? "All Branches"
      : (branchFilterOptions.find((b) => b.id === branch.selectedBranchId)
          ?.name ?? branch.selected.name)
    : (branchName ?? "Branch");

  const exportOrganization = useMemo(
    () => ({
      name: organizationName || cfg.orgName || undefined,
      logoUrl: cfg.logo || undefined,
    }),
    [cfg.logo, cfg.orgName, organizationName],
  );

  const isRangeMode = filter.mode !== "daily";
  // Pending is now always inbox-style (never date-scoped — see
  // filterLeavesByDateRange in leave-filters.ts), so this KPI's label/sub
  // no longer varies with the period selector the way it used to.
  const kpiLabel = "Pending Leaves";
  const kpiSub = "Awaiting approval";

  // ── Filter toolbar sections ───────────────────────────────────────────────
  const groupFilterTemplate = useMemo(
    () =>
      templateFilters.find((filter) =>
        ["department", "class", "section", "designation"].includes(filter.key),
      ),
    [templateFilters],
  );

  const toolbarSections = useMemo<DynamicFilterSection[]>(
    () => [
      ...(isGlobal && branch.selectorBranches.length > 1
        ? [
            {
              id: "branch",
              type: "custom" as const,
              render: (
                <BranchSelector
                  branches={branch.selectorBranches}
                  selected={branch.selected}
                  onChange={branch.onChange}
                />
              ),
            },
          ]
        : []),
      // Date range only applies to the Leaves (pending-requests) tab — the
      // History tab aggregates a full calendar year via its own year
      // picker (see historyYear), not the daily/weekly/monthly filter.
      ...(activeView === "requests"
        ? [
            {
              id: "date",
              type: "custom" as const,
              // Leave (unlike Attendance/Overtime) is routinely applied for
              // future dates, so it opts out of DateFilterBar's default
              // "can't pick past today" ceiling.
              render: <DateFilterBar filter={filter} maxDate={null} />,
            },
          ]
        : []),
      ...(templateModel.hasMultiplePeopleTypes
        ? [
            {
              id: "peopleType",
              type: "select" as const,
              label: "Type",
              value: templateModel.peopleType,
              options: templateModel.selectablePeopleTypes,
              minWidth: 160,
              onChange: (value: string) => setSelectedPeopleType(value),
            },
          ]
        : []),
      {
        id: "department",
        type: "select" as const,
        label: groupFilterTemplate?.label ?? templateModel.groupLabel,
        value: leaveFilters.filters.department ?? "__all__",
        options: leaveFilters.departmentOptions,
        minWidth: 300,
        onChange: (value: string) =>
          leaveFilters.setDepartment(value === "__all__" ? null : value),
      },
      {
        id: "type",
        type: "select" as const,
        label: "Leave Type",
        value: leaveFilters.filters.type ?? "__all__",
        options: leaveFilters.typeOptions,
        minWidth: 180,
        onChange: (value: string) =>
          leaveFilters.setType(value === "__all__" ? null : value),
      },
      {
        id: "search",
        type: "search" as const,
        value: leaveFilters.filters.search,
        placeholder: `Search ${templateModel.personSingular.toLowerCase()} name, ${templateModel.groupLabel.toLowerCase()}, type...`,
        grow: true,
        minWidth: 280,
        onChange: leaveFilters.setSearch,
      },
      {
        id: "reset",
        type: "reset" as const,
        label: "Clear",
        onClick: leaveFilters.reset,
      },
    ],
    [
      branch,
      filter,
      isGlobal,
      leaveFilters,
      groupFilterTemplate,
      templateModel.groupLabel,
      templateModel.personSingular,
      templateModel.hasMultiplePeopleTypes,
      templateModel.peopleType,
      templateModel.selectablePeopleTypes,
    ],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        minHeight: "100%",
        background: T.bgPage,
        padding: "24px 24px 48px",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 22,
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              color: T.textHeading,
              fontSize: 24,
              fontWeight: 900,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <CalendarDays size={22} color={T.teal600} />
            Leave Management
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <RefreshButton
            size="md"
            loading={leavesRefreshing}
            onClick={refreshLeaves}
            ariaLabel="Refresh leave requests"
          />
          {activeView === "requests" ? (
            <ExportButton
              data={leaveFilters.fullyFilteredLeaves}
              filename={exportConfig.filename}
              label="Export"
              organization={exportOrganization}
              excel={{
                columns: exportConfig.columns,
                meta: exportConfig.metadata,
              }}
              pdf={{
                title: "Leave Requests",
                subtitle: contextLabel,
                reportPeriod: filter.label,
                meta: exportConfig.metadata,
                columns: exportConfig.columns,
              }}
              emptyMessage="No leave requests match the current filters."
            />
          ) : (
            <ExportButton
              data={historyRows}
              filename={`leave-history_${historyYear}`}
              label="Export"
              organization={exportOrganization}
              excel={{
                columns: historyExportColumns,
              }}
              pdf={{
                title: "Leave History",
                subtitle: contextLabel,
                reportPeriod: String(historyYear),
                columns: historyExportColumns,
              }}
              emptyMessage="No employees match the current filters."
            />
          )}
        </div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 4,
          background: T.slate50,
          border: `1px solid ${T.border}`,
          borderRadius: 14,
          padding: 4,
          marginBottom: 20,
          width: "fit-content",
        }}
      >
        <button
          style={tabStyle(activeView === "requests")}
          onClick={() => setActiveView("requests")}
          type="button"
          title="View leave requests"
        >
          <Inbox size={13} /> Leaves
        </button>
        <button
          style={tabStyle(activeView === "history")}
          onClick={() => setActiveView("history")}
          type="button"
          title="View leave history"
        >
          <BarChart2 size={13} /> Leave History
        </button>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 14,
          marginBottom: 20,
        }}
      >
        <StatCard
          label={templateModel.statsTotalLabel}
          value={stats.totalStaff}
          sub={isGlobal ? `${stats.totalBranches} branches` : "Current branch"}
        />
        <StatCard
          label={kpiLabel}
          value={leaveFilters.pendingCount}
          sub={kpiSub}
        />
        <StatCard
          label="Present Today"
          value={stats.presentToday}
          sub={`${stats.avgAttendance}% attendance`}
        />
        <StatCard
          label="Absent Today"
          value={stats.absentToday}
          sub={`${stats.lateToday} late arrivals`}
        />
      </div>

      {/* Filter Toolbar */}
      <DynamicFilterToolbar
        sections={toolbarSections}
        style={{ marginBottom: 16 }}
      />

      {activeView === "requests" ? (
        <>
          {/* Table */}
          <div
            style={{
              background: T.bgCard,
              border: `1px solid ${T.border}`,
              borderRadius: 16,
              boxShadow: T.shadow,
              overflow: "hidden",
            }}
          >
            {/* Table Header */}
            <div
              style={{
                padding: "15px 20px",
                borderBottom: `1px solid ${T.border}`,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <h2
                  style={{
                    margin: 0,
                    fontSize: 14,
                    fontWeight: 900,
                    color: T.textHeading,
                  }}
                >
                  Pending Leave Requests
                </h2>
                <p
                  style={{
                    margin: "2px 0 0",
                    fontSize: 11,
                    color: T.textMuted,
                  }}
                >
                  All pending, plus approved/rejected history for {filter.label}
                </p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span
                  style={{
                    background: T.teal50,
                    border: `1px solid ${T.teal100}`,
                    color: T.teal600,
                    borderRadius: 999,
                    padding: "4px 10px",
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {totalItems} result{totalItems !== 1 ? "s" : ""}
                  {totalPages > 1 && ` · Page ${page} of ${totalPages}`}
                </span>
              </div>
            </div>

            {/* Table Body */}
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: T.slate50 }}>
                    {[
                      {
                        key: "employee",
                        label: templateModel.personSingular,
                        align: "left",
                      },
                      ...(isGlobal
                        ? [
                            {
                              key: "branch",
                              label: templateModel.branchLabel,
                              align: "left",
                            },
                          ]
                        : []),
                      {
                        key: "department",
                        label: templateModel.groupLabel,
                        align: "left",
                      },
                      { key: "type", label: "Leave Type", align: "left" },
                      {
                        key: "payrollTreatment",
                        label: "Payroll Treatment",
                        align: "center",
                      },
                      { key: "days", label: "Days", align: "center" },
                      { key: "status", label: "Status", align: "center" },
                      { key: "action", label: "Action", align: "center" },
                    ].map((col) => (
                      <th
                        key={col.key}
                        style={{
                          padding: "12px 16px",
                          textAlign:
                            col.align as React.CSSProperties["textAlign"],
                          fontSize: 10,
                          fontWeight: 900,
                          color: T.textLight,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          borderBottom: `1px solid ${T.border}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {leavesLoading ? (
                    <tr>
                      <td
                        colSpan={isGlobal ? 8 : 7}
                        style={{
                          padding: 48,
                          textAlign: "center",
                          color: T.textLight,
                          fontSize: 13,
                        }}
                      >
                        Loading leave requests…
                      </td>
                    </tr>
                  ) : (
                    <>
                      {paginatedItems.map((leave: PendingLeaveItem) => {
                        const highlighted =
                          String(leave.id) === highlightedLeaveId;

                        return (
                          <tr
                            id={`leave-row-${leave.id}`}
                            key={leave.id}
                            style={{
                              borderBottom: highlighted
                                ? "1px solid #fed7aa"
                                : `1px solid ${T.slate100}`,
                              background: highlighted
                                ? "#fff7ed"
                                : "transparent",
                              boxShadow: highlighted
                                ? "inset 3px 0 0 #f97316"
                                : "none",
                            }}
                          >
                            {/* Employee */}
                            <td style={{ padding: "13px 16px" }}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 10,
                                }}
                              >
                                <div
                                  style={{
                                    width: 34,
                                    height: 34,
                                    borderRadius: 10,
                                    background: T.teal50,
                                    color: T.teal600,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontWeight: 900,
                                  }}
                                >
                                  {leave.name.charAt(0)}
                                </div>
                                <div>
                                  <p
                                    style={{
                                      margin: 0,
                                      fontSize: 12,
                                      fontWeight: 800,
                                      color: T.textBody,
                                    }}
                                  >
                                    {leave.name}
                                  </p>
                                </div>
                              </div>
                            </td>

                            {/* Branch (global only) */}
                            {isGlobal && (
                              <td style={{ padding: "13px 16px" }}>
                                <span
                                  style={{
                                    background: T.slate50,
                                    border: `1px solid ${T.slate200}`,
                                    borderRadius: 7,
                                    padding: "4px 8px",
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: T.navy700,
                                  }}
                                >
                                  {leave.branchName}
                                </span>
                              </td>
                            )}

                            {/* Department */}
                            <td style={{ padding: "13px 16px" }}>
                              <span
                                style={{
                                  background: T.slate50,
                                  border: `1px solid ${T.slate200}`,
                                  borderRadius: 7,
                                  padding: "4px 8px",
                                  fontSize: 11,
                                  fontWeight: 700,
                                  color: T.textMuted,
                                }}
                              >
                                {leave.dept}
                              </span>
                            </td>

                            {/* Type */}
                            <td style={{ padding: "13px 16px" }}>
                              <span
                                style={{
                                  background: `${T.teal600}15`,
                                  border: `1px solid ${T.teal600}30`,
                                  color: T.teal600,
                                  borderRadius: 7,
                                  padding: "4px 8px",
                                  fontSize: 11,
                                  fontWeight: 800,
                                }}
                              >
                                {leave.type}
                              </span>
                              {leave.halfDayPeriod && (
                                <div
                                  style={{
                                    marginTop: 4,
                                    fontSize: 10,
                                    fontWeight: 700,
                                    color: T.textMuted,
                                    textTransform: "capitalize",
                                  }}
                                >
                                  {leave.halfDayPeriod}
                                  {leave.halfDayStartTime &&
                                  leave.halfDayEndTime
                                    ? ` · ${leave.halfDayStartTime}–${leave.halfDayEndTime}`
                                    : ""}
                                </div>
                              )}
                            </td>

                            {/* Payroll treatment */}
                            <td
                              style={{
                                padding: "13px 16px",
                                textAlign: "center",
                              }}
                            >
                              {(() => {
                                const mode = String(
                                  leave.leaveCompensation ?? "not_configured",
                                ).toLowerCase();
                                const payrollDecision = String(
                                  leave.leavePayrollDecision ?? "",
                                ).toLowerCase();

                                const appearance =
                                  mode === "unpaid"
                                    ? {
                                        bg: T.red100,
                                        border: `${T.red600}33`,
                                        color: T.red600,
                                        label: "Unpaid",
                                      }
                                    : mode === "excluded"
                                      ? {
                                          bg: T.slate100,
                                          border: `${T.textMuted}33`,
                                          color: T.textMuted,
                                          label: "Excluded",
                                        }
                                      : mode === "paid"
                                        ? {
                                            bg: T.green100,
                                            border: `${T.green600}33`,
                                            color: T.green600,
                                            label: "Paid",
                                          }
                                        : {
                                            bg: T.amber100,
                                            border: `${T.amber600}33`,
                                            color: T.amber600,
                                            label: "Not Configured",
                                          };

                                return (
                                  <div
                                    style={{
                                      display: "inline-flex",
                                      flexDirection: "column",
                                      alignItems: "center",
                                      gap: 4,
                                    }}
                                  >
                                    <span
                                      style={{
                                        background: appearance.bg,
                                        border: `1px solid ${appearance.border}`,
                                        color: appearance.color,
                                        borderRadius: 999,
                                        padding: "4px 10px",
                                        fontSize: 10,
                                        fontWeight: 800,
                                        textTransform: "uppercase",
                                      }}
                                    >
                                      {appearance.label}
                                    </span>
                                    {payrollDecision && (
                                      <span
                                        style={{
                                          fontSize: 10,
                                          fontWeight: 700,
                                          color: T.textMuted,
                                          textTransform: "capitalize",
                                        }}
                                      >
                                        Decision: {payrollDecision}
                                      </span>
                                    )}
                                  </div>
                                );
                              })()}
                            </td>

                            {/* Days */}
                            <td
                              style={{
                                padding: "13px 16px",
                                textAlign: "center",
                              }}
                            >
                              <strong>{leave.days}d</strong>
                            </td>

                            {/* Status */}
                            <td
                              style={{
                                padding: "13px 16px",
                                textAlign: "center",
                              }}
                            >
                              <StatusBadge status={leave.status ?? "Pending"} />
                            </td>

                            {/* Action */}
                            <td
                              style={{
                                padding: "13px 16px",
                                textAlign: "center",
                              }}
                            >
                              {(() => {
                                const normalizedStatus = String(
                                  leave.status ?? "Pending",
                                ).toLowerCase();
                                const isApproved =
                                  normalizedStatus === "approved";
                                const isRejected =
                                  normalizedStatus === "rejected";
                                return (
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "center",
                                      gap: 7,
                                    }}
                                  >
                                    <JellyButton
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => setDetailsLeave(leave)}
                                      leftIcon={<Eye size={12} />}
                                    ></JellyButton>
                                    {!isApproved && (
                                      <JellyButton
                                        type="button"
                                        variant="success"
                                        size="sm"
                                        loading={loadingId === leave.id}
                                        disabled={loadingId === leave.id}
                                        onClick={() =>
                                          handleLeaveAction(
                                            leave.id,
                                            "Approved",
                                          )
                                        }
                                        leftIcon={<CheckCircle2 size={12} />}
                                      >
                                        Approve
                                      </JellyButton>
                                    )}
                                    {!isRejected && (
                                      <JellyButton
                                        type="button"
                                        variant="danger"
                                        size="sm"
                                        loading={loadingId === leave.id}
                                        disabled={loadingId === leave.id}
                                        onClick={() =>
                                          handleLeaveAction(
                                            leave.id,
                                            "Rejected",
                                          )
                                        }
                                        leftIcon={<XCircle size={12} />}
                                      >
                                        Reject
                                      </JellyButton>
                                    )}
                                  </div>
                                );
                              })()}
                            </td>
                          </tr>
                        );
                      })}

                      {paginatedItems.length === 0 && (
                        <tr>
                          <td
                            colSpan={isGlobal ? 8 : 7}
                            style={{
                              padding: 48,
                              textAlign: "center",
                              color: T.textLight,
                              fontSize: 13,
                            }}
                          >
                            <CalendarDays
                              size={32}
                              style={{
                                opacity: 0.2,
                                display: "block",
                                margin: "0 auto 10px",
                              }}
                            />
                            No pending requests, and no leave history
                            {isRangeMode ? ` for ${filter.label}` : ""} matches
                            your filters.
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && paginatedItems.length > 0 && (
              <div
                style={{
                  padding: "12px 20px",
                  borderTop: `1px solid ${T.border}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                }}
              >
                <JellyButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => goToPage(page - 1)}
                  disabled={page === 1}
                >
                  ← Previous
                </JellyButton>

                <span
                  style={{ fontSize: 11, color: T.textMuted, fontWeight: 600 }}
                >
                  Page {page} of {totalPages}
                </span>

                <JellyButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => goToPage(page + 1)}
                  disabled={page === totalPages}
                >
                  Next →
                </JellyButton>
              </div>
            )}
          </div>
        </>
      ) : (
        <LeaveHistoryTable
          rows={paginatedHistoryRows}
          loading={historyLoading}
          showBranch={isGlobal}
          year={historyYear}
          yearOptions={historyYearOptions}
          onYearChange={setHistoryYear}
          quotaConfigured={historyQuotaConfigured}
          page={historyPage}
          totalPages={historyTotalPages}
          totalItems={historyTotalItems}
          goToPage={goToHistoryPage}
        />
      )}

      {detailsLeave && (
        <LeaveDetailsModal
          leave={detailsLeave}
          branchLabel={templateModel.branchLabel}
          showBranch={isGlobal}
          onClose={() => setDetailsLeave(null)}
        />
      )}
    </div>
  );
}
