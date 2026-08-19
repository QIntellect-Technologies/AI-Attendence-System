/**
 * PayrollModule.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Current-context compatible payroll module.
 *
 * This version does not use useOrg().payrollStore because the current
 * OrgConfigContext exposes cfg/orgDummy, not payrollStore. Payroll rows and
 * edits come from usePayrollData(), which is the single payroll adapter for the
 * frontend until the backend is connected.
 */

import React, { useCallback, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import ModernSelect, {
  ModernSelectOption,
} from "../../components/ui/ModernSelect";
import {
  BarChart2,
  Building2,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  Edit2,
  Loader2,
  Settings,
  TrendingUp,
  Users,
  X,
  Zap,
} from "lucide-react";

import { useOrg } from "../../contexts/OrgConfigContext";
import { usePayrollData } from "./hooks/usePayrollData";
import type { PayrollRow } from "./hooks/usePayrollData";
import useBranchSelector from "../../hooks/useBranchSelector";
import BranchSelector from "../../components/ui/BranchSelector";
import { parseLocalDate, useDateFilter } from "../../hooks/useDateFilter";
import DateFilterBar from "../../components/ui/DateFilterBar";
import DynamicFilterToolbar, {
  type AmountOperator,
  type DynamicFilterSection,
  type SortDirection,
} from "../../components/ui/DynamicFilterToolbar";
import ExportButton from "../../components/ui/ExportButton";
import type { PdfPrimitive } from "../../components/ui/ExportPdfButton";
import RefreshButton from "../../components/ui/RefreshButton";
import { usePayrollPolicy } from "./hooks/usePayrollPolicy";
import { toastSuccess, toastError } from "../../utils/notifications";
import { formatDisplayDate } from "../../utils/formatDate";
import {
  DEFAULT_PAYROLL_POLICY,
  getPayrollPolicy,
  type PayrollPolicy,
  type LateComingMode,
  type AllowanceMode,
  type AllowanceType,
  type AppliedAllowance,
} from "./api/payrollApi";
const T = {
  teal600: "#0d9488",
  teal200: "#99f6e4",
  teal100: "#ccfbf1",
  teal50: "#f0fdfa",
  navy700: "#134471",
  navy600: "#164e63",
  slate200: "#e2e8f0",
  slate100: "#f1f5f9",
  slate50: "#f8fafc",
  green600: "#16a34a",
  green100: "#f0fdf4",
  red600: "#e11d48",
  amber600: "#d97706",
  amber100: "#fffbeb",
  blue500: "#0ea5e9",
  blue100: "#e0f2fe",
  bgPage: "#f5f6fa",
  bgCard: "#ffffff",
  border: "#e2e8f0",
  textHeading: "#1a699f",
  textBody: "#334155",
  textMuted: "#64748b",
  textLight: "#94a3b8",
  shadowCard: "0 1px 3px rgba(15,45,74,0.06),0 1px 2px rgba(15,45,74,0.04)",
  shadowMd: "0 4px 12px rgba(15,45,74,0.10)",
  shadowLg: "0 20px 60px rgba(12,35,64,0.2)",
} as const;

const MONTH_ABBRS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const PER_DAY_RATE_BASIS_OPTIONS: ModernSelectOption[] = [
  {
    value: "calendar_days",
    label: "Calendar Days",
    description: "Base Salary ÷ days in month",
  },
  {
    value: "fixed_days",
    label: "Fixed Working Days",
    description: "Base Salary ÷ a fixed day count",
  },
  {
    value: "scheduled_days",
    label: "Scheduled Days",
    description: "Base Salary ÷ staff's actual scheduled days",
  },
];

const LATE_COMING_MODE_OPTIONS: ModernSelectOption[] = [
  { value: "none", label: "No Automatic Deduction" },
  {
    value: "occurrence_threshold",
    label: "Occurrence Threshold",
    description: "N late arrivals = 1 half-day deduction",
  },
  {
    value: "flat_per_occurrence",
    label: "Flat Per Occurrence",
    description: "Fixed Rs. deducted per late arrival",
  },
  { value: "per_minute", label: "Per-Minute Rate", description: "Coming soon" },
];

const LEAVE_PAY_STATUS_OPTIONS: ModernSelectOption[] = [
  { value: "paid", label: "Paid" },
  { value: "unpaid", label: "Unpaid" },
];

const ALLOWANCE_MODE_OPTIONS: ModernSelectOption[] = [
  { value: "fixed", label: "Fixed (PKR)" },
  { value: "percent", label: "% of Basic" },
  { value: "none", label: "No Value" },
];

type ActiveTab = "records" | "trend" | "salary";
type PayrollSortKey = keyof Pick<
  PayrollRow,
  | "name"
  | "department"
  | "branchName"
  | "netPay"
  | "baseSalary"
  | "overtimeAmount"
  | "deductions"
  | "presentDays"
  | "unpaidLeaveDays"
  | "lateCount"
>;

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: T.slate50,
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  padding: "10px 14px",
  fontSize: 13,
  fontWeight: 600,
  color: T.textBody,
  outline: "none",
  boxSizing: "border-box",
};

const fmtPKR = (value: number): string =>
  `Rs. ${Math.round(value).toLocaleString("en-PK")}`;

function monthFromDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  return MONTH_ABBRS[parsed.getMonth()] ?? MONTH_ABBRS[new Date().getMonth()];
}

/** "YYYY-MM-DD" -> "Jan 05, 2026". Goes through `parseLocalDate` (not
 *  `new Date(str)`) so the export's period never off-by-ones for
 *  positive-UTC-offset timezones — see the note in useDateFilter.ts.
 *  Formatting itself delegates to `formatDisplayDate`, the one date format
 *  shared by every report/export surface — see utils/formatDate.ts. */
function formatReportDate(dateStr: string): string {
  return formatDisplayDate(parseLocalDate(dateStr));
}

const StatCard: React.FC<{
  label: string;
  value: string | number;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
}> = ({ label, value, icon: Icon, iconBg, iconColor }) => (
  <div
    style={{
      background: T.bgCard,
      border: `1px solid ${T.border}`,
      borderRadius: 16,
      boxShadow: T.shadowCard,
      padding: "20px 24px",
      display: "flex",
      flexDirection: "column",
      gap: 16,
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: T.textMuted,
        }}
      >
        {label}
      </span>
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon size={16} color={iconColor} strokeWidth={2} />
      </span>
    </div>
    <p
      style={{
        fontSize: 22,
        fontWeight: 800,
        color: T.navy700,
        margin: 0,
        letterSpacing: "-0.02em",
      }}
    >
      {value}
    </p>
  </div>
);

const DepartmentSplitCard: React.FC<{
  data: { name: string; total: number }[];
}> = ({ data }) => {
  const max = Math.max(...data.map((row) => row.total), 1);

  return (
    <div style={cardStyle}>
      <h3 style={cardTitleStyle}>Department Payroll Split</h3>
      <p style={cardSubStyle}>Net pay distribution by department</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {data.length === 0 ? (
          <EmptyState text="No department payroll data available." />
        ) : (
          data.map((row) => {
            const width = Math.max(8, (row.total / max) * 100);
            return (
              <div key={row.name}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    marginBottom: 5,
                    fontSize: 12,
                    fontWeight: 800,
                    color: T.textHeading,
                  }}
                >
                  <span>{row.name}</span>
                  <span>{fmtPKR(row.total)}</span>
                </div>
                <div
                  style={{
                    height: 7,
                    background: T.teal50,
                    borderRadius: 999,
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      height: "100%",
                      width: `${width}%`,
                      background: `linear-gradient(90deg, ${T.teal600}, ${T.navy700})`,
                      borderRadius: 999,
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

const BranchTrendCard: React.FC<{
  rows: PayrollRow[];
  branches: { id: number; name: string }[];
  selectedMonth: string;
}> = ({ rows, branches, selectedMonth }) => {
  const branchTotals = useMemo(() => {
    return branches.map((branch) => ({
      branch,
      total: rows
        .filter((row) => Number(row.branchId) === Number(branch.id))
        .reduce((sum: number, row: PayrollRow) => sum + row.netPay, 0),
    }));
  }, [branches, rows]);

  const max = Math.max(...branchTotals.map((item) => item.total), 1);

  return (
    <div style={cardStyle}>
      <h3 style={cardTitleStyle}>
        {branches.length === 1
          ? "Branch Payroll Trend"
          : "Branch Payroll Comparison"}
      </h3>
      <p style={cardSubStyle}>{selectedMonth} · net pay per branch · PKR</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {branchTotals.length === 0 ? (
          <EmptyState text="No branch payroll data available." />
        ) : (
          branchTotals.map(({ branch, total }) => {
            const width = Math.max(6, (total / max) * 100);
            return (
              <div key={branch.id}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "140px minmax(0, 1fr) 120px",
                    alignItems: "center",
                    gap: 12,
                    fontSize: 12,
                  }}
                >
                  <strong style={{ color: T.textHeading }}>
                    {branch.name}
                  </strong>
                  <div
                    style={{
                      height: 28,
                      background: T.slate50,
                      border: `1px solid ${T.border}`,
                      borderRadius: 8,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${width}%`,
                        background: `linear-gradient(90deg, ${T.teal100}, ${T.teal600})`,
                        borderRight: `6px solid ${T.navy700}`,
                      }}
                    />
                  </div>
                  <strong style={{ color: T.navy700, textAlign: "right" }}>
                    {fmtPKR(total)}
                  </strong>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

const SalaryConfigTab: React.FC<{
  rows: PayrollRow[];
  branches: { id: number; name: string }[];
  selectedBranchId?: number;
  onEditRow?: (row: PayrollRow) => void;
}> = ({ rows, branches, selectedBranchId, onEditRow }) => {
  const [expandedDepts, setExpandedDepts] = useState<Record<string, boolean>>(
    {},
  );

  const toggleDept = (key: string) => {
    setExpandedDepts((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const visibleBranches = selectedBranchId
    ? branches.filter((branch) => branch.id === selectedBranchId)
    : branches;

  const grouped = useMemo(() => {
    return visibleBranches.map((branch) => {
      const branchRows = rows.filter(
        (row) => Number(row.branchId) === branch.id,
      );
      const departments = Array.from(
        branchRows.reduce((map, row) => {
          const items = map.get(row.department) ?? [];
          items.push(row);
          map.set(row.department, items);
          return map;
        }, new Map<string, PayrollRow[]>()),
      );

      return { branch, departments };
    });
  }, [rows, visibleBranches]);

  return (
    <div style={cardStyle}>
      <h3 style={cardTitleStyle}>Salary Configuration</h3>
      <p style={cardSubStyle}>
        Click on any department to view and configure individual staff salaries.
      </p>

      {grouped.map(({ branch, departments }) => (
        <div key={branch.id} style={{ marginBottom: 18 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              background: T.teal50,
              border: `1px solid ${T.teal200}`,
              borderRadius: 12,
              padding: "12px 14px",
              marginBottom: 10,
            }}
          >
            <Building2 size={17} color={T.teal600} />
            <strong style={{ color: T.textHeading }}>{branch.name}</strong>
            <span style={{ fontSize: 11, color: T.textMuted }}>
              {departments.reduce((sum, [, items]) => sum + items.length, 0)}{" "}
              staff
            </span>
          </div>

          {departments.length === 0 ? (
            <EmptyState text={`No staff data for ${branch.name}.`} />
          ) : (
            departments.map(([department, members]) => {
              const deptKey = `${branch.id}:${department}`;
              const isExpanded = !!expandedDepts[deptKey];
              return (
                <div
                  key={deptKey}
                  style={{
                    border: `1px solid ${T.border}`,
                    borderRadius: 10,
                    marginBottom: 8,
                    background: T.bgCard,
                    overflow: "hidden",
                  }}
                >
                  <div
                    onClick={() => toggleDept(deptKey)}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "12px 14px",
                      cursor: "pointer",
                      background: isExpanded ? T.slate50 : T.bgCard,
                      transition: "background 0.2s",
                      userSelect: "none",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 800,
                          color: T.textHeading,
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {department}
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: T.teal600,
                            background: T.teal50,
                            border: `1px solid ${T.teal200}`,
                            borderRadius: 6,
                            padding: "1px 6px",
                          }}
                        >
                          {members.length} staff
                        </span>
                      </div>
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 11,
                          color: T.textMuted,
                        }}
                      >
                        Total net pay:{" "}
                        {fmtPKR(
                          members.reduce((sum, row) => sum + row.netPay, 0),
                        )}
                      </div>
                    </div>
                    <div>
                      {isExpanded ? (
                        <ChevronDown size={16} color={T.textMuted} />
                      ) : (
                        <ChevronRight size={16} color={T.textMuted} />
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div
                      style={{
                        borderTop: `1px solid ${T.slate100}`,
                        background: "#fff",
                        padding: "4px 8px 8px",
                      }}
                    >
                      {members.map((member) => (
                        <div
                          key={member.id}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "10px 10px",
                            borderBottom: `1px solid ${T.slate50}`,
                            gap: 12,
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              minWidth: 0,
                              flex: 1,
                            }}
                          >
                            <div
                              style={{
                                width: 28,
                                height: 28,
                                borderRadius: "50%",
                                flexShrink: 0,
                                background: `linear-gradient(135deg,${T.teal600},#0EA5E9)`,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: 11,
                                fontWeight: 700,
                                color: "#fff",
                              }}
                            >
                              {member.name.charAt(0)}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  fontWeight: 800,
                                  color: T.textHeading,
                                  fontSize: 12,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {member.name}
                              </div>
                              <div style={{ fontSize: 10, color: T.textLight }}>
                                {member.empId}
                              </div>
                              {member.cnic && (
                                <div
                                  style={{ fontSize: 10, color: T.textLight }}
                                >
                                  {member.cnic}
                                </div>
                              )}
                            </div>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 14,
                            }}
                          >
                            <div style={{ textAlign: "right" }}>
                              <div
                                style={{
                                  fontSize: 10,
                                  color: T.textMuted,
                                  fontWeight: 600,
                                }}
                              >
                                Base Salary
                              </div>
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: 800,
                                  color: T.navy700,
                                }}
                              >
                                {fmtPKR(member.baseSalary)}
                              </div>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onEditRow?.(member);
                              }}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 4,
                                background: "transparent",
                                border: `1px solid ${T.teal200}`,
                                borderRadius: 8,
                                padding: "6px 10px",
                                cursor: "pointer",
                                color: T.teal600,
                                fontSize: 11,
                                fontWeight: 700,
                                transition: "all 0.15s ease",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = T.teal50;
                                e.currentTarget.style.borderColor = T.teal600;
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background =
                                  "transparent";
                                e.currentTarget.style.borderColor = T.teal200;
                              }}
                            >
                              <Edit2 size={11} /> Configure
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      ))}
    </div>
  );
};

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      padding: 28,
      border: `1px dashed ${T.border}`,
      borderRadius: 12,
      background: T.slate50,
      color: T.textLight,
      fontSize: 13,
      textAlign: "center",
    }}
  >
    {text}
  </div>
);

const cardStyle: React.CSSProperties = {
  background: T.bgCard,
  border: `1px solid ${T.border}`,
  borderRadius: 16,
  boxShadow: T.shadowCard,
  padding: "22px 24px",
};

const cardTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 800,
  color: T.textHeading,
};

const cardSubStyle: React.CSSProperties = {
  margin: "3px 0 18px",
  fontSize: 11,
  color: T.textLight,
};

export default function PayrollModule() {
  const { branchId: branchIdParam } = useParams<{ branchId?: string }>();
  const { cfg, updateCfg, activeBranchId, organizationId } = useOrg();

  // Route param takes highest priority (branch dashboard pages).
  // Falls back to sidebar-selected branch (activeBranchId from OrgConfigContext).
  // Falls back to global (all branches) when neither is set.
  const scopedBranchId = branchIdParam
    ? Number(branchIdParam)
    : activeBranchId !== null
      ? activeBranchId
      : undefined;
  const isGlobal = scopedBranchId === undefined;
  const branchSelector = useBranchSelector("filter");
  const payrollDateFilter = useDateFilter("monthly");

  const otRatePerHour = cfg.payrollPolicy.otRatePerHour;
  const defaultSalary = cfg.payrollPolicy.defaultSalary;

  const [activeTab, setActiveTab] = useState<ActiveTab>("records");
  const [selectedPeopleType, setSelectedPeopleType] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [amountOperator, setAmountOperator] = useState<AmountOperator>("all");
  const [amountValue, setAmountValue] = useState("");
  const [sortKey, setSortKey] = useState<PayrollSortKey>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<PayrollRow | null>(null);
  const [draftSalary, setDraftSalary] = useState(0);
  // Per-staff OT rate override (salary_configs.ot_rate). Empty string means
  // "no override" — falls back to the org/branch default (otRatePerHour)
  // both here and on the backend (support_db_payroll.get_client_payroll_page).
  // OT Hours itself is never edited here — it's the real approved-hours
  // total from Overtime Management, shown read-only.
  const [draftOtRateOverride, setDraftOtRateOverride] = useState<string>("");
  // Per-staff allowance selection (salary_configs.applied_allowances) — which
  // of the org/branch's configured allowanceTypes this person gets, and any
  // per-person override value. Whole-object replace on save, same contract
  // as draftPolicy below.
  const [draftAppliedAllowances, setDraftAppliedAllowances] = useState<
    Record<string, AppliedAllowance>
  >({});
  const [draftPolicy, setDraftPolicy] = useState<PayrollPolicy>(
    DEFAULT_PAYROLL_POLICY,
  );
  const [newLeaveTypeKey, setNewLeaveTypeKey] = useState("");
  const [newAllowanceTypeKey, setNewAllowanceTypeKey] = useState("");

  const selectedMonth = useMemo(
    () => monthFromDate(payrollDateFilter.range.startDate),
    [payrollDateFilter.range.startDate],
  );

  const selectedYear = useMemo(
    () => payrollDateFilter.range.startDate.slice(0, 4),
    [payrollDateFilter.range.startDate],
  );

  // "YYYY-MM" for API calls — monthToPeriod() in usePayrollData requires
  // this exact shape to resolve a pay period. selectedMonth ("Jul") is
  // display-only and must never be passed to the API.
  const periodMonth = useMemo(
    () => payrollDateFilter.range.startDate.slice(0, 7),
    [payrollDateFilter.range.startDate],
  );

  const effectiveBranchId = isGlobal
    ? branchSelector.selectedBranchId
    : scopedBranchId;

  const {
    rows,
    stats,
    deptSummary,
    modulePeopleTypes,
    peopleType,
    updateBaseSalary,
    markPaid,
    markPending,
    refreshing,
    refresh,
  } = usePayrollData({
    branchId: effectiveBranchId,
    month: periodMonth,
    peopleType: selectedPeopleType,
  });

  const peopleOptions = useMemo(
    () =>
      modulePeopleTypes.map((type) => ({
        value: type,
        label: type.charAt(0).toUpperCase() + type.slice(1),
      })),
    [modulePeopleTypes],
  );

  const branchOptions = useMemo(
    () => cfg.branches.map((branch) => ({ id: branch.id, name: branch.name })),
    [cfg.branches],
  );

  const trendBranches = useMemo(() => {
    if (!effectiveBranchId) return branchOptions;
    return branchOptions.filter((branch) => branch.id === effectiveBranchId);
  }, [branchOptions, effectiveBranchId]);

  const contextLabel = isGlobal
    ? branchSelector.selectedBranchId
      ? branchSelector.selected.name
      : "All Branches"
    : (cfg.branches.find((branch) => branch.id === scopedBranchId)?.name ??
      "Branch");

  // Explicit "from date – to date" for the export header, independent of
  // payrollDateFilter.label (which collapses to just "January 2026" for
  // the monthly view — the export always wants both hard boundaries).
  const reportPeriodLabel = useMemo(
    () =>
      `${formatReportDate(payrollDateFilter.range.startDate)} – ${formatReportDate(
        payrollDateFilter.range.endDate,
      )}`,
    [payrollDateFilter.range.startDate, payrollDateFilter.range.endDate],
  );

  // Org identity fed into ExportButton — rendered in the header band of
  // both the Excel workbook and the PDF.
  const exportOrganization = useMemo(
    () => ({ name: cfg.orgName || undefined, logoUrl: cfg.logo }),
    [cfg.orgName, cfg.logo],
  );

  // Single source of truth for the export table shape — Excel and PDF used
  // to carry two hand-duplicated ~14-field column lists that only
  // differed by PKR formatting/alignment, which is exactly the kind of
  // drift that lets one format silently fall out of sync with the other.
  // `staffId` (an internal UUID, not something anyone downstream needs)
  // and `branchName` are deliberately left out — see chat request to drop
  // both from every export.
  //
  // "Rs" currency format for Excel cells — the native numeric value stays
  // sortable/summable in the spreadsheet while still displaying formatted,
  // unlike the PDF path which has to bake the currency symbol into a
  // string via `pdfAccessor`. `numFmt` is a no-op for any column whose
  // accessor isn't numeric.
  const PKR_NUM_FMT = '"Rs" #,##0';

  const payrollExportFields = useMemo<
    Array<{
      header: string;
      /** Raw value — used as-is for the Excel cell's native value. */
      accessor: (row: PayrollRow) => PdfPrimitive;
      /** Formatted override for the PDF (e.g. currency). Falls back to
       *  `accessor` when omitted. Typed explicitly (rather than left to
       *  array-literal inference) so every element has the same shape and
       *  `.pdfAccessor` is safe to read on all of them below. */
      pdfAccessor?: (row: PayrollRow) => PdfPrimitive;
      align?: "left" | "right" | "center";
      /** Excel number format — set on currency columns so the cell renders
       *  as native, formatted currency instead of a plain number/string. */
      numFmt?: string;
    }>
  >(
    () => [
      { header: "Employee ID", accessor: (row: PayrollRow) => row.empId },
      { header: "Name", accessor: (row: PayrollRow) => row.name },
      { header: "CNIC", accessor: (row: PayrollRow) => row.cnic },
      { header: "Department", accessor: (row: PayrollRow) => row.department },
      {
        header: "Base Salary",
        accessor: (row: PayrollRow) => row.baseSalary,
        pdfAccessor: (row: PayrollRow) => fmtPKR(row.baseSalary),
        align: "right" as const,
        numFmt: PKR_NUM_FMT,
      },
      {
        header: "Allowances",
        accessor: (row: PayrollRow) => row.allowances,
        pdfAccessor: (row: PayrollRow) => fmtPKR(row.allowances),
        align: "right" as const,
        numFmt: PKR_NUM_FMT,
      },
      {
        header: "Present Days",
        accessor: (row: PayrollRow) => row.presentDays,
        align: "right" as const,
      },
      {
        header: "OT Hours",
        accessor: (row: PayrollRow) => row.otHours,
        align: "right" as const,
      },
      {
        header: "OT Rate/hr",
        accessor: (row: PayrollRow) => row.otRate,
        pdfAccessor: (row: PayrollRow) => fmtPKR(row.otRate),
        align: "right" as const,
        numFmt: PKR_NUM_FMT,
      },
      {
        header: "OT Pay",
        accessor: (row: PayrollRow) => row.overtimeAmount,
        pdfAccessor: (row: PayrollRow) => fmtPKR(row.overtimeAmount),
        align: "right" as const,
        numFmt: PKR_NUM_FMT,
      },
      {
        header: "Late Comings",
        accessor: (row: PayrollRow) => row.lateCount,
        align: "right" as const,
      },
      {
        header: "Unpaid Leaves",
        accessor: (row: PayrollRow) => row.unpaidLeaveDays,
        align: "right" as const,
      },
      {
        header: "Deductions",
        accessor: (row: PayrollRow) => row.deductions,
        pdfAccessor: (row: PayrollRow) => fmtPKR(row.deductions),
        align: "right" as const,
        numFmt: PKR_NUM_FMT,
      },
      {
        header: "Net Salary",
        accessor: (row: PayrollRow) => row.netPay,
        pdfAccessor: (row: PayrollRow) => fmtPKR(row.netPay),
        align: "right" as const,
        numFmt: PKR_NUM_FMT,
      },
      { header: "Status", accessor: (row: PayrollRow) => row.status },
    ],
    [otRatePerHour],
  );

  const payrollExcelColumns = useMemo(
    () =>
      payrollExportFields.map(({ header, accessor, align, numFmt }) => ({
        header,
        accessor,
        align,
        numFmt,
      })),
    [payrollExportFields],
  );

  const payrollPdfColumns = useMemo(
    () =>
      payrollExportFields.map(({ header, accessor, pdfAccessor, align }) => ({
        header,
        accessor: pdfAccessor ?? accessor,
        align,
      })),
    [payrollExportFields],
  );

  const visibleRows = useMemo<PayrollRow[]>(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const amount = Number(amountValue);
    const shouldFilterByAmount =
      amountOperator !== "all" &&
      amountValue.trim() !== "" &&
      Number.isFinite(amount);

    const matchesAmount = (value: number): boolean => {
      if (!shouldFilterByAmount) return true;
      if (amountOperator === "lt") return value < amount;
      if (amountOperator === "lte") return value <= amount;
      if (amountOperator === "eq") return value === amount;
      if (amountOperator === "gte") return value >= amount;
      if (amountOperator === "gt") return value > amount;
      return true;
    };

    const filtered = rows.filter((row: PayrollRow) => {
      const searchable = [
        row.name,
        row.empId,
        row.cnic,
        row.staffId,
        row.department,
        row.branchName,
        row.status,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchable.includes(normalizedQuery) && matchesAmount(row.netPay);
    });

    if (sortDirection === "none") return filtered;

    return [...filtered].sort((a: PayrollRow, b: PayrollRow) => {
      const left = a[sortKey];
      const right = b[sortKey];
      const direction = sortDirection === "asc" ? 1 : -1;

      if (typeof left === "number" && typeof right === "number") {
        return (left - right) * direction;
      }

      return (
        String(left ?? "").localeCompare(String(right ?? ""), undefined, {
          numeric: true,
          sensitivity: "base",
        }) * direction
      );
    });
  }, [amountOperator, amountValue, rows, searchQuery, sortDirection, sortKey]);

  const resetListFilters = useCallback(() => {
    setSearchQuery("");
    setAmountOperator("all");
    setAmountValue("");
    setSortKey("name");
    setSortDirection("asc");
    branchSelector.reset();
    payrollDateFilter.setMode("monthly");
  }, [branchSelector, payrollDateFilter]);

  const payrollFilterSections = useMemo<DynamicFilterSection[]>(
    () => [
      {
        id: "branch",
        type: "custom",
        hidden: !isGlobal,
        render: (
          <BranchSelector
            branches={branchSelector.selectorBranches}
            selected={branchSelector.selected}
            onChange={branchSelector.onChange}
          />
        ),
      },
      {
        id: "date",
        type: "custom",
        // Payroll only ever pays out on a monthly cycle — no daily/weekly/
        // custom filtering makes sense here. Restricting `modes` hides
        // those buttons for this instance only; every other page's
        // DateFilterBar/useDateFilter is untouched.
        render: (
          <DateFilterBar
            filter={payrollDateFilter}
            modes={["monthly"]}
            compact
          />
        ),
      },
      {
        id: "peopleType",
        type: "select",
        label: "People",
        hidden: modulePeopleTypes.length <= 1,
        value: peopleType,
        options: peopleOptions,
        minWidth: 160,
        onChange: (value: string) => setSelectedPeopleType(value),
      },
      {
        id: "search",
        type: "search",
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: "Search name, ID, department, branch, status...",
        grow: true,
        minWidth: 300,
      },
      {
        id: "amountOperator",
        type: "select",
        label: "Net Salary Filter",
        value: amountOperator,
        minWidth: 156,
        options: [
          { value: "all", label: "All", description: "No salary filter" },
          { value: "lt", label: "Less than", description: "Below amount" },
          {
            value: "lte",
            label: "Less or equal",
            description: "At most amount",
          },
          { value: "eq", label: "Equal to", description: "Exact amount" },
          {
            value: "gte",
            label: "Greater or equal",
            description: "At least amount",
          },
          { value: "gt", label: "Greater than", description: "Above amount" },
        ],
        onChange: (value: string) => setAmountOperator(value as AmountOperator),
      },
      {
        id: "amountValue",
        type: "custom",
        render: (
          <input
            type="number"
            min={0}
            value={amountValue}
            onChange={(event) => setAmountValue(event.target.value)}
            placeholder="Net Salary"
            disabled={amountOperator === "all"}
            style={{
              height: 38,
              width: 132,
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              background: amountOperator === "all" ? T.slate50 : T.bgCard,
              color: T.textBody,
              fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
              fontSize: 12,
              fontWeight: 700,
              outline: "none",
              padding: "0 12px",
              opacity: amountOperator === "all" ? 0.55 : 1,
              boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
            }}
          />
        ),
      },
      {
        id: "sortKey",
        type: "select",
        label: "Sort By",
        value: sortKey,
        minWidth: 150,
        options: [
          { value: "name", label: "Name" },
          { value: "department", label: "Department" },
          { value: "branchName", label: "Branch" },
          { value: "netPay", label: "Net Salary" },
          { value: "baseSalary", label: "Base Salary" },
          { value: "overtimeAmount", label: "OT Pay" },
          { value: "lateCount", label: "Late Comings" },
          { value: "unpaidLeaveDays", label: "Unpaid Leaves" },
          { value: "deductions", label: "Deductions" },
          { value: "presentDays", label: "Present Days" },
        ],
        onChange: (value: string) => setSortKey(value as PayrollSortKey),
      },
      {
        id: "sortDirection",
        type: "select",
        label: "Sort Direction",
        value: sortDirection,
        minWidth: 176,
        options: [
          {
            value: "none",
            label: "No sort",
            description: "Keep original order",
          },
          {
            value: "asc",
            label: "Ascending",
            description: "A → Z / Low → High",
          },
          {
            value: "desc",
            label: "Descending",
            description: "Z → A / High → Low",
          },
        ],
        onChange: (value: string) => setSortDirection(value as SortDirection),
      },
      {
        id: "reset",
        type: "reset",
        label: "Clear",
        onClick: resetListFilters,
      },
    ],
    [
      amountOperator,
      amountValue,
      branchSelector,
      isGlobal,
      modulePeopleTypes,
      payrollDateFilter,
      peopleOptions,
      peopleType,
      resetListFilters,
      searchQuery,
      sortDirection,
      sortKey,
    ],
  );

  // After
  const tableColumns = useMemo(
    () => [
      { key: "#", label: "#" },
      { key: "name", label: "Name" },
      { key: "cnic", label: "CNIC" },
      ...(isGlobal ? [{ key: "branch", label: "Branch" }] : []),
      { key: "dept", label: "Department" },
      { key: "base", label: "Base Salary" },
      { key: "allowances", label: "Allowances" },
      { key: "present", label: "Present" },
      { key: "otHrs", label: "OT Hrs" },
      { key: "otRate", label: "OT Rate/hr" },
      { key: "otPay", label: "OT Pay" },
      { key: "lateComings", label: "Late Comings" },
      { key: "unpaidLeaves", label: "Unpaid Leaves" },
      { key: "deductions", label: "Deductions" },
      { key: "net", label: "Net Salary" },
      { key: "status", label: "Status" },
      { key: "action", label: "" },
    ],
    [isGlobal],
  );

  const openEditModal = useCallback((row: PayrollRow) => {
    setEditingRow(row);
    setDraftSalary(row.baseSalary);
    // Prefill from the raw override (0 = none set), not the effective rate,
    // so an untouched field genuinely means "no override" on save rather
    // than silently pinning today's org default onto this one staff member.
    setDraftOtRateOverride(
      row.otRateOverride ? String(row.otRateOverride) : "",
    );
    setDraftAppliedAllowances(row.appliedAllowances ?? {});
    setIsEditModalOpen(true);
  }, []);

  // The allowance catalog (which types exist, their label/mode/default
  // value) shown in the Edit Payroll modal below must reflect *this staff
  // member's* effective policy, not always the org-wide default — a
  // branch can override the catalog (e.g. a different Transport amount),
  // and getPayrollPolicy's staffId scope already resolves the backend's
  // individual > branch > org precedence for us (see PayrollPolicyScope
  // in payrollApi.ts). Re-fetched fresh each time the modal opens for a
  // row rather than reused from cfg.payrollPolicy, which only ever holds
  // the org-wide default.
  const [editingRowAllowanceTypes, setEditingRowAllowanceTypes] = useState<
    Record<string, AllowanceType>
  >({});
  const [editingRowAllowanceTypesLoading, setEditingRowAllowanceTypesLoading] =
    useState(false);
  React.useEffect(() => {
    let cancelled = false;
    if (!isEditModalOpen || !editingRow || !organizationId) {
      setEditingRowAllowanceTypes({});
      return undefined;
    }
    setEditingRowAllowanceTypesLoading(true);
    getPayrollPolicy(organizationId, { staffId: editingRow.staffId })
      .then((effectivePolicy) => {
        if (!cancelled)
          setEditingRowAllowanceTypes(effectivePolicy.allowanceTypes ?? {});
      })
      .catch(() => {
        // Fall back to the org-wide default rather than showing nothing —
        // still better than blocking the modal on a transient fetch error.
        if (!cancelled)
          setEditingRowAllowanceTypes(cfg.payrollPolicy.allowanceTypes ?? {});
      })
      .finally(() => {
        if (!cancelled) setEditingRowAllowanceTypesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isEditModalOpen,
    editingRow,
    organizationId,
    cfg.payrollPolicy.allowanceTypes,
  ]);

  const [togglingStaffId, setTogglingStaffId] = useState<string | null>(null);

  const handleToggleStatus = useCallback(
    async (row: PayrollRow) => {
      const key = String(row.staffId);
      if (togglingStaffId === key) return;
      setTogglingStaffId(key);
      try {
        if (row.status === "Paid") {
          await markPending(row.staffId);
        } else {
          await markPaid(row.staffId);
        }
      } finally {
        setTogglingStaffId((current) => (current === key ? null : current));
      }
    },
    [markPaid, markPending, togglingStaffId],
  );

  const [savingEdit, setSavingEdit] = useState(false);
  const [saveEditError, setSaveEditError] = useState<string | null>(null);

  const handleSaveEdit = useCallback(async () => {
    if (!editingRow) return;
    setSavingEdit(true);
    setSaveEditError(null);
    try {
      // Blank field -> 0 -> "no override, use org/branch default" on the
      // backend (support_db_payroll: `salary_config.get('ot_rate') or
      // policy.get('otRatePerHour')`). Sent explicitly (not omitted) so
      // clearing a previously-set override actually persists as cleared.
      const otRate =
        draftOtRateOverride.trim() === "" ? 0 : Number(draftOtRateOverride);
      // effective_from is a real calendar date on the backend (when this
      // edit took effect), not the report period currently being viewed —
      // periodMonth ("YYYY-MM") is the wrong shape and the wrong value
      // here (it would misdate the change to whichever month's report
      // happens to be open, and Postgres rejects it as an invalid date
      // besides). Omit it and let updateBaseSalary default to today.
      await updateBaseSalary(
        editingRow.staffId,
        Number(draftSalary),
        undefined,
        { otRate, appliedAllowances: draftAppliedAllowances },
      );
      setIsEditModalOpen(false);
      setEditingRow(null);
    } catch (err) {
      setSaveEditError(
        err instanceof Error ? err.message : "Failed to save payroll changes.",
      );
    } finally {
      setSavingEdit(false);
    }
  }, [
    draftAppliedAllowances,
    draftOtRateOverride,
    draftSalary,
    editingRow,
    updateBaseSalary,
  ]);

  // Payroll Rules modal scope is derived from where the person already is
  // — the route/sidebar branch context (`scopedBranchId`/`isGlobal`,
  // computed above from `useParams`/`activeBranchId`) — never from a
  // switcher inside the modal. This is deliberate, not a missing feature:
  // an in-modal org/branch/staff picker would let anyone who can open a
  // branch dashboard also reach up and overwrite the org-wide default
  // every other branch falls back to. Opening Payroll Rules from the
  // org-level ("All Branches") page edits the org default; opening it
  // from a specific branch's dashboard edits that branch's override only.
  //
  // Deliberately NOT `effectiveBranchId` — that also folds in the
  // page-local branch *filter* dropdown (branchSelector), which is
  // display-only and must never change what gets written.
  const rulesBranch = useMemo(
    () =>
      isGlobal
        ? null
        : (cfg.branches.find((branch) => branch.id === scopedBranchId) ?? null),
    [isGlobal, scopedBranchId, cfg.branches],
  );
  // payroll_policy_overrides is keyed on the backend branch UUID, not
  // cfg.branches' numeric UI id (see rulesBranchOptions' former filter —
  // same constraint). A branch that hasn't finished syncing yet has no
  // UUID, so it can't hold an override; surfaced as a blocking notice in
  // the modal rather than silently falling back to an org-wide save.
  const rulesBranchId: string | null = rulesBranch?.backendBranchId ?? null;
  const rulesBranchUnavailable = !isGlobal && !rulesBranchId;

  const {
    policy,
    loading: policyLoading,
    saving: policySaving,
    error: policyError,
    save: savePolicy,
  } = usePayrollPolicy({ branchId: rulesBranchId });

  // Keep the draft in sync with the effective policy for the current
  // (implicit) scope — fires on open, and again if the person navigates
  // to a different branch while the modal happens to be open.
  React.useEffect(() => {
    if (isRulesModalOpen) setDraftPolicy(policy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, isRulesModalOpen]);

  const openRulesModal = useCallback(() => {
    setDraftPolicy(policy);
    setIsRulesModalOpen(true);
  }, [policy]);

  const handleSaveRules = useCallback(async () => {
    try {
      await savePolicy(draftPolicy);
      if (isGlobal) {
        // usePayrollPolicy's own `policy` state is now fresh, but that
        // hook instance is local to this modal — it's not what the
        // payroll table reads. usePayrollData derives each row's
        // org-default OT rate from OrgConfigContext's `cfg.payrollPolicy`
        // (see usePayrollData.ts:719), which is only populated at org
        // bootstrap and otherwise never invalidated. Without this patch
        // the table silently keeps showing the stale rate until a full
        // page reload re-fetches org config.
        updateCfg({ payrollPolicy: draftPolicy });
      } else {
        // A branch override must never touch the shared org-wide cfg —
        // that's the global default every *other* branch falls back to.
        // Instead, force-refetch this branch's payroll rows so the
        // backend-resolved effective_ot_rate (support_db_payroll's
        // resolve_effective_ot_rate) reflects the new override
        // immediately, same as the org path but via the table's own data
        // source rather than the shared cache.
        void refresh({ force: true });
      }
      setIsRulesModalOpen(false);
      toastSuccess(
        isGlobal
          ? "Payroll rules saved for the organization"
          : `Payroll rules saved for ${rulesBranch?.name ?? "this branch"}`,
      );
    } catch {
      toastError("Failed to save payroll rules");
      // Failure stays visible via policyError inline in the modal — the
      // modal deliberately stays open so the person doesn't lose their
      // edited policy and can retry without re-entering everything.
    }
  }, [draftPolicy, savePolicy, isGlobal, updateCfg, refresh, rulesBranch]);

  const rulesScopeSummary = useMemo(() => {
    if (isGlobal) {
      return "Saved org-wide — the default every branch and staff member falls back to unless they have their own override.";
    }
    if (rulesBranchUnavailable) {
      return "This branch hasn't finished syncing yet, so it can't hold its own payroll rules. Try again once setup completes, or edit rules from the organization-wide Payroll page.";
    }
    return `Overrides the org default for ${rulesBranch?.name ?? "this branch"} only — other branches and the org default are unaffected.`;
  }, [isGlobal, rulesBranchUnavailable, rulesBranch]);

  const tabStyle = (tab: ActiveTab): React.CSSProperties => ({
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
    background: activeTab === tab ? T.navy700 : "transparent",
    color: activeTab === tab ? "#fff" : T.textMuted,
  });

  return (
    <div
      style={{
        minHeight: "100%",
        background: T.bgPage,
        padding: "24px 24px 48px",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
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
              fontSize: 24,
              fontWeight: 900,
              color: T.textHeading,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <DollarSign size={22} color={T.teal600} />
            Payroll Management
          </h1>
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <RefreshButton
            size="md"
            loading={refreshing}
            onClick={refresh}
            ariaLabel="Refresh payroll data"
          />
          <ExportButton
            filename={`Payroll_${contextLabel}_${selectedMonth}_${selectedYear}`}
            data={visibleRows}
            organization={exportOrganization}
            excel={{
              columns: payrollExcelColumns,
            }}
            pdf={{
              title: "Payroll Report",
              titleTag: `${selectedMonth} ${selectedYear}`,
              reportPeriod: reportPeriodLabel,
              otRatePerHour: otRatePerHour,
              summary: [
                { label: "Total Pay-out", value: fmtPKR(stats.totalPayout) },
                { label: "Total OT Paid", value: fmtPKR(stats.totalOT) },
                { label: "Employees", value: String(stats.totalStaff) },
              ],
              columns: payrollPdfColumns,
            }}
            style={{
              background: T.bgCard,
              border: `1px solid ${T.border}`,
              color: T.textBody,
              boxShadow: T.shadowCard,
              fontWeight: 600,
            }}
          />
          <button
            onClick={openRulesModal}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              background: T.navy700,
              border: "none",
              borderRadius: 10,
              padding: "9px 16px",
              fontSize: 12,
              fontWeight: 700,
              color: "#fff",
              cursor: "pointer",
              boxShadow: T.shadowMd,
            }}
          >
            <Settings size={14} color="#fff" /> Payroll Rules
          </button>
        </div>
      </div>

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
          style={tabStyle("records")}
          onClick={() => setActiveTab("records")}
        >
          <BarChart2 size={13} /> Records
        </button>
        <button style={tabStyle("trend")} onClick={() => setActiveTab("trend")}>
          <TrendingUp size={13} /> Trend
        </button>
        <button
          style={tabStyle("salary")}
          onClick={() => setActiveTab("salary")}
        >
          <DollarSign size={13} /> Salary Config
        </button>
      </div>

      {activeTab !== "salary" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 16,
            marginBottom: 16,
          }}
        >
          <StatCard
            label="Total Pay-out"
            value={fmtPKR(stats.totalPayout)}
            icon={DollarSign}
            iconBg={T.teal100}
            iconColor={T.teal600}
          />
          <StatCard
            label="Total OT Paid"
            value={fmtPKR(stats.totalOT)}
            icon={Zap}
            iconBg="#d1e8f0"
            iconColor={T.navy600}
          />
          <StatCard
            label="Employees"
            value={stats.totalStaff}
            icon={Users}
            iconBg={T.blue100}
            iconColor={T.blue500}
          />
          <StatCard
            label="Status"
            value={stats.status}
            icon={Clock}
            iconBg={stats.status === "Paid" ? T.green100 : T.amber100}
            iconColor={stats.status === "Paid" ? T.green600 : T.amber600}
          />
        </div>
      )}

      <DynamicFilterToolbar
        sections={payrollFilterSections}
        bordered
        style={{ marginBottom: activeTab !== "salary" ? 24 : 20 }}
      />

      {activeTab === "records" && (
        <div
          style={{
            background: T.bgCard,
            border: `1px solid ${T.border}`,
            borderRadius: 16,
            boxShadow: T.shadowCard,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "16px 24px",
              borderBottom: `1px solid ${T.slate100}`,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span
              style={{ fontSize: 13, fontWeight: 700, color: T.textHeading }}
            >
              Employee Payroll
            </span>
            <span style={{ fontSize: 11, color: T.textMuted }}>
              {payrollDateFilter.label} · {visibleRows.length} records
            </span>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr style={{ background: T.slate50 }}>
                  {tableColumns.map((column) => (
                    <th
                      key={column.key}
                      style={{
                        padding: "12px 20px",
                        textAlign: [
                          "present",
                          "otHrs",
                          "lateComings",
                          "unpaidLeaves",
                        ].includes(column.key)
                          ? "center"
                          : "left",
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: T.textLight,
                        borderBottom: `1px solid ${T.border}`,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row: PayrollRow, index: number) => (
                  <tr
                    key={row.id}
                    style={{ borderBottom: `1px solid ${T.slate100}` }}
                  >
                    <td style={tableCellStyle}>{index + 1}</td>
                    <td style={tableCellStyle}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: "50%",
                            flexShrink: 0,
                            background: `linear-gradient(135deg,${T.teal600},#0EA5E9)`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 13,
                            fontWeight: 700,
                            color: "#fff",
                          }}
                        >
                          {row.name.charAt(0)}
                        </div>
                        <div>
                          <div
                            style={{ fontWeight: 800, color: T.textHeading }}
                          >
                            {row.name}
                          </div>
                          <div style={{ fontSize: 10, color: T.textLight }}>
                            {row.empId}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td style={tableCellStyle}>{row.cnic || "—"}</td>
                    {isGlobal && (
                      <td style={tableCellStyle}>
                        <Badge>{row.branchName}</Badge>
                      </td>
                    )}
                    <td style={tableCellStyle}>
                      <Badge color={T.teal600} bg={T.teal50}>
                        {row.department}
                      </Badge>
                    </td>
                    <td style={tableCellStyle}>{fmtPKR(row.baseSalary)}</td>
                    <td style={tableCellStyle}>{fmtPKR(row.allowances)}</td>
                    <td style={{ ...tableCellStyle, textAlign: "center" }}>
                      {row.presentDays}
                    </td>
                    <td style={{ ...tableCellStyle, textAlign: "center" }}>
                      {row.otHours}h
                    </td>
                    <td style={{ ...tableCellStyle, textAlign: "center" }}>
                      {fmtPKR(row.otRate)}
                    </td>
                    <td
                      style={{
                        ...tableCellStyle,
                        color: T.navy600,
                        fontWeight: 800,
                      }}
                    >
                      <BreakdownValue
                        amount={row.overtimeAmount}
                        prefix="+"
                        color={T.navy600}
                        lines={
                          row.breakdown
                            ? [
                                `${row.breakdown.overtimeHours}h × Rs.${row.otRate}/hr`,
                              ]
                            : []
                        }
                      />
                    </td>
                    <td
                      style={{
                        ...tableCellStyle,
                        textAlign: "center",
                        color: T.amber600,
                        fontWeight: 800,
                      }}
                    >
                      {row.lateCount}
                    </td>
                    <td
                      style={{
                        ...tableCellStyle,
                        textAlign: "center",
                        color: T.amber600,
                        fontWeight: 800,
                      }}
                    >
                      {row.unpaidLeaveDays}
                    </td>
                    <td
                      style={{
                        ...tableCellStyle,
                        color: T.red600,
                        fontWeight: 800,
                      }}
                    >
                      <BreakdownValue
                        amount={row.deductions}
                        prefix="−"
                        color={T.red600}
                        lines={
                          row.breakdown
                            ? [
                                row.breakdown.lateCount > 0
                                  ? `Late arrivals: ${row.breakdown.lateCount} → ${fmtPKR(row.breakdown.lateDeductionAmount)}`
                                  : "",
                                row.breakdown.halfDayAttendanceCount > 0 ||
                                row.breakdown.halfDayLeaveCount > 0
                                  ? `Half-days: ${row.breakdown.halfDayAttendanceCount + row.breakdown.halfDayLeaveCount} → ${fmtPKR(row.breakdown.halfDayDeductionAmount)}`
                                  : "",
                                row.breakdown.unpaidLeaveDays > 0
                                  ? `Unpaid leave: ${row.breakdown.unpaidLeaveDays}d → ${fmtPKR(row.breakdown.unpaidLeaveDeductionAmount)}`
                                  : "",
                                row.breakdown.attendanceLeaveConflictDays > 0
                                  ? `⚠ ${row.breakdown.attendanceLeaveConflictDays}d on file as leave but also attended — excluded from deduction`
                                  : "",
                              ].filter(Boolean)
                            : []
                        }
                      />
                    </td>
                    <td
                      style={{
                        ...tableCellStyle,
                        color: T.teal600,
                        fontWeight: 900,
                      }}
                    >
                      {fmtPKR(row.netPay)}
                    </td>
                    <td style={tableCellStyle}>
                      <button
                        onClick={() => handleToggleStatus(row)}
                        disabled={togglingStaffId === String(row.staffId)}
                        title={
                          row.status === "Paid"
                            ? "Marked paid — click to revert to Pending"
                            : "Click to mark this period as Paid"
                        }
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor:
                            togglingStaffId === String(row.staffId)
                              ? "default"
                              : "pointer",
                          opacity:
                            togglingStaffId === String(row.staffId) ? 0.6 : 1,
                        }}
                      >
                        <Badge
                          color={
                            row.status === "Paid" ? T.green600 : T.amber600
                          }
                          bg={row.status === "Paid" ? T.green100 : T.amber100}
                        >
                          {row.status}
                        </Badge>
                      </button>
                    </td>
                    <td style={tableCellStyle}>
                      <button
                        onClick={() => openEditModal(row)}
                        style={{
                          background: "none",
                          border: `1px solid ${T.border}`,
                          borderRadius: 8,
                          padding: "6px 8px",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          color: T.textMuted,
                        }}
                      >
                        <Edit2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}

                {visibleRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={tableColumns.length}
                      style={{
                        padding: 40,
                        textAlign: "center",
                        color: T.textLight,
                      }}
                    >
                      No payroll records match the selected filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "trend" && (
        <div className="payroll-trend-grid">
          <DepartmentSplitCard data={deptSummary} />
          <BranchTrendCard
            rows={visibleRows}
            branches={trendBranches}
            selectedMonth={selectedMonth}
          />
        </div>
      )}

      {activeTab === "salary" && (
        <SalaryConfigTab
          rows={visibleRows}
          branches={branchOptions}
          selectedBranchId={effectiveBranchId}
          onEditRow={openEditModal}
        />
      )}

      {isRulesModalOpen && (
        <Modal onClose={() => !policySaving && setIsRulesModalOpen(false)}>
          <h2 style={modalTitleStyle}>
            {isGlobal
              ? "Company Payroll Rules"
              : `Payroll Rules — ${rulesBranch?.name ?? "Branch"}`}
          </h2>
          <p style={modalSubStyle}>{rulesScopeSummary}</p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              marginBottom: 20,
            }}
          >
            <Field label="Default Base Salary">
              <input
                type="number"
                min={0}
                step="any"
                value={draftPolicy.defaultSalary}
                onChange={(event) =>
                  setDraftPolicy((p) => ({
                    ...p,
                    defaultSalary: Math.max(0, Number(event.target.value) || 0),
                  }))
                }
                style={inputStyle}
              />
            </Field>
            <Field label="OT Rate / Hour">
              <input
                type="number"
                min={0}
                step="any"
                value={draftPolicy.otRatePerHour}
                onChange={(event) =>
                  setDraftPolicy((p) => ({
                    ...p,
                    otRatePerHour: Math.max(0, Number(event.target.value) || 0),
                  }))
                }
                style={{
                  ...inputStyle,
                  background: T.teal50,
                  borderColor: T.teal200,
                }}
              />
            </Field>
          </div>

          <Field label="Per-Day Rate Basis (for leave/half-day deductions)">
            <ModernSelect
              value={draftPolicy.perDayRateBasis}
              onChange={(value) =>
                setDraftPolicy((p) => ({
                  ...p,
                  perDayRateBasis: value as PayrollPolicy["perDayRateBasis"],
                }))
              }
              ariaLabel="Per-day rate basis"
              width="100%"
              options={PER_DAY_RATE_BASIS_OPTIONS}
            />
          </Field>

          {draftPolicy.perDayRateBasis === "fixed_days" && (
            <Field label="Fixed Working Days / Month">
              <input
                type="number"
                min={1}
                max={31}
                value={draftPolicy.fixedWorkingDaysPerMonth}
                onChange={(event) =>
                  setDraftPolicy((p) => ({
                    ...p,
                    fixedWorkingDaysPerMonth: Math.min(
                      31,
                      Math.max(1, Number(event.target.value) || 1),
                    ),
                  }))
                }
                style={{ ...inputStyle, marginTop: 10 }}
              />
            </Field>
          )}

          <div style={{ marginTop: 20 }}>
            <Field label="Late-Coming Policy">
              <ModernSelect
                value={draftPolicy.lateComingPolicy.mode}
                onChange={(value) =>
                  setDraftPolicy((p) => ({
                    ...p,
                    lateComingPolicy: {
                      ...p.lateComingPolicy,
                      mode: value as LateComingMode,
                    },
                  }))
                }
                ariaLabel="Late-coming policy"
                width="100%"
                options={LATE_COMING_MODE_OPTIONS}
              />
            </Field>

            {draftPolicy.lateComingPolicy.mode === "occurrence_threshold" && (
              <Field label="Late Arrivals per Half-Day Deduction">
                <input
                  type="number"
                  min={1}
                  value={draftPolicy.lateComingPolicy.thresholdOccurrences ?? 3}
                  onChange={(event) =>
                    setDraftPolicy((p) => ({
                      ...p,
                      lateComingPolicy: {
                        ...p.lateComingPolicy,
                        thresholdOccurrences: Math.max(
                          1,
                          Number(event.target.value) || 1,
                        ),
                      },
                    }))
                  }
                  style={{ ...inputStyle, marginTop: 10 }}
                />
              </Field>
            )}

            {draftPolicy.lateComingPolicy.mode === "flat_per_occurrence" && (
              <Field label="Rs. Deducted per Late Occurrence">
                <input
                  type="number"
                  min={0}
                  value={
                    draftPolicy.lateComingPolicy.flatAmountPerOccurrence ?? 0
                  }
                  onChange={(event) =>
                    setDraftPolicy((p) => ({
                      ...p,
                      lateComingPolicy: {
                        ...p.lateComingPolicy,
                        flatAmountPerOccurrence: Math.max(
                          0,
                          Number(event.target.value) || 0,
                        ),
                      },
                    }))
                  }
                  style={{ ...inputStyle, marginTop: 10 }}
                />
              </Field>
            )}
          </div>

          <div style={{ marginTop: 20, marginBottom: 24 }}>
            <span
              style={{
                display: "block",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: T.textMuted,
                marginBottom: 8,
              }}
            >
              Leave Type — Paid / Unpaid / Annual Quota
            </span>

            {Object.entries(draftPolicy.leaveTypeRules).map(
              ([leaveType, status]) => (
                <div
                  key={leaveType}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 10px",
                    border: `1px solid ${T.border}`,
                    borderRadius: 8,
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{ fontSize: 12, fontWeight: 700, color: T.textBody }}
                  >
                    {leaveType}
                  </span>
                  <div
                    style={{ display: "flex", gap: 6, alignItems: "center" }}
                  >
                    <ModernSelect
                      value={status}
                      onChange={(value) =>
                        setDraftPolicy((p) => ({
                          ...p,
                          leaveTypeRules: {
                            ...p.leaveTypeRules,
                            [leaveType]: value as "paid" | "unpaid",
                          },
                        }))
                      }
                      ariaLabel={`${leaveType} pay status`}
                      width={110}
                      minWidth={110}
                      options={LEAVE_PAY_STATUS_OPTIONS}
                    />
                    <input
                      type="number"
                      min={0}
                      step={1}
                      title="Annual paid-day quota for this leave type"
                      aria-label={`${leaveType} annual quota`}
                      value={draftPolicy.leaveTypeQuotas[leaveType] ?? 0}
                      onChange={(event) => {
                        const quota = Math.max(
                          0,
                          Number(event.target.value) || 0,
                        );
                        setDraftPolicy((p) => ({
                          ...p,
                          leaveTypeQuotas: {
                            ...p.leaveTypeQuotas,
                            [leaveType]: quota,
                          },
                        }));
                      }}
                      style={{ ...inputStyle, width: 64, textAlign: "right" }}
                    />
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: T.textMuted,
                      }}
                    >
                      days/yr
                    </span>
                    <button
                      onClick={() =>
                        setDraftPolicy((p) => {
                          const nextRules = { ...p.leaveTypeRules };
                          delete nextRules[leaveType];
                          const nextQuotas = { ...p.leaveTypeQuotas };
                          delete nextQuotas[leaveType];
                          return {
                            ...p,
                            leaveTypeRules: nextRules,
                            leaveTypeQuotas: nextQuotas,
                          };
                        })
                      }
                      style={{
                        border: "none",
                        background: "none",
                        color: T.red600,
                        cursor: "pointer",
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ),
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                placeholder="e.g. sick, casual, annual"
                value={newLeaveTypeKey}
                onChange={(event) => setNewLeaveTypeKey(event.target.value)}
                style={inputStyle}
              />
              <button
                onClick={() => {
                  const key = newLeaveTypeKey.trim().toLowerCase();
                  if (!key || draftPolicy.leaveTypeRules[key]) return;
                  setDraftPolicy((p) => ({
                    ...p,
                    leaveTypeRules: { ...p.leaveTypeRules, [key]: "paid" },
                    leaveTypeQuotas: { ...p.leaveTypeQuotas, [key]: 0 },
                  }));
                  setNewLeaveTypeKey("");
                }}
                style={secondaryButtonStyle}
              >
                Add
              </button>
            </div>
          </div>

          <div style={{ marginTop: 20, marginBottom: 24 }}>
            <span
              style={{
                display: "block",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: T.textMuted,
                marginBottom: 8,
              }}
            >
              Allowance Types — Fixed / % of Basic / No Value
            </span>

            {Object.entries(draftPolicy.allowanceTypes).map(([key, type]) => (
              <div
                key={key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 10px",
                  border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  marginBottom: 6,
                  gap: 8,
                }}
              >
                <input
                  value={type.label}
                  aria-label={`${key} label`}
                  onChange={(event) =>
                    setDraftPolicy((p) => ({
                      ...p,
                      allowanceTypes: {
                        ...p.allowanceTypes,
                        [key]: { ...type, label: event.target.value },
                      },
                    }))
                  }
                  style={{ ...inputStyle, flex: 1, minWidth: 0 }}
                />
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <ModernSelect
                    value={type.mode}
                    onChange={(value) =>
                      setDraftPolicy((p) => ({
                        ...p,
                        allowanceTypes: {
                          ...p.allowanceTypes,
                          [key]: { ...type, mode: value as AllowanceMode },
                        },
                      }))
                    }
                    ariaLabel={`${key} mode`}
                    width={130}
                    minWidth={130}
                    options={ALLOWANCE_MODE_OPTIONS}
                  />
                  {type.mode !== "none" && (
                    <input
                      type="number"
                      min={0}
                      step={type.mode === "percent" ? 0.5 : 1}
                      title={
                        type.mode === "percent"
                          ? "% of basic salary"
                          : "Flat amount (PKR)"
                      }
                      aria-label={`${key} value`}
                      value={type.value}
                      onChange={(event) =>
                        setDraftPolicy((p) => ({
                          ...p,
                          allowanceTypes: {
                            ...p.allowanceTypes,
                            [key]: {
                              ...type,
                              value: Math.max(
                                0,
                                Number(event.target.value) || 0,
                              ),
                            },
                          },
                        }))
                      }
                      style={{ ...inputStyle, width: 72, textAlign: "right" }}
                    />
                  )}
                  <button
                    onClick={() =>
                      setDraftPolicy((p) => {
                        const next = { ...p.allowanceTypes };
                        delete next[key];
                        return { ...p, allowanceTypes: next };
                      })
                    }
                    style={{
                      border: "none",
                      background: "none",
                      color: T.red600,
                      cursor: "pointer",
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            ))}

            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                placeholder="e.g. transport, housing, meal"
                value={newAllowanceTypeKey}
                onChange={(event) => setNewAllowanceTypeKey(event.target.value)}
                style={inputStyle}
              />
              <button
                onClick={() => {
                  const key = newAllowanceTypeKey.trim().toLowerCase();
                  if (!key || draftPolicy.allowanceTypes[key]) return;
                  setDraftPolicy((p) => ({
                    ...p,
                    allowanceTypes: {
                      ...p.allowanceTypes,
                      [key]: {
                        label: newAllowanceTypeKey.trim(),
                        mode: "fixed",
                        value: 0,
                      },
                    },
                  }));
                  setNewAllowanceTypeKey("");
                }}
                style={secondaryButtonStyle}
              >
                Add
              </button>
            </div>
          </div>

          {policyError && (
            <div
              style={{
                background: "#fef2f2",
                border: `1px solid #fecaca`,
                borderRadius: 10,
                padding: "10px 14px",
                marginBottom: 16,
                fontSize: 12,
                fontWeight: 600,
                color: T.red600,
              }}
            >
              {policyError}
            </div>
          )}

          <button
            onClick={handleSaveRules}
            disabled={policySaving || policyLoading || rulesBranchUnavailable}
            style={{
              ...primaryButtonStyle,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              cursor:
                policySaving || policyLoading || rulesBranchUnavailable
                  ? "not-allowed"
                  : "pointer",
              opacity:
                policySaving || policyLoading || rulesBranchUnavailable
                  ? 0.7
                  : 1,
            }}
          >
            {policySaving && (
              <Loader2
                size={14}
                color="#fff"
                style={{ animation: "payroll-spin 0.7s linear infinite" }}
              />
            )}
            {policySaving ? "Saving…" : "Save Configuration"}
          </button>
        </Modal>
      )}

      {isEditModalOpen && editingRow && (
        <Modal onClose={() => setIsEditModalOpen(false)}>
          <h2 style={modalTitleStyle}>Edit Payroll</h2>
          <p style={modalSubStyle}>
            {editingRow.name} · {editingRow.department}
            {isGlobal ? ` · ${editingRow.branchName}` : ""}
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              marginBottom: 12,
            }}
          >
            <Field label="Base Salary (PKR)">
              <input
                type="number"
                min={0}
                step="any"
                value={draftSalary}
                onChange={(event) =>
                  setDraftSalary(Math.max(0, Number(event.target.value) || 0))
                }
                style={inputStyle}
              />
            </Field>
            <Field label="OT Rate Override (Rs/hr)">
              <input
                type="number"
                min={0}
                step="any"
                value={draftOtRateOverride}
                onChange={(event) => {
                  const raw = event.target.value;
                  // Empty string is meaningful here — it means "no
                  // override, fall back to the org default" — so don't
                  // coerce it to 0.
                  if (raw === "") return setDraftOtRateOverride("");
                  setDraftOtRateOverride(String(Math.max(0, Number(raw) || 0)));
                }}
                placeholder={`Org default: ${otRatePerHour}`}
                style={{
                  ...inputStyle,
                  background: T.teal50,
                  borderColor: T.teal200,
                }}
              />
            </Field>
          </div>
          <p
            style={{
              fontSize: 11,
              color: T.textMuted,
              marginTop: -4,
              marginBottom: 20,
            }}
          >
            Leave blank to use the org rate. OT Hours this period (
            {editingRow.otHours}h) come from approved Overtime Management
            requests and aren't edited here.
          </p>

          {editingRowAllowanceTypesLoading ? (
            <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 20 }}>
              Loading allowances…
            </div>
          ) : (
            Object.keys(editingRowAllowanceTypes).length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: T.textMuted,
                    marginBottom: 8,
                  }}
                >
                  Allowances
                </span>
                {/* Catalog is this staff member's *effective* policy —
                    their individual override if set, else their branch's
                    override, else the org-wide default (see
                    editingRowAllowanceTypes above, resolved via
                    getPayrollPolicy's staffId scope). So a branch that's
                    overridden, say, the Transport amount shows that
                    branch's value here, not the org default. */}
                {Object.entries(editingRowAllowanceTypes).map(([key, type]) => {
                  const applied = draftAppliedAllowances[key];
                  const enabled = Boolean(applied?.enabled);
                  return (
                    <div
                      key={key}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "8px 10px",
                        border: `1px solid ${T.border}`,
                        borderRadius: 8,
                        marginBottom: 6,
                        gap: 8,
                      }}
                    >
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontSize: 12,
                          fontWeight: 700,
                          color: T.textBody,
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(event) =>
                            setDraftAppliedAllowances((p) => ({
                              ...p,
                              [key]: {
                                enabled: event.target.checked,
                                overrideValue: applied?.overrideValue,
                              },
                            }))
                          }
                        />
                        {type.label}
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: T.textMuted,
                          }}
                        >
                          {type.mode === "percent"
                            ? `(${type.value}% default)`
                            : type.mode === "none"
                              ? "(no value)"
                              : `(Rs. ${type.value} default)`}
                        </span>
                      </label>
                      {enabled && type.mode !== "none" && (
                        <input
                          type="number"
                          min={0}
                          title="Override this staff member's value — leave blank to use the default above"
                          placeholder={String(type.value)}
                          aria-label={`${key} override value`}
                          value={applied?.overrideValue ?? ""}
                          onChange={(event) => {
                            const raw = event.target.value;
                            setDraftAppliedAllowances((p) => ({
                              ...p,
                              [key]: {
                                enabled: true,
                                overrideValue:
                                  raw.trim() === "" ? undefined : Number(raw),
                              },
                            }));
                          }}
                          style={{
                            ...inputStyle,
                            width: 90,
                            textAlign: "right",
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )
          )}

          <div
            style={{
              background: T.teal50,
              border: `1px solid ${T.teal100}`,
              borderRadius: 10,
              padding: "10px 14px",
              marginBottom: 20,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: 11, color: T.textMuted, fontWeight: 600 }}>
              Net Pay Preview
            </span>
            <span style={{ fontSize: 14, fontWeight: 800, color: T.teal600 }}>
              {fmtPKR(
                Math.max(
                  0,
                  Number(draftSalary) +
                    editingRow.otHours *
                      (draftOtRateOverride.trim() === ""
                        ? otRatePerHour
                        : Number(draftOtRateOverride) || 0) +
                    editingRow.manualAllowance +
                    Object.entries(draftAppliedAllowances).reduce(
                      (sum, [key, applied]) => {
                        if (!applied?.enabled) return sum;
                        const type = editingRowAllowanceTypes[key];
                        if (!type) return sum;
                        const value = applied.overrideValue ?? type.value ?? 0;
                        if (type.mode === "percent")
                          return sum + (Number(draftSalary) * value) / 100;
                        if (type.mode === "none") return sum;
                        return sum + value;
                      },
                      0,
                    ) -
                    editingRow.deductions,
                ),
              )}
            </span>
          </div>

          {saveEditError && (
            <p style={{ fontSize: 12, color: T.red600, marginBottom: 12 }}>
              {saveEditError}
            </p>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => setIsEditModalOpen(false)}
              disabled={savingEdit}
              style={{ ...secondaryButtonStyle, flex: 1 }}
            >
              Cancel
            </button>
            <button
              onClick={handleSaveEdit}
              disabled={savingEdit}
              style={{
                ...primaryButtonStyle,
                flex: 2,
                opacity: savingEdit ? 0.7 : 1,
              }}
            >
              {savingEdit ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </Modal>
      )}

      <style>{`
        * { box-sizing: border-box; }

        .payroll-trend-grid {
          display: grid;
          grid-template-columns: minmax(420px, 0.9fr) minmax(520px, 1.25fr);
          gap: 20px;
          align-items: stretch;
        }

        .payroll-trend-grid > * { min-width: 0; width: 100%; }

        @media (max-width: 1220px) {
          .payroll-trend-grid { grid-template-columns: 1fr; }
        }

        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${T.slate200}; border-radius: 4px; }

        @keyframes payroll-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

const tableCellStyle: React.CSSProperties = {
  padding: "13px 20px",
  color: T.textBody,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const Badge: React.FC<{
  children: React.ReactNode;
  color?: string;
  bg?: string;
}> = ({ children, color = T.navy700, bg = T.slate50 }) => (
  <span
    style={{
      background: bg,
      border: `1px solid ${T.slate200}`,
      borderRadius: 6,
      padding: "3px 9px",
      fontSize: 11,
      fontWeight: 700,
      color,
    }}
  >
    {children}
  </span>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <label style={{ display: "block" }}>
    <span
      style={{
        display: "block",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: T.textMuted,
        marginBottom: 8,
      }}
    >
      {label}
    </span>
    {children}
  </label>
);

const BreakdownValue: React.FC<{
  amount: number;
  prefix: "+" | "−";
  color: string;
  lines: string[];
}> = ({ amount, prefix, color, lines }) => (
  <span
    title={
      lines.length ? lines.join("\n") : "No itemized breakdown for this period"
    }
    style={{
      cursor: lines.length ? "help" : "default",
      borderBottom: lines.length ? `1px dotted ${color}` : "none",
    }}
  >
    {prefix}
    {fmtPKR(amount)}
  </span>
);

const Modal: React.FC<{ children: React.ReactNode; onClose: () => void }> = ({
  children,
  onClose,
}) => (
  <div
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(12,35,64,0.45)",
      backdropFilter: "blur(4px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 50,
      padding: 16,
    }}
    onClick={onClose}
  >
    <div
      style={{
        background: T.bgCard,
        borderRadius: 20,
        padding: 32,
        width: "100%",
        maxWidth: 460,
        boxShadow: T.shadowLg,
        position: "relative",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        onClick={onClose}
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          border: "none",
          background: "transparent",
          color: T.textLight,
          cursor: "pointer",
          display: "flex",
        }}
      >
        <X size={18} />
      </button>
      {children}
    </div>
  </div>
);

const modalTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 800,
  color: T.textHeading,
};

const modalSubStyle: React.CSSProperties = {
  margin: "4px 0 24px",
  fontSize: 12,
  color: T.textMuted,
};

const primaryButtonStyle: React.CSSProperties = {
  width: "100%",
  background: T.teal600,
  color: "#fff",
  border: "none",
  borderRadius: 12,
  padding: "13px",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const secondaryButtonStyle: React.CSSProperties = {
  background: "none",
  border: `1px solid ${T.border}`,
  borderRadius: 12,
  padding: "12px",
  fontSize: 12,
  fontWeight: 700,
  color: T.textMuted,
  cursor: "pointer",
};
