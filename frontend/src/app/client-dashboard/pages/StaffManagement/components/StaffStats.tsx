/**
 * pages/StaffManagement/components/StaffStats.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Stat bar above the directory table.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type FC } from "react";
import { T } from "../../../components/ui/theme";
import { type PeopleRenderingModel } from "../../../utils/templateRendering";
import { type StaffMember } from "../types/staffTypes";
import { staffSalary } from "../utils/staffMember";

// ─── Stat bar ─────────────────────────────────────────────────────────────────

export const StaffStats: FC<{
  /** Rows currently loaded (ONE page) - only used for the salary average and
   * as a fallback while `counts` has not loaded yet. */
  staff: StaffMember[];
  /** Directory-wide headcounts from the server (all pages). */
  counts?: { total: number; active: number; inactiveOrPending: number } | null;
  peopleModel: PeopleRenderingModel;
  purchasedModules: string[];
}> = ({ staff, counts, peopleModel, purchasedModules }) => {
  const pageActive = staff.filter((s) => s.status === "active").length;
  const pageInactive = staff.filter((s) => s.status === "inactive").length;
  const pagePending = staff.filter((s) => s.status === "pending").length;

  const total = counts ? counts.total : staff.length;
  const active = counts ? counts.active : pageActive;
  const inactiveOrPending = counts
    ? counts.inactiveOrPending
    : pageInactive + pagePending;
  const payrollEnabled = purchasedModules
    .map((moduleKey) => String(moduleKey).trim().toLowerCase())
    .includes("payroll");
  const showPayrollStats = payrollEnabled && !peopleModel.isStudent;

  const cards: { label: string; val: number | string; color: string }[] = [
    {
      label: peopleModel.statsTotalLabel,
      val: total,
      color: T.navy600,
    },
    { label: "Active", val: active, color: T.teal600 },
    { label: "Inactive/Pending", val: inactiveOrPending, color: T.amber },
  ];

  if (showPayrollStats) {
    const avgSal = staff.length
      ? Math.round(
        staff.reduce((acc, member) => acc + staffSalary(member), 0) /
        staff.length,
      )
      : 0;
    cards.push({
      label: "Avg Salary",
      val: `${Math.round(avgSal / 1000)}K`,
      color: T.navy600,
    });
  }

  return (
    <div
      className="staff-management-stats"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 12,
        minWidth: 0,
        width: "100%",
      }}
    >
      {cards.map((card) => (
        <div
          key={card.label}
          style={{
            background: T.card,
            border: `1px solid ${T.border}`,
            borderRadius: 10,
            padding: "12px 16px",
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: T.muted,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: ".07em",
              marginBottom: 6,
              overflowWrap: "anywhere",
            }}
          >
            {card.label}
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: card.color }}>
            {card.val}
          </div>
        </div>
      ))}
    </div>
  );
};