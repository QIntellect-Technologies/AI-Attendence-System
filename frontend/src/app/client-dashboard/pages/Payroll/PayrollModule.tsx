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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import ModernSelect, {
  ModernSelectOption,
} from "../../components/ui/ModernSelect";
import {
  BarChart2,
  Building2,
  CheckCircle2,
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
import {
  getBranchModulePath,
  getModulePath,
} from "../../config/moduleRegistry";
import { getBackendBranchId } from "../../utils/tenantScope";
import { usePayrollData } from "./hooks/usePayrollData";
import type { PayrollRow } from "./hooks/usePayrollData";
import useBranchSelector from "../../hooks/useBranchSelector";
import BranchSelector from "../../components/ui/BranchSelector";
import { FastPagination } from "../../components/common/FastPagination";
import {
  formatDate,
  parseLocalDate,
  useDateFilter,
} from "../../hooks/useDateFilter";
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
import { useStatefulPagination } from "../LeaveManagement/shared/hooks/usePagination";
import {
  usePayrollModuleGates,
  type PayrollGatedModule,
} from "./hooks/usePayrollModuleGates";
import {
  confirmDialog,
  toastSuccess,
  toastError,
} from "../../utils/notifications";
import { setPayrollDecision } from "../attendance_temp/api/attendanceExceptionsApi";
import type { PayrollDecision } from "../attendance_temp/api/attendanceExceptionsApi";
import { formatDisplayDate } from "../../utils/formatDate";
import {
  DEFAULT_PAYROLL_POLICY,
  getPaidPayrollMonthlyTrends,
  getPayrollPolicy,
  type PayrollPolicy,
  type PayrollPolicyWrite,
  type PaidPayrollMonthlyTrends,
  type PayrollMonthCalendar,
  type PayrollWeekday,
  type LateComingMode,
  type AllowanceMode,
  type AllowanceType,
  type AppliedAllowance,
  PAYROLL_VALUE_MIN,
  PAYROLL_VALUE_MAX,
  PAYROLL_PERCENT_MAX,
} from "./api/payrollApi";
import {
  SALARY_MIN,
  SALARY_MAX,
} from "../StaffManagement/utils/staffValidation";
import { listBranchDepartments } from "../StaffManagement/api/attendanceSettingsApi";
import GroupedBarChartCard from "../../components/ui/charts/GroupedBarChartCard";
import LineChartCard from "../../components/ui/charts/LineChartCard";
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

function withoutOvertimeRate(policy: PayrollPolicy): PayrollPolicyWrite {
  const { otRatePerHour: _otRatePerHour, ...policyWithoutOvertimeRate } =
    policy;
  return policyWithoutOvertimeRate;
}

const LATE_COMING_MODE_OPTIONS: ModernSelectOption[] = [
  { value: "none", label: "No deduction for late arrivals" },
  {
    value: "occurrence_threshold",
    label: "Deduct after repeated late arrivals",
    description: "Deduct one day's pay each time the set number is reached",
  },
  {
    value: "flat_per_occurrence",
    label: "Deduct for every late arrival",
    description: "Deduct the same amount for each late arrival",
  },
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
type PayrollStatusFilter = "all" | "Paid" | "Pending";
type PayrollSortKey = keyof Pick<
  PayrollRow,
  "netPay" | "baseSalary" | "overtimeAmount" | "deductions" | "unpaidLeaveDays"
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
  onClick?: () => void;
  active?: boolean;
}> = ({ label, value, icon: Icon, iconBg, iconColor, onClick, active }) => (
  <div
    role={onClick ? "button" : undefined}
    tabIndex={onClick ? 0 : undefined}
    aria-pressed={onClick ? active : undefined}
    onClick={onClick}
    onKeyDown={(event) => {
      if (onClick && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        onClick();
      }
    }}
    onMouseEnter={(event) => {
      if (!onClick) return;
      event.currentTarget.style.transform = "translateY(-3px)";
      event.currentTarget.style.boxShadow = T.shadowMd;
    }}
    onMouseLeave={(event) => {
      if (!onClick) return;
      event.currentTarget.style.transform = "translateY(0)";
      event.currentTarget.style.boxShadow = T.shadowCard;
    }}
    style={{
      background: T.bgCard,
      border: `1px solid ${T.border}`,
      borderRadius: 16,
      boxShadow: T.shadowCard,
      padding: "20px 24px",
      display: "flex",
      flexDirection: "column",
      gap: 16,
      cursor: onClick ? "pointer" : undefined,
      transform: "translateY(0)",
      transition: "transform 180ms ease, box-shadow 180ms ease",
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
  return (
    <div style={cardStyle}>
      <h3 style={cardTitleStyle}>Department Payroll Split</h3>
      <p style={cardSubStyle}>Net pay distribution by department</p>
      {data.length === 0 ? (
        <EmptyState text="No department payroll data available." />
      ) : (
        <GroupedBarChartCard
          singleHeight={230}
          data={data.map(({ name, total }) => ({ label: name, value: total }))}
        />
      )}
    </div>
  );
};

const PayrollCompositionCard: React.FC<{
  rows: PayrollRow[];
  hasOvertime: boolean;
}> = ({ rows, hasOvertime }) => {
  const totals = useMemo(
    () =>
      rows.reduce(
        (result, row) => {
          result.baseSalary += row.baseSalary;
          result.allowances += row.allowances;
          result.overtime += row.overtimeAmount;
          result.deductions += row.deductions;
          result.netPay += row.netPay;
          return result;
        },
        {
          baseSalary: 0,
          allowances: 0,
          overtime: 0,
          deductions: 0,
          netPay: 0,
        },
      ),
    [rows],
  );
  const items = [
    { label: "Base salary", amount: totals.baseSalary },
    { label: "Allowances", amount: totals.allowances },
    ...(hasOvertime
      ? [{ label: "Overtime", amount: totals.overtime }]
      : []),
    { label: "Deductions", amount: totals.deductions },
    { label: "Net pay", amount: totals.netPay },
  ];

  return (
    <div style={cardStyle}>
      <h3 style={cardTitleStyle}>Payroll Composition</h3>
      <p style={cardSubStyle}>Earnings, deductions, and net pay for filtered records</p>
      {rows.length === 0 ? (
        <EmptyState text="No payroll data matches the selected filters." />
      ) : (
        <GroupedBarChartCard
          singleHeight={230}
          data={items.map(({ label, amount }) => ({ label, value: amount }))}
        />
      )}
    </div>
  );
};

type PayrollTrendBranch = { id: string; name: string };

const PayrollMonthlyTrendCard: React.FC<{
  organizationId: string | number | null;
  anchorMonth: string;
  branchId: string | null;
  branches: PayrollTrendBranch[];
  peopleType: string;
  department: string;
  search: string;
  amountOperator: AmountOperator;
  amountValue: string;
  statusFilter: PayrollStatusFilter;
}> = ({
  organizationId,
  anchorMonth,
  branchId,
  branches,
  peopleType,
  department,
  search,
  amountOperator,
  amountValue,
  statusFilter,
}) => {
  const [trend, setTrend] = useState<PaidPayrollMonthlyTrends | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!organizationId || statusFilter === "Pending") {
      setTrend(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setError(null);
    const timeout = window.setTimeout(() => {
      setLoading(true);
      getPaidPayrollMonthlyTrends({
        organizationId,
        anchorMonth,
        branchId,
        peopleType,
        department: department === "all" ? null : department,
        search,
        amountOperator,
        amountValue,
      })
        .then((response) => {
          if (!cancelled) setTrend(response);
        })
        .catch((requestError: unknown) => {
          if (!cancelled) {
            setError(
              requestError instanceof Error
                ? requestError.message
                : "Unable to load payroll trends.",
            );
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    amountOperator,
    amountValue,
    anchorMonth,
    branchId,
    department,
    organizationId,
    peopleType,
    search,
    statusFilter,
  ]);

  const monthsWithPayroll = useMemo(() => {
    if (!trend) return [];
    const monthsWithRows = new Set(trend.rows.map((row) => row.month));
    return trend.months.filter((month) => monthsWithRows.has(month));
  }, [trend]);

  const series = useMemo(() => {
    if (!trend) return [];
    const branchIds = Array.from(
      new Set(trend.rows.map((row) => row.branch_id)),
    );
    return branchIds.map((id) => {
      const branch = branches.find((item) => item.id === id);
      return {
        name: branch?.name ?? (id === "unknown" ? "Other" : `Branch ${id}`),
        data: monthsWithPayroll.map((month) => ({
          label: new Date(`${month}-01T00:00:00`).toLocaleDateString(
            undefined,
            { month: "short", year: "2-digit" },
          ),
          value:
            trend.rows.find(
              (row) => row.branch_id === id && row.month === month,
            )?.payroll ?? 0,
        })),
      };
    });
  }, [branches, monthsWithPayroll, trend]);
  const chartData = useMemo(
    () => series[0]?.data ?? [],
    [series],
  );

  return (
    <div style={cardStyle}>
      <h3 style={cardTitleStyle}>
        {branchId ? "Monthly Payroll Trend" : "Monthly Payroll by Branch"}
      </h3>
      <p style={cardSubStyle}>Paid payroll · processed months through {anchorMonth}</p>
      {loading ? (
        <div
          role="status"
          style={{ color: T.textMuted, fontSize: 12, padding: "24px 0" }}
        >
          Loading paid payroll history…
        </div>
      ) : error ? (
        <div role="alert" style={{ color: T.red600, fontSize: 12 }}>
          {error}
        </div>
      ) : statusFilter === "Pending" ? (
        <EmptyState text="This trend shows paid payroll only. Select Paid or All to view history." />
      ) : series.length === 0 ? (
        <EmptyState text="No paid payroll snapshots match the selected filters." />
      ) : (
        <LineChartCard
          data={series.length === 1 ? chartData : undefined}
          series={series.length > 1 ? series : undefined}
          height={260}
          color={T.teal600}
          formatY={(value) =>
            value >= 1_000_000
              ? `${(value / 1_000_000).toFixed(1)}M`
              : value >= 1_000
                ? `${Math.round(value / 1_000)}K`
                : String(value)
          }
          formatTooltip={(value) => fmtPKR(value)}
          showArea
          showDots
        />
      )}
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

/** Sort choices; `requires` hides an option when its module isn't purchased. */
const PAYROLL_SORT_OPTIONS: ReadonlyArray<{
  value: PayrollSortKey;
  label: string;
  requires?: PayrollGatedModule;
}> = [
  { value: "netPay", label: "Net Salary" },
  { value: "baseSalary", label: "Base Salary" },
  { value: "overtimeAmount", label: "OT Pay", requires: "overtime" },
  { value: "unpaidLeaveDays", label: "Unpaid Leaves", requires: "leave" },
  { value: "deductions", label: "Deductions" },
];

export default function PayrollModule() {
  const navigate = useNavigate();
  const { branchId: branchIdParam } = useParams<{ branchId?: string }>();
  const {
    cfg,
    updateCfg,
    activeBranchId,
    organizationId,
    setSelectedPeopleType: setOrgSelectedPeopleType,
  } = useOrg();
  // Leave / Overtime are separately purchased modules — every rule, column,
  // sort option, export field and edit input tied to them is gated here.
  const gates = usePayrollModuleGates();
  const hasOvertime = gates.overtime;
  const hasLeave = gates.leave;

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

  const [activeTab, setActiveTab] = useState<ActiveTab>("records");
  const [selectedPeopleType, setSelectedPeopleType] = useState<string | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [amountOperator, setAmountOperator] = useState<AmountOperator>("all");
  const [amountValue, setAmountValue] = useState("");
  const [sortKey, setSortKey] = useState<PayrollSortKey>("netPay");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [statusFilter, setStatusFilter] = useState<PayrollStatusFilter>("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");

  const [isRulesModalOpen, setIsRulesModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [lateDecisionRow, setLateDecisionRow] = useState<PayrollRow | null>(
    null,
  );
  const [decidingAttendanceId, setDecidingAttendanceId] = useState<
    string | null
  >(null);
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
  const [holidayDateDraft, setHolidayDateDraft] = useState("");
  const [newLeaveTypeKey, setNewLeaveTypeKey] = useState("");
  const [newAllowanceTypeKey, setNewAllowanceTypeKey] = useState("");
  const allowanceNameError = useMemo(() => {
    const seen = new Map<string, string>();
    for (const [key, type] of Object.entries(draftPolicy.allowanceTypes)) {
      const normalized = type.label.trim().toLocaleLowerCase();
      if (!normalized) continue;
      const previousKey = seen.get(normalized);
      if (previousKey) {
        return `Allowance names must be unique. "${type.label}" is used more than once.`;
      }
      seen.set(normalized, key);
    }
    return null;
  }, [draftPolicy.allowanceTypes]);
  const newAllowanceName = newAllowanceTypeKey.trim().toLowerCase();
  const newAllowanceNameConflict = useMemo(() => {
    if (!newAllowanceName) return false;
    return Object.entries(draftPolicy.allowanceTypes).some(
      ([key, type]) =>
        key.trim().toLowerCase() === newAllowanceName ||
        type.label.trim().toLowerCase() === newAllowanceName,
    );
  }, [draftPolicy.allowanceTypes, newAllowanceName]);
  const salaryConfigError = useMemo(() => {
    if (!Number.isFinite(draftSalary))
      return "Base salary must be a valid number.";
    if (draftSalary < SALARY_MIN)
      return `Base salary must be at least PKR ${SALARY_MIN.toLocaleString("en-PK")}.`;
    if (draftSalary > SALARY_MAX)
      return `Base salary cannot exceed PKR ${SALARY_MAX.toLocaleString("en-PK")}.`;
    return null;
  }, [draftSalary]);
  const otRateConfigError = useMemo(() => {
    if (draftOtRateOverride.trim() === "") return null;
    const value = Number(draftOtRateOverride);
    if (!Number.isFinite(value) || value < PAYROLL_VALUE_MIN)
      return "OT rate must be at least PKR 1.";
    if (value > PAYROLL_VALUE_MAX)
      return "OT rate cannot exceed PKR 100,000,000.";
    return null;
  }, [draftOtRateOverride]);
  const blockInvalidNumberKeys = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (["-", "+", "e", "E"].includes(event.key)) event.preventDefault();
  };
  const payrollRulesError = useMemo(() => {
    if (hasOvertime && draftPolicy.otRatePerHour < PAYROLL_VALUE_MIN)
      return "OT rate must be at least PKR 1.";
    if (hasOvertime && draftPolicy.otRatePerHour > PAYROLL_VALUE_MAX)
      return "OT rate cannot exceed PKR 100,000,000.";
    for (const type of Object.values(draftPolicy.allowanceTypes)) {
      const maximum =
        type.mode === "percent" ? PAYROLL_PERCENT_MAX : PAYROLL_VALUE_MAX;
      if (type.mode !== "none" && type.value < PAYROLL_VALUE_MIN)
        return "Allowance values must be at least PKR 1.";
      if (type.value > maximum)
        return type.mode === "percent"
          ? "Allowance percentages cannot exceed 100%."
          : "Allowance values cannot exceed PKR 100,000,000.";
    }
    return allowanceNameError;
  }, [allowanceNameError, draftPolicy, hasOvertime]);

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
  const monthCalendar: PayrollMonthCalendar =
    draftPolicy.payrollCalendarsByMonth[periodMonth] ?? {};
  const monthHolidayDates = Array.isArray(monthCalendar.holidayDates)
    ? monthCalendar.holidayDates
    : [];
  const monthHolidaysConfirmed =
    monthCalendar.holidaysConfirmed === true || monthHolidayDates.length > 0;
  const selectedMonthWeeklyOffDays: PayrollWeekday[] =
    periodMonth >= draftPolicy.payrollWeeklyOffDaysEffectiveFrom
      ? draftPolicy.payrollWeeklyOffDays
      : (monthCalendar.weeklyOffDays ??
        (monthCalendar.weeklyOffDay ? [monthCalendar.weeklyOffDay] : ["sunday"]));
  const monthEndDay = new Date(
    Number(periodMonth.slice(0, 4)),
    Number(periodMonth.slice(5, 7)),
    0,
  ).getDate();
  const monthEndDate = `${periodMonth}-${String(monthEndDay).padStart(2, "0")}`;
  const updateMonthCalendar = (changes: Partial<PayrollMonthCalendar>) =>
    setDraftPolicy((current) => {
      const currentCalendar = current.payrollCalendarsByMonth[periodMonth] ?? {
        holidayDates: [],
      };
      return {
        ...current,
        payrollCalendarsByMonth: {
          ...current.payrollCalendarsByMonth,
          [periodMonth]: { ...currentCalendar, ...changes },
        },
      };
    });
  const updateWeeklyOffDays = (weeklyOffDays: PayrollWeekday[]) =>
    setDraftPolicy((current) => ({
      ...current,
      payrollWeeklyOffDays: weeklyOffDays,
      payrollWeeklyOffDaysEffectiveFrom: periodMonth,
    }));
  const currentDate = new Date();
  const nextMonthDate = new Date(
    currentDate.getFullYear(),
    currentDate.getMonth() + 1,
    1,
  );
  const currentMonthLastDate = new Date(
    currentDate.getFullYear(),
    currentDate.getMonth() + 1,
    0,
  ).getDate();
  const nextCalendarMonth = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}`;
  const nextCalendarMonthLabel = nextMonthDate.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const showNextMonthCalendarReminder =
    currentMonthLastDate - currentDate.getDate() <= 7 &&
    policy.payrollCalendarsByMonth[nextCalendarMonth]?.holidaysConfirmed !==
      true &&
    (policy.payrollCalendarsByMonth[nextCalendarMonth]?.holidayDates?.length ??
      0) === 0;

  const effectiveBranchId = isGlobal
    ? branchSelector.selectedBranchId
    : scopedBranchId;
  const departmentBranchIds = useMemo(
    () =>
      cfg.branches
        .filter(
          (branch) =>
            effectiveBranchId === undefined ||
            branch.id === effectiveBranchId,
        )
        .map((branch) => getBackendBranchId(branch) ?? String(branch.id))
        .filter(Boolean),
    [cfg.branches, effectiveBranchId],
  );
  const [configuredDepartments, setConfiguredDepartments] = useState<string[]>(
    [],
  );
  useEffect(() => {
    if (!organizationId || departmentBranchIds.length === 0) {
      setConfiguredDepartments([]);
      return;
    }
    setConfiguredDepartments([]);
    let cancelled = false;
    Promise.all(
      departmentBranchIds.map((branchId) =>
        listBranchDepartments(branchId, organizationId),
      ),
    )
      .then((results) => {
        if (cancelled) return;
        setConfiguredDepartments(
          Array.from(
            new Set(
              results
                .flat()
                .map((department) => department.name?.trim())
                .filter((name): name is string => Boolean(name)),
            ),
          ).sort((a, b) => a.localeCompare(b)),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        toastError(
          error instanceof Error
            ? `Unable to load configured departments: ${error.message}`
            : "Unable to load configured departments.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [departmentBranchIds, organizationId]);

  const {
    rows,
    modulePeopleTypes,
    peopleType,
    loading,
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

  const handleLateDecision = useCallback(
    async (attendanceId: string, decision: PayrollDecision) => {
      if (!organizationId || !lateDecisionRow?.breakdown) return;
      setDecidingAttendanceId(attendanceId);
      try {
        await setPayrollDecision({
          organizationId,
          attendanceId,
          decision,
        });
        setLateDecisionRow((current) =>
          current?.breakdown
            ? {
                ...current,
                breakdown: {
                  ...current.breakdown,
                  pendingLateDecisions:
                    current.breakdown.pendingLateDecisions.filter(
                      (item) => item.attendanceId !== attendanceId,
                    ),
                },
              }
            : current,
        );
        toastSuccess(
          decision === "include"
            ? "Late arrival included in payroll."
            : "Late arrival excluded from payroll.",
        );
        await refresh({ force: true }).catch(() => {
          toastError(
            "The decision was saved, but payroll could not be refreshed. Refresh the page to see the updated totals.",
          );
        });
      } catch (error) {
        toastError(
          error instanceof Error
            ? error.message
            : "Unable to save the late-arrival decision.",
        );
      } finally {
        setDecidingAttendanceId(null);
      }
    },
    [organizationId, lateDecisionRow, refresh],
  );

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

  const trendBranches = useMemo<PayrollTrendBranch[]>(
    () =>
      cfg.branches.map((branch) => ({
        id: getBackendBranchId(branch) ?? String(branch.id),
        name: branch.name,
      })),
    [cfg.branches],
  );
  const trendBranchId = useMemo(() => {
    if (effectiveBranchId === undefined) return null;
    const branch = cfg.branches.find(
      (item) => Number(item.id) === Number(effectiveBranchId),
    );
    return branch
      ? (getBackendBranchId(branch) ?? String(branch.id))
      : String(effectiveBranchId);
  }, [cfg.branches, effectiveBranchId]);

  const contextLabel = isGlobal
    ? branchSelector.selectedBranchId
      ? branchSelector.selected.name
      : "All Branches"
    : (cfg.branches.find((branch) => branch.id === scopedBranchId)?.name ??
      "Branch");

  // Explicit "from date – to date" for the export header, independent of
  // payrollDateFilter.label (which collapses to just "January 2026" for
  // the monthly view — the export always wants both hard boundaries).
  const todayDate = formatDate(new Date());
  const reportPeriodLabel = useMemo(
    () => {
      const { startDate, endDate } = payrollDateFilter.range;
      const reportEndDate =
        startDate.slice(0, 7) === todayDate.slice(0, 7) ? todayDate : endDate;
      return `${formatReportDate(startDate)} – ${formatReportDate(reportEndDate)}`;
    },
    [
      payrollDateFilter.range.startDate,
      payrollDateFilter.range.endDate,
      todayDate,
    ],
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
      /** Omitted from both exports when this module isn't purchased. */
      requires?: PayrollGatedModule;
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
        header: "Working Days",
        accessor: (row: PayrollRow) => row.totalWorkingDays,
        align: "right" as const,
      },
      {
        header: "Absent Days",
        accessor: (row: PayrollRow) => row.absentDays,
        align: "right" as const,
      },
      {
        header: "OT Hours",
        accessor: (row: PayrollRow) => row.otHours,
        align: "right" as const,
        requires: "overtime" as const,
      },
      {
        header: "OT Rate/hr",
        accessor: (row: PayrollRow) => row.otRate,
        pdfAccessor: (row: PayrollRow) => fmtPKR(row.otRate),
        align: "right" as const,
        numFmt: PKR_NUM_FMT,
        requires: "overtime" as const,
      },
      {
        header: "OT Pay",
        accessor: (row: PayrollRow) => row.overtimeAmount,
        pdfAccessor: (row: PayrollRow) => fmtPKR(row.overtimeAmount),
        align: "right" as const,
        numFmt: PKR_NUM_FMT,
        requires: "overtime" as const,
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
        requires: "leave" as const,
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

  const visibleExportFields = useMemo(
    () => gates.filterByGate(payrollExportFields),
    [gates, payrollExportFields],
  );

  const payrollExcelColumns = useMemo(
    () =>
      visibleExportFields.map(({ header, accessor, align, numFmt }) => ({
        header,
        accessor,
        align,
        numFmt,
      })),
    [visibleExportFields],
  );

  const payrollPdfColumns = useMemo(
    () =>
      visibleExportFields.map(({ header, accessor, pdfAccessor, align }) => ({
        header,
        accessor: pdfAccessor ?? accessor,
        align,
      })),
    [visibleExportFields],
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

      return (
        searchable.includes(normalizedQuery) &&
        matchesAmount(row.netPay) &&
        (departmentFilter === "all" ||
          (departmentFilter === "Unassigned"
            ? !row.department?.trim()
            : row.department === departmentFilter)) &&
        (statusFilter === "all" ||
          (statusFilter === "Paid"
            ? row.status === "Paid"
            : row.status !== "Paid"))
      );
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
  }, [
    amountOperator,
    amountValue,
    departmentFilter,
    rows,
    searchQuery,
    sortDirection,
    sortKey,
    statusFilter,
  ]);

  const filteredDepartmentSummary = useMemo(() => {
    const totals = new Map<string, number>();
    visibleRows.forEach((row) => {
      const department = row.department?.trim() || "Unassigned";
      totals.set(department, (totals.get(department) ?? 0) + row.netPay);
    });
    return Array.from(totals, ([name, total]) => ({ name, total })).sort(
      (left, right) => right.total - left.total,
    );
  }, [visibleRows]);

  const resetListFilters = useCallback(() => {
    setSearchQuery("");
    setAmountOperator("all");
    setAmountValue("");
    setSortKey("netPay");
    setSortDirection("asc");
    setStatusFilter("all");
    setDepartmentFilter("all");
    branchSelector.reset();
    payrollDateFilter.setMode("monthly");
  }, [branchSelector, payrollDateFilter]);

  const payrollFilterSections = useMemo<DynamicFilterSection[]>(
    () => [
      {
        id: "branch",
        type: "custom",
        hidden: !isGlobal || !branchSelector.hasMultipleBranches,
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
        id: "department",
        type: "select",
        label: "Department",
        value: departmentFilter,
        options: [
          { value: "all", label: "Departments" },
          ...Array.from(
            new Set(
              [
                ...configuredDepartments,
                ...rows.map((row) =>
                  row.department?.trim() ? row.department : "Unassigned",
                ),
              ],
            ),
          )
            .sort((a, b) => a.localeCompare(b))
            .map((department) => ({
              value: department,
              label: department,
            })),
        ],
        minWidth: 160,
        onChange: setDepartmentFilter,
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
        options: gates
          .filterByGate(PAYROLL_SORT_OPTIONS)
          .map(({ value, label }) => ({ value, label })),
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
        id: "search",
        type: "search",
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: "Search name, ID, department, branch, status...",
        grow: true,
        minWidth: 300,
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
      departmentFilter,
      isGlobal,
      modulePeopleTypes,
      payrollDateFilter,
      peopleOptions,
      peopleType,
      rows,
      resetListFilters,
      searchQuery,
      sortDirection,
      sortKey,
      statusFilter,
      gates,
    ],
  );

  // After
  const tableColumns = useMemo(
    () =>
      gates.filterByGate<{
        key: string;
        label: string;
        requires?: PayrollGatedModule;
      }>([
        { key: "#", label: "Staff ID" },
        { key: "name", label: "Name" },
        { key: "cnic", label: "CNIC" },
        ...(isGlobal ? [{ key: "branch", label: "Branch" }] : []),
        { key: "dept", label: "Department" },
        { key: "base", label: "Base Salary" },
        { key: "allowances", label: "Allowances" },
        { key: "present", label: "Present" },
        { key: "workingDays", label: "Working Days" },
        { key: "absent", label: "Absent" },
        { key: "otHrs", label: "OT Hrs", requires: "overtime" },
        { key: "otRate", label: "OT Rate/hr", requires: "overtime" },
        { key: "otPay", label: "OT Pay", requires: "overtime" },
        { key: "lateComings", label: "Late Comings" },
        { key: "unpaidLeaves", label: "Unpaid Leaves", requires: "leave" },
        { key: "deductions", label: "Deductions" },
        { key: "net", label: "Net Salary" },
        { key: "status", label: "Status" },
        { key: "action", label: "" },
      ]),
    [isGlobal, gates],
  );

  // Body cells render off the same filtered list as the header, so a column
  // can never be hidden in <thead> but still present in <tbody> (or vice versa).
  const visibleColumnKeys = useMemo(
    () => new Set(tableColumns.map((column) => column.key)),
    [tableColumns],
  );
  const showCol = (key: string) => visibleColumnKeys.has(key);

  const orgAllowanceTypesRef = useRef(cfg.payrollPolicy.allowanceTypes);
  orgAllowanceTypesRef.current = cfg.payrollPolicy.allowanceTypes;

  const openEditModal = useCallback((row: PayrollRow) => {
    setEditingRowAllowanceTypes({});
    setEditingRowAllowanceTypesLoading(true);
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
    if (!isEditModalOpen) return undefined;
    if (!editingRow || !organizationId) {
      setEditingRowAllowanceTypes({});
      setEditingRowAllowanceTypesLoading(false);
      return undefined;
    }
    getPayrollPolicy(organizationId, {
      branchId: editingRow.backendBranchId,
      staffId: editingRow.staffId,
    })
      .then((effectivePolicy) => {
        if (!cancelled)
          setEditingRowAllowanceTypes(effectivePolicy.allowanceTypes ?? {});
      })
      .catch(() => {
        // Fall back to the org-wide default rather than showing nothing —
        // still better than blocking the modal on a transient fetch error.
        if (!cancelled)
          setEditingRowAllowanceTypes(orgAllowanceTypesRef.current ?? {});
      })
      .finally(() => {
        if (!cancelled) setEditingRowAllowanceTypesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isEditModalOpen,
    editingRow?.staffId,
    editingRow?.backendBranchId,
    organizationId,
  ]);
  const [payrollPageSize, setPayrollPageSize] = useState(25);
  const payrollPager = useStatefulPagination({
    items: visibleRows,
    itemsPerPage: payrollPageSize,
  });
  const paginatedPayrollRows = payrollPager.paginatedItems;

  const [togglingStaffId, setTogglingStaffId] = useState<string | null>(null);
  const [selectedPayrollStaffIds, setSelectedPayrollStaffIds] = useState<
    Set<string>
  >(() => new Set());
  const [processingPayroll, setProcessingPayroll] = useState(false);

  const handleToggleStatus = useCallback(
    async (row: PayrollRow) => {
      const key = String(row.staffId);
      if (togglingStaffId === key) return;
      setTogglingStaffId(key);
      try {
        if (row.status === "Paid") {
          await markPending(row.staffId);
        } else {
          const pendingCount =
            row.breakdown?.pendingLateDecisions.length ?? 0;
          if (pendingCount > 0) {
            const confirmation = await confirmDialog({
              title: "Late-arrival decisions are pending",
              text: `${pendingCount} late-arrival ${
                pendingCount === 1 ? "decision is" : "decisions are"
              } still pending for ${row.name}. Resolve them first. If you continue, all undecided late arrivals will be included in payroll.`,
              confirmButtonText: "Continue and mark paid",
            });
            if (!confirmation.isConfirmed) return;
          }
          await markPaid(row.staffId);
        }
      } finally {
        setTogglingStaffId((current) => (current === key ? null : current));
      }
    },
    [markPaid, markPending, togglingStaffId],
  );

  const selectedPayrollRows = visibleRows.filter((row) =>
    selectedPayrollStaffIds.has(String(row.staffId)),
  );
  const selectedUnpaidRows = selectedPayrollRows.filter(
    (row) => row.status !== "Paid",
  );
  const selectedPaidRows = selectedPayrollRows.filter(
    (row) => row.status === "Paid",
  );
  const allVisibleRowsSelected =
    visibleRows.length > 0 &&
    visibleRows.every((row) =>
      selectedPayrollStaffIds.has(String(row.staffId)),
    );

  const handleBulkStatusChange = async (
    targetStatus: "Paid" | "Pending",
    rowsToProcess: PayrollRow[],
  ) => {
    if (processingPayroll || rowsToProcess.length === 0) return;
    const isMarkingPaid = targetStatus === "Paid";
    const peopleWithPendingDecisions = isMarkingPaid
      ? rowsToProcess.filter(
          (row) => (row.breakdown?.pendingLateDecisions.length ?? 0) > 0,
        ).length
      : 0;
    const pendingWarning = !peopleWithPendingDecisions
      ? ""
      : peopleWithPendingDecisions === rowsToProcess.length
        ? rowsToProcess.length === 1
          ? " This person has pending late-arrival decisions. Resolve them first; if you continue, all undecided late arrivals will be included in payroll."
          : ` All ${rowsToProcess.length} selected people have pending late-arrival decisions. Resolve them first; if you continue, all undecided late arrivals will be included in payroll.`
        : ` ${peopleWithPendingDecisions} of ${rowsToProcess.length} selected people have pending late-arrival decisions. Resolve them first; if you continue, all undecided late arrivals will be included in payroll.`;

    const confirmation = await confirmDialog({
      title: isMarkingPaid ? "Process payroll?" : "Mark as pending?",
      text: `Mark ${rowsToProcess.length} selected ${
        rowsToProcess.length === 1 ? "person" : "people"
      } as ${targetStatus.toLowerCase()} for ${payrollDateFilter.label}?${pendingWarning}`,
      confirmButtonText: isMarkingPaid ? "Process Payroll" : "Mark Pending",
    });
    if (!confirmation.isConfirmed) return;

    setProcessingPayroll(true);
    try {
      const results = await Promise.allSettled(
        rowsToProcess.map((row) =>
          targetStatus === "Paid"
            ? markPaid(row.staffId)
            : markPending(row.staffId),
        ),
      );
      const successfulIds = new Set<string>();
      const failures: string[] = [];

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          successfulIds.add(String(rowsToProcess[index].staffId));
        } else {
          failures.push(
            `${rowsToProcess[index].name}: ${
              result.reason instanceof Error
                ? result.reason.message
                : "Unable to update payroll status."
            }`,
          );
        }
      });

      if (successfulIds.size > 0) {
        setSelectedPayrollStaffIds((current) => {
          const next = new Set(current);
          successfulIds.forEach((id) => next.delete(id));
          return next;
        });
        toastSuccess(
          `${successfulIds.size} ${
            successfulIds.size === 1 ? "person" : "people"
          } marked as ${targetStatus.toLowerCase()}.`,
        );
      }
      if (failures.length > 0) {
        toastError(
          `${failures.length} payroll ${
            failures.length === 1 ? "update failed" : "updates failed"
          }: ${failures.join("; ")}`,
        );
      }
    } finally {
      setProcessingPayroll(false);
    }
  };

  const [savingEdit, setSavingEdit] = useState(false);
  const [saveEditError, setSaveEditError] = useState<string | null>(null);

  const handleSaveEdit = useCallback(async () => {
    if (!editingRow || salaryConfigError || otRateConfigError) return;
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
        {
          // Omitted (not sent as 0) without the Overtime module, so saving a
          // salary edit can't silently clear a previously-set per-staff rate.
          ...(hasOvertime ? { otRate } : {}),
          appliedAllowances: draftAppliedAllowances,
        },
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
    salaryConfigError,
    otRateConfigError,
    editingRow,
    updateBaseSalary,
    hasOvertime,
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
      if (payrollRulesError) return;
      const policyToSave = hasOvertime
        ? draftPolicy
        : withoutOvertimeRate(draftPolicy);
      await savePolicy(policyToSave);
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
  }, [
    draftPolicy,
    payrollRulesError,
    savePolicy,
    isGlobal,
    updateCfg,
    refresh,
    rulesBranch,
    hasOvertime,
  ]);

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
  const payrollKpiStats = visibleRows.reduce(
    (counts, row) => {
      counts.totalPayout += row.netPay;
      counts.totalOT += row.overtimeAmount;
      counts.totalStaff += 1;
      if (row.status === "Paid") counts.paid += 1;
      else counts.pending += 1;
      return counts;
    },
    { totalPayout: 0, totalOT: 0, totalStaff: 0, paid: 0, pending: 0 },
  );

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
              ...(hasOvertime ? { otRatePerHour } : {}),
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

      {!policyLoading && showNextMonthCalendarReminder && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            flexWrap: "wrap",
            padding: "14px 18px",
            marginBottom: 18,
            border: `1px solid ${T.amber100}`,
            borderRadius: 14,
            background: "#fffbeb",
            boxShadow: T.shadowCard,
          }}
        >
          <div>
            <div style={{ color: T.textHeading, fontSize: 13, fontWeight: 800 }}>
              Prepare {nextCalendarMonthLabel}’s payroll calendar
            </div>
            <div
              style={{
                marginTop: 4,
                color: T.textMuted,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Weekly days off carry forward automatically. Confirm next month’s
              holidays before the month begins.
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              payrollDateFilter.setMode("monthly");
              payrollDateFilter.setSelectedMonth(nextCalendarMonth);
              openRulesModal();
            }}
            style={{
              ...primaryButtonStyle,
              whiteSpace: "nowrap",
              padding: "9px 14px",
            }}
          >
            Configure{" "}
            {nextMonthDate.toLocaleDateString("en-US", { month: "short" })}
          </button>
        </div>
      )}

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
            gridTemplateColumns: `repeat(${hasOvertime ? 5 : 4}, minmax(0, 1fr))`,
            gap: 16,
            marginBottom: 16,
          }}
        >
          <StatCard
            label="Total Pay-out"
            value={fmtPKR(payrollKpiStats.totalPayout)}
            icon={DollarSign}
            iconBg={T.teal100}
            iconColor={T.teal600}
          />
          {hasOvertime && (
            <StatCard
              label="Total OT Paid"
              value={fmtPKR(payrollKpiStats.totalOT)}
              icon={Zap}
              iconBg="#d1e8f0"
              iconColor={T.navy600}
            />
          )}
          <StatCard
            label="Employees"
            value={payrollKpiStats.totalStaff}
            icon={Users}
            iconBg={T.blue100}
            iconColor={T.blue500}
            onClick={() => {
              setOrgSelectedPeopleType(peopleType);
              navigate(
                branchIdParam
                  ? getBranchModulePath("employees", Number(branchIdParam))
                  : getModulePath("employees"),
              );
            }}
          />
          <StatCard
            label="Paid"
            value={payrollKpiStats.paid}
            icon={CheckCircle2}
            iconBg={T.green100}
            iconColor={T.green600}
            onClick={() =>
              setStatusFilter((current) =>
                current === "Paid" ? "all" : "Paid",
              )
            }
            active={statusFilter === "Paid"}
          />
          <StatCard
            label="Pending"
            value={payrollKpiStats.pending}
            icon={Clock}
            iconBg={T.amber100}
            iconColor={T.amber600}
            onClick={() =>
              setStatusFilter((current) =>
                current === "Pending" ? "all" : "Pending",
              )
            }
            active={statusFilter === "Pending"}
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
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              {selectedPayrollRows.length > 0 && (
                <span style={{ fontSize: 11, color: T.textMuted }}>
                  {selectedPayrollRows.length} selected
                </span>
              )}
              {selectedUnpaidRows.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    handleBulkStatusChange("Paid", selectedUnpaidRows)
                  }
                  disabled={processingPayroll}
                  style={{
                    border: "none",
                    borderRadius: 8,
                    padding: "8px 12px",
                    color: "#fff",
                    background: T.teal600,
                    fontWeight: 700,
                    cursor: processingPayroll ? "not-allowed" : "pointer",
                    opacity: processingPayroll ? 0.5 : 1,
                  }}
                >
                  {processingPayroll ? "Processing..." : "Process payroll"}
                </button>
              )}
              {selectedPaidRows.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    handleBulkStatusChange("Pending", selectedPaidRows)
                  }
                  disabled={processingPayroll}
                  style={{
                    border: `1px solid ${T.border}`,
                    borderRadius: 8,
                    padding: "8px 12px",
                    color: T.textBody,
                    background: T.bgCard,
                    fontWeight: 700,
                    cursor: processingPayroll ? "not-allowed" : "pointer",
                    opacity: processingPayroll ? 0.5 : 1,
                  }}
                >
                  {processingPayroll ? "Processing..." : "Mark Pending"}
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  setSelectedPayrollStaffIds(
                    allVisibleRowsSelected
                      ? new Set()
                      : new Set(visibleRows.map((row) => String(row.staffId))),
                  )
                }
                disabled={visibleRows.length === 0 || processingPayroll}
                style={{
                  border: `1px solid ${T.border}`,
                  borderRadius: 8,
                  padding: "7px 10px",
                  color: T.textBody,
                  background: T.bgCard,
                  cursor:
                    visibleRows.length === 0 || processingPayroll
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    visibleRows.length === 0 || processingPayroll ? 0.5 : 1,
                }}
              >
                {allVisibleRowsSelected ? "Deselect all" : "Select all"}
              </button>
              <span style={{ fontSize: 11, color: T.textMuted }}>
                {payrollDateFilter.label} · {visibleRows.length} records
              </span>
            </div>
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
                  <th
                    style={{
                      padding: "12px 12px",
                      textAlign: "center",
                      borderBottom: `1px solid ${T.border}`,
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label="Select all payroll rows"
                      checked={allVisibleRowsSelected}
                      ref={(element) => {
                        if (element) {
                          element.indeterminate =
                            selectedPayrollRows.length > 0 &&
                            !allVisibleRowsSelected;
                        }
                      }}
                      onChange={(event) =>
                        setSelectedPayrollStaffIds(
                          event.target.checked
                            ? new Set(
                                visibleRows.map((row) => String(row.staffId)),
                              )
                            : new Set(),
                        )
                      }
                      disabled={visibleRows.length === 0 || processingPayroll}
                    />
                  </th>
                  {tableColumns.map((column) => (
                    <th
                      key={column.key}
                      style={{
                        padding: "12px 20px",
                        textAlign: [
                          "present",
                          "absent",
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
                {paginatedPayrollRows.map((row: PayrollRow) => (
                  <tr
                    key={row.id}
                    style={{ borderBottom: `1px solid ${T.slate100}` }}
                  >
                    <td style={{ ...tableCellStyle, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.name} for payroll processing`}
                        checked={selectedPayrollStaffIds.has(
                          String(row.staffId),
                        )}
                        onChange={(event) =>
                          setSelectedPayrollStaffIds((current) => {
                            const next = new Set(current);
                            if (event.target.checked) {
                              next.add(String(row.staffId));
                            } else {
                              next.delete(String(row.staffId));
                            }
                            return next;
                          })
                        }
                        disabled={processingPayroll}
                      />
                    </td>
                    <td style={tableCellStyle}>{row.empId || "—"}</td>
                    <td style={tableCellStyle}>
                      <div style={{ fontWeight: 800, color: T.textHeading }}>
                        {row.name}
                      </div>
                    </td>
                    <td style={tableCellStyle}>{row.cnic || "—"}</td>
                    {isGlobal && (
                      <td style={tableCellStyle}>
                        <Badge>{row.branchName}</Badge>
                      </td>
                    )}
                    <td style={tableCellStyle}>{row.department}</td>
                    <td style={tableCellStyle}>{fmtPKR(row.baseSalary)}</td>
                    <td style={tableCellStyle}>{fmtPKR(row.allowances)}</td>
                    <td style={{ ...tableCellStyle, textAlign: "center" }}>
                      {row.presentDays}
                    </td>
                    {showCol("workingDays") && (
                      <td
                        style={{ ...tableCellStyle, textAlign: "center" }}
                        title="Scheduled workdays this month, excluding weekly days off and holidays"
                      >
                        {row.totalWorkingDays}
                      </td>
                    )}
                    {showCol("absent") && (
                      <td style={{ ...tableCellStyle, textAlign: "center" }}>
                        {row.absentDays}
                      </td>
                    )}
                    {showCol("otHrs") && (
                      <td style={{ ...tableCellStyle, textAlign: "center" }}>
                        {row.otHours}h
                      </td>
                    )}
                    {showCol("otRate") && (
                      <td style={{ ...tableCellStyle, textAlign: "center" }}>
                        {fmtPKR(row.otRate)}
                      </td>
                    )}
                    {showCol("otPay") && (
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
                    )}
                    <td
                      style={{
                        ...tableCellStyle,
                        textAlign: "center",
                        color: T.amber600,
                        fontWeight: 800,
                      }}
                    >
                      <div
                        style={{
                          display: "grid",
                          justifyItems: "center",
                          gap: 4,
                        }}
                      >
                        <span>{row.lateCount}</span>
                        {(row.breakdown?.pendingLateDecisions.length ?? 0) >
                          0 && (
                          <button
                            type="button"
                            onClick={() => setLateDecisionRow(row)}
                            style={{
                              border: 0,
                              padding: 0,
                              background: "transparent",
                              color: T.amber600,
                              cursor: "pointer",
                              font: "inherit",
                              fontSize: 10,
                              textDecoration: "underline",
                            }}
                          >
                            {row.breakdown!.pendingLateDecisions.length}{" "}
                            {row.breakdown!.pendingLateDecisions.length === 1
                              ? "decision pending"
                              : "decisions pending"}
                          </button>
                        )}
                      </div>
                    </td>
                    {showCol("unpaidLeaves") && (
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
                    )}
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
                                row.breakdown.absentDays > 0
                                  ? `Absent scheduled days: ${row.breakdown.absentDays} → ${fmtPKR(row.breakdown.absenceDeductionAmount)}`
                                  : "",
                                row.breakdown.lateCount > 0
                                  ? `Late arrivals: ${row.breakdown.lateCount} → ${fmtPKR(row.breakdown.lateDeductionAmount)}`
                                  : "",
                                row.breakdown.halfDayAttendanceCount > 0 ||
                                row.breakdown.halfDayLeaveCount > 0
                                  ? `Half-days: ${row.breakdown.halfDayAttendanceCount + row.breakdown.halfDayLeaveCount} → ${fmtPKR(row.breakdown.halfDayDeductionAmount)}`
                                  : "",
                                hasLeave && row.breakdown.unpaidLeaveDays > 0
                                  ? `Unpaid leave: ${row.breakdown.unpaidLeaveDays}d → ${fmtPKR(row.breakdown.unpaidLeaveDeductionAmount)}`
                                  : "",
                                hasLeave &&
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
                        disabled={
                          processingPayroll ||
                          togglingStaffId === String(row.staffId)
                        }
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
                            processingPayroll ||
                            togglingStaffId === String(row.staffId)
                              ? "default"
                              : "pointer",
                          opacity:
                            processingPayroll ||
                            togglingStaffId === String(row.staffId)
                              ? 0.6
                              : 1,
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
                      colSpan={tableColumns.length + 1}
                      style={{
                        padding: 40,
                        textAlign: "center",
                        color: T.textLight,
                      }}
                    >
                      {loading || refreshing ? (
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                          role="status"
                          aria-live="polite"
                        >
                          <Loader2
                            size={16}
                            color={T.textMuted}
                            style={{
                              animation: "payroll-spin 0.7s linear infinite",
                            }}
                          />
                          Loading payroll data…
                        </span>
                      ) : (
                        "No data found for the selected filters."
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {activeTab === "records" && (
        <FastPagination
          page={payrollPager.page}
          pageSize={payrollPageSize}
          total={payrollPager.totalItems}
          onPageChange={payrollPager.goToPage}
          onPageSizeChange={setPayrollPageSize}
        />
      )}

      {activeTab === "trend" && (
        <div className="payroll-trend-grid">
          <DepartmentSplitCard data={filteredDepartmentSummary} />
          <PayrollCompositionCard rows={visibleRows} hasOvertime={hasOvertime} />
          <PayrollMonthlyTrendCard
            organizationId={organizationId}
            anchorMonth={periodMonth}
            branchId={trendBranchId}
            branches={trendBranches}
            peopleType={peopleType}
            department={departmentFilter}
            search={searchQuery}
            amountOperator={amountOperator}
            amountValue={amountValue}
            statusFilter={statusFilter}
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

      {lateDecisionRow?.breakdown && (
        <Modal
          scrollable
          onClose={() =>
            decidingAttendanceId === null && setLateDecisionRow(null)
          }
        >
          <h2 style={modalTitleStyle}>Late-arrival decisions</h2>
          <p style={modalSubStyle}>
            {lateDecisionRow.name} · {payrollDateFilter.label}
          </p>
          <p
            style={{
              margin: "0 0 16px",
              color: T.textMuted,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            Choose whether each late arrival should count toward this person’s
            payroll deduction.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            {lateDecisionRow.breakdown.pendingLateDecisions
              .slice()
              .sort((left, right) => left.date.localeCompare(right.date))
              .map(({ attendanceId, date }) => (
                <div
                  key={attendanceId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "10px 12px",
                    border: `1px solid ${T.border}`,
                    borderRadius: 10,
                  }}
                >
                  <span
                    style={{
                      color: T.textBody,
                      fontSize: 13,
                      fontWeight: 700,
                    }}
                  >
                    {formatDisplayDate(parseLocalDate(date))}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["include", "exclude"] as const).map((decision) => (
                      <button
                        key={decision}
                        type="button"
                        disabled={decidingAttendanceId !== null}
                        onClick={() =>
                          void handleLateDecision(attendanceId, decision)
                        }
                        style={{
                          ...(decision === "include"
                            ? primaryButtonStyle
                            : secondaryButtonStyle),
                          padding: "7px 10px",
                          fontSize: 11,
                          opacity: decidingAttendanceId !== null ? 0.65 : 1,
                        }}
                      >
                        {decidingAttendanceId === attendanceId
                          ? "Saving…"
                          : decision === "include"
                            ? "Include"
                            : "Exclude"}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            {lateDecisionRow.breakdown.pendingLateDecisions.length === 0 && (
              <p
                style={{
                  margin: "0 0 16px",
                  color: T.green600,
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                All late-arrival decisions for this period are resolved.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setLateDecisionRow(null)}
            disabled={decidingAttendanceId !== null}
            style={{ ...secondaryButtonStyle, width: "100%", marginTop: 18 }}
          >
            Done
          </button>
        </Modal>
      )}

      {isRulesModalOpen && (
        <Modal
          scrollable
          onClose={() => !policySaving && setIsRulesModalOpen(false)}
        >
          <h2 style={modalTitleStyle}>
            {isGlobal
              ? "Company Payroll Rules"
              : `Payroll Rules — ${rulesBranch?.name ?? "Branch"}`}
          </h2>
          <p style={modalSubStyle}>{rulesScopeSummary}</p>

          {hasOvertime && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr",
                gap: 16,
                marginBottom: 20,
              }}
            >
              <Field label="OT Rate / Hour">
                <input
                  type="number"
                  min={0}
                  max={PAYROLL_VALUE_MAX}
                  step="any"
                  onKeyDown={blockInvalidNumberKeys}
                  value={draftPolicy.otRatePerHour}
                  onChange={(event) =>
                    setDraftPolicy((p) => ({
                      ...p,
                      otRatePerHour: Math.min(
                        PAYROLL_VALUE_MAX,
                        Number(event.target.value),
                      ),
                    }))
                  }
                  style={{
                    ...inputStyle,
                    background: T.teal50,
                    borderColor: otRateConfigError ? T.red600 : T.teal200,
                  }}
                  aria-invalid={Boolean(otRateConfigError)}
                />
                {otRateConfigError && (
                  <p
                    role="alert"
                    style={{
                      margin: "5px 0 0",
                      fontSize: 11,
                      color: T.red600,
                      fontWeight: 600,
                    }}
                  >
                    {otRateConfigError}
                  </p>
                )}
              </Field>
            </div>
          )}

          <div
            style={{
              padding: 18,
              marginBottom: 20,
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              background: T.bgCard,
              boxShadow: T.shadowCard,
            }}
          >
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
              Payroll Calendar · {selectedMonth} {selectedYear}
            </span>
            <p
              style={{
                margin: "0 0 12px",
                color: T.textMuted,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Weekly days off repeat from the selected month onward. Holidays are
              specific to each month and must be confirmed separately. You can
              change these settings later.
            </p>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 700,
                    color: T.textMuted,
                    marginBottom: 6,
                  }}
                >
                  Weekly days off
                </label>
                <details
                  style={{
                    position: "relative",
                    fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
                  }}
                >
                  <summary
                    style={{
                      ...inputStyle,
                      minHeight: 38,
                      boxSizing: "border-box",
                      display: "flex",
                      alignItems: "center",
                      cursor: "pointer",
                      listStyle: "none",
                      color: T.textHeading,
                      fontWeight: 700,
                    }}
                  >
                    {selectedMonthWeeklyOffDays
                      .map((day) => day[0].toUpperCase() + day.slice(1))
                      .join(", ") || "Select weekly days off"}
                  </summary>
                  <div
                    style={{
                      position: "relative",
                      marginTop: 6,
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "2px 8px",
                      padding: 10,
                      border: `1px solid ${T.border}`,
                      borderRadius: 12,
                      background: T.bgCard,
                      boxShadow: T.shadowCard,
                    }}
                  >
                    {(
                      [
                        "monday",
                        "tuesday",
                        "wednesday",
                        "thursday",
                        "friday",
                        "saturday",
                        "sunday",
                      ] as PayrollWeekday[]
                    ).map((day) => (
                      <label
                        key={day}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "7px 6px",
                          borderRadius: 8,
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: 600,
                          color: T.textHeading,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedMonthWeeklyOffDays.includes(day)}
                          disabled={
                            selectedMonthWeeklyOffDays.length === 1 &&
                            selectedMonthWeeklyOffDays.includes(day)
                          }
                          onChange={(event) => {
                            const days = new Set(selectedMonthWeeklyOffDays);
                            if (event.target.checked) days.add(day);
                            else days.delete(day);
                            updateWeeklyOffDays([...days]);
                          }}
                        />
                        {day[0].toUpperCase() + day.slice(1)}
                      </label>
                    ))}
                  </div>
                </details>
              </div>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 700,
                    color: T.textMuted,
                    marginBottom: 6,
                  }}
                >
                  Holidays (excluded from scheduled days)
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="date"
                    min={`${periodMonth}-01`}
                    max={monthEndDate}
                    value={holidayDateDraft}
                    onChange={(event) => setHolidayDateDraft(event.target.value)}
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    type="button"
                    disabled={
                      !holidayDateDraft ||
                      monthHolidayDates.includes(holidayDateDraft)
                    }
                    onClick={() => {
                      updateMonthCalendar({
                        holidayDates: [...monthHolidayDates, holidayDateDraft].sort(),
                        holidaysConfirmed: true,
                      });
                      setHolidayDateDraft("");
                    }}
                    style={{
                      ...primaryButtonStyle,
                      padding: "8px 14px",
                      opacity:
                        !holidayDateDraft ||
                        monthHolidayDates.includes(holidayDateDraft)
                          ? 0.55
                          : 1,
                    }}
                  >
                    Add
                  </button>
                </div>
                {monthHolidayDates.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                    {monthHolidayDates.map((holiday) => (
                      <span
                        key={holiday}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "5px 8px",
                          borderRadius: 8,
                          background: T.teal50,
                          color: T.textHeading,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {formatReportDate(holiday)}
                        <button
                          type="button"
                          aria-label={`Remove holiday ${holiday}`}
                          onClick={() =>
                            updateMonthCalendar({
                              holidayDates: monthHolidayDates.filter(
                                (dateValue) => dateValue !== holiday,
                              ),
                            })
                          }
                          style={{
                            border: 0,
                            background: "transparent",
                            color: T.red600,
                            cursor: "pointer",
                            padding: 0,
                            fontWeight: 800,
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {monthHolidayDates.length === 0 && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      flexWrap: "wrap",
                      marginTop: 10,
                    }}
                  >
                    <span style={{ color: T.textMuted, fontSize: 11 }}>
                      {monthHolidaysConfirmed
                        ? "No holidays recorded for this month."
                        : "If this month has no holidays, confirm that here."}
                    </span>
                    {monthHolidaysConfirmed ? (
                      <button
                        type="button"
                        onClick={() =>
                          setDraftPolicy((current) => {
                            const calendars = { ...current.payrollCalendarsByMonth };
                            const savedCalendar = calendars[periodMonth];
                            if (
                              savedCalendar &&
                              (savedCalendar.weeklyOffDays ||
                                savedCalendar.weeklyOffDay)
                            ) {
                              const {
                                holidayDates: _holidayDates,
                                holidaysConfirmed: _holidaysConfirmed,
                                ...legacyWeeklySchedule
                              } = savedCalendar;
                              calendars[periodMonth] = legacyWeeklySchedule;
                            } else {
                              delete calendars[periodMonth];
                            }
                            return { ...current, payrollCalendarsByMonth: calendars };
                          })
                        }
                        style={{
                          border: 0,
                          background: "transparent",
                          color: T.textMuted,
                          fontSize: 11,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        Clear confirmation
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          updateMonthCalendar({
                            holidayDates: [],
                            holidaysConfirmed: true,
                          })
                        }
                        style={{
                          ...primaryButtonStyle,
                          padding: "7px 10px",
                          fontSize: 11,
                        }}
                      >
                        Confirm no holidays
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <Field label="Late Arrival Deduction">
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
              <div style={{ marginTop: 16 }}>
                <Field label="Number of late arrivals for one day's pay deduction">
                  <input
                    type="number"
                    min={1}
                    value={
                      draftPolicy.lateComingPolicy.thresholdOccurrences ?? 3
                    }
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
              </div>
            )}

            {draftPolicy.lateComingPolicy.mode === "flat_per_occurrence" && (
              <div style={{ marginTop: 16 }}>
                <Field label="Amount to deduct for each late arrival (Rs.)">
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
              </div>
            )}
          </div>

          {hasLeave && (
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
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: T.textBody,
                      }}
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
                  maxLength={40}
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
          )}
          {/* Lives outside the Leave block: it reports an allowance-name
              error and must still show when the Leave module is off. */}
          {allowanceNameError && (
            <div
              role="alert"
              style={{
                background: "#fef2f2",
                border: `1px solid #fecaca`,
                borderRadius: 10,
                padding: "10px 14px",
                marginTop: 10,
                fontSize: 12,
                fontWeight: 600,
                color: T.red600,
              }}
            >
              {allowanceNameError}
            </div>
          )}

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
                  maxLength={40}
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
                      min={PAYROLL_VALUE_MIN}
                      max={
                        type.mode === "percent"
                          ? PAYROLL_PERCENT_MAX
                          : PAYROLL_VALUE_MAX
                      }
                      step={type.mode === "percent" ? 0.5 : 1}
                      onKeyDown={blockInvalidNumberKeys}
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
                                PAYROLL_VALUE_MIN,
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
                maxLength={40}
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
                disabled={!newAllowanceName || newAllowanceNameConflict}
                style={{
                  ...secondaryButtonStyle,
                  cursor:
                    !newAllowanceName || newAllowanceNameConflict
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    !newAllowanceName || newAllowanceNameConflict ? 0.55 : 1,
                }}
              >
                Add
              </button>
            </div>
            {newAllowanceNameConflict && (
              <div
                role="alert"
                style={{
                  color: T.red600,
                  fontSize: 11,
                  fontWeight: 600,
                  marginTop: 6,
                }}
              >
                {newAllowanceTypeKey.trim()} is already added. Choose another
                allowance.
              </div>
            )}
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
          {payrollRulesError && !policyError && (
            <div
              role="alert"
              style={{
                color: T.red600,
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 16,
              }}
            >
              {payrollRulesError}
            </div>
          )}

          <button
            onClick={handleSaveRules}
            disabled={
              policySaving ||
              policyLoading ||
              rulesBranchUnavailable ||
              Boolean(payrollRulesError)
            }
            style={{
              ...primaryButtonStyle,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              cursor:
                policySaving ||
                policyLoading ||
                rulesBranchUnavailable ||
                Boolean(payrollRulesError)
                  ? "not-allowed"
                  : "pointer",
              opacity:
                policySaving ||
                policyLoading ||
                rulesBranchUnavailable ||
                Boolean(payrollRulesError)
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
              gridTemplateColumns: hasOvertime ? "1fr 1fr" : "1fr",
              gap: 16,
              marginBottom: hasOvertime ? 12 : 20,
            }}
          >
            <Field label="Base Salary (PKR)">
              <input
                type="number"
                min={SALARY_MIN}
                max={SALARY_MAX}
                step="1"
                onKeyDown={blockInvalidNumberKeys}
                value={draftSalary}
                onChange={(event) =>
                  setDraftSalary(
                    Math.min(SALARY_MAX, Number(event.target.value)),
                  )
                }
                aria-invalid={Boolean(salaryConfigError)}
                style={{
                  ...inputStyle,
                  ...(salaryConfigError ? { borderColor: T.red600 } : null),
                }}
              />
              {salaryConfigError && (
                <p
                  role="alert"
                  style={{
                    margin: "5px 0 0",
                    fontSize: 11,
                    color: T.red600,
                    fontWeight: 600,
                  }}
                >
                  {salaryConfigError}
                </p>
              )}
            </Field>
            {hasOvertime && (
              <Field label="OT Rate Override (Rs/hr)">
                <input
                  type="number"
                  min={0}
                  max={PAYROLL_VALUE_MAX}
                  step="any"
                  onKeyDown={blockInvalidNumberKeys}
                  value={draftOtRateOverride}
                  onChange={(event) => {
                    const raw = event.target.value;
                    // Empty string is meaningful here — it means "no
                    // override, fall back to the org default" — so don't
                    // coerce it to 0.
                    if (raw === "") return setDraftOtRateOverride("");
                    setDraftOtRateOverride(
                      String(Math.min(PAYROLL_VALUE_MAX, Number(raw))),
                    );
                  }}
                  placeholder={`Org default: ${otRatePerHour}`}
                  style={{
                    ...inputStyle,
                    background: T.teal50,
                    borderColor: T.teal200,
                  }}
                />
              </Field>
            )}
          </div>
          {hasOvertime && (
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
          )}

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
                          min={PAYROLL_VALUE_MIN}
                          max={
                            type.mode === "percent"
                              ? PAYROLL_PERCENT_MAX
                              : PAYROLL_VALUE_MAX
                          }
                          onKeyDown={blockInvalidNumberKeys}
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
                                  raw.trim() === ""
                                    ? undefined
                                    : Math.min(
                                        type.mode === "percent"
                                          ? PAYROLL_PERCENT_MAX
                                          : PAYROLL_VALUE_MAX,
                                        Number(raw),
                                      ),
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
                    (hasOvertime
                      ? editingRow.otHours *
                        (draftOtRateOverride.trim() === ""
                          ? otRatePerHour
                          : Number(draftOtRateOverride) || 0)
                      : 0) +
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
              disabled={
                savingEdit ||
                editingRowAllowanceTypesLoading ||
                Boolean(salaryConfigError) ||
                Boolean(otRateConfigError)
              }
              style={{
                ...primaryButtonStyle,
                flex: 2,
                opacity:
                  savingEdit || salaryConfigError || otRateConfigError
                    ? 0.7
                    : 1,
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

        .payroll-modal-scrollable::-webkit-scrollbar { width: 6px; }
        .payroll-modal-scrollable::-webkit-scrollbar-track { background: transparent; }
        .payroll-modal-scrollable::-webkit-scrollbar-thumb {
          background: ${T.slate200};
          border-radius: 6px;
        }

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

const Modal: React.FC<{
  children: React.ReactNode;
  onClose: () => void;
  scrollable?: boolean;
}> = ({ children, onClose, scrollable = false }) => (
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
        ...(scrollable
          ? {
              height: "fit-content",
              minHeight: 0,
              maxHeight: "min(75vh, calc(100vh - 32px))",
              overflow: "hidden",
            }
          : null),
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close modal"
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
      {scrollable ? (
        <div
          className="payroll-modal-scrollable"
          style={{
            maxHeight: "calc(min(75vh, calc(100vh - 32px)) - 64px)",
            overflowY: "auto",
            marginRight: -32,
            paddingRight: 26,
            scrollbarGutter: "stable",
            scrollbarWidth: "auto",
            scrollbarColor: `${T.slate200} transparent`,
          }}
        >
          {children}
        </div>
      ) : (
        children
      )}
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
