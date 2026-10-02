/**
 * DepartmentPayrollCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Calculates and displays the total base payroll allocation per department.
 * Uses the pre-fetched `allStaff` list from the Dashboard Overview.
 */

import React, { useMemo } from "react";
import DashboardCard from "./DashboardCard";
import GroupedBarChartCard from "../../ui/charts/GroupedBarChartCard";
import { T } from "../../ui/theme";

interface DepartmentPayrollCardProps {
  allStaff: any[];
  action?: React.ReactNode;
}

// ─── Y-axis / tooltip formatter ───────────────────────────────────────────────

const fmtPayroll = (v: number): string =>
  v >= 1_000_000
    ? `${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000
      ? `${Math.round(v / 1_000)}K`
      : v.toLocaleString();

// ─── Main component ───────────────────────────────────────────────────────────

const DepartmentPayrollCard: React.FC<DepartmentPayrollCardProps> = ({
  allStaff,
  action,
}) => {
  const chartData = useMemo(() => {
    if (!allStaff || allStaff.length === 0) return [];
    
    const deptTotals: Record<string, number> = {};
    
    allStaff.forEach(staff => {
      // Find the department name, defaulting to "Unassigned"
      const dept = staff.department_name || staff.department || "Unassigned";
      
      // Parse the salary safely
      const salaryStr = staff.base_salary ?? staff.baseSalary ?? staff.salary ?? 0;
      const salary = parseFloat(String(salaryStr));
      
      if (!isNaN(salary) && salary > 0) {
        deptTotals[dept] = (deptTotals[dept] || 0) + salary;
      }
    });

    // Convert to array and sort descending to show highest payroll departments first
    return Object.entries(deptTotals)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [allStaff]);

  return (
    <DashboardCard
      title="Department Allocation"
      action={action}
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
      </p>

      {/* GroupedBarChartCard expects single series via the `data` prop */}
      <GroupedBarChartCard
        data={chartData.length > 0 ? chartData : [{ label: "No Data", value: 0 }]}
        singleHeight={200}
      />
    </DashboardCard>
  );
};

export default React.memo(DepartmentPayrollCard);
