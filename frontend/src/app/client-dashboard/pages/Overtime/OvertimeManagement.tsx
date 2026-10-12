/**
 * src/modules/overtime/OvertimeManagement.tsx — REFACTORED
 * ─────────────────────────────────────────────────────────────────────────────
 * Overtime request management with approve/reject workflow.
 * Uses ExportExcelButton (formatted, branded .xlsx) with jelly hover fill effect.
 *
 * Single source of truth: ModuleContext.overtime (ScopedStore<OvertimeRequest>)
 *   - Seeded from generateOrgDummyData.overtime (org/branch-aware)
 *   - All mutations via overtime.update(id, patch) — reflected on all pages
 *
 * Backend migration:
 *   Replace createEntityStore internals with API fetch/mutate.
 *   This component's public API (useModule().overtime) is unchanged.
 *
 * Scope:
 *   Route param :branchId / activeBranchId → branch view (branch admin).
 *   Neither present                         → global view (org admin).
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Banknote,
  CalendarDays,
  CheckCircle,
  Clock,
  Eye,
  Settings,
  TimerReset,
  XCircle,
  RefreshCw,
} from "lucide-react";
import PeopleTypeSelector from "../../components/ui/PeopleTypeSelector";
import { updateOvertimeStatus } from "../../api/api";
import {
  toastSuccess,
  toastError,
  confirmDialog,
} from "../../utils/notifications";
import {
  getPayrollPolicy,
  savePayrollPolicy,
  DEFAULT_PAYROLL_POLICY,
  type PayrollPolicy,
} from "../Payroll/api/payrollApi";
import { useOrg } from "../../contexts/OrgConfigContext";
import { useModule } from "../../contexts/ModuleContext";
import type { OvertimeRequest } from "../../contexts/ModuleContext";
import { T } from "../../components/ui/theme";
import JellyButton from "../../components/ui/JellyButton";
import ModernSelect from "../../components/ui/ModernSelect";
import DynamicFilterToolbar, {
  type DynamicFilterSection,
} from "../../components/ui/DynamicFilterToolbar";
import RefreshButton from "../../components/ui/RefreshButton";
import { StatusBadge } from "../../components/ui/DashboardComponents";
import StatCard from "../../components/dashboard/overview/StatCard";
import ExportButton from "../../components/ui/ExportButton";
import type { ExportExcelColumn } from "../../components/ui/ExportExcelButton";

import type { BranchOption, DecidableStatus } from "./types/overtime";
import { API_STATUS_MAP, DEFAULT_OVERTIME_POLICY } from "./types/overtime";
import {
  calculateOvertimePay,
  formatDate,
  loadPolicy,
  persistPolicy,
  policyMethodLabel,
  safeBranchName,
} from "./utils/overtime.utils";
import {
  resolveModulePeopleTypes,
  normalizePeopleType,
} from "../../utils/templateRendering";
import { useOvertimeFilters } from "./hooks/useOvertimeFilters";
// import PolicySettingsModal from "./components/PolicySettingsModal";
import OvertimeDetailPanel from "./components/OvertimeDetailPanel";
import RejectReasonModal from "./components/RejectReasonModal";

// ─── Shared inline styles ─────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  height: 38,
  width: "100%",
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  background: T.card,
  color: T.head,
  padding: "0 10px",
  fontSize: 12,
  fontWeight: 700,
  fontFamily: "inherit",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  fontWeight: 900,
  color: T.muted,
  textTransform: "uppercase",
  letterSpacing: ".07em",
  marginBottom: 5,
};

const tinyButtonStyle: React.CSSProperties = {
  height: 30,
  borderRadius: 9,
  border: `1px solid ${T.border}`,
  background: T.card,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 10px",
  fontSize: 11,
  fontWeight: 900,
  color: T.head,
};

const iconButtonStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 9,
  border: `1px solid ${T.border}`,
  background: T.card,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

type OvertimeViewFields = {
  staffId?: string | number | null;
  userId?: string | number | null;
  user_id?: string | number | null;
  staffName?: string | null;
  employeeName?: string | null;
  userName?: string | null;
  user_name?: string | null;
  name?: string | null;
  date?: string | null;
  otDate?: string | null;
  ot_date?: string | null;
  appliedOn?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
};

type StaffSalaryLookupRow = {
  id?: string | number | null;
  userId?: string | number | null;
  user_id?: string | number | null;
  name?: string | null;
  staffName?: string | null;
  salary?: number | string | null;
  personCode?: string | null;
  person_code?: string | null;
  employeeId?: string | null;
  employee_id?: string | null;
  registrationNumber?: string | null;
  registration_number?: string | null;
};

function toViewFields(request: OvertimeRequest): OvertimeViewFields {
  return request as OvertimeRequest & OvertimeViewFields;
}

function stringValue(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function lowerValue(value: unknown): string {
  return stringValue(value).trim().toLowerCase();
}

function getOvertimeStaffId(request: OvertimeRequest): string {
  const row = toViewFields(request);
  return stringValue(row.staffId ?? row.userId ?? row.user_id ?? "");
}

function getOvertimeStaffName(request: OvertimeRequest): string {
  const row = toViewFields(request);
  return stringValue(
    row.staffName ??
      row.employeeName ??
      row.userName ??
      row.user_name ??
      row.name,
    "Unknown Employee",
  );
}

function getOvertimeDate(request: OvertimeRequest): string {
  const row = toViewFields(request);
  return stringValue(row.date ?? row.otDate ?? row.ot_date ?? "");
}

function getOvertimeAppliedOn(request: OvertimeRequest): string {
  const row = toViewFields(request);
  return stringValue(row.appliedOn ?? row.createdAt ?? row.created_at ?? "");
}

function asStaffSalaryLookupRow(value: unknown): StaffSalaryLookupRow {
  return value && typeof value === "object"
    ? (value as StaffSalaryLookupRow)
    : {};
}

function getStaffRowId(row: StaffSalaryLookupRow): string {
  return stringValue(row.id ?? row.userId ?? row.user_id ?? "");
}

function getStaffRowName(row: StaffSalaryLookupRow): string {
  return stringValue(row.name ?? row.staffName ?? "");
}

function getStaffRowSalary(row: StaffSalaryLookupRow): number | undefined {
  const parsed = Number(row.salary);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getStaffRowPersonCode(row: StaffSalaryLookupRow): string {
  return stringValue(
    row.personCode ??
      row.person_code ??
      row.employeeId ??
      row.employee_id ??
      row.registrationNumber ??
      row.registration_number ??
      "",
  );
}

function normalizeBranchScope(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesBranchScope(
  requestBranchId: number | string | null | undefined,
  targetBranchId: number | string | null | undefined,
): boolean {
  const targetNumber = normalizeBranchScope(targetBranchId);
  const requestNumber = normalizeBranchScope(requestBranchId);

  if (targetNumber != null && requestNumber != null) {
    return targetNumber === requestNumber;
  }

  return String(requestBranchId ?? "") === String(targetBranchId ?? "");
}

interface OvertimeManagementProps {
  embedded?: boolean;
  branchScopeOverride?: number | string | null;
}

// ─── Main Component ───────────────────────────────────────────────────────────

const OvertimeManagement: React.FC<OvertimeManagementProps> = ({
  embedded = false,
  branchScopeOverride,
}) => {
  const params = useParams<{ branchId?: string; id?: string }>();
  const [searchParams] = useSearchParams();
  const highlightedOvertimeId = searchParams.get("highlight");
  const { cfg, activeBranchId, organizationId } = useOrg();
  const { overtime, staff, refreshing, refresh } = useModule();

  // ── Scope resolution ───────────────────────────────────────────────────────
  const routeBranchId =
    (params.branchId ?? params.id)
      ? normalizeBranchScope(params.branchId ?? params.id)
      : undefined;
  const effectiveBranchId =
    branchScopeOverride ?? activeBranchId ?? routeBranchId;
  const isGlobalDashboard = effectiveBranchId == null;
  const isBranchDashboard = !isGlobalDashboard;

  const modulePeopleTypes = useMemo(
    () =>
      resolveModulePeopleTypes(
        cfg as unknown as Record<string, unknown>,
        "overtime",
        isGlobalDashboard ? null : effectiveBranchId,
      ),
    [cfg, isGlobalDashboard, effectiveBranchId],
  );

  const branches = useMemo<BranchOption[]>(
    () =>
      cfg.branches.map((b) => ({
        id: Number(b.id),
        name: b.name || `Branch ${b.id}`,
      })),
    [cfg.branches],
  );

  const fallbackBranchId =
    normalizeBranchScope(effectiveBranchId ?? branches[0]?.id ?? 1) ?? 1;

  const previousPeopleFilterRef = useRef<string | null>(null);

  // ── Staff (for salary lookup) ──────────────────────────────────────────────
  const staffRows = staff.allItems;

  const getStaffMonthlySalary = useCallback(
    (request: OvertimeRequest): number | undefined => {
      const requestStaffId = getOvertimeStaffId(request);
      const requestStaffName = lowerValue(getOvertimeStaffName(request));

      const match = staffRows.find((staffRow) => {
        const row = asStaffSalaryLookupRow(staffRow);
        const staffRowId = getStaffRowId(row);
        const staffRowName = lowerValue(getStaffRowName(row));

        return (
          (requestStaffId && staffRowId === requestStaffId) ||
          (requestStaffName && staffRowName === requestStaffName)
        );
      });

      return getStaffRowSalary(asStaffSalaryLookupRow(match));
    },
    [staffRows],
  );

  const getStaffPersonCode = useCallback(
    (request: OvertimeRequest): string => {
      const requestStaffId = getOvertimeStaffId(request);
      const requestStaffName = lowerValue(getOvertimeStaffName(request));

      const match = staffRows.find((staffRow) => {
        const row = asStaffSalaryLookupRow(staffRow);
        const staffRowId = getStaffRowId(row);
        const staffRowName = lowerValue(getStaffRowName(row));

        return (
          (requestStaffId && staffRowId === requestStaffId) ||
          (requestStaffName && staffRowName === requestStaffName)
        );
      });

      const code = getStaffRowPersonCode(asStaffSalaryLookupRow(match));
      return code || requestStaffId;
    },
    [staffRows],
  );

  // ── Policy (localStorage) ──────────────────────────────────────────────────
  const policyScopeKey = String(organizationId || "global");

  const [policy, setPolicy] = useState(() =>
    loadPolicy(DEFAULT_OVERTIME_POLICY, policyScopeKey),
  );
  const [policyModalOpen, setPolicyModalOpen] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [backendPayrollPolicy, setBackendPayrollPolicy] =
    useState<PayrollPolicy | null>(null);
  const [backendPolicyLoading, setBackendPolicyLoading] = useState(false);

  const handlePolicySave = useCallback(
    (nextPolicy: typeof policy) => {
      // Keep local UI policy and also attempt to persist OT rate to backend
      (async () => {
        setPolicySaving(true);
        try {
          setPolicy(nextPolicy);
          persistPolicy(nextPolicy, policyScopeKey);

          if (organizationId) {
            const merged: PayrollPolicy = {
              ...DEFAULT_PAYROLL_POLICY,
              ...(backendPayrollPolicy || {}),
              otRatePerHour: Number(nextPolicy.fixedRatePerHour) || 0,
            };
            try {
              const saved = await savePayrollPolicy(organizationId, merged);
              setBackendPayrollPolicy(saved);
            } catch (err) {
              toastError("Failed to persist OT rate to backend");
              console.error("Failed to save payroll policy to backend:", err);
            }
          }

          toastSuccess("Pay policy saved");
        } catch (err) {
          toastError("Failed to save pay policy");
          console.error("Failed to persist overtime pay policy:", err);
        } finally {
          setTimeout(() => {
            setPolicySaving(false);
            setPolicyModalOpen(false);
          }, 250);
        }
      })();
    },
    [policyScopeKey, organizationId, backendPayrollPolicy],
  );

  // ── UI-only state ──────────────────────────────────────────────────────────
  const [selectedRequest, setSelectedRequest] =
    useState<OvertimeRequest | null>(null);
  const [rejectTarget, setRejectTarget] = useState<OvertimeRequest | null>(
    null,
  );

  // ── Single source: ModuleContext.overtime ──────────────────────────────────
  const scopedRequests = useMemo<OvertimeRequest[]>(() => {
    const source = overtime.allItems;
    const branchScoped = isGlobalDashboard
      ? source
      : source.filter((r) =>
          matchesBranchScope(r.branchId, effectiveBranchId ?? fallbackBranchId),
        );

    if (!modulePeopleTypes.length) return branchScoped;

    return branchScoped.filter((request) => {
      const r = request as unknown as Record<string, unknown>;
      const requestPeopleType = normalizePeopleType(
        r.peopleType ?? r.people_type ?? r.userType ?? "staff",
      );
      return modulePeopleTypes.includes(requestPeopleType);
    });
  }, [
    overtime.allItems,
    isGlobalDashboard,
    effectiveBranchId,
    fallbackBranchId,
    modulePeopleTypes,
  ]);

  // ── Filters/sort ───────────────────────────────────────────────────────────
  const {
    filters,
    query,
    sortKey,
    sortDir,
    setQuery,
    setBranch,
    setStatus,
    setDepartment,
    setPeriod,
    setHours,
    setCustomFrom,
    setCustomTo,
    setSortKey,
    setSortDir,
    branchOptions,
    departmentOptions,
    statusOptions,
    filteredRequests,
    reset: resetFilters,
  } = useOvertimeFilters({ scopedRequests, branches, isGlobalDashboard });

  // People-type filter (UI-only). Rendered only when the module supports multiple types.
  const [peopleFilter, setPeopleFilter] = useState<string>("staff");

  const peopleOptions = useMemo(() => {
    if (!modulePeopleTypes || modulePeopleTypes.length === 0)
      return [] as { value: string; label: string }[];
    return modulePeopleTypes.map((p) => ({
      value: p,
      label: p[0].toUpperCase() + p.slice(1),
    }));
  }, [modulePeopleTypes]);

  // Keep the selected filter valid as entitlement changes (branch switch,
  // Support editing scope in another tab, "all" no longer being an option).
  // Prefers "staff" as the default when it's entitled; otherwise falls back
  // to the first entitled type — never hardcoded, always driven by
  // modulePeopleTypes for orgs where "staff" isn't in scope at all.
  useEffect(() => {
    if (!modulePeopleTypes.length) return;
    if (modulePeopleTypes.includes(peopleFilter)) return;
    setPeopleFilter(
      modulePeopleTypes.includes("staff") ? "staff" : modulePeopleTypes[0],
    );
  }, [modulePeopleTypes, peopleFilter]);

  // Fetch backend payroll policy for organization so UI estimates use same OT rate
  useEffect(() => {
    let cancelled = false;
    if (!organizationId) {
      setBackendPayrollPolicy(null);
      return;
    }
    setBackendPolicyLoading(true);
    (async () => {
      try {
        const p = await getPayrollPolicy(organizationId);
        if (!cancelled) setBackendPayrollPolicy(p);
      } catch (e) {
        console.error("Failed to load backend payroll policy:", e);
      } finally {
        if (!cancelled) setBackendPolicyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  useEffect(() => {
    if (embedded) return;

    if (previousPeopleFilterRef.current === null) {
      previousPeopleFilterRef.current = peopleFilter;
      void refresh();
      return;
    }

    if (previousPeopleFilterRef.current !== peopleFilter) {
      previousPeopleFilterRef.current = peopleFilter;
      void refresh();
    }
  }, [embedded, peopleFilter, refresh]);

  // Final filtered requests, narrowed to the selected people type. No "all"
  // branch anymore — the selector only ever holds one of modulePeopleTypes.
  const finalFilteredRequests = useMemo(() => {
    if (!peopleFilter) return filteredRequests;
    return filteredRequests.filter((r) => {
      const rr = r as unknown as Record<string, unknown>;
      const requestPeopleType = normalizePeopleType(
        rr.peopleType ?? rr.people_type ?? rr.userType ?? "staff",
      );
      return requestPeopleType === peopleFilter;
    });
  }, [filteredRequests, peopleFilter]);

  // ── Mutation ───────────────────────────────────────────────────────────────
  const handleStatusUpdate = useCallback(
    async (
      id: string,
      status: DecidableStatus,
      note?: string,
    ): Promise<void> => {
      const now = new Date().toISOString();
      const patch: Partial<OvertimeRequest> = {
        status,
        updatedAt: now,
        ...(status === "Rejected" ? { rejectionNote: note ?? null } : {}),
      };

      overtime.update(id, patch);

      setSelectedRequest((current) =>
        current?.id === id ? { ...current, ...patch } : current,
      );
      setRejectTarget(null);

      const apiId = String(id).trim();
      const target = overtime.allItems.find((r) => String(r.id) === String(id));
      const staffName = target ? getOvertimeStaffName(target) : id;
      if (apiId) {
        try {
          await updateOvertimeStatus(
            apiId,
            API_STATUS_MAP[status],
            "Admin",
            organizationId,
            status === "Rejected" ? note : null,
          );
          toastSuccess(
            `${staffName} ${status === "Approved" ? "approved" : "rejected"}`,
          );
        } catch (error) {
          toastError(
            `Failed to ${status === "Approved" ? "approve" : "reject"} overtime: ${String(error ?? "")}`,
          );
          console.error("Failed to sync overtime status with backend:", error);
        }
      }
    },
    [overtime, organizationId],
  );

  useLayoutEffect(() => {
    if (!highlightedOvertimeId) return;

    const row = document.getElementById(
      `overtime-row-${highlightedOvertimeId}`,
    );

    if (!row) return;

    row.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [finalFilteredRequests, highlightedOvertimeId]);

  // ── KPI stats ──────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const pending = finalFilteredRequests.filter(
      (r) => r.status === "Pending",
    ).length;
    const approved = finalFilteredRequests.filter(
      (r) => r.status === "Approved",
    ).length;
    const rejected = finalFilteredRequests.filter(
      (r) => r.status === "Rejected",
    ).length;
    const totalHours = finalFilteredRequests.reduce(
      (sum, r) => sum + r.hours,
      0,
    );
    const effectivePolicy = backendPayrollPolicy
      ? {
          ...policy,
          fixedRatePerHour:
            backendPayrollPolicy.otRatePerHour ?? policy.fixedRatePerHour,
        }
      : policy;
    const estimatedPay = finalFilteredRequests.reduce(
      (sum, r) =>
        sum +
        calculateOvertimePay(
          r.hours,
          effectivePolicy,
          getStaffMonthlySalary(r),
        ),
      0,
    );
    return { pending, approved, rejected, totalHours, estimatedPay };
  }, [finalFilteredRequests, policy, getStaffMonthlySalary]);

  // ── Export columns ─────────────────────────────────────────────────────────
  const exportColumns = useMemo<ExportExcelColumn<OvertimeRequest>[]>(
    () => [
      {
        header: "Employee",
        accessor: (row) => getOvertimeStaffName(row),
      },
      {
        header: "Employee ID",
        accessor: (row) => getOvertimeStaffId(row),
      },
      ...(isGlobalDashboard
        ? [
            {
              header: "Branch",
              accessor: (row: OvertimeRequest) =>
                row.branchName || `Branch ${row.branchId}`,
            },
          ]
        : []),
      {
        header: "Department",
        key: "department" as keyof OvertimeRequest,
      },
      {
        header: "Date",
        accessor: (row) => formatDate(getOvertimeDate(row)),
      },
      {
        header: "Hours",
        accessor: (row) => row.hours.toFixed(1),
        align: "right" as const,
      },
      {
        header: "Pay",
        accessor: (row) => {
          const effective = backendPayrollPolicy
            ? {
                ...policy,
                fixedRatePerHour:
                  backendPayrollPolicy.otRatePerHour ?? policy.fixedRatePerHour,
              }
            : policy;
          return `${policy.currencyLabel} ${calculateOvertimePay(row.hours, effective, getStaffMonthlySalary(row)).toLocaleString()}`;
        },
        align: "right" as const,
      },
      {
        header: "Status",
        key: "status" as keyof OvertimeRequest,
      },
      {
        header: "Applied On",
        accessor: (row) => formatDate(getOvertimeAppliedOn(row)),
      },
    ],
    [policy, getStaffMonthlySalary, isGlobalDashboard],
  );

  const mobileFilterSections: DynamicFilterSection[] = [
    ...(isGlobalDashboard
      ? [
          {
            id: "branch",
            type: "select" as const,
            label: "Branch",
            value: filters.branch,
            options: branchOptions.map(({ value, label, count }) => ({
              value,
              label,
              count,
            })),
            onChange: setBranch,
          },
        ]
      : []),
    ...(modulePeopleTypes.length > 1
      ? [
          {
            id: "people",
            type: "custom" as const,
            render: (
              <div>
                <label style={labelStyle}>People</label>
                <PeopleTypeSelector
                  value={peopleFilter}
                  onChange={setPeopleFilter}
                  options={peopleOptions}
                  ariaLabel="Filter overtime by people type"
                  minWidth={160}
                />
              </div>
            ),
          },
        ]
      : []),
    {
      id: "department",
      type: "select",
      label: "Department",
      value: filters.department,
      options: departmentOptions.map(({ value, label, count }) => ({
        value,
        label,
        count,
      })),
      onChange: setDepartment,
    },
    {
      id: "status",
      type: "select",
      label: "Status",
      value: filters.status,
      options: statusOptions.map(({ value, label, count }) => ({
        value,
        label,
        count,
      })),
      onChange: (value) => setStatus(value as typeof filters.status),
    },
    {
      id: "period",
      type: "select",
      label: "Period",
      value: filters.period,
      options: [
        { value: "all", label: "All Dates" },
        { value: "today", label: "Today" },
        { value: "7d", label: "Last 7 Days" },
        { value: "30d", label: "Last 30 Days" },
        { value: "month", label: "This Month" },
        { value: "custom", label: "Custom Range" },
      ],
      onChange: (value) => setPeriod(value as typeof filters.period),
    },
    {
      id: "hours",
      type: "select",
      label: "Hours",
      value: filters.hours,
      options: [
        { value: "all", label: "All Hours" },
        { value: "lt2", label: "Less than 2h" },
        { value: "2to4", label: "2h to 4h" },
        { value: "gt4", label: "More than 4h" },
      ],
      onChange: (value) => setHours(value as typeof filters.hours),
    },
    ...(filters.period === "custom"
      ? [
          {
            id: "customFrom",
            type: "custom" as const,
            render: (
              <div>
                <label style={labelStyle}>From</label>
                <input
                  type="date"
                  value={filters.customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                  style={inputStyle}
                />
              </div>
            ),
          },
          {
            id: "customTo",
            type: "custom" as const,
            render: (
              <div>
                <label style={labelStyle}>To</label>
                <input
                  type="date"
                  value={filters.customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                  style={inputStyle}
                />
              </div>
            ),
          },
        ]
      : []),
    {
      id: "sort",
      type: "select",
      label: "Sort By",
      value: sortKey,
      options: [
        { value: "date", label: "Date" },
        { value: "employee", label: "Employee" },
        { value: "hours", label: "Hours" },
        { value: "status", label: "Status" },
        { value: "appliedOn", label: "Applied On" },
        { value: "branch", label: "Branch" },
      ],
      onChange: (value) => setSortKey(value as typeof sortKey),
    },
    {
      id: "direction",
      type: "select",
      label: "Direction",
      value: sortDir,
      options: [
        { value: "desc", label: "Descending" },
        { value: "asc", label: "Ascending" },
      ],
      onChange: (value) => setSortDir(value as typeof sortDir),
    },
    {
      id: "search",
      type: "search",
      value: query,
      placeholder: "Employee, department, task...",
      onChange: setQuery,
      minWidth: 220,
    },
    {
      id: "reset",
      type: "reset",
      label: "Clear",
      onClick: resetFilters,
    },
  ];

  return (
    <div
      className="overtime-management-page"
      style={{
        padding: "24px 24px 48px",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
        background: T.bgPage,
        minHeight: "100%",
        minWidth: 0,
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      {!embedded && (
        <div
          className="overtime-page-header"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
            marginBottom: 18,
          }}
        >
          <div>
            <h1
              style={{
                margin: 0,
                fontSize: 22,
                fontWeight: 800,
                color: "#0F172A",
                letterSpacing: "-0.5px",
                fontFamily: "'DM Sans', 'Inter', sans-serif",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <CalendarDays size={22} color={T.teal600} />
              Overtime Management
            </h1>
            <p
              style={{
                margin: "4px 0 0",
                fontSize: 12,
                fontWeight: 500,
                color: "#64748B",
                fontFamily: "'DM Sans', 'Inter', sans-serif",
              }}
            >
              {new Date().toLocaleDateString("en-US", {
                weekday: "long",
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </p>
          </div>
          <div
            className="overtime-page-actions"
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            <DynamicFilterToolbar
              sections={mobileFilterSections}
              mobileOnly
              className="staff-management-mobile-filter"
            />
            <RefreshButton
              size="md"
              loading={refreshing}
              onClick={refresh}
              ariaLabel="Refresh overtime requests"
            />
            <ExportButton
              data={finalFilteredRequests}
              filename={`Overtime_${safeBranchName(fallbackBranchId, branches)}_${new Date().toISOString().split("T")[0]}`}
              organization={{
                name: cfg.orgName || undefined,
                logoUrl: cfg.logo,
              }}
              excel={{
                columns: exportColumns,
                title: "Overtime Report",
                reportPeriod: new Date().toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                }),
                summary: [
                  { label: "Pending", value: String(stats.pending) },
                  { label: "Approved", value: String(stats.approved) },
                  { label: "Total Hours", value: stats.totalHours.toFixed(1) },
                ],
              }}
              pdf={{
                columns: exportColumns,
                title: "Overtime Report",
                reportPeriod: new Date().toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                }),
                summary: [
                  { label: "Pending", value: String(stats.pending) },
                  { label: "Approved", value: String(stats.approved) },
                  { label: "Total Hours", value: stats.totalHours.toFixed(1) },
                ],
              }}
              emptyMessage="No overtime requests to export."
            />
            {/*<JellyButton
              type="button"
              variant="secondary"
              fillColor={T.navy700}
              leftIcon={<Settings size={14} />}
              onClick={() => setPolicyModalOpen(true)}
            >
              Pay Policy
            </JellyButton>*/}
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="overtime-stat-grid mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          title="Pending"
          value={stats.pending}
          icon={Clock}
          iconBg="#FEF3C7"
          iconColor="#c2410c"
        />
        <StatCard
          title="Approved"
          value={stats.approved}
          icon={CheckCircle}
          iconBg="#ECFDF5"
          iconColor="#16a34a"
        />
        <StatCard
          title="Rejected"
          value={stats.rejected}
          icon={XCircle}
          iconBg="#FFF1F2"
          iconColor="#e11d48"
        />
        <StatCard
          title="Total Hours"
          value={stats.totalHours.toFixed(1)}
          icon={TimerReset}
          iconBg="#E0F2FE"
          iconColor={T.teal600}
        />
        <StatCard
          title="Estimated Pay"
          value={`${policy.currencyLabel} ${stats.estimatedPay.toLocaleString()}`}
          icon={Banknote}
          iconBg="#E0F2FE"
          iconColor={T.navy600}
          sub={policyMethodLabel(policy)}
        />
      </div>

      {/* Filters */}
      <div
        className="overtime-filter-grid"
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          padding: 16,
          marginBottom: 18,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))",
          gap: 10,
          alignItems: "end",
        }}
      >
        {/* other filters first; search is intentionally placed near the end */}

        {isGlobalDashboard && (
          <div>
            <label style={labelStyle}>Branch</label>
            <ModernSelect
              value={filters.branch}
              onChange={setBranch}
              options={branchOptions.map((o) => ({
                value: o.value,
                label: o.label,
                description: o.count > 0 ? `${o.count} records` : undefined,
              }))}
              ariaLabel="Filter overtime by branch"
              width="100%"
              minWidth={140}
            />
          </div>
        )}

        {modulePeopleTypes.length > 1 && (
          <div>
            <label style={labelStyle}>People</label>
            <PeopleTypeSelector
              value={peopleFilter}
              onChange={setPeopleFilter}
              options={peopleOptions}
              ariaLabel="Filter overtime by people type"
              minWidth={160}
            />
          </div>
        )}

        <div>
          <label style={labelStyle}>Department</label>
          <ModernSelect
            value={filters.department}
            onChange={setDepartment}
            options={departmentOptions.map((o) => ({
              value: o.value,
              label: o.label,
              description: o.count > 0 ? `${o.count} records` : undefined,
            }))}
            ariaLabel="Filter overtime by department"
            width="100%"
            minWidth={160}
          />
        </div>

        <div>
          <label style={labelStyle}>Status</label>
          <ModernSelect
            value={filters.status}
            onChange={(value) => setStatus(value as typeof filters.status)}
            options={statusOptions.map((o) => ({
              value: o.value,
              label: o.label,
              description: o.count > 0 ? `${o.count} records` : undefined,
            }))}
            ariaLabel="Filter overtime by status"
            width="100%"
            minWidth={160}
          />
        </div>

        <div>
          <label style={labelStyle}>Period</label>
          <ModernSelect
            value={filters.period}
            onChange={(value) => setPeriod(value as typeof filters.period)}
            options={[
              { value: "all", label: "All Dates" },
              { value: "today", label: "Today" },
              { value: "7d", label: "Last 7 Days" },
              { value: "30d", label: "Last 30 Days" },
              { value: "month", label: "This Month" },
              { value: "custom", label: "Custom Range" },
            ]}
            ariaLabel="Filter overtime by period"
            width="100%"
            minWidth={160}
          />
        </div>

        <div>
          <label style={labelStyle}>Hours</label>
          <ModernSelect
            value={filters.hours}
            onChange={(value) => setHours(value as typeof filters.hours)}
            options={[
              { value: "all", label: "All Hours" },
              { value: "lt2", label: "Less than 2h" },
              { value: "2to4", label: "2h to 4h" },
              { value: "gt4", label: "More than 4h" },
            ]}
            ariaLabel="Filter overtime by hours"
            width="100%"
            minWidth={160}
          />
        </div>

        {filters.period === "custom" && (
          <>
            <div>
              <label style={labelStyle}>From</label>
              <input
                type="date"
                value={filters.customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>To</label>
              <input
                type="date"
                value={filters.customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                style={inputStyle}
              />
            </div>
          </>
        )}

        <div>
          <label style={labelStyle}>Sort By</label>
          <ModernSelect
            value={sortKey}
            onChange={(value) => setSortKey(value as typeof sortKey)}
            options={[
              { value: "date", label: "Date" },
              { value: "employee", label: "Employee" },
              { value: "hours", label: "Hours" },
              { value: "status", label: "Status" },
              { value: "appliedOn", label: "Applied On" },
              { value: "branch", label: "Branch" },
            ]}
            ariaLabel="Sort overtime requests"
            width="100%"
            minWidth={160}
          />
        </div>

        <div>
          <label style={labelStyle}>Direction</label>
          <ModernSelect
            value={sortDir}
            onChange={(value) => setSortDir(value as typeof sortDir)}
            options={[
              { value: "desc", label: "Descending" },
              { value: "asc", label: "Ascending" },
            ]}
            ariaLabel="Sort direction"
            width="100%"
            minWidth={160}
          />
        </div>
        <div
          className="overtime-filter-search"
          style={{
            gridColumn: "span 3",
            display: "flex",
            alignItems: "end",
            gap: 10,
            minWidth: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <label style={labelStyle}>Search</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Employee, department, task..."
              style={inputStyle}
              maxLength={100}
            />
          </div>

          <button
            type="button"
            onClick={resetFilters}
            style={{
              ...tinyButtonStyle,
              height: 38,
              display: "inline-flex",
              gap: 8,
              alignItems: "center",
              padding: "0 12px",
              background: T.card,
              flexShrink: 0,
            }}
            aria-label="Clear filters"
          >
            <RefreshCw size={14} color={T.teal600} />
            <span style={{ fontWeight: 900, fontSize: 12 }}>Clear</span>
          </button>
        </div>
      </div>

      {/* Table */}
      <div
        className="overtime-table-card"
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(15,45,74,0.06), 0 1px 2px rgba(15,45,74,0.04)",
        }}
      >
        <div className="overtime-table-scroll" style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              minWidth: isGlobalDashboard ? 980 : 850,
              borderCollapse: "collapse",
              textAlign: "left",
            }}
          >
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                {[
                  "Employee",
                  ...(isGlobalDashboard ? ["Branch"] : []),
                  "Department",
                  "Date",
                  "Hours",
                  "Pay",
                  "Status",
                  "Actions",
                ].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    style={{
                      padding: "12px 16px",
                      textAlign: "left",
                      fontSize: 10,
                      fontWeight: 900,
                      color: "#94a3b8",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      borderBottom: `1px solid ${T.border}`,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {finalFilteredRequests.map((request) => {
                const highlighted = String(request.id) === highlightedOvertimeId;
                const effective = backendPayrollPolicy
                  ? {
                      ...policy,
                      fixedRatePerHour:
                        backendPayrollPolicy.otRatePerHour ??
                        policy.fixedRatePerHour,
                    }
                  : policy;
                const pay = calculateOvertimePay(
                  request.hours,
                  effective,
                  getStaffMonthlySalary(request),
                );
                const cellStyle: React.CSSProperties = {
                  padding: "8px 16px",
                  verticalAlign: "middle",
                  borderBottom: highlighted
                    ? "1px solid #fed7aa"
                    : `1px solid ${T.slate100}`,
                };
                return (
                  <tr
                    id={`overtime-row-${request.id}`}
                    key={request.id}
                    className="overtime-table-row"
                    style={{
                      background: highlighted ? "#fff7ed" : "transparent",
                      boxShadow: highlighted
                        ? "inset 3px 0 0 #f97316"
                        : "none",
                    }}
                    onMouseEnter={(event) => {
                      if (!highlighted) {
                        event.currentTarget.style.background = "#f8fafc";
                      }
                    }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = highlighted
                        ? "#fff7ed"
                        : "transparent";
                    }}
                  >
                    <td style={cellStyle}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: T.body }}>
                        {getOvertimeStaffName(request)}
                      </div>
                      <div style={{ color: T.muted, fontSize: 11 }}>
                        {getStaffPersonCode(request)}
                      </div>
                    </td>
                    {isGlobalDashboard && (
                      <td
                        style={{
                          ...cellStyle,
                          color: T.navy600,
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {request.branchName}
                      </td>
                    )}
                    <td style={{ ...cellStyle, color: T.body, fontSize: 12 }}>
                      {request.department}
                    </td>
                    <td style={cellStyle}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: T.body }}>
                        {formatDate(getOvertimeDate(request))}
                      </div>
                      <div style={{ color: T.muted, fontSize: 10 }}>
                        Applied {formatDate(getOvertimeAppliedOn(request))}
                      </div>
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        fontSize: 12,
                        fontWeight: 800,
                        color: T.body,
                      }}
                    >
                      {request.hours.toFixed(1)}h
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        fontSize: 12,
                        fontWeight: 800,
                        color: T.teal600,
                      }}
                    >
                      {policy.currencyLabel} {pay.toLocaleString()}
                    </td>
                    <td style={cellStyle}>
                      <StatusBadge status={request.status} />
                    </td>
                    <td style={cellStyle}>
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <JellyButton
                          type="button"
                          variant="ghost"
                          iconOnly
                          leftIcon={<Eye size={14} />}
                          onClick={() => setSelectedRequest(request)}
                          title="View details"
                          aria-label="View overtime details"
                        />
                        {request.status === "Pending" && (
                          <>
                            <JellyButton
                              type="button"
                              variant="success"
                              size="sm"
                              onClick={async () => {
                                const confirmed = await confirmDialog({
                                  title: "Approve overtime?",
                                  text: `Approve overtime for ${getOvertimeStaffName(request)} on ${formatDate(getOvertimeDate(request))}?`,
                                  confirmButtonText: "Approve",
                                });
                                if (confirmed.isConfirmed) {
                                  void handleStatusUpdate(request.id, "Approved");
                                }
                              }}
                            >
                              Approve
                            </JellyButton>
                            <JellyButton
                              type="button"
                              variant="danger"
                              size="sm"
                              onClick={() => setRejectTarget(request)}
                            >
                              Reject
                            </JellyButton>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {finalFilteredRequests.length === 0 && (
                <tr>
                  <td
                    colSpan={isGlobalDashboard ? 8 : 7}
                    style={{
                      padding: "48px 16px",
                      textAlign: "center",
                      color: T.muted,
                      fontSize: 13,
                    }}
                  >
                    No overtime requests match the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail panel */}
      {selectedRequest && (
        <OvertimeDetailPanel
          request={selectedRequest}
          policy={policy}
          monthlySalary={getStaffMonthlySalary(selectedRequest)}
          personCode={getStaffPersonCode(selectedRequest)}
          onClose={() => setSelectedRequest(null)}
          onApprove={async (id) => {
            const confirmed = await confirmDialog({
              title: "Approve overtime?",
              text: `Approve overtime for ${getOvertimeStaffName(selectedRequest)} on ${formatDate(getOvertimeDate(selectedRequest))}?`,
              confirmButtonText: "Approve",
            });
            if (confirmed.isConfirmed) {
              void handleStatusUpdate(id, "Approved");
            }
          }}
          onReject={(request) => setRejectTarget(request)}
        />
      )}

      {/* Policy modal */}
      {/* {policyModalOpen && (
        <PolicySettingsModal
          policy={policy}
          onSave={handlePolicySave}
          onClose={() => setPolicyModalOpen(false)}
          saving={policySaving}
        />
      )} */}

      {/* Reject modal */}
      {rejectTarget && (
        <RejectReasonModal
          request={rejectTarget}
          onConfirm={(id, reason) => handleStatusUpdate(id, "Rejected", reason)}
          onClose={() => setRejectTarget(null)}
        />
      )}
    </div>
  );
};

export default OvertimeManagement;
