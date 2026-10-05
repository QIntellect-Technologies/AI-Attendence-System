/**
 * DepartmentPayrollCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Total base payroll allocation per department.
 *
 * Default view   : loads the *current calendar month* payroll via
 *                  usePayrollData — identical to selecting the current month
 *                  in the picker. This ensures staff archived mid-month still
 *                  appear (the backend's "archived during period" backfill
 *                  merges them in), whereas the old allStaff-based approach
 *                  excluded anyone the moment they were archived.
 *
 * Month selected : the header "mm/yyyy" picker loads that month's payroll rows
 *                  and sums base salary per department. Future months show
 *                  "No payroll for <month>". Reset returns to the current month.
 */

import React, { useMemo, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import DashboardCard from "./DashboardCard";
import GroupedBarChartCard from "../../ui/charts/GroupedBarChartCard";
import usePayrollData from "../../../pages/Payroll/hooks/usePayrollData";
import { T } from "../../ui/theme";

interface DepartmentPayrollCardProps {
  /** Kept for API compatibility; no longer used for the default view. */
  allStaff?: any[];
  /** UI branch id; omit for "All branches". */
  branchId?: number | string | null;
  peopleType?: string | null;
  action?: React.ReactNode;
}

type BarPoint = { label: string; value: number };

const NO_DATA: BarPoint[] = [{ label: "No Data", value: 0 }];

/** Sum salaries per department, highest first. Ignores zero / invalid salaries. */
function totalsByDepartment(
  items: { department: string; salary: unknown }[],
): BarPoint[] {
  const totals: Record<string, number> = {};
  items.forEach(({ department, salary }) => {
    const dept = String(department ?? "").trim() || "Unassigned";
    const amount = parseFloat(String(salary ?? 0));
    if (!isNaN(amount) && amount > 0) {
      totals[dept] = (totals[dept] || 0) + amount;
    }
  });
  return Object.entries(totals)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

function monthTitle(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/** Current calendar month as "YYYY-MM" (local time — never via toISOString). */
function currentMonthKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const CHART_HEIGHT = 200;

const statusBoxStyle: React.CSSProperties = {
  height: CHART_HEIGHT,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  color: T.muted,
};

// ─── Shared chart renderer (used for both default and selected month) ─────────

const MonthDepartmentChart: React.FC<{
  month: string;
  branchId?: number | string | null;
  peopleType?: string | null;
}> = ({ month, branchId, peopleType }) => {
  const { rows, loading, refreshing, error } = usePayrollData({
    month,
    branchId: branchId ?? undefined,
    peopleType: peopleType ?? undefined,
  });

  const isFutureMonth = month > currentMonthKey();

  const data = useMemo(
    () =>
      isFutureMonth
        ? []
        : totalsByDepartment(
          rows.map((row) => ({
            department: row.department,
            salary: row.baseSalary,
          })),
        ),
    [rows, isFutureMonth],
  );

  if (loading || refreshing) {
    return (
      <div role="status" style={statusBoxStyle}>
        Loading {monthTitle(month)}…
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" style={{ ...statusBoxStyle, color: "#b91c1c" }}>
        {error}
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <div role="status" style={statusBoxStyle}>
        No payroll for {monthTitle(month)}
      </div>
    );
  }
  return <GroupedBarChartCard data={data} singleHeight={CHART_HEIGHT} />;
};

// ─── Main component ───────────────────────────────────────────────────────────

const DepartmentPayrollCard: React.FC<DepartmentPayrollCardProps> = ({
  branchId,
  peopleType,
  action,
}) => {
  // "" = no override → current month is used automatically.
  const [monthOverride, setMonthOverride] = useState("");
  const monthInputRef = useRef<HTMLInputElement | null>(null);

  const thisMonth = currentMonthKey();
  // The month actually displayed: user's manual pick or the current month.
  const activeMonth = monthOverride || thisMonth;
  // True only when the user has deliberately picked a different month.
  const hasOverride = Boolean(monthOverride);

  // Picker label: show the selected month, or the current month with a subtle
  // hint that it is the live default (no explicit selection needed).
  const monthText = `${activeMonth.slice(5, 7)}/${activeMonth.slice(0, 4)}`;

  const monthPicker = (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {hasOverride && (
        <button
          type="button"
          onClick={() => setMonthOverride("")}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid #e2e8f0",
            background: "transparent",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 500,
            color: "#64748b",
          }}
        >
          Reset
        </button>
      )}
      <div
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "3px 8px",
          borderRadius: 6,
          border: hasOverride ? "1px solid #0f172a" : "1px solid #e2e8f0",
          background: hasOverride ? "#f8fafc" : "transparent",
          fontSize: 12,
          color: hasOverride ? "#0f172a" : "#64748b",
          cursor: "pointer",
        }}
      >
        <span>{monthText}</span>
        <Calendar size={13} color={hasOverride ? "#0f172a" : "#64748b"} />
        {/* Invisible native month input on top: provides the real picker. */}
        <input
          ref={monthInputRef}
          type="month"
          aria-label="Select payroll month"
          value={monthOverride}
          onChange={(e) => setMonthOverride(e.target.value)}
          onClick={() => {
            try {
              monthInputRef.current?.showPicker?.();
            } catch {
              /* picker unavailable — native input still works */
            }
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0,
            cursor: "pointer",
            border: "none",
          }}
        />
      </div>
      {action && <div style={{ marginLeft: 4 }}>{action}</div>}
    </div>
  );

  return (
    <DashboardCard
      title="Department Allocation"
      action={monthPicker}
      height={300}
      bodyStyle={{ minHeight: 220, minWidth: 0, width: "100%" }}
    >
      <p
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: T.muted,
          marginBottom: 6,
          letterSpacing: "0.02em",
        }}
      >
        Total Base Payroll Cost per Department
        {` · ${monthTitle(activeMonth)}`}
      </p>

      {/* Always use the payroll endpoint — default = current month,
          override = whatever the user picked. This ensures staff archived
          mid-month still appear (backend backfills them for the period). */}
      <MonthDepartmentChart
        month={activeMonth}
        branchId={branchId}
        peopleType={peopleType}
      />
    </DashboardCard>
  );
};

export default React.memo(DepartmentPayrollCard);