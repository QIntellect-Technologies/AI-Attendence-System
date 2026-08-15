/**
 * modules/staff/components/StaffStats.tsx
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
  staff: StaffMember[];
  peopleModel: PeopleRenderingModel;
  purchasedModules: string[];
}> = ({ staff, peopleModel, purchasedModules }) => {
  const active = staff.filter((s) => s.status === "active").length;
  const inactive = staff.filter((s) => s.status === "inactive").length;
  const pending = staff.filter((s) => s.status === "pending").length;
  const payrollEnabled = purchasedModules
    .map((moduleKey) => String(moduleKey).trim().toLowerCase())
    .includes("payroll");
  const showPayrollStats = payrollEnabled && !peopleModel.isStudent;

  const cards: { label: string; val: number | string; color: string }[] = [
    {
      label: peopleModel.statsTotalLabel,
      val: staff.length,
      color: T.navy600,
    },
    { label: "Active", val: active, color: T.teal600 },
    { label: "Inactive/Pending", val: inactive + pending, color: T.amber },
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
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cards.length},1fr)`,
        gap: 12,
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
