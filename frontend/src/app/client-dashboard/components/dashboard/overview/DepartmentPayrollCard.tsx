/**
 * DepartmentPayrollCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Total base payroll allocation per department.
 *
 * Default view   : sums each person's base salary from the pre-fetched
 *                  `allStaff` list (no extra request).
 * Month selected : the header "mm/yyyy" picker (same box style as the Attendance
 *                  card's "mm/dd/yyyy") loads that month's payroll rows — the
 *                  same data the Payroll page shows for that month — and sums
 *                  base salary per department. Reset returns to the default view.
 */

import React, { useMemo, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import DashboardCard from "./DashboardCard";
import GroupedBarChartCard from "../../ui/charts/GroupedBarChartCard";
import usePayrollData from "../../../pages/Payroll/hooks/usePayrollData";
import { T } from "../../ui/theme";

interface DepartmentPayrollCardProps {
  allStaff: any[];
  /** UI branch id; omit for "All branches". Only used when a month is picked. */
  branchId?: number | string | null;
  /** Only used when a month is picked. */
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

const CHART_HEIGHT = 200;

const statusBoxStyle: React.CSSProperties = {
  height: CHART_HEIGHT,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 12,
  color: T.muted,
};

// ─── Month view (mounted only while a month is selected) ──────────────────────

const MonthDepartmentChart: React.FC<{
  month: string;
  branchId?: number | string | null;
  peopleType?: string | null;
}> = ({ month, branchId, peopleType }) => {
  const { rows, loading, error } = usePayrollData({
    month,
    branchId: branchId ?? undefined,
    peopleType: peopleType ?? undefined,
  });

  const data = useMemo(
    () =>
      totalsByDepartment(
        rows.map((row) => ({
          department: row.department,
          salary: row.baseSalary,
        })),
      ),
    [rows],
  );

  if (loading) {
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
  return (
    <GroupedBarChartCard
      data={data.length > 0 ? data : NO_DATA}
      singleHeight={CHART_HEIGHT}
    />
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

const DepartmentPayrollCard: React.FC<DepartmentPayrollCardProps> = ({
  allStaff,
  branchId,
  peopleType,
  action,
}) => {
  const [month, setMonth] = useState(""); // "YYYY-MM" or "" (default view)
  const monthInputRef = useRef<HTMLInputElement | null>(null);

  const defaultData = useMemo(() => {
    if (!allStaff || allStaff.length === 0) return [];
    return totalsByDepartment(
      allStaff.map((staff) => ({
        department: staff.department_name || staff.department || "Unassigned",
        salary: staff.base_salary ?? staff.baseSalary ?? staff.salary ?? 0,
      })),
    );
  }, [allStaff]);

  const active = Boolean(month);

  // "2026-10" → "10/2026"; empty → "mm/yyyy" placeholder.
  const monthText = active
    ? `${month.slice(5, 7)}/${month.slice(0, 4)}`
    : "mm/yyyy";

  const monthPicker = (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {active && (
        <button
          type="button"
          onClick={() => setMonth("")}
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
          border: active ? "1px solid #0f172a" : "1px solid #e2e8f0",
          background: active ? "#f8fafc" : "transparent",
          fontSize: 12,
          color: active ? "#0f172a" : "#64748b",
          cursor: "pointer",
        }}
      >
        <span>{monthText}</span>
        <Calendar size={13} color={active ? "#0f172a" : "#64748b"} />
        {/* Invisible native month input on top: provides the real picker. */}
        <input
          ref={monthInputRef}
          type="month"
          aria-label="Select payroll month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
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
        {active ? ` · ${monthTitle(month)}` : ""}
      </p>

      {active ? (
        <MonthDepartmentChart
          month={month}
          branchId={branchId}
          peopleType={peopleType}
        />
      ) : (
        <GroupedBarChartCard
          data={defaultData.length > 0 ? defaultData : NO_DATA}
          singleHeight={CHART_HEIGHT}
        />
      )}
    </DashboardCard>
  );
};

export default React.memo(DepartmentPayrollCard);