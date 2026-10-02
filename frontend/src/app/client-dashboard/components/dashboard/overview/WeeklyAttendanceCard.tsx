/**
 * WeeklyAttendanceCard.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper: DashboardCard shell + data-shape translation around the
 * reusable GroupedBarChartCard. Visuals unchanged from the original.
 */

import React, { useMemo, useState } from "react";
import DashboardCard from "./DashboardCard";
import GroupedBarChartCard, {
  type BarSeries,
} from "../../ui/charts/GroupedBarChartCard";
import type { WeeklyAttendanceItem } from "../../../hooks/useDashboardOverviewData";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BranchSeries {
  branchId: number;
  branchName: string;
  data: WeeklyAttendanceItem[]; // one entry per day
}

interface WeeklyAttendanceCardProps {
  /** Single-series data (branch scope or filtered global) */
  data?: WeeklyAttendanceItem[];
  /** Multi-series data for "All Branches" global view */
  branchSeries?: BranchSeries[];
  title?: string;
  action?: React.ReactNode;
  showBranchDropdown?: boolean; // kept for API compat, unused internally
  /** Keeps this card equal-height with PendingLeavesCard and CctvStatusCard. */
  height?: number | string;
  /** Chart body height inside the equal-height dashboard card. */
  listHeight?: number | string;
  
  fetchedLogs?: any[];
  allStaff?: any[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function numericHeight(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ─── Main component ───────────────────────────────────────────────────────────

const WeeklyAttendanceCard: React.FC<WeeklyAttendanceCardProps> = ({
  data,
  branchSeries,
  title = "Attendance",
  action,
  height = 350,
  listHeight = 260,
  fetchedLogs,
  allStaff,
}) => {
  const [filter, setFilter] = useState<"week" | "14_days" | "day">("week");
  const [selectedDate, setSelectedDate] = useState("");

  const isMulti = branchSeries && branchSeries.length > 0;
  const chartHeight = numericHeight(listHeight, 260);

  const singleData = useMemo(() => {
    if (filter === "day" && selectedDate && fetchedLogs && allStaff) {
      const dateLogs = fetchedLogs.filter((log) => {
        const d = log.logDate || log.date || log.timestamp;
        return d === selectedDate || String(d).startsWith(selectedDate);
      });
      
      const presentStaffIds = new Set(
        dateLogs
          .filter((log) => ["present", "late", "checked_in", "checked_out", "half_day"].includes((log.status || "").toLowerCase()))
          .map((log) => String(log.staffId || log.userId))
      );

      const deptCounts: Record<string, number> = {};
      allStaff.forEach(staff => {
         const deptName = staff.department_name || staff.department || "Unassigned";
         if (!deptCounts[deptName]) deptCounts[deptName] = 0;
      });

      allStaff.forEach(staff => {
        if (presentStaffIds.has(String(staff.id))) {
          const deptName = staff.department_name || staff.department || "Unassigned";
          deptCounts[deptName] = (deptCounts[deptName] || 0) + 1;
        }
      });

      return Object.entries(deptCounts).map(([label, value]) => ({ label, value }));
    }

    if (filter === "14_days" && fetchedLogs) {
      const dateCounts: Record<string, number> = {};
      fetchedLogs.forEach(log => {
        if (["present", "late", "checked_in", "checked_out", "half_day"].includes((log.status || "").toLowerCase())) {
          // parse out just the YYYY-MM-DD
          const d = log.logDate || log.date || log.timestamp;
          const dateStr = d ? String(d).split('T')[0] : "";
          if (dateStr) {
            dateCounts[dateStr] = (dateCounts[dateStr] || 0) + 1;
          }
        }
      });
      
      const last14Days = [];
      const today = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;
        
        const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        last14Days.push({ label, value: dateCounts[dateStr] || 0 });
      }
      return last14Days;
    }

    return (data ?? []).map((d) => ({ label: d.day, value: d.count }));
  }, [data, filter, selectedDate, fetchedLogs, allStaff]);

  const multiSeries: BarSeries[] | undefined = useMemo(() => {
    if (!isMulti) return undefined;
    return branchSeries!.map((b) => ({
      id: b.branchId,
      name: b.branchName,
      data: b.data.map((d) => ({ label: d.day, value: d.count })),
    }));
  }, [isMulti, branchSeries]);

  const customAction = (
    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
      <button 
        type="button"
        onClick={() => { setFilter("week"); setSelectedDate(""); }}
        style={{ 
          padding: "4px 10px", 
          borderRadius: "6px", 
          border: filter === "week" ? "1px solid #0f172a" : "1px solid #e2e8f0", 
          background: filter === "week" ? "#f8fafc" : "transparent", 
          cursor: "pointer", 
          fontSize: "12px", 
          fontWeight: 500,
          color: filter === "week" ? "#0f172a" : "#64748b" 
        }}
      >
        Week
      </button>
      <button 
        type="button"
        onClick={() => { setFilter("14_days"); setSelectedDate(""); }}
        style={{ 
          padding: "4px 10px", 
          borderRadius: "6px", 
          border: filter === "14_days" ? "1px solid #0f172a" : "1px solid #e2e8f0", 
          background: filter === "14_days" ? "#f8fafc" : "transparent", 
          cursor: "pointer", 
          fontSize: "12px", 
          fontWeight: 500,
          color: filter === "14_days" ? "#0f172a" : "#64748b" 
        }}
      >
        14 Days
      </button>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <input 
          type="date"
          value={selectedDate}
          onChange={(e) => { 
            setSelectedDate(e.target.value); 
            if (e.target.value) setFilter("day"); 
          }}
          style={{ 
            padding: "3px 8px", 
            borderRadius: "6px", 
            border: filter === "day" ? "1px solid #0f172a" : "1px solid #e2e8f0", 
            background: filter === "day" ? "#f8fafc" : "transparent",
            fontSize: "12px", 
            color: filter === "day" ? "#0f172a" : "#64748b",
            cursor: "pointer",
            outline: "none"
          }}
        />
      </div>
      {action && <div style={{ marginLeft: 4 }}>{action}</div>}
    </div>
  );

  return (
    <DashboardCard
      title={title}
      action={customAction}
      height={height}
      bodyStyle={{
        minHeight: listHeight,
        maxHeight: listHeight,
        minWidth: 0,
        width: "100%",
      }}
    >
      <GroupedBarChartCard
        data={isMulti ? undefined : singleData}
        series={multiSeries}
        singleHeight={chartHeight}
        multiHeight={Math.max(210, chartHeight - 25)}
      />
    </DashboardCard>
  );
};

export default React.memo(WeeklyAttendanceCard);
